"""Bar-cutting tests on synthetic candles. Run with `python tests/test_bars.py` or `pytest`."""
import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import bars as B  # noqa: E402

DAY_MS = 86_400_000


def synthetic(n_minutes: int, seed: int = 0, start_ms: int = 1_700_000_000_000 // B.MINUTE * B.MINUTE) -> pd.DataFrame:
    """Lognormal turnover per minute with a few enormous minutes, random-walk prices, a 0.5% gap of missing minutes."""
    rng = np.random.default_rng(seed)
    ts = start_ms + np.arange(n_minutes) * B.MINUTE
    keep = rng.random(n_minutes) > 0.005
    ts = ts[keep]
    n = len(ts)
    close = 30_000 * np.exp(np.cumsum(rng.normal(0, 0.001, n)))
    open_ = np.concatenate(([close[0]], close[:-1]))
    high = np.maximum(open_, close) * (1 + rng.random(n) * 0.001)
    low = np.minimum(open_, close) * (1 - rng.random(n) * 0.001)
    turnover = np.exp(rng.normal(np.log(3e6), 0.8, n))
    turnover[rng.random(n) < 0.001] *= 200                       # a handful of huge minutes
    return pd.DataFrame({"ts": ts, "open": open_, "high": high, "low": low, "close": close,
                         "volume": turnover / close, "turnover": turnover})


def test_every_completed_dollar_bar_reaches_its_size():
    df = synthetic(60_000)
    cd = B.Candles(df)
    pos = {int(t): i for i, t in enumerate(df["ts"])}
    for size in (1e8, 5e8, 2e9):
        bars, forming, start = B.dollar_bars(cd, size)
        assert bars, size
        for b in bars:
            i0 = pos[b["t"] * 1000]
            i1 = i0 + b["n"] - 1
            raw = float(df["turnover"].iloc[i0:i1 + 1].sum())
            assert raw >= size, (size, b)
            assert raw - float(df["turnover"].iloc[i1]) < size, ("bar closed later than needed", size, b)
        assert forming is None or float(df["turnover"].iloc[start:].sum()) < size
        # bars tile the candles without gaps or overlap
        assert pos[bars[0]["t"] * 1000] == 0
        for a, b in zip(bars, bars[1:]):
            assert pos[b["t"] * 1000] == pos[a["t"] * 1000] + a["n"]


def test_incremental_update_matches_full_rebuild():
    """Feed the candles in chunks, revising the last minute several times as a live feed does."""
    df = synthetic(30_000, seed=1)
    head = 20_000
    cd = B.Candles(df.iloc[:head])
    sets, _ = B.build_all(cd)
    rows = df.iloc[head:].to_numpy().tolist()
    rng = np.random.default_rng(2)
    i = 0
    while i < len(rows):
        chunk = rows[i:i + int(rng.integers(1, 40))]
        i += len(chunk)
        partial = list(chunk[-1])
        partial[6] *= 0.3                                        # first sighting of the newest minute: not yet complete
        partial[2] = max(partial[1], partial[4])
        cd.upsert(chunk[:-1] + [partial])
        B.update_all(sets, cd)
        cd.upsert([chunk[-1]])                                   # then the finished minute
        B.update_all(sets, cd)
    full = B.Candles(df)                                         # same sizes as the sets were built with (the auto size is fixed at build time)
    for k, s in sets.items():
        bars, forming, _ = B.dollar_bars(full, s["size"]) if k.startswith("d:") else B.time_bars(full, s["tf"])
        assert s["bars"] == bars, k
        assert s["forming"] == forming, k
    assert np.array_equal(cd.frame()["volume"].to_numpy(), df["volume"].to_numpy())


def test_time_bar_period_starts():
    ts = np.array([1_700_000_000_000, 1_700_000_000_000 + 5 * DAY_MS])
    for tf, check in (("1h", lambda t: t % 3_600_000 == 0), ("4h", lambda t: t % 14_400_000 == 0), ("1D", lambda t: t % DAY_MS == 0),
                      ("1W", lambda t: pd.Timestamp(t, unit="ms").weekday() == 0 and t % DAY_MS == 0),
                      ("1M", lambda t: pd.Timestamp(t, unit="ms").day == 1 and t % DAY_MS == 0)):
        ps = B.period_start(ts, tf)
        assert all(check(int(p)) for p in ps), tf
        assert all(p <= t for p, t in zip(ps, ts)), tf
    bars, forming, start = B.time_bars(B.Candles(synthetic(3_000, seed=3)), "1h")
    assert all(b["t"] % 3600 == 0 for b in bars)
    assert all(b["n"] <= 60 for b in bars)


def test_live_poll_recuts_a_bar_closed_on_a_partial_minute():
    """The live poller sends [K-1, K final, K+1 forming] in one upsert after K was first seen partial: the bar
    that closed on partial K must be cut again with the full K, exactly as a fresh build would."""
    df = synthetic(20_000, seed=5)
    rows = df.to_numpy().tolist()
    head = 15_000
    cd = B.Candles(df.iloc[:head])
    sets, _ = B.build_all(cd)
    for i in range(head, len(rows) - 1):
        partial = list(rows[i]); partial[6] *= 0.2; partial[2] = max(partial[1], partial[4]); partial[3] = min(partial[1], partial[4])
        cd.upsert([partial])                                     # minute i, forming
        B.update_all(sets, cd)
        nxt = list(rows[i + 1]); nxt[6] *= 0.1
        cd.upsert([rows[i - 1], rows[i], nxt])                   # the next poll: i final, i+1 forming
        B.update_all(sets, cd)
        cd.upsert([rows[i + 1]])
        B.update_all(sets, cd)
    full = B.Candles(df)
    for k, s in sets.items():
        bars, forming, _ = B.dollar_bars(full, s["size"]) if k.startswith("d:") else B.time_bars(full, s["tf"])
        assert s["bars"] == bars, k
        assert s["forming"] == forming, k


def test_size_keys_match_the_page():
    """The page builds its key as 'd:' + size with JS number formatting; the server must agree for every size."""
    for auto in (1.5, 37.0, 1.5e6, 5.5e9):
        sizes = B.sizes_for(auto, {"1h": auto * 0.029, "4h": auto * 0.13, "1D": auto, "1W": auto * 6.5, "1M": auto * 29})
        keys = [B.size_key(s) for s in sizes]
        assert len(set(keys)) == len(sizes), keys
        for s, k in zip(sizes, keys):
            js = str(int(s)) if s == int(s) else repr(s)
            assert k == "d:" + js, (s, k)
    assert B.size_key(5.5e9) == "d:5500000000" and B.size_key(0.75) == "d:0.75"


def test_median_sizes_per_period():
    """$1M every minute for 400 days: whole periods hold exactly 60, 240, 1440 or 10,080 minutes' worth, months
    30 or 31 days; partial periods at either end don't drag the medians down; all of them are in the menu."""
    start = 1_700_000_000_000 // DAY_MS * DAY_MS + 7 * B.MINUTE         # not on a period boundary
    ts = start + np.arange(400 * 1440) * B.MINUTE
    one = np.ones(len(ts))
    cd = B.Candles(pd.DataFrame({"ts": ts, "open": one, "high": one, "low": one, "close": one, "volume": one * 1e6, "turnover": one * 1e6}))
    sets, meta = B.build_all(cd)
    md = meta["medians"]
    assert md["1h"] == 6e7 and md["4h"] == 2.4e8 and md["1D"] == meta["auto_size"] == 1.4e9 and md["1W"] == 1e10, md
    assert md["1M"] in (4.3e10, 4.5e10), md
    assert set(md.values()) <= set(meta["sizes"]) and all(B.size_key(s) in sets for s in md.values())
    young = B.Candles(pd.DataFrame({"ts": ts[:3 * 1440], "open": one[:4320], "high": one[:4320], "low": one[:4320],
                                    "close": one[:4320], "volume": one[:4320], "turnover": one[:4320] * 1e6}))
    md = B.median_sizes(young, B.auto_size(young))
    assert set(md) == {"1h", "4h", "1D"}, md                      # three days: no whole week or month yet


def test_nearest_size_matches_the_page_fallback():
    """The server answers a gone size with the set the page will pick: the closest left on a log scale."""
    sizes = [1.5e8, 5.2e8, 6.6e8, 1e9, 2.6e9, 5.2e9, 1e10, 2.6e10, 3.4e10, 5.2e10, 1.5e11]
    assert B.nearest_size(sizes, "170000000", 5.2e9) == 1.5e8
    assert B.nearest_size(sizes, "30000000000", 5.2e9) == 3.4e10
    assert B.nearest_size(sizes, "1e13", 5.2e9) == 1.5e11
    assert B.nearest_size(sizes, "null", 5.2e9) == 5.2e9 == B.nearest_size(sizes, "0", 5.2e9) == B.nearest_size(sizes, "x", 5.2e9)


def test_upsert_replaces_same_minute_and_ignores_older():
    df = synthetic(100, seed=4)
    cd = B.Candles(df)
    last = int(cd.ts[cd.n - 1])
    cd.upsert([[last, 1, 2, 0.5, 1.5, 10, 12.5]])
    assert cd.n == 100 and cd.d[cd.n - 1] == 12.5
    cd.upsert([[last - B.MINUTE, 1, 2, 0.5, 1.5, 10, 99]])
    assert cd.n == 100 and cd.d[cd.n - 1] == 12.5
    cd.upsert([[last + B.MINUTE, 1, 2, 0.5, 1.5, 10, 7]])
    assert cd.n == 101 and cd.d[cd.n - 1] == 7
    assert cd.dirty_from == 99


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_"):
            fn()
            print("ok", name)
