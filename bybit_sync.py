"""Bybit v5 public kline access (keyless) and the per-market candle files.

A market is "spot:BTCUSDT" or "linear:BTCUSDT" (USDT/USDC perpetual). Each one lives in
data/bybit_<category>_<SYMBOL>.parquet with columns ts (ms, candle open), open, high, low, close,
volume (base coin) and turnover (quote coin = the dollars traded in that minute, which is what
dollar bars need). Backfills stream rows to a callback so the chart can grow while the download
runs, checkpoint every 100 requests, and stop within one request when asked (the app never keeps
downloading after its window is closed; the next launch resumes where it stopped).

Run directly to backfill one market from the command line:  python bybit_sync.py linear:ETHUSDT
"""
import json
import os
import sys
import time
import urllib.request
from pathlib import Path

import pandas as pd

HERE = Path(__file__).resolve().parent
DATA = HERE / "data"
API = "https://api.bybit.com/v5/market/kline"
COLS = ["ts", "open", "high", "low", "close", "volume", "turnover"]
CATEGORIES = ("spot", "linear")
MINUTE = 60_000
WINDOW = 1000 * MINUTE                # one request covers 1000 minutes
UA = {"User-Agent": "dollarbarchart/2"}


def parse(key: str) -> tuple[str, str]:
    """'linear:BTCUSDT' -> ('linear', 'BTCUSDT'); rejects anything that is not a plain category:symbol."""
    category, _, symbol = key.partition(":")
    if category not in CATEGORIES or not symbol or not symbol.isalnum() or symbol != symbol.upper():
        raise ValueError(f"bad market key {key!r}")
    return category, symbol


def path(key: str) -> Path:
    category, symbol = parse(key)
    return DATA / f"bybit_{category}_{symbol}.parquet"


def kline(category: str, symbol: str, interval: str = "1", start_ms=None, end_ms=None, limit: int = 1000,
          attempts: int = 6, timeout: float = 20, stop=None) -> list:
    """One kline request, rows oldest-first as [ts, o, h, l, c, volume, turnover]. Retries transport errors
    (not when stop() asks to quit)."""
    url = f"{API}?category={category}&symbol={symbol}&interval={interval}&limit={limit}"
    if start_ms is not None:
        url += f"&start={int(start_ms)}"
    if end_ms is not None:
        url += f"&end={int(end_ms)}"
    for attempt in range(attempts):
        try:
            r = json.load(urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=timeout))
            code = r.get("retCode")
            if code == 10001:                                    # parameter error (unknown symbol...): retrying will not help
                raise LookupError(f"bybit: {r.get('retMsg')} ({url})")
            if code != 0:                                        # 10016 "svc error", 10006 rate limit...: transient, retry
                raise RuntimeError(f"bybit retCode {code}: {r.get('retMsg')}")
            rows = [[int(x[0]), float(x[1]), float(x[2]), float(x[3]), float(x[4]), float(x[5]), float(x[6])]
                    for x in r["result"]["list"]]
            rows.sort()
            return rows
        except LookupError:
            raise
        except Exception:
            if attempt == attempts - 1 or (stop and stop()):
                raise
            time.sleep(1.5 * (attempt + 1))
    return []


def fetch(key: str, start_ms: int, end_ms: int, stop=None) -> list:
    category, symbol = parse(key)
    return kline(category, symbol, "1", start_ms, end_ms, stop=stop)


def latest(key: str, n: int = 3) -> list:
    """The newest n candles (the last one is still forming). Used by the live poller."""
    category, symbol = parse(key)
    return kline(category, symbol, "1", limit=n)


def first_candle_ms(key: str, quick: bool = False):
    """Open time of the market's first weekly candle (one request: 1000 weeks covers any listing), or None
    when Bybit has no candles for it. The 1-minute backfill starts there; the first minutes of the week
    that precede the first trade are just empty windows. quick = one short attempt (interactive callers)."""
    category, symbol = parse(key)
    rows = kline(category, symbol, "W", limit=1000, attempts=1 if quick else 6, timeout=5 if quick else 20)
    return rows[0][0] if rows else None


def load(key: str) -> pd.DataFrame:
    p = path(key)
    return pd.read_parquet(p) if p.exists() else pd.DataFrame(columns=COLS)


def save(key: str, df: pd.DataFrame) -> None:
    """Atomic write: a crash mid-write leaves the old file intact instead of a truncated one."""
    p = path(key)
    p.parent.mkdir(exist_ok=True)
    tmp = p.with_suffix(".tmp")
    df.to_parquet(tmp, index=False)
    os.replace(tmp, p)


def sync(key: str, on_rows, cursor_ms: int, stop=None, checkpoint=None, pause: float = 0.05) -> str:
    """Stream 1-minute candles from cursor_ms up to now into on_rows(rows), oldest first.

    Returns "done" once the forming candle is reached, or "stopped" when stop() asked to quit (the caller
    keeps what it received; the next sync resumes from its last candle, which is refetched because it may
    have been forming). checkpoint(requests) is called every 100 requests so the caller can persist.
    """
    cursor, requests = int(cursor_ms), 0
    while True:
        if stop and stop():
            return "stopped"
        now_ms = int(time.time() * 1000)
        end = cursor + WINDOW - 1
        rows = fetch(key, cursor, end, stop=stop)
        requests += 1
        if rows:
            on_rows(rows)
            last = rows[-1][0]
            if last >= now_ms - MINUTE:                          # reached the forming candle
                return "done"
            cursor = last + MINUTE
        else:
            if end >= now_ms:
                return "done"
            cursor = end + 1                                     # a window with no candles (pre-listing, downtime): skip it
        if checkpoint and requests % 100 == 0:
            checkpoint(requests)
        time.sleep(pause)


def merge(df: pd.DataFrame, new: list) -> pd.DataFrame:
    add = pd.DataFrame(new, columns=COLS)
    df = pd.concat([df[df["ts"] < add["ts"].iloc[0]], add]) if len(df) else add
    return df.drop_duplicates("ts", keep="last").sort_values("ts").reset_index(drop=True)


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    market = sys.argv[1] if len(sys.argv) > 1 else "linear:BTCUSDT"
    t0 = time.time()
    frame = load(market)
    start = int(frame["ts"].iloc[-1]) if len(frame) else first_candle_ms(market)
    if start is None:
        sys.exit(f"{market}: Bybit has no candles for this market")
    got = []

    def take(rows):
        got.extend(rows)
        if len(got) % 50_000 < 1000:
            print(f"  {time.strftime('%Y-%m-%d %H:%M', time.gmtime(rows[-1][0] // 1000))}Z  {len(got):,} candles  {time.time() - t0:5.0f}s", flush=True)

    def flush(_requests):
        global frame, got
        if got:
            frame = merge(frame, got); got = []; save(market, frame)

    sync(market, take, start, checkpoint=flush)
    flush(0)
    print(f"done: {market} {len(frame):,} candles, {time.strftime('%Y-%m-%d %H:%M', time.gmtime(int(frame['ts'].iloc[0]) // 1000))}Z -> "
          f"{time.strftime('%Y-%m-%d %H:%M', time.gmtime(int(frame['ts'].iloc[-1]) // 1000))}Z in {time.time() - t0:.0f}s")
