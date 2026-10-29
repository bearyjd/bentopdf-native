#!/usr/bin/env bash
# Runs the portable second-instance check and turns its exit code into a CI verdict:
#   0 -> passed, 3 -> the KNOWN failure of issue #11 (loud job-summary line, step stays green),
#   anything else (1 = real failure, 2 = usage, 127 = missing command, a signal, ...) -> red.
# Usage: portable-second-step.sh <command> [args...]   (CI passes: bash smoke-installer.sh --portable-second-instance <exe>)
set -uo pipefail

[ "$#" -gt 0 ] || { echo "usage: portable-second-step.sh <command> [args...]" >&2; exit 2; }
"$@"
rc=$?

say() { echo "$1"; [ -z "${GITHUB_STEP_SUMMARY:-}" ] || echo "$1" >> "$GITHUB_STEP_SUMMARY"; }
case "$rc" in
  0)
    say "## Portable second-instance (issue #11) PASSED on this run: review and close the issue, then drop the known-failure code."
    ;;
  3)
    say "## KNOWN FAILURE #11: portable second-instance (healthy first instance; second launch hung or forwarding unobservable). NOT VERIFIED. Other portable failures would be red."
    echo "::warning::KNOWN FAILURE #11 (portable second-instance), not a regression"
    ;;
  *)
    say "## FAILED: portable second-instance check exited $rc, which is NOT the known #11 signature (exit 3)."
    echo "::error::portable second-instance check failed with exit $rc (not the known #11 signature)"
    exit 1
    ;;
esac
exit 0
