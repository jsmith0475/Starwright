#!/bin/bash
# Starwright launcher for macOS and Linux.
# macOS: double-click this file in Finder.   Linux: run ./start.sh in a terminal.
# It serves this folder on your own machine only (127.0.0.1) and opens the game in your browser.
cd "$(dirname "$0")" || exit 1
PORT="${STARWRIGHT_PORT:-8642}"
URL="http://localhost:$PORT/"

open_browser() {
  [ -n "$STARWRIGHT_NO_BROWSER" ] && return 0
  if [ "$(uname)" = "Darwin" ]; then open "$URL"
  elif command -v xdg-open >/dev/null 2>&1; then xdg-open "$URL" >/dev/null 2>&1
  else echo "Open $URL in your browser."
  fi
}

# On a Mac without the Xcode Command Line Tools, /usr/bin/python3 is a stub that only pops up an
# install dialog, so it does not count as Python.
have_python3() {
  local p; p="$(command -v python3 2>/dev/null)" || return 1
  if [ "$(uname)" = "Darwin" ] && [ "$p" = "/usr/bin/python3" ]; then
    xcode-select -p >/dev/null 2>&1 || return 1
  fi
  return 0
}
have_ruby_httpd() { command -v ruby >/dev/null 2>&1 && ruby -e 'require "webrick"' >/dev/null 2>&1; }

# Already running (or the port is taken by something else)?
if command -v curl >/dev/null 2>&1; then
  page="$(curl -fsS --max-time 2 "$URL" 2>/dev/null)"
  if [ -n "$page" ]; then
    if printf '%s' "$page" | grep -q "<title>Starwright</title>"; then
      echo "Starwright is already running at $URL"
      open_browser; exit 0
    fi
    echo "Port $PORT is in use by another program."
    echo "Close it, or start Starwright on another port:  STARWRIGHT_PORT=8700 \"$0\""
    [ -t 0 ] && read -r _
    exit 1
  fi
fi

case "${STARWRIGHT_SERVER:-auto}" in
  python) server=python ;; node) server=node ;; ruby) server=ruby ;;
  *) if have_python3; then server=python
     elif command -v node >/dev/null 2>&1; then server=node
     elif have_ruby_httpd; then server=ruby
     else server=none; fi ;;
esac

if [ "$server" = none ]; then
  echo "Starwright needs Python 3 (or Node.js) to serve the game to your browser, and neither was found."
  if [ "$(uname)" = "Darwin" ]; then
    echo "On a Mac, run this once in Terminal and then start Starwright again:  xcode-select --install"
  else
    echo "Install Python 3 with your package manager (for example: sudo apt install python3)."
  fi
  [ -t 0 ] && read -r _
  exit 1
fi

(sleep 1; open_browser) &
echo "Starwright is running at $URL"
echo "Leave this window open while you play. Close it, or press Ctrl+C, to stop."
case "$server" in
  python) exec python3 serve.py "$PORT" ;;
  node)   exec node tests/e2e/serve.mjs "$PORT" ;;
  ruby)   exec ruby -run -e httpd . -p "$PORT" -b 127.0.0.1 ;;
esac
