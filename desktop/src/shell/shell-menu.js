'use strict';

const brand = require('../../brand.json');

/**
 * Application menu of the tabbed shell. Every action is a callback acting on
 * the ACTIVE TAB explicitly (Electron's zoom/reload roles would hit whichever
 * WebContents has focus, possibly the shell UI). Ctrl conventions on
 * Linux/Windows via CmdOrCtrl; on macOS the app menu role is added (NOT
 * VERIFIED: no macOS machine).
 * @param {{openFile: Function, openRecent: (id: string) => void, closeTab: Function, nextTab: Function,
 *          previousTab: Function, reloadTool: Function, zoom: (step: -1|0|1) => void,
 *          showAbout: Function, openSource: Function}} actions
 * @param {{recents: ReadonlyArray<{id: string, name: string}>, devtools?: boolean, platform?: string}} options
 */
function buildShellMenuTemplate(actions, { recents = [], devtools = false, platform = process.platform } = {}) {
  const recentItems = recents.length
    ? recents.map((r) => ({ label: r.name.replace(/&/g, '&&'), click: () => actions.openRecent(r.id) }))
    : [{ label: 'No recent files', enabled: false }];
  return [
    ...(platform === 'darwin' ? [{ role: 'appMenu' }] : []),
    {
      label: '&File',
      submenu: [
        { id: 'open', label: 'Open...', accelerator: 'CmdOrCtrl+O', click: () => actions.openFile() },
        { id: 'recent', label: 'Open Recent', submenu: recentItems },
        { type: 'separator' },
        { id: 'close-tab', label: 'Close Tab', accelerator: 'CmdOrCtrl+W', click: () => actions.closeTab() },
        { type: 'separator' },
        { role: 'quit', accelerator: 'CmdOrCtrl+Q' },
      ],
    },
    { label: '&Edit', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
    {
      label: '&Tab',
      submenu: [
        { id: 'next-tab', label: 'Next Tab', accelerator: 'Ctrl+Tab', click: () => actions.nextTab() },
        { id: 'previous-tab', label: 'Previous Tab', accelerator: 'Ctrl+Shift+Tab', click: () => actions.previousTab() },
      ],
    },
    {
      label: '&View',
      submenu: [
        { id: 'reload-tool', label: 'Reload Tool', accelerator: 'CmdOrCtrl+R', click: () => actions.reloadTool() },
        { type: 'separator' },
        { id: 'zoom-reset', label: 'Actual Size', accelerator: 'CmdOrCtrl+0', click: () => actions.zoom(0) },
        { id: 'zoom-in', label: 'Zoom In', accelerator: 'CmdOrCtrl+=', click: () => actions.zoom(1) },
        { id: 'zoom-out', label: 'Zoom Out', accelerator: 'CmdOrCtrl+-', click: () => actions.zoom(-1) },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        ...(devtools ? [{ role: 'toggleDevTools' }] : []),
      ],
    },
    {
      label: '&Help',
      submenu: [
        { id: 'about', label: `About ${brand.productName}`, click: () => actions.showAbout() },
        { id: 'source', label: 'Source code (AGPL-3.0)', click: () => actions.openSource() },
      ],
    },
  ];
}

module.exports = { buildShellMenuTemplate };
