"""Merge several venues' minute candles into one series.

Dollars and base volume are summed across venues. Each price (open, high, low, close) is the dollar-weighted
median of the venues that traded that minute: the price where half the minute's dollars traded at or below
it. One venue's bad print (a thin book's wick, a stale feed) cannot move it unless that venue carried half
the money, and a dominant venue counts for what it traded. Minutes nobody traded in take the prices of the
first frame that has them (frames come in priority order). Done in numpy, in chunks of minutes, so a BTC-sized
merge (ten series of several million rows) takes seconds and bounded memory.

despike() repairs the merged prices no second exchange confirms: a minute whose price is SPIKE times away from
the median close of the minutes before it and of those after it, shown by only one exchange (the only one trading then, like Bitfinex's
BTC trades at $0.01 in April 2013, or one holding most of the say). Market-wide moves, which every exchange
shows, are kept. A minute only one exchange traded, while a bigger exchange (more say) traded within LONE_SPAN
minutes of it, is held closer: LONE_BAND beyond the other exchanges' lowest low and highest high around it
(Kraken's thin 2014 BTC/USD book printed $295 while the market was at $400).

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
RELIST_GAP = 14 * DAY                                            # a hole this long may be a delisting and a listing again ...
RELIST_MOVE = 2.0                                                # ... it is, when the price across it moved more than this (no reference to ask)
MISMATCH = 0.30                                                  # a day whose close is this far from the reference's is another coin
MISMATCH_DAYS, MISMATCH_SPAN = 3, 30 * DAY                       # ... once this many such days fall within this span
WEIGHT_SPAN = DAY                                                # an exchange's say in a minute's price: its dollars over the day before
METHOD = 4                                                       # the merge rule's version (a cached merge made by another is redone)
SPIKE = 2.0                                                      # a merged price above SPIKE x (or below 1/SPIKE x) the median close ...
SPIKE_ROWS = 30                                                  # ... of this many merged minutes either side is an off-price print ...
CONFIRM = 2                                                      # ... unless this many exchanges show such a price within a minute of it
MINUTE = 60_000
LONE_SPAN = 5                                                    # minutes either side: a minute only one thinner exchange traded ...
LONE_BAND = 0.03                                                 # ... may print this far beyond the bigger ones' range there
LONE_RATIO = 3.0                                                 # bigger = this many times its dollars over the day before
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


def trailing_dollars(ts: np.ndarray, dollars: np.ndarray) -> np.ndarray:
    """Each minute's dollars of the WEIGHT_SPAN before it, not counting the minute itself."""
    cum = np.concatenate([[0.0], np.cumsum(dollars)])
    return cum[np.arange(len(ts))] - cum[np.searchsorted(ts, ts - WEIGHT_SPAN, side="left")]


def merge(frames: list, since=None, weights=None) -> pd.DataFrame:
    """frames in priority order, each with the app's columns, sorted by ts; returns one frame sorted by ts.
    since = only minutes at or after this time (the tail after a cached merge).
    Dollars and volume are summed. Each of open/high/low/close is the median of the exchanges that traded in the
    minute, each weighted by its dollars over the day before (weights = one fixed number per frame instead, for a
    few live rows): the way price indexes weight their exchanges. A big trade far off the price on a nearly dead
    market (Bitfinex ZEC sold 3,500 ZEC at $46 with the market at $67 on 2025-09-29) has almost no say, where
    weighting by the minute's own dollars let it outvote Binance. A candle without trades has no say at all."""
    parts = []
    for j, f in enumerate(frames):
        if not len(f):
            continue
        ts = f["ts"].to_numpy(np.int64)
        dol = f["turnover"].to_numpy(float)
        say = trailing_dollars(ts, np.maximum(dol, 0.0)) if weights is None else np.full(len(ts), float(weights[j]))
        say = np.where(dol > 0, say, 0.0)
        lo = int(np.searchsorted(ts, since)) if since is not None else 0
        if lo >= len(ts):
            continue
        parts.append((ts[lo:], np.stack([f[c].to_numpy(float)[lo:] for c in PX], axis=1),
                      f["volume"].to_numpy(float)[lo:], dol[lo:], say[lo:]))
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
        W0 = np.zeros((b - a, k))                                # the minute's own dollars: the say when no one has a day behind it
        for j, (p, ps) in enumerate(zip(parts, pos)):
            i0, i1 = np.searchsorted(ps, [a, b])
            rel = ps[i0:i1] - a
            P[rel, j, :] = p[1][i0:i1]
            W[rel, j] = p[4][i0:i1]
            W0[rel, j] = np.maximum(p[3][i0:i1], 0.0)
            vol[a + rel] += p[2][i0:i1]
            dol[a + rel] += p[3][i0:i1]
        fresh = ~(W.sum(axis=1) > 0)
        W[fresh] = W0[fresh]
        for c in range(4):
            px[a:b, c] = weighted_median(P[:, :, c], W)
    px[:, 1] = np.maximum(px[:, 1], px[:, [0, 3]].max(axis=1))  # medians keep the order of each venue's own o/h/l/c,
    px[:, 2] = np.minimum(px[:, 2], px[:, [0, 3]].min(axis=1))  # this only guards float noise
    return pd.DataFrame({"ts": u, "open": px[:, 0], "high": px[:, 1], "low": px[:, 2], "close": px[:, 3], "volume": vol, "turnover": dol})


def merge_rows(row_lists: list, weights=None) -> list:
    """Same rule for a few live rows per venue (priority order): one row per minute. weights = each venue's
    dollars over the last day (the say it has in the price; None = weigh by the rows' own dollars)."""
    keep = [i for i, rows in enumerate(row_lists) if rows]
    frames = [pd.DataFrame(sorted(row_lists[i]), columns=COLS) for i in keep]
    out = merge(frames, weights=[weights[i] for i in keep]) if weights is not None else _merge_by_rows(frames)
    return [[int(r[0])] + [float(x) for x in r[1:]] for r in out.itertuples(index=False)]


def _merge_by_rows(frames: list) -> pd.DataFrame:
    """A few rows without known weights: each venue weighs its own dollars of these rows."""
    return merge(frames, weights=[max(float(f["turnover"].clip(lower=0).sum()), 0.0) for f in frames])


def spike_refs(close: np.ndarray) -> tuple:
    """(median close of the SPIKE_ROWS minutes before each minute, of the SPIKE_ROWS after it); NaN where there are none."""
    s = pd.Series(close)
    back = s.rolling(SPIKE_ROWS, min_periods=1).median().shift(1).to_numpy()
    fwd = s[::-1].reset_index(drop=True).rolling(SPIKE_ROWS, min_periods=1).median().shift(1).to_numpy()[::-1]
    return back, fwd


def lone_bands(ts: np.ndarray, frames: list, start: int = 0, weights=None) -> tuple:
    """(low, high) limits for the merged minutes ts[start:] that a single exchange traded while one with more say
    (LONE_RATIO times its dollars over the day before, or weights) traded within LONE_SPAN minutes: the other
    exchanges' lowest low and highest high in that span, LONE_BAND wider. NaN elsewhere; for the newest LONE_SPAN
    minutes (the minutes after them have not arrived yet: they are checked when the merge is redone); and, without
    weights, where either exchange has less than a day behind it (no say to compare yet: ZEC's launch week)."""
    t = ts[start:]
    m = len(t)
    lo_b, hi_b = np.full(m, np.nan), np.full(m, np.nan)
    if not m or len(frames) < 2:
        return lo_b, hi_b
    cnt, who, tr = np.zeros(m, np.int32), np.full(m, -1, np.int32), []
    for j, f in enumerate(frames):
        sd = f["turnover"].to_numpy(float)
        ok = sd > 0
        sts = f["ts"].to_numpy(np.int64)[ok]
        tr.append((sts, f["high"].to_numpy(float)[ok], f["low"].to_numpy(float)[ok], np.concatenate([[0.0], np.cumsum(sd[ok])])))
        k = np.searchsorted(t, sts)
        hit = k < m
        hit[hit] = t[k[hit]] == sts[hit]
        cnt[k[hit]] += 1
        who[k[hit]] = j
    lone = np.flatnonzero((cnt == 1) & (t <= ts[-1] - LONE_SPAN * MINUTE))
    if not len(lone):
        return lo_b, hi_b
    tl, wl = t[lone], who[lone]

    def say(j: int, at: np.ndarray) -> np.ndarray:
        """Its dollars over the day before; NaN while it has less than a day behind it."""
        if weights is not None:
            return np.full(len(at), float(weights[j]))
        sts, cum = tr[j][0], tr[j][3]
        if not len(sts):
            return np.full(len(at), np.nan)
        out = cum[np.searchsorted(sts, at)] - cum[np.searchsorted(sts, at - WEIGHT_SPAN)]
        return np.where(at - WEIGHT_SPAN >= sts[0], out, np.nan)

    own = np.zeros(len(lone))
    for j in range(len(frames)):
        sel = wl == j
        if sel.any():
            own[sel] = say(j, tl[sel])
    o_lo, o_hi, bigger = np.full(len(lone), np.inf), np.full(len(lone), -np.inf), np.zeros(len(lone), bool)
    for j, (sts, hi, lo, _) in enumerate(tr):
        a = np.searchsorted(sts, tl - LONE_SPAN * MINUTE)
        b = np.searchsorted(sts, tl + LONE_SPAN * MINUTE, side="right")
        near = (b > a) & (wl != j)
        if not near.any():
            continue
        for o in range(int((b - a)[near].max())):
            idx = a + o
            v = near & (idx < b)
            o_lo[v] = np.minimum(o_lo[v], lo[idx[v]])
            o_hi[v] = np.maximum(o_hi[v], hi[idx[v]])
        with np.errstate(invalid="ignore"):
            bigger |= near & (say(j, tl) > own * LONE_RATIO)          # (NaN on either side: not bigger)
    use = bigger & np.isfinite(o_lo) & np.isfinite(o_hi)
    lo_b[lone[use]] = o_lo[use] * (1 - LONE_BAND)
    hi_b[lone[use]] = o_hi[use] * (1 + LONE_BAND)
    return lo_b, hi_b


def despike(merged: pd.DataFrame, frames: list, start: int = 0, ref=None, weights=None) -> tuple:
    """Repair the off-price prints in merged rows start.. that no second exchange confirms. Returns (frame, number
    of minutes repaired). frames = the merge's input (priority order); ref = one reference price per row from
    start on (default: the median close of the SPIKE_ROWS merged minutes before each and of the SPIKE_ROWS after
    it, spike_refs, with the rows before start as context); weights = one say per frame (default: each exchange's
    dollars over the day before the minute).
    A price is a bad print when it is SPIKE times below (above) the minutes before it AND the minutes after it: a
    step to a new price level (sparse early history, a listing) is near one side and stays. It stands anyway when
    CONFIRM exchanges that traded within a minute of it went that far the same way (a crash every exchange shows).
    A minute only one exchange traded is held to lone_bands() where a bigger exchange traded around it.
    Otherwise it takes the dollar-weighted median of the exchanges whose price there is not a bad print, and when
    there is none (the only exchange trading then): the open becomes the previous close, the close the open, and
    the high and low the candle's body."""
    n = len(merged)
    if start >= n or not len(frames):
        return merged, 0
    ts = merged["ts"].to_numpy(np.int64)
    px = merged[list(PX)].to_numpy(float)
    if ref is None:
        lo = max(0, start - SPIKE_ROWS)
        back, fwd = spike_refs(px[lo:, 3])
        back, fwd = back[start - lo:], fwd[start - lo:]
    else:
        back = fwd = np.asarray(ref, float)
    with np.errstate(invalid="ignore"):
        low_b = np.fmin(back, fwd) / SPIKE                      # NaN only where neither side has minutes
        high_b = np.fmax(back, fwd) * SPIKE
        center = np.where(np.isnan(back), fwd, back)
        l_lo, l_hi = lone_bands(ts, frames, start, weights)
        low_b, high_b = np.fmax(low_b, l_lo), np.fmin(high_b, l_hi)   # (fmax/fmin skip the NaN of the other)
        center = np.where(center < low_b, low_b, np.where(center > high_b, high_b, center))
        seg = px[start:]
        bad = (seg < low_b[:, None]) | (seg > high_b[:, None])
    rows = np.flatnonzero(bad.any(axis=1))
    if not len(rows):
        return merged, 0
    src = [(f["ts"].to_numpy(np.int64), f[list(PX)].to_numpy(float), f["turnover"].to_numpy(float)) for f in frames]
    cums = {}

    def say(j: int, t: int) -> float:
        if weights is not None:
            return float(weights[j])
        if j not in cums:
            cums[j] = np.concatenate([[0.0], np.cumsum(np.maximum(src[j][2], 0.0))])
        sts, cum = src[j][0], cums[j]
        return float(cum[np.searchsorted(sts, t)] - cum[np.searchsorted(sts, t - WEIGHT_SPAN)])

    px = px.copy()
    fixed = 0
    for r in rows:                                               # oldest first: a repaired close is the next open's fallback
        i, t = start + int(r), int(ts[start + int(r)])
        lo_b, hi_b = low_b[r], high_b[r]
        new, lone = px[i].copy(), []
        for c in range(4):
            x = px[i, c]
            if not (x < lo_b or x > hi_b):
                continue
            down, confirm, vals, ws, own = x < lo_b, 0, [], [], []
            for j, (sts, spx, sd) in enumerate(src):
                a, b = np.searchsorted(sts, [t - MINUTE, t + MINUTE + 1])
                if a == b:
                    continue
                traded = sd[a:b] > 0
                if not traded.any():
                    continue
                near = spx[a:b, c][traded]
                if (near.min() < lo_b) if down else (near.max() > hi_b):
                    confirm += 1
                k = int(np.searchsorted(sts, t))
                if k < len(sts) and sts[k] == t and sd[k] > 0 and lo_b <= spx[k, c] <= hi_b:
                    vals.append(spx[k, c])
                    ws.append(say(j, t))
                    own.append(sd[k])
            if confirm >= CONFIRM:
                continue
            if vals:
                w = np.asarray(ws)
                w = w if w.sum() > 0 else np.asarray(own)                # nobody has a day behind it: the minute's dollars, as merge()
                new[c] = weighted_median(np.asarray(vals)[None, :], w[None, :])[0]
            else:
                lone.append(c)
        if 0 in lone:
            prev = px[i - 1, 3] if i > 0 else np.nan
            new[0] = prev if lo_b <= prev <= hi_b else center[r]
        if 3 in lone:
            new[3] = new[0] if lo_b <= new[0] <= hi_b else center[r]
        if 1 in lone:
            new[1] = max(new[0], new[3])
        if 2 in lone:
            new[2] = min(new[0], new[3])
        new[1] = max(new[1], new[0], new[3])
        new[2] = min(new[2], new[0], new[3])
        if not np.array_equal(new, px[i]):
            px[i] = new
            fixed += 1
    if not fixed:
        return merged, 0
    out = merged.copy()
    out[list(PX)] = px
    return out, fixed


def despike_rows(rows: list, row_lists: list, weights: list, ref: float) -> list:
    """despike() for a few live merged rows: row_lists = each exchange's newest rows (the merge's input), ref =
    the chart's recent median close."""
    if not rows or not ref > 0:
        return rows
    merged = pd.DataFrame(rows, columns=COLS)
    frames = [pd.DataFrame(sorted(r), columns=COLS) if r else _empty() for r in row_lists]
    out, fixed = despike(merged, frames, ref=np.full(len(merged), float(ref)), weights=weights)
    if not fixed:
        return rows
    return [[int(r[0])] + [float(x) for x in r[1:]] for r in out.itertuples(index=False)]


def daily_close(f: pd.DataFrame) -> pd.Series:
    """The median minute close of each UTC day (a thin venue's last trade of the day can be hours old)."""
    if not len(f):
        return pd.Series(dtype=float)
    return f.groupby(f["ts"].to_numpy(np.int64) // DAY * DAY)["close"].median()


def trust(f: pd.DataFrame, ref_daily=None, jumps: bool = True) -> pd.DataFrame:
    """The part of a venue's series that is the same coin as the reference:
    - nothing before a relisting: a hole of RELIST_GAP or more without a candle across which the price does not
      carry on (it moved unlike the reference over the same days, by more than MISMATCH; with no reference
      there, by more than RELIST_MOVE times). Exchanges also just lack data for weeks (Bitfinex has no BTC
      minutes for April-May 2016): the history before such a hole is kept;
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
    mine = daily_close(f)
    cut = None
    holes = np.flatnonzero(np.diff(ts) > RELIST_GAP)
    for g in holes[::-1]:                                        # the newest hole that is a relisting cuts
        before, after = int(ts[g]) // DAY * DAY, int(ts[g + 1]) // DAY * DAY
        r = mine.loc[after] / mine.loc[before]
        if ref_daily is not None and before in ref_daily.index and after in ref_daily.index:
            moved_alike = abs(np.log(r * ref_daily.loc[before] / ref_daily.loc[after])) <= np.log(1 + MISMATCH)
        else:
            moved_alike = 1 / RELIST_MOVE <= r <= RELIST_MOVE
        if not moved_alike:
            cut = int(ts[g + 1])
            break
    if jumps and len(mine) > 1:
        days, px = mine.index.to_numpy(np.int64), mine.to_numpy(float)
        step = px[1:] / px[:-1]
        across = {int(ts[g + 1]) // DAY * DAY for g in holes}    # the first day after a long hole: judged above
        for i in np.flatnonzero((step > JUMP) | (step < 1 / JUMP)):
            before, day, r = int(days[i]), int(days[i + 1]), step[i]   # (before = the venue's previous day: holes happen)
            if day in across:
                continue
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
