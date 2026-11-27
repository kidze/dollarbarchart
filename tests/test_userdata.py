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
        self.old = X.DATA, U.DRAWINGS, U.SETTINGS, U.SCRIPTS
        X.DATA, U.DRAWINGS, U.SETTINGS, U.SCRIPTS = self.d, self.d / "drawings.json", self.d / "settings.json", self.d / "indicators"
        U.forget()
        return self.d

    def __exit__(self, *exc):
        X.DATA, U.DRAWINGS, U.SETTINGS, U.SCRIPTS = self.old
        U.forget()
        shutil.rmtree(self.d, ignore_errors=True)


def test_drawings_round_trip_survive_a_restart():
    with TempData() as d:
        items, rev0 = U.get_drawings(KEY)
        assert items == []                                       # nothing saved yet: empty, not an error
        prev, rev1 = U.change_drawings(KEY, [LINE], [])
        assert prev == rev0 and rev1 != rev0
        U.change_drawings("spot:OTHERUSDT", [dict(LINE, id="b2")], [])
        U.forget()                                               # what a server restart sees: only the file
        assert U.get_drawings(KEY)[0] == [LINE]
        assert U.get_drawings("spot:OTHERUSDT")[0][0]["id"] == "b2"
        assert U.get_drawings(KEY)[1] != rev1                    # a new server never claims an old revision
        U.change_drawings(KEY, [], ["a1"])                       # the last drawing deleted: the market leaves the file
        U.forget()
        assert U.get_drawings(KEY)[0] == [] and KEY not in json.loads((d / "drawings.json").read_text())
        assert sorted(p.name for p in d.iterdir()) == ["drawings.json"]   # no .tmp left behind


def test_two_windows_never_wipe_each_other():
    """Each window sends only what it changed, so a window with an old copy cannot delete what another one drew."""
    with TempData():
        _, rev_a = U.get_drawings(KEY)                           # both windows open the market while it is empty
        _, rev_b = U.get_drawings(KEY)
        prev, rev_a = U.change_drawings(KEY, [LINE], [])         # window A draws a line
        assert prev == rev_b                                     # (B has not seen it)
        moved = dict(LINE, id="b2", points=[{"t": 1, "p": 2}, {"t": 3, "p": 4}])
        prev, rev_b = U.change_drawings(KEY, [moved], [])        # window B, still holding its empty copy, draws another
        assert prev == rev_a and prev != U.get_drawings(KEY)[1]  # B can tell someone else changed the list in between
        assert [x["id"] for x in U.get_drawings(KEY)[0]] == ["a1", "b2"]
        restyled = dict(LINE, style={"color": "rgba(1,2,3,1)", "width": 3})
        U.change_drawings(KEY, [restyled], [])                   # an edit replaces that drawing only, in place
        assert U.get_drawings(KEY)[0] == [restyled, moved]
        U.change_drawings(KEY, [], ["b2", "never-saved"])        # deleting an id nobody has is harmless
        assert U.get_drawings(KEY)[0] == [restyled]
        before = U.get_drawings(KEY)[1]
        assert U.change_drawings(KEY, [], []) == (before, before)   # an empty change is not a change


def test_bad_drawings_are_refused_and_change_nothing():
    with TempData():
        U.change_drawings(KEY, [LINE], [])
        many = [dict(LINE, id=f"x{i}") for i in range(U.MAX_DRAWINGS)]
        for key, up, dl in [("../../etc", [LINE], []), ("", [LINE], []), (KEY, {"not": "a list"}, []), (KEY, ["text"], []),
                            (KEY, [dict(LINE, id="../x")], []), (KEY, [{"no": "id"}], []), (KEY, [], "a1"), (KEY, [], [1]),
                            (KEY, many, [])]:
            try:
                U.change_drawings(key, up, dl)
            except ValueError:
                pass
            else:
                raise AssertionError(f"accepted {key!r} {str(up)[:40]} {dl!r}")
        U.forget()
        assert U.get_drawings(KEY)[0] == [LINE]


def test_settings_merge_by_key():
    with TempData():
        assert U.get_settings() == {}
        look = {"bg": {"type": "solid", "color": "rgba(19,23,34,0.9)"}, "body": {"show": True}}
        U.change_settings({"appearance": look})
        U.change_settings({"drawUi": {"lock": True}})            # another window saves another key: both kept
        U.forget()
        assert U.get_settings() == {"appearance": look, "drawUi": {"lock": True}}
        U.change_settings({"drawUi": None})                      # null removes a key
        assert U.get_settings() == {"appearance": look}
        try:
            U.change_settings(["no"])
        except ValueError:
            pass
        else:
            raise AssertionError("accepted a list as settings")


def test_damaged_file_is_set_aside_not_fatal():
    with TempData() as d:
        (d / "drawings.json").write_bytes(b"\x00" * 64)          # what a power cut leaves
        assert U.get_drawings(KEY)[0] == []
        assert (d / "drawings.json.damaged").exists()
        U.change_drawings(KEY, [LINE], [])                       # and saving works again
        U.forget()
        assert U.get_drawings(KEY)[0] == [LINE]


SRC = '//@version=5\nindicator("My MA", overlay = true)\nplot(ta.sma(close, 20))\n'


def test_scripts_kept_replaced_by_title_and_removed():
    with TempData() as d:
        assert U.list_scripts() == []
        a = U.add_script("My MA", r"C:\some\where\ma.pine", SRC)
        assert a["id"] == "my-ma" and a["file"] == "ma.pine" and (d / "indicators" / "my-ma.pine").read_text(encoding="utf-8") == SRC
        b = U.add_script("Other one", "o.txt", SRC.replace("My MA", "Other one"))
        newer = SRC.replace("20", "50")
        c = U.add_script("My MA", "ma2.pine", newer)             # the same title again: a new version, in its old place
        U.forget()                                               # (as after a restart)
        got = U.list_scripts()
        assert [x["id"] for x in got] == ["my-ma", "other-one"] and got[0]["source"] == newer and got[0]["file"] == "ma2.pine"
        assert got[0]["added"] == a["added"] and c["updated"] >= a["updated"] and b["id"] == "other-one"
        assert U.delete_script("my-ma") is True and U.delete_script("my-ma") is False
        assert [x["id"] for x in U.list_scripts()] == ["other-one"] and not (d / "indicators" / "my-ma.pine").exists()
        assert U.script_id("TD Sequential (Classic) by Kidze!") == "td-sequential-classic-by-kidze" and U.script_id("§§") == "indicator"
        for bad in [("", "x.pine", SRC), ("T", "x.pine", ""), ("T", "x.pine", "x" * (U.MAX_SCRIPT + 1)), ("T", 5, SRC), (None, "x", SRC)]:
            try:
                U.add_script(*bad)
            except ValueError:
                pass
            else:
                raise AssertionError(f"accepted {bad[:2]}")
        for bad in ["../x", "", 7]:
            try:
                U.delete_script(bad)
            except ValueError:
                pass
            else:
                raise AssertionError(f"accepted id {bad!r}")


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
            st, j = call(f"/drawings?m={KEY}")
            assert st == 200 and j["drawings"] == [] and j["rev"]
            st, j2 = call(f"/drawings?m={KEY}", {"upsert": [LINE]})
            assert st == 200 and j2["ok"] and j2["prev"] == j["rev"] and j2["rev"] != j["rev"]
            assert call(f"/drawings?m={KEY}") == (200, {"drawings": [LINE], "rev": j2["rev"]})
            assert call("/settings", {"settings": {"appearance": {"x": 1}}})[0] == 200
            assert call("/settings", {"settings": {"drawUi": {"y": 2}}})[0] == 200
            assert call("/settings") == (200, {"settings": {"appearance": {"x": 1}, "drawUi": {"y": 2}}})
            # another website open in the same browser must not be able to change them
            assert call(f"/drawings?m={KEY}", {"delete": ["a1"]}, {"Origin": "https://evil.example"})[0] == 403
            assert call(f"/drawings?m={KEY}", raw=b'{"delete": ["a1"]}', headers={"Content-Type": "text/plain"})[0] == 415
            assert call(f"/drawings?m={KEY}", raw=b"not json")[0] == 400
            assert call("/drawings?m=bad%20key", {"upsert": [LINE]})[0] == 400
            assert call(f"/drawings?m={KEY}") == (200, {"drawings": [LINE], "rev": j2["rev"]})   # none of that changed anything
            st, j = call("/scripts", {"add": {"name": "My MA", "file": "ma.pine", "source": SRC}})
            assert st == 200 and j["ok"] and j["script"]["id"] == "my-ma"
            st, j = call("/scripts")
            assert st == 200 and [(x["id"], x["source"]) for x in j["scripts"]] == [("my-ma", SRC)]
            assert call("/scripts", {"add": {"name": "x", "file": "x", "source": SRC}}, {"Origin": "https://evil.example"})[0] == 403
            assert call("/scripts", {"add": {"name": "", "source": SRC}})[0] == 400
            assert call("/scripts", {"nothing": 1})[0] == 400
            assert call("/scripts", {"delete": "my-ma"}) == (200, {"ok": True, "deleted": True})
            assert call("/scripts") == (200, {"scripts": []})
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
