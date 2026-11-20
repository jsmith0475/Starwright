#!/usr/bin/env python3
"""Static server for Starwright. Same as `python3 -m http.server`, except every reply says "no-cache", so the
browser re-checks each file and never keeps running an old copy of the game after an update."""
import sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer


class Handler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def log_message(self, *args):
        pass


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8642
    ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()
