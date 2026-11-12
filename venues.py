"""Other exchanges' public 1-minute candles, for the combined market of a ticker ("all:BTC").

Every adapter turns a venue's own kline format into the app's rows [ts (ms, minute open), open, high, low,
close, volume (base coin), dollars]. Binance, OKX and KuCoin report quote-currency turnover, so their dollars
are exact; Coinbase and Bitfinex only report base volume, so dollars = volume x close, which at one minute is
as true as it needs to be. Each series lives in data/<venue>_<SYMBOL>.parquet with a sidecar .json that
remembers whether the history side is complete. Writes go through bybit_sync.write_durably.

Forward venues page from the first candle towards now in fixed windows (Coinbase 300 rows, KuCoin 1500,
Bitfinex 10000, Bitstamp 1000, Binance one day). OKX only pages backwards ("after" = older than), so its tail is
walked from now back to the newest stored candle and its history from the oldest stored candle back to the
listing. Two one-off repairs of what the first download missed: a venue whose real start is earlier than the
first candle it reported then (Coinbase's daily candles start 2015-07-20, its minutes 2015-01-26; Binance's
archive lacks the first months of its oldest perps) has the history before its file's first candle walked once
(head_check), and a venue with coarser candles where its minutes are missing (Bitfinex has no BTC minutes for
2014-11-22..12-31, 2015-05 and 2016-04..05, but 5-minute candles) has those hours filled from them (coarse_tfs).
Binance's history comes from its public archive (data.binance.vision: one zip per month, then one per day);
only the last day or two, which the archive does not have yet, comes from its REST API (a few requests), and
the live minutes come from its websocket stream, so the app adds next to nothing to the request weight this
machine's other Binance users spend. Every sync is resumable and stops within one request when asked, like
bybit_sync. Bybit itself is wrapped here too so the combined market treats all its parts alike.
"""
import io
import json
import re
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import zipfile
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
try:
    import websocket                                             # websocket-client: Binance's live minutes (else REST every poll)
except ImportError:
    websocket = None
import pandas as pd

import bybit_sync as X

DATA = X.DATA
COLS = X.COLS
MINUTE = X.MINUTE
HOUR = 3_600_000
DAY = 86_400_000
HEAD_VERSION = 1                                                 # the head check's version (a series checked by another is checked again)
UA = X.UA
STABLE = {"USD", "USDT", "USDC", "UST"}                        # quotes that count as dollars
FLUSH_ROWS = 250_000                                             # rows held in memory before the parquet is rewritten
FLUSH_REQUESTS = 500


def _get(url: str, timeout: float = 20, attempts: int = 6, stop=None, raw: bool = False):
    """GET JSON (raw=True: the bytes). A 4xx that is not a rate limit or a refusal that can pass (403: a
    firewall's ban), or Bitfinex's 500 "error" body = LookupError: bad symbol or range, do not retry.
    Everything else is retried with a growing pause."""
    for attempt in range(attempts):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=timeout) as r:
                return r.read() if raw else json.load(r)
        except urllib.error.HTTPError as e:
            body = ""
            try:
                body = e.read(200).decode("utf-8", "replace")
            except Exception:
                pass
            if (400 <= e.code < 500 and e.code not in (403, 408, 418, 425, 429)) or (e.code == 500 and body.startswith('["error"')):
                raise LookupError(f"HTTP {e.code} {body[:80]}")
            if attempt == attempts - 1 or (stop and stop()):
                raise
            time.sleep(2.0 * (attempt + 1) * (5 if e.code in (418, 429) else 1))
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
    head_check = False                                           # True: first_ms may now find history before a stored file's first candle
    coarse_tfs = ()                                              # (finest, ..., 60): candle minutes coarse() serves, to fill missing hours
    drop_empty = False                                           # True: candles without volume are the venue's padding, not stored

    def coarse(self, symbol: str, minutes: int, start_ms: int, end_ms: int, stop=None) -> list:   # coarser candles, ascending
        raise NotImplementedError

    def first_is_sure(self, symbol: str) -> bool:                # False: first_ms fell back to a source that may start late
        return True

    def instruments(self) -> list:                               # [{"symbol", "base", "quote", "kind", "list_ms"}]
        raise NotImplementedError

    def first_ms(self, symbol: str):                             # forward venues: open time of the first candle (or its day)
        raise NotImplementedError

    def fetch(self, symbol: str, start_ms: int, end_ms: int, stop=None) -> list:   # forward venues, rows ascending
        raise NotImplementedError

    def fetch_before(self, symbol: str, ts_ms: int, stop=None) -> list:            # reverse venues: closed rows older than ts, ascending
        raise NotImplementedError

    def latest(self, symbol: str, n: int = 3) -> list:          # the newest n minutes, the last one still forming
        raise NotImplementedError

    def label(self, symbol: str, kind: str) -> str:
        return f"{self.title} {symbol}"


# ---------------------------------------------------------------- Binance (archive + a few REST requests + websocket live)

class Binance(Venue):
    """symbol = "spot:ZECUSDT" or "perp:ZECUSDT" (USDT-margined perpetual)."""
    name = "binance"
    title = "Binance"
    window = 1440
    pause = 0.0
    head_check = True                                            # the archive starts 2020-01 for perps listed in 2019 (BTCUSDT 2019-09-08)
    HISTORY_PAUSE = 1.0                                          # seconds after each REST request for a past day the archive lacks
    VISION = "https://data.binance.vision/"
    S3 = "https://s3-ap-northeast-1.amazonaws.com/data.binance.vision?delimiter=/&prefix="
    ARCHIVE = {"spot": "data/spot", "perp": "data/futures/um"}
    REST = {"spot": ("https://api.binance.com/api/v3/klines", 1000), "perp": ("https://fapi.binance.com/fapi/v1/klines", 1500)}
    WS = {"spot": "wss://stream.binance.com:9443/ws/{}@kline_1m", "perp": "wss://fstream.binance.com/market/ws/{}@kline_1m"}

    def __init__(self):
        self._months = {}                                        # (kind, symbol) -> ("YYYY-MM", rows array or None = not in the archive)
        self._lock = threading.Lock()
        self._streams = {}
        self._unsure = set()                                     # symbols whose last first_ms could not ask the REST API

    def first_is_sure(self, symbol: str) -> bool:
        return symbol not in self._unsure

    @staticmethod
    def split(symbol: str) -> tuple:
        kind, _, sym = symbol.partition(":")
        if kind not in ("spot", "perp") or not sym.isalnum():
            raise ValueError(f"bad binance symbol {symbol!r}")
        return kind, sym

    def label(self, symbol: str, kind: str) -> str:
        return f"Binance {self.split(symbol)[1]} {kind}"

    def instruments(self) -> list:
        out = []
        r = _get("https://api.binance.com/api/v3/exchangeInfo?symbolStatus=TRADING", timeout=60)
        for it in r.get("symbols", []):
            if it.get("status") == "TRADING" and it.get("quoteAsset") in STABLE and it.get("isSpotTradingAllowed", True):
                out.append({"symbol": "spot:" + it["symbol"], "base": it["baseAsset"], "quote": it["quoteAsset"], "kind": "spot", "list_ms": 0})
        r = _get("https://fapi.binance.com/fapi/v1/exchangeInfo", timeout=60)
        for it in r.get("symbols", []):
            if it.get("status") == "TRADING" and it.get("contractType") == "PERPETUAL" and it.get("quoteAsset") in STABLE:
                out.append({"symbol": "perp:" + it["symbol"], "base": it["baseAsset"], "quote": it["quoteAsset"], "kind": "perp",
                            "list_ms": int(it.get("onboardDate") or 0)})
        return out

    # archive files
    def _keys(self, kind: str, sym: str, period: str) -> list:
        prefix = f"{self.ARCHIVE[kind]}/{period}/klines/{sym}/1m/"
        xml = _get(self.S3 + urllib.parse.quote(prefix, safe="/"), raw=True, timeout=30).decode("utf-8", "replace")
        return re.findall(r"<Key>([^<]+\.zip)</Key>", xml)

    @staticmethod
    def _parse_zip(blob: bytes) -> np.ndarray:
        z = zipfile.ZipFile(io.BytesIO(blob))
        text = z.read(z.namelist()[0])
        if text[:1].isalpha():                                   # newer files start with a header line
            text = text.split(b"\n", 1)[1] if b"\n" in text else b""
        if not text.strip():
            return np.zeros((0, 7))
        a = np.loadtxt(io.BytesIO(text), delimiter=",", usecols=(0, 1, 2, 3, 4, 5, 7), ndmin=2)
        ts = a[:, 0].astype(np.int64)
        ts = np.where(ts > 10 ** 14, ts // 1000, ts)             # spot files switched to microseconds in 2025
        a[:, 0] = ts // MINUTE * MINUTE
        return a[np.argsort(a[:, 0], kind="stable")]

    def _archive(self, kind: str, sym: str, period: str, name: str, stop=None):
        url = f"{self.VISION}{self.ARCHIVE[kind]}/{period}/klines/{sym}/1m/{sym}-1m-{name}.zip"
        try:
            return self._parse_zip(_get(url, raw=True, timeout=60, stop=stop))
        except LookupError:                                      # 404: not in the archive (yet)
            return None

    def _month(self, kind: str, sym: str, month: str, stop=None):
        """One month's zip, kept while that series is being read (a sync walks a month a day at a time)."""
        with self._lock:
            hit = self._months.get((kind, sym))
            if hit and hit[0] == month:
                return hit[1]
        rows = self._archive(kind, sym, "monthly", month, stop)
        with self._lock:
            self._months[(kind, sym)] = (month, rows)
        return rows

    def _rest(self, kind: str, sym: str, start_ms: int, end_ms: int, stop=None, attempts: int = 6) -> list:
        url, limit = self.REST[kind]
        out, cur = [], int(start_ms)
        while cur <= end_ms:
            d = _get(f"{url}?symbol={sym}&interval=1m&startTime={cur}&endTime={int(end_ms)}&limit={limit}", stop=stop, attempts=attempts)
            if not d:
                break
            out.extend([int(x[0]), float(x[1]), float(x[2]), float(x[3]), float(x[4]), float(x[5]), float(x[7])] for x in d)
            if len(d) < limit:
                break
            cur = int(d[-1][0]) + MINUTE
        return out

    def _day(self, kind: str, sym: str, day_ms: int, now_ms: int, stop=None) -> list:
        """All of one UTC day's candles: the month's zip for past months, the day's zip for past days of this
        month, the REST API for today and for any day the archive does not have."""
        dt = datetime.fromtimestamp(day_ms / 1000, tz=timezone.utc)
        today = now_ms // DAY * DAY
        if day_ms < today:
            month = dt.strftime("%Y-%m")
            if month < datetime.fromtimestamp(now_ms / 1000, tz=timezone.utc).strftime("%Y-%m"):
                rows = self._month(kind, sym, month, stop)
                if rows is not None:
                    i0, i1 = np.searchsorted(rows[:, 0], [day_ms, day_ms + DAY])
                    if i1 > i0:
                        return rows[i0:i1].tolist()
            rows = self._archive(kind, sym, "daily", dt.strftime("%Y-%m-%d"), stop)
            if rows is not None and len(rows):
                return rows.tolist()
        rows = self._rest(kind, sym, day_ms, day_ms + DAY - 1, stop)
        if day_ms < today - DAY:                                 # a past day the archive lacks: one request a second at most
            time.sleep(self.HISTORY_PAUSE)
        return rows

    def forget(self, symbol: str) -> None:
        with self._lock:
            self._months.pop(self.split(symbol), None)

    def first_ms(self, symbol: str):
        """The REST API's first candle (one request: the archive lacks the first months of the oldest perps),
        else (REST failing: a ban, the network) the archive's, which first_is_sure() then says may be late."""
        kind, sym = self.split(symbol)
        url, _ = self.REST[kind]
        try:
            d = _get(f"{url}?symbol={sym}&interval=1m&startTime=0&limit=1", attempts=3)
            self._unsure.discard(symbol)
            if d:
                return int(d[0][0])
        except LookupError:
            raise
        except Exception:
            self._unsure.add(symbol)
        for period in ("monthly", "daily"):
            keys = self._keys(kind, sym, period)
            if keys:
                name = keys[0].rsplit(f"{sym}-1m-", 1)[1][:-4]
                rows = self._archive(kind, sym, period, name)
                if rows is not None and len(rows):
                    return int(rows[0, 0])
        return None

    def fetch(self, symbol: str, start_ms: int, end_ms: int, stop=None) -> list:
        kind, sym = self.split(symbol)
        now_ms = int(time.time() * 1000)
        out, day = [], start_ms // DAY * DAY
        while day <= end_ms and day <= now_ms:
            out.extend(r for r in self._day(kind, sym, day, now_ms, stop) if start_ms <= r[0] <= end_ms)
            day += DAY
        return [[int(r[0])] + [float(x) for x in r[1:]] for r in out]

    def latest(self, symbol: str, n: int = 3) -> list:
        kind, sym = self.split(symbol)
        with self._lock:
            st = self._streams.get(symbol)
            if websocket is None:                                # no websocket-client: one REST read per poll
                st = None
            elif st is None or not st.alive():
                st = self._streams[symbol] = _Stream(self.WS[kind].format(sym.lower()), lambda: self._rest(kind, sym, int(time.time() * 1000) - 4 * MINUTE, int(time.time() * 1000), attempts=1))
        if st is None:
            now = int(time.time() * 1000)
            rows = self._rest(kind, sym, now - (n + 1) * MINUTE, now, attempts=1)
            return [list(r) for r in rows if r[0] > rows[-1][0] - n * MINUTE] if rows else []
        return st.latest(n)


class _Stream:
    """One Binance kline websocket: keeps the last few minutes, seeded by one REST request so the minutes before
    the connection are there too. Closes itself two minutes after the last read; a new read reopens it.
    If the stream has said nothing for 30 s, reads fall back to REST, at most once per 20 s; a read raises when
    neither has answered for 45 s."""

    IDLE_S = 120

    def __init__(self, url: str, rest):
        self.url, self.rest = url, rest
        self.rows, self.lock = {}, threading.Lock()
        self.used = time.time()
        self.heard = 0.0
        self.rest_at = 0.0
        self.rest_ok = 0.0
        self.closed = False
        threading.Thread(target=self.run, daemon=True, name="binance-ws").start()

    def alive(self) -> bool:
        return not self.closed

    def put(self, rows) -> None:
        with self.lock:
            for r in rows:
                self.rows[int(r[0])] = list(r)
            newest = max(self.rows) if self.rows else 0
            for t in [t for t in self.rows if t < newest - 10 * MINUTE]:
                del self.rows[t]

    def run(self) -> None:
        try:
            while time.time() - self.used < self.IDLE_S:
                try:
                    ws = websocket.create_connection(self.url, timeout=15)
                except Exception:
                    time.sleep(5)
                    continue
                try:
                    while time.time() - self.used < self.IDLE_S:
                        try:
                            msg = json.loads(ws.recv())
                        except websocket.WebSocketTimeoutException:
                            continue                             # a quiet market: nothing traded for 15 s
                        k = (msg.get("data") or msg).get("k") if isinstance(msg, dict) else None
                        if k:
                            self.put([[int(k["t"]), float(k["o"]), float(k["h"]), float(k["l"]), float(k["c"]), float(k["v"]), float(k["q"])]])
                            self.heard = time.time()
                except Exception:
                    time.sleep(2)                                # dropped (Binance closes streams after 24 h): reconnect
                finally:
                    try:
                        ws.close()
                    except Exception:
                        pass
        finally:
            self.closed = True

    def latest(self, n: int) -> list:
        now = time.time()
        self.used = now
        if now - self.heard > 30 and now - self.rest_at > 20:   # just opened, or the stream went quiet: one REST read
            self.rest_at = now
            try:
                self.put(self.rest())
                self.rest_ok = now
            except Exception:
                pass
        if now - max(self.heard, self.rest_ok) > 45:             # neither the stream nor REST: say so (the poll counts as failed)
            raise RuntimeError("no live minutes from Binance")
        with self.lock:
            if not self.rows:
                return []
            newest = max(self.rows)
            return [self.rows[t] for t in sorted(self.rows) if t > newest - n * MINUTE]


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
    def _rows(data: list, symbol: str, closed_only: bool) -> list:   # [ts, o, h, l, c, vol, volCcy, volCcyQuote, confirm]
        swap = symbol.endswith("-SWAP")
        rows = []
        for x in data:
            if closed_only and len(x) > 8 and x[8] == "0":      # the minute still forming: never stored
                continue
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
        return self._rows(self._check(r), symbol, closed_only=True)

    def latest(self, symbol: str, n: int = 3) -> list:
        r = _get(f"{self.API}/market/candles?instId={symbol}&bar=1m&limit={n}", timeout=10, attempts=1)
        return self._rows(self._check(r), symbol, closed_only=False)


# ---------------------------------------------------------------- KuCoin (quote turnover, forward, BTC 1m since 2018-01)

class KuCoin(Venue):
    name = "kucoin"
    title = "KuCoin"
    window = 1500                                                # the most a request returns; past that it keeps the NEWEST rows
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
        # endAt is exclusive (checked 2026-11-12): [start, end] inclusive of end's minute = endAt one minute on
        return self._rows(self._candles(symbol, "1min", start_ms // 1000, _minute(end_ms) // 1000 + 60, stop))

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
    head_check = True                                            # files made before first_ms knew OPENED start at DAILY_FLOOR
    OPENED = 1_422_230_400_000                                   # 2015-01-26, the exchange's first day: 1-minute candles go back to it ...
    DAILY_FLOOR = 1_437_350_400_000                              # ... while daily (and 5m+) candles start 2015-07-20 (checked 2026-11-12)

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
                first = min(int(x[0]) for x in data) * 1000
                return self.OPENED if first <= self.DAILY_FLOOR else first   # a product of the first days: from opening day
            start += 299 * 86_400_000
            time.sleep(self.pause)
        return None

    def fetch(self, symbol: str, start_ms: int, end_ms: int, stop=None) -> list:
        # end is inclusive; up to 301 rows are accepted, 302 is a 400 (checked 2026-11-12)
        return self._rows(self._candles(symbol, 60, start_ms, _minute(end_ms), stop))

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
        end_ms = min(int(end_ms), int(time.time() * 1000))       # an end in the future is "time_interval: invalid" (10020)
        url = f"{self.API}/candles/trade:1m:{self._sym(symbol)}/hist?limit={self.window}&sort=1&start={int(start_ms)}&end={end_ms}"
        return self._rows(_get(url, stop=stop) or [])

    def latest(self, symbol: str, n: int = 3) -> list:
        return self._rows(_get(f"{self.API}/candles/trade:1m:{self._sym(symbol)}/hist?limit={n}", timeout=10, attempts=1) or [])

    coarse_tfs = (5, 60)                                         # 5m candles cover every BTC/ETH minute hole (checked 2026-11-12)
    TF = {5: "5m", 15: "15m", 30: "30m", 60: "1h"}

    def coarse(self, symbol: str, minutes: int, start_ms: int, end_ms: int, stop=None) -> list:
        end_ms = min(int(end_ms), int(time.time() * 1000))
        out, cur = [], int(start_ms)
        while cur <= end_ms and not (stop and stop()):
            url = f"{self.API}/candles/trade:{self.TF[minutes]}:{self._sym(symbol)}/hist?limit={self.window}&sort=1&start={cur}&end={end_ms}"
            rows = [r for r in self._rows(_get(url, stop=stop) or []) if cur <= r[0] <= end_ms]
            time.sleep(self.pause)
            out.extend(rows)
            if len(rows) < self.window:
                break
            cur = rows[-1][0] + minutes * MINUTE
        return out


# ---------------------------------------------------------------- Bitstamp (base volume, forward, BTC 1m since 2011-09)

class Bitstamp(Venue):
    """Pads every minute after a pair's first trade with a flat zero-volume candle: those are not stored."""
    name = "bitstamp"
    title = "Bitstamp"
    window = 1000                                                # the most a request returns (1001 is a 400)
    pause = 0.15                                                 # documented limit 8000 requests / 10 min
    exact_dollars = False
    drop_empty = True
    quotes = ("USD", "USDT", "USDC")
    API = "https://www.bitstamp.net/api/v2"

    def instruments(self) -> list:
        out = []
        for it in _get(f"{self.API}/trading-pairs-info/"):
            base, _, quote = str(it.get("name", "")).partition("/")
            if it.get("trading") != "Enabled" or quote not in STABLE:
                continue
            out.append({"symbol": it["url_symbol"], "base": base, "quote": quote, "kind": "spot", "list_ms": 0})
        return out

    def label(self, symbol: str, kind: str) -> str:
        return f"Bitstamp {symbol.upper()}"

    @staticmethod
    def _rows(r) -> list:                                        # {"data": {"ohlc": [{"timestamp" s, open, high, low, close, volume}]}}
        rows = [[int(x["timestamp"]) * 1000, float(x["open"]), float(x["high"]), float(x["low"]), float(x["close"]),
                 float(x["volume"]), float(x["volume"]) * float(x["close"])] for x in ((r or {}).get("data") or {}).get("ohlc") or []]
        rows.sort()
        return rows

    OPENED_S = 1_300_000_000                                     # 2011-03, before Bitstamp opened (2011-08)
    BUCKET_S = 259_200                                           # 3-day candles: one request spans 1000 of them (8.2 years)

    def first_ms(self, symbol: str):
        # 3-day candles from `start` begin at the pair's first one; a pair listed more than 1000 buckets later
        # answers nothing there (SOL 2022-08, HYPE 2025-11: checked 2026-11-12), so the next 1000 are asked. A
        # 1-minute window that starts before the pair's first minute answers from that minute on (nothing when it
        # ends before it), so walking 1-minute windows from this bucket's start misses nothing (BTC 2011-08-18 12:37)
        start, now = self.OPENED_S, int(time.time())
        while start < now:
            rows = self._rows(_get(f"{self.API}/ohlc/{symbol}/?step={self.BUCKET_S}&limit=1000&start={start}"))
            traded = [r for r in rows if r[5] > 0]
            if traded:
                return traded[0][0]
            start += 1000 * self.BUCKET_S
        return None

    def fetch(self, symbol: str, start_ms: int, end_ms: int, stop=None) -> list:
        # start is inclusive and the window runs `limit` minutes from it; with end too, start is ignored (checked 2026-11-12)
        return self._rows(_get(f"{self.API}/ohlc/{symbol}/?step=60&limit={self.window}&start={int(start_ms) // 1000}", stop=stop))

    def latest(self, symbol: str, n: int = 3) -> list:
        return [r for r in self._rows(_get(f"{self.API}/ohlc/{symbol}/?step=60&limit={n}", timeout=10, attempts=1)) if r[5] > 0]


# ---------------------------------------------------------------- Kraken (archive + trades + OHLC, base volume, BTC 1m since 2013-10)

class _Ranged(io.RawIOBase):
    """Byte-split zip parts on a web server read as one seekable file, a block at a time with HTTP range requests:
    zipfile reads the directory and one entry without the rest of the archive (Kraken's is 9.5 GB)."""
    BLOCK = 4 << 20

    def __init__(self, urls: list, sizes: list, stop=None):
        self.urls, self.sizes, self.total, self.pos, self.stop = urls, sizes, sum(sizes), 0, stop
        self.cache = {}

    def readable(self):
        return True

    def seekable(self):
        return True

    def tell(self):
        return self.pos

    def seek(self, off, whence=0):
        self.pos = off if whence == 0 else self.pos + off if whence == 1 else self.total + off
        return self.pos

    def _block(self, b: int) -> bytes:
        if b not in self.cache:
            lo, hi = b * self.BLOCK, min(self.total, (b + 1) * self.BLOCK) - 1
            out, start = b"", 0
            for url, n in zip(self.urls, self.sizes):
                a, z = max(lo, start), min(hi, start + n - 1)
                if a <= z:
                    for attempt in range(6):
                        try:
                            req = urllib.request.Request(url, headers=dict(UA, Range=f"bytes={a - start}-{z - start}"))
                            with urllib.request.urlopen(req, timeout=60) as r:
                                part = r.read()
                            if len(part) != z - a + 1:
                                raise IOError("short range read")
                            out += part
                            break
                        except Exception:
                            if attempt == 5 or (self.stop and self.stop()):
                                raise
                            time.sleep(2.0 * (attempt + 1))
                start += n
            if len(self.cache) >= 3:
                self.cache.pop(next(iter(self.cache)))
            self.cache[b] = out
        return self.cache[b]

    def readinto(self, buf) -> int:
        n = min(len(buf), self.total - self.pos)
        got = 0
        while got < n:
            b, off = divmod(self.pos, self.BLOCK)
            chunk = self._block(b)[off:off + n - got]
            buf[got:got + len(chunk)] = chunk
            got += len(chunk)
            self.pos += len(chunk)
        return got


class Kraken(Venue):
    """History from Kraken's free OHLCVT archive (1-minute candles of every pair from its first trade, a zip in
    byte-split parts: only the pair's entry is read, with range requests), then its public trades summed into
    minutes up to the last 11 hours, which its OHLC endpoint serves (720 minutes)."""
    name = "kraken"
    title = "Kraken"
    window = 1440                                                # minutes per forward request after the archive (trades paged inside)
    pause = 1.05                                                 # public endpoints: about one request a second
    exact_dollars = False                                        # the archive's candles carry coin volume: dollars = volume x close
    drop_empty = True
    quotes = ("USD", "USDT", "USDC")
    API = "https://api.kraken.com/0/public"
    ARCHIVE = "https://assets.kraken.com/marketing/institutions/Kraken_OHLCVT_Full.zip.part{:02d}"
    ALIASES = {"XBT": "BTC", "XDG": "DOGE"}
    OHLC_SPAN = 11 * HOUR                                        # windows younger than this come from the OHLC endpoint
    CHUNK = 100_000

    def __init__(self):
        self._parts = None

    def _call(self, path: str, stop=None, attempts: int = 6):
        """A public endpoint's result; its errors come in a 200 body: a rate limit is waited out, an unknown pair
        is a LookupError."""
        for attempt in range(attempts):
            r = _get(f"{self.API}/{path}", stop=stop, attempts=attempts)
            err = (r or {}).get("error") or []
            if not err:
                return r.get("result") or {}
            text = "; ".join(map(str, err))
            if "Unknown asset pair" in text or "Invalid arguments" in text:
                raise LookupError(f"kraken: {text}")
            if attempt == attempts - 1 or (stop and stop()):
                raise RuntimeError(f"kraken: {text}")
            time.sleep(5.0 * (attempt + 1))
        return {}

    def instruments(self) -> list:
        out = []
        for it in self._call("AssetPairs").values():
            base, _, quote = str(it.get("wsname") or "").partition("/")
            if quote not in STABLE or str(it.get("altname", "")).endswith(".d") or it.get("status", "online") != "online":
                continue
            out.append({"symbol": it["altname"], "base": self.ALIASES.get(base, base), "quote": quote, "kind": "spot", "list_ms": 0})
        return out

    def label(self, symbol: str, kind: str) -> str:
        return f"Kraken {symbol}"

    # the archive
    def _zip(self, stop=None):
        if self._parts is None:
            urls, sizes = [], []
            for k in range(100):
                try:
                    with urllib.request.urlopen(urllib.request.Request(self.ARCHIVE.format(k), method="HEAD", headers=UA), timeout=30) as r:
                        sizes.append(int(r.headers["Content-Length"]))
                        urls.append(self.ARCHIVE.format(k))
                except urllib.error.HTTPError as e:
                    if e.code == 404 and urls:
                        break
                    raise
            self._parts = (urls, sizes)
        return zipfile.ZipFile(io.BufferedReader(_Ranged(*self._parts, stop=stop), 1 << 20))

    def stream(self, symbol: str, after_ms: int, stop=None):
        """The archive's 1-minute rows of a pair newer than after_ms, in chunks (none when the pair is not in it)."""
        z = self._zip(stop)
        name = f"{symbol}_1.csv"
        if name not in z.namelist():
            return
        with z.open(name) as fh:
            chunk = []
            for line in io.TextIOWrapper(fh, encoding="ascii"):
                x = line.split(",")
                if len(x) < 6:
                    continue
                t = int(x[0]) * 1000
                if t <= after_ms:
                    continue
                v, c = float(x[5]), float(x[4])
                if v <= 0:                                       # (the files hold traded minutes only; a padding row would be stored)
                    continue
                chunk.append([t, float(x[1]), float(x[2]), float(x[3]), c, v, v * c])
                if len(chunk) >= self.CHUNK:
                    yield chunk
                    chunk = []
                    if stop and stop():
                        return
            if chunk:
                yield chunk

    def first_ms(self, symbol: str):
        for chunk in self.stream(symbol, -1):
            return chunk[0][0]
        trades = self._trades(symbol, 0)[0]                      # a pair younger than the archive: its first trade
        return trades[0][0] // MINUTE * MINUTE if trades else None

    # after the archive
    def _trades(self, symbol: str, since_ns: int, stop=None) -> tuple:
        """([[ms, price, volume], ...] from since, the next cursor)."""
        r = self._call(f"Trades?pair={symbol}&since={int(since_ns)}&count=1000", stop=stop)
        rows = next((v for k, v in r.items() if k != "last"), [])
        return [[int(float(x[2]) * 1000), float(x[0]), float(x[1])] for x in rows], int(r.get("last") or 0)

    @staticmethod
    def _minutes(trades: list) -> list:
        out = {}
        for t, p, v in trades:
            m = t // MINUTE * MINUTE
            r = out.get(m)
            if r is None:
                out[m] = [m, p, p, p, p, v, p * v]
            else:
                r[2], r[3], r[4] = max(r[2], p), min(r[3], p), p
                r[5] += v
                r[6] += p * v
        return [out[m] for m in sorted(out)]

    def _ohlc(self, symbol: str, since_ms: int, stop=None, attempts: int = 6) -> list:
        r = self._call(f"OHLC?pair={symbol}&interval=1&since={int(since_ms) // 1000 - 60}", stop=stop, attempts=attempts)
        rows = next((v for k, v in r.items() if k != "last"), [])
        # [time s, open, high, low, close, vwap, volume, count]: dollars = vwap x volume
        return [[int(x[0]) * 1000, float(x[1]), float(x[2]), float(x[3]), float(x[4]), float(x[6]), float(x[5]) * float(x[6])] for x in rows]

    def fetch(self, symbol: str, start_ms: int, end_ms: int, stop=None) -> list:
        now = int(time.time() * 1000)
        if start_ms >= now - self.OHLC_SPAN:
            return [r for r in self._ohlc(symbol, start_ms, stop) if start_ms <= r[0] <= end_ms]
        trades, since = [], int(start_ms) * 1_000_000 - 1         # since is exclusive: a trade at start_ms is kept
        while not (stop and stop()):
            page, nxt = self._trades(symbol, since, stop)
            trades.extend(x for x in page if start_ms <= x[0] <= end_ms)
            if len(page) < 1000 or page[-1][0] > end_ms or nxt <= since:
                break
            since = nxt
            time.sleep(self.pause)
        rows = self._minutes(trades)
        if rows and rows[-1][0] < min(end_ms, now) // MINUTE * MINUTE and not (stop and stop()):
            rows.append([min(end_ms, now) // MINUTE * MINUTE, rows[-1][4], rows[-1][4], rows[-1][4], rows[-1][4], 0.0, 0.0])
        return rows                                              # (a zero-volume marker at the window's end: the sync moves past a quiet tail)

    def latest(self, symbol: str, n: int = 3) -> list:
        rows = self._ohlc(symbol, int(time.time() * 1000) - (n + 1) * MINUTE, attempts=1)
        return [r for r in rows if r[5] > 0][-n:]


# ---------------------------------------------------------------- Bybit, through bybit_sync, so a combined market treats it like the others

class Bybit(Venue):
    name = "bybit"
    title = "Bybit"
    window = 1000
    pause = 0.05

    def label(self, symbol: str, kind: str) -> str:
        return f"Bybit {X.parse(symbol)[1]} {kind}"

    def first_ms(self, symbol: str):                             # symbol = the app's market key, "linear:BTCUSDT"
        return X.first_candle_ms(symbol)

    def fetch(self, symbol: str, start_ms: int, end_ms: int, stop=None) -> list:
        return X.fetch(symbol, start_ms, end_ms, stop=stop)

    def latest(self, symbol: str, n: int = 3) -> list:
        return X.kline(*X.parse(symbol), "1", limit=n, attempts=1, timeout=10)


VENUES = {v.name: v for v in (Binance(), Bybit(), OKX(), Coinbase(), Bitstamp(), Kraken(), KuCoin(), Bitfinex())}
# whose prices decide a minute nobody traded in (the price itself is the dollar-weighted median of the venues that did)
PRIORITY = ["binance", "bybit", "okx", "coinbase", "bitstamp", "kraken", "kucoin", "bitfinex"]
DOWNLOAD_ORDER = ["binance", "bybit", "kucoin", "bitfinex", "coinbase", "bitstamp", "kraken", "okx"]


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
    """The series on disk (empty frame if none). Unreadable bytes raise X.Damaged, like a Bybit market file."""
    p = path(venue, symbol)
    try:
        raw = p.read_bytes()
    except FileNotFoundError:
        return pd.DataFrame(columns=COLS)
    try:
        df = pd.read_parquet(io.BytesIO(raw))
        if [c for c in COLS if c not in df.columns]:
            raise ValueError("missing columns")
    except MemoryError:
        raise
    except Exception as e:
        raise X.Damaged(f"{p.name}: {type(e).__name__}: {e}") from e
    return df[COLS]


def save(venue: str, symbol: str, df: pd.DataFrame) -> None:
    X.write_durably(path(venue, symbol), lambda f: df.to_parquet(f, index=False))


def load_side(venue: str, symbol: str) -> dict:
    p = side_path(venue, symbol)
    try:
        return json.loads(p.read_text(encoding="utf-8")) if p.exists() else {}
    except Exception:
        return {}


def save_side(venue: str, symbol: str, side: dict) -> None:
    X.write_durably(side_path(venue, symbol), lambda f: f.write(json.dumps(side).encode()))


def set_aside(venue: str, symbol: str) -> None:
    """A damaged series file is moved out of the way (with its sidecar); the next sync downloads it again."""
    for p in (path(venue, symbol), side_path(venue, symbol)):
        if p.exists():
            p.replace(p.with_name(p.name + ".damaged"))


def merge_frame(df: pd.DataFrame, new: list) -> pd.DataFrame:
    """Rows may be older or newer than the frame (reverse venues grow both ends); the newest copy of a minute wins."""
    add = pd.DataFrame(new, columns=COLS)
    add["ts"] = add["ts"].astype("int64")
    df = pd.concat([df, add]) if len(df) else add
    return df.drop_duplicates("ts", keep="last").sort_values("ts").reset_index(drop=True)


# ---------------------------------------------------------------- the generic, resumable sync

def sync(venue: Venue, symbol: str, on_rows=None, progress=None, stop=None, checkpoint=None, list_ms: int = 0) -> dict:
    """Bring data/<venue>_<symbol>.parquet up to now. on_rows(rows) sees every row as it arrives (oldest first
    within a request), progress(pct, at_ms) the position, checkpoint() runs after each parquet write.
    Returns {"result": "done" | "stopped", "first", "last", "n", "prev_last" (the newest candle on disk before
    this sync, None for a fresh series), "grew_back" (rows older than what was on disk arrived)}. Raises
    LookupError when the venue does not know the symbol (or has no candles for it)."""
    try:
        frame = load(venue.name, symbol)
    except X.Damaged:
        set_aside(venue.name, symbol)
        frame = load(venue.name, symbol)
    side = load_side(venue.name, symbol)
    new, since_flush = [], 0
    now_ms = int(time.time() * 1000)
    prev_last = int(frame["ts"].iloc[-1]) if len(frame) else None
    prev_first = int(frame["ts"].iloc[0]) if len(frame) else None

    def flush():
        nonlocal frame, new, since_flush
        if new:
            frame = merge_frame(frame, new)
            new = []
            save(venue.name, symbol, frame)
        since_flush = 0
        save_side(venue.name, symbol, side)
        if checkpoint:
            checkpoint()

    def take(rows, hold=False):
        nonlocal since_flush
        new.extend(rows)
        since_flush += 1
        if on_rows:
            on_rows(rows)
        if not hold and (len(new) >= FLUSH_ROWS or since_flush >= FLUSH_REQUESTS):
            flush()

    holding = [False]                                            # a reverse tail walk is keeping its rows in memory
    filled = [0]                                                 # hours without minutes filled from coarser candles

    def finish(result):
        if holding[0]:
            new.clear()                                          # the unfinished tail is fetched again next time
            holding[0] = False
        flush()
        if hasattr(venue, "forget"):
            venue.forget(symbol)
        out = {"result": result, "first": int(frame["ts"].iloc[0]) if len(frame) else None,
               "last": int(frame["ts"].iloc[-1]) if len(frame) else None, "n": int(len(frame)), "prev_last": prev_last,
               "filled": filled[0]}
        out["grew_back"] = prev_first is not None and out["first"] is not None and out["first"] < prev_first
        if len(frame):
            side["first"] = out["first"]
        save_side(venue.name, symbol, side)
        return out

    def page(cursor, end):
        """One forward request: (rows to store, the newest minute it answered for, or None)."""
        rows = [r for r in venue.fetch(symbol, cursor, end, stop=stop) if cursor <= r[0] <= end]   # some venues pad the window
        if not rows:
            return [], None
        return ([r for r in rows if r[5] > 0] if venue.drop_empty else rows), rows[-1][0]

    def head(cursor, until):
        """Forward from cursor to until (inclusive): history before the file's first candle that the first download
        missed. Resumable: side["head_walk"] = [where it is, where it ends]. False = stopped."""
        side["head_walk"] = [int(cursor), int(until)]
        begin, span = cursor, max(1, until - cursor)
        while cursor <= until:
            if stop and stop():
                return False
            end = min(cursor + venue.window * MINUTE - 1, until)
            rows, last = page(cursor, end)
            cursor = last + MINUTE if last is not None else end + 1
            side["head_walk"][0] = int(cursor)
            if rows:
                take(rows)
            if progress:
                progress(min(99.0, (cursor - begin) / span * 100), cursor)
            time.sleep(venue.pause)
        side.pop("head_walk", None)
        return True

    def fill_holes():
        """Hours the venue traded in (its hourly candles) but serves no minutes for: its finest coarser candles
        there, else the hour's candle. Each stretch of history is checked once (side["holes_to"]); the last day is
        left for later, its minutes may still be arriving. A failure leaves the stretch for the next sync: the
        series itself is complete without it."""
        flush()
        if not len(frame):
            return
        ts = frame["ts"].to_numpy(np.int64)
        lo = int(side.get("holes_to") or ts[0] // HOUR * HOUR)
        hi = (int(ts[-1]) - DAY) // HOUR * HOUR
        if hi <= lo:
            return
        try:
            hours = venue.coarse(symbol, 60, lo, hi - 1, stop=stop)
            if stop and stop():
                return
            have = np.unique(ts // HOUR)
            hrs = np.array([r[0] // HOUR for r in hours], np.int64)
            miss = [r for r, held in zip(hours, np.isin(hrs, have)) if not held and r[5] > 0]
            fine_tf = venue.coarse_tfs[0]
            rows, i = [], 0
            while i < len(miss):                                 # one fine request covers the missing hours of its window,
                a = miss[i][0]                                   # which ends on an hour boundary (no hour half-filled)
                b = min(max((a + venue.window * fine_tf * MINUTE) // HOUR * HOUR, a + HOUR) - 1, hi - 1)
                fine = {}
                if fine_tf < 60:
                    for r in venue.coarse(symbol, fine_tf, a, b, stop=stop):
                        fine.setdefault(r[0] // HOUR, []).append(r)
                    if stop and stop():
                        return
                while i < len(miss) and miss[i][0] <= b:
                    rows.extend(fine.get(miss[i][0] // HOUR) or [miss[i]])
                    i += 1
        except Exception:
            return
        if rows:
            take(sorted(rows))
            filled[0] += len(miss)
        side["holes_to"] = hi
        flush()

    def run():
        if not venue.reverse:
            if len(frame):
                cursor = int(frame["ts"].iloc[-1])               # refetched: it may have been forming
                first = int(frame["ts"].iloc[0])
                if side.get("head_walk"):                        # a head walk that was stopped part-way
                    if not head(*side["head_walk"]):
                        return finish("stopped")
                    side["head"] = HEAD_VERSION
                elif venue.head_check and side.get("head") != HEAD_VERSION:
                    sure = True
                    try:
                        deeper = venue.first_ms(symbol)
                        sure = venue.first_is_sure(symbol)
                    except LookupError:
                        deeper = None
                    except Exception:                            # the network: checked again next time, the tail goes on
                        deeper, sure = None, False
                    if deeper is not None and deeper < first:
                        if not head(deeper, first - MINUTE):
                            return finish("stopped")
                        first = deeper
                    if sure:
                        side["head"] = HEAD_VERSION
            else:
                first = venue.first_ms(symbol)
                if first is None:
                    raise LookupError(f"{venue.title} has no candles for {symbol}")
                cursor = first
                if venue.first_is_sure(symbol):                  # else the head check looks again next time
                    side["head"] = HEAD_VERSION
            side["first"] = first
            side["history_done"] = True                          # forward venues start at the first candle
            span = max(1, now_ms - first)
            if hasattr(venue, "stream") and not side.get("stream_done"):   # a venue's archive first (Kraken), resumable
                streamed = None                                  # from where a stopped stream got to; a file the stream did
                for chunk in venue.stream(symbol, int(side.get("stream_at", -1)), stop=stop):   # not write streams all
                    side["stream_at"] = int(chunk[-1][0])        # (set before take: a flush saves it with the rows)
                    take(chunk)
                    streamed = chunk[-1][0]
                    if progress:
                        progress(max(0.0, min(100.0, (streamed - first) / span * 100)), streamed)
                    if stop and stop():
                        return finish("stopped")
                if stop and stop():
                    return finish("stopped")
                side["stream_done"] = True
                if streamed is not None:                         # the API goes on from the archive's end (a file that
                    cursor = streamed + MINUTE                   # held newer rows has them fetched again, its gap with them)
            while True:
                if stop and stop():
                    return finish("stopped")
                end = cursor + venue.window * MINUTE - 1
                rows, last = page(cursor, end)
                if last is not None:
                    if rows:
                        take(rows)
                    if progress:
                        progress(max(0.0, min(100.0, (last - first) / span * 100)), last)
                    if last >= now_ms - MINUTE:
                        break
                    cursor = last + MINUTE
                else:
                    if end >= now_ms:
                        break
                    cursor = end + 1
                time.sleep(venue.pause)
            if venue.coarse_tfs:
                fill_holes()
                if stop and stop():
                    return finish("stopped")
            out = finish("done")
            if out["n"] == 0:
                raise LookupError(f"{venue.title} has no candles for {symbol}")
            return out

        # a reverse venue (OKX): walk back from now to the newest stored candle, then from the oldest one to the listing
        def walk_back(hi, floor, hold=False):
            """fetch_before(hi) repeatedly, back to `floor` (exclusive; None = to the listing). "done" | "dry" | "stopped".
            hold = keep the rows in memory until the walk is complete (a tail walk stopped halfway would otherwise
            leave a hole between the old newest candle and where it stopped, which no later tail walk revisits)."""
            while True:
                if stop and stop():
                    return "stopped"
                rows = venue.fetch_before(symbol, hi, stop=stop)
                if not rows:
                    return "dry"
                if floor is not None:
                    rows = [r for r in rows if r[0] > floor]
                if rows:
                    take(rows, hold)
                    if progress:
                        progress(*_reverse_progress(rows[0][0], floor, list_ms or side.get("first") or 0, now_ms))
                if floor is not None and (not rows or rows[0][0] <= floor + MINUTE):
                    return "done"
                hi = rows[0][0]
                time.sleep(venue.pause)

        newest = int(frame["ts"].iloc[-1]) if len(frame) else None
        holding[0] = newest is not None
        r = walk_back(now_ms + MINUTE, newest, hold=holding[0])
        if r == "stopped":
            return finish("stopped")
        holding[0] = False
        if newest is None and r == "dry":                        # a fresh series: the tail walk reached the listing
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

    try:
        return run()
    except Exception as e:
        try:                                                     # keep what arrived before the error (or the stop)
            out = finish("stopped")
        except Exception:
            out = None
        if out is not None and stop and stop() and not isinstance(e, LookupError):
            return out                                           # stopped part-way through a request: a pause, not a failure
        raise


def _reverse_progress(at_ms: int, floor, first_guess: int, now_ms: int):
    if floor is not None:                                        # catching up the tail: how much of the gap is closed
        span = max(1, now_ms - floor)
        return (max(0.0, min(100.0, (now_ms - at_ms) / span * 100)), at_ms)
    if first_guess and first_guess <= at_ms:                     # walking history back to the listing
        span = max(1, now_ms - first_guess)
        return (max(0.0, min(100.0, (now_ms - at_ms) / span * 100)), at_ms)
    return (0.0, at_ms)


# ---------------------------------------------------------------- which symbols mean a ticker on each venue

REFRESH_S = 86_400


def instruments_path() -> Path:
    return DATA / "venues.json"


def load_instruments(max_age_s: float = REFRESH_S) -> dict:
    """{venue: [instrument rows]} for the non-Bybit venues, cached in data/venues.json for a day; a venue whose
    list cannot be fetched keeps its old list (or an empty one)."""
    p = instruments_path()
    cache = {}
    if p.exists():
        try:
            cache = json.loads(p.read_text(encoding="utf-8"))
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
        X.write_durably(p, lambda f: f.write(json.dumps(cache, separators=(",", ":")).encode()))
    return {name: entry.get("rows", []) for name, entry in cache.items()}


def markets_for(ticker: str, instruments: dict, aliases: dict = None) -> list:
    """One spot and one perp per venue for a ticker (the venue's preferred quote), in DOWNLOAD_ORDER:
    [{"venue", "symbol", "kind", "quote", "list_ms"}]. aliases = {venue base: ticker} as markets.ALIASES.
    1000x contracts (1000PEPE) are not matched: their prices are not the coin's."""
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
