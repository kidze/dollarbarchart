"""Bar builders for the viewer, working on 1-minute candles held in growable numpy arrays.

Dollar bars follow Lopez de Prado (AFML ch. 2): a bar closes with the candle whose turnover brings the
dollars traded SINCE THE BAR OPENED up to the threshold, so every completed bar holds >= size (plus the
overflow of its last minute). Time bars are the usual 1h/4h/1D/1W/1M candles; weeks start Monday 00:00 UTC.
Every bar's `t` is its open time (seconds), like TradingView; `e` is its close time.
"""
import numpy as np
import pandas as pd

SIZE_STEPS = [0.1, 0.2, 0.5, 1, 2, 5, 10]        # dollar sizes offered = the market's median day x these
TIMEFRAMES = ["1h", "4h", "1D", "1W", "1M"]
MINUTE = 60_000
DAY = 86_400_000


class Candles:
    """ts (ms), open, high, low, close, volume, turnover in arrays with spare capacity so live candles append in place."""

    ARRAYS = ("ts", "o", "h", "l", "c", "v", "d")

    def __init__(self, df: pd.DataFrame, spare: int = 20_000):
        n = len(df)
        self.cap = n + spare
        self.n = n
        self.ts = np.zeros(self.cap, np.int64); self.ts[:n] = df["ts"].to_numpy(np.int64)
        self.o = np.zeros(self.cap); self.o[:n] = df["open"].to_numpy(float)
        self.h = np.zeros(self.cap); self.h[:n] = df["high"].to_numpy(float)
        self.l = np.zeros(self.cap); self.l[:n] = df["low"].to_numpy(float)
        self.c = np.zeros(self.cap); self.c[:n] = df["close"].to_numpy(float)
        self.v = np.zeros(self.cap); self.v[:n] = df["volume"].to_numpy(float)
        self.d = np.zeros(self.cap); self.d[:n] = df["turnover"].to_numpy(float)
        self.dirty_from = n                                  # first index not yet written to the parquet
        self.touched = n                                     # lowest index rewritten since the bar sets were last updated

    def _grow(self) -> None:
        self.cap = self.cap + self.cap // 2 + 100_000
        for name in self.ARRAYS:
            a = getattr(self, name)
            b = np.zeros(self.cap, a.dtype); b[:self.n] = a[:self.n]
            setattr(self, name, b)

    def upsert(self, rows) -> None:
        """rows = [[ts, o, h, l, c, volume, turnover], ...] oldest-first; replaces the candle with the same ts, appends newer ones."""
        for r in rows:
            ts = int(r[0])
            if self.n and ts < self.ts[self.n - 1]:
                continue                                     # older than what we hold: ignore
            i = self.n - 1 if (self.n and ts == self.ts[self.n - 1]) else self.n
            if i == self.n:
                if i >= self.cap:
                    self._grow()
                self.n += 1
            self.ts[i], self.o[i], self.h[i], self.l[i], self.c[i], self.v[i], self.d[i] = ts, r[1], r[2], r[3], r[4], r[5], r[6]
            self.dirty_from = min(self.dirty_from, i)
            self.touched = min(self.touched, i)

    def frame(self) -> pd.DataFrame:
        n = self.n
        return pd.DataFrame({"ts": self.ts[:n], "open": self.o[:n], "high": self.h[:n], "low": self.l[:n],
                             "close": self.c[:n], "volume": self.v[:n], "turnover": self.d[:n]})

    def bar(self, i0: int, i1: int) -> dict:
        """One bar from candles i0..i1 inclusive."""
        return {"t": int(self.ts[i0] // 1000), "e": int((self.ts[i1] + MINUTE) // 1000),
                "o": _px(self.o[i0]), "h": _px(self.h[i0:i1 + 1].max()),
                "l": _px(self.l[i0:i1 + 1].min()), "c": _px(self.c[i1]),
                "d": int(round(float(self.d[i0:i1 + 1].sum()))), "n": int(i1 - i0 + 1)}


def _px(x) -> float:
    """Prices as sent to the chart: 6 significant digits is plenty for a candle and keeps sub-cent coins exact enough."""
    return float(f"{float(x):.6g}")


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
    """Median daily turnover over the last 365 days, rounded to two significant figures.
    Falls back to the average day (or $1M) while a market has only a day or two of candles."""
    n = cd.n
    last = cd.ts[n - 1]
    m = cd.ts[:n] >= last - 365 * DAY
    days = cd.ts[:n][m] // DAY
    daily = pd.Series(cd.d[:n][m]).groupby(days).sum()
    med = float(daily.iloc[1:-1].median()) if len(daily) > 2 else float(daily.mean())   # drop the two partial days
    if not med > 0:
        total = float(cd.d[:n].sum())
        span_days = max(1.0, (cd.ts[n - 1] - cd.ts[0]) / DAY)
        med = total / span_days if total > 0 else 1e6
    return float(f"{med:.2g}")


def sizes_for(auto: float) -> list:
    """The menu: the median day and a few multiples either side, each rounded to two significant figures."""
    out = {float(f"{auto * k:.2g}") for k in SIZE_STEPS}
    out.add(auto)
    return sorted(s for s in out if s > 0)


def size_key(size: float) -> str:
    """Must equal the page's 'd:' + size (JS Number#toString): whole dollars without '.0', fractions in
    shortest round-trip form (only markets with a median day under $100 ever have fractional sizes)."""
    return f"d:{int(size)}" if size == int(size) else f"d:{size!r}"


def build_all(cd: Candles) -> tuple[dict, dict]:
    """All bar sets from scratch. Returns (sets, meta)."""
    auto = auto_size(cd)
    sizes = sizes_for(auto)
    sets = {}
    for s in sizes:
        bars, forming, st = dollar_bars(cd, s)
        sets[size_key(s)] = {"bars": bars, "forming": forming, "start": st, "size": s}
    for tf in TIMEFRAMES:
        bars, forming, st = time_bars(cd, tf)
        sets["t:" + tf] = {"bars": bars, "forming": forming, "start": st, "tf": tf}
    meta = {"auto_size": auto, "sizes": sizes, "timeframes": TIMEFRAMES,
            "first": int(cd.ts[0] // 1000), "last": int(cd.ts[cd.n - 1] // 1000), "n_candles": int(cd.n)}
    cd.touched = cd.n
    return sets, meta


def update_all(sets: dict, cd: Candles) -> None:
    """Recompute only from each set's forming bar onward (cheap; called after every live candle).
    A dollar bar that closed on a candle this upsert rewrote (a minute first seen while still forming) is
    re-cut with the fuller candle, even when later minutes arrived in the same upsert."""
    for key, s in sets.items():
        if key.startswith("d:"):
            while s["bars"] and s["start"] - 1 >= cd.touched:    # its closing candle changed: cut it again
                s["start"] -= s["bars"].pop()["n"]
            bars, forming, st = dollar_bars(cd, s["size"], s["start"])
        else:
            bars, forming, st = time_bars(cd, s["tf"], s["start"])
        s["bars"].extend(bars)
        s["forming"], s["start"] = forming, st
    cd.touched = cd.n
