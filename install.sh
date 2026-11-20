#!/bin/sh
# Starwright one-step installer for macOS and Linux.
#
#   curl -fsSL https://raw.githubusercontent.com/jsmith0475/Starwright/main/install.sh | sh
#
# Downloads the game into ~/Starwright, adds a shortcut, and starts it. Run it again to update.
# Nothing is installed system-wide and nothing needs sudo. To remove Starwright, delete the folder.
#
# Options (environment variables):
#   STARWRIGHT_DIR=/some/folder   install somewhere other than ~/Starwright
#   STARWRIGHT_NO_LAUNCH=1        install only, do not start the game
set -eu

REPO="jsmith0475/Starwright"
REF="${STARWRIGHT_REF:-main}"
DIR="${STARWRIGHT_DIR:-$HOME/Starwright}"
ARCHIVE="${STARWRIGHT_ARCHIVE_URL:-https://github.com/$REPO/archive/refs/heads/$REF.tar.gz}"

say() { printf '%s\n' "$*"; }
fail() { say "Starwright install failed: $*" >&2; exit 1; }
is_starwright() { [ -f "$1/index.html" ] && grep -q "<title>Starwright</title>" "$1/index.html"; }

command -v tar >/dev/null 2>&1 || fail "the 'tar' command is missing."
TMP="$(mktemp -d 2>/dev/null || mktemp -d -t starwright)"
trap 'rm -rf "$TMP"' EXIT INT TERM

say "Downloading Starwright..."
if command -v curl >/dev/null 2>&1; then
  curl -fsSL "$ARCHIVE" -o "$TMP/starwright.tar.gz" || fail "could not download $ARCHIVE"
elif command -v wget >/dev/null 2>&1; then
  wget -q "$ARCHIVE" -O "$TMP/starwright.tar.gz" || fail "could not download $ARCHIVE"
else
  fail "neither curl nor wget was found."
fi

mkdir "$TMP/src"
tar -xzf "$TMP/starwright.tar.gz" -C "$TMP/src" --strip-components=1 || fail "the download could not be unpacked."
is_starwright "$TMP/src" || fail "the download does not look like Starwright."

if [ -e "$DIR" ]; then
  if is_starwright "$DIR"; then
    say "Updating the copy in $DIR (your saved games live in the browser and are not touched)."
    mv "$DIR" "$TMP/previous"
  else
    fail "$DIR already exists and is not a Starwright folder. Move it, or set STARWRIGHT_DIR to another folder."
  fi
fi
mkdir -p "$(dirname "$DIR")"
mv "$TMP/src" "$DIR"
chmod +x "$DIR/start.command" "$DIR/start.sh"

OS="$(uname)"
if [ "$OS" = "Darwin" ]; then
  if [ -d "$HOME/Desktop" ]; then
    ln -sf "$DIR/start.command" "$HOME/Desktop/Starwright.command" 2>/dev/null \
      && say "Added a Starwright shortcut to your Desktop." || true
  fi
else
  APPS="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
  if mkdir -p "$APPS" 2>/dev/null; then
    cat > "$APPS/starwright.desktop" <<DESKTOP
[Desktop Entry]
Type=Application
Name=Starwright
Comment=Build rockets and fly them with real orbital mechanics
Exec="$DIR/start.sh"
Path=$DIR
Terminal=true
Categories=Game;Simulation;
DESKTOP
    say "Added Starwright to your applications menu."
  fi
fi

say ""
say "Starwright is installed in $DIR"
if [ -n "${STARWRIGHT_NO_LAUNCH:-}" ]; then
  say "Start it any time with:  \"$DIR/start.sh\""
  exit 0
fi
say "Starting it now. Next time, use the shortcut or run:  \"$DIR/start.sh\""
say ""
trap - EXIT INT TERM
rm -rf "$TMP"
if [ "$OS" = "Darwin" ]; then
  open "$DIR/start.command"
else
  exec "$DIR/start.sh"
fi
