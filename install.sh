#!/bin/sh
set -eu

NAME=slicc-capture
BIN=sccapture
REPO=ai-ecoverse/slicc-capture
MIN_NODE=24

die() {
  printf '%s: %s\n' "$NAME" "$1" >&2
  exit 1
}

usage() {
  printf 'usage: install.sh [--version <version>] [--dir <dir>] [--help]\n\n'
  printf 'Installs %s, from the latest release of %s or <version>, with Node %s or later (downloaded if missing).\n\n' "$BIN" "$REPO" "$MIN_NODE"
  printf '  --version <version>  the release to install (default: the latest; or VERSION)\n'
  printf '  --dir <dir>          where the launcher goes (default: ~/.local/bin; or INSTALL_DIR)\n'
  printf '  --help               print this and exit\n'
}

[ -n "${HOME:-}" ] || die 'HOME is not set'

VERSION="${VERSION:-}"
INSTALL_DIR="${INSTALL_DIR:-$HOME/.local/bin}"
RELEASES="${SLICC_INSTALL_BASE_URL:-https://github.com/$REPO/releases}"
NODE_DIST="${SLICC_NODE_DIST_BASE:-https://nodejs.org/dist}"
DATA="${XDG_DATA_HOME:-$HOME/.local/share}/$NAME"

while [ $# -gt 0 ]; do
  case "$1" in
    --help)
      usage
      exit 0
      ;;
    --version | --dir)
      [ $# -ge 2 ] && [ -n "$2" ] || die "$1 needs a value"
      if [ "$1" = --version ]; then VERSION="$2"; else INSTALL_DIR="$2"; fi
      shift 2
      ;;
    *)
      printf '%s: unknown option: %s\n' "$NAME" "$1" >&2
      exit 1
      ;;
  esac
done

VERSION="${VERSION#v}"
if [ -n "$VERSION" ] && ! printf '%s\n' "$VERSION" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+([-+][0-9A-Za-z.-]+)?$'; then
  die "invalid version: $VERSION"
fi
[ -n "$INSTALL_DIR" ] || die '--dir needs a value'

TMP=
STAGE=
cleanup() {
  [ -z "$TMP" ] || rm -rf "$TMP"
  [ -z "$STAGE" ] || rm -rf "$STAGE"
}
trap cleanup EXIT
trap 'exit 1' HUP INT TERM
TMP="$(mktemp -d)"

fetch() {
  if command -v curl >/dev/null 2>&1; then
    curl -fsL -o "$2" "$1" || die "download failed: $1"
  elif command -v wget >/dev/null 2>&1; then
    wget -q -O "$2" "$1" || die "download failed: $1"
  else
    die 'curl or wget is required'
  fi
}

sha256() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d' ' -f1
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | cut -d' ' -f1
  else
    die 'sha256sum or shasum is required'
  fi
}

verify() {
  [ -n "$3" ] || die "no checksum for $2"
  actual="$(sha256 "$1")"
  [ "$actual" = "$3" ] || die "checksum mismatch for $2"
}

absolute() {
  printf '%s/%s\n' "$(cd "$(dirname "$1")" && pwd -P)" "$(basename "$1")"
}

new_enough() {
  version="$("$1" --version 2>/dev/null)" || return 1
  major="${version#v}"
  major="${major%%.*}"
  case "$major" in
    '' | *[!0-9]*) return 1 ;;
  esac
  [ "$major" -ge "$MIN_NODE" ]
}

download_node() {
  case "$(uname -s)" in
    Darwin) os=darwin ;;
    Linux) os=linux ;;
    *) die "unsupported OS: $(uname -s); install Node $MIN_NODE or later, or use npm install -g @ai-ecoverse/slicc-capture" ;;
  esac
  case "$(uname -m)" in
    x86_64 | amd64) arch=x64 ;;
    arm64 | aarch64) arch=arm64 ;;
    *) die "unsupported architecture: $(uname -m); install Node $MIN_NODE or later, or use npm install -g @ai-ecoverse/slicc-capture" ;;
  esac
  if [ "$os" = linux ]; then
    musl=
    for f in /lib/ld-musl-*; do
      [ -e "$f" ] && musl=1
    done
    if [ -z "$musl" ] && command -v ldd >/dev/null 2>&1 && ldd --version 2>&1 | grep -qi musl; then
      musl=1
    fi
    [ -z "$musl" ] || die "nodejs.org has no Node for musl Linux; install Node $MIN_NODE or later with the package manager (apk add nodejs) and run this again"
  fi
  fetch "$NODE_DIST/index.json" "$TMP/index.json"
  lts=
  for v in $(tr '}' '\n' <"$TMP/index.json" | sed -n 's/^.*"version":"v\([0-9][0-9.]*\)".*"lts":"[^"]*".*$/\1/p'); do
    if [ "${v%%.*}" -ge "$MIN_NODE" ]; then
      lts="$v"
      break
    fi
  done
  [ -n "$lts" ] || die "no Node LTS release $MIN_NODE or later in $NODE_DIST/index.json"
  archive="node-v$lts-$os-$arch.tar.gz"
  fetch "$NODE_DIST/v$lts/SHASUMS256.txt" "$TMP/SHASUMS256.txt"
  printf '%s: downloading Node %s\n' "$NAME" "$lts" >&2
  fetch "$NODE_DIST/v$lts/$archive" "$TMP/$archive"
  verify "$TMP/$archive" "$archive" "$(sed -n "s/^\([0-9a-f]\{64\}\) [ *]$archive\$/\1/p" "$TMP/SHASUMS256.txt" | head -n 1)"
  mkdir -p "$DATA"
  STAGE="$DATA/.node-$$"
  rm -rf "$STAGE"
  mkdir -p "$STAGE"
  tar -xzf "$TMP/$archive" -C "$STAGE" --strip-components=1 || die "could not unpack $archive"
  [ -x "$STAGE/bin/node" ] || die "no bin/node in $archive"
  rm -rf "$DATA/node"
  mv "$STAGE" "$DATA/node"
  STAGE=
  NODE="$DATA/node/bin/node"
}

NODE=
if command -v node >/dev/null 2>&1 && new_enough node; then
  NODE="$(absolute "$(command -v node)")"
elif [ -x "$DATA/node/bin/node" ] && new_enough "$DATA/node/bin/node"; then
  NODE="$DATA/node/bin/node"
else
  download_node
fi
new_enough "$NODE" || die "$NODE is not Node $MIN_NODE or later"

if [ -n "$VERSION" ]; then
  BASE="$RELEASES/download/v$VERSION"
else
  BASE="$RELEASES/latest/download"
fi
fetch "$BASE/SHA256SUMS" "$TMP/SHA256SUMS"
if [ -z "$VERSION" ]; then
  VERSION="$(sed -n "s/^[0-9a-f]\{64\} [ *]$NAME-\([0-9][0-9A-Za-z.+-]*\)\.tgz\$/\1/p" "$TMP/SHA256SUMS" | head -n 1)"
  [ -n "$VERSION" ] || die "no $NAME tarball in $BASE/SHA256SUMS"
fi
TARBALL="$NAME-$VERSION.tgz"
SUM="$(sed -n "s/^\([0-9a-f]\{64\}\) [ *]$TARBALL\$/\1/p" "$TMP/SHA256SUMS" | head -n 1)"
[ -n "$SUM" ] || die "no checksum for $TARBALL in $BASE/SHA256SUMS"
fetch "$BASE/$TARBALL" "$TMP/$TARBALL"
verify "$TMP/$TARBALL" "$TARBALL" "$SUM"

mkdir -p "$DATA"
DATA="$(cd "$DATA" && pwd -P)"
STAGE="$DATA/.install-$$"
rm -rf "$STAGE"
mkdir -p "$STAGE"
tar -xzf "$TMP/$TARBALL" -C "$STAGE" --strip-components=1 || die "could not unpack $TARBALL"
[ -f "$STAGE/host/$BIN.mjs" ] || die "no host/$BIN.mjs in $TARBALL"
rm -rf "${DATA:?}/$VERSION"
mv "$STAGE" "$DATA/$VERSION"
STAGE=
rm -f "$DATA/current"
ln -s "$VERSION" "$DATA/current"

quote() {
  printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"
}

mkdir -p "$INSTALL_DIR" || die "could not create $INSTALL_DIR"
DIR="$(cd "$INSTALL_DIR" && pwd -P)"
LAUNCHER="$DIR/$BIN"
printf '#!/bin/sh\nexec %s %s "$@"\n' "$(quote "$NODE")" "$(quote "$DATA/$VERSION/host/$BIN.mjs")" >"$LAUNCHER.$$" || die "could not write $LAUNCHER"
chmod 755 "$LAUNCHER.$$"
mv -f "$LAUNCHER.$$" "$LAUNCHER"

INSTALLED="$("$LAUNCHER" --version 2>/dev/null)" || die "$LAUNCHER --version failed"
printf '%s %s installed to %s\n' "$BIN" "$INSTALLED" "$LAUNCHER"
case ":$PATH:" in
  *":$INSTALL_DIR:"* | *":$DIR:"*) ;;
  *) printf '%s is not on PATH; add it with: export PATH="%s:%s"\n' "$DIR" "$DIR" "\$PATH" ;;
esac
