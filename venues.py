"""Other exchanges' public 1-minute candles, for the combined "ALL venues" market.

Every adapter turns a venue's own kline format into the app's rows [ts (ms, minute open), open, high, low,
close, volume (base coin), dollars]. OKX and KuCoin report quote-currency turnover, so their dollars are
exact; Coinbase and Bitfinex only report base volume, so dollars = volume x close, which at one minute is
as true as it needs to be. Each series lives in data/<venue>_<SYMBOL>.parquet with a sidecar .json that
remembers whether the history side is complete.

Forward venues page from the first candle towards now in fixed windows (Coinbase 300 rows, KuCoin 1500,
Bitfinex 10000). OKX only pages backwards ("after" = older than), so its tail is walked from now back to
the newest stored candle and its history from the oldest stored candle back to the listing. Every sync is
resumable and stops within one request when asked, like bybit_sync. Bybit itself is wrapped here too so
the combined market treats all its parts alike.
"""
import json
import os
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

import pandas as pd

import bybit_sync as X

DATA = X.DATA
COLS = X.COLS
MINUTE = X.MINUTE
UA = X.UA
STABLE = {"USD", "USDT", "USDC", "UST"}                        # quotes that count as dollars
FLUSH_ROWS = 100_000                                             # rows held in memory before the parquet is rewritten
FLUSH_REQUESTS = 200


def _get(url: str, timeout: float = 20, attempts: int = 6, stop=None):
    """GET JSON. A 4xx that is not a rate limit (or Bitfinex's 500 "error" body) = LookupError: bad symbol or
    range, do not retry. Everything else is retried with a growing pause."""
    for attempt in range(attempts):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=timeout) as r:
                return json.load(r)
        except urllib.error.HTTPError as e:
            body = ""
            try:
                body = e.read(200).decode("utf-8", "replace")
            except Exception:
                pass
            if (400 <= e.code < 500 and e.code not in (408, 425, 429)) or (e.code == 500 and body.startswith('["error"')):
                raise LookupError(f"HTTP {e.code} {body[:80]}")
            if attempt == attempts - 1 or (stop and stop()):
                raise
            time.sleep(2.0 * (attempt + 1))
        except LookupError:
            raise
        except Exception:
            if attempt == attempts - 1 or (stop and stop()):
                raise
            time.sleep(1.5 * (attempt + 1))
    return None


def _iso(ms: int) -> str:
    return datetime.fromtimestamp(ms / 1000, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _minute(ms) -> int:
    return int(ms) // MINUTE * MINUTE


class Venue:
    name = ""
    title = ""
    window = 0                                                   # minutes per forward request (forward venues)
    limit = 0                                                    # rows per backwards request (reverse venues)
    pause = 0.2                                                  # seconds between requests
    reverse = False
    exact_dollars = True                                         # False = dollars approximated as volume x close
    quotes = ("USDT", "USDC", "USD")                             # preferred quote first

    def instruments(self) -> list:                               # [{"symbol", "base", "quote", "kind", "list_ms"}]
        raise NotImplementedError

    def first_ms(self, symbol: str):                             # forward venues: open time of the first daily candle
        raise NotImplementedError

    def fetch(self, symbol: str, start_ms: int, end_ms: int, stop=None) -> list:   # forward venues, rows ascending
        raise NotImplementedError

    def fetch_before(self, symbol: str, ts_ms: int, stop=None) -> list:            # reverse venues: rows older than ts, ascending
        raise NotImplementedError

    def latest(self, symbol: str, n: int = 3) -> list:
        raise NotImplementedError


# ---------------------------------------------------------------- OKX (quote volume, pages backwards, BTC 1m since 2018)

class OKX(Venue):
    name = "okx"
    title = "OKX"
    reverse = True
    limit = 300                                                  # the docs say 100, the endpoint honours 300 (checked 2026-09-29)
    pause = 0.15                                                 # 20 req / 2 s documented
    API = "https://www.okx.com/api/v5"

    def instruments(self) -> list:
        out = []
        for inst_type, kind in (("SPOT", "spot"), ("SWAP", "perp")):
            r = _get(f"{self.API}/public/instruments?instType={inst_type}")
            for it in r.get("data", []):
                if it.get("state") != "live":
                    continue
                if kind == "spot":
                    base, quote = it["baseCcy"], it["quoteCcy"]
                else:
                    if it.get("ctType") != "linear":
                        continue
                    base, quote = it["ctValCcy"], it["settleCcy"]
                if quote not in STABLE:
                    continue
                out.append({"symbol": it["instId"], "base": base, "quote": quote, "kind": kind, "list_ms": int(it.get("listTime") or 0)})
        return out

    @staticmethod
    def _rows(data: list, symbol: str) -> list:                 # [ts, o, h, l, c, vol, volCcy, volCcyQuote, confirm]
        swap = symbol.endswith("-SWAP")
        rows = []
        for x in data:
            base_vol = float(x[6]) if swap else float(x[5])      # SWAP: vol = contracts, volCcy = coins; SPOT: vol = coins
            rows.append([_minute(x[0]), float(x[1]), float(x[2]), float(x[3]), float(x[4]), base_vol, float(x[7])])
        rows.sort()
        return rows

    @staticmethod
    def _check(r: dict) -> list:
        if r.get("code") not in ("0", 0):
            if str(r.get("code")) in ("51000", "51001"):        # parameter error / instrument does not exist
                raise LookupError(f"okx: {r.get('msg')}")
            raise RuntimeError(f"okx code {r.get('code')}: {r.get('msg')}")
        return r.get("data", [])

    def fetch_before(self, symbol: str, ts_ms: int, stop=None) -> list:
        r = _get(f"{self.API}/market/history-candles?instId={symbol}&bar=1m&after={int(ts_ms)}&limit={self.limit}", stop=stop)
        return self._rows(self._check(r), symbol)

    def latest(self, symbol: str, n: int = 3) -> list:
        r = _get(f"{self.API}/market/candles?instId={symbol}&bar=1m&limit={n}", timeout=10, attempts=1)
        return self._rows(self._check(r), symbol)


# ---------------------------------------------------------------- KuCoin (quote turnover, forward, BTC 1m since 2018-01)

class KuCoin(Venue):
    name = "kucoin"
    title = "KuCoin"
    window = 1500
    pause = 0.2
    API = "https://api.kucoin.com/api"

    def instruments(self) -> list:
        r = _get(f"{self.API}/v2/symbols")
        out = []
        for it in r.get("data", []):
            if not it.get("enableTrading") or it.get("quoteCurrency") not in STABLE:
                continue
            out.append({"symbol": it["symbol"], "base": it["baseCurrency"], "quote": it["quoteCurrency"], "kind": "spot", "list_ms": 0})
        return out

    @staticmethod
    def _rows(data: list) -> list:                              # [time s, open, close, high, low, volume, turnover]
        rows = [[int(x[0]) * 1000, float(x[1]), float(x[3]), float(x[4]), float(x[2]), float(x[5]), float(x[6])] for x in data]
        rows.sort()
        return rows

    def _candles(self, symbol: str, typ: str, start_s: int, end_s: int, stop=None, attempts: int = 6) -> list:
        r = _get(f"{self.API}/v1/market/candles?type={typ}&symbol={symbol}&startAt={start_s}&endAt={end_s}", stop=stop, attempts=attempts)
        if r.get("code") != "200000":
            if r.get("code") in ("400100", "900001"):            # parameter error / symbol not exists
                raise LookupError(f"kucoin: {r.get('msg')}")
            raise RuntimeError(f"kucoin code {r.get('code')}: {r.get('msg')}")
        return r.get("data", [])

    def first_ms(self, symbol: str):
        start = 1_483_228_800                                    # 2017-01-01; 1500 daily candles per request = 4.1 years
        now = int(time.time())
        while start < now:
            data = self._candles(symbol, "1day", start, min(now, start + 1500 * 86400))
            if data:
                return int(data[-1][0]) * 1000                   # newest first: the last row is the oldest day
            start += 1500 * 86400
        return None

    def fetch(self, symbol: str, start_ms: int, end_ms: int, stop=None) -> list:
        return self._rows(self._candles(symbol, "1min", start_ms // 1000, end_ms // 1000 + 60, stop))

    def latest(self, symbol: str, n: int = 3) -> list:
        now = int(time.time())
        return self._rows(self._candles(symbol, "1min", now - 60 * (n + 1), now + 60, attempts=1))


# ---------------------------------------------------------------- Coinbase Exchange (base volume, forward, BTC 1m since 2015-01)

class Coinbase(Venue):
    name = "coinbase"
    title = "Coinbase"
    window = 300
    pause = 0.15                                                 # 10 req/s documented
    exact_dollars = False
    quotes = ("USD", "USDT", "USDC")
    API = "https://api.exchange.coinbase.com"

    def instruments(self) -> list:
        r = _get(f"{self.API}/products")
        out = []
        for it in r:
            if it.get("status") != "online" or it.get("trading_disabled") or it.get("quote_currency") not in STABLE:
                continue
            out.append({"symbol": it["id"], "base": it["base_currency"], "quote": it["quote_currency"], "kind": "spot", "list_ms": 0})
        return out

    @staticmethod
    def _rows(data: list) -> list:                              # [time s, low, high, open, close, volume]
        rows = [[int(x[0]) * 1000, float(x[3]), float(x[2]), float(x[1]), float(x[4]), float(x[5]), float(x[5]) * float(x[4])] for x in data]
        rows.sort()
        return rows

    def _candles(self, symbol: str, granularity: int, start_ms: int, end_ms: int, stop=None, attempts: int = 6) -> list:
        url = f"{self.API}/products/{symbol}/candles?granularity={granularity}&start={_iso(start_ms)}&end={_iso(end_ms)}"
        return _get(url, stop=stop, attempts=attempts) or []

    def first_ms(self, symbol: str):
        start = 1_420_070_400_000                                # 2015-01-01; 300 daily candles per request
        now = int(time.time() * 1000)
        while start < now:
            data = self._candles(symbol, 86400, start, min(now, start + 299 * 86_400_000))
            if data:
                return min(int(x[0]) for x in data) * 1000
            start += 299 * 86_400_000
            time.sleep(self.pause)
        return None

    def fetch(self, symbol: str, start_ms: int, end_ms: int, stop=None) -> list:
        return self._rows(self._candles(symbol, 60, start_ms, end_ms + MINUTE, stop))

    def latest(self, symbol: str, n: int = 3) -> list:
        now = int(time.time() * 1000)
        return self._rows(self._candles(symbol, 60, now - MINUTE * (n + 1), now + MINUTE, attempts=1))


# ---------------------------------------------------------------- Bitfinex (base volume, forward, BTC 1m since 2013-04)

class Bitfinex(Venue):
    name = "bitfinex"
    title = "Bitfinex"
    window = 10_000
    pause = 2.1                                                  # 30 req/min documented
    exact_dollars = False
    quotes = ("USD", "USDT", "USDC")
    API = "https://api-pub.bitfinex.com/v2"

    def instruments(self) -> list:
        r = _get(f"{self.API}/conf/pub:list:pair:exchange")
        out = []
        for pair in r[0]:
            if ":" in pair:
                base, quote = pair.split(":", 1)
            else:
                base, quote = pair[:-3], pair[-3:]
            if quote not in STABLE:
                continue
            out.append({"symbol": "t" + pair, "base": base, "quote": "USDT" if quote == "UST" else quote, "kind": "spot", "list_ms": 0})
        return out

    @staticmethod
    def _rows(data: list) -> list:                              # [mts, open, close, high, low, volume]
        rows = [[_minute(x[0]), float(x[1]), float(x[3]), float(x[4]), float(x[2]), float(x[5]), float(x[5]) * float(x[2])] for x in data]
        rows.sort()
        return rows

    @staticmethod
    def _sym(symbol: str) -> str:
        return urllib.parse.quote(symbol, safe="")

    def first_ms(self, symbol: str):
        r = _get(f"{self.API}/candles/trade:1D:{self._sym(symbol)}/hist?limit=1&sort=1&start=1")
        return _minute(r[0][0]) if r else None

    def fetch(self, symbol: str, start_ms: int, end_ms: int, stop=None) -> list:
        url = f"{self.API}/candles/trade:1m:{self._sym(symbol)}/hist?limit={self.window}&sort=1&start={int(start_ms)}&end={int(end_ms)}"
        return self._rows(_get(url, stop=stop) or [])

    def latest(self, symbol: str, n: int = 3) -> list:
        return self._rows(_get(f"{self.API}/candles/trade:1m:{self._sym(symbol)}/hist?limit={n}", timeout=10, attempts=1) or [])


# ---------------------------------------------------------------- Bybit, through bybit_sync, so a combined market treats it like the others

class Bybit(Venue):
    name = "bybit"
    title = "Bybit"
    window = 1000
    pause = 0.05

    def first_ms(self, symbol: str):                             # symbol = the app's market key, "linear:BTCUSDT"
        return X.first_candle_ms(symbol)

    def fetch(self, symbol: str, start_ms: int, end_ms: int, stop=None) -> list:
        return X.fetch(symbol, start_ms, end_ms, stop=stop)

    def latest(self, symbol: str, n: int = 3) -> list:
        return X.latest(symbol, n)


VENUES = {v.name: v for v in (Bybit(), OKX(), KuCoin(), Coinbase(), Bitfinex())}
PRIORITY = ["bybit", "okx", "coinbase", "kucoin", "bitfinex"]    # whose prices win for a minute; dollars are summed over all
DOWNLOAD_ORDER = ["bybit", "kucoin", "bitfinex", "coinbase", "okx"]   # quick and deep first; OKX (100 rows a request) last


# ---------------------------------------------------------------- files

def safe(symbol: str) -> str:
    return "".join(c if c.isalnum() else "_" for c in symbol)


def path(venue: str, symbol: str) -> Path:
    if venue == "bybit":
        return X.path(symbol)
    return DATA / f"{venue}_{safe(symbol)}.parquet"


def side_path(venue: str, symbol: str) -> Path:
    return path(venue, symbol).with_suffix(".json")


def load(venue: str, symbol: str) -> pd.DataFrame:
    p = path(venue, symbol)
    return pd.read_parquet(p) if p.exists() else pd.DataFrame(columns=COLS)


def save(venue: str, symbol: str, df: pd.DataFrame) -> None:
    p = path(venue, symbol)
    p.parent.mkdir(exist_ok=True)
    tmp = p.with_suffix(".tmp")
    df.to_parquet(tmp, index=False)
    os.replace(tmp, p)


def load_side(venue: str, symbol: str) -> dict:
    p = side_path(venue, symbol)
    try:
        return json.loads(p.read_text(encoding="utf-8")) if p.exists() else {}
    except Exception:
        return {}


def save_side(venue: str, symbol: str, side: dict) -> None:
    p = side_path(venue, symbol)
    p.parent.mkdir(exist_ok=True)
    tmp = p.with_suffix(".jtmp")
    tmp.write_text(json.dumps(side), encoding="utf-8")
    os.replace(tmp, p)


def merge_frame(df: pd.DataFrame, new: list) -> pd.DataFrame:
    """Rows may be older or newer than the frame (reverse venues grow both ends); the newest copy of a minute wins."""
    add = pd.DataFrame(new, columns=COLS)
    add["ts"] = add["ts"].astype("int64")
    df = pd.concat([df, add]) if len(df) else add
    return df.drop_duplicates("ts", keep="last").sort_values("ts").reset_index(drop=True)


# ---------------------------------------------------------------- the generic, resumable sync

def sync(venue: Venue, symbol: str, on_rows=None, progress=None, stop=None, checkpoint=None, list_ms: int = 0,
         lock=None) -> dict:
    """Bring data/<venue>_<symbol>.parquet up to now. on_rows(rows) sees every row as it arrives (oldest first
    within a request), progress(pct, at_ms) the position, checkpoint() runs after each parquet write; lock
    (if given) is held around writes so another writer of the same file never shares its .tmp.
    Returns {"result": "done" | "stopped", "first", "last", "n", "prev_last" (the newest candle on disk before
    this sync, None for a fresh series)}. Raises LookupError when the venue does not know the symbol (or has
    no candles for it)."""
    frame = load(venue.name, symbol)
    side = load_side(venue.name, symbol)
    new, requests, since_flush = [], 0, 0
    now_ms = int(time.time() * 1000)
    prev_last = int(frame["ts"].iloc[-1]) if len(frame) else None

    def flush():
        nonlocal frame, new, since_flush
        if new:
            frame = merge_frame(frame, new)
            new = []
            if lock:
                with lock:
                    save(venue.name, symbol, frame)
            else:
                save(venue.name, symbol, frame)
        since_flush = 0
        save_side(venue.name, symbol, side)
        if checkpoint:
            checkpoint()

    def take(rows):
        nonlocal since_flush
        new.extend(rows)
        since_flush += 1
        if on_rows:
            on_rows(rows)
        if len(new) >= FLUSH_ROWS or since_flush >= FLUSH_REQUESTS:
            flush()

    def finish(result):
        flush()
        if len(frame):
            side["first"] = int(frame["ts"].iloc[0])
        save_side(venue.name, symbol, side)
        return {"result": result, "first": int(frame["ts"].iloc[0]) if len(frame) else None,
                "last": int(frame["ts"].iloc[-1]) if len(frame) else None, "n": int(len(frame)), "prev_last": prev_last}

    if not venue.reverse:
        if len(frame):
            cursor = int(frame["ts"].iloc[-1])
            first = int(frame["ts"].iloc[0])
        else:
            first = venue.first_ms(symbol)
            if first is None:
                raise LookupError(f"{venue.title} has no candles for {symbol}")
            cursor = first
        side["first"] = first
        side["history_done"] = True                              # forward venues start at the first candle
        span = max(1, now_ms - first)
        while True:
            if stop and stop():
                return finish("stopped")
            end = cursor + venue.window * MINUTE - 1
            rows = [r for r in venue.fetch(symbol, cursor, end, stop=stop) if cursor <= r[0] <= end]   # some venues pad the window
            requests += 1
            if rows:
                take(rows)
                last = rows[-1][0]
                if progress:
                    progress(min(100.0, (last - first) / span * 100), last)
                if last >= now_ms - MINUTE:
                    break
                cursor = last + MINUTE
            else:
                if end >= now_ms:
                    break
                cursor = end + 1
            time.sleep(venue.pause)
        return finish("done")

    # a reverse venue (OKX): walk back from now to the newest stored candle, then from the oldest one to the listing
    def walk_back(hi, floor):
        """fetch_before(hi) repeatedly, back to `floor` (exclusive; None = to the listing). "done" | "dry" | "stopped"."""
        nonlocal requests
        while True:
            if stop and stop():
                return "stopped"
            rows = venue.fetch_before(symbol, hi, stop=stop)
            requests += 1
            if not rows:
                return "dry"
            if floor is not None:
                rows = [r for r in rows if r[0] > floor]
            if rows:
                take(rows)
                if progress:
                    progress(*_reverse_progress(rows[0][0], floor, list_ms or side.get("first") or 0, now_ms))
            if floor is not None and (not rows or rows[0][0] <= floor + MINUTE):
                return "done"
            hi = rows[0][0]
            time.sleep(venue.pause)

    newest = int(frame["ts"].iloc[-1]) if len(frame) else None
    r = walk_back(now_ms + MINUTE, newest)
    if r == "stopped":
        return finish("stopped")
    if newest is None and r == "dry":                            # a fresh series: the tail walk reached the listing
        side["history_done"] = True
    if not side.get("history_done"):
        flush()
        lo = int(frame["ts"].iloc[0]) if len(frame) else None
        if lo is None:
            raise LookupError(f"{venue.title} has no candles for {symbol}")
        r = walk_back(lo, None)
        if r == "stopped":
            return finish("stopped")
        side["history_done"] = True
    out = finish("done")
    if out["n"] == 0:
        raise LookupError(f"{venue.title} has no candles for {symbol}")
    return out


def _reverse_progress(at_ms: int, floor, first_guess: int, now_ms: int):
    if floor is not None:                                        # catching up the tail: how much of the gap is closed
        span = max(1, now_ms - floor)
        return (max(0.0, min(100.0, (now_ms - at_ms) / span * 100)), at_ms)
    if first_guess and first_guess <= at_ms:                     # walking history back to the listing
        span = max(1, now_ms - first_guess)
        return (max(0.0, min(100.0, (now_ms - at_ms) / span * 100)), at_ms)
    return (0.0, at_ms)


# ---------------------------------------------------------------- which symbols mean a ticker on each venue

INSTRUMENTS = DATA / "venues.json"
REFRESH_S = 86_400


def load_instruments(max_age_s: float = REFRESH_S) -> dict:
    """{venue: [instrument rows]} for the non-Bybit venues, cached in data/venues.json for a day; a venue whose
    list cannot be fetched keeps its old list (or an empty one)."""
    cache = {}
    if INSTRUMENTS.exists():
        try:
            cache = json.loads(INSTRUMENTS.read_text(encoding="utf-8"))
        except Exception:
            cache = {}
    changed = False
    for name, v in VENUES.items():
        if name == "bybit":
            continue
        entry = cache.get(name)
        if entry and time.time() - entry.get("fetched", 0) < max_age_s:
            continue
        try:
            cache[name] = {"fetched": int(time.time()), "rows": v.instruments()}
            changed = True
        except Exception:
            if not entry:
                cache[name] = {"fetched": 0, "rows": []}
    if changed:
        INSTRUMENTS.parent.mkdir(exist_ok=True)
        tmp = INSTRUMENTS.with_suffix(".tmp")
        tmp.write_text(json.dumps(cache, separators=(",", ":")), encoding="utf-8")
        os.replace(tmp, INSTRUMENTS)
    return {name: entry.get("rows", []) for name, entry in cache.items()}


def markets_for(ticker: str, instruments: dict, aliases: dict = None) -> list:
    """One spot and one perp per venue for a ticker (the venue's preferred quote), in DOWNLOAD_ORDER:
    [{"venue", "symbol", "kind", "quote", "list_ms"}]. aliases = {venue base: ticker} as markets.ALIASES."""
    t = ticker.strip().upper()
    names = {t} | {b for b, a in (aliases or {}).items() if a == t}
    out = []
    for name in DOWNLOAD_ORDER:
        v = VENUES.get(name)
        rows = instruments.get(name) or []
        for kind in ("spot", "perp"):
            cands = [r for r in rows if r["kind"] == kind and r["base"].upper() in names and r["quote"] in v.quotes]
            if cands:
                best = min(cands, key=lambda r: v.quotes.index(r["quote"]))
                out.append({"venue": name, "symbol": best["symbol"], "kind": kind, "quote": best["quote"], "list_ms": best.get("list_ms", 0)})
    return out
