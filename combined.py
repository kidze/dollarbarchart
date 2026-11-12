"""Merge several venues' minute candles into one series.

Dollars and base volume are summed across venues. Each price (open, high, low, close) is the dollar-weighted
median of the venues that traded that minute: the price where half the minute's dollars traded at or below
it. One venue's bad print (a thin book's wick, a stale feed) cannot move it unless that venue carried half
the money, and a dominant venue counts for what it traded. Minutes nobody traded in take the prices of the
first frame that has them (frames come in priority order). Done in numpy, in chunks of minutes, so a BTC-sized
merge (ten series of several million rows) takes seconds and bounded memory.

trust() decides how much of a venue's history belongs to the coin the app means by a ticker: an exchange
can reuse a ticker for another coin, or relist one after a long break.
"""
import numpy as np
import pandas as pd

import bybit_sync as X

COLS = X.COLS
PX = ("open", "high", "low", "close")
DAY = 86_400_000
CHUNK = 250_000
RELIST_GAP = 14 * DAY                                            # a hole this long = delisted and listed again: keep what follows it
MISMATCH = 0.30                                                  # a day whose close is this far from the reference's is another coin
MISMATCH_DAYS, MISMATCH_SPAN = 3, 30 * DAY                       # ... once this many such days fall within this span
JUMP = 4.0                                                       # a day whose price is this many times the day before's: another coin took the symbol


def _empty() -> pd.DataFrame:
    return pd.DataFrame({c: pd.Series(dtype="int64" if c == "ts" else "float64") for c in COLS})


def weighted_median(vals: np.ndarray, w: np.ndarray) -> np.ndarray:
    """Row-wise dollar-weighted median of vals (rows x venues, NaN = venue absent) with weights w (0 where absent).
    Rows with no weight at all fall back to the first non-NaN value."""
    v = np.where(np.isnan(vals), np.inf, vals)
    order = np.argsort(v, axis=1, kind="stable")
    sv = np.take_along_axis(v, order, 1)
    sw = np.take_along_axis(np.where(np.isnan(vals), 0.0, w), order, 1)
    cw = np.cumsum(sw, axis=1)
    total = cw[:, -1]
    j = np.argmax(cw >= total[:, None] / 2, axis=1)
    out = sv[np.arange(len(sv)), j]
    none = ~(total > 0)
    if none.any():
        first = np.argmax(~np.isnan(vals[none]), axis=1)
        out[none] = vals[none][np.arange(none.sum()), first]
    return out


def merge(frames: list, since=None) -> pd.DataFrame:
    """frames in priority order, each with the app's columns, sorted by ts; returns one frame sorted by ts.
    since = only minutes at or after this time (the tail after a cached merge)."""
    parts = []
    for f in frames:
        if not len(f):
            continue
        ts = f["ts"].to_numpy(np.int64)
        lo = int(np.searchsorted(ts, since)) if since is not None else 0
        if lo >= len(ts):
            continue
        parts.append((ts[lo:], np.stack([f[c].to_numpy(float)[lo:] for c in PX], axis=1),
                      f["volume"].to_numpy(float)[lo:], f["turnover"].to_numpy(float)[lo:]))
    if not parts:
        return _empty()
    u = np.unique(np.concatenate([p[0] for p in parts]))
    n, k = len(u), len(parts)
    px = np.empty((n, 4))
    vol = np.zeros(n)
    dol = np.zeros(n)
    pos = [np.searchsorted(u, p[0]) for p in parts]
    for a in range(0, n, CHUNK):
        b = min(n, a + CHUNK)
        P = np.full((b - a, k, 4), np.nan)
        W = np.zeros((b - a, k))
        for j, (p, ps) in enumerate(zip(parts, pos)):
            i0, i1 = np.searchsorted(ps, [a, b])
            rel = ps[i0:i1] - a
            P[rel, j, :] = p[1][i0:i1]
            W[rel, j] = np.maximum(p[3][i0:i1], 0.0)
            vol[a + rel] += p[2][i0:i1]
            dol[a + rel] += p[3][i0:i1]
        for c in range(4):
            px[a:b, c] = weighted_median(P[:, :, c], W)
    px[:, 1] = np.maximum(px[:, 1], px[:, [0, 3]].max(axis=1))  # medians keep the order of each venue's own o/h/l/c,
    px[:, 2] = np.minimum(px[:, 2], px[:, [0, 3]].min(axis=1))  # this only guards float noise
    return pd.DataFrame({"ts": u, "open": px[:, 0], "high": px[:, 1], "low": px[:, 2], "close": px[:, 3], "volume": vol, "turnover": dol})


def merge_rows(row_lists: list) -> list:
    """Same rule for a few live rows per venue (priority order): one row per minute."""
    frames = [pd.DataFrame(sorted(rows), columns=COLS) for rows in row_lists if rows]
    out = merge(frames)
    return [[int(r[0])] + [float(x) for x in r[1:]] for r in out.itertuples(index=False)]


def daily_close(f: pd.DataFrame) -> pd.Series:
    """The median minute close of each UTC day (a thin venue's last trade of the day can be hours old)."""
    if not len(f):
        return pd.Series(dtype=float)
    return f.groupby(f["ts"].to_numpy(np.int64) // DAY * DAY)["close"].median()


def trust(f: pd.DataFrame, ref_daily=None, jumps: bool = True) -> pd.DataFrame:
    """The part of a venue's series that is the same coin as the reference:
    - nothing before a relisting gap (RELIST_GAP without a candle);
    - nothing up to and including a day whose price is JUMP times (or 1/JUMP) the venue's previous day with
      candles, unless the reference moved the same way over the same days: exchanges hand a symbol to a new
      coin without a gap (Binance's LITUSDT perp was Litentry until 2025-12-23, then Lighter at 6x the price;
      PUMPUSDT changed coins on 2025-07-10 at a tenth);
    - nothing up to the end of the last run of MISMATCH_DAYS days within MISMATCH_SPAN whose prices are more than
      MISMATCH away from the reference's (another coin under the same ticker, or a redenomination); scattered
      wild days of a thin venue are not a run.
    Days the reference does not cover are otherwise kept. jumps=False for the reference itself."""
    if not len(f):
        return f
    ts = f["ts"].to_numpy(np.int64)
    gaps = np.flatnonzero(np.diff(ts) > RELIST_GAP)
    cut = int(ts[gaps[-1] + 1]) if len(gaps) else None
    mine = daily_close(f)
    if jumps and len(mine) > 1:
        days, px = mine.index.to_numpy(np.int64), mine.to_numpy(float)
        step = px[1:] / px[:-1]
        for i in np.flatnonzero((step > JUMP) | (step < 1 / JUMP)):
            before, day, r = int(days[i]), int(days[i + 1]), step[i]   # (before = the venue's previous day: holes happen)
            if ref_daily is not None and day in ref_daily.index and before in ref_daily.index:
                rr = ref_daily.loc[day] / ref_daily.loc[before]
                if (rr > 2) == (r > 1) and (rr > 2 or rr < 0.5):  # the reference made the same move: a real one
                    continue
            cut = max(cut or 0, day + DAY)
    if ref_daily is not None and len(ref_daily):
        common = mine.index.intersection(ref_daily.index)
        if len(common):
            ratio = (mine.loc[common] / ref_daily.loc[common]).to_numpy()
            bad = np.sort(common[np.abs(ratio - 1) > MISMATCH].to_numpy(np.int64))
            k = MISMATCH_DAYS - 1
            runs = np.flatnonzero(bad[k:] - bad[:len(bad) - k] <= MISMATCH_SPAN) + k if len(bad) > k else []
            if len(runs):                                        # the newest run's last day
                after = int(bad[runs[-1]]) + DAY
                cut = after if cut is None else max(cut, after)
    if cut is None:
        return f
    return f[f["ts"] >= cut].reset_index(drop=True)
