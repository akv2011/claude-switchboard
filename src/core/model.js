/**
 * Which model and effort level a chat is running on.
 *
 * Neither is in the session registry, so both are read from the transcript. An
 * assistant entry carries them together:
 *
 *   {"type":"assistant","effort":"high","message":{"model":"claude-opus-5",...}}
 *
 * Both change during a conversation, so the LAST assistant entry is what the
 * chat is actually using. That means reading the tail, not the head.
 */

import { readTailEntries } from './jsonl.js';

/**
 * Enough to reach the last reply with text. A chat mid tool-loop can have a
 * hundred kilobytes of tool results after its last sentence.
 */
const TAIL_BYTES = 256 * 1024;

/**
 * Claude Code writes its own messages into the transcript as an assistant entry
 * with a bracketed placeholder in place of a model, for example
 *
 *   {"model":"<synthetic>","content":[{"text":"There's an issue with the
 *    selected model (opus-4.6). It may not exist..."}]}
 *
 * On one real store 3,452 of 8,615 chats ended on one. Reporting that as the
 * model would put "<synthetic>" in the column for a third of the list.
 */
const isPlaceholder = (model) => model.startsWith('<');

/**
 * @returns {{model:string|null, effort:string|null}} nulls when the transcript
 *   has no assistant reply yet, which is normal for a chat that just started.
 */
export function readModelAndEffort(file) {
  const entries = readTailEntries(file, TAIL_BYTES);
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i];
    const model = entry?.message?.model;
    if (typeof model === 'string' && model && !isPlaceholder(model)) {
      return { model, effort: typeof entry.effort === 'string' ? entry.effort : null };
    }
  }
  return { model: null, effort: null };
}

/** How much of a reply to show in a row. One line, trimmed of markdown. */
const LAST_LINE_CHARS = 160;

/**
 * Model, effort and the last thing the assistant said, from one read of the
 * tail. The last line is what the list is for: a session's name says what it
 * is, its last line says what it is doing or asking right now.
 *
 * @returns {{model:string|null, effort:string|null, lastLine:string|null}}
 */
export function readTailFacts(file) {
  const entries = readTailEntries(file, TAIL_BYTES);
  let model = null;
  let effort = null;
  let lastLine = null;
  let contextTokens = null;
  let permissionMode = null;
  // How the chat last stopped, when it stopped on an API error (a usage limit
  // most often) and nobody has prompted it since.
  let stoppedOn = null;
  let sawPrompt = false;
  let sawReply = false;
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i];
    if (!sawReply && !sawPrompt && entry?.type === 'user' && typeof entry.message?.content === 'string') sawPrompt = true;
    if (!sawReply && entry?.type === 'assistant') {
      sawReply = true;
      if (!sawPrompt && entry.isApiErrorMessage) {
        const text = lastTextLine(entry) ?? '';
        stoppedOn = { kind: entry.error === 'rate_limit' ? 'limit' : 'error', text, at: entry.timestamp ?? null };
      }
    }
    // The permission mode rides on each prompt the person sent.
    if (entry?.type === 'user' && !permissionMode && typeof entry.permissionMode === 'string') {
      permissionMode = entry.permissionMode;
    }
    if (entry?.type !== 'assistant') continue;
    const candidate = entry?.message?.model;
    if (!model && typeof candidate === 'string' && candidate && !isPlaceholder(candidate)) {
      model = candidate;
      effort = typeof entry.effort === 'string' ? entry.effort : null;
    }
    // What the last reply had to read is the size of the context right now.
    const usage = entry?.message?.usage;
    if (contextTokens === null && usage && typeof usage === 'object') {
      contextTokens = (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0)
        + (usage.cache_read_input_tokens ?? 0);
    }
    if (!lastLine) lastLine = lastTextLine(entry);
    if (model && lastLine && contextTokens !== null && permissionMode) break;
  }
  return { model, effort, lastLine, contextTokens, permissionMode, stoppedOn, pathTokens: pathTokens(entries) };
}

/**
 * The folder names the chat's recent work runs through, counted: every
 * "name/" that starts a path segment in its replies, tool calls and results.
 * Top 8 only; the scan matches them against real subfolders later.
 */
export function pathTokens(entries) {
  const counts = new Map();
  for (const entry of entries) {
    if (entry?.type !== 'assistant' && entry?.type !== 'user') continue;
    const text = JSON.stringify(entry.message?.content ?? '');
    // Lookarounds, not a consumed separator: a pattern that ate the "/" after
    // each name skipped every other folder in a path like /a/b/c/project/.
    for (const m of text.matchAll(/(?<=^|[\s"'`(=:\\/])([A-Za-z0-9][A-Za-z0-9_.-]{1,60})(?=\/)/g)) {
      counts.set(m[1], (counts.get(m[1]) ?? 0) + 1);
    }
  }
  return [...counts].sort((a, b) => b[1] - a[1]).slice(0, 16);
}

/**
 * Tokens the model can hold. Every current model is 1M (Fable 5.x, Opus 5.x
 * and 4.6+, Sonnet 5.x and 4.6, Haiku 5.5); Haiku 4.5 and the older lines are
 * 200K. A [1m] suffix is explicit. Per the Claude API reference as of October 2026.
 */
export function contextWindow(model) {
  const id = model ?? '';
  if (/\[1m\]/.test(id)) return 1_000_000;
  if (/claude-(haiku-4-5|opus-4-[0-5]\b|sonnet-4-[0-5]\b|[a-z]+-3)/.test(id)) return 200_000;
  return 1_000_000;
}

/** Claude Code's permission mode ids, as a person would say them. */
export function permissionLabel(mode) {
  return {
    bypassPermissions: 'bypass', acceptEdits: 'accept edits', plan: 'plan', default: 'ask', manual: 'ask',
    auto: 'auto', dontAsk: "don't ask",
  }[mode] ?? mode ?? null;
}

/** The final non-empty line of an assistant entry's text, as plain words. */
function lastTextLine(entry) {
  const blocks = Array.isArray(entry?.message?.content) ? entry.message.content : [];
  const text = blocks
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n');
  const lines = text.split('\n').map(plainLine).filter(Boolean);
  const line = lines[lines.length - 1];
  if (!line) return null;
  return line.length > LAST_LINE_CHARS ? `${line.slice(0, LAST_LINE_CHARS - 1).trimEnd()}…` : line;
}

function plainLine(line) {
  return line
    .replace(/`+/g, '')
    .replace(/\*\*|__/g, '')
    .replace(/^\s*(?:[-*>]|#+|\d+\.)\s+/, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Does the last line want something from the person? A question is the clear
 * case; a line that addresses "you" is usually a request for a decision.
 */
// Phrases that hand the next move to the person. A bare "you" is not one:
// "Nothing changes on your side" matched it, and 28 of 85 last lines did.
const ASKS = /\?\s*$|\b(should i|shall i|want me to|do you want|would you like|let me know|tell me|your call|up to you|say (so|the word|go)|waiting (on|for) you|if you want|needs? (your|a) (decision|go|yes|approval|answer|input)|approve|confirm)\b/i;

export function asksForYou(lastLine) {
  return Boolean(lastLine) && ASKS.test(lastLine);
}

/**
 * A model id shortened for a narrow column: the family and its size, dropping
 * the vendor prefix and the dated suffix that makes every id look alike.
 *
 *   claude-opus-5              -> opus 5
 *   claude-haiku-4-5-20251001  -> haiku 4.5
 *   claude-opus-5[1m]          -> opus 5 1m
 */
export function shortModel(model) {
  if (!model) return null;
  const bracket = /\[([^\]]+)\]$/.exec(model);
  const suffix = bracket ? ` ${bracket[1]}` : '';
  const base = model.replace(/\[[^\]]+\]$/, '');
  const match = /^claude-([a-z]+)-(\d+)(?:-(\d+))?/.exec(base);
  if (!match) return base + suffix;
  const [, family, major, minor] = match;
  return `${family} ${major}${minor ? `.${minor}` : ''}${suffix}`;
}
