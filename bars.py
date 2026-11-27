"""Bar builders for the viewer, working on 1-minute candles held in growable numpy arrays.

Dollar bars follow Lopez de Prado (AFML ch. 2): a bar closes with the candle whose turnover brings the
dollars traded SINCE THE BAR OPENED up to the threshold, so every completed bar holds >= size (plus the
overflow of its last minute). Adaptive dollar bars do the same with a size that follows the market: a bar
starting on day D is sized as the median daily turnover of the 30 complete days before D divided by a target
number of bars a day, so a coin whose trading grew 100x keeps a similar number of bars a day through its
whole history (only past days decide a size, never the bar's own day or later). Time bars are the usual
1h/4h/1D/1W/1M candles; weeks start Monday 00:00 UTC.
Every bar's `t` is its open time (seconds), like TradingView; `e` is its close time.
"""
import numpy as np
import pandas as pd

SIZE_STEPS = [0.1, 0.2, 0.5, 1, 2, 5, 10]        # dollar sizes offered = the market's median day x these
MEDIAN_TFS = ["1h", "4h", "1W", "1M"]            # also offered: the median hour, 4 hours, week and month
ADAPTIVE = [24, 6, 1]                            # adaptive sets: about this many bars a day
ADAPT_DAYS = 30                                  # each day's adaptive size comes from the median of the days before it
ADAPT_LOOKBACK = 400                             # ... that had trades, looked for this far back (across a hole in the data)
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
        """One bar from candles i0..i1 inclusive: times (s), prices, v = volume in the base coin (the `volume` of the
        indicators people load), d = dollars, n = candles."""
        return {"t": int(self.ts[i0] // 1000), "e": int((self.ts[i1] + MINUTE) // 1000),
                "o": _px(self.o[i0]), "h": _px(self.h[i0:i1 + 1].max()),
                "l": _px(self.l[i0:i1 + 1].min()), "c": _px(self.c[i1]), "v": _px(self.v[i0:i1 + 1].sum()),
                "d": int(round(float(self.d[i0:i1 + 1].sum()))), "n": int(i1 - i0 + 1)}


def _px(x) -> float:
    """Prices as sent to the chart: 6 significant digits is plenty for a candle and keeps sub-cent coins exact enough."""
    return float(f"{float(x):.6g}")


_P10 = np.array([float(f"1e{i}") for i in range(23)])           # 10^0 .. 10^22: each one exact as a float


def px_all(x) -> list:
    """_px() of every value at once, the same floats. A value times a power of ten is rounded to a whole number
    and divided back (both steps exact: the power is, and so is the whole number); the few values within a
    millionth of a half there, where the product's own rounding could tip the result, take _px itself."""
    x = np.asarray(x, float)
    a = np.abs(x)
    with np.errstate(divide="ignore", invalid="ignore"):
        k = 5 - np.floor(np.log10(a))                            # decimals kept (negative: a price of millions)
        fast = np.isfinite(k) & (np.abs(k) <= 22)
        ki = np.where(fast, k, 0).astype(np.int64)
        p = _P10[np.abs(ki)]
        m = np.where(ki >= 0, a * p, a / p)
        fast &= np.abs(m - np.floor(m) - 0.5) > 1e-6
        out = np.where(fast, np.copysign(np.where(ki >= 0, np.rint(m) / p, np.rint(m) * p), x), x).tolist()
    for i in np.flatnonzero(~fast).tolist():
        out[i] = _px(out[i])
    return out


def bars_of(cd: Candles, s: np.ndarray, e: np.ndarray, z=None) -> list:
    """cd.bar(s[k], e[k]) for every k at once: bars that follow each other without a gap (each starts on the
    candle after the one before ended). z = one size per bar, carried as "z" (adaptive bars)."""
    if not len(s):
        return []
    a, b, at = int(s[0]), int(e[-1]) + 1, s - s[0]
    cols = [(cd.ts[s] // 1000).tolist(), ((cd.ts[e] + MINUTE) // 1000).tolist(), px_all(cd.o[s]),
            px_all(np.maximum.reduceat(cd.h[a:b], at)), px_all(np.minimum.reduceat(cd.l[a:b], at)), px_all(cd.c[e]),
            px_all(np.add.reduceat(cd.v[a:b], at)),
            np.rint(np.add.reduceat(cd.d[a:b], at)).astype(np.int64).tolist(), (e - s + 1).tolist()]
    if z is None:
        return [{"t": t, "e": u, "o": o, "h": h, "l": lo, "c": c, "v": v, "d": d, "n": n} for t, u, o, h, lo, c, v, d, n in zip(*cols)]
    return [{"t": t, "e": u, "o": o, "h": h, "l": lo, "c": c, "v": v, "d": d, "n": n, "z": w}
            for t, u, o, h, lo, c, v, d, n, w in zip(*cols, z)]


def _cut(cum: np.ndarray, size_at, never_falls: bool) -> list:
    """Where each bar ends: the first candle at which the dollars since the bar opened reach size_at(the bar's
    first candle). cum = the candles' running dollars. A bar ends near where it starts, so each search looks at
    a short stretch first and widens it (the same answer as searching everything while cum never falls, far
    quicker on years of minutes)."""
    m, ends, i, w = len(cum), [], 0, 64
    find = cum.searchsorted
    while i < m:
        target = (cum[i - 1] if i else 0.0) + size_at(i)
        if never_falls:
            hi = min(m, i + w)
            j = i + int(cum[i:hi].searchsorted(target, side="left"))
            while j == hi and hi < m:
                w *= 8
                hi = min(m, i + w)
                j = i + int(cum[i:hi].searchsorted(target, side="left"))
            w = max(64, 2 * (j - i + 1))
        else:
            j = int(find(target, side="left"))
        if j >= m:
            break
        ends.append(j)
        i = j + 1
    return ends


def _dollars(cd: Candles, start: int, cum=None) -> tuple:
    """(running dollars of candles start.., whether they never fall): cum = a build's shared running dollars from candle 0."""
    d = cd.d[start:cd.n]
    if cum is None or start:
        cum = np.cumsum(d)
    return cum, not bool((d < 0).any())


def dollar_bars(cd: Candles, size: float, start: int = 0, cum=None):
    """Completed bars from candle `start` on, the forming bar, and the index where the forming bar starts."""
    n = cd.n
    if start >= n:
        return [], None, start
    cum, never_falls = _dollars(cd, start, cum)
    ends = np.asarray(_cut(cum, lambda i: size, never_falls), np.int64) + start
    starts = np.concatenate(([start], ends[:-1] + 1)) if len(ends) else ends
    i = int(ends[-1]) + 1 if len(ends) else start
    forming = cd.bar(i, n - 1) if i < n else None
    return bars_of(cd, starts, ends), forming, i


def day_sizes(cd: Candles, per_day: float, d_from: int, d_to: int, medians: dict = None) -> dict:
    """{epoch day: adaptive bar size} for days d_from..d_to: the median turnover of the ADAPT_DAYS most recent
    days before each that had trades (at most ADAPT_LOOKBACK days back), over per_day. A day without candles is
    a hole in the data or a halted market, not a $0 day: counted as $0, a month-long hole (Bitfinex has no BTC
    minutes for December 2014) collapsed the size to $1 and made every minute after it a bar. A day with no
    such day behind it uses its own total. Never below $1. medians = day_medians() of those days, when the
    caller has them (a build cuts three adaptive sets from the same medians)."""
    if medians is None:
        medians = day_medians(cd, d_from, d_to)
    return {d: max(medians[d] / per_day, 1.0) for d in range(d_from, d_to + 1)}


def day_medians(cd: Candles, d_from: int, d_to: int) -> dict:
    """{epoch day: the median day's dollars day_sizes() divides} for days d_from..d_to."""
    n = cd.n
    first = int(cd.ts[0] // DAY)
    lo = max(first, d_from - ADAPT_DAYS - ADAPT_LOOKBACK)
    i0 = int(np.searchsorted(cd.ts[:n], lo * DAY))
    tot = np.bincount((cd.ts[i0:n] // DAY - lo).astype(np.int64), weights=cd.d[i0:n], minlength=d_to - lo + 1)
    traded = np.flatnonzero(tot > 0)                 # day offsets from lo that had trades
    out = {}
    for d in range(d_from, d_to + 1):
        k = int(np.searchsorted(traded, d - lo))     # the traded days before d, no further back than the lookback
        k0 = int(np.searchsorted(traded, d - ADAPT_DAYS - ADAPT_LOOKBACK - lo))
        past = tot[traded[max(k0, k - ADAPT_DAYS):k]]
        out[d] = float(np.median(past)) if len(past) else float(tot[d - lo])
    return out


def adaptive_bars(cd: Candles, per_day: float, start: int = 0, cum=None, medians: dict = None):
    """Like dollar_bars, but each bar's size is its first minute's day size (day_sizes); every bar carries it as "z"."""
    n = cd.n
    if start >= n:
        return [], None, start
    cum, never_falls = _dollars(cd, start, cum)
    days = cd.ts[start:n] // DAY
    size_of = day_sizes(cd, per_day, int(days[0]), int(days[-1]), medians)
    ends = np.asarray(_cut(cum, lambda i: size_of[int(days[i])], never_falls), np.int64) + start
    starts = np.concatenate(([start], ends[:-1] + 1)) if len(ends) else ends
    i = int(ends[-1]) + 1 if len(ends) else start
    forming = None
    if i < n:
        forming = cd.bar(i, n - 1)
        forming["z"] = int(round(size_of[int(days[i - start])]))
    return bars_of(cd, starts, ends, [int(round(size_of[d])) for d in days[starts - start].tolist()]), forming, i


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
        return ts_ms.astype("datetime64[ms]").astype("datetime64[M]").astype("datetime64[ms]").astype(np.int64)
    raise ValueError(tf)


def time_bars(cd: Candles, tf: str, start: int = 0):
    n = cd.n
    if start >= n:
        return [], None, start
    ps = period_start(cd.ts[start:n], tf)
    idx = np.flatnonzero(np.diff(ps)) + 1
    starts = np.concatenate(([0], idx))
    ends = np.concatenate((idx - 1, [len(ps) - 1]))
    bars = bars_of(cd, starts + start, ends + start)
    for bar, t in zip(bars, (ps[starts] // 1000).tolist()):
        bar["t"] = t                                           # label by period start even if the first minute is missing
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


def median_sizes(cd: Candles, auto: float) -> dict:
    """Median turnover of a 1h, 4h, day, week and month over the last 365 days, counting whole periods only
    (the same UTC periods as the time bars), rounded like auto_size. The day is auto_size; a period the
    market has no whole one of yet (a week-old coin has no whole month) is left out."""
    n = cd.n
    m = cd.ts[:n] >= cd.ts[n - 1] - 365 * DAY
    ts, d = cd.ts[:n][m], cd.d[:n][m]
    out = {"1D": auto}
    for tf in MEDIAN_TFS:
        per = pd.Series(d).groupby(period_start(ts, tf)).sum()
        med = float(per.iloc[1:-1].median()) if len(per) > 2 else 0.0      # drop the two partial periods
        if med > 0:
            out[tf] = float(f"{med:.2g}")
    return out


def sizes_for(auto: float, medians: dict = None) -> list:
    """The menu: the median day and a few multiples either side, plus the other medians, each rounded to two
    significant figures."""
    out = {float(f"{auto * k:.2g}") for k in SIZE_STEPS}
    out.add(auto)
    out.update((medians or {}).values())
    return sorted(s for s in out if s > 0)


def menu_of(cd: Candles) -> dict:
    """The size menu as build_all() puts it in meta: the median day, the other medians and the sizes offered."""
    auto = auto_size(cd)
    medians = median_sizes(cd, auto)
    return {"auto_size": auto, "sizes": sizes_for(auto, medians), "medians": medians}


def nearest_size(sizes: list, want: str, auto: float) -> float:
    """The size the page falls back to when the one it remembered is gone (the page's nearestSize does the same):
    the closest left on a log scale, or the median day when it remembered none."""
    try:
        x = float(want)
    except ValueError:
        x = 0.0
    if not x > 0 or not sizes:
        return auto
    return min(sizes, key=lambda s: abs(np.log(s / x)))


def size_key(size: float) -> str:
    """Must equal the page's 'd:' + size (JS Number#toString): whole dollars without '.0', fractions in
    shortest round-trip form (only markets with a median day under $100 ever have fractional sizes)."""
    return f"d:{int(size)}" if size == int(size) else f"d:{size!r}"


def build_all(cd: Candles) -> tuple[dict, dict]:
    """All bar sets from scratch. Returns (sets, meta)."""
    menu = menu_of(cd)
    auto, medians, sizes = menu["auto_size"], menu["medians"], menu["sizes"]
    sets = {}
    cum = np.cumsum(cd.d[:cd.n])                                 # every dollar set cuts the same running dollars
    day_med = day_medians(cd, int(cd.ts[0] // DAY), int(cd.ts[cd.n - 1] // DAY))
    for s in sizes:
        bars, forming, st = dollar_bars(cd, s, cum=cum)
        sets[size_key(s)] = {"bars": bars, "forming": forming, "start": st, "size": s}
    for k in ADAPTIVE:
        bars, forming, st = adaptive_bars(cd, k, cum=cum, medians=day_med)
        sets[f"a:{k}"] = {"bars": bars, "forming": forming, "start": st, "per_day": k}
    for tf in TIMEFRAMES:
        bars, forming, st = time_bars(cd, tf)
        sets["t:" + tf] = {"bars": bars, "forming": forming, "start": st, "tf": tf}
    meta = {"auto_size": auto, "sizes": sizes, "medians": medians, "adaptive": ADAPTIVE, "timeframes": TIMEFRAMES,
            "first": int(cd.ts[0] // 1000), "last": int(cd.ts[cd.n - 1] // 1000), "n_candles": int(cd.n)}
    cd.touched = cd.n
    return sets, meta


def update_all(sets: dict, cd: Candles) -> None:
    """Recompute only from each set's forming bar onward (cheap; called after every live candle).
    A dollar bar that closed on a candle this upsert rewrote (a minute first seen while still forming) is
    re-cut with the fuller candle, even when later minutes arrived in the same upsert."""
    for key, s in sets.items():
        if key[:2] in ("d:", "a:"):
            while s["bars"] and s["start"] - 1 >= cd.touched:    # its closing candle changed: cut it again
                s["start"] -= s["bars"].pop()["n"]
            if key.startswith("d:"):
                bars, forming, st = dollar_bars(cd, s["size"], s["start"])
            else:
                bars, forming, st = adaptive_bars(cd, s["per_day"], s["start"])
        else:
            bars, forming, st = time_bars(cd, s["tf"], s["start"])
        s["bars"].extend(bars)
        s["forming"], s["start"] = forming, st
    cd.touched = cd.n
