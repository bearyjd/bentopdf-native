'use strict';

// Preload of the trusted shell UI only (tab strip, tool sidebar, recents).
// Sandboxed: may only require 'electron'. Channel names mirror shell-channels.js.
const { contextBridge, ipcRenderer } = require('electron');

const SHELL_CHANNELS = Object.freeze({
  listTools: 'shell:list-tools',
  getState: 'shell:get-state',
  openTool: 'shell:open-tool',
  switchTab: 'shell:switch-tab',
  closeTab: 'shell:close-tab',
  openFileDialog: 'shell:open-file-dialog',
  openRecent: 'shell:open-recent',
  stateChanged: 'shell:state-changed',
});

const bridge = {
  listTools: () => ipcRenderer.invoke(SHELL_CHANNELS.listTools),
  getState: () => ipcRenderer.invoke(SHELL_CHANNELS.getState),
  openTool: (toolId, docId) => ipcRenderer.invoke(SHELL_CHANNELS.openTool, toolId, docId),
  switchTab: (tabId) => ipcRenderer.invoke(SHELL_CHANNELS.switchTab, tabId),
  closeTab: (tabId) => ipcRenderer.invoke(SHELL_CHANNELS.closeTab, tabId),
  openFileDialog: () => ipcRenderer.invoke(SHELL_CHANNELS.openFileDialog),
  openRecent: (recentId) => ipcRenderer.invoke(SHELL_CHANNELS.openRecent, recentId),
  onStateChanged: (callback) => {
    if (typeof callback !== 'function') throw new TypeError('callback must be a function');
    const listener = (_event, state) => callback(state);
    ipcRenderer.on(SHELL_CHANNELS.stateChanged, listener);
    return () => ipcRenderer.removeListener(SHELL_CHANNELS.stateChanged, listener);
  },
};

contextBridge.exposeInMainWorld('bentoShell', Object.freeze(bridge));
