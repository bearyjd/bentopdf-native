'use strict';

// RELEASE flavour of src/test-mode.js (issue #13). electron-builder packs THIS file as src/test-mode.js in a release
// build (tools/flavour.js), so a release build has no test mode at all: no marker is ever looked for, no switch is
// test-only, no environment variable enables anything. The real logic ships only in the SMOKE flavour, which is
// never distributed. The release gate (tools/check-asar-policy.js --flavour release) requires the packaged file to be
// this one, byte for byte.
const hasTestMarker = () => false;
const isTestSwitch = () => false;
const testHeadless = () => false;
const testTraceDir = () => undefined;

module.exports = { hasTestMarker, isTestSwitch, testHeadless, testTraceDir };
