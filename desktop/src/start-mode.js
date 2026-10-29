'use strict';

/**
 * Which application the entry point starts. The product is the tabbed shell
 * (scheme transport). `BENTO_TRANSPORT=http` selects the M2 single-window app
 * served from loopback: a TEST-ONLY harness kept so the old single-window
 * tests still run (it is ignored when the app is packaged, see main.js). It has
 * no tabs, no shell UI, no recents and is not a supported way to use the app.
 */
const DEFAULT_TRANSPORT = 'scheme';
const startKindFor = (transport) => (transport === 'scheme' ? 'shell' : 'single-window-test-harness');

module.exports = { DEFAULT_TRANSPORT, startKindFor };
