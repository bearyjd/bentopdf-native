#!/usr/bin/env bash
# Mutation test for check-postinst.sh and check-symlinks.sh. Needs no built artifact: it renders
# packaging/linux/after-install.sh like electron-builder does and breaks one thing per case.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
T="$(mktemp -d)"
trap 'rm -rf "$T"' EXIT
FAILED=0
sed -e 's/\${sanitizedProductName}/App/g' -e 's/\${executable}/app/g' "$HERE/linux/after-install.sh" > "$T/base"

post() { # name expected-exit want-substring sed-expression
  local got=0 out
  sed -E "$4" "$T/base" > "$T/post"
  out="$("$HERE/check-postinst.sh" "$T/post" 2>&1)" || got=$?
  if [ "$got" = "$2" ] && { [ -z "$3" ] || [[ "$out" == *"$3"* ]]; }; then echo "ok:   $1"; else echo "FAIL: $1 (exit $got, wanted $2 / '$3'): $out" >&2; FAILED=1; fi
}
post "rendered after-install.sh passes" 0 "" 's/^$//'
post "export ELECTRON_DISABLE_SANDBOX=1" 1 "environment variable" '/^set -u$/a export ELECTRON_DISABLE_SANDBOX=1'
post "CHROME_DEVEL_SANDBOX in script" 1 "environment variable" '$a CHROME_DEVEL_SANDBOX=/x true'
post "NODE_OPTIONS in script" 1 "environment variable" '$a export NODE_OPTIONS=--inspect'
post "unconditional chmod 4755 at the top" 1 "more than one" '/^set -u$/a chmod 4755 "$SANDBOX"'
post "sole chmod 4755 made unconditional" 1 "not guarded" 's/^if \[ "\$use_setuid" = 1 \]; then$/if true; then/'
post "setuid guard on the wrong variable" 1 "not guarded" 's/^if \[ "\$use_setuid" = 1 \]; then$/if [ "$use_setuid" = 0 ]; then/'
post "use_setuid not defaulted" 1 "default use_setuid" 's/^use_setuid=0$/use_setuid=1/'
post "no re-probe after profile load" 1 "re-probe" 's/install_apparmor_profile && userns_works_for_nobody \|\| use_setuid=1/install_apparmor_profile || use_setuid=1/'
post "no setuid fallback" 1 "no setuid fallback" 's/chmod 4755/chmod 0755/'
post "no probe as nobody" 1 "does not probe" 's/setpriv --reuid=65534/true/'

link() { # name expected-exit want-substring  (setup function body reads $T/tree)
  local got=0 out
  out="$("$HERE/check-symlinks.sh" "$T/tree" 2>&1)" || got=$?
  if [ "$got" = "$1" ] && { [ -z "$2" ] || [[ "$out" == *"$2"* ]]; }; then echo "ok:   $3"; else echo "FAIL: $3 (exit $got, wanted $1 / '$2'): $out" >&2; FAILED=1; fi
}
fresh() { rm -rf "$T/tree"; mkdir -p "$T/tree/resources" "$T/tree/lib"; : > "$T/tree/lib/a.so"; }
fresh; ln -s ../lib/a.so "$T/tree/resources/ok"; ln -s a.so "$T/tree/lib/b.so"
link 0 "" "relative in-tree symlinks pass"
fresh; ln -s /etc/passwd "$T/tree/resources/evil"
link 1 "escapes the tree" "absolute symlink to /etc/passwd fails"
fresh; ln -s ../../etc/passwd "$T/tree/resources/evil"
link 1 "escapes the tree" "relative symlink climbing out of the tree fails"
fresh; ln -s ../../../../../../../../etc/passwd "$T/tree/resources/evil"
link 1 "escapes the tree" "deeply relative symlink to /etc/passwd fails"
fresh; ln -s /opt/App/lib/a.so "$T/tree/resources/abs"
link 1 "escapes the tree" "absolute symlink (even to a path that looks in-tree) fails"
fresh; ln -s ../lib/missing.so "$T/tree/resources/dangling"
link 0 "" "dangling in-tree symlink passes"
mkdir "$T/outside"; fresh; ln -s ../../outside "$T/tree/resources/dir"
link 1 "escapes the tree" "directory symlink out of the tree fails"
exit "$FAILED"
