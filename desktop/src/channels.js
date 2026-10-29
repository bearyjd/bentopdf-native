'use strict';

// Keep in sync with preload.js (a sandboxed preload cannot require local
// modules); test/security.test.js asserts the two lists match.
const CHANNELS = Object.freeze({
  openFile: 'bento:open-file',
  readFile: 'bento:read-file',
  saveFile: 'bento:save-file',
  takeOpened: 'bento:take-opened',
  fileOpened: 'bento:file-opened',
});

module.exports = { CHANNELS };
