"""Local server for the dollar-bar chart: many markets, one at a time on screen.

Serves index.html and JSON on 127.0.0.1:8793. A market ("linear:BTCUSDT", "spot:PUMPUSDT") is loaded
from its parquet when a page asks for it, caught up to now (first time: a full backfill that the chart
watches grow), then polled every 5 s so the forming bar moves. One background worker does all downloads,
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

import bars as B
import bybit_sync as X
import markets as MK
import userdata as U

HERE = Path(__file__).resolve().parent
PORT = int(os.environ.get("DOLLARBARS_PORT", "8793"))         # a dev checkout runs on another port next to the live app
POLL_S = 5
IDLE_EXIT_S = 120
LOOK_S = 60                                                      # a market counts as "on screen" this long after its last request
KEEP_LOADED = 3
WATCH_STALE_S = 86_400
QUIET_S = 60                                                     # an update is offered only after the source files stopped changing for this long
DEFAULT_MARKET = "linear:BTCUSDT"
CORE = ["server.py", "bars.py", "bybit_sync.py", "markets.py", "userdata.py", "index.html", "lightweight-charts.js"]
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
    X.parse(key)
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
    """Write the market's candles to its parquet (atomic). Serialized per market so two callers never share a .tmp."""
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
    category, symbol = X.parse(key)
    info = {"key": key, "ticker": symbol, "name": "", "kind": "spot" if category == "spot" else "perp",
            "symbol": symbol, "quote": "", "first": None, "stock": False}
    idx = STATE["index"]
    if idx:
        for r in idx:
            if r["key"] == key:
                info.update({k: r[k] for k in ("ticker", "name", "kind", "symbol", "quote", "first", "stock")})
                break
    info["watch"] = info["ticker"] in STATE["watchlist"]
    return info


def meta_of(m: Market) -> dict:
    return dict(m.meta, sync=m.sync, progress=m.progress, updated=m.updated, live_err=m.live_err[:120], notice=m.notice,
                build=build_tag(STATE["build"]), update=STATE["update"], market=market_info(m.key),
                index_status=STATE["index_status"], source=source_text(m.key))


def source_text(key: str) -> str:
    info = market_info(key)
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
    row, _ = resolve(ticker)
    if row is None:
        log(f"watchlist {ticker}: no market with candles, skipping")
        STATE["watch_done"].add(ticker)
        return
    key = row["key"]
    with LOCK:
        m = STATE["markets"].get(key)
        if m is None:
            m = STATE["markets"][key] = Market(key)
            m.last_req = time.time() - LOOK_S                    # background: does not count as on screen
        elif m.sync == "live" or on_screen(m):                   # the market job and the live poll own it
            STATE["watch_done"].add(ticker)
            return
    p = X.path(key)
    fresh = p.exists() and time.time() - p.stat().st_mtime < WATCH_STALE_S
    if fresh and m.cd is None:
        STATE["watch_done"].add(ticker)
        return
    sync_market(m, ("watch", ticker))
    if m.sync == "live" or m.sync.startswith("failed"):
        STATE["watch_done"].add(ticker)
    if not on_screen(m):
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
            if m.sync != "live" or m.cd is None or not on_screen(m, now):
                continue
            try:
                rows = X.latest(m.key, 3)
                with LOCK:
                    cd = m.cd
                    last = int(cd.ts[cd.n - 1])
                if rows and rows[-1][0] - last >= X.WINDOW:      # more than one request's worth missed (long sleep): the worker walks it
                    with LOCK:
                        m.sync = "backfilling"
                    continue
                if rows and rows[0][0] > last + B.MINUTE:
                    rows = X.fetch(m.key, last, rows[-1][0])     # a few missed minutes: one request refills them
                with LOCK:
                    cd.upsert(rows)
                    B.update_all(m.sets, cd)
                    m.meta["last"] = int(cd.ts[cd.n - 1] // 1000)
                    m.meta["n_candles"] = int(cd.n)
                    m.updated = time.time()
                m.live_err = ""
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

    def do_GET(self):
        STATE["last_req"] = time.time()
        u = urlparse(self.path)
        p, q = u.path, parse_qs(u.query)
        try:
            if p == "/":
                body = (HERE / "index.html").read_bytes()
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
                    return self.js({"meta": meta_of(m), "keys": keys})
            if p == "/live":
                m = touch(q.get("m", [DEFAULT_MARKET])[0])
                with LOCK:
                    keys = {k: {"n": len(v["bars"]), "tail": v["bars"][-2:], "forming": v["forming"]} for k, v in m.sets.items()} if m.sets else {}
                    return self.js({"meta": meta_of(m), "keys": keys})
            if p == "/search":
                return self.js(self.search(q.get("q", [""])[0]))
            if p == "/pick":
                if not STATE["index"]:
                    return self.js({"key": None, "candidates": [], "status": STATE["index_status"]})
                row, cands = resolve(q.get("t", [""])[0], quick=True)
                return self.js({"key": row["key"] if row else (cands[0]["key"] if cands else None), "candidates": self.decorate(cands), "status": "ok"})
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
    new = X.path(DEFAULT_MARKET)
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
