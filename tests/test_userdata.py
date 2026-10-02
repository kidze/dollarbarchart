"""Saved drawings and chart settings: storage, damaged files, and the HTTP routes the page uses (including that only the
app's own page may write). Run with `python tests/test_userdata.py` or `pytest`."""
import json
import shutil
import sys
import tempfile
import threading
import urllib.error
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import bybit_sync as X  # noqa: E402
import userdata as U  # noqa: E402

KEY = "linear:TESTUSDT"
LINE = {"id": "a1", "type": "trendline", "points": [{"t": 1700000000, "p": 100.5}, {"t": 1700003600, "p": 101}],
        "style": {"color": "rgba(41,98,255,1)", "width": 2}}


class TempData:
    """Points the user-data files at a fresh temporary folder for the duration of a test."""

    def __enter__(self) -> Path:
        self.d = Path(tempfile.mkdtemp(prefix="dbc-user-"))
        self.old = X.DATA, U.DRAWINGS, U.SETTINGS
        X.DATA, U.DRAWINGS, U.SETTINGS = self.d, self.d / "drawings.json", self.d / "settings.json"
        U.forget()
        return self.d

    def __exit__(self, *exc):
        X.DATA, U.DRAWINGS, U.SETTINGS = self.old
        U.forget()
        shutil.rmtree(self.d, ignore_errors=True)


def test_drawings_round_trip_survive_a_restart():
    with TempData() as d:
        assert U.get_drawings(KEY) == []                         # nothing saved yet: empty, not an error
        U.put_drawings(KEY, [LINE])
        U.put_drawings("spot:OTHERUSDT", [dict(LINE, id="b2")])
        U.forget()                                               # what a server restart sees: only the file
        assert U.get_drawings(KEY) == [LINE]
        assert U.get_drawings("spot:OTHERUSDT")[0]["id"] == "b2"
        U.put_drawings(KEY, [])                                  # the last drawing deleted: the market leaves the file
        U.forget()
        assert U.get_drawings(KEY) == [] and KEY not in json.loads((d / "drawings.json").read_text())
        assert sorted(p.name for p in d.iterdir()) == ["drawings.json"]   # no .tmp left behind


def test_bad_drawings_are_refused_and_change_nothing():
    with TempData():
        U.put_drawings(KEY, [LINE])
        for key, value in [("../../etc", [LINE]), ("", [LINE]), (KEY, {"not": "a list"}), (KEY, ["text"]),
                           (KEY, [LINE] * (U.MAX_DRAWINGS + 1))]:
            try:
                U.put_drawings(key, value)
            except ValueError:
                pass
            else:
                raise AssertionError(f"accepted {key!r}")
        U.forget()
        assert U.get_drawings(KEY) == [LINE]


def test_settings_round_trip():
    with TempData():
        assert U.get_settings() == {}
        s = {"appearance": {"bg": {"type": "solid", "color": "rgba(19,23,34,0.9)"}, "body": {"show": True}}}
        U.put_settings(s)
        U.forget()
        assert U.get_settings() == s
        try:
            U.put_settings(["no"])
        except ValueError:
            pass
        else:
            raise AssertionError("accepted a list as settings")


def test_damaged_file_is_set_aside_not_fatal():
    with TempData() as d:
        (d / "drawings.json").write_bytes(b"\x00" * 64)          # what a power cut leaves
        assert U.get_drawings(KEY) == []
        assert (d / "drawings.json.damaged").exists()
        U.put_drawings(KEY, [LINE])                              # and saving works again
        U.forget()
        assert U.get_drawings(KEY) == [LINE]


def test_http_routes():
    import http.server
    import server as S
    with TempData():
        srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), S.H)
        port = srv.server_address[1]
        old_port, S.PORT = S.PORT, port
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        base = f"http://127.0.0.1:{port}"

        def call(path, body=None, headers=None, raw=None):
            data = raw if raw is not None else (json.dumps(body).encode() if body is not None else None)
            h = {"Content-Type": "application/json", "Origin": base} if data is not None else {}
            h.update(headers or {})
            req = urllib.request.Request(base + path, data=data, headers=h, method="POST" if data is not None else "GET")
            try:
                with urllib.request.urlopen(req, timeout=5) as r:
                    return r.status, json.loads(r.read())
            except urllib.error.HTTPError as e:
                return e.code, json.loads(e.read() or b"{}")
        try:
            assert call(f"/drawings?m={KEY}", {"drawings": [LINE]}) == (200, {"ok": True})
            assert call(f"/drawings?m={KEY}") == (200, {"drawings": [LINE]})
            assert call("/settings", {"settings": {"appearance": {"x": 1}}})[0] == 200
            assert call("/settings") == (200, {"settings": {"appearance": {"x": 1}}})
            # another website open in the same browser must not be able to overwrite them
            assert call(f"/drawings?m={KEY}", {"drawings": []}, {"Origin": "https://evil.example"})[0] == 403
            assert call(f"/drawings?m={KEY}", raw=b'{"drawings": []}', headers={"Content-Type": "text/plain"})[0] == 415
            assert call(f"/drawings?m={KEY}", raw=b"not json")[0] == 400
            assert call("/drawings?m=bad%20key", {"drawings": [LINE]})[0] == 400
            assert call(f"/drawings?m={KEY}") == (200, {"drawings": [LINE]})   # none of that changed anything
            for bad in ["/static/../server.py", "/static/%2e%2e/server.py", "/static/nope.js", "/static/x.py"]:
                assert call(bad)[0] == 404, bad
            assert all(f in S.sources() for f in ("userdata.py", "index.html"))
        finally:
            S.PORT = old_port
            srv.shutdown()
            srv.server_close()


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_"):
            fn()
            print("ok", name)
