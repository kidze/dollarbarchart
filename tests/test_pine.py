"""The Pine engine (static/pine.js): runs the cases of tests/pine_cases.js in a headless browser and checks that every one
passed. The browser (Edge, Chrome or Chromium) is driven through its DevTools port with a small WebSocket client of the
standard library (on Windows the browser runs detached from its launcher, so --dump-dom prints nothing). Skipped when
no such browser is installed. Run with `python tests/test_pine.py` or `pytest`."""
import base64
import json
import os
import shutil
import socket
import struct
import subprocess
import tempfile
import time
import urllib.request
from pathlib import Path
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parents[1]
BROWSERS = [
    r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
    r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "/opt/pw-browsers/chromium",
]
PAGE = ('<!doctype html><meta charset="utf-8"><pre id="out"></pre>'
        '<script>window.onerror = function(m, s, l, c){ var o = document.getElementById("out");'
        ' if (!o.textContent) o.textContent = JSON.stringify({cases: [{name: "the page", ok: false, msg: m + " at " + s + ":" + l + ":" + c}]}); };</script>'
        '<script src="{pine}"></script><script src="{cases}"></script>')


def browser():
    for p in BROWSERS:
        if os.path.isfile(p):
            return p
    for name in ("msedge", "microsoft-edge", "google-chrome", "chrome", "chromium", "chromium-browser"):
        p = shutil.which(name)
        if p:
            return p
    return None


class WS:
    """Just enough of a WebSocket client for the DevTools protocol: text frames, one call at a time."""

    def __init__(self, url, timeout=30):
        u = urlparse(url)
        self.s = socket.create_connection((u.hostname, u.port), timeout=timeout)
        key = base64.b64encode(os.urandom(16)).decode()
        self.s.sendall((f"GET {u.path} HTTP/1.1\r\nHost: {u.hostname}:{u.port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
                        f"Sec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n").encode())
        buf = b""
        while b"\r\n\r\n" not in buf:
            chunk = self.s.recv(4096)
            if not chunk:
                raise ConnectionError("no WebSocket handshake")
            buf += chunk
        head, self.rest = buf.split(b"\r\n\r\n", 1)
        if b" 101 " not in head.split(b"\r\n")[0]:
            raise ConnectionError(head.decode(errors="replace"))
        self.n = 0

    def _read(self, k):
        while len(self.rest) < k:
            chunk = self.s.recv(65536)
            if not chunk:
                raise ConnectionError("the WebSocket closed")
            self.rest += chunk
        out, self.rest = self.rest[:k], self.rest[k:]
        return out

    def send(self, obj):
        data, mask = json.dumps(obj).encode(), os.urandom(4)
        n = len(data)
        size = bytes([0x80 | n]) if n < 126 else bytes([0x80 | 126]) + struct.pack(">H", n) if n < 65536 else bytes([0x80 | 127]) + struct.pack(">Q", n)
        self.s.sendall(b"\x81" + size + mask + bytes(b ^ mask[i % 4] for i, b in enumerate(data)))

    def recv(self):
        msg = b""
        while True:
            b0, b1 = self._read(2)
            n = b1 & 0x7F
            if n == 126:
                n = struct.unpack(">H", self._read(2))[0]
            elif n == 127:
                n = struct.unpack(">Q", self._read(8))[0]
            if b1 & 0x80:
                self._read(4)
            payload, op = self._read(n), b0 & 0x0F
            if op == 8:
                raise ConnectionError("the WebSocket closed")
            if op in (0, 1, 2):
                msg += payload
                if b0 & 0x80:
                    return json.loads(msg)

    def call(self, method, params=None):
        self.n += 1
        self.send({"id": self.n, "method": method, "params": params or {}})
        while True:
            m = self.recv()
            if m.get("id") == self.n:
                if "error" in m:
                    raise RuntimeError(m["error"])
                return m.get("result", {})

    def close(self):
        try:
            self.s.close()
        except OSError:
            pass


def get_json(url):
    with urllib.request.urlopen(url, timeout=5) as r:
        return json.loads(r.read())


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def run_page(page_uri, expression, wait_s=240):
    """Opens page_uri in a fresh headless profile and returns the first non-empty value of `expression` (a JS string)."""
    exe = browser()
    if not exe:
        return None
    tmp, port, bws = tempfile.mkdtemp(prefix="dbc-pine-"), free_port(), None
    proc = subprocess.Popen([exe, "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check", "--disable-extensions",
                             "--user-data-dir=" + str(Path(tmp) / "profile"), f"--remote-debugging-port={port}", page_uri],
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        deadline = time.time() + wait_s
        while True:
            try:
                bws = get_json(f"http://127.0.0.1:{port}/json/version")["webSocketDebuggerUrl"]
                pages = [t for t in get_json(f"http://127.0.0.1:{port}/json/list") if t.get("type") == "page" and t.get("url") == page_uri]
                if pages:
                    break
            except OSError:
                pass
            if time.time() > deadline:
                raise AssertionError("the browser did not open the page")
            time.sleep(0.2)
        ws = WS(pages[0]["webSocketDebuggerUrl"])
        try:
            while time.time() < deadline:
                v = ws.call("Runtime.evaluate", {"expression": expression, "returnByValue": True}).get("result", {}).get("value")
                if v:
                    return v
                time.sleep(0.25)
            raise AssertionError("the page did not finish in time")
        finally:
            ws.close()
    finally:
        if bws:
            try:
                b = WS(bws)
                b.send({"id": 1, "method": "Browser.close"})
                b.close()
            except OSError:
                pass
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            proc.kill()
        for _ in range(20):                                      # the browser lets go of its profile a moment after it closes
            shutil.rmtree(tmp, ignore_errors=True)
            if not os.path.exists(tmp):
                break
            time.sleep(0.25)


def run_cases():
    """The results of tests/pine_cases.js: a list of {name, ok, msg}, or None when there is no browser to run them in."""
    tmp = Path(tempfile.mkdtemp(prefix="dbc-pine-page-"))
    try:
        page = tmp / "run.html"
        page.write_text(PAGE.replace("{pine}", (ROOT / "static" / "pine.js").as_uri())
                            .replace("{cases}", (ROOT / "tests" / "pine_cases.js").as_uri()), encoding="utf-8")
        text = run_page(page.as_uri(), "(document.getElementById('out') || {}).textContent || ''")
        return None if text is None else json.loads(text)["cases"]
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def test_pine_cases():
    cases = run_cases()
    if cases is None:
        try:
            import pytest
            pytest.skip("no Chromium-based browser to run static/pine.js in")
        except ImportError:
            print("skipped: no Chromium-based browser")
            return
    failed = [c for c in cases if not c["ok"]]
    assert len(cases) >= 20, f"only {len(cases)} cases ran"
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
