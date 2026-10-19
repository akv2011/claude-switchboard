/**
 * Resolve the name you actually know a chat by.
 *
 * Names are stored inside the transcript, not in the live registry, which is why
 * a dead session can still be named in the sidebar. Two entry types carry them:
 *
 *   {"type":"custom-title","customTitle":"Shop_checkout"}
 *   {"type":"ai-title","aiTitle":"Checkout flow for the store and ..."}
 *
 * Over a few hundred real sessions, about a fifth had a custom title, four in
 * five an AI title, and about one in twenty neither.
 *
 * Both types are rewritten many times through a transcript and names are
 * mutable (a live session was seen changing from "Draft_ideas" to "Api_v2"
 * mid session), so the LAST occurrence wins, never the first.
 */

import { readHead, parseLines, readTailEntries } from './jsonl.js';

/** How far back to look for a title before giving up and widening the window. */
const TAIL_WINDOWS = [256 * 1024, 2 * 1024 * 1024];

const MAX_PROMPT_CHARS = 60;

/**
 * @param {string} file transcript path
 * @returns {{customTitle:string|null, aiTitle:string|null}}
 */
export function readTitles(file) {
  let customTitle = null;
  let aiTitle = null;

  for (const window of TAIL_WINDOWS) {
    const entries = readTailEntries(file, window);
    for (const entry of entries) {
      if (entry.type === 'custom-title' && entry.customTitle) customTitle = entry.customTitle;
      else if (entry.type === 'ai-title' && entry.aiTitle) aiTitle = entry.aiTitle;
    }
    if (customTitle || aiTitle) break;
  }
  return { customTitle, aiTitle };
}

/** First thing the user typed, used only when a session has no title at all. */
export function readFirstPrompt(file) {
  const entries = parseLines(readHead(file, 256 * 1024), 'head');
  for (const entry of entries) {
    if (entry.type !== 'user') continue;
    const content = entry.message?.content;
    let text = null;
    if (typeof content === 'string') text = content;
    else if (Array.isArray(content)) {
      const block = content.find((c) => c?.type === 'text' && typeof c.text === 'string');
      if (block) text = block.text;
    }
    if (!text) continue;
    // Skip harness noise so the fallback shows something the user recognises.
    if (text.startsWith('<')) continue;
    // A first prompt is often a paste, so strip the markdown that would
    // otherwise show up as "## Context Usage **Model:** ..." in the list.
    const clean = text
      .replace(/^#{1,6}\s*/gm, '')
      .replace(/\*\*|__|`+/g, '')
      .replace(/^[-*+>\s]+/, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!clean) continue;
    return clean.length > MAX_PROMPT_CHARS ? `${clean.slice(0, MAX_PROMPT_CHARS)}...` : clean;
  }
  return null;
}

/**
 * The display name, in precedence order.
 *
 * @param {string} file transcript path
 * @param {string} sessionId used for the last resort label
 * @returns {{name:string, source:'custom'|'ai'|'prompt'|'id'}}
 */
export function resolveName(file, sessionId) {
  const { customTitle, aiTitle } = readTitles(file);
  if (customTitle) return { name: customTitle, source: 'custom' };
  if (aiTitle) return { name: aiTitle, source: 'ai' };

  const prompt = readFirstPrompt(file);
  if (prompt) return { name: prompt, source: 'prompt' };

  return { name: `(unnamed ${String(sessionId).slice(0, 8)})`, source: 'id' };
}
