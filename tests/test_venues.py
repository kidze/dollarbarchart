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


def test_merge_sums_dollars_and_takes_the_dollar_weighted_median_price():
    """Each venue's say in a minute's price = its dollars over the day before (b has 500 minutes more history, so
    it leads until a's day outweighs it, about 80 minutes in)."""
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
    later = both[both["ts"] >= T0 + 200 * M]
    assert np.allclose(later["close"].to_numpy(), pa.loc[later["ts"]].to_numpy())    # a carries most of the dollars
    pb = b.set_index("ts")["close"]
    assert np.allclose(only_b["close"].to_numpy(), pb.loc[only_b["ts"]].to_numpy())
    swapped = C.merge([b, a])                                        # order only matters for minutes nobody traded
    assert np.allclose(swapped["turnover"], out["turnover"]) and np.allclose(swapped["close"], out["close"])
    assert len(C.merge([])) == 0 and len(C.merge([a.iloc[:0]])) == 0
    assert (out["high"] >= out[["open", "close"]].max(axis=1)).all() and (out["low"] <= out[["open", "close"]].min(axis=1)).all()


def test_one_venues_bad_print_does_not_move_the_price():
    """Three venues at ~100 carrying 70% of the dollars, one at 50 (a flash wick on a thin book) carrying 30%."""
    base = [series(T0, 50, dollars=d, px=100, seed=s) for d, s in ((3e5, 1), (2e5, 2), (2e5, 3))]
    bad = series(T0, 50, dollars=3e5, px=50, seed=4)
    out = C.merge(base + [bad])
    assert (out["close"] > 95).all() and (out["low"] > 95).all()
    heavy = series(T0, 50, dollars=9e6, px=50, seed=5)               # but a venue with most of the money sets the price
    assert (C.merge(base + [heavy])["close"].iloc[1:] < 55).all()   # (from its second minute: the first has no day behind it)
    w = C.weighted_median(np.array([[1.0, 2.0, 3.0], [np.nan, 5.0, 7.0], [4.0, np.nan, np.nan]]),
                          np.array([[1.0, 1.0, 5.0], [0.0, 1.0, 1.0], [0.0, 0.0, 0.0]]))
    assert w.tolist() == [3.0, 5.0, 4.0]                             # heavy wins; lower median on a tie; unweighted falls back


def test_a_dead_markets_big_off_price_trade_has_no_say():
    """Bitfinex ZEC, 2025-09-29 08:44: 3,500 ZEC sold at $46 (about $164k, more than every other exchange that
    minute) while Binance and Bybit traded at $67. Its say is its dollars over the day before: next to nothing."""
    live = series(T0, 3000, dollars=1e5, px=67, seed=21)
    dead = series(T0, 3000, dollars=0.0, px=67, seed=22)             # candles without trades: no say at all
    dead.loc[dead.index[::400], "turnover"] = 50.0                   # a few tiny trades a day
    t = T0 + 2000 * M
    dead.loc[dead["ts"] == t, ["open", "high", "low", "close", "turnover"]] = [46.0, 46.8, 45.8, 46.8, 1.64e5]
    dead.loc[dead["ts"] == t + 7 * M, ["open", "high", "low", "close", "turnover"]] = [20.0, 20.0, 20.0, 20.0, 0.0]
    out = C.merge([dead, live]).set_index("ts")                      # (dead first: priority does not save it either)
    assert np.allclose(out["low"].to_numpy(), live["low"].to_numpy()) and np.allclose(out["high"].to_numpy(), live["high"].to_numpy())
    assert out.loc[t, "turnover"] == 1.64e5 + 1e5                    # its dollars still count
    w = C.trailing_dollars(np.array([0, M, 2 * M, V.DAY + M]), np.array([5.0, 7.0, 11.0, 13.0]))
    assert w.tolist() == [0.0, 5.0, 12.0, 18.0]                      # the day before, not the minute itself


def test_merge_since_matches_the_full_merge_tail():
    a, b = series(T0, 3000, dollars=1e6, seed=7), series(T0 + 100 * M, 2500, dollars=7e5, px=100.5, seed=8)
    full = C.merge([a, b])
    cut = T0 + 1777 * M
    tail = C.merge([a, b], since=cut)
    assert tail["ts"].iloc[0] == cut
    pd.testing.assert_frame_equal(tail.reset_index(drop=True), full[full["ts"] >= cut].reset_index(drop=True))


def test_merge_rows_sums_per_minute():
    r = C.merge_rows([[[T0, 1, 2, 0.5, 1.5, 10, 100], [T0 + M, 1, 2, 0.5, 1.5, 10, 100]],
                      [[T0 + M, 9, 9, 9, 9, 1, 5], [T0 + 2 * M, 9, 9, 9, 9, 1, 5]], []])
    assert [x[0] for x in r] == [T0, T0 + M, T0 + 2 * M]
    assert r[1][6] == 105 and r[1][1] == 1 and r[2][6] == 5 and r[2][1] == 9


def test_trust_drops_a_relisted_past_and_another_coins_history():
    ref = series(T0, 60 * 1440, px=100, seed=9)
    same = ref.copy()
    same[["open", "high", "low", "close"]] *= 1.01                   # the same coin, a cent dearer
    assert len(C.trust(same, C.daily_close(ref))) == len(same)
    other = same.copy()
    early = other["ts"] < T0 + 20 * V.DAY
    other.loc[early, ["open", "high", "low", "close"]] *= 3          # the first 20 days were another coin at 3x the price
    kept = C.trust(other, C.daily_close(ref))
    assert kept["ts"].iloc[0] >= T0 + 20 * V.DAY - V.DAY and kept["ts"].iloc[0] <= T0 + 21 * V.DAY
    wild = same.copy()
    wild.loc[wild["ts"].between(T0 + 30 * V.DAY, T0 + 31 * V.DAY - 1), ["open", "high", "low", "close"]] *= 2   # one wild day: kept
    assert len(C.trust(wild, C.daily_close(ref))) == len(same)
    renamed = same.copy()                                            # no gap: the symbol went to another coin at 6x on day 40
    renamed.loc[renamed["ts"] >= T0 + 40 * V.DAY, ["open", "high", "low", "close"]] *= 6
    short_ref = C.daily_close(renamed)[C.daily_close(renamed).index >= T0 + 45 * V.DAY]   # the reference (the new coin) starts after the switch
    kept = C.trust(renamed, short_ref)
    assert T0 + 40 * V.DAY < kept["ts"].iloc[0] <= T0 + 42 * V.DAY          # from the first whole day after the switch
    real = ref.copy()                                                # a real 6x day that the reference made too is kept
    real.loc[real["ts"] >= T0 + 40 * V.DAY, ["open", "high", "low", "close"]] *= 6
    assert len(C.trust(renamed, C.daily_close(real))) == len(renamed)
    assert len(C.trust(renamed, None, jumps=False)) == len(renamed)
    relisted = pd.concat([same.iloc[:5 * 1440], same.iloc[25 * 1440:]])   # a 20-day hole: delisted, listed again
    relisted.iloc[:5 * 1440, 1:5] *= 3                               # ... and before it, the symbol was another coin at 3x
    assert C.trust(relisted, None)["ts"].iloc[0] == T0 + 25 * 1440 * M
    assert C.trust(relisted, C.daily_close(ref))["ts"].iloc[0] == T0 + 25 * 1440 * M


def test_trust_keeps_history_across_an_exchanges_data_hole():
    ref = series(T0, 120 * 1440, px=100, seed=16)
    holed = pd.concat([ref.iloc[:30 * 1440], ref.iloc[91 * 1440:]])    # 61 days of no data (Bitfinex BTC, 2016-04..05)
    assert len(C.trust(holed, None)) == len(holed)                  # the price carried on across it
    assert len(C.trust(holed, C.daily_close(ref))) == len(holed)
    up = ref.copy()                                                  # the coin rose 3x during the hole, the reference too
    up.loc[up["ts"] >= T0 + 60 * V.DAY, ["open", "high", "low", "close"]] *= 3
    holed = pd.concat([up.iloc[:30 * 1440], up.iloc[91 * 1440:]])
    assert len(C.trust(holed, C.daily_close(up))) == len(holed)     # the reference made the move: same coin
    assert C.trust(holed, None)["ts"].iloc[0] == T0 + 91 * V.DAY    # no reference: a 3x move across a hole is not trusted
    down = pd.concat([ref.iloc[:30 * 1440], ref.iloc[91 * 1440:]])  # another coin at 4x+ before the hole: cut at the hole, not a day later
    down.iloc[:30 * 1440, 1:5] *= 5
    assert C.trust(down, None)["ts"].iloc[0] == T0 + 91 * V.DAY
    near = pd.concat([ref.iloc[:30 * 1440], ref.iloc[91 * 1440:]])  # another coin before the hole, priced within 2x
    near.iloc[:30 * 1440, 1:5] *= 1.5
    assert C.trust(near, C.daily_close(ref))["ts"].iloc[0] == T0 + 91 * V.DAY


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


def test_reverse_tail_walk_stopped_halfway_leaves_no_hole():
    scratch()
    full = series(T0, 2000, seed=11)
    v = FakeReverse(full, int(full["ts"].iloc[999]))
    V.sync(v, "H")                                                   # minutes 0..999 on disk, history done
    v.now = int(full["ts"].iloc[-1]); set_now(v.now)
    n0 = v.requests
    res = V.sync(v, "H", stop=lambda: v.requests - n0 >= 4)          # the tail walk (1000 new minutes) stops after 4 pages
    assert res["result"] == "stopped" and res["last"] == int(full["ts"].iloc[999])   # nothing half-walked was kept
    res = V.sync(v, "H")
    assert res["result"] == "done" and V.load("fakerev", "H")["ts"].tolist() == full["ts"].tolist()


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


def test_binance_archive_rows_header_and_microseconds():
    import io, zipfile
    lines = ["open_time,open,high,low,close,volume,close_time,quote_volume,count,tb,tq,ignore",
             f"{T0 * 1000},1,2,0.5,1.5,10,{T0 * 1000 + 59_999_999},15,3,1,1,0",
             f"{(T0 + M) * 1000},1.5,2,1,1.2,4,{(T0 + M) * 1000 + 59_999_999},5,3,1,1,0"]
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr("X-1m-2025-01.csv", "\n".join(lines) + "\n")
    a = V.Binance._parse_zip(buf.getvalue())
    assert a[:, 0].tolist() == [T0, T0 + M] and a[0].tolist()[1:] == [1, 2, 0.5, 1.5, 10, 15]
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr("X-1m-2020-01.csv", f"{T0},1,2,0.5,1.5,10,{T0 + 59_999},15,3,1,1,0\n")   # older files: ms, no header
    assert V.Binance._parse_zip(buf.getvalue())[:, 0].tolist() == [T0]
    assert V.Binance.split("perp:ZECUSDT") == ("perp", "ZECUSDT")
    assert V.path("binance", "spot:ZECUSDT").name == "binance_spot_ZECUSDT.parquet"


def test_paths_are_filesystem_safe():
    scratch()
    assert V.path("okx", "BTC-USDT-SWAP").name == "okx_BTC_USDT_SWAP.parquet"
    assert V.path("bitfinex", "tBTC:USD").name == "bitfinex_tBTC_USD.parquet"
    assert V.side_path("kucoin", "BTC-USDT").name == "kucoin_BTC_USDT.json"
    assert V.path("bybit", "linear:BTCUSDT").name == "bybit_linear_BTCUSDT.parquet"


def test_trust_judges_a_jump_across_a_hole_over_the_same_days():
    days = 90
    ref = series(T0, days * 1440, px=100, seed=12)
    rise = np.exp(np.log(1.2) * np.clip((ref["ts"].to_numpy() - (T0 + 40 * V.DAY)) / V.DAY, 0, 10))   # 1.2x a day for 10 days
    for c in ("open", "high", "low", "close"):
        ref[c] = ref[c] * rise
    holed = ref[(ref["ts"] < T0 + 40 * V.DAY) | (ref["ts"] >= T0 + 50 * V.DAY)].copy()   # 10 days without candles: 6x across them
    assert len(C.trust(holed, C.daily_close(ref))) == len(holed)    # the reference made the same move over those days
    assert C.trust(holed, None)["ts"].iloc[0] >= T0 + 50 * V.DAY    # no reference: the jump is not explained


def test_trust_cuts_at_a_run_of_mismatched_days_not_at_scattered_ones():
    ref = series(T0, 400 * 1440, px=100, seed=13)
    scattered = ref.copy()
    for d in (20, 100, 200, 380):                                    # wild two-day spells months apart: a thin venue's bad prints
        on = scattered["ts"].between(T0 + d * V.DAY, T0 + (d + 2) * V.DAY - 1)
        scattered.loc[on, ["open", "high", "low", "close"]] *= 1.6
    assert len(C.trust(scattered, C.daily_close(ref))) == len(scattered)
    run = ref.copy()                                                 # days 100..109 another coin at 1.6x, scattered ones later
    run.loc[run["ts"].between(T0 + 100 * V.DAY, T0 + 110 * V.DAY - 1), ["open", "high", "low", "close"]] *= 1.6
    on = run["ts"].between(T0 + 300 * V.DAY, T0 + 301 * V.DAY - 1)
    run.loc[on, ["open", "high", "low", "close"]] *= 1.6
    assert T0 + 109 * V.DAY < C.trust(run, C.daily_close(ref))["ts"].iloc[0] <= T0 + 111 * V.DAY   # (T0 is not a UTC midnight)


class Flaky(Fake):
    """A forward venue whose requests fail from the n-th on (a network drop); raise_on_stop = fails as a stop lands."""

    def __init__(self, df, now_ms, fail_at):
        super().__init__(df, now_ms)
        self.fail_at = fail_at

    def fetch(self, symbol, start_ms, end_ms, stop=None):
        if self.requests >= self.fail_at:
            self.requests += 1
            raise OSError("connection reset")
        return super().fetch(symbol, start_ms, end_ms, stop)


class FlakyReverse(FakeReverse):
    def __init__(self, df, now_ms, fail_at):
        super().__init__(df, now_ms)
        self.fail_at = fail_at

    def fetch_before(self, symbol, ts_ms, stop=None):
        if self.requests >= self.fail_at:
            self.requests += 1
            raise OSError("connection reset")
        return super().fetch_before(symbol, ts_ms, stop)


def test_a_failure_part_way_keeps_what_arrived_and_a_stop_is_a_pause():
    scratch()
    full = series(T0, 1500, seed=14)
    v = Flaky(full, int(full["ts"].iloc[-1]), fail_at=7)
    try:
        V.sync(v, "F")
        assert False, "expected the network error"
    except OSError:
        pass
    assert len(V.load("fake", "F")) == 700                           # the 7 pages before the error are on disk (no flush was due)
    v.fail_at = 10 ** 9
    assert V.sync(v, "F")["n"] == 1500 and V.load("fake", "F")["ts"].tolist() == full["ts"].tolist()
    scratch()
    halt = {"on": False}
    v = Flaky(full, int(full["ts"].iloc[-1]), fail_at=5)
    orig = v.fetch

    def fetch(symbol, a, b, stop=None):                              # the stop lands while a request is failing
        if v.requests >= v.fail_at:
            halt["on"] = True
        return orig(symbol, a, b, stop)
    v.fetch = fetch
    res = V.sync(v, "G", stop=lambda: halt["on"])
    assert res["result"] == "stopped" and res["n"] == 500 and len(V.load("fake", "G")) == 500


def test_a_reverse_failure_keeps_history_pages_but_not_half_a_tail():
    scratch()
    full = series(T0, 2000, seed=15)
    v = FlakyReverse(full, int(full["ts"].iloc[999]), fail_at=10 ** 9)
    V.sync(v, "Q")                                                   # minutes 0..999, history done
    v.now = int(full["ts"].iloc[-1]); set_now(v.now)
    v.fail_at = v.requests + 4                                       # the tail walk (1000 new minutes) fails after 4 pages
    try:
        V.sync(v, "Q")
        assert False, "expected the network error"
    except OSError:
        pass
    assert V.load("fakerev", "Q")["ts"].iloc[-1] == full["ts"].iloc[999]   # nothing half-walked was kept: no hole
    v.fail_at = 10 ** 9
    assert V.load("fakerev", "Q")["ts"].tolist() == full["ts"].iloc[:1000].tolist()
    V.sync(v, "Q")
    assert V.load("fakerev", "Q")["ts"].tolist() == full["ts"].tolist()
    scratch()                                                        # a fresh series failing in its history walk keeps the pages
    v = FlakyReverse(full, int(full["ts"].iloc[-1]), fail_at=12)
    try:
        V.sync(v, "Q2")
        assert False, "expected the network error"
    except OSError:
        pass
    on_disk = V.load("fakerev", "Q2")
    assert len(on_disk) == 1200 and on_disk["ts"].iloc[-1] == full["ts"].iloc[-1]
    v.fail_at = 10 ** 9
    V.sync(v, "Q2", list_ms=T0)
    assert V.load("fakerev", "Q2")["ts"].tolist() == full["ts"].tolist() and V.load_side("fakerev", "Q2")["history_done"]



def test_a_print_only_one_exchange_shows_is_repaired_and_a_crash_two_show_stays():
    a = series(T0, 300, seed=11)
    b = series(T0, 300, dollars=5e5, seed=11)                       # the same prices, half the dollars
    a.loc[100, ["open", "low"]] = 0.01                               # Bitfinex 2013-04-16: a sale swept the book to $0.01 ...
    a.loc[200, ["open", "high", "low", "close"]] = 1.06              # ... and a whole candle at $1.06
    b = b.drop(index=[100, 200]).reset_index(drop=True)              # ... in minutes nobody else traded
    for f in (a, b):                                                 # minute 250: both exchanges crash 60% and come back
        i = f.index[f["ts"] == T0 + 250 * M][0]
        f.loc[i, ["low", "close"]] = [40.0, 45.0]
    merged = C.merge([a, b])
    out, fixed = C.despike(merged, [a, b])
    row = lambda df, k: df[df["ts"] == T0 + k * M].iloc[0]
    assert fixed == 2
    assert row(out, 100)["open"] == row(merged, 99)["close"] and row(out, 100)["low"] > 50
    assert row(out, 100)["close"] == row(merged, 100)["close"]
    assert all(row(out, 200)[c] == row(merged, 199)["close"] for c in C.PX)   # a flat candle at the last good price
    assert row(out, 250)["low"] == 40.0 and row(out, 250)["close"] == 45.0   # every exchange showed it: a real move
    keep = ~merged["ts"].isin([T0 + 100 * M, T0 + 200 * M])
    assert out[keep].equals(merged[keep])


def test_a_bad_print_from_the_exchange_with_most_say_takes_the_others_price():
    big = series(T0, 3000, dollars=1e6, seed=13)
    small = series(T0, 3000, dollars=1e4, seed=13)                   # the same prices, a hundredth of the dollars
    big.loc[2000, "low"] = 1.0
    merged = C.merge([big, small])
    assert merged.loc[2000, "low"] == 1.0                            # the median follows the exchange with most of the say
    out, fixed = C.despike(merged, [big, small])
    assert fixed == 1 and out.loc[2000, "low"] == small.loc[2000, "low"]
    assert out.drop(index=2000).equals(merged.drop(index=2000))


def test_live_rows_repair_a_print_only_one_exchange_shows():
    a = [[T0, 100.0, 101.0, 0.5, 100.5, 10.0, 1000.0]]
    b = [[T0, 100.0, 100.8, 99.5, 100.2, 5.0, 500.0]]
    rows = C.merge_rows([a, b], [3.0, 1.0])
    assert rows[0][3] == 0.5
    assert C.despike_rows(rows, [a, b], [3.0, 1.0], 100.0)[0][3] == 99.5
    a2 = [[T0, 100.0, 101.0, 40.0, 45.0, 10.0, 1000.0]]
    b2 = [[T0, 100.0, 100.0, 41.0, 46.0, 5.0, 500.0]]
    rows2 = C.merge_rows([a2, b2], [3.0, 1.0])
    assert C.despike_rows(rows2, [a2, b2], [3.0, 1.0], 100.0) == rows2   # both show the crash: it stays
    assert C.despike_rows(rows, [a, b], [3.0, 1.0], 0.0) == rows        # no chart yet: nothing to judge against


def test_a_head_check_walks_the_history_before_the_files_first_candle_once_and_resumes():
    scratch()
    full = series(T0, 1000, seed=14)
    v = Fake(full, int(full["ts"].iloc[-1]))
    v.head_check = True
    V.save("fake", "H", full.iloc[600:].reset_index(drop=True))     # a file whose first download started late
    V.save_side("fake", "H", {"first": int(full["ts"].iloc[600]), "history_done": True})
    stop_after = {"n": 3}
    res = V.sync(v, "H", stop=lambda: v.requests >= stop_after["n"])
    side = V.load_side("fake", "H")
    assert res["result"] == "stopped" and res["grew_back"] and side["head_walk"] == [T0 + 300 * M, T0 + 599 * M] and "head" not in side
    assert len(V.load("fake", "H")) == 700                           # what arrived is kept
    stop_after["n"] = 10 ** 9
    res = V.sync(v, "H")
    side = V.load_side("fake", "H")
    assert res["result"] == "done" and side["head"] == V.HEAD_VERSION and "head_walk" not in side
    assert V.load("fake", "H")["ts"].tolist() == full["ts"].tolist()
    n0 = v.requests
    V.sync(v, "H")
    assert v.requests - n0 == 1                                      # checked once: later syncs only catch up the tail


class FakeCoarse(Fake):
    """A venue with minute holes and coarser candles: 5-minute ones for some hours, hourly ones for all."""
    coarse_tfs = (5, 60)

    def __init__(self, df, now_ms, five, hourly):
        super().__init__(df, now_ms)
        self.five, self.hourly, self.coarse_calls = five, hourly, []

    def coarse(self, symbol, minutes, start_ms, end_ms, stop=None):
        self.coarse_calls.append((minutes, start_ms, end_ms))
        src = self.five if minutes == 5 else self.hourly
        return rows_of(src[(src["ts"] >= start_ms) & (src["ts"] <= end_ms)])


def test_hours_a_venue_serves_no_minutes_for_are_filled_from_its_coarser_candles():
    scratch()
    H = V.HOUR
    start = (T0 // H + 1) * H
    full = series(start, 4 * 1440, seed=15)
    hour = (full["ts"] - start) // H
    minutes = full[~hour.between(30, 40) & ~hour.between(50, 52)].reset_index(drop=True)
    hrs = np.arange(96)
    hourly = pd.DataFrame({"ts": start + hrs * H, "open": 100.0, "high": 101.0, "low": 99.0, "close": 100.0,
                           "volume": np.where((hrs >= 50) & (hrs <= 52), 0.0, 60.0), "turnover": 6000.0})   # 50-52: a halt
    f5 = start + np.arange(30 * 12, 36 * 12) * 5 * M
    five = pd.DataFrame({"ts": f5, "open": 100.0, "high": 100.5, "low": 99.5, "close": 100.0, "volume": 5.0, "turnover": 500.0})
    v = FakeCoarse(minutes, int(minutes["ts"].iloc[-1]), five, hourly)
    res = V.sync(v, "F")
    got = V.load("fake", "F")
    h = (got["ts"] - start) // H
    assert res["result"] == "done" and res["filled"] == 11
    assert sorted(got["ts"][h.between(30, 35)]) == sorted(f5)                              # 5-minute candles where it has them
    assert sorted(got["ts"][h.between(36, 40)]) == [start + k * H for k in range(36, 41)]  # else the hour's candle
    assert not h.between(50, 52).any()                                                      # no trades in the halt: nothing
    assert len(got) == len(minutes) + 72 + 5
    assert V.load_side("fake", "F")["holes_to"] == (int(minutes["ts"].iloc[-1]) - V.DAY) // H * H
    n = len(v.coarse_calls)
    V.sync(v, "F")
    assert len(v.coarse_calls) == n                                  # nothing new to check


def test_padding_candles_without_volume_are_not_stored_and_the_sync_still_advances():
    scratch()
    df = series(T0, 500, seed=16)
    pad = df.index % 7 != 0                                          # only every 7th minute traded (Bitstamp pads the rest)
    df.loc[pad, ["volume", "turnover"]] = 0.0
    v = Fake(df, int(df["ts"].iloc[-1]))
    v.drop_empty = True
    V.sync(v, "P")
    got = V.load("fake", "P")
    assert (got["volume"] > 0).all() and len(got) == int((~pad).sum()) and v.requests == 5


def test_a_step_to_a_new_price_level_is_not_a_bad_print():
    """Sparse history on one exchange: a day-apart series steps from 100 to 380 and stays (the review's case).
    Each row is near the rows on one side of it, so nothing is repaired; a lone print far from both sides is."""
    ts = T0 + np.arange(61) * V.DAY
    px = np.where(np.arange(61) < 30, 100.0, 380.0)
    f = pd.DataFrame({"ts": ts, "open": px, "high": px, "low": px, "close": px, "volume": 1.0, "turnover": px})
    out, fixed = C.despike(C.merge([f]), [f])
    assert fixed == 0
    g = f.copy()
    g.loc[45, ["low", "close"]] = [20.0, 20.0]
    out, fixed = C.despike(C.merge([g]), [g])
    assert fixed == 1 and out.loc[45, "low"] == 380.0 and out.loc[45, "close"] == 380.0


def test_a_stretch_longer_than_one_fine_request_fills_whole_hours():
    """The 5-minute window ends on an hour boundary: no missing hour gets only part of its candles (the review's case)."""
    scratch()
    H = V.HOUR
    start = (T0 // H + 1) * H
    full = series(start, 3 * 1440, seed=17)
    hour = (full["ts"] - start) // H
    minutes = full[~hour.between(10, 30)].reset_index(drop=True)
    hourly = pd.DataFrame({"ts": start + np.arange(72) * H, "open": 100.0, "high": 101.0, "low": 99.0, "close": 100.0,
                           "volume": 60.0, "turnover": 6000.0})
    f5 = start + np.arange(10 * 12, 31 * 12) * 5 * M
    five = pd.DataFrame({"ts": f5, "open": 100.0, "high": 100.5, "low": 99.5, "close": 100.0, "volume": 5.0, "turnover": 500.0})
    v = FakeCoarse(minutes, int(minutes["ts"].iloc[-1]), five, hourly)  # window 100: a fine request spans 8h20m
    res = V.sync(v, "W")
    got = V.load("fake", "W")
    per_hour = ((got["ts"] - start) // H).value_counts()
    assert res["filled"] == 21 and all(per_hour[k] == 12 for k in range(10, 31))
    assert all(b % H == H - 1 or b == ((int(minutes["ts"].iloc[-1]) - V.DAY) // H * H) - 1 for m_, a, b in v.coarse_calls if m_ == 5)


def test_a_coarse_failure_leaves_the_series_done_and_the_stretch_for_next_time():
    scratch()
    H = V.HOUR
    start = (T0 // H + 1) * H
    full = series(start, 3 * 1440, seed=18)
    minutes = full[~((full["ts"] - start) // H).between(5, 6)].reset_index(drop=True)
    hourly = pd.DataFrame({"ts": start + np.arange(72) * H, "open": 100.0, "high": 101.0, "low": 99.0, "close": 100.0,
                           "volume": 60.0, "turnover": 6000.0})
    v = FakeCoarse(minutes, int(minutes["ts"].iloc[-1]), hourly.iloc[:0], hourly)
    real = v.coarse

    def broken(*a, **k):
        raise LookupError("HTTP 500 [\"error\",11010,\"ratelimit: error\"]")
    v.coarse = broken
    res = V.sync(v, "E")
    assert res["result"] == "done" and res["filled"] == 0 and "holes_to" not in V.load_side("fake", "E")
    v.coarse = real
    res = V.sync(v, "E")
    assert res["filled"] == 2 and "holes_to" in V.load_side("fake", "E")


def test_a_first_candle_the_venue_is_unsure_of_is_checked_again():
    scratch()
    full = series(T0, 600, seed=19)
    v = Fake(full, int(full["ts"].iloc[-1]))
    v.head_check = True
    v.first_is_sure = lambda symbol: False                           # Binance's REST failed: the archive's first may be late
    V.sync(v, "U")
    assert "head" not in V.load_side("fake", "U")
    V.save("fake", "U", full.iloc[200:].reset_index(drop=True))     # (as if the archive started later than REST)
    v.first_is_sure = lambda symbol: True
    V.sync(v, "U")
    assert V.load_side("fake", "U")["head"] == V.HEAD_VERSION and V.load("fake", "U")["ts"].tolist() == full["ts"].tolist()


def test_bitstamp_finds_the_first_candle_of_a_pair_listed_years_after_it_opened():
    """One 3-day request spans 8.2 years from 2011: a pair listed later (SOL 2022) is found on the next page."""
    b, asked = V.Bitstamp(), []
    listed = 1_660_694_400                                           # 2022-08-17
    span = 1000 * V.Bitstamp.BUCKET_S

    def fake_get(url, **kw):
        start = int(url.rsplit("start=", 1)[1])
        asked.append(start)
        ts = [t for t in range(listed, start + span, V.Bitstamp.BUCKET_S) if t >= start]
        return {"data": {"ohlc": [{"timestamp": t, "open": 1, "high": 1, "low": 1, "close": 1, "volume": 2} for t in ts]}}
    real, V._get = V._get, fake_get
    try:
        set_now(1_794_000_000_000)
        assert b.first_ms("solusd") == listed * 1000 and asked == [V.Bitstamp.OPENED_S, V.Bitstamp.OPENED_S + span]
        asked.clear()
        listed = 1_900_000_000                                       # never traded before now: nothing, and the walk ends
        assert b.first_ms("nousd") is None and len(asked) == 2
    finally:
        V._get = real


class FakeArchive(Fake):
    """A Kraken-like venue: an archive streamed in chunks for the first rows, its API for the rest."""
    def __init__(self, df, now_ms, archived):
        super().__init__(df, now_ms)
        self.archived, self.streams = archived, []

    def stream(self, symbol, after_ms, stop=None):
        self.streams.append(after_ms)
        rows = rows_of(self.archived[self.archived["ts"] > after_ms])
        for i in range(0, len(rows), 100):
            yield rows[i:i + 100]
            if stop and stop():
                return

    def fetch(self, symbol, start_ms, end_ms, stop=None):
        assert start_ms > int(self.archived["ts"].iloc[-1]), "the API is asked only for what the archive does not have"
        return super().fetch(symbol, start_ms, end_ms, stop)


def test_an_archive_is_streamed_first_resumes_after_a_stop_and_the_api_takes_over():
    scratch()
    full = series(T0, 900, seed=20)
    v = FakeArchive(full, int(full["ts"].iloc[-1]), full.iloc[:600])
    chunks = {"n": 0}
    orig = v.stream

    def counted(symbol, after_ms, stop=None):
        for c in orig(symbol, after_ms, stop):
            chunks["n"] += 1
            yield c
    v.stream = counted
    res = V.sync(v, "K", stop=lambda: chunks["n"] >= 2)
    side = V.load_side("fake", "K")
    assert res["result"] == "stopped" and res["n"] == 200 and not side.get("stream_done")
    res = V.sync(v, "K")
    assert res["result"] == "done" and V.load_side("fake", "K")["stream_done"]
    assert v.streams == [-1, T0 + 199 * M]                           # resumed after the last stored minute
    assert V.load("fake", "K")["ts"].tolist() == full["ts"].tolist()
    n0, s0 = v.requests, len(v.streams)
    V.sync(v, "K")
    assert len(v.streams) == s0 and v.requests - n0 == 1             # streamed once: later syncs use the API only


def test_kraken_trades_become_minutes_and_a_window_moves_past_a_quiet_tail():
    k = V.Kraken()
    t = T0
    trades = [[t + 1000, 10.0, 1.0], [t + 2000, 12.0, 2.0], [t + 59000, 9.0, 1.0], [t + M + 5, 11.0, 3.0]]
    assert k._minutes(trades) == [[t, 10.0, 12.0, 9.0, 9.0, 4.0, 10.0 + 24.0 + 9.0], [t + M, 11.0, 11.0, 11.0, 11.0, 3.0, 33.0]]
    pages = [[[t + i * 30_000, 100.0 + i, 1.0] for i in range(1000)], [[t + 1000 * 30_000 + i, 50.0, 1.0] for i in range(3)]]
    calls = []

    def fake_trades(symbol, since_ns, stop=None):
        calls.append(since_ns)
        page = pages[len(calls) - 1] if len(calls) <= len(pages) else []
        return page, (page[-1][0] * 1_000_000 if page else since_ns)
    k._trades = fake_trades
    set_now(t + 10 * V.DAY)
    end = t + 1440 * M - 1
    rows = k.fetch("XBTUSD", t, end)
    assert calls[0] == t * 1_000_000 - 1 and len(calls) == 2         # since is exclusive; paged until the trades ran out
    assert rows[0][0] == t and rows[-1] == [end // M * M, rows[-2][4], rows[-2][4], rows[-2][4], rows[-2][4], 0.0, 0.0]
    assert all(r[5] > 0 for r in rows[:-1]) and sum(r[5] for r in rows) == 1003.0


def test_a_file_the_archive_did_not_write_is_streamed_from_the_start():
    """A Kraken file holding only newer API rows (its side file lost, say): the archive is streamed whole, not
    from the file's newest minute, so the history before it arrives (the review's case)."""
    scratch()
    full = series(T0, 900, seed=21)
    v = FakeArchive(full, int(full["ts"].iloc[-1]), full.iloc[:600])
    V.save("fake", "P", full.iloc[700:].reset_index(drop=True))
    res = V.sync(v, "P")
    assert v.streams == [-1] and res["result"] == "done" and V.load_side("fake", "P")["stream_done"]
    assert V.load("fake", "P")["ts"].tolist() == full["ts"].tolist()     # the gap between the archive and the file too

if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_"):
            fn()
            print("ok", name)
