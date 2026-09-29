"""Combined-market tests on fake venues (no network). Run with `python tests/test_venues.py` or `pytest`."""
import pathlib
import sys
import tempfile
import types
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import combined as C  # noqa: E402
import venues as V  # noqa: E402

M = V.MINUTE
T0 = 1_700_000_000_000 // M * M
CLOCK = [0.0]
V.time = types.SimpleNamespace(time=lambda: CLOCK[0], sleep=lambda s: None)   # the sync's "now" and pauses under test control


def set_now(ms):
    CLOCK[0] = ms / 1000 + 30                                        # 30 s into the newest minute


def series(start_ms, n, dollars=1e6, px=100.0, seed=0):
    """n minutes of candles from start_ms."""
    rng = np.random.default_rng(seed)
    ts = start_ms + np.arange(n) * M
    close = px * np.exp(np.cumsum(rng.normal(0, 0.001, n)))
    return pd.DataFrame({"ts": ts, "open": close, "high": close * 1.001, "low": close * 0.999, "close": close,
                         "volume": dollars / close, "turnover": np.full(n, dollars)})


def rows_of(df):
    return df[V.COLS].to_numpy().tolist()


def scratch():
    d = pathlib.Path(tempfile.mkdtemp(prefix="dbc-venues-"))
    V.DATA = d
    return d


class Fake(V.Venue):
    """A forward venue holding one in-memory series; counts requests; can be told to stop after some."""
    name = "fake"
    title = "Fake"
    window = 100
    pause = 0

    def __init__(self, df, now_ms):
        self.df = df
        self.now = now_ms
        self.requests = 0
        set_now(now_ms)

    def first_ms(self, symbol):
        return int(self.df["ts"].iloc[0]) if len(self.df) else None

    def fetch(self, symbol, start_ms, end_ms, stop=None):
        self.requests += 1
        sub = self.df[(self.df["ts"] >= start_ms) & (self.df["ts"] <= end_ms) & (self.df["ts"] <= self.now)]
        return rows_of(sub)

    def latest(self, symbol, n=3):
        return rows_of(self.df[self.df["ts"] <= self.now].tail(n))


class FakeReverse(Fake):
    """An OKX-like venue: only "rows older than ts", newest page first."""
    name = "fakerev"
    title = "FakeRev"
    reverse = True
    limit = 100

    def fetch_before(self, symbol, ts_ms, stop=None):
        self.requests += 1
        sub = self.df[(self.df["ts"] < ts_ms) & (self.df["ts"] <= self.now)].tail(self.limit)
        return rows_of(sub)


def test_merge_sums_dollars_and_keeps_priority_prices():
    a = series(T0, 1000, dollars=1e6, px=100, seed=1)
    b = series(T0 - 500 * M, 1200, dollars=2e5, px=101, seed=2)      # starts earlier, ends earlier
    b = b[b["ts"] % (3 * M) != 0]                                    # and misses every third minute
    out = C.merge([a, b])
    assert out["ts"].is_monotonic_increasing and out["ts"].is_unique
    assert set(out["ts"]) == set(a["ts"]) | set(b["ts"])
    both = out[out["ts"].isin(a["ts"]) & out["ts"].isin(b["ts"])]
    assert np.allclose(both["turnover"], 1.2e6)                      # summed
    only_a = out[out["ts"].isin(a["ts"]) & ~out["ts"].isin(b["ts"])]
    assert np.allclose(only_a["turnover"], 1e6)
    only_b = out[~out["ts"].isin(a["ts"])]
    assert np.allclose(only_b["turnover"], 2e5)
    pa = a.set_index("ts")["close"]
    assert np.allclose(both["close"].to_numpy(), pa.loc[both["ts"]].to_numpy())      # a's prices win where both trade
    pb = b.set_index("ts")["close"]
    assert np.allclose(only_b["close"].to_numpy(), pb.loc[only_b["ts"]].to_numpy())
    assert np.allclose(C.merge([b, a])["turnover"].sum(), out["turnover"].sum())      # order changes prices, not dollars
    assert len(C.merge([])) == 0 and len(C.merge([a.iloc[:0]])) == 0


def test_merge_rows_sums_per_minute():
    r = C.merge_rows([[[T0, 1, 2, 0.5, 1.5, 10, 100], [T0 + M, 1, 2, 0.5, 1.5, 10, 100]],
                      [[T0 + M, 9, 9, 9, 9, 1, 5], [T0 + 2 * M, 9, 9, 9, 9, 1, 5]], []])
    assert [x[0] for x in r] == [T0, T0 + M, T0 + 2 * M]
    assert r[1][6] == 105 and r[1][1] == 1 and r[2][6] == 5 and r[2][1] == 9


def test_forward_sync_pages_flushes_resumes_and_catches_up():
    scratch()
    full = series(T0, 1244, seed=3)                                  # the venue holds 1244 minutes; "now" is minute 1233 at first
    df = full.iloc[:1234]
    now = int(df["ts"].iloc[-1])
    v = Fake(full, now)
    seen, marks, cps = [], [], []
    stop_after = {"n": 5}
    res = V.sync(v, "X", on_rows=seen.extend, progress=lambda p, at: marks.append((p, at)),
                 stop=lambda: v.requests >= stop_after["n"], checkpoint=lambda: cps.append(1))
    assert res["result"] == "stopped" and res["n"] == 500 and res["prev_last"] is None
    on_disk = V.load("fake", "X")
    assert len(on_disk) == 500 and V.load_side("fake", "X")["history_done"] and V.load_side("fake", "X")["first"] == T0
    assert 0 < marks[-1][0] < 100
    stop_after["n"] = 10 ** 9
    res = V.sync(v, "X", on_rows=seen.extend)
    assert res["result"] == "done" and res["n"] == 1234 and res["prev_last"] == T0 + 499 * M
    assert res["first"] == T0 and res["last"] == now
    assert V.load("fake", "X")["ts"].tolist() == df["ts"].tolist()
    assert len(seen) == 1234 + 1                                     # the resume refetched its last (possibly forming) minute
    # later: the venue has 10 more minutes; one request catches up and re-reads the last minute
    v.now = now + 10 * M; set_now(v.now)
    n0 = v.requests
    res = V.sync(v, "X", on_rows=seen.extend)
    assert res["result"] == "done" and res["last"] == now + 10 * M and v.requests - n0 == 1
    assert V.load("fake", "X")["ts"].tolist() == full["ts"].tolist() and len(seen) == 1235 + 11


def test_forward_sync_skips_empty_windows_and_rejects_unknown_symbols():
    scratch()
    df = series(T0, 300, seed=4)
    df = pd.concat([df.iloc[:100], df.iloc[250:]])                   # a 150-minute hole
    v = Fake(df, int(df["ts"].iloc[-1]))
    res = V.sync(v, "X")
    assert res["result"] == "done" and res["n"] == 150 and v.requests == 3
    empty = Fake(df.iloc[:0], T0)
    try:
        V.sync(empty, "NOPE")
        assert False, "expected LookupError"
    except LookupError:
        pass
    assert not V.path("fake", "NOPE").exists()


def test_reverse_sync_walks_tail_then_history_and_resumes():
    scratch()
    full = series(T0, 1057, seed=5)
    df = full.iloc[:1050]
    now = int(df["ts"].iloc[-1])
    v = FakeReverse(full, now)
    # first pass: stopped after 4 pages (400 newest minutes)
    res = V.sync(v, "R", stop=lambda: v.requests >= 4, list_ms=T0)
    assert res["result"] == "stopped" and res["n"] == 400 and res["last"] == now
    assert not V.load_side("fakerev", "R").get("history_done")
    # second pass: the tail is already there (one page confirms it), then the history walks back to the listing
    marks = []
    res = V.sync(v, "R", progress=lambda p, at: marks.append(p), list_ms=T0)
    assert res["result"] == "done" and res["n"] == 1050 and res["first"] == T0
    assert V.load_side("fakerev", "R")["history_done"]
    assert marks[-1] == 100.0
    assert V.load("fakerev", "R")["ts"].tolist() == df["ts"].tolist()
    # later: 7 new minutes appear; the tail walk fetches them and stops at the newest stored candle
    v.now = now + 7 * M; set_now(v.now)
    n0 = v.requests
    seen = []
    res = V.sync(v, "R", on_rows=seen.extend, list_ms=T0)
    assert res["result"] == "done" and res["last"] == now + 7 * M and v.requests - n0 == 1
    assert len(seen) == 7 and V.load("fakerev", "R")["ts"].tolist() == full["ts"].tolist()


def test_reverse_sync_fresh_series_completes_in_one_walk():
    scratch()
    df = series(T0, 250, seed=6)
    v = FakeReverse(df, int(df["ts"].iloc[-1]))
    res = V.sync(v, "R2")
    assert res["result"] == "done" and res["n"] == 250 and V.load_side("fakerev", "R2")["history_done"]
    assert v.requests == 4                                           # 3 pages + the empty one that proves the listing


def test_markets_for_prefers_each_venues_quote_and_honours_aliases():
    inst = {"okx": [{"symbol": "BTC-USDT", "base": "BTC", "quote": "USDT", "kind": "spot", "list_ms": 1},
                    {"symbol": "BTC-USDC", "base": "BTC", "quote": "USDC", "kind": "spot", "list_ms": 2},
                    {"symbol": "BTC-USDT-SWAP", "base": "BTC", "quote": "USDT", "kind": "perp", "list_ms": 3},
                    {"symbol": "PUMP-USDT", "base": "PUMP", "quote": "USDT", "kind": "spot", "list_ms": 4}],
            "coinbase": [{"symbol": "BTC-USDT", "base": "BTC", "quote": "USDT", "kind": "spot", "list_ms": 0},
                         {"symbol": "BTC-USD", "base": "BTC", "quote": "USD", "kind": "spot", "list_ms": 0}],
            "kucoin": [{"symbol": "PUMPFUN-USDT", "base": "PUMPFUN", "quote": "USDT", "kind": "spot", "list_ms": 0}],
            "bitfinex": [{"symbol": "tBTCUSD", "base": "BTC", "quote": "USD", "kind": "spot", "list_ms": 0},
                         {"symbol": "tBTCUST", "base": "BTC", "quote": "USDT", "kind": "spot", "list_ms": 0}]}
    got = V.markets_for("btc", inst)
    assert [(g["venue"], g["symbol"]) for g in got] == [("bitfinex", "tBTCUSD"), ("coinbase", "BTC-USD"), ("okx", "BTC-USDT"), ("okx", "BTC-USDT-SWAP")]
    got = V.markets_for("PUMP", inst, {"PUMPFUN": "PUMP"})
    assert [(g["venue"], g["symbol"]) for g in got] == [("kucoin", "PUMPFUN-USDT"), ("okx", "PUMP-USDT")]
    assert V.markets_for("ZZZ", inst) == []


def test_paths_are_filesystem_safe():
    scratch()
    assert V.path("okx", "BTC-USDT-SWAP").name == "okx_BTC_USDT_SWAP.parquet"
    assert V.path("bitfinex", "tBTC:USD").name == "bitfinex_tBTC_USD.parquet"
    assert V.side_path("kucoin", "BTC-USDT").name == "kucoin_BTC_USDT.json"
    assert V.path("bybit", "linear:BTCUSDT").name == "bybit_linear_BTCUSDT.parquet"


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_"):
            fn()
            print("ok", name)
