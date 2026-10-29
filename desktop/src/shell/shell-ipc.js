'use strict';

const { SHELL_CHANNELS } = require('./shell-channels');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Only the registered shell WebContents, top frame, at the shell origin.
 * A second page at the same origin (or a tool view given the shell preload)
 * is refused by the id check; a tool page is refused by both.
 */
function isShellSender(event, { shellOrigin, shellId }) {
  const frame = event && event.senderFrame;
  if (!event || !event.sender || shellId === null || event.sender.id !== shellId || !frame || frame.parent !== null) return false;
  try {
    return new URL(frame.url).origin === shellOrigin || frame.url.startsWith(`${shellOrigin}/`);
  } catch {
    return false;
  }
}

/** Argument validators: the shell is trusted code, but its inputs are still checked. */
function toolIdArg(raw, registry) {
  if (!registry.has(raw)) throw new Error('unknown tool');
  return raw;
}

function docIdArg(raw, store) {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== 'string' || !UUID.test(raw) || !store.has(raw)) throw new Error('unknown document');
  return raw;
}

function tabIdArg(raw, tabs) {
  if (!Number.isSafeInteger(raw) || raw < 1 || !tabs.has(raw)) throw new Error('unknown tab');
  return raw;
}

function recentIdArg(raw, recents) {
  if (typeof raw !== 'string' || !UUID.test(raw) || recents.pathOf(raw) === undefined) throw new Error('unknown recent file');
  return raw;
}

/**
 * Shell IPC. `getShellId()` returns the id of the one shell WebContents
 * (null before it exists: every call is refused). `actions` do the work;
 * this module only gates and validates.
 */
function registerShellIpc({ ipcMain, shellOrigin, getShellId, registry, store, tabs, recents, actions }) {
  const gate = (channel, handler) =>
    ipcMain.handle(channel, (event, ...args) => {
      if (!isShellSender(event, { shellOrigin, shellId: getShellId() })) throw new Error('untrusted sender');
      return handler(...args);
    });

  gate(SHELL_CHANNELS.listTools, () => actions.listTools());
  gate(SHELL_CHANNELS.getState, () => actions.state());
  gate(SHELL_CHANNELS.openTool, (toolId, docId) => actions.openTool(toolIdArg(toolId, registry), docIdArg(docId, store)));
  gate(SHELL_CHANNELS.switchTab, (tabId) => actions.switchTab(tabIdArg(tabId, tabs)));
  gate(SHELL_CHANNELS.closeTab, (tabId) => actions.closeTab(tabIdArg(tabId, tabs)));
  gate(SHELL_CHANNELS.openFileDialog, () => actions.openFileDialog());
  gate(SHELL_CHANNELS.openRecent, (recentId) => actions.openRecent(recentIdArg(recentId, recents)));

  return () => {
    for (const channel of Object.values(SHELL_CHANNELS)) ipcMain.removeHandler(channel);
  };
}

module.exports = { registerShellIpc, isShellSender, toolIdArg, docIdArg, tabIdArg, recentIdArg };
