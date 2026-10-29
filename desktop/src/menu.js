'use strict';

const brand = require('../brand.json');
const SOURCE_URL = brand.sourceUrl;
const UPSTREAM_URL = brand.upstreamUrl;

/** Text of Help > About: the AGPL notice and where the corresponding source is. */
function aboutDetail() {
  return [
    'Unofficial, community-built desktop packaging of BentoPDF. Not affiliated with or endorsed by the BentoPDF project.',
    '',
    'Licensed under the GNU Affero General Public License v3.0 only (AGPL-3.0-only). This program comes with ABSOLUTELY NO WARRANTY.',
    '',
    `Corresponding source for this build: ${SOURCE_URL}`,
    `(the exact commit and upstream tag are in SOURCE.txt next to this application). Upstream: ${UPSTREAM_URL}`,
    '',
    'Third-party licences: NOTICE, LICENSE.electron.txt and LICENSES.chromium.html next to this application.',
    'This application never updates itself and makes no network requests of its own.',
  ].join('\n');
}

/** Deliberately minimal and role-based; the full menus are M3. `showAbout`/`openSource` are callbacks. */
function buildMenuTemplate({ showAbout, openSource, devtools = false }) {
  return [
    { label: 'File', submenu: [{ role: 'quit' }] },
    { label: 'Edit', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
    {
      label: 'View',
      submenu: [{ role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' }, { role: 'togglefullscreen' }, ...(devtools ? [{ role: 'toggleDevTools' }] : [])],
    },
    {
      label: 'Help',
      submenu: [
        { label: `About ${brand.productName}`, click: showAbout },
        { label: 'Source code (AGPL-3.0)', click: openSource },
      ],
    },
  ];
}

module.exports = { aboutDetail, buildMenuTemplate, SOURCE_URL };
