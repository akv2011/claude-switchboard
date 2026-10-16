/**
 * Main process.
 *
 * Deliberately thin. Every request below forwards straight into src/core, which
 * is plain Node-compatible ESM with zero dependencies, so the same logic backs
 * the CLI and would back a different window framework unchanged.
 */

// defineRPC is a static on BrowserView, not BrowserWindow.
import { BrowserWindow, BrowserView } from 'electrobun/bun';
import { toolPath } from '../core/paths.js';
import {
  getOverview, previewDelete, performDelete, restoreGroups, clearProject,
  openInVscode, recorder, enableAutoTasks, setPersistentSessions,
  attachSession, moveSession, controlChat, newChat, searchAll, moveToLocal, peekRemoteScreen, readLastMessage, moveLiveSession, balanceToRemote, setAutoBalance, copyText,
} from '../core/api.js';
import { listAccounts, switchAccount, newChatAs } from '../core/accounts.js';
import { openAgent, stopAgent } from '../core/background.js';
import { restartWith } from '../core/restart.js';

// An app started from Finder or the Dock gets launchd's PATH, /usr/bin:/bin
// and little else, which holds none of code, claude, cswap or rg.
process.env.PATH = toolPath();

const rpc = BrowserView.defineRPC({
  // Matches the view side: a slow scan must not be cut off mid flight.
  maxRequestTime: 600_000,
  handlers: {
    requests: {
      overview: () => getOverview(),

      previewDelete: ({ sessionId, projectDir }) => previewDelete({ sessionId, projectDir }),

      confirmDelete: ({ sessionId, projectDir }) => {
        try {
          return { ok: true, result: performDelete({ sessionId, projectDir }) };
        } catch (err) {
          return { ok: false, error: (err as Error).message };
        }
      },

      restore: ({ groups, launch }) => restoreGroups(groups, { launch }),

      attach: ({ name, cwd }) => attachSession({ name, cwd }),

      moveToRemote: ({ sessionId }) => moveSession(sessionId),

      control: ({ sessionId, name, machine, action, value }) => controlChat({ sessionId, name, machine, action, value }),

      peek: ({ name }) => peekRemoteScreen(name),

      lastMessage: ({ sessionId, projectDir }) => readLastMessage({ sessionId, projectDir }),

      moveLive: ({ sessionId, force }) => moveLiveSession({ sessionId, force }),

      moveToLocal: ({ sessionId }) => moveToLocal({ sessionId }),

      balance: ({ max }) => balanceToRemote({ max }),

      setAutoBalance: ({ enabled }) => ({ ok: true, config: setAutoBalance(enabled) }),

      accounts: () => listAccounts(),

      switchAccount: ({ number }) => switchAccount(number),

      newChatAs: ({ number, cwd }) => newChatAs(number, cwd),

      restartWith: ({ sessionId, machine, model, effort, permission }) => restartWith({ sessionId, machine, model, effort, permission }),

      newChat: (choice) => newChat(choice),

      searchAll: ({ query }) => searchAll(query),

      openAgent: ({ id }) => openAgent(id),

      stopAgent: ({ id }) => stopAgent(id),

      copyText: ({ text }) => copyText(text),

      clearTasks: ({ cwd }) => clearProject(cwd),

      enableAutoTasks: () => {
        try {
          return { ok: true, result: enableAutoTasks() };
        } catch (err) {
          return { ok: false, error: (err as Error).message };
        }
      },

      disablePersistence: () => {
        try {
          return { ok: true, result: setPersistentSessions(false) };
        } catch (err) {
          return { ok: false, error: (err as Error).message };
        }
      },

      openProject: ({ cwd }) => openInVscode(cwd),

      recorderInstall: () => {
        try {
          recorder.install();
          return { ok: true, status: recorder.status() };
        } catch (err) {
          return { ok: false, error: (err as Error).message };
        }
      },

      recorderUninstall: () => {
        recorder.uninstall();
        return { ok: true, status: recorder.status() };
      },
    },
    messages: {},
  },
});

new BrowserWindow({
  title: 'Claude Session Restore',
  url: 'views://mainview/index.html',
  frame: { x: 120, y: 100, width: 1080, height: 720 },
  rpc,
});
