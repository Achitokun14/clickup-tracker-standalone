#!/usr/bin/env python3
"""ClickUp OAuth callback listener (called by oauth-bootstrap.sh).

Reads from env:
  CUP_CLIENT_ID         (required) ClickUp OAuth app Client ID
  CUP_CLIENT_SECRET     (required) ClickUp OAuth app Client Secret
  CUP_REDIRECT_URI      (default http://localhost:8765) Must match the
                        redirect URI registered on the OAuth app.
  CUP_TOKEN_OUT         (default /tmp/cup-oauth-token) Where to write
                        the access_token after exchange. Mode 600.

Behavior:
  1. Bind localhost:<port-from-CUP_REDIRECT_URI> for the callback.
  2. Print the ClickUp authorize URL and try to open the system browser.
  3. Wait up to 20 minutes for the redirect with ?code=...
  4. Exchange code for access_token via /api/v2/oauth/token.
  5. Write token to CUP_TOKEN_OUT and exit 0.

Always-stdlib (no pip installs needed).
"""
import http.server
import json
import os
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import webbrowser

CLIENT_ID = os.environ["CUP_CLIENT_ID"]
CLIENT_SECRET = os.environ["CUP_CLIENT_SECRET"]
REDIRECT_URI = os.environ.get("CUP_REDIRECT_URI", "http://localhost:8765")
TOKEN_OUT = os.environ.get("CUP_TOKEN_OUT", "/tmp/cup-oauth-token")

parsed = urllib.parse.urlparse(REDIRECT_URI)
PORT = parsed.port or 8765

state = {}


class CallbackHandler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        q = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
        code = q.get("code", [None])[0]
        err = q.get("error", [None])[0]
        if code:
            state["code"] = code
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.end_headers()
            self.wfile.write(
                b"<!doctype html><html><head><title>OK</title></head>"
                b"<body style='font-family:system-ui;padding:2rem'>"
                b"<h2>\xe2\x9c\x93 Authorized</h2>"
                b"<p>Return to your terminal.</p></body></html>"
            )
        else:
            self.send_response(400)
            self.send_header("Content-Type", "text/plain; charset=utf-8")
            self.end_headers()
            self.wfile.write(f"Missing 'code' (error={err or 'none'})".encode())
            state["err"] = err or "no code"

    def log_message(self, *_a):
        pass


def main() -> None:
    try:
        srv = http.server.HTTPServer(("127.0.0.1", PORT), CallbackHandler)
    except OSError as e:
        print(f"ERROR: cannot bind 127.0.0.1:{PORT} — {e}", file=sys.stderr)
        sys.exit(1)

    threading.Thread(target=srv.serve_forever, daemon=True).start()

    auth_url = (
        "https://app.clickup.com/api"
        f"?client_id={urllib.parse.quote(CLIENT_ID)}"
        f"&redirect_uri={urllib.parse.quote(REDIRECT_URI)}"
    )
    print(f"\n→ Open this URL in your browser to authorize:\n  {auth_url}\n")
    try:
        webbrowser.open(auth_url)
    except Exception:
        pass
    print(f"→ Listening on {REDIRECT_URI} for callback (timeout 20 min)…")

    for _ in range(1200):
        if state:
            break
        time.sleep(1)
    srv.shutdown()

    if "err" in state:
        print(f"ERROR: ClickUp returned error: {state['err']}", file=sys.stderr)
        sys.exit(2)
    if "code" not in state:
        print("ERROR: timeout waiting for callback (20 min)", file=sys.stderr)
        sys.exit(3)

    print("→ Exchanging code for access_token")
    data = urllib.parse.urlencode(
        {
            "client_id": CLIENT_ID,
            "client_secret": CLIENT_SECRET,
            "code": state["code"],
        }
    ).encode()
    req = urllib.request.Request(
        "https://api.clickup.com/api/v2/oauth/token",
        data=data,
        method="POST",
        headers={"Content-Type": "application/x-www-form-urlencoded"},
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            body = json.loads(r.read())
    except urllib.error.HTTPError as e:
        detail = e.read().decode(errors="replace")
        print(
            f"ERROR: token exchange failed (HTTP {e.code}): {detail}",
            file=sys.stderr,
        )
        sys.exit(4)

    token = body.get("access_token")
    if not token:
        print(f"ERROR: no access_token in response: {body}", file=sys.stderr)
        sys.exit(5)

    with open(TOKEN_OUT, "w") as f:
        f.write(token)
    os.chmod(TOKEN_OUT, 0o600)
    print(f"\n✓ Access token written to {TOKEN_OUT} (length={len(token)})")


if __name__ == "__main__":
    main()
