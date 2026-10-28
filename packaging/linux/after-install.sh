#!/bin/bash
# shellcheck shell=bash
# deb/rpm post-install script (electron-builder template: ${executable} and
# ${sanitizedProductName} are replaced at build time; do not use other ${...} forms).
#
# Sandbox policy, fail-closed (the app never runs with --no-sandbox):
#   - The payload ships chrome-sandbox as root:root 0755 (NOT setuid), so there is no
#     window between unpack and this script in which a setuid helper exists.
#   - Unprivileged user namespaces work for an ordinary user  -> keep 0755.
#   - Only AppArmor restricts them (Ubuntu 23.10+)            -> install the app-specific
#     AppArmor profile (grants `userns` to this binary only); keep 0755 if it loaded.
#   - Kernel/sysctl forbids them, the probe fails, a probe tool is missing, or the
#     profile could not be loaded                              -> setuid root 4755 helper.
set -u

APP='/opt/${sanitizedProductName}'
EXE='${executable}'
SANDBOX="$APP/chrome-sandbox"

if type update-alternatives >/dev/null 2>&1; then
    if [ -L "/usr/bin/$EXE" ] && [ -e "/usr/bin/$EXE" ] && [ "$(readlink "/usr/bin/$EXE")" != "/etc/alternatives/$EXE" ]; then
        rm -f "/usr/bin/$EXE"
    fi
    update-alternatives --install "/usr/bin/$EXE" "$EXE" "$APP/$EXE" 100 || ln -sf "$APP/$EXE" "/usr/bin/$EXE"
else
    ln -sf "$APP/$EXE" "/usr/bin/$EXE"
fi

sysctl_value() { cat "/proc/sys/$1" 2>/dev/null || true; }

# Can an ordinary (non-root) user create a user namespace? As root `unshare --user`
# always succeeds, so drop to nobody first. Unknown (tool missing) counts as "no".
userns_works_for_nobody() {
    [ -e /proc/self/ns/user ] || return 1
    command -v setpriv >/dev/null 2>&1 || return 1
    command -v unshare >/dev/null 2>&1 || return 1
    setpriv --reuid=65534 --regid=65534 --clear-groups unshare --user true >/dev/null 2>&1
}

install_apparmor_profile() {
    local src="$APP/resources/apparmor-profile" dst="/etc/apparmor.d/$EXE"
    apparmor_status --enabled >/dev/null 2>&1 || return 1
    hash apparmor_parser 2>/dev/null || return 1
    apparmor_parser --skip-kernel-load --debug "$src" >/dev/null 2>&1 || return 1
    cp -f "$src" "$dst" || return 1
    if ! { [ -x /usr/bin/ischroot ] && /usr/bin/ischroot; }; then
        apparmor_parser --replace --write-cache --skip-read-cache "$dst" || return 1
    fi
}

chown root:root "$SANDBOX" 2>/dev/null || true
chmod 0755 "$SANDBOX" || true

use_setuid=0
if [ "$(sysctl_value kernel/unprivileged_userns_clone)" = 0 ] || [ "$(sysctl_value user/max_user_namespaces)" = 0 ]; then
    use_setuid=1
elif [ "$(sysctl_value kernel/apparmor_restrict_unprivileged_userns)" = 1 ]; then
    install_apparmor_profile || use_setuid=1
elif ! userns_works_for_nobody; then
    use_setuid=1
fi

if [ "$use_setuid" = 1 ]; then
    chmod 4755 "$SANDBOX" || true
fi

if hash update-mime-database 2>/dev/null; then
    update-mime-database /usr/share/mime || true
fi

if hash update-desktop-database 2>/dev/null; then
    update-desktop-database /usr/share/applications || true
fi
