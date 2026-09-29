"""Merge several venues' minute candles into one series: dollars and base volume are summed across venues,
prices come from the highest-priority venue that has the minute. Done in numpy so a BTC-sized merge
(several series of 3-4 million rows) takes seconds and bounded memory."""
import numpy as np
import pandas as pd

import bybit_sync as X

COLS = X.COLS


def merge(frames: list) -> pd.DataFrame:
    """frames in priority order (highest first), each with the app's columns; returns one frame sorted by ts."""
    frames = [f for f in frames if len(f)]
    if not frames:
        return pd.DataFrame(columns=COLS)
    ts = frames[0]["ts"].to_numpy(np.int64)
    px = np.stack([frames[0][c].to_numpy(float) for c in ("open", "high", "low", "close")], axis=1)
    vol = frames[0]["volume"].to_numpy(float).copy()
    dol = frames[0]["turnover"].to_numpy(float).copy()
    for f in frames[1:]:
        t2 = f["ts"].to_numpy(np.int64)
        idx = np.searchsorted(ts, t2)
        inb = idx < len(ts)
        found = np.zeros(len(t2), bool)
        found[inb] = ts[idx[inb]] == t2[inb]
        vol[idx[found]] += f["volume"].to_numpy(float)[found]
        dol[idx[found]] += f["turnover"].to_numpy(float)[found]
        miss = ~found
        if miss.any():                                           # minutes only this venue traded: its prices, its dollars
            ts = np.concatenate([ts, t2[miss]])
            px = np.concatenate([px, np.stack([f[c].to_numpy(float)[miss] for c in ("open", "high", "low", "close")], axis=1)])
            vol = np.concatenate([vol, f["volume"].to_numpy(float)[miss]])
            dol = np.concatenate([dol, f["turnover"].to_numpy(float)[miss]])
            order = np.argsort(ts, kind="stable")
            ts, px, vol, dol = ts[order], px[order], vol[order], dol[order]
    return pd.DataFrame({"ts": ts, "open": px[:, 0], "high": px[:, 1], "low": px[:, 2], "close": px[:, 3], "volume": vol, "turnover": dol})


def merge_rows(row_lists: list) -> list:
    """Same rule for a few live rows per venue (priority order): one row per minute, dollars summed."""
    out = {}
    for rows in row_lists:
        for r in rows:
            cur = out.get(r[0])
            if cur is None:
                out[r[0]] = list(r)
            else:
                cur[5] += r[5]
                cur[6] += r[6]
    return [out[k] for k in sorted(out)]
