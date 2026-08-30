#!/bin/sh
# CHIMERA installer.
#
#   curl -fsSL https://raw.githubusercontent.com/HammadM-dev/chimera/main/scripts/install.sh | sh
#
# Downloads the latest release, puts it somewhere sensible, and leaves a
# `chimera` command on PATH. No root, no package manager, nothing outside the
# user's own home directory.
#
# Why a terminal installer rather than "download the .dmg":
#
#   macOS refuses to open an app that was downloaded by a browser and is not
#   signed by a paid Developer ID — Gatekeeper reads the `com.apple.quarantine`
#   attribute the browser attaches, and there is no "open anyway" that a normal
#   person will find. Windows shows the same class of warning via SmartScreen
#   and Mark-of-the-Web. Neither attribute is set by curl. So this path works
#   today, and the certificates can come later without changing anything a user
#   does.
#
# POSIX sh on purpose: this runs before anything of ours exists, on whatever
# shell the machine has.

set -eu

REPO="HammadM-dev/chimera"
PREFIX="${CHIMERA_PREFIX:-$HOME/.local}"
LIB="$PREFIX/share/chimera"
BIN="$PREFIX/bin"

say() { printf '%s\n' "$*"; }
die() { printf 'install: %s\n' "$*" >&2; exit 1; }

need() {
  command -v "$1" >/dev/null 2>&1 || die "this needs \`$1\`, which is not installed."
}

need curl

os="$(uname -s)"
arch="$(uname -m)"

case "$os" in
  Linux)  platform=linux ;;
  Darwin) platform=mac ;;
  *) die "unsupported system \"$os\". CHIMERA runs on Linux, macOS and Windows; on Windows use install.ps1." ;;
esac

# Normalised because the two names for the same chip differ by platform, and
# the release assets use one of them.
case "$arch" in
  x86_64|amd64) arch=x64 ;;
  aarch64|arm64) arch=arm64 ;;
  *) die "unsupported architecture \"$arch\"." ;;
esac

say "Looking for the latest release..."

# The repository is public, so this needs no token — a 404 here means there is
# no release yet rather than that something is wrong with the network, and the
# message below says so.
#
# Overridable so the installer can be tested against a local release before a
# real one exists, and so a mirror is possible later without a second copy of
# this script. Defaults to GitHub, which is what every user gets.
api="${CHIMERA_RELEASES_API:-https://api.github.com/repos/$REPO/releases/latest}"
release="$(curl -fsSL "$api" 2>/dev/null)" || die \
  "could not read $REPO's releases — there may not be one published yet."

version="$(printf '%s' "$release" | sed -n 's/.*"tag_name": *"\([^"]*\)".*/\1/p' | head -1)"
[ -n "$version" ] || die "no released version found yet."

# One asset per platform: an AppImage on Linux, a zip holding the .app on
# macOS. Matched on extension rather than on a composed filename so a rename in
# electron-builder's defaults does not silently break the installer.
case "$platform" in
  linux) pattern='[^"]*\.AppImage' ;;
  mac)   pattern='[^"]*mac[^"]*\.zip' ;;
esac

assets="$(printf '%s' "$release" \
  | tr ',' '\n' \
  | sed -n "s/.*\"browser_download_url\": *\"\($pattern\)\".*/\1/p")"

url="$(printf '%s' "$assets" | grep -i -- "$arch" | head -1)"

# electron-builder names the x64 build without an architecture suffix, so an
# x64 machine usually matches nothing above and has to fall back to the
# unsuffixed asset.
#
# The fallback excludes anything named for the *other* architecture rather than
# taking the first of its kind. Taking the first would hand an arm64 build to
# an Intel machine whenever a release happened to ship only arm64 — an install
# that completes and then refuses to start, which is far harder to work out
# from the outside than "no asset for your platform".
if [ -z "$url" ]; then
  case "$arch" in
    x64)   other='arm64\|aarch64' ;;
    arm64) other='x64\|amd64\|x86_64' ;;
  esac
  url="$(printf '%s' "$assets" | grep -iv -- "$other" | head -1)"
fi

[ -n "$url" ] || die "release $version has no asset for $platform/$arch."

say "Installing CHIMERA $version for $platform/$arch..."

mkdir -p "$LIB" "$BIN"

# A temp directory that is cleaned up however this exits, so a failed download
# never leaves a half-written app behind for the shim to point at.
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT INT TERM

if [ "$platform" = linux ]; then
  curl -fSL --progress-bar "$url" -o "$tmp/chimera.AppImage" || die "download failed."
  chmod +x "$tmp/chimera.AppImage"
  mv "$tmp/chimera.AppImage" "$LIB/chimera.AppImage"

  cat > "$BIN/chimera" <<EOF
#!/bin/sh
exec "$LIB/chimera.AppImage" "\$@"
EOF
  chmod +x "$BIN/chimera"
  installed="$LIB/chimera.AppImage"
else
  need unzip
  curl -fSL --progress-bar "$url" -o "$tmp/chimera.zip" || die "download failed."
  unzip -q "$tmp/chimera.zip" -d "$tmp/unpacked" || die "the download could not be unpacked."

  app="$(find "$tmp/unpacked" -maxdepth 2 -name '*.app' -print | head -1)"
  [ -n "$app" ] || die "no application found inside the download."

  mkdir -p "$HOME/Applications"
  rm -rf "$HOME/Applications/$(basename "$app")"
  mv "$app" "$HOME/Applications/"
  installed="$HOME/Applications/$(basename "$app")"

  # `open` rather than executing the binary directly: it hands the app to
  # launchd the way a double-click does, so it gets its own process group and
  # does not die with the terminal it was started from.
  cat > "$BIN/chimera" <<EOF
#!/bin/sh
exec open -a "$installed" --args "\$@"
EOF
  chmod +x "$BIN/chimera"
fi

say ""
say "CHIMERA $version is installed."
say "  app:     $installed"
say "  command: $BIN/chimera"

# Said only when it is true, and said as the one remaining step rather than as
# a warning about a thing that already worked.
case ":$PATH:" in
  *":$BIN:"*) say ""; say "Type \`chimera\` to start." ;;
  *)
    say ""
    say "$BIN is not on your PATH. Add it, then type \`chimera\`:"
    say ""
    say "  echo 'export PATH=\"$BIN:\$PATH\"' >> ~/.profile && . ~/.profile"
    ;;
esac
