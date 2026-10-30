# shellcheck shell=bash disable=SC2034
# Sourced, not run. Mutations of the shipped src/ files that tools/check-asar-policy.js (the behavioural part of
# the release gate) MUST turn red. One entry per line: "name|file under src/|mutation", where the mutation is a sed
# expression or @<path under desktop/> (copy that file over). Every sed expression must leave valid JavaScript
# (block comments, never `//`, in the middle of a line) so that the gate fails on the BEHAVIOUR it checks, not on
# a syntax error. Used by test-asar-policy-mutations.sh (Linux, fast), test-verify-artifact.sh (Linux, full gate)
# and test-verify-artifact-win.sh (full gate on the real build). The caller sets ROOT (the repository root).
# POLICY_MUTATIONS apply to a SMOKE-flavour tree (gate run with --flavour smoke), RELEASE_MUTATIONS to a RELEASE one.

# apply_policy_mutation <src dir> <file> <mutation>: applies one entry; returns 2 if it did not change the file.
apply_policy_mutation() {
  local dir="$1" file="$2" mutation="$3"
  if [ "${mutation#@}" != "$mutation" ]; then
    if cmp -s "$ROOT/desktop/${mutation#@}" "$dir/$file"; then echo "mutation $mutation leaves $file unchanged" >&2; return 2; fi
    cp "$ROOT/desktop/${mutation#@}" "$dir/$file"
  else
    sed -i "$mutation" "$dir/$file"
    grep -q 'MUTATED' "$dir/$file" || { echo "mutation '$mutation' did not change $file" >&2; return 2; }
  fi
  node --check "$dir/$file" || { echo "mutation '$mutation' is not valid JavaScript (it would be caught for the wrong reason)" >&2; return 2; }
}

RELEASE_MUTATIONS=(
  "release: real test-mode.js packed instead of the stub|test-mode.js|@src/test-mode.js"
  "release: flavour constant flipped to smoke|build-flavour.js|s/flavour: 'release'/flavour: 'smoke' \/* MUTATED *\//"
  "release: flavour file edited (still says release)|build-flavour.js|s/^'use strict';$/'use strict'; \/* MUTATED *\//"
  "release: stub hasTestMarker returns true|test-mode.js|s/const hasTestMarker = () => false;/const hasTestMarker = () => true; \/* MUTATED *\//"
  "release: stub accepts test switches|test-mode.js|s/const isTestSwitch = () => false;/const isTestSwitch = () => true; \/* MUTATED *\//"
  "release: argv flavour rule dropped|argv-policy.js|s/return TEST_FLAVOURS.has(flavour) \&\& /return \/* MUTATED *\/ /"
  "release: release added to the test flavours|argv-policy.js|s/new Set(\['dev', 'smoke'\]);/new Set(['dev', 'smoke', 'release']); \/* MUTATED *\//"
  "release: DevTools gate dropped from app.js|app.js|s/allowDevtools: !app.isPackaged \&\& flavour !== 'release',/allowDevtools: !app.isPackaged, \/* MUTATED *\//"
  "release: DevTools gate dropped from shell-app.js|shell/shell-app.js|s/allowDevtools: !app.isPackaged \&\& flavour !== 'release',/allowDevtools: !app.isPackaged, \/* MUTATED *\//"
  "release: debug-port literal in main.js code|main.js|s/^'use strict';$/'use strict'; const x = '-remote-debugging-port=0'; \/* MUTATED *\//"
)

POLICY_MUTATIONS=(
  "smoke: tree carries the release stub|test-mode.js|@flavours/release/test-mode.js"

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
