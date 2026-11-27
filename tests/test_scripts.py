"""The indicators loaded from a file, on the page (static/scripts.js): runs the cases of tests/scripts_cases.js in a
headless browser, on a page with the chart library, ui.js and scripts.js and a stand-in for the rest of the app. The
scripts run in the real engine (static/pine.js) in workers, so the page is served over HTTP from this checkout, by a
server of this test's own that lives as long as the test. Skipped when no Chromium-based browser is installed. Run
with `python tests/test_scripts.py` or `pytest`."""
import http.server
import json
import threading
from pathlib import Path

from test_pine import browser, run_page

ROOT = Path(__file__).resolve().parents[1]
PAGE = ('<!doctype html><meta charset="utf-8">'
        '<div id="chart" style="width:900px;height:500px"></div><div id="lgScr"></div><pre id="out"></pre>'
        '<script>window.onerror = function(m, s, l, c){ var o = document.getElementById("out");'
        ' if (!o.textContent) o.textContent = JSON.stringify({cases: [{name: "the page", ok: false, msg: m + " at " + s + ":" + l + ":" + c}]}); };</script>'
        '<script src="/lightweight-charts.js"></script><script src="/static/ui.js"></script><script src="/static/scripts.js"></script>'
        '<script src="/tests/scripts_cases.js"></script>')
TYPES = {".js": "text/javascript", ".css": "text/css"}


class Handler(http.server.BaseHTTPRequestHandler):
    """The test page, and the files it asks for: the chart library and what is in static/ and tests/."""

    def do_GET(self):
        p = self.path.split("?")[0]
        if p == "/test.html":
            body, kind = PAGE.encode(), "text/html; charset=utf-8"
        else:
            f = (ROOT / p.lstrip("/")).resolve()
            if not f.is_file() or not (f == ROOT / "lightweight-charts.js" or f.parent in (ROOT / "static", ROOT / "tests")):
                return self.send_error(404)
            body, kind = f.read_bytes(), TYPES.get(f.suffix, "application/octet-stream")
        self.send_response(200)
        self.send_header("Content-Type", kind)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass


def run_cases():
    """The results of tests/scripts_cases.js: a list of {name, ok, msg}, or None when there is no browser to run them in."""
    if not browser():
        return None
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    try:
        text = run_page(f"http://127.0.0.1:{srv.server_address[1]}/test.html", "(document.getElementById('out') || {}).textContent || ''")
        return None if text is None else json.loads(text)["cases"]
    finally:
        srv.shutdown()
        srv.server_close()


def test_scripts_cases():
    cases = run_cases()
    if cases is None:
        try:
            import pytest
            pytest.skip("no Chromium-based browser to run static/scripts.js in")
        except ImportError:
            print("skipped: no Chromium-based browser")
            return
    failed = [c for c in cases if not c["ok"]]
    assert len(cases) >= 14, f"only {len(cases)} cases ran"
    assert not failed, "\n\n".join(f"{c['name']}:\n{c.get('msg', '')}" for c in failed)


if __name__ == "__main__":
    res = run_cases()
    if res is None:
        print("skipped: no Chromium-based browser")
    else:
        for c in res:
            print("ok  " if c["ok"] else "FAIL", c["name"])
            if not c["ok"]:
                print("    " + c.get("msg", "").replace("\n", "\n    "))
        print(f"{sum(c['ok'] for c in res)}/{len(res)} passed")
        raise SystemExit(0 if all(c["ok"] for c in res) else 1)
