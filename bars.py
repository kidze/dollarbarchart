"""Bar builders for the viewer, working on 1-minute candles held in growable numpy arrays.

Dollar bars follow Lopez de Prado (AFML ch. 2): a bar closes with the candle whose turnover brings the
dollars traded SINCE THE BAR OPENED up to the threshold, so every completed bar holds >= size (plus the
overflow of its last minute). Time bars are the usual 1h/4h/1D/1W/1M candles; weeks start Monday 00:00 UTC.
Every bar's `t` is its open time (seconds), like TradingView; `e` is its close time.
"""
import numpy as np
import pandas as pd

DOLLAR_SIZES = [1e9, 2e9, 5e9, 10e9, 20e9, 50e9]
TIMEFRAMES = ["1h", "4h", "1D", "1W", "1M"]
MINUTE = 60_000
DAY = 86_400_000


class Candles:
    """ts (ms), open, high, low, close, turnover in arrays with spare capacity so live candles append in place."""

    def __init__(self, df: pd.DataFrame):
        n = len(df)
        self.cap = n + 1_000_000
        self.n = n
        self.ts = np.zeros(self.cap, np.int64); self.ts[:n] = df["ts"].to_numpy(np.int64)
        self.o = np.zeros(self.cap); self.o[:n] = df["open"].to_numpy(float)
        self.h = np.zeros(self.cap); self.h[:n] = df["high"].to_numpy(float)
        self.l = np.zeros(self.cap); self.l[:n] = df["low"].to_numpy(float)
        self.c = np.zeros(self.cap); self.c[:n] = df["close"].to_numpy(float)
        self.v = np.zeros(self.cap); self.v[:n] = df["volume"].to_numpy(float)
        self.d = np.zeros(self.cap); self.d[:n] = df["turnover"].to_numpy(float)
        self.dirty_from = n                                  # first index not yet written to the parquet

    def upsert(self, rows) -> None:
        """rows = [[ts, o, h, l, c, volume, turnover], ...] oldest-first; replaces the candle with the same ts, appends newer ones."""
        for r in rows:
            ts = int(r[0])
            if self.n and ts < self.ts[self.n - 1]:
                continue                                     # older than what we hold: ignore
            i = self.n - 1 if (self.n and ts == self.ts[self.n - 1]) else self.n
            if i == self.n:
                self.n += 1
            self.ts[i], self.o[i], self.h[i], self.l[i], self.c[i], self.v[i], self.d[i] = ts, r[1], r[2], r[3], r[4], r[5], r[6]
            self.dirty_from = min(self.dirty_from, i)

    def frame(self) -> pd.DataFrame:
        n = self.n
        return pd.DataFrame({"ts": self.ts[:n], "open": self.o[:n], "high": self.h[:n], "low": self.l[:n],
                             "close": self.c[:n], "volume": self.v[:n], "turnover": self.d[:n]})

    def bar(self, i0: int, i1: int) -> dict:
        """One bar from candles i0..i1 inclusive."""
        return {"t": int(self.ts[i0] // 1000), "e": int((self.ts[i1] + MINUTE) // 1000),
                "o": round(float(self.o[i0]), 1), "h": round(float(self.h[i0:i1 + 1].max()), 1),
                "l": round(float(self.l[i0:i1 + 1].min()), 1), "c": round(float(self.c[i1]), 1),
                "d": round(float(self.d[i0:i1 + 1].sum()) / 1e9, 4), "n": int(i1 - i0 + 1)}


def dollar_bars(cd: Candles, size: float, start: int = 0):
    """Completed bars from candle `start` on, the forming bar, and the index where the forming bar starts."""
    n = cd.n
    if start >= n:
        return [], None, start
    cum = np.cumsum(cd.d[start:n])
    out, i = [], 0
    while True:
        base = cum[i - 1] if i > 0 else 0.0
        j = int(np.searchsorted(cum, base + size, side="left"))   # first candle at which the bar's dollars reach size
        if j >= len(cum):
            break
        out.append(cd.bar(start + i, start + j))
        i = j + 1
    forming = cd.bar(start + i, n - 1) if i < len(cum) else None
    return out, forming, start + i


def period_start(ts_ms: np.ndarray, tf: str) -> np.ndarray:
    if tf.endswith("h"):
        p = int(tf[:-1]) * 3_600_000
        return ts_ms // p * p
    if tf == "1D":
        return ts_ms // DAY * DAY
    if tf == "1W":
        day = ts_ms // DAY
        return ((day + 3) // 7 * 7 - 3) * DAY                 # epoch day 0 was a Thursday; weeks start Monday
    if tf == "1M":
        return pd.to_datetime(ts_ms, unit="ms").to_period("M").to_timestamp().as_unit("ms").asi8   # ms, whatever unit pandas picked
    raise ValueError(tf)


def time_bars(cd: Candles, tf: str, start: int = 0):
    n = cd.n
    if start >= n:
        return [], None, start
    ps = period_start(cd.ts[start:n], tf)
    idx = np.flatnonzero(np.diff(ps)) + 1
    starts = np.concatenate(([0], idx))
    ends = np.concatenate((idx - 1, [len(ps) - 1]))
    bars = []
    for a, b in zip(starts, ends):
        bar = cd.bar(start + int(a), start + int(b))
        bar["t"] = int(ps[a] // 1000)                          # label by period start even if the first minute is missing
        bars.append(bar)
    return bars[:-1], bars[-1], start + int(starts[-1])


def auto_size(cd: Candles) -> float:
    """Median daily turnover over the last 365 days, rounded to two significant figures."""
    n = cd.n
    last = cd.ts[n - 1]
    m = cd.ts[:n] >= last - 365 * DAY
    days = cd.ts[:n][m] // DAY
    daily = pd.Series(cd.d[:n][m]).groupby(days).sum()
    daily = daily.iloc[1:-1] if len(daily) > 2 else daily     # drop the two partial days
    return float(f"{float(daily.median()):.2g}")


def size_key(size: float) -> str:
    return f"d:{int(size)}"


def build_all(cd: Candles) -> tuple[dict, dict]:
    """All bar sets from scratch. Returns (sets, meta)."""
    auto = auto_size(cd)
    sizes = sorted(set(DOLLAR_SIZES) | {auto})
    sets = {}
    for s in sizes:
        bars, forming, st = dollar_bars(cd, s)
        sets[size_key(s)] = {"bars": bars, "forming": forming, "start": st, "size": s}
    for tf in TIMEFRAMES:
        bars, forming, st = time_bars(cd, tf)
        sets["t:" + tf] = {"bars": bars, "forming": forming, "start": st, "tf": tf}
    meta = {"auto_size": auto, "sizes": sizes, "timeframes": TIMEFRAMES,
            "first": int(cd.ts[0] // 1000), "last": int(cd.ts[cd.n - 1] // 1000), "n_candles": int(cd.n),
            "source": "Bybit BTCUSDT perpetual, 1-minute candles, dollars = exchange-reported turnover"}
    return sets, meta


def update_all(sets: dict, cd: Candles) -> None:
    """Recompute only from each set's forming bar onward (cheap; called after every live candle)."""
    last_ts = int(cd.ts[cd.n - 1])
    for key, s in sets.items():
        if key.startswith("d:"):
            if s["bars"] and s["bars"][-1]["e"] * 1000 > last_ts:      # closed on the still-forming minute: re-cut it with the fuller minute
                s["start"] -= s["bars"].pop()["n"]
            bars, forming, st = dollar_bars(cd, s["size"], s["start"])
        else:
            bars, forming, st = time_bars(cd, s["tf"], s["start"])
        s["bars"].extend(bars)
        s["forming"], s["start"] = forming, st
