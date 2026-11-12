"""Local server for the dollar-bar chart: many markets, one at a time on screen.

Serves index.html and JSON on 127.0.0.1:8793. A market ("linear:BTCUSDT", "spot:PUMPUSDT") is loaded
from its parquet when a page asks for it, caught up to now (first time: a full backfill that the chart
watches grow), then polled every 5 s so the forming bar moves. A combined market ("all:BTC", the default)
is a ticker on every exchange that lists it (Binance, Bybit, OKX, Coinbase, KuCoin, Bitfinex; spot and
perpetual; see venues.py): each series is downloaded into its own file, the exchanges in parallel, and
merged into one series (combined.py) whose dollars are the sum and whose prices are the dollar-weighted
median of the exchanges that traded each minute. One background worker does all downloads,
in this order: the market on screen, then the daily instrument-list refresh, then first-candle probes for
the search index, then the watchlist (data/watchlist.json) so those open instantly next time. Nothing
runs when no window is open: two minutes after the last page request the worker is told to stop,
everything is written to disk and the process exits; the next launch resumes.

It also watches its own source files: once they have stopped changing for a minute, /live carries an
`update` notice and the page shows a banner. "Update now" reloads the page if only the page changed, or
calls /restart, which hands the port to a fresh copy of this server and exits; the page reconnects and
reloads by itself.

  /bars?m=&k=   full history of bar set k of a market (one call per page load or menu change); a dollar
                size that is gone (or d:null) gets the nearest size left (the median day for null), the
                same pick the page makes; every set when k is absent
  /live?m=      the last two completed bars + the forming bar of every set (polled every 5 s)
  /search?q=    markets matching what was typed (empty q = the watchlist)
  /pick?t=      resolve a ticker to the market with the most history (probes depth if unknown)
  /watchlist?add=T | ?remove=T
  /drawings?m=  the market's saved drawings and their revision (GET), or change some (POST {"upsert": [...], "delete": [ids]})
  /settings     the chart's saved look (GET), or change some of its keys (POST {"settings": {key: value, ...}})
  /static/<f>   the page's scripts and styles
  /ping, /restart
"""
import http.server
import json
import os
import re
import subprocess
import sys
import threading
import time
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from concurrent.futures import ThreadPoolExecutor, wait

import numpy as np
import pandas as pd

import bars as B
import bybit_sync as X
import combined as C
import markets as MK
import userdata as U
import venues as V

HERE = Path(__file__).resolve().parent
PORT = int(os.environ.get("DOLLARBARS_PORT", "8793"))         # a dev checkout runs on another port next to the live app
POLL_S = 5
IDLE_EXIT_S = 120
LOOK_S = 60                                                      # a market counts as "on screen" this long after its last request
KEEP_LOADED = 3
WATCH_STALE_S = 86_400
QUIET_S = 60                                                     # an update is offered only after the source files stopped changing for this long
DEFAULT_MARKET = "all:BTC"
CORE = ["server.py", "bars.py", "bybit_sync.py", "markets.py", "userdata.py", "venues.py", "combined.py", "index.html", "lightweight-charts.js"]
REBUILD_S = 300                                                  # a combined market is re-merged this often while its history downloads
PRICE_BAND = 0.10                                                # a series whose price is further than this from the reference is another coin
LIVE_GAP_S = 100                                                 # an exchange unanswered this long missed minutes its 3-minute poll no longer covers
STALE_PRICE_S = 3600                                             # the price check ignores a last candle older than this (a quiet pair)
REPLAN_S = 3600                                                  # an exchange's missing market list is asked for again after this
RESYNC_S = 900                                                   # a combined market with a failed exchange tries it (only it) again after this
CACHE_REFRESH_DAYS = 7                                           # the merge cache is rewritten once the days merged on top of it reach this
POOL = ThreadPoolExecutor(12, thread_name_prefix="live")         # the combined markets' live polls, all exchanges at once
STATIC = HERE / "static"
PAGE_TYPES = {".js": "application/javascript", ".css": "text/css"}

STATE = {"markets": {}, "stop": False, "restarting": False, "last_req": time.time(), "started": time.time(),
         "build": {}, "update": None, "candidate": None, "candidate_at": 0.0,
         "index": None, "index_status": "loading instruments", "index_first": {}, "index_raw": None, "index_dirty": False,
         "index_stale": False, "index_fetched": 0.0, "index_retry_at": 0.0, "scan_failed": set(), "bg_retry_at": 0.0,
         "watchlist": [], "watch_done": set()}
LOCK = threading.RLock()
WORKER_DONE = threading.Event()
SRV = None


class Market:
    def __init__(self, key: str):
        self.key = key
        self.cd = None                                           # bars.Candles once loaded
        self.sets = None
        self.meta = {}
        self.built_n = 0                                         # candles the bar sets were last built from
        self.sync = "queued"                                     # queued | loading | backfilling | live | failed: ...
        self.progress = None                                     # {"pct", "at"} while backfilling
        self.first_ms = None
        self.last_req = time.time()
        self.updated = 0.0
        self.synced = False                                      # reached "now" at least once this session
        self.live_err = ""                                       # last live-poll or download error, shown on the page until rows arrive
        self.notice = ""                                         # why a market on disk is downloading from scratch (shown until it is live)
        self.retry_at = 0.0                                      # a download that failed is retried after a pause
        self.persist_lock = threading.Lock()                     # one writer per market
        self.venues = None                                       # all:<T> only: the series it is made of (see plan_all)
        self.live_rows = {}                                      # all:<T> only: label -> {minute: newest row seen live}
        self.built_at = 0.0                                      # all:<T> only: when the merged series was last rebuilt
        self.weights = {}                                        # all:<T> only: label -> its dollars over the last day (its say in live prices)
        self.built_done = 0                                      # all:<T> only: how many series were done at that merge
        self.resync_at = 0.0                                     # all:<T> only: an exchange failed, try again after this
        self.retry_failed = False                                # all:<T> only: the next sync retries just the failed exchanges
        self.replan = False                                      # all:<T> only: an exchange's market list was missing at plan time: plan again
        self.live_ok = {}                                        # all:<T> only: label -> when its live poll last answered
        self.live_stale = False                                  # all:<T> only: an exchange missed live minutes: re-merge from the files

    @property
    def combined(self) -> bool:
        return self.key.startswith("all:")


def parse_key(key: str) -> tuple:
    """'linear:BTCUSDT' -> ('linear', 'BTCUSDT'); 'all:BTC' -> ('all', 'BTC'). Rejects anything else."""
    if key.startswith("all:"):
        t = key[4:]
        if not t or not t.isalnum() or t != t.upper():
            raise ValueError(f"bad market key {key!r}")
        return "all", t
    return X.parse(key)


def log(msg: str) -> None:
    print(time.strftime("%H:%M:%S"), msg, flush=True)


# ---------------------------------------------------------------- update detection / restart

def sources() -> list:
    """The files whose change is an update: the server's modules, the page, and everything the page loads from static/."""
    try:
        extra = sorted("static/" + p.name for p in STATIC.iterdir() if p.suffix in PAGE_TYPES)
    except OSError:
        extra = []
    return CORE + extra


def build_id() -> dict:
    out = {}
    for f in sources():
        p = HERE / f
        try:
            st = p.stat()
            out[f] = [int(st.st_mtime), st.st_size]
        except OSError:                                          # being replaced right now (git checkout): counts as changed
            pass
    return out


def build_tag(b: dict) -> str:
    return f"{max((v[0] for v in b.values()), default=0)}-{sum(v[1] for v in b.values())}"


def page_tag() -> tuple:
    """(tag of the page's files on disk now, newest of their modification times)."""
    page = {f: v for f, v in build_id().items() if not f.endswith(".py")}
    return build_tag(page), max((v[0] for v in page.values()), default=0)


def page_stale(pb) -> bool:
    """The asking window was served other page files than the ones on disk (an update arrived while it stayed open, or
    the server was restarted without the window reloading). Only once the files have been quiet for QUIET_S."""
    tag, newest = page_tag()
    return pb != tag and time.time() - newest >= QUIET_S


def check_update() -> None:
    """Offer an update only once the files have been stable for QUIET_S, so a half-written set of files
    (an edit in progress, a checkout half done) is never handed to a restart."""
    b = build_id()
    if b == STATE["build"]:
        STATE["update"] = STATE["candidate"] = None
        return
    now = time.time()
    if b != STATE["candidate"]:                                  # first sight of this set, or it moved again: restart the quiet clock
        STATE["candidate"], STATE["candidate_at"] = b, now
        if STATE["update"]:
            log("update withdrawn: source files still changing")
        STATE["update"] = None
        return
    if now - STATE["candidate_at"] < QUIET_S:
        return
    changed = [f for f in dict.fromkeys(list(STATE["build"]) + list(b)) if b.get(f) != STATE["build"].get(f)]
    kind = "restart" if any(f.endswith(".py") for f in changed) else "reload"
    if STATE["update"] is None or STATE["update"]["files"] != changed:
        log(f"update available ({kind}): {', '.join(changed)}")
    STATE["update"] = {"kind": kind, "files": changed}


def update_settled() -> bool:
    b = build_id()
    return b == STATE["candidate"] and time.time() - STATE["candidate_at"] >= QUIET_S


def page_served() -> None:
    """The page just loaded the current index.html and its scripts, so those no longer count as pending updates."""
    b = build_id()
    for f in [f for f in STATE["build"] if not f.endswith(".py") and f not in b]:
        del STATE["build"][f]
    for f, v in b.items():
        if not f.endswith(".py"):
            STATE["build"][f] = v
    check_update()


def restart() -> None:
    time.sleep(0.3)                                              # let the /restart response leave first
    log("restarting for update")
    STATE["restarting"] = True
    STATE["stop"] = True
    WORKER_DONE.wait(30)
    persist_all()
    SRV.shutdown()                                               # serve_forever() returns in the main thread, see main()


def spawn_successor() -> None:
    kw = dict(cwd=str(HERE), stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    if os.name == "nt":
        kw["creationflags"] = subprocess.DETACHED_PROCESS | subprocess.CREATE_NEW_PROCESS_GROUP
    else:
        kw["start_new_session"] = True
    subprocess.Popen([sys.executable, str(HERE / "server.py")], **kw)


def open_log() -> None:
    """All output goes to logs/server.log, opened by this process itself (a launcher's shell redirect would
    lock the file on Windows and stop a restarted copy from opening it; pythonw has no console at all)."""
    (HERE / "logs").mkdir(exist_ok=True)
    f = open(HERE / "logs" / "server.log", "a", buffering=1, encoding="utf-8", errors="replace")
    sys.stdout = sys.stderr = f


# ---------------------------------------------------------------- markets in memory

def touch(key: str) -> Market:
    """The page asked for this market: make sure it exists and mark it as on screen."""
    parse_key(key)
    with LOCK:
        m = STATE["markets"].get(key)
        if m is None:
            m = STATE["markets"][key] = Market(key)
            log(f"{key}: requested")
        m.last_req = time.time()
        return m


def on_screen(m: Market, now=None) -> bool:
    return (now or time.time()) - m.last_req < LOOK_S


def persist(m: Market) -> None:
    """Write the market's candles to its parquet (atomic). Serialized per market so two callers never share a .tmp.
    A combined market is never written: its parts are, by their own syncs, and it is merged again from them."""
    if m.combined:
        return
    with m.persist_lock:
        with LOCK:
            cd = m.cd
            if cd is None or cd.dirty_from >= cd.n:
                return
            frame = cd.frame()
            cd.dirty_from = cd.n
        try:
            X.save(m.key, frame)
        except Exception:
            with LOCK:
                if m.cd is cd:
                    cd.dirty_from = min(cd.dirty_from, 0)     # keep it dirty: the next persist retries
            raise


def persist_all() -> None:
    """Never raises: one bad write must not stop the exit or the restart handoff."""
    for m in list(STATE["markets"].values()):
        try:
            persist(m)
        except Exception as e:
            log(f"{m.key}: persist failed: {type(e).__name__}: {e}")
    try:
        save_index()
    except Exception as e:
        log(f"instrument cache save failed: {type(e).__name__}: {e}")


def unload(m: Market) -> None:
    persist(m)
    with LOCK:
        m.cd, m.sets, m.built_n = None, None, 0
        if m.sync == "live":
            m.sync = "queued"                                    # reload from disk when asked again
        log(f"{m.key}: unloaded")


def evict() -> None:
    """Keep memory bounded: at most KEEP_LOADED markets in memory, dropping the least recently viewed."""
    with LOCK:
        loaded = [m for m in STATE["markets"].values() if m.cd is not None]
        loaded.sort(key=lambda m: m.last_req)
        victims = [m for m in loaded[:-KEEP_LOADED]] if len(loaded) > KEEP_LOADED else []
    for m in victims:
        if not on_screen(m):
            unload(m)


def market_info(key: str) -> dict:
    category, symbol = parse_key(key)
    info = {"key": key, "ticker": symbol, "name": "", "kind": "all" if category == "all" else "spot" if category == "spot" else "perp",
            "symbol": "" if category == "all" else symbol, "quote": "", "first": None, "stock": False, "found": False}
    idx = STATE["index"]
    if idx:
        for r in idx:
            if category == "all" and r["ticker"] == symbol:
                info.update({"name": r["name"], "stock": r["stock"], "found": True})
                break
            if r["key"] == key:
                info.update({k: r[k] for k in ("ticker", "name", "kind", "symbol", "quote", "first", "stock")}, found=True)
                break
    info["watch"] = info["ticker"] in STATE["watchlist"]
    return info


def meta_of(m: Market) -> dict:
    out = dict(m.meta, sync=m.sync, progress=m.progress, updated=m.updated, live_err=m.live_err[:120], notice=m.notice,
               build=build_tag(STATE["build"]), update=STATE["update"], market=market_info(m.key),
               index_status=STATE["index_status"], source=source_text(m))
    if m.combined:
        out["venues"] = [{k: s.get(k) for k in ("label", "status", "pct", "n", "first", "exact", "note")} for s in (m.venues or [])]
    return out


def source_text(m: Market) -> str:
    if m.combined:
        parts = [s["label"] for s in (m.venues or []) if not s["status"].startswith("absent") and s.get("n")]
        approx = [s["label"] for s in (m.venues or []) if not s.get("exact", True) and s.get("n")]
        return ("Combined: " + (" + ".join(parts) if parts else "every exchange that lists it") +
                ". 1-minute candles; dollars are summed across exchanges, each price is the dollar-weighted median of the exchanges "
                "that traded that minute" + (f" ({', '.join(approx)} report coin volume only: dollars = volume × close)" if approx else "") +
                f"; a price {C.SPIKE:g}× away from the minutes around it that no second exchange shows is a bad print and is repaired,"
                f" and a minute only a much smaller exchange traded is held within {C.LONE_BAND:.0%} of the bigger ones around it"
                "; hours an exchange serves no minutes for are filled from its 5-minute or hourly candles where it has them")
    info = market_info(m.key)
    what = "perpetual" if info["kind"] == "perp" else "spot"
    return f"Bybit {info['symbol']} {what}, 1-minute candles, dollars = exchange-reported turnover"


# ---------------------------------------------------------------- instrument index

def load_index() -> None:
    """The cached list is usable at once, stale or not; a refresh is a worker job that runs behind the
    on-screen market, so a slow or absent network never delays a chart that is already on disk."""
    raw, first = MK.load_cache()
    with LOCK:
        STATE["index_first"] = dict(first, **STATE["index_first"])   # probes made this session win
    if raw:
        STATE["index_raw"] = raw
        STATE["index_fetched"] = raw.get("fetched", 0)
        rebuild_index()
        STATE["index_status"] = "ok"
    STATE["index_stale"] = not raw or time.time() - STATE["index_fetched"] >= MK.REFRESH_S


def refresh_index() -> None:
    """Fetch the instrument list now (two requests) and rebuild; keeps the probed first-candle times."""
    raw = MK.fetch_instruments()
    STATE["index_raw"] = raw
    STATE["index_fetched"] = raw["fetched"]
    STATE["index_dirty"] = True
    STATE["index_stale"] = False
    log(f"instruments fetched: {len(raw['spot'])} spot, {len(raw['linear'])} perps")
    rebuild_index()
    STATE["index_status"] = "ok"
    save_index()


def rebuild_index() -> None:
    with LOCK:
        STATE["index"] = MK.build_rows(STATE["index_raw"], STATE["index_first"])


def save_index() -> None:
    with LOCK:
        if not STATE["index_dirty"] or STATE["index_raw"] is None:
            return
        raw, first = STATE["index_raw"], dict(STATE["index_first"])
        STATE["index_dirty"] = False
    try:
        MK.save_cache(raw, first)
    except Exception:
        with LOCK:
            STATE["index_dirty"] = True                          # retried on the next persist / exit
        raise


def probe_first(key: str, quick: bool = False):
    """First-candle time of a market, probed once and cached (0 = Bybit has no candles for it)."""
    with LOCK:
        if key in STATE["index_first"]:
            return STATE["index_first"][key] or None
    ms = X.first_candle_ms(key, quick=quick)
    with LOCK:
        STATE["index_first"][key] = ms or 0
        STATE["index_dirty"] = True
        if STATE["index"]:
            for r in STATE["index"]:
                if r["key"] == key:
                    r["first"] = ms
    return ms


def resolve(ticker: str, quick: bool = False) -> tuple:
    """(deepest market row or None, candidate rows) for a ticker, probing unknown depths (a few requests).
    quick = the interactive path: one short attempt per candidate, unknown stays unknown."""
    idx = STATE["index"] or []
    cands = MK.candidates(idx, ticker)
    if not cands and idx and time.time() - STATE["index_fetched"] > 600:   # maybe listed since the last fetch
        try:
            refresh_index()
            cands = MK.candidates(STATE["index"], ticker)
        except Exception as e:
            log(f"instrument refresh on miss failed: {type(e).__name__}")
    for r in cands:
        if r.get("first") is None:
            try:
                r["first"] = probe_first(r["key"], quick=quick)
            except Exception as e:
                log(f"{r['key']}: depth probe failed: {type(e).__name__}")
    return MK.deepest(cands), cands


def scan_pending() -> list:
    """Markets whose first-candle time is still unknown, the watchlist's own candidates first so the picker
    can show "most history" for the tickers that matter before the long tail is probed."""
    rows = [r for r in (STATE["index"] or [])
            if r.get("first") is None and r["key"] not in STATE["index_first"] and r["key"] not in STATE["scan_failed"]]
    wl = set(STATE["watchlist"])
    rows.sort(key=lambda r: (r["ticker"] not in wl, r["kind"] != "perp"))
    return [r["key"] for r in rows]


# ---------------------------------------------------------------- the worker: downloads, one job at a time

def next_job(current=None):
    """current = the job in progress: a running market job is kept while its market is still on screen, unless
    another on-screen market was asked for clearly later (a ticker switch), so two windows do not thrash."""
    with LOCK:
        now = time.time()
        looked = [m for m in STATE["markets"].values()
                  if on_screen(m, now) and m.sync in ("queued", "loading", "backfilling") and m.retry_at <= now]
        if looked:
            best = max(looked, key=lambda m: m.last_req)
            if current and current[0] == "market":
                cur = STATE["markets"].get(current[1])
                if cur in looked and best.last_req - cur.last_req < 2 * POLL_S:
                    return current
            return ("market", best.key)
        if now < STATE["bg_retry_at"]:
            return None
        if STATE["index_stale"] and now >= STATE["index_retry_at"]:
            return ("index", None)
        if STATE["index"] and scan_pending():
            return ("scan", None)
        if STATE["index"]:
            for t in STATE["watchlist"]:
                if t not in STATE["watch_done"]:
                    return ("watch", t)
    return None


def preempted(job) -> bool:
    return STATE["stop"] or next_job(job) != job


def sync_market(m: Market, job) -> None:
    if m.combined:
        only, m.retry_failed = m.retry_failed, False
        return sync_all(m, job, only_failed=only)
    if m.cd is None:
        m.sync = "loading"
        try:
            frame = X.load(m.key)
        except X.Damaged as e:                                   # e.g. cut power mid-write before writes were durable: start over
            aside = X.set_aside(m.key)
            log(f"{m.key}: saved candles unreadable ({e}); kept as {aside.name}, downloading again")
            m.notice = "the saved file was damaged (power cut?), downloading it again"
            frame = X.load(m.key)
        cd = B.Candles(frame)
        with LOCK:
            m.cd = cd
            if cd.n:
                m.sets, m.meta = B.build_all(cd)
                m.built_n = cd.n
                m.updated = time.time()
    cd = m.cd
    if cd.n:
        cursor = int(cd.ts[cd.n - 1])
    else:
        cursor = probe_first(m.key)
        if cursor is None:
            m.sync = "failed: Bybit has no candles for this market"
            return
    m.first_ms = int(cd.ts[0]) if cd.n else cursor
    m.sync = "backfilling"

    def resize(force=False):
        """The median day (and so the size menu) moves as history arrives: rebuild when it doubled or halved,
        and once more at the end if anything new came in."""
        with LOCK:
            if m.sets is None or cd.n == 0:
                return
            auto = B.auto_size(cd)
            cur = m.meta.get("auto_size") or auto
            moved = auto >= 2 * cur or auto <= cur / 2
            if (moved and cd.n - m.built_n >= 1440) or (force and cd.n - m.built_n >= 60):
                m.sets, m.meta = B.build_all(cd)
                m.built_n = cd.n

    def on_rows(rows):
        with LOCK:
            cd.upsert(rows)
            if m.sets is None:
                m.sets, m.meta = B.build_all(cd)
                m.built_n = cd.n
            else:
                B.update_all(m.sets, cd)
                m.meta["last"] = int(cd.ts[cd.n - 1] // 1000)
                m.meta["n_candles"] = int(cd.n)
            now_ms = time.time() * 1000
            span = max(1.0, now_ms - m.first_ms)
            m.progress = {"pct": min(100.0, round((rows[-1][0] - m.first_ms) / span * 100, 1)), "at": int(rows[-1][0] // 1000)}
            m.updated = time.time()
            m.live_err = ""

    def checkpoint(requests):
        persist(m)
        resize()

    stop = lambda: preempted(job)
    result = X.sync(m.key, on_rows, cursor, stop=stop, checkpoint=checkpoint)
    if result == "done":
        persist(m)                                               # a pause keeps its rows in memory; checkpoints, eviction and exit write them
        resize(force=True)
        with LOCK:
            m.sync = "live"
            m.progress = None
            m.synced = True
            m.live_err = ""
            m.notice = ""
        log(f"{m.key}: live with {cd.n:,} candles")
    else:
        log(f"{m.key}: backfill paused at {m.progress['at'] if m.progress else '?'}")


# ---------------------------------------------------------------- combined markets: all:<TICKER>

def plan_all(ticker: str) -> tuple:
    """The series a combined market is made of: one spot and one perp per exchange. On Bybit, the deepest
    market of each kind whose display ticker is exactly this one (USDT first; 1000x contracts are left out
    because their prices are not the coin's). Each entry tracks its own download: status queued | syncing |
    done | paused | absent: why | failed: why. Returns (series, exchanges whose market list is missing)."""
    series = []
    exact = [r for r in MK.candidates(STATE["index"] or [], ticker) if r["ticker"] == ticker and r.get("first") != 0]
    for kind in ("perp", "spot"):
        rows = [r for r in exact if r["kind"] == kind]
        if rows:
            r = min(rows, key=lambda r: (r.get("first") or float("inf"), r["quote"] != "USDT"))
            series.append({"venue": "bybit", "symbol": r["key"], "kind": kind, "list_ms": 0})
    try:
        inst = V.load_instruments()
    except Exception as e:
        log(f"{ticker}: exchange instrument lists failed: {type(e).__name__}: {e}")
        inst = {}
    missing = [v for v in V.VENUES if v != "bybit" and not inst.get(v)]
    for g in V.markets_for(ticker, inst, MK.ALIASES):
        if g["venue"] != "bybit":
            series.append({"venue": g["venue"], "symbol": g["symbol"], "kind": g["kind"], "list_ms": g["list_ms"]})
    for s in series:
        v = V.VENUES[s["venue"]]
        s.update(label=v.label(s["symbol"], s["kind"]), exact=v.exact_dollars, status="queued", pct=None, n=0, first=None, note="")
    return series, missing


def latest_price(s: dict):
    try:
        rows = V.VENUES[s["venue"]].latest(s["symbol"], 2)
        return rows[-1][4] if rows and rows[-1][0] >= (time.time() - STALE_PRICE_S) * 1000 else None
    except Exception:
        return None


def price_check(m: Market, series=None) -> None:
    """A ticker means different coins on different exchanges now and then (LIT is Lighter on Bybit and
    Litentry on KuCoin; OKX's QNT perp is not Quant). Every series' latest price is compared with Bybit's
    perp (else Bybit's spot, else the median of all answers); one further than PRICE_BAND away is left out.
    A series that does not answer (or has not traded for an hour) stays in: trust() checks its history against
    the reference at merge time. series = the ones to judge (default: all)."""
    prices = list(POOL.map(latest_price, m.venues))
    ref = next((px for s, px in zip(m.venues, prices) if s["venue"] == "bybit" and s["kind"] == "perp" and px), None)
    ref = ref or next((px for s, px in zip(m.venues, prices) if s["venue"] == "bybit" and px), None)
    ref = ref or (float(np.median([px for px in prices if px])) if any(prices) else None)
    if not ref:
        return
    judged = m.venues if series is None else series
    for s, px in zip(m.venues, prices):
        if px and abs(px / ref - 1) > PRICE_BAND and any(s is j for j in judged):
            s["status"] = f"absent: price {px:g} vs {ref:g}, another coin with this ticker?"
            log(f"{m.key}: {s['label']} left out: {s['status']}")


def cache_paths(ticker: str) -> tuple:
    p = X.DATA / f"all_{ticker}.parquet"
    return p, p.with_suffix(".json")


def merged_frame(m: Market) -> pd.DataFrame:
    """Every series from disk, trimmed to the history that is the same coin (combined.trust, against Bybit's perp,
    else Bybit's spot, else the longest series), merged. The merge up to the start of the last complete day
    is cached in data/all_<T>.parquet: when no series changed before that point only the days after it are
    merged again (BTC: seconds instead of a minute)."""
    _, ticker = parse_key(m.key)
    order = {v: i for i, v in enumerate(V.PRIORITY)}
    parts = sorted([s for s in m.venues if not s["status"].startswith("absent")], key=lambda s: (s["kind"] != "perp", order.get(s["venue"], 9)))
    loaded = []
    for s in parts:
        try:
            f = V.load(s["venue"], s["symbol"])
        except X.Damaged as e:
            log(f"{m.key}: {s['label']} unreadable ({e}), downloading it again")
            if s["venue"] == "bybit":
                X.set_aside(s["symbol"])
            else:
                V.set_aside(s["venue"], s["symbol"])
            s["status"] = "queued"
            continue
        if len(f):
            loaded.append((s, f))
    ref = next((f for s, f in loaded if s["venue"] == "bybit" and s["kind"] == "perp"), None)
    ref = ref if ref is not None else next((f for s, f in loaded if s["venue"] == "bybit"), None)
    ref = ref if ref is not None else (max((f for _, f in loaded), key=len) if loaded else None)
    ref_kept = C.trust(ref, None, jumps=False) if ref is not None else None
    ref_daily = C.daily_close(ref_kept) if ref_kept is not None else None
    frames, labels = [], []
    for s, f in loaded:
        kept = ref_kept if f is ref else C.trust(f, ref_daily)
        if len(kept) == len(f):
            s["note"] = ""
        elif not len(kept):
            s["note"] = "its history is another coin: left out"
        else:
            s["note"] = "kept from " + time.strftime("%Y-%m-%d", time.gmtime(int(kept["ts"].iloc[0]) / 1000))
        if len(kept):
            s["n"], s["first"] = int(len(kept)), int(kept["ts"].iloc[0])
            frames.append(kept)
            labels.append(s["label"])
        else:
            s["n"] = 0
    if not frames:
        return C.merge([])
    m.weights = {lab: float(f["turnover"].to_numpy(float)[f["ts"].to_numpy(np.int64) > int(f["ts"].iloc[-1]) - C.DAY].clip(min=0).sum())
                 for lab, f in zip(labels, frames)}
    cp, cj = cache_paths(ticker)
    base, cut = None, None
    try:
        side = json.loads(cj.read_text(encoding="utf-8")) if cj.exists() else None
        if side and side.get("method") == C.METHOD and sorted(side["parts"]) == sorted(labels):
            cut = int(side["last"])
            if all(side["parts"][lab] == [int(f["ts"].iloc[0]), int(np.searchsorted(f["ts"].to_numpy(np.int64), cut))]
                   for lab, f in zip(labels, frames)):
                base = pd.read_parquet(cp)
                base = base[base["ts"] < cut]
    except Exception as e:
        log(f"{m.key}: merge cache unusable ({type(e).__name__}), merging everything")
        base = None
    complete = all(s["status"] == "done" or s["status"].startswith("absent") for s in m.venues)
    today = int(time.time() * 1000) // C.DAY * C.DAY
    if base is not None:                                         # (the cached part was repaired when it was written)
        merged = pd.concat([base, C.merge(frames, since=cut)], ignore_index=True)
        merged, fixed = C.despike(merged, frames, start=len(base))
        if fixed:
            log(f"{m.key}: {fixed} off-price minutes no other exchange confirms repaired")
        if not (complete and today - cut >= CACHE_REFRESH_DAYS * C.DAY):
            return merged
    else:
        merged, fixed = C.despike(C.merge(frames), frames)
        if fixed:
            log(f"{m.key}: {fixed} off-price minutes no other exchange confirms repaired")
    if complete:
        cut = min(today, int(merged["ts"].iloc[-1]) - C.LONE_SPAN * C.MINUTE) if len(merged) else today   # complete days only (today keeps
                                                                 # changing), and not the minutes lone_bands() has not checked yet
        try:
            head = merged[merged["ts"] < cut]
            X.write_durably(cp, lambda fh: head.to_parquet(fh, index=False))
            fp = {lab: [int(f["ts"].iloc[0]), int(np.searchsorted(f["ts"].to_numpy(np.int64), cut))] for lab, f in zip(labels, frames)}
            X.write_durably(cj, lambda fh: fh.write(json.dumps({"method": C.METHOD, "last": cut, "parts": fp}).encode()))
        except Exception as e:
            log(f"{m.key}: merge cache not written: {type(e).__name__}: {e}")
    return merged


def rebuild_all(m: Market) -> None:
    t0 = time.time()
    frame = merged_frame(m)
    cd = B.Candles(frame)
    sets, meta = (B.build_all(cd) if cd.n else (None, {}))
    with LOCK:
        m.cd, m.sets, m.meta, m.built_n = cd, sets, meta, cd.n
        m.first_ms = int(cd.ts[0]) if cd.n else None
        m.built_at = m.updated = time.time()
        m.built_done = sum(1 for s in m.venues or [] if s["status"] == "done")
    log(f"{m.key}: merged {cd.n:,} minutes from {sum(1 for s in m.venues if s.get('n'))} series in {time.time() - t0:.1f}s")


def sync_part(m: Market, s: dict, stop) -> None:
    """Catch one series' file up to now (first time: its whole history)."""
    if s["venue"] == "bybit":                                    # the plain Bybit market of the same key shares the file
        plain = STATE["markets"].get(s["symbol"])
        if plain is not None and plain.cd is not None:
            if on_screen(plain):                                 # open in another window: its own sync and live poll keep it current
                persist(plain)
                s["status"] = "done"
                return
            unload(plain)
    s["status"], s["pct"] = "syncing", 0.0

    def progress(pct, at):
        s["pct"] = round(pct, 1)
        s["at"] = int(at // 1000)

    def flushed():                                               # rows on disk: the next periodic merge takes them in
        s["grew"] = True

    try:
        res = V.sync(V.VENUES[s["venue"]], s["symbol"], progress=progress, stop=stop, checkpoint=flushed,
                     list_ms=s.get("list_ms") or 0)
    except LookupError as e:
        s["status"] = f"absent: {e}"[:160]
        log(f"{m.key}: {s['label']} left out: {e}")
        return
    except Exception as e:
        s["status"] = f"failed: {type(e).__name__}"
        m.live_err = f"{s['label']}: {type(e).__name__}: {e}"
        log(f"{m.key}: {s['label']} failed: {type(e).__name__}: {e}")
        return
    s["n"], s["first"], s["pct"] = res["n"], res["first"], 100.0
    if res.get("filled"):
        log(f"{m.key}: {s['label']}: {res['filled']} hours without minutes filled from its coarser candles")
    s["grew"] = s.get("grew") or res["grew_back"] or res["prev_last"] is None or bool(res.get("filled"))
    s["status"] = "paused" if res["result"] == "stopped" else "done"


def refresh_tail(m: Market, s: dict, stop) -> None:
    """A done series' newest minutes onto its file while the market's other series are still downloading (its
    status stays "done"; a failure is left for the next round)."""
    try:
        if s["venue"] == "bybit":                                # the plain Bybit market of the same key shares the file
            plain = STATE["markets"].get(s["symbol"])
            if plain is not None and plain.cd is not None:
                if on_screen(plain):
                    persist(plain)
                    return
                unload(plain)
        V.sync(V.VENUES[s["venue"]], s["symbol"], stop=stop)
    except Exception as e:
        log(f"{m.key}: {s['label']} catching up failed: {type(e).__name__}: {e}")


def sync_all(m: Market, job, build: bool = True, only_failed: bool = False) -> None:
    """Every exchange at once (each one's series one after another, inside its rate limits), then merge.
    While a long first download runs the chart is re-merged every REBUILD_S so it keeps growing. A series
    that fails is retried after RESYNC_S; one an exchange does not have is left out for good.
    build=False (the background watchlist job): download only, the merge happens when the chart is opened.
    only_failed: the retry of exchanges that failed last time; the others are left alone (no re-merge unless one recovers)."""
    _, ticker = parse_key(m.key)
    stop = lambda: preempted(job)
    if m.venues is None or m.replan:
        if STATE["index"] is None:                               # Bybit's list is not in yet (first launch, slow network): plan later
            m.retry_at = time.time() + 5
            return
        planned, missing = plan_all(ticker)
        have = {(s["venue"], s["kind"]) for s in m.venues or []}
        fresh = [s for s in planned if (s["venue"], s["kind"]) not in have]   # one spot + one perp per exchange, first pick kept
        if m.venues is None and not planned:
            if missing:                                          # the exchanges' lists did not arrive (network?): ask again soon
                m.sync, m.retry_at = "queued", time.time() + 60
                m.live_err = "market lists of " + ", ".join(V.VENUES[v].title for v in missing) + " did not load, retrying"
                return
            m.sync = "failed: no exchange lists this ticker"
            return
        if m.venues is None:
            m.sync = "loading"
        m.venues = (m.venues or []) + fresh
        m.replan = bool(missing)
        if missing:
            log(f"{m.key}: market lists missing for {', '.join(missing)}: planned again later")
        if fresh:
            price_check(m, fresh)
            log(f"{m.key}: {len(fresh)} series: " + ", ".join(s["label"] + (" (left out)" if s["status"].startswith("absent") else "") for s in fresh))
    if build and m.cd is None:
        m.sync = "loading"
        rebuild_all(m)                                           # what is on disk shows at once
    with LOCK:
        m.sync = "backfilling"
        m.live_err = ""
    groups = {}
    for s in m.venues:
        if s["status"].startswith("absent") or (only_failed and s["status"] == "done"):
            continue
        s["status"] = "queued"
        groups.setdefault(s["venue"], []).append(s)
    m.built_done = 0                                             # every series counts as newly done again
    for g in groups.values():                                    # the perp first: it usually trades the most
        g.sort(key=lambda s: s["kind"] != "perp")
    if only_failed and not groups:
        m.sync = "live"
        m.resync_at = time.time() + REPLAN_S if m.replan else 0.0
        return

    def run(series):
        for s in series:
            if stop():
                s["status"] = "paused"
                continue
            sync_part(m, s, stop)

    with ThreadPoolExecutor(max(1, len(groups)), thread_name_prefix="venue") as ex:
        futs = [ex.submit(run, g) for g in groups.values()]
        while True:
            _, pending = wait(futs, timeout=2)
            live = [s for s in m.venues if not s["status"].startswith("absent")]
            if live:
                pct = sum(100.0 if s["status"] == "done" else (s.get("pct") or 0.0) for s in live) / len(live)
                ats = [s.get("at") for s in live if s["status"] == "syncing" and s.get("at")]
                m.progress = {"pct": round(pct, 1), "at": min(ats) if ats else int(time.time())}
                m.updated = time.time()
            if not pending:
                break
            done = [s for s in live if s["status"] == "done" and s.get("n")]
            if not build or not (done or any(s.get("grew") for s in live)):
                continue
            behind = m.cd is None or not m.cd.n or int(m.cd.ts[m.cd.n - 1]) < (time.time() - LIVE_GAP_S * 3) * 1000
            if done and (m.sets is None or (behind and len(done) > m.built_done)):
                rebuild_all(m)                                   # an empty or out-of-date chart: as soon as an exchange is in
            elif time.time() - m.built_at > REBUILD_S and not stop():
                for s in done:                                   # their files end where they finished: catch them up first
                    if not stop():
                        refresh_tail(m, s, stop)
                if not stop():
                    rebuild_all(m)                               # the series still downloading join with what they have
        for f in futs:
            f.result()
    failed = [s for s in m.venues if s["status"].startswith("failed")]
    recovered = only_failed and any(s["status"] == "done" for g in groups.values() for s in g)
    if build and not stop() and (recovered or not only_failed):
        rebuild_all(m)
    for s in m.venues:
        s.pop("grew", None)
    with LOCK:
        m.progress = None
        if stop():
            log(f"{m.key}: paused")
        elif not build:
            m.sync = "queued"
        elif m.sets is None:                                     # nothing on any exchange yet (network down?): try again in a while
            m.retry_at = time.time() + 30
        else:
            m.sync = "live"
            m.synced = True
            m.live_rows = {}
            m.live_ok = {s["label"]: time.time() for s in m.venues if s["status"] == "done"}
            m.live_stale = False
            m.resync_at = time.time() + (RESYNC_S if failed else REPLAN_S) if failed or m.replan else 0.0
            n_done = sum(1 for s in m.venues if s["status"] == "done")
            log(f"{m.key}: live with {m.cd.n:,} merged minutes from {n_done} series" + (f", {len(failed)} failed" if failed else ""))


def live_rows_all(m: Market) -> tuple:
    """Every done series' newest minutes, polled at once; each series' minutes are remembered so one failed
    poll does not drop its dollars from a minute. A series that answers again after LIVE_GAP_S of failures
    marks the market stale (its missed minutes are refilled from the exchange). Returns (merged rows of the
    last three minutes, error text)."""
    order = {v: i for i, v in enumerate(V.PRIORITY)}
    done = sorted([s for s in (m.venues or []) if s["status"] == "done" and s.get("n")],
                  key=lambda s: (s["kind"] != "perp", order.get(s["venue"], 9)))

    def poll(s):
        try:
            return s, V.VENUES[s["venue"]].latest(s["symbol"], 3), ""
        except Exception as e:
            return s, None, f"{s['label']}: {type(e).__name__}"

    err = ""
    for s, rows, e in POOL.map(poll, done):
        if not e:
            now = time.time()
            prev = m.live_ok.get(s["label"])
            if prev is not None and now - prev > LIVE_GAP_S:
                m.live_stale = True
            m.live_ok[s["label"]] = now
        if rows:
            known = m.live_rows.setdefault(s["label"], {})
            for r in rows:
                known[int(r[0])] = r
        err = err or e
    newest = max((t for k in m.live_rows.values() for t in k), default=None)
    if newest is None:
        return [], err
    lists = []
    for s in done:
        known = m.live_rows.get(s["label"], {})
        for t in [t for t in known if t < newest - 10 * B.MINUTE]:
            del known[t]
        lists.append([known[t] for t in sorted(known) if t >= newest - 2 * B.MINUTE])
    weights = [m.weights.get(s["label"], 0.0) for s in done]
    rows = C.merge_rows(lists, weights)
    cd = m.cd
    if cd is not None and cd.n:                                  # a print only one exchange shows, against the chart's last hour
        rows = C.despike_rows(rows, lists, weights, float(np.median(cd.c[max(0, cd.n - 2 * C.SPIKE_ROWS - 1):cd.n])))
    return rows, err


def scan_batch() -> None:
    keys = scan_pending()[:25]
    try:
        for key in keys:
            if preempted(("scan", None)):
                break
            try:
                probe_first(key)
            except (LookupError, ValueError) as e:              # Bybit rejects the symbol: it really has no candles
                log(f"{key}: depth probe rejected: {e}")
                with LOCK:
                    STATE["index_first"][key] = 0
                    STATE["index_dirty"] = True
            except Exception:                                    # network / Bybit hiccup: leave it unknown, retried next launch
                STATE["scan_failed"].add(key)
                raise
            time.sleep(0.25)
    finally:
        save_index()
    if not scan_pending():
        log("depth scan complete")


def watch_job(ticker: str) -> None:
    """Keep a watchlist ticker's combined market fresh in the background (download only; it is merged when opened)."""
    key = f"all:{ticker}"
    with LOCK:
        m = STATE["markets"].get(key)
        if m is None:
            m = STATE["markets"][key] = Market(key)
            m.last_req = time.time() - LOOK_S                    # background: does not count as on screen
        elif m.sync == "live" or on_screen(m):                   # the market job and the live poll own it
            STATE["watch_done"].add(ticker)
            return
    if m.venues is not None and m.cd is None:
        files = [V.path(s["venue"], s["symbol"]) for s in m.venues if not s["status"].startswith("absent")]
        if files and all(f.exists() and time.time() - f.stat().st_mtime < WATCH_STALE_S for f in files):
            STATE["watch_done"].add(ticker)
            return
    sync_all(m, ("watch", ticker), build=m.cd is not None)
    if m.venues is None and not m.sync.startswith("failed") and m.retry_at > time.time():
        STATE["bg_retry_at"] = max(STATE["bg_retry_at"], m.retry_at)   # the exchanges' lists did not load: ask again later
    if m.venues is not None and not any(s["status"] in ("paused", "queued", "syncing") for s in m.venues):
        STATE["watch_done"].add(ticker)
    if m.sync.startswith("failed"):
        STATE["watch_done"].add(ticker)
    if not on_screen(m) and m.cd is not None:
        unload(m)


def worker() -> None:
    try:
        try:
            load_index()
        except Exception as e:
            STATE["index_status"] = f"instrument list failed: {type(e).__name__}"
            log(STATE["index_status"])
        while not STATE["stop"]:
            job = next_job()
            if job is None:
                time.sleep(1)
                continue
            kind, arg = job
            try:
                if kind == "market":
                    sync_market(STATE["markets"][arg], job)
                elif kind == "index":
                    refresh_index()
                elif kind == "scan":
                    scan_batch()
                else:
                    watch_job(arg)
            except LookupError as e:                             # Bybit rejects the symbol: no point retrying
                log(f"job {job} rejected: {e}")
                if kind == "market":
                    STATE["markets"][arg].sync = f"failed: {e}"
                elif kind == "watch":
                    STATE["watch_done"].add(arg)
            except Exception as e:                               # network / Bybit hiccup: keep what we have, retry in a while
                log(f"job {job} failed: {type(e).__name__}: {e} (retrying in 30 s)")
                if kind == "market":
                    m = STATE["markets"][arg]
                    m.live_err = f"{type(e).__name__}: {e}"
                    m.retry_at = time.time() + 30
                    m.sync = "backfilling" if m.sets else "queued"
                elif kind == "index":
                    STATE["index_status"] = "ok" if STATE["index"] else f"instrument list failed: {type(e).__name__}"
                    STATE["index_retry_at"] = time.time() + 300
                else:
                    STATE["bg_retry_at"] = time.time() + 30
            try:
                evict()
            except Exception as e:                               # parquet held open / disk: keep it loaded, try later
                log(f"evict failed: {type(e).__name__}: {e}")
    finally:
        WORKER_DONE.set()


# ---------------------------------------------------------------- live polling of what is on screen

def live_loop() -> None:
    while not STATE["stop"]:
        time.sleep(POLL_S)
        now = time.time()
        for m in list(STATE["markets"].values()):
            downloading = m.combined and m.sync == "backfilling" and m.sets is not None   # a long download: the newest
            if (m.sync != "live" and not downloading) or m.cd is None or not on_screen(m, now) or not m.cd.n:   # minutes stay live
                continue
            if downloading:
                try:
                    rows, err = live_rows_all(m)
                    if rows:
                        with LOCK:                               # only onto a chart that reaches them (else the next merge does)
                            if m.sets is not None and m.cd is not None and m.cd.n and rows[0][0] <= int(m.cd.ts[m.cd.n - 1]) + 3 * B.MINUTE:
                                m.cd.upsert(rows)
                                B.update_all(m.sets, m.cd)
                                m.meta["last"] = int(m.cd.ts[m.cd.n - 1] // 1000)
                                m.meta["n_candles"] = int(m.cd.n)
                                m.updated = time.time()
                except Exception as e:
                    m.live_err = type(e).__name__
                continue
            if m.combined and m.resync_at and now > m.resync_at:  # an exchange failed last time: the worker tries it again
                m.resync_at = 0.0
                m.retry_failed = True
                m.sync = "backfilling"
                continue
            try:
                err = ""
                if m.combined:
                    rows, err = live_rows_all(m)
                else:
                    rows = X.latest(m.key, 3)
                with LOCK:
                    cd = m.cd
                    last = int(cd.ts[cd.n - 1])
                if m.combined and m.live_stale and now - m.built_at > REBUILD_S:
                    with LOCK:                                   # an exchange (or the machine) missed minutes: the worker
                        m.sync = "backfilling"                   # catches every file up and merges again
                    continue
                if not m.combined and rows and rows[-1][0] - last >= X.WINDOW:   # missed minutes (a long sleep): the worker walks them
                    with LOCK:
                        m.sync = "backfilling"
                    continue
                if rows and rows[0][0] > last + B.MINUTE and not m.combined:
                    rows = X.fetch(m.key, last, rows[-1][0])     # a few missed minutes: one request refills them
                if not rows:
                    m.live_err = err
                    continue
                with LOCK:
                    cd.upsert(rows)
                    B.update_all(m.sets, cd)
                    m.meta["last"] = int(cd.ts[cd.n - 1] // 1000)
                    m.meta["n_candles"] = int(cd.n)
                    m.updated = time.time()
                m.live_err = err
            except Exception as e:                               # network blip: keep serving what we have
                m.live_err = type(e).__name__


def watchdog() -> None:
    prev = time.time()
    last_persist = time.time()
    while True:
        time.sleep(10)
        now = time.time()
        try:
            if now - prev > 30:                                  # the machine was asleep: give the page a cycle to reconnect
                STATE["last_req"] = now
            prev = now
            check_update()
            if now - last_persist > 900:
                persist_all()
                last_persist = now
        except Exception as e:
            log(f"watchdog: {type(e).__name__}: {e}")
        idle = now - STATE["last_req"]
        if idle > IDLE_EXIT_S and not STATE["restarting"]:
            log(f"no page for {int(idle)} s, stopping")
            STATE["stop"] = True
            try:
                WORKER_DONE.wait(30)
                persist_all()
            finally:
                log("exiting")
                os._exit(0)


# ---------------------------------------------------------------- HTTP

class H(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a):                                   # quiet
        pass

    def send(self, code, body, ctype="application/json"):
        self.send_response(code)
        self.send_header("Content-Type", ctype + ("; charset=utf-8" if "text" in ctype or "javascript" in ctype else ""))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def js(self, obj, code=200):
        return self.send(code, json.dumps(obj, separators=(",", ":")).encode())

    def meta(self, m, q) -> dict:
        out = meta_of(m)
        if not out["update"] and build_id() == STATE["build"] and page_stale(q.get("pb", [None])[0]):
            out["update"] = {"kind": "reload", "files": ["the page"], "stale": True}
        return out

    def do_GET(self):
        STATE["last_req"] = time.time()
        u = urlparse(self.path)
        p, q = u.path, parse_qs(u.query)
        try:
            if p == "/":
                body = (HERE / "index.html").read_bytes().replace(
                    b'<meta name="dbc-build" content="">', f'<meta name="dbc-build" content="{page_tag()[0]}">'.encode())
                page_served()
                return self.send(200, body, "text/html")
            if p == "/lightweight-charts.js":
                return self.send(200, (HERE / "lightweight-charts.js").read_bytes(), "application/javascript")
            if p.startswith("/static/"):
                name = p[len("/static/"):]
                f = STATIC / name
                if not re.fullmatch(r"[a-z0-9_-]+\.(js|css)", name) or not f.is_file():
                    return self.js({"error": "not found"}, 404)
                return self.send(200, f.read_bytes(), PAGE_TYPES[f.suffix])
            if p == "/drawings":
                items, rev = U.get_drawings(q.get("m", [DEFAULT_MARKET])[0])
                return self.js({"drawings": items, "rev": rev})
            if p == "/settings":
                return self.js({"settings": U.get_settings()})
            if p == "/ping":
                if STATE["stop"]:                                # winding down: a launcher must start a fresh copy
                    return self.js({"ok": False, "stopping": True, "pid": os.getpid()}, 503)
                return self.js({"ok": True, "build": build_tag(STATE["build"]), "pid": os.getpid()})
            if p == "/bars":
                m = touch(q.get("m", [DEFAULT_MARKET])[0])
                with LOCK:
                    want = q.get("k", [""])[0]
                    if m.sets and want.startswith("d:") and want not in m.sets:      # a size the page remembered is gone, or none yet
                        want = B.size_key(B.nearest_size(m.meta["sizes"], want[2:], m.meta["auto_size"]))
                    sets = ({want: m.sets[want]} if want in m.sets else m.sets) if m.sets else {}
                    keys = {k: {"bars": v["bars"], "forming": v["forming"]} for k, v in sets.items()}
                    return self.js({"meta": self.meta(m, q), "keys": keys})
            if p == "/live":
                m = touch(q.get("m", [DEFAULT_MARKET])[0])
                with LOCK:
                    keys = {k: {"n": len(v["bars"]), "tail": v["bars"][-2:], "forming": v["forming"]} for k, v in m.sets.items()} if m.sets else {}
                    return self.js({"meta": self.meta(m, q), "keys": keys})
            if p == "/search":
                return self.js(self.search(q.get("q", [""])[0]))
            if p == "/pick":
                if not STATE["index"]:
                    return self.js({"key": None, "candidates": [], "status": STATE["index_status"]})
                t = q.get("t", [""])[0].strip().upper()
                row, cands = resolve(t, quick=True)
                hit = row or (cands[0] if cands else None)
                if hit is None and t.isalnum():                  # not on Bybit: another exchange may list it
                    try:
                        hit = {"ticker": t} if V.markets_for(t, V.load_instruments()) else None
                    except Exception:
                        hit = None
                return self.js({"key": f"all:{hit['ticker']}" if hit else None, "candidates": self.decorate(cands), "status": "ok"})
            if p == "/watchlist":
                with LOCK:
                    wl = STATE["watchlist"]
                    for t in q.get("add", []):
                        t = t.strip().upper()
                        if t and t not in wl:
                            wl.append(t)
                            STATE["watch_done"].discard(t)
                    for t in q.get("remove", []):
                        t = t.strip().upper()
                        if t in wl:
                            wl.remove(t)
                    MK.save_watchlist(wl)
                    return self.js({"watchlist": list(wl)})
            if p == "/restart":
                if STATE["restarting"]:
                    return self.js({"ok": True, "pid": os.getpid()})
                if STATE["update"] is None:
                    return self.js({"ok": False, "reason": "no update pending"})
                if not update_settled():
                    return self.js({"ok": False, "reason": "source files are still changing; try again in a minute"})
                threading.Thread(target=restart, daemon=True).start()
                return self.js({"ok": True, "pid": os.getpid()})
            self.js({"error": "not found"}, 404)
        except ValueError as e:
            self.js({"error": str(e)}, 400)
        except Exception as e:
            log(f"request {self.path} failed: {type(e).__name__}: {e}")
            self.js({"error": f"{type(e).__name__}: {e}"}, 500)

    def do_POST(self):
        STATE["last_req"] = time.time()
        u = urlparse(self.path)
        p, q = u.path, parse_qs(u.query)
        try:
            # Only this app's own page may write: another site open in the browser could otherwise post here.
            # A JSON content type cannot be sent cross-site without a CORS preflight, which this server never grants.
            origin = self.headers.get("Origin")
            if origin and origin not in (f"http://127.0.0.1:{PORT}", f"http://localhost:{PORT}"):
                return self.js({"error": "forbidden"}, 403)
            if not (self.headers.get("Content-Type") or "").startswith("application/json"):
                return self.js({"error": "send application/json"}, 415)
            n = int(self.headers.get("Content-Length") or 0)
            if n > U.MAX_BODY:
                return self.js({"error": "too large"}, 413)
            body = json.loads(self.rfile.read(n) or b"{}")
            if not isinstance(body, dict):
                raise ValueError("send a JSON object")
            if p == "/drawings":
                prev, rev = U.change_drawings(q.get("m", [""])[0], body.get("upsert"), body.get("delete"))
                return self.js({"ok": True, "prev": prev, "rev": rev})   # prev = what this change was applied on
            if p == "/settings":
                U.change_settings(body.get("settings"))
                return self.js({"ok": True})
            self.js({"error": "not found"}, 404)
        except ValueError as e:
            self.js({"error": str(e)}, 400)
        except Exception as e:
            log(f"request POST {self.path} failed: {type(e).__name__}: {e}")
            self.js({"error": f"{type(e).__name__}: {e}"}, 500)

    def decorate(self, rows: list) -> list:
        out = []
        for r in rows:
            m = STATE["markets"].get(r["key"])
            out.append(dict(r, have=X.path(r["key"]).exists(), status=m.sync if m else "", watch=r["ticker"] in STATE["watchlist"]))
        return out

    def search(self, qs: str) -> dict:
        idx = STATE["index"]
        if not idx:
            return {"rows": [], "status": STATE["index_status"], "watchlist": STATE["watchlist"]}
        qs = qs.strip()
        if qs:
            rows = MK.search(idx, qs)
        else:                                                    # the watchlist, best market first where known, each market once
            rows, seen = [], set()
            for t in STATE["watchlist"]:
                cands = MK.candidates(idx, t)
                best = MK.deepest(cands)
                for r in ([best] + [c for c in cands if c is not best] if best else cands):
                    if r["key"] not in seen:
                        seen.add(r["key"])
                        rows.append(r)
        return {"rows": self.decorate(rows), "status": "ok", "watchlist": STATE["watchlist"],
                "pending": len(scan_pending()), "stale": STATE["index_stale"]}


def migrate() -> None:
    """v2 kept one file, data/bybit_btcusdt_1m.parquet; give it its v3 name."""
    old = X.DATA / "bybit_btcusdt_1m.parquet"
    new = X.path("linear:BTCUSDT")
    if old.exists() and not new.exists():
        old.rename(new)
        log(f"renamed {old.name} -> {new.name}")


def main() -> None:
    global SRV
    open_log()
    http.server.ThreadingHTTPServer.allow_reuse_address = os.name != "nt"
    for attempt in range(80):                                    # a stopping copy may hold the port for up to ~40 s
        try:
            SRV = http.server.ThreadingHTTPServer(("127.0.0.1", PORT), H)
            break
        except OSError:
            time.sleep(0.5)
    else:
        log(f"port {PORT} busy: a viewer server is already running, nothing to do")
        return
    STATE["build"] = build_id()
    migrate()
    STATE["watchlist"] = MK.load_watchlist()
    threading.Thread(target=worker, daemon=True).start()
    threading.Thread(target=live_loop, daemon=True).start()
    threading.Thread(target=watchdog, daemon=True).start()
    log(f"serving http://127.0.0.1:{PORT}/ (pid {os.getpid()}, build {build_tag(STATE['build'])}, watchlist {', '.join(STATE['watchlist'])})")
    try:
        SRV.serve_forever()
    finally:
        if STATE["restarting"]:                                  # /restart: free the port, start the new copy, go away
            SRV.server_close()
            spawn_successor()
            log("successor started, exiting")
            os._exit(0)
        STATE["stop"] = True
        persist_all()


if __name__ == "__main__":
    main()
