#!/bin/sh
# Starwright launcher for Linux (and macOS from a terminal). Same as start.command.
exec bash "$(dirname "$0")/start.command" "$@"
