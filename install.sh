#!/bin/sh
set -eu

BIN_NAME="sccapture"
PACKAGE="slicc-capture"
REPO="ai-ecoverse/slicc-capture"
MIN_NODE=24

usage() {
  printf 'usage: install.sh [--version VERSION] [--dir DIR] [--help]\n'
  printf '\nInstalls %s from @ai-ecoverse/%s, with Node %s or later (downloaded if missing).\n' "$BIN_NAME" "$PACKAGE" "$MIN_NODE"
  printf '\n  --version VERSION   the release to install (default: the latest)\n'
  printf '  --dir DIR           where the launcher goes (default: %s/.local/bin)\n' "\$HOME"
  printf '  --help              print this usage and exit\n'
}

die() {
  printf 'install.sh: %s\n' "$1" >&2
  exit 1
}

usage_error() {
  printf 'install.sh: %s\n' "$1" >&2
  usage >&2
  exit 2
}

VERSION=""
INSTALL_DIR=""
DIR_GIVEN=""
BASE_URL="${SLICC_INSTALL_BASE_URL:-}"
NODE_DIST_BASE="${SLICC_NODE_DIST_BASE:-https://nodejs.org/dist}"

while [ $# -gt 0 ]; do
  case "$1" in
    --version|--dir)
      [ $# -ge 2 ] || usage_error "$1 needs a value"
      if [ "$1" = --version ]; then VERSION="${2#v}"; else INSTALL_DIR="$2"; DIR_GIVEN=1; fi
      shift 2
      ;;
    --version=*) VERSION="${1#--version=}"; VERSION="${VERSION#v}"; shift ;;
    --dir=*) INSTALL_DIR="${1#--dir=}"; DIR_GIVEN=1; shift ;;
    --help|-h) usage; exit 0 ;;
    *) usage_error "unknown option $1" ;;
  esac
done

[ -z "$DIR_GIVEN" ] || [ -n "$INSTALL_DIR" ] || usage_error "--dir needs a value"
if [ -z "${HOME:-}" ] && { [ -z "$DIR_GIVEN" ] || [ -z "${XDG_DATA_HOME:-}" ]; }; then
  die "HOME is not set; give --dir and set XDG_DATA_HOME"
fi
[ -n "$DIR_GIVEN" ] || INSTALL_DIR="$HOME/.local/bin"
DATA_DIR="${XDG_DATA_HOME:-${HOME:-}/.local/share}/$PACKAGE"

detect_os() {
  case "$(uname -s)" in
    Darwin) printf 'darwin' ;;
    Linux) printf 'linux' ;;
    *) die "no Node download for $(uname -s); install Node $MIN_NODE or later, then npm install -g @ai-ecoverse/$PACKAGE" ;;
  esac
}

detect_arch() {
  case "$(uname -m)" in
    x86_64|amd64) printf 'x64' ;;
    arm64|aarch64) printf 'arm64' ;;
    *) die "no Node download for $(uname -m); install Node $MIN_NODE or later and re-run" ;;
  esac
}

is_musl() {
  for f in /lib/ld-musl-*; do
    if [ -e "$f" ]; then return 0; fi
  done
  if command -v ldd >/dev/null 2>&1 && ldd --version 2>&1 | grep -qi musl; then return 0; fi
  return 1
}

fetch() {
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL -o "$2" "$1" || die "could not download $1"
  elif command -v wget >/dev/null 2>&1; then
    wget -qO "$2" "$1" || die "could not download $1"
  else
    die "curl or wget is required"
  fi
}

sha256() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d' ' -f1
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | cut -d' ' -f1
  else
    die "sha256sum or shasum is required"
  fi
}

verify() {
  [ -n "$2" ] || die "no checksum for $(basename "$1")"
  _actual="$(sha256 "$1")"
  [ "$_actual" = "$2" ] || die "checksum mismatch for $(basename "$1"): expected $2, got $_actual"
}

sum_of() {
  grep "^[0-9a-f]\{64\}  \*\{0,1\}$2\$" "$1" | head -1 | cut -d' ' -f1
}

node_ok() {
  _ver="$("$1" --version 2>/dev/null)" || return 1
  _major="$(printf '%s' "$_ver" | sed 's/^v//' | cut -d. -f1)"
  [ "$_major" -ge "$MIN_NODE" ] 2>/dev/null
}

find_node() {
  if command -v node >/dev/null 2>&1 && node_ok node; then
    command -v node
    return 0
  fi
  _managed="$DATA_DIR/node/bin/node"
  if [ -x "$_managed" ] && node_ok "$_managed"; then
    printf '%s' "$_managed"
    return 0
  fi
  return 1
}

pick_node() {
  printf '%s\n' "$1" | tr '{' '\n' | \
    sed -n 's/.*"version": *"v\([0-9][0-9]*\)\.\([0-9][0-9.]*\)".*"lts": *\([^,}]*\).*/\1 \2 \3/p' | \
    awk -v min="$MIN_NODE" -v lts="$2" '$1 + 0 >= min + 0 && (lts == 0 || $3 != "false") { print "v" $1 "." $2; exit }'
}

ensure_node() {
  if _found="$(find_node)"; then
    printf '%s' "$_found"
    return 0
  fi
  _os="$(detect_os)"
  _arch="$(detect_arch)"
  if [ "$_os" = linux ] && is_musl; then
    die "no official Node for musl; install Node $MIN_NODE or later (for example apk add nodejs-current) and re-run"
  fi
  printf 'install.sh: no Node %s or later on PATH, downloading it\n' "$MIN_NODE" >&2
  _tmp="$(mktemp -d)"
  fetch "$NODE_DIST_BASE/index.json" "$_tmp/index.json"
  _index="$(cat "$_tmp/index.json")"
  _version="$(pick_node "$_index" 1)"
  [ -n "$_version" ] || _version="$(pick_node "$_index" 0)"
  [ -n "$_version" ] || die "no Node $MIN_NODE or later in $NODE_DIST_BASE/index.json"
  _archive="node-$_version-$_os-$_arch.tar.gz"
  fetch "$NODE_DIST_BASE/$_version/SHASUMS256.txt" "$_tmp/SHASUMS256.txt"
  fetch "$NODE_DIST_BASE/$_version/$_archive" "$_tmp/$_archive"
  verify "$_tmp/$_archive" "$(sum_of "$_tmp/SHASUMS256.txt" "$_archive")"
  mkdir -p "$DATA_DIR"
  _extract="$DATA_DIR/.node-$$"
  rm -rf "$_extract"
  mkdir -p "$_extract"
  tar xzf "$_tmp/$_archive" -C "$_extract" --strip-components=1
  rm -rf "$_tmp" "$DATA_DIR/node"
  mv "$_extract" "$DATA_DIR/node"
  printf 'install.sh: Node %s installed to %s\n' "$_version" "$DATA_DIR/node" >&2
  printf '%s' "$DATA_DIR/node/bin/node"
}

quoted() {
  printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"
}

NODE_BIN="$(ensure_node)"
NODE_ABS="$(cd "$(dirname "$NODE_BIN")" && pwd -P)/$(basename "$NODE_BIN")"

if [ -z "$BASE_URL" ]; then
  if [ -z "$VERSION" ]; then
    BASE_URL="https://github.com/$REPO/releases/latest/download"
  else
    BASE_URL="https://github.com/$REPO/releases/download/v$VERSION"
  fi
fi
BASE_URL="${BASE_URL%/}"

TMP_INSTALL="$(mktemp -d)"
EXTRACT=""
trap 'rm -rf "$TMP_INSTALL" ${EXTRACT:+"$EXTRACT"}' EXIT

fetch "$BASE_URL/SHA256SUMS" "$TMP_INSTALL/SHA256SUMS"
if [ -n "$VERSION" ]; then
  TGZ="$PACKAGE-$VERSION.tgz"
else
  TGZ="$(sed -n "s/^[0-9a-f]\{64\}  \*\{0,1\}\($PACKAGE-[0-9][0-9A-Za-z.+-]*\.tgz\)\$/\1/p" "$TMP_INSTALL/SHA256SUMS" | head -1)"
  [ -n "$TGZ" ] || die "no $PACKAGE tarball in $BASE_URL/SHA256SUMS"
fi
fetch "$BASE_URL/$TGZ" "$TMP_INSTALL/$TGZ"
verify "$TMP_INSTALL/$TGZ" "$(sum_of "$TMP_INSTALL/SHA256SUMS" "$TGZ")"

BUNDLE_VERSION="${TGZ#"$PACKAGE"-}"
BUNDLE_VERSION="${BUNDLE_VERSION%.tgz}"
BUNDLE_DIR="$DATA_DIR/$BUNDLE_VERSION"
mkdir -p "$DATA_DIR"
EXTRACT="$DATA_DIR/.bundle-$$"
rm -rf "$EXTRACT"
mkdir -p "$EXTRACT"
tar xzf "$TMP_INSTALL/$TGZ" -C "$EXTRACT" --strip-components=1
ENTRY="$BUNDLE_DIR/host/$BIN_NAME.mjs"
[ -f "$EXTRACT/host/$BIN_NAME.mjs" ] || die "$TGZ has no host/$BIN_NAME.mjs"
if "$NODE_ABS" -e 'const f = process.argv[1]; const p = JSON.parse(require("fs").readFileSync(f, "utf8")); if (Object.keys({ ...p.dependencies, ...p.optionalDependencies }).length === 0) process.exit(1); delete p.devDependencies; require("fs").writeFileSync(f, JSON.stringify(p, null, 2))' "$EXTRACT/package.json"; then
  NODE_DIR="$(dirname "$NODE_ABS")"
  NPM_CLI="$NODE_DIR/../lib/node_modules/npm/bin/npm-cli.js"
  if [ -f "$NPM_CLI" ]; then
    (cd "$EXTRACT" && PATH="$NODE_DIR:$PATH" "$NODE_ABS" "$NPM_CLI" install --omit=dev --ignore-scripts --no-audit --no-fund >&2) || die "npm install failed for $TGZ"
  elif command -v npm >/dev/null 2>&1; then
    (cd "$EXTRACT" && PATH="$NODE_DIR:$PATH" npm install --omit=dev --ignore-scripts --no-audit --no-fund >&2) || die "npm install failed for $TGZ"
  else
    die "$TGZ has dependencies, and there is no npm next to $NODE_ABS or on PATH"
  fi
fi
rm -rf "$BUNDLE_DIR"
mv "$EXTRACT" "$BUNDLE_DIR"

mkdir -p "$INSTALL_DIR"
INSTALL_DIR="$(cd "$INSTALL_DIR" && pwd -P)"
LAUNCHER="$INSTALL_DIR/$BIN_NAME"
LAUNCHER_TMP="$LAUNCHER.tmp.$$"
{
  printf '#!/bin/sh\n'
  printf 'SCCAPTURE_INSTALL_DIR=%s\n' "$(quoted "$INSTALL_DIR")"
  printf 'export SCCAPTURE_INSTALL_DIR\n'
  printf ": \"\${NODE_USE_ENV_PROXY=1}\"\\n"
  printf 'export NODE_USE_ENV_PROXY\n'
  printf 'exec %s %s "$@"\n' "$(quoted "$NODE_ABS")" "$(quoted "$ENTRY")"
} > "$LAUNCHER_TMP"
chmod 755 "$LAUNCHER_TMP"
mv "$LAUNCHER_TMP" "$LAUNCHER"

REPORTED="$("$LAUNCHER" --version 2>/dev/null)" || die "$LAUNCHER --version failed"
[ "$REPORTED" = "$BUNDLE_VERSION" ] || [ "$REPORTED" = "$BIN_NAME $BUNDLE_VERSION" ] || die "$LAUNCHER reports $REPORTED, not $BUNDLE_VERSION"
printf '%s %s installed to %s\n' "$BIN_NAME" "$BUNDLE_VERSION" "$LAUNCHER"

case ":$PATH:" in
  *":$INSTALL_DIR:"*) ;;
  *) printf 'Add %s to your PATH: export PATH="%s:%s"\n' "$INSTALL_DIR" "$INSTALL_DIR" "\$PATH" ;;
esac
