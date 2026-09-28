"""Local server for the BTC dollar-bar viewer.

Serves index.html and two JSON endpoints on 127.0.0.1:8793, catches the candle file up to now on start,
then polls Bybit every 5 s so the forming bar moves. Exits on its own two minutes after the last page
request (i.e. when the window is closed), writing new candles back to the parquet first. It will not
exit while a first-run backfill is still downloading, so closing the window early loses nothing.

It also watches its own source files: when one changes, /live carries an `update` notice and the page
shows a banner. "Update now" reloads the page if only the page changed, or calls /restart, which hands
the port to a fresh copy of this server and exits; the page reconnects and reloads by itself.

  /bars     full history for every bar set (one call per page load or menu change)
  /live     the last two completed bars + the forming bar of every set (polled every 5 s)
  /restart  persist, start a new server process, exit
"""
import http.server
import json
import os
import subprocess
import sys
import threading
import time
from pathlib import Path

import bars as B
import bybit_sync

HERE = Path(__file__).resolve().parent
PORT = 8793
POLL_S = 5
IDLE_EXIT_S = 120
PERSIST_S = 900
SOURCES = ["server.py", "bars.py", "bybit_sync.py", "index.html", "lightweight-charts.js"]
STATE = {"cd": None, "sets": {}, "meta": {}, "sync": "starting", "updated": 0, "last_req": time.time(), "started": time.time(),
         "build": {}, "update": None, "restarting": False}
LOCK = threading.Lock()
SRV = None


def log(msg: str) -> None:
    print(time.strftime("%H:%M:%S"), msg, flush=True)


def build_id() -> dict:
    """mtime + size of every source file; a change in any of them means an update is available."""
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
    """Compare the files on disk with the ones this process started from (or last served, for page files)."""
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


def rebuild(df) -> None:
    cd = B.Candles(df)
    sets, meta = B.build_all(cd)
    with LOCK:
        STATE.update(cd=cd, sets=sets, meta=meta, updated=time.time())


def persist() -> None:
    """Write candles received live back to the parquet (atomically; a crash mid-write cannot corrupt the file)."""
    with LOCK:
        cd = STATE["cd"]
        if cd is None or cd.dirty_from >= cd.n:
            return
        frame = cd.frame()
        cd.dirty_from = cd.n
    bybit_sync.save(frame)


def data_loop() -> None:
    # 1. what is on disk, immediately (may be hours or days behind)
    df = bybit_sync.load()
    if len(df):
        STATE["sync"] = "history loaded, catching up"
        rebuild(df)
    # 2. catch up to now (first run: ~20 min for the full history; the parquet is checkpointed as it goes)
    def progress(last_ms, n):
        STATE["sync"] = f"catching up: {time.strftime('%Y-%m-%d %H:%M', time.gmtime(last_ms // 1000))}Z"
    df = bybit_sync.sync(progress=progress)
    rebuild(df)
    STATE["sync"] = "live"
    log(f"live with {len(df):,} candles")
    # 3. live: refresh the newest candles every few seconds; refill any minutes missed while asleep or offline
    last_persist = time.time()
    while True:
        time.sleep(POLL_S)
        if STATE["restarting"]:
            return
        try:
            rows = bybit_sync.latest(3)
            with LOCK:
                cd = STATE["cd"]
                last = int(cd.ts[cd.n - 1])
            if rows and rows[0][0] > last + B.MINUTE:
                rows = bybit_sync.fetch(last, rows[-1][0])       # up to 1000 minutes per poll; longer gaps close over a few polls
            with LOCK:
                cd.upsert(rows)
                B.update_all(STATE["sets"], cd)
                STATE["meta"]["last"] = int(cd.ts[cd.n - 1] // 1000)
                STATE["updated"] = time.time()
            STATE["sync"] = "live"
        except Exception as e:                                   # network blip: keep serving what we have
            STATE["sync"] = f"live (last poll failed: {type(e).__name__})"
        if time.time() - last_persist > PERSIST_S:
            persist()
            last_persist = time.time()


def data_thread() -> None:
    while True:
        try:
            data_loop()
            return
        except Exception as e:                                   # e.g. no network at launch: say so on the page and retry
            STATE["sync"] = f"failed: {type(e).__name__}: {e} (retrying in 30 s)"
            log(STATE["sync"])
            time.sleep(30)


def watchdog() -> None:
    prev = time.time()
    while True:
        time.sleep(10)
        now = time.time()
        if now - prev > 30:                                      # the machine was asleep: give the page a cycle to reconnect
            STATE["last_req"] = now
        prev = now
        check_update()
        idle = now - STATE["last_req"]
        settled = STATE["sync"].startswith("live") or STATE["sync"].startswith("failed")
        if idle > IDLE_EXIT_S and now - STATE["started"] > 300 and settled and not STATE["restarting"]:
            log("no page for two minutes, exiting")
            persist()
            os._exit(0)


def restart() -> None:
    """Stop serving; main() then hands the port to a fresh copy of this server, which runs the new code."""
    time.sleep(0.3)                                              # let the /restart response leave first
    log("restarting for update")
    STATE["restarting"] = True
    persist()
    SRV.shutdown()                                               # serve_forever() returns in the main thread, see main()


def spawn_successor() -> None:
    """Start a fresh server process that outlives this one. It writes its own log (see open_log)."""
    kw = dict(cwd=str(HERE), stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    if os.name == "nt":
        kw["creationflags"] = subprocess.DETACHED_PROCESS | subprocess.CREATE_NEW_PROCESS_GROUP
    else:
        kw["start_new_session"] = True
    subprocess.Popen([sys.executable, str(HERE / "server.py")], **kw)


def open_log() -> None:
    """All output goes to logs/server.log, opened by this process itself (a launcher's shell redirect would
    lock the file on Windows and stop a restarted copy from opening it). The launcher may use pythonw, which
    has no console at all, so this must happen before the first print."""
    (HERE / "logs").mkdir(exist_ok=True)
    f = open(HERE / "logs" / "server.log", "a", buffering=1, encoding="utf-8", errors="replace")
    sys.stdout = sys.stderr = f


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

    def do_GET(self):
        STATE["last_req"] = time.time()
        p = self.path.split("?")[0]
        if p == "/":
            body = (HERE / "index.html").read_bytes()
            page_served()
            return self.send(200, body, "text/html")
        if p == "/lightweight-charts.js":
            return self.send(200, (HERE / "lightweight-charts.js").read_bytes(), "application/javascript")
        if p == "/ping":
            return self.send(200, json.dumps({"ok": True, "build": build_tag(STATE["build"]), "pid": os.getpid()}).encode())
        if p == "/bars":
            with LOCK:
                body = json.dumps({"meta": dict(STATE["meta"], sync=STATE["sync"], updated=STATE["updated"],
                                                build=build_tag(STATE["build"]), update=STATE["update"]),
                                   "keys": {k: {"bars": v["bars"], "forming": v["forming"]} for k, v in STATE["sets"].items()}},
                                  separators=(",", ":")).encode()
            return self.send(200, body)
        if p == "/live":
            with LOCK:
                body = json.dumps({"meta": {"sync": STATE["sync"], "updated": STATE["updated"], "last": STATE["meta"].get("last"),
                                            "build": build_tag(STATE["build"]), "update": STATE["update"]},
                                   "keys": {k: {"n": len(v["bars"]), "tail": v["bars"][-2:], "forming": v["forming"]}
                                            for k, v in STATE["sets"].items()}}, separators=(",", ":")).encode()
            return self.send(200, body)
        if p == "/restart":
            if not STATE["restarting"]:
                threading.Thread(target=restart, daemon=True).start()
            return self.send(200, json.dumps({"ok": True, "pid": os.getpid()}).encode())
        self.send(404, b'{"error":"not found"}')


def main() -> None:
    global SRV
    open_log()
    # SO_REUSEADDR on Windows lets a second copy bind the same port (two servers, one zombie); elsewhere it is
    # what allows a restarted copy to bind while old connections are still in TIME_WAIT.
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
    threading.Thread(target=data_thread, daemon=True).start()
    threading.Thread(target=watchdog, daemon=True).start()
    log(f"serving http://127.0.0.1:{PORT}/ (pid {os.getpid()}, build {build_tag(STATE['build'])})")
    try:
        SRV.serve_forever()
    finally:
        if STATE["restarting"]:                                  # /restart: free the port, start the new copy, go away
            SRV.server_close()
            spawn_successor()
            log("successor started, exiting")
            os._exit(0)
        persist()


if __name__ == "__main__":
    main()
