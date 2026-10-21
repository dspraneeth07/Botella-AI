"""Threaded stdlib HTTP server exposing the capabilities as JSON + static SPA.

Endpoints:
  GET /api/health                         -> {ok, narration_enabled, ...}
  GET /api/capabilities                   -> capability metadata
  GET /api/<capability>?store=&location=&narrate=
       capability in {inventory, buying, customers}
  (everything else)                       -> serves the React build in web/dist

Run: python -m storeagent.api.server [--port 8000] [--host 127.0.0.1]
"""
from __future__ import annotations

import argparse
import json
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from ..config import NARRATION
from .service import CAPABILITIES, capabilities_meta, run_capability

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

# Where the built React app lands (vite build -> web/dist).
WEB_DIST = Path(__file__).resolve().parent.parent.parent / "web" / "dist"

_CONTENT_TYPES = {
    ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".json": "application/json",
    ".ico": "image/x-icon", ".map": "application/json", ".woff2": "font/woff2",
}


class Handler(BaseHTTPRequestHandler):
    server_version = "StoreAgent/1.5"
    protocol_version = "HTTP/1.1"

    # ----- helpers -----
    def _send(self, code: int, body: bytes, content_type: str) -> None:
        self.send_response(code)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _json(self, code: int, payload: dict) -> None:
        self._send(code, json.dumps(payload, default=str).encode("utf-8"),
                   "application/json; charset=utf-8")

    def log_message(self, fmt: str, *args) -> None:  # quieter logs
        sys.stderr.write("  api %s - %s\n" % (self.address_string(), fmt % args))

    def do_OPTIONS(self) -> None:  # noqa: N802
        self._send(204, b"", "text/plain")

    def do_HEAD(self) -> None:  # noqa: N802
        self.do_GET()

    def do_GET(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        path = parsed.path
        if path.startswith("/api/"):
            return self._handle_api(path[len("/api/"):], parse_qs(parsed.query))
        return self._serve_static(path)

    # ----- API -----
    def _handle_api(self, route: str, qs: dict) -> None:
        route = route.strip("/")
        if route in ("health", ""):
            return self._json(200, {
                "ok": True, "narration_enabled": NARRATION.enabled,
                "capabilities": list(CAPABILITIES),
            })
        if route == "capabilities":
            return self._json(200, {"capabilities": capabilities_meta()})

        if route in CAPABILITIES:
            try:
                store = int(qs["store"][0]) if "store" in qs else None
                location = int(qs["location"][0]) if "location" in qs else None
            except (ValueError, IndexError):
                return self._json(400, {"error": "store/location must be integers"})
            narrate = qs.get("narrate", ["0"])[0] not in ("0", "false", "")
            nocache = qs.get("nocache", ["0"])[0] not in ("0", "false", "")
            try:
                result = run_capability(route, store=store, location=location,
                                        narrate=narrate, use_cache=not nocache)
            except Exception as e:  # surface as JSON, don't 500 the SPA
                return self._json(502, {"error": f"{type(e).__name__}: {e}"})
            return self._json(200, result)

        return self._json(404, {"error": f"unknown endpoint: /api/{route}"})

    # ----- static SPA -----
    def _serve_static(self, path: str) -> None:
        if not WEB_DIST.exists():
            return self._json(404, {
                "error": "Frontend build not found.",
                "hint": "cd web && npm install && npm run build  (or run the Vite dev server)",
                "api": ["/api/health", "/api/capabilities",
                        "/api/inventory?store=10", "/api/buying?store=10",
                        "/api/customers?store=88"],
            })
        rel = path.lstrip("/") or "index.html"
        target = (WEB_DIST / rel).resolve()
        # Path traversal guard + SPA fallback to index.html.
        if not str(target).startswith(str(WEB_DIST.resolve())) or not target.is_file():
            target = WEB_DIST / "index.html"
        body = target.read_bytes()
        ctype = _CONTENT_TYPES.get(target.suffix, "application/octet-stream")
        self._send(200, body, ctype)


def main() -> None:
    ap = argparse.ArgumentParser(description="StoreAgent JSON API + dashboard server")
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8000)
    args = ap.parse_args()

    httpd = ThreadingHTTPServer((args.host, args.port), Handler)
    print(f"StoreAgent API on http://{args.host}:{args.port}")
    print(f"  AI narration: {'on' if NARRATION.enabled else 'off'}")
    print(f"  frontend : {'serving ' + str(WEB_DIST) if WEB_DIST.exists() else 'not built (use Vite dev server)'}")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nshutting down")
        httpd.shutdown()


if __name__ == "__main__":
    main()
