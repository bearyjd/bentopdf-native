'use strict';

// Exit-code policy of `packaged-smoke-win.js --portable --mode second-instance-only` (portable exe, issue #11).
// Pure so it is unit-tested on Linux. 3 is reserved for the KNOWN #11 signature and nothing else:
//   - the first instance is healthy (still running after the settle time), AND
//   - the second launch either hung (did not exit in time) or exited 0 without any observable forwarding
//     (the portable exe cannot enter test mode, so "the file arrived" can never be observed).
// Everything else is a failure of its own (exit 1): first instance died or never started, second instance crashed
// (non-zero exit), or the harness itself threw. Exit 0 is never returned: nothing here can prove forwarding works.
const EXIT_PASS = 0;
const EXIT_FAIL = 1;
const EXIT_KNOWN_ISSUE_11 = 3;

function classifyPortableSecondInstance({ firstAlive, secondExit }) {
  if (firstAlive !== true) return { code: EXIT_FAIL, known: false, reason: 'the first portable instance did not stay running (crash or missing exe): not the #11 signature' };
  if (secondExit === 'timeout') return { code: EXIT_KNOWN_ISSUE_11, known: true, reason: 'the second launch hung while the first instance was healthy' };
  if (secondExit === 0) return { code: EXIT_KNOWN_ISSUE_11, known: true, reason: 'the second launch exited 0 but forwarding of its file cannot be observed in the portable exe (no test mode)' };
  return { code: EXIT_FAIL, known: false, reason: `the second launch ended with ${String(secondExit)}: not the #11 signature` };
}

module.exports = { classifyPortableSecondInstance, EXIT_PASS, EXIT_FAIL, EXIT_KNOWN_ISSUE_11 };
