'use strict';

// Usage: node tools/check-fuses.js <path-to-electron-based-binary>
// Reads the fuse wire from the binary and exits non-zero on any mismatch.
const { FuseState, FuseV1Options, getCurrentFuseWire } = require('@electron/fuses');
const { EXPECTED_FUSES } = require('./fuse-config');

async function main() {
  const binary = process.argv[2];
  if (!binary) throw new Error('usage: check-fuses.js <binary>');
  const wire = await getCurrentFuseWire(binary);
  const mismatches = [];
  for (const [index, want] of Object.entries(EXPECTED_FUSES)) {
    const got = wire[index];
    const ok = got === (want ? FuseState.ENABLE : FuseState.DISABLE);
    process.stdout.write(`${ok ? 'ok  ' : 'FAIL'} ${FuseV1Options[index]} = ${FuseState[got]} (want ${want ? 'ENABLE' : 'DISABLE'})\n`);
    if (!ok) mismatches.push(FuseV1Options[index]);
  }
  if (mismatches.length) throw new Error(`fuse mismatch: ${mismatches.join(', ')}`);
}

main().catch((err) => {
  process.stderr.write(`${err.message}\n`);
  process.exit(1);
});
