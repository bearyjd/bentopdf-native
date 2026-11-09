#!/usr/bin/env bash
# Policy check of a deb postinst / rpm scriptlet text (rendered from packaging/linux/after-install.sh).
#   packaging/check-postinst.sh <script>     prints "FAIL: ..." and exits 1 on the first violated rule
# Structure matters, not only presence: a grep for 'chmod 4755' alone passes an unconditional setuid.
set -euo pipefail
POST="${1:?usage: check-postinst.sh <script>}"
fail() { echo "FAIL: $*" >&2; exit 1; }

[ -s "$POST" ] || fail "missing or empty maintainer script ${POST##*/}"
grep -q 'setpriv --reuid=65534' "$POST" || fail "post-install does not probe user namespaces as an unprivileged user"
grep -q 'apparmor_restrict_unprivileged_userns' "$POST" || fail "post-install does not look at the AppArmor userns restriction"
grep -q 'chmod 4755' "$POST" || fail "post-install has no setuid fallback for the sandbox helper"
grep -q 'chmod 0755' "$POST" || fail "post-install does not reset the sandbox helper to 0755 first"

# The setuid chmod must exist exactly once and sit directly under `if [ "$use_setuid" = 1 ]` (never unconditional).
[ "$(grep -c 'chmod 4755' "$POST")" = 1 ] || fail "post-install has more than one 'chmod 4755' (setuid must have a single, conditional site)"
grep -Eq '^[[:space:]]*use_setuid=0[[:space:]]*$' "$POST" || fail "post-install does not default use_setuid to 0"
PREV="$(grep -B1 'chmod 4755' "$POST" | head -n1)"
printf '%s\n' "$PREV" | grep -Eq '^[[:space:]]*if \[ "\$use_setuid" = 1 \]; then[[:space:]]*$' || fail "post-install: 'chmod 4755' is not guarded by use_setuid=1 (unconditional setuid)"
# The reset to 0755 must come before the conditional setuid, or the setuid is undone / never needed.
RESET_LN="$(grep -n 'chmod 0755' "$POST" | tail -n1 | cut -d: -f1)"
SETUID_LN="$(grep -n 'chmod 4755' "$POST" | head -n1 | cut -d: -f1)"
[ "$RESET_LN" -lt "$SETUID_LN" ] || fail "post-install: the 0755 reset comes after the setuid chmod"

# A profile that loads but does not lift the restriction must fall back to setuid: the probe is repeated after loading.
grep -Fq 'install_apparmor_profile && userns_works_for_nobody || use_setuid=1' "$POST" || fail "post-install does not re-probe user namespaces after loading the AppArmor profile"

# Nothing in a maintainer script may touch the sandbox/env switches (flags are checked by verify-artifact.sh).
if grep -En 'ELECTRON_DISABLE_SANDBOX|CHROME_DEVEL_SANDBOX|ELECTRON_EXTRA_LAUNCH_ARGS|ELECTRON_ENABLE_LOGGING|ELECTRON_RUN_AS_NODE|NODE_OPTIONS' "$POST" >&2; then
  fail "post-install references a sandbox-off or node-injection environment variable"
fi
echo "ok:   post-install policy structure"
