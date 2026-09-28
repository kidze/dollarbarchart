"""Which markets exist on Bybit, what people call them, how deep their history goes, and search.

The instrument list (two keyless requests, ~1,300 USDT/USDC spot pairs and perpetuals) is cached in
data/instruments.json together with every market's first-candle time once probed. Typing "PUMP" must
find the PUMPFUNUSDT perpetual and "NVDA" the NVDAX tokenized stock, and "LIT" must not rank Lumentum
first, so matching works on the ticker people type (base coin with known aliases), then symbol, then name.
"""
import json
import re
import time
import urllib.request
from pathlib import Path

import bybit_sync as X

CACHE = X.DATA / "instruments.json"
WATCHLIST = X.DATA / "watchlist.json"
DEFAULT_WATCHLIST = ["BTC", "ETH", "SOL"]
QUOTES = ("USDT", "USDC")
ALIASES = {"PUMPFUN": "PUMP", "SHIB1000": "SHIB"}   # Bybit base coin -> the ticker people type
REFRESH_S = 86_400
API = "https://api.bybit.com/v5/market/instruments-info"


def _get(url: str) -> dict:
    for attempt in range(4):
        try:
            r = json.load(urllib.request.urlopen(urllib.request.Request(url, headers=X.UA), timeout=30))
            if r.get("retCode") != 0:
                raise RuntimeError(f"bybit retCode {r.get('retCode')}: {r.get('retMsg')}")
            return r["result"]
        except RuntimeError:
            raise
        except Exception:
            if attempt == 3:
                raise
            time.sleep(2 * (attempt + 1))
    return {}


def fetch_instruments() -> dict:
    """Trading USDT/USDC spot pairs and linear perpetuals (no dated futures), minimal fields."""
    out = {"fetched": int(time.time()), "spot": [], "linear": []}
    for category in X.CATEGORIES:
        cursor = ""
        while True:
            res = _get(f"{API}?category={category}&limit=1000" + (f"&cursor={cursor}" if cursor else ""))
            for it in res.get("list", []):
                if it.get("status") != "Trading" or it.get("quoteCoin") not in QUOTES:
                    continue
                if category == "linear" and it.get("contractType") != "LinearPerpetual":
                    continue
                out[category].append({"symbol": it["symbol"], "base": it["baseCoin"], "quote": it["quoteCoin"],
                                      "name": it.get("fullName") or "", "type": it.get("symbolType") or "",
                                      "underlying": it.get("underlyingTicker") or "", "launch": int(it.get("launchTime") or 0)})
            cursor = res.get("nextPageCursor") or ""
            if not cursor:
                break
    return out


def ticker_of(base: str, symbol_type: str) -> str:
    if base in ALIASES:
        return ALIASES[base]
    if symbol_type == "xstocks" and base.endswith("X"):    # NVDAX = tokenized NVDA
        return base[:-1]
    return base


def build_rows(raw: dict, first: dict) -> list:
    """One row per market with the display ticker, a name (spot rows borrow it from the perp) and depth."""
    names = {}
    for r in raw.get("linear", []):
        if r["name"]:
            names.setdefault(ticker_of(r["base"], r["type"]), r["name"])
            names.setdefault(r["base"], r["name"])
    rows = []
    for category in X.CATEGORIES:
        for r in raw.get(category, []):
            ticker = ticker_of(r["base"], r["type"])
            key = f"{category}:{r['symbol']}"
            rows.append({"key": key, "category": category, "kind": "spot" if category == "spot" else "perp",
                         "symbol": r["symbol"], "base": r["base"], "quote": r["quote"], "ticker": ticker,
                         "name": r["name"] or names.get(ticker, "") or names.get(r["base"], ""),
                         "stock": r["type"] in ("stock", "xstocks", "ETF") or bool(r["underlying"]),
                         "launch": r["launch"], "first": first.get(key)})
    return rows


_LEAD_DIGITS = re.compile(r"^\d+")


def search(rows: list, q: str, limit: int = 60) -> list:
    """Rank: exact ticker, ticker prefix, symbol prefix, name prefix, name/symbol contains. USDT before USDC,
    perps before spot within a ticker (the picker then puts the deeper history first once known)."""
    q = q.strip().upper()
    if not q:
        return []
    scored = []
    for r in rows:
        t, b, s, n = r["ticker"], r["base"], r["symbol"], r["name"].upper()
        bare = _LEAD_DIGITS.sub("", b)                        # 1000PEPE -> PEPE
        if q in (t, b, bare):
            sc = 0
        elif t.startswith(q) or bare.startswith(q):
            sc = 1
        elif s.startswith(q):
            sc = 2
        elif n.startswith(q):
            sc = 3
        elif q in n or (len(q) >= 3 and q in s):
            sc = 4
        else:
            continue
        scored.append((sc, len(t), t, r["quote"] != "USDT", r["kind"] != "perp", r))
    scored.sort(key=lambda x: x[:5])
    return [x[-1] for x in scored[:limit]]


def candidates(rows: list, ticker: str) -> list:
    """Every market a typed ticker can mean: display ticker, raw base, or the base without a 1000x prefix
    (1000XEC, 10000SATS) — the same names search() matches, so Enter never says "nothing" under a hit."""
    t = ticker.strip().upper()
    if not t:
        return []
    out = [r for r in rows if t in (r["ticker"], r["base"], _LEAD_DIGITS.sub("", r["base"]))]
    out.sort(key=lambda r: (r["quote"] != "USDT", r["kind"] != "perp"))
    return out


def deepest(cands: list):
    """The market with the earliest known first candle; perps and USDT win ties. None if depth is unknown."""
    known = [r for r in cands if r.get("first")]
    if not known:
        return None
    return min(known, key=lambda r: (r["first"], r["kind"] != "perp", r["quote"] != "USDT"))


def load_cache():
    if CACHE.exists():
        try:
            c = json.loads(CACHE.read_text(encoding="utf-8"))
            return c.get("raw"), c.get("first", {})
        except Exception:
            pass
    return None, {}


def save_cache(raw: dict, first: dict) -> None:
    CACHE.parent.mkdir(exist_ok=True)
    tmp = CACHE.with_suffix(".tmp")
    tmp.write_text(json.dumps({"raw": raw, "first": first}, separators=(",", ":")), encoding="utf-8")
    tmp.replace(CACHE)


def load_watchlist() -> list:
    if WATCHLIST.exists():
        try:
            wl = json.loads(WATCHLIST.read_text(encoding="utf-8"))
            if isinstance(wl, list):
                return [t for t in dict.fromkeys(x.strip().upper() for x in wl if isinstance(x, str)) if t]
        except Exception:
            pass
    return list(DEFAULT_WATCHLIST)


def save_watchlist(wl: list) -> None:
    WATCHLIST.parent.mkdir(exist_ok=True)
    tmp = WATCHLIST.with_suffix(".tmp")
    tmp.write_text(json.dumps(wl, indent=0), encoding="utf-8")
    tmp.replace(WATCHLIST)
