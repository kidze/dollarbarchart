"""Local server for the dollar-bar chart: many markets, one at a time on screen.

Serves index.html and JSON on 127.0.0.1:8793. A market ("linear:BTCUSDT", "spot:PUMPUSDT") is loaded
from its parquet when a page asks for it, caught up to now (first time: a full backfill that the chart
watches grow), then polled every 5 s so the forming bar moves. One background worker does all downloads,
in this order: the market on screen, then first-candle probes for the search index, then the watchlist
(data/watchlist.json) so those open instantly next time. Nothing runs when no window is open: two
minutes after the last page request the worker is told to stop, everything is written to disk and the
process exits; the next launch resumes.

It also watches its own source files: when one changes, /live carries an `update` notice and the page
shows a banner. "Update now" reloads the page if only the page changed, or calls /restart, which hands
the port to a fresh copy of this server and exits; the page reconnects and reloads by itself.

  /bars?m=      full history for every bar set of a market (one call per page load or menu change)
  /live?m=      the last two completed bars + the forming bar of every set (polled every 5 s)
  /search?q=    markets matching what was typed (empty q = the watchlist)
  /pick?t=      resolve a ticker to the market with the most history (probes depth if unknown)
  /watchlist?add=T | ?remove=T
  /ping, /restart
"""
import http.server
import json
import os
import subprocess
import sys
import threading
import time
from pathlib import Path
from urllib.parse import parse_qs, urlparse

import bars as B
import bybit_sync as X
import markets as MK

HERE = Path(__file__).resolve().parent
PORT = int(os.environ.get("DOLLARBARS_PORT", "8793"))         # a dev checkout runs on another port next to the live app
POLL_S = 5
IDLE_EXIT_S = 120
LOOK_S = 60                                                      # a market counts as "on screen" this long after its last request
KEEP_LOADED = 3
WATCH_STALE_S = 86_400
DEFAULT_MARKET = "linear:BTCUSDT"
SOURCES = ["server.py", "bars.py", "bybit_sync.py", "markets.py", "index.html", "lightweight-charts.js"]

STATE = {"markets": {}, "stop": False, "restarting": False, "last_req": time.time(), "started": time.time(),
         "build": {}, "update": None, "index": None, "index_status": "loading instruments", "index_first": {},
         "index_raw": None, "index_dirty": False, "watchlist": [], "watch_done": set()}
LOCK = threading.RLock()
WORKER_DONE = threading.Event()
SRV = None


class Market:
    def __init__(self, key: str):
        self.key = key
        self.cd = None                                           # bars.Candles once loaded
        self.sets = None
        self.meta = {}
        self.sync = "queued"                                     # queued | loading | backfilling | live | failed: ...
        self.progress = None                                     # {"pct", "at"} while backfilling
        self.first_ms = None
        self.last_req = time.time()
        self.updated = 0.0
        self.synced = False                                      # reached "now" at least once this session
        self.live_err = ""                                       # last live-poll or download error, shown on the page
        self.retry_at = 0.0                                      # a download that failed is retried after a pause


def log(msg: str) -> None:
    print(time.strftime("%H:%M:%S"), msg, flush=True)


# ---------------------------------------------------------------- update detection / restart

def build_id() -> dict:
    out = {}
    for f in SOURCES:
        p = HERE / f
        if p.exists():
            st = p.stat()
            out[f] = [int(st.st_mtime), st.st_size]
    return out


def build_tag(b: dict) -> str:
    return f"{max((v[0] for v in b.values()), default=0)}-{sum(v[1] for v in b.values())}"


def check_update() -> None:
    b = build_id()
    if b == STATE["build"]:
        STATE["update"] = None
        return
    changed = [f for f in SOURCES if b.get(f) != STATE["build"].get(f)]
    kind = "restart" if any(f.endswith(".py") for f in changed) else "reload"
    if STATE["update"] is None or STATE["update"]["files"] != changed:
        log(f"update available ({kind}): {', '.join(changed)}")
    STATE["update"] = {"kind": kind, "files": changed}


def page_served() -> None:
    """The page just loaded the current index.html + chart library, so those no longer count as pending updates."""
    b = build_id()
    for f in SOURCES:
        if not f.endswith(".py") and f in b:
            STATE["build"][f] = b[f]
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
    with LOCK:
        cd = m.cd
        if cd is None or cd.dirty_from >= cd.n:
            return
        frame = cd.frame()
        cd.dirty_from = cd.n
    X.save(m.key, frame)


def persist_all() -> None:
    for m in list(STATE["markets"].values()):
        try:
            persist(m)
        except Exception as e:
            log(f"{m.key}: persist failed: {type(e).__name__}: {e}")
    save_index()


def unload(m: Market) -> None:
    persist(m)
    with LOCK:
        m.cd, m.sets = None, None
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
    return dict(m.meta, sync=m.sync, progress=m.progress, updated=m.updated, live_err=m.live_err,
                build=build_tag(STATE["build"]), update=STATE["update"], market=market_info(m.key),
                index_status=STATE["index_status"], source=source_text(m.key))


def source_text(key: str) -> str:
    info = market_info(key)
    what = "perpetual" if info["kind"] == "perp" else "spot"
    return f"Bybit {info['symbol']} {what}, 1-minute candles, dollars = exchange-reported turnover"


# ---------------------------------------------------------------- instrument index

def load_index() -> None:
    raw, first = MK.load_cache()
    STATE["index_first"] = first
    if raw and time.time() - raw.get("fetched", 0) < MK.REFRESH_S:
        STATE["index_raw"] = raw
    else:
        try:
            STATE["index_raw"] = MK.fetch_instruments()
            STATE["index_dirty"] = True
            log(f"instruments fetched: {len(STATE['index_raw']['spot'])} spot, {len(STATE['index_raw']['linear'])} perps")
        except Exception as e:
            if raw:
                STATE["index_raw"] = raw                         # offline: the stale list is better than none
                log(f"instruments refresh failed ({type(e).__name__}), using the cached list")
            else:
                STATE["index_status"] = f"instrument list unavailable: {type(e).__name__}"
                return
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
    MK.save_cache(raw, first)


def probe_first(key: str):
    """First-candle time of a market, probed once and cached (0 = Bybit has no candles for it)."""
    with LOCK:
        if key in STATE["index_first"]:
            return STATE["index_first"][key] or None
    ms = X.first_candle_ms(key)
    with LOCK:
        STATE["index_first"][key] = ms or 0
        STATE["index_dirty"] = True
        if STATE["index"]:
            for r in STATE["index"]:
                if r["key"] == key:
                    r["first"] = ms
    return ms


def resolve(ticker: str) -> tuple:
    """(deepest market row or None, candidate rows) for a ticker, probing unknown depths (a few requests)."""
    idx = STATE["index"] or []
    cands = MK.candidates(idx, ticker)
    for r in cands:
        if r.get("first") is None:
            try:
                r["first"] = probe_first(r["key"])
            except Exception as e:
                log(f"{r['key']}: depth probe failed: {type(e).__name__}")
    return MK.deepest(cands), cands


def scan_pending() -> list:
    """Markets whose first-candle time is still unknown, the watchlist's own candidates first so the picker
    can show "most history" for the tickers that matter before the long tail is probed."""
    rows = [r for r in (STATE["index"] or []) if r.get("first") is None and r["key"] not in STATE["index_first"]]
    wl = set(STATE["watchlist"])
    rows.sort(key=lambda r: (r["ticker"] not in wl, r["kind"] != "perp"))
    return [r["key"] for r in rows]


# ---------------------------------------------------------------- the worker: downloads, one job at a time

def next_job():
    with LOCK:
        now = time.time()
        looked = [m for m in STATE["markets"].values()
                  if on_screen(m, now) and m.sync in ("queued", "loading", "backfilling") and m.retry_at <= now]
        if looked:
            return ("market", max(looked, key=lambda m: m.last_req).key)
        if STATE["index"] and scan_pending():
            return ("scan", None)
        for t in STATE["watchlist"]:
            if t in STATE["watch_done"]:
                continue
            return ("watch", t)
    return None


def preempted(job) -> bool:
    return STATE["stop"] or next_job() != job


def sync_market(m: Market, job) -> None:
    if m.cd is None:
        m.sync = "loading"
        cd = B.Candles(X.load(m.key))
        with LOCK:
            m.cd = cd
            if cd.n:
                m.sets, m.meta = B.build_all(cd)
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
    m.live_err = ""
    t0 = time.time()

    def on_rows(rows):
        with LOCK:
            cd.upsert(rows)
            if m.sets is None:
                m.sets, m.meta = B.build_all(cd)
            else:
                B.update_all(m.sets, cd)
                m.meta["last"] = int(cd.ts[cd.n - 1] // 1000)
                m.meta["n_candles"] = int(cd.n)
            now_ms = time.time() * 1000
            span = max(1.0, now_ms - m.first_ms)
            m.progress = {"pct": min(100.0, round((rows[-1][0] - m.first_ms) / span * 100, 1)), "at": int(rows[-1][0] // 1000)}
            m.updated = time.time()

    def checkpoint(requests):
        persist(m)

    result = X.sync(m.key, on_rows, cursor, stop=lambda: preempted(job), checkpoint=checkpoint)
    if result == "done":
        persist(m)                                               # a pause keeps its rows in memory; checkpoints, eviction and exit write them
        with LOCK:
            if m.sets is not None and time.time() - t0 > 60:    # a long backfill: the median day may have changed, rebuild once
                m.sets, m.meta = B.build_all(cd)
            m.sync = "live"
            m.progress = None
            m.synced = True
        log(f"{m.key}: live with {cd.n:,} candles")
    else:
        log(f"{m.key}: backfill paused at {m.progress['at'] if m.progress else '?'}")


def scan_batch() -> None:
    keys = scan_pending()[:25]
    for key in keys:
        if STATE["stop"]:
            return
        try:
            probe_first(key)
        except Exception as e:
            log(f"{key}: depth probe failed: {type(e).__name__}")
            with LOCK:
                STATE["index_first"][key] = 0
        time.sleep(0.25)
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
        m = STATE["markets"].get(key) or STATE["markets"].setdefault(key, Market(key))
        m.last_req = min(m.last_req, time.time() - LOOK_S)      # background: does not count as on screen
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
            elif kind == "scan":
                scan_batch()
            else:
                watch_job(arg)
        except LookupError as e:                                 # Bybit rejects the symbol: no point retrying
            log(f"job {job} rejected: {e}")
            if kind == "market":
                STATE["markets"][arg].sync = f"failed: {e}"
            elif kind == "watch":
                STATE["watch_done"].add(arg)
        except Exception as e:                                   # network / Bybit hiccup: keep what we have, retry in a while
            log(f"job {job} failed: {type(e).__name__}: {e} (retrying in 30 s)")
            if kind == "market":
                m = STATE["markets"][arg]
                m.live_err = f"{type(e).__name__}: {e}"
                m.retry_at = time.time() + 30
                m.sync = "backfilling" if m.sets else "queued"
            else:
                time.sleep(30 if not STATE["stop"] else 0)
        evict()
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
                if rows and rows[0][0] > last + B.MINUTE:
                    rows = X.fetch(m.key, last, rows[-1][0])     # missed minutes (sleep, offline): refill, 1000 per poll
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
        if now - prev > 30:                                      # the machine was asleep: give the page a cycle to reconnect
            STATE["last_req"] = now
        prev = now
        check_update()
        if now - last_persist > 900:
            persist_all()
            last_persist = now
        idle = now - STATE["last_req"]
        if idle > IDLE_EXIT_S and now - STATE["started"] > 300 and not STATE["restarting"]:
            log("no page for two minutes, stopping")
            STATE["stop"] = True
            WORKER_DONE.wait(30)
            persist_all()
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
            if p == "/ping":
                return self.js({"ok": True, "build": build_tag(STATE["build"]), "pid": os.getpid()})
            if p == "/bars":
                m = touch(q.get("m", [DEFAULT_MARKET])[0])
                with LOCK:
                    keys = {k: {"bars": v["bars"], "forming": v["forming"]} for k, v in m.sets.items()} if m.sets else {}
                    return self.js({"meta": meta_of(m), "keys": keys})
            if p == "/live":
                m = touch(q.get("m", [DEFAULT_MARKET])[0])
                with LOCK:
                    keys = {k: {"n": len(v["bars"]), "tail": v["bars"][-2:], "forming": v["forming"]} for k, v in m.sets.items()} if m.sets else {}
                    return self.js({"meta": meta_of(m), "keys": keys})
            if p == "/search":
                return self.js(self.search(q.get("q", [""])[0]))
            if p == "/pick":
                row, cands = resolve(q.get("t", [""])[0])
                return self.js({"key": row["key"] if row else (cands[0]["key"] if cands else None), "candidates": self.decorate(cands)})
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
                if not STATE["restarting"]:
                    threading.Thread(target=restart, daemon=True).start()
                return self.js({"ok": True, "pid": os.getpid()})
            self.js({"error": "not found"}, 404)
        except ValueError as e:
            self.js({"error": str(e)}, 400)
        except Exception as e:
            log(f"request {self.path} failed: {type(e).__name__}: {e}")
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
        else:                                                    # the watchlist, best market first where known
            rows = []
            for t in STATE["watchlist"]:
                cands = MK.candidates(idx, t)
                best = MK.deepest(cands)
                rows.extend([best] + [c for c in cands if c is not best] if best else cands)
        return {"rows": self.decorate(rows), "status": "ok", "watchlist": STATE["watchlist"],
                "pending": len(scan_pending()) if STATE["index"] else 0}


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
    for attempt in range(20):                                    # after /restart the old copy may hold the port for a moment
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
