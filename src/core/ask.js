/**
 * The window's requests, asked again when a frozen page made them time out.
 *
 * WebKit freezes the window's page 8 minutes after the window is hidden and
 * thaws it when it is shown (5 hours in one case read from the system
 * log). The request timer counts the frozen hours, so a request in flight then
 * times out the moment the page wakes, though the app answered in seconds.
 */

/** Requests that only read, so asking twice is harmless. */
export const READS = new Set(['overview', 'accounts', 'lastMessage', 'peek', 'searchAll', 'previewDelete']);

/**
 * A read that timed out is asked once more. An action is not, since asking
 * twice would move or restart a chat twice.
 *
 * @param {string} name the request name
 * @param {() => Promise<any>} ask sends it
 */
export function askAgainOnTimeout(name, ask) {
  if (!READS.has(name)) return ask();
  return ask().catch((err) => (/timed out/.test(err?.message ?? '') ? ask() : Promise.reject(err)));
}
