#!/usr/bin/env python3
"""Local preview server for serve.cmd (and `python serve.py`).

Why not `python -m http.server 8000`:
- Windows lets a second listener bind a port already in use (SO_REUSEADDR)
  while connections keep going to the first, older process. We therefore probe
  with connect() (which also ignores TIME_WAIT sockets, unlike bind()) and pick
  the first free port in 8000-8010.
- The real URL is printed and opened in the browser, so a forgotten preview
  window never leaves you looking at a stale port.
- .js/.mjs/.json are served with explicit MIME types: ES modules are rejected
  when Windows' registry maps .js to something other than a JS type.

Only the standard library is used. Requires Python 3.7+.
"""

import argparse
import functools
import http.server
import os
import socket
import sys
import webbrowser

HOST = '127.0.0.1'
FIRST_PORT = 8000
LAST_PORT = 8010


class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        '.js': 'text/javascript',
        '.mjs': 'text/javascript',
        '.json': 'application/json',
        '.webmanifest': 'application/manifest+json',
        '.wasm': 'application/wasm',
        '.svg': 'image/svg+xml',
    }


def port_in_use(port):
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        probe.settimeout(0.15)
        return probe.connect_ex((HOST, port)) == 0


def open_server(start_port):
    for port in range(start_port, LAST_PORT + 1):
        if port_in_use(port):
            continue
        try:
            return http.server.ThreadingHTTPServer((HOST, port), handler_for_root()), port
        except OSError:
            continue
    return None, None


def handler_for_root():
    root = os.path.dirname(os.path.abspath(__file__))
    return functools.partial(Handler, directory=root)


def main():
    parser = argparse.ArgumentParser(description='Steve Server Map local preview')
    parser.add_argument('--port', type=int, default=FIRST_PORT, help='first port to try')
    parser.add_argument('--no-open', action='store_true', help="don't open the browser")
    args = parser.parse_args()

    root = os.path.dirname(os.path.abspath(__file__))
    os.chdir(root)

    server, port = open_server(args.port)
    if server is None:
        print(f'[x] Ports {args.port}-{LAST_PORT} are in use. Close the old preview window and try again.', flush=True)
        return 2

    url = f'http://{HOST}:{port}/'
    print(f'  Serving: {root}', flush=True)
    print(f'  URL:     {url}', flush=True)
    print('  Stop:    Ctrl + C', flush=True)
    if port != args.port:
        print(f'  [i] Port {args.port} is already taken, using {port} instead.', flush=True)
    if not args.no_open:
        webbrowser.open(url)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    print('  Stopped.', flush=True)
    return 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    except Exception as error:  # surface the full error instead of a bare traceback
        print(f'[x] {type(error).__name__}: {error}', flush=True)
        sys.exit(3)
