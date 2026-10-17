/**
 * Main process.
 *
 * Deliberately thin. Every request below forwards straight into src/core, which
 * is plain Node-compatible ESM with zero dependencies, so the same logic backs
 * the CLI and would back a different window framework unchanged.
 */

// defineRPC is a static on BrowserView, not BrowserWindow.
import { BrowserWindow, BrowserView, ApplicationMenu } from 'electrobun/bun';
import { toolPath } from '../core/paths.js';
import {
  getOverview, previewDelete, performDelete, restoreGroups, clearProject,
  openInVscode, recorder, enableAutoTasks, setPersistentSessions,
  attachSession, moveSession, controlChat, newChat, searchAll, moveToLocal, peekRemoteScreen, readLastMessage, moveLiveSession, balanceToRemote, setAutoBalance, copyText,
} from '../core/api.js';
import { listAccounts, switchAccount, newChatAs } from '../core/accounts.js';
import { openAgent, stopAgent } from '../core/background.js';
import { restartWith } from '../core/restart.js';
import { assignGroup, createGroup, deleteGroup } from '../core/groups.js';

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

      assignGroup: ({ names, group }) => assignGroup({ names, group }),

      createGroup: ({ name }) => createGroup(name),

      deleteGroup: ({ name }) => deleteGroup(name),

      // WKWebView's own page zoom: the page lays out at the zoomed width, so
      // its media and container queries follow, and text stays sharp.
      setZoom: ({ level }) => {
        const zoom = Number(level);
        if (!(zoom >= 0.5 && zoom <= 2)) return { ok: false, error: 'zoom is 0.5 to 2' };
        win.setPageZoom(zoom);
        return { ok: true };
      },

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

const win = new BrowserWindow({
  title: 'Claude Switchboard',
  url: 'views://mainview/index.html',
  frame: { x: 120, y: 100, width: 1080, height: 720 },
  rpc,
});

// Without a main menu macOS never delivered Cmd+= to the page, and Cmd+C and
// Cmd+V did nothing in the search box. Roles other than the Edit ones carry no
// shortcut of their own, so Quit and Hide name theirs.
ApplicationMenu.setApplicationMenu([
  { label: 'Claude Switchboard', submenu: [
    { role: 'hide', accelerator: 'CommandOrControl+H' },
    { role: 'hideOthers', accelerator: 'CommandOrControl+Alt+H' },
    { role: 'showAll' },
    { type: 'divider' },
    { role: 'quit', accelerator: 'CommandOrControl+Q' },
  ] },
  { label: 'Edit', submenu: [
    { role: 'undo' }, { role: 'redo' }, { type: 'divider' },
    { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' },
  ] },
  { label: 'View', submenu: [
    { label: 'Zoom In', action: 'zoom-in', accelerator: 'CommandOrControl+=' },
    { label: 'Zoom Out', action: 'zoom-out', accelerator: 'CommandOrControl+-' },
    { label: 'Actual Size', action: 'zoom-reset', accelerator: 'CommandOrControl+0' },
  ] },
]);

// The view owns the level, its memory and the toast; the menu only says which way.
const ZOOM_STEPS: Record<string, number> = { 'zoom-in': 1, 'zoom-out': -1, 'zoom-reset': 0 };
ApplicationMenu.on('application-menu-clicked', (event) => {
  const step = ZOOM_STEPS[(event as { data?: { action?: string } }).data?.action ?? ''];
  if (step !== undefined) (rpc as any).send.zoom({ step });
});
