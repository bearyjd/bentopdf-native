#!/usr/bin/env bash
# Checksum-pinned artifact acquisition, sourced by scripts/build-local.sh (and its tests).
# Caller provides: die, info, T (private 0700 temp dir), CACHE_DIR, CHECKSUMS, CURL_OPTS,
# UPDATE_CHECKSUMS and NEWSUMS (file collecting new sums in --update-checksums mode).
#
# TOCTOU: the shared cache dir can be written by anyone who can write the repo checkout,
# so a file is never used from there. Every artifact is copied into $T/verified (private),
# verified AS THAT COPY, and only the private copy is handed to callers via $ACQUIRED.
sum_of()  { sha256sum "$1" | awk '{print $1}'; }
want_of() { awk -v k="$1" '$2==k{print $1; exit}' "$CHECKSUMS"; }

verify_or_die() { # key file [also-delete] : compare against scripts/checksums.sha256, delete file(s) on failure
  local key=$1 file=$2 extra=${3:-} want got
  want="$(want_of "$key")"
  [ -n "$want" ] || { rm -f "$file" ${extra:+"$extra"}; die "no pinned checksum for $key; review the source, then run scripts/build-local.sh --update-checksums"; }
  got="$(sum_of "$file")"
  [ "$got" = "$want" ] || { rm -f "$file" ${extra:+"$extra"}; die "checksum mismatch for $key (pinned $want, got $got); cache entry deleted"; }
}

check_members() { # tgz : reject absolute paths, .. components and any link member
  local names links
  tar tzf "$1" >/dev/null 2>&1 || die "$1 is not a readable tar.gz"
  names="$(tar tzf "$1" | awk '/^\// || /(^|\/)\.\.(\/|$)/')"
  [ -z "$names" ] || die "$1 contains unsafe member paths: $(echo "$names" | awk 'NR==1')"
  links="$(tar tvzf "$1" | awk '$1 ~ /^[lh]/')"
  [ -z "$links" ] || die "$1 contains link members; refusing"
}

validate_file() { # key file : structural check of a downloaded file
  case "$1" in
    *.tgz) check_members "$2" ;;
    *.gz)  gzip -t "$2" 2>/dev/null || die "$1 is not valid gzip" ;;
    *)     [ -s "$2" ] || die "$1 is empty" ;;
  esac
}

ACQUIRED=""   # read by the sourcing script
# shellcheck disable=SC2034
acquire() { # key kind(npm|url) arg : verified PRIVATE copy lands at $T/verified/<key>, path in $ACQUIRED
  local key=$1 kind=$2 arg=$3 f="$CACHE_DIR/$1" priv="$T/verified/$1" part tmp
  ACQUIRED="$priv"
  mkdir -p "$(dirname "$f")" "$(dirname "$priv")"
  if [ "$UPDATE_CHECKSUMS" != true ] && [ -f "$f" ]; then
    cp --reflink=auto -- "$f" "$priv"          # copy first, then verify the copy: nothing swapped later can reach the build
    verify_or_die "$key" "$priv" "$f"         # every cache hit is re-verified
    return 0
  fi
  part="$f.part"; rm -f "$part"
  info "downloading $key"
  if [ "$kind" = npm ]; then
    tmp="$(mktemp -d)"
    (cd "$tmp" && npm pack "$arg" --ignore-scripts --quiet >/dev/null) || die "npm pack $arg failed"
    mv -- "$tmp"/*.tgz "$priv"; rmdir "$tmp"
  else
    curl "${CURL_OPTS[@]}" "$arg" -o "$priv" || { rm -f "$priv"; die "download failed: $arg"; }
  fi
  validate_file "$key" "$priv"
  if [ "$UPDATE_CHECKSUMS" = true ]; then
    printf '%s  %s\n' "$(sum_of "$priv")" "$key" >> "$NEWSUMS"
  else
    verify_or_die "$key" "$priv"              # verified BEFORE it enters the cache
  fi
  cp --reflink=auto -- "$priv" "$part"; mv -- "$part" "$f"   # cache is filled from the verified bytes
}

npm_artifact() { # spec -> cached tgz (npm pack output is the registry tarball)
  acquire "npm/$(echo "$1" | sed 's#^@##; s#/#-#; s#@#-#').tgz" npm "$1"
}

safe_untar() { # tgz dest [strip-components]
  check_members "$1"
  mkdir -p "$2"
  tar xzf "$1" --no-same-owner -C "$2" --strip-components="${3:-0}"
}

