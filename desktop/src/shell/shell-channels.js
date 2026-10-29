'use strict';

// Keep in sync with shell-preload.js (a sandboxed preload cannot require local
// modules); test/shell-ipc.test.js asserts the two lists match.
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

module.exports = { SHELL_CHANNELS };
