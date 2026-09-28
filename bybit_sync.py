"""Keep a local copy of Bybit's BTCUSDT linear-perp 1-minute candles (public v5 kline endpoint, keyless).

Stored in data/bybit_btcusdt_1m.parquet with columns ts (ms, candle open), open, high, low, close,
volume (BTC) and turnover (USDT = the dollars traded in that minute, which is what dollar bars need).
Resumable: re-run to append whatever is missing; the last stored candle is refetched because it may
have been captured while still forming.

Run directly to backfill:  python bybit_sync.py
"""
import json
import os
import sys
import time
import urllib.request
from pathlib import Path

import pandas as pd

HERE = Path(__file__).resolve().parent
PATH = HERE / "data" / "bybit_btcusdt_1m.parquet"
URL = ("https://api.bybit.com/v5/market/kline?category=linear&symbol=BTCUSDT&interval=1&limit=1000"
       "&start={start}&end={end}")
COLS = ["ts", "open", "high", "low", "close", "volume", "turnover"]
FIRST_MS = 1_585_094_400_000          # 2020-03-25, when Bybit's USDT perpetual started trading
MINUTE = 60_000
WINDOW = 1000 * MINUTE                # one request covers 1000 minutes


def fetch(start_ms: int, end_ms: int) -> list:
    """One kline request, returned oldest-first. Retries on transport errors."""
    for attempt in range(6):
        try:
            req = urllib.request.Request(URL.format(start=start_ms, end=end_ms), headers={"User-Agent": "dollar-bars/1"})
            r = json.load(urllib.request.urlopen(req, timeout=20))
            if r.get("retCode") != 0:
                raise RuntimeError(f"bybit retCode {r.get('retCode')}: {r.get('retMsg')}")
            rows = [[int(x[0]), float(x[1]), float(x[2]), float(x[3]), float(x[4]), float(x[5]), float(x[6])]
                    for x in r["result"]["list"]]
            rows.sort()
            return rows
        except Exception:
            if attempt == 5:
                raise
            time.sleep(1.5 * (attempt + 1))
    return []


def load() -> pd.DataFrame:
    return pd.read_parquet(PATH) if PATH.exists() else pd.DataFrame(columns=COLS)


def save(df: pd.DataFrame) -> None:
    """Atomic write: a crash mid-write leaves the old file intact instead of a truncated one."""
    PATH.parent.mkdir(exist_ok=True)
    tmp = PATH.with_suffix(".tmp")
    df.to_parquet(tmp, index=False)
    os.replace(tmp, PATH)


def latest(n: int = 3) -> list:
    """The newest n candles (the last one is still forming). Used by the live poller."""
    req = urllib.request.Request(f"https://api.bybit.com/v5/market/kline?category=linear&symbol=BTCUSDT&interval=1&limit={n}",
                                 headers={"User-Agent": "dollar-bars/1"})
    r = json.load(urllib.request.urlopen(req, timeout=10))
    rows = [[int(x[0]), float(x[1]), float(x[2]), float(x[3]), float(x[4]), float(x[5]), float(x[6])] for x in r["result"]["list"]]
    rows.sort()
    return rows


def sync(progress=None, stop=None, pause: float = 0.05) -> pd.DataFrame:
    """Append everything from the last stored candle to now; returns the full frame."""
    df = load()
    cursor = int(df["ts"].iloc[-1]) if len(df) else FIRST_MS
    new, requests = [], 0
    while True:
        now_ms = int(time.time() * 1000)
        end = cursor + WINDOW - 1
        rows = fetch(cursor, end)
        requests += 1
        if rows:
            new.extend(rows)
            last = rows[-1][0]
            if progress and requests % 25 == 0:
                progress(last, len(new))
            if last >= now_ms - MINUTE:            # reached the forming candle
                break
            cursor = last + MINUTE
        else:
            if end >= now_ms:
                break
            cursor = end + 1                        # a window with no candles (exchange downtime): skip it
        if stop and stop():
            break
        time.sleep(pause)
        if len(new) >= 200_000 and requests % 200 == 0:     # first-run backfill: checkpoint so a closed window loses nothing
            df = merge(df, new); new = []; save(df)
    if new:
        df = merge(df, new)
        save(df)
    return df


def merge(df: pd.DataFrame, new: list) -> pd.DataFrame:
    add = pd.DataFrame(new, columns=COLS)
    df = pd.concat([df[df["ts"] < add["ts"].iloc[0]], add]) if len(df) else add
    return df.drop_duplicates("ts", keep="last").sort_values("ts").reset_index(drop=True)


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    t0 = time.time()

    def show(last_ms, n):
        print(f"  {time.strftime('%Y-%m-%d %H:%M', time.gmtime(last_ms // 1000))}Z  {n:,} candles  {time.time() - t0:5.0f}s", flush=True)

    frame = sync(progress=show)
    print(f"done: {len(frame):,} candles, {time.strftime('%Y-%m-%d %H:%M', time.gmtime(int(frame['ts'].iloc[0]) // 1000))}Z -> "
          f"{time.strftime('%Y-%m-%d %H:%M', time.gmtime(int(frame['ts'].iloc[-1]) // 1000))}Z in {time.time() - t0:.0f}s")
