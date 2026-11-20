"""A combined market's long download on fake exchanges: what is on screen keeps up while it runs. Run with
`python tests/test_combined_server.py` or `pytest`."""
import shutil
import sys
import tempfile
import threading
import time
import types
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import bybit_sync as X  # noqa: E402
import venues as V  # noqa: E402

M = V.MINUTE
CLOCK = [0.0]                                                    # the exchanges' "now" (seconds), moved by the test


class Fake(V.Venue):
    """A forward exchange holding minutes [first, CLOCK]; `delay` seconds per request makes it slow."""
    title = "Fake"
    window = 100
    pause = 0

    def __init__(self, name, first_ms, delay=0.0):
        self.name, self.first, self.delay, self.requests = name, first_ms, delay, 0

    def label(self, symbol, kind):
        return f"{self.name} {symbol}"

    def first_ms(self, symbol):
        return self.first

    def fetch(self, symbol, start_ms, end_ms, stop=None):
        self.requests += 1
        time.sleep(self.delay)
        cap = int(CLOCK[0] * 1000) // M * M
        return [[t, 100.0, 101.0, 99.0, 100.0, 10.0, 1000.0] for t in range(max(int(start_ms), self.first), min(int(end_ms), cap) + 1, M)]

    def latest(self, symbol, n=3):
        cap = int(CLOCK[0] * 1000) // M * M
        return [[t, 100.0, 101.0, 99.0, 100.0, 10.0, 1000.0] for t in range(cap - (n - 1) * M, cap + 1, M)]


def test_a_long_download_merges_partial_series_and_keeps_the_newest_minutes():
    import server as S
    d = Path(tempfile.mkdtemp(prefix="dbc-comb-"))
    saved = (X.DATA, V.DATA, V.time, V.FLUSH_REQUESTS, S.REBUILD_S, S.plan_all, S.price_check, dict(V.VENUES), S.STATE["index"])
    end = (int(time.time() * 1000) // M - 1) * M                 # the newest minute when the test starts
    CLOCK[0] = end / 1000 + 30
    fast, slow = Fake("fastx", end - 199 * M), Fake("slowx", end - 2999 * M, delay=0.2)
    X.DATA = V.DATA = d
    V.time = types.SimpleNamespace(time=lambda: CLOCK[0], sleep=time.sleep)
    V.FLUSH_REQUESTS = 3                                         # the slow one (6 s) writes every 3 requests
    S.REBUILD_S = 0.3
    V.VENUES.update(fastx=fast, slowx=slow)
    S.STATE["index"] = S.STATE["index"] or []

    def plan(ticker):
        out = [{"venue": v.name, "symbol": "T", "kind": "spot", "list_ms": 0} for v in (fast, slow)]
        for s in out:
            s.update(label=V.VENUES[s["venue"]].label("T", "spot"), exact=True, status="queued", pct=None, n=0, first=None, note="")
        return out, []
    S.plan_all, S.price_check = plan, (lambda m, series=None: None)
    key = "all:TESTCOMB"
    m = S.STATE["markets"][key] = S.Market(key)
    seen = []                                                    # (rows merged, newest minute) at each rebuild while it ran
    try:
        th = threading.Thread(target=S.sync_all, args=(m, ("market", key)), daemon=True)
        th.start()
        t0, moved = time.time(), False
        while th.is_alive() and time.time() - t0 < 30:
            m.last_req = time.time()                             # on screen
            if m.cd is not None and m.cd.n and (not seen or seen[-1] != (m.cd.n, int(m.cd.ts[m.cd.n - 1]))):
                seen.append((m.cd.n, int(m.cd.ts[m.cd.n - 1])))
            if not moved and seen:                               # the exchanges move on 5 minutes after the first merge
                CLOCK[0] += 5 * 60
                moved = True
            time.sleep(0.02)
        th.join(5)
        assert not th.is_alive() and m.sync == "live", m.sync
        assert any(200 < n < 3000 for n, last in seen), seen    # the slow one was merged in part while still downloading
        assert any(last == end + 5 * M and n < 3000 + 5 for n, last in seen), seen   # ... and the fast one's newest minutes kept up
        assert m.cd.n == 3005 and int(m.cd.ts[m.cd.n - 1]) == end + 5 * M, (m.cd.n, int(m.cd.ts[m.cd.n - 1]) - end)
        import json, combined as C
        side = json.loads(S.cache_paths("TESTCOMB")[1].read_text(encoding="utf-8"))   # the merge cache never holds the
        assert side["last"] <= int(m.cd.ts[m.cd.n - 1]) - C.LONE_SPAN * M   # newest minutes the lone rule has not checked
        assert side["written"] == int(time.time() * 1000) // C.DAY * C.DAY   # the weekly refresh counts from this day
    finally:
        X.DATA, V.DATA, V.time, V.FLUSH_REQUESTS, S.REBUILD_S, S.plan_all, S.price_check, venues, S.STATE["index"] = saved
        V.VENUES.clear()
        V.VENUES.update(venues)
        S.STATE["markets"].pop(key, None)
        shutil.rmtree(d, ignore_errors=True)


def test_a_window_served_an_older_page_is_told_to_reload():
    import server as S
    tag, _ = S.page_tag()
    old = S.QUIET_S
    try:
        S.QUIET_S = 0
        S.STATE["build"] = S.build_id()                          # nothing else pending
        h = types.SimpleNamespace(meta=S.H.meta)
        m = S.Market("linear:TESTSTALE")
        assert S.H.meta(h, m, {"pb": ["1-2"]})["update"] == {"kind": "reload", "files": ["the page"], "stale": True}
        assert S.H.meta(h, m, {"pb": [tag]})["update"] is None
        pending = dict(S.STATE["build"], **{"server.py": [0, 0]})   # a server change still pending: the restart offer wins
        S.STATE["build"], kept = pending, S.STATE["build"]
        assert S.H.meta(h, m, {"pb": ["1-2"]})["update"] is None
        S.STATE["build"] = kept
        assert not S.page_stale(tag)
        assert S.page_stale("1-2") and S.page_stale(None)        # an older page, and a page from before pages said
        S.QUIET_S = 10 ** 9
        assert not S.page_stale("1-2")                           # files still changing: not yet
    finally:
        S.QUIET_S = old



def test_the_server_stays_while_a_chart_window_is_open_however_quiet():
    """A hidden or sleeping window stops asking, but it is still open: no exit while one is on the screen."""
    import server as S
    saved = (S.window_open, S.STATE["last_req"], S.STATE["restarting"])
    try:
        now = time.time()
        S.STATE["restarting"] = False
        S.STATE["last_req"] = now - 30
        S.window_open = lambda: False
        assert not S.should_exit(now)                            # asked 30 s ago
        S.STATE["last_req"] = now - 3600
        assert S.should_exit(now)                                # an hour quiet, no window: closed
        S.window_open = lambda: True
        assert not S.should_exit(now)                            # an hour quiet, window open (asleep): stays
        S.window_open = lambda: False
        S.STATE["restarting"] = True
        assert not S.should_exit(now)                            # a restart hands over itself
        S.window_open = saved[0]
        assert S.window_open() in (True, False)                  # the real check answers (False off Windows)
    finally:
        S.window_open, S.STATE["last_req"], S.STATE["restarting"] = saved

def test_a_market_merged_before_shows_from_disk_before_any_exchange_is_asked():
    import server as S
    d = Path(tempfile.mkdtemp(prefix="dbc-comb-"))
    saved = (X.DATA, V.DATA, V.time, S.plan_all, S.price_check, dict(V.VENUES), S.STATE["index"], S.rebuild_all)
    end = (int(time.time() * 1000) // M - 1) * M
    CLOCK[0] = end / 1000 + 30
    a, b = Fake("ax", end - 499 * M), Fake("bx", end - 299 * M)
    X.DATA = V.DATA = d
    V.time = types.SimpleNamespace(time=lambda: CLOCK[0], sleep=time.sleep)
    V.VENUES.update(ax=a, bx=b)
    S.STATE["index"] = S.STATE["index"] or []
    asked = []                                                       # which market lists a plan read: fresh ones (a request) or the ones on disk

    def plan(ticker, lists_max_age_s=None):
        asked.append(lists_max_age_s)
        out = [{"venue": v.name, "symbol": "T", "kind": "spot", "list_ms": 0} for v in (a, b)]
        for s in out:
            s.update(label=V.VENUES[s["venue"]].label("T", "spot"), exact=True, status="queued", pct=None, n=0, first=None, note="")
        return out, []
    gate, checked = threading.Event(), []

    def price_check(m, series=None):                                 # the first question to the exchanges: held up, as on a bad network
        checked.append(([s["label"] for s in series or []], m.cd is not None and m.cd.n, m.sync))
        gate.wait(10)
    merges = []

    def rebuild(m):
        merges.append(dict(m.progress or {}))
        saved[-1](m)
    S.plan_all, S.price_check, S.rebuild_all = plan, price_check, rebuild
    key = "all:TESTDISK"
    try:
        m = S.STATE["markets"][key] = S.Market(key)
        gate.set()
        S.sync_all(m, ("market", key))                               # first launch: nothing on disk, everything downloaded and merged
        assert m.sync == "live" and m.cd.n == 500 and asked == [None], (m.sync, asked)
        assert checked[0][1:] == (False, "loading")                  # (nothing to show before the exchanges answered)
        assert merges[-1].get("merging") and not any(p.get("merging") for p in merges[:-1]), merges   # only the last merge says "merging"
        first_gen = m.gen
        assert first_gen and S.meta_of(m)["gen"] == first_gen

        CLOCK[0] += 20 * 60                                          # the app is closed, 20 minutes pass, it is opened again
        m = S.STATE["markets"][key] = S.Market(key)
        gate.clear(); del asked[:], checked[:], merges[:]
        th = threading.Thread(target=S.sync_all, args=(m, ("market", key)), daemon=True)
        th.start()
        t0 = time.time()
        while not checked and time.time() - t0 < 10:
            m.last_req = time.time()
            time.sleep(0.01)
        assert checked, "the price check was never reached"
        labels, shown, sync = checked[0]
        assert shown == 500 and sync == "loading", (shown, sync)     # the chart was built from the files before any exchange was asked
        assert asked[0] == float("inf") and asked[1] is None, asked  # ... from the market lists on disk; fresh ones only after it
        assert sorted(labels) == ["ax T", "bx T"]                    # and the series it showed are price-checked like new ones
        assert m.gen > first_gen and not any("unchecked" in s for s in m.venues)
        shown_gen = m.gen
        gate.set()
        th.join(20)
        assert not th.is_alive() and m.sync == "live" and m.cd.n == 520, (m.sync, m.cd.n)
        assert m.gen > shown_gen                                     # the merge after catching up is another build: a page takes the whole set again
        assert merges[-1].get("merging") and merges[-1].get("pct") == 100.0
    finally:
        gate.set()
        X.DATA, V.DATA, V.time, S.plan_all, S.price_check, venues, S.STATE["index"], S.rebuild_all = saved
        V.VENUES.clear()
        V.VENUES.update(venues)
        S.STATE["markets"].pop(key, None)
        shutil.rmtree(d, ignore_errors=True)


def test_background_downloads_wait_for_the_pages_market_at_start_up():
    import server as S
    saved = {k: S.STATE[k] for k in ("markets", "started", "watchlist", "watch_done", "index", "index_stale", "bg_retry_at", "index_retry_at")}
    scan = S.scan_pending
    try:
        S.scan_pending = lambda: []
        S.STATE.update(markets={}, started=time.time(), watchlist=["AAA"], watch_done=set(), index=[{"ticker": "AAA"}],
                       index_stale=False, bg_retry_at=0.0, index_retry_at=0.0)
        assert S.next_job() is None                                  # just started, the page has not asked yet: the worker stays free for it
        S.STATE["index_stale"] = True
        assert S.next_job() == ("index", None)                       # (a first launch still fetches the market list at once)
        S.STATE["index_stale"] = False
        m = S.Market("all:BBB")
        S.STATE["markets"]["all:BBB"] = m
        assert S.next_job() == ("market", "all:BBB")                 # the page's market goes first ...
        m.sync = "live"
        assert S.next_job() == ("watch", "AAA")                      # ... and once it is served the watchlist follows, grace or not
        S.STATE["markets"] = {}
        S.STATE["started"] = time.time() - S.START_GRACE_S - 1
        assert S.next_job() == ("watch", "AAA")                      # nobody asked for anything: after the grace the watchlist starts anyway
    finally:
        S.STATE.update(saved)
        S.scan_pending = scan


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_"):
            fn()
            print("ok", name)
