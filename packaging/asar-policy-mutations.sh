# shellcheck shell=bash disable=SC2034
# Sourced, not run. Mutations of the shipped src/ files that tools/check-asar-policy.js (the behavioural part of
# the release gate) MUST turn red. One entry per line: "name|file under src/|sed expression". Every expression
# must leave valid JavaScript (block comments, never `//`, in the middle of a line) so that the gate fails on the
# BEHAVIOUR it checks, not on a syntax error. Used by test-asar-policy-mutations.sh (Linux, fast) and by
# test-verify-artifact-win.sh (full gate on the real build).
POLICY_MUTATIONS=(
  "win32 marker: dev compare dropped|test-mode.js|s/ || st.dev !== lst.dev || st.ino !== lst.ino) return false;/ || st.ino !== lst.ino) return false; \/* MUTATED *\//"
  "win32 marker: ino compare dropped|test-mode.js|s/ || st.dev !== lst.dev || st.ino !== lst.ino) return false;/ || st.dev !== lst.dev) return false; \/* MUTATED *\//"
  "win32 marker: size check dropped|test-mode.js|s/ || Number(st.size) !== MARKER_CONTENT.length) return false;/) return false; \/* MUTATED *\//"
  "win32 marker: nlink check dropped|test-mode.js|s/if (Number(st.nlink) !== 1 || Number(st.size)/if (\/* MUTATED *\/ Number(st.size)/"
  "win32 marker: case-sensitive path compare|test-mode.js|s/const sameWin32Path = (a, b) => a.toLowerCase() === b.toLowerCase();/const sameWin32Path = (a, b) => a === b; \/* MUTATED *\//"
  "posix marker: size check dropped|test-mode.js|s/ || st.size !== MARKER_CONTENT.length) return false;/) return false; \/* MUTATED *\//"
  "posix marker: isFile check dropped|test-mode.js|s/if (!st.isFile() || st.nlink !== 1 ||/if (\/* MUTATED *\/ st.nlink !== 1 ||/"
  "argv policy: win32 slash rule dropped|argv-policy.js|s/platform === 'win32' \&\& arg.startsWith('\/')/false \/* MUTATED *\//"
  "argv policy: slash rule widened to every platform|argv-policy.js|s/platform === 'win32' \&\& arg.startsWith('\/')/\/* MUTATED *\/ arg.startsWith('\/')/"
  "argv policy: slash rule widened to non-linux|argv-policy.js|s/platform === 'win32' \&\& arg.startsWith('\/')/platform !== 'linux' \&\& \/* MUTATED *\/ arg.startsWith('\/')/"
)
