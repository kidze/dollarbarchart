"""What the owner makes on the chart and wants back next time: drawings (per market), the chart's look, and the
indicators loaded from a file.

All live in data/ next to the candles and are written the same crash-safe way (bybit_sync.write_durably):
  data/drawings.json   {"linear:BTCUSDT": [drawing, ...], ...}    one list per market, shared by every bar size
  data/settings.json   {"appearance": {...}, ...}                 whatever the page sends
  data/indicators/     the Pine scripts loaded with Indicators → Load indicator: <id>.pine each, as the file was,
                       and index.json listing them ({"scripts": [{id, name, file, added, updated}]}). The id comes
                       from the script's title, so loading a new version of a script replaces the old one.

Pages never send a whole list or the whole settings object, only what they changed: drawings as upserts and deletes
by id, settings as the top-level keys that changed. Two app windows open at once (launch.cmd run again, or dollar bars
in one and time bars in the other) therefore cannot wipe each other's work with an out-of-date copy. Every change to a
market's drawings gets a new revision, so a page can tell that another window changed them and fetch them again.

The page owns the format of a drawing and of the settings; this module only checks shape and size, keeps a copy in
memory and writes the file. A file that cannot be parsed is kept aside as <name>.damaged and treated as empty, so
one bad file never stops the chart from opening.
"""
import itertools
import json
import os
import re
import threading
import time
import uuid

import bybit_sync as X

DRAWINGS = X.DATA / "drawings.json"
SETTINGS = X.DATA / "settings.json"
SCRIPTS = X.DATA / "indicators"
MAX_SCRIPT = 1_000_000                                           # characters of one script's source
MAX_SCRIPTS = 200
MAX_BODY = 4_000_000                                             # bytes of one POST
MAX_DRAWINGS = 5_000                                             # per market
KEY_RE = re.compile(r"[a-z]+:[A-Za-z0-9._-]{1,40}")              # market keys: linear:BTCUSDT, spot:PUMPUSDT
ID_RE = re.compile(r"[A-Za-z0-9_-]{1,40}")

_LOCK = threading.Lock()
_cache = {}                                                      # file path -> parsed dict
_BOOT = uuid.uuid4().hex[:8]                                     # revisions from an earlier server never look current
_count = itertools.count(1)
_revs = {}                                                       # market key -> revision of its drawings


def _read(path) -> dict:
    key = str(path)
    if key in _cache:
        return _cache[key]
    try:
        d = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(d, dict):
            raise ValueError("not an object")
    except FileNotFoundError:
        d = {}
    except (ValueError, UnicodeDecodeError):                     # JSONDecodeError is a ValueError
        os.replace(path, path.with_name(path.name + ".damaged"))
        d = {}
    _cache[key] = d
    return d


def _write(path, d: dict) -> None:
    body = json.dumps(d, separators=(",", ":")).encode("utf-8")
    X.write_durably(path, lambda f: f.write(body))


def _rev(key: str) -> str:
    return _revs.setdefault(key, f"{_BOOT}-0")


def forget() -> None:
    """Drop the in-memory copies (tests point the paths somewhere else)."""
    with _LOCK:
        _cache.clear()
        _revs.clear()


def get_drawings(key: str) -> tuple:
    """(the market's drawings, their revision)"""
    with _LOCK:
        return list(_read(DRAWINGS).get(key, [])), _rev(key)


def change_drawings(key: str, upsert, delete) -> tuple:
    """Apply one page's changes: replace or append drawings by id, remove ids. Returns (revision before, revision after)."""
    if not isinstance(key, str) or not KEY_RE.fullmatch(key):
        raise ValueError(f"bad market key {key!r}")
    upsert = upsert or []
    delete = delete or []
    if not isinstance(upsert, list) or not all(isinstance(x, dict) and isinstance(x.get("id"), str) and ID_RE.fullmatch(x["id"]) for x in upsert):
        raise ValueError("upsert must be a list of drawings, each with an id")
    if not isinstance(delete, list) or not all(isinstance(x, str) for x in delete):
        raise ValueError("delete must be a list of ids")
    with _LOCK:
        before = _rev(key)
        if not upsert and not delete:
            return before, before
        d = dict(_read(DRAWINGS))
        cur = list(d.get(key, []))
        gone = set(delete)
        cur = [x for x in cur if x.get("id") not in gone]
        at = {x.get("id"): i for i, x in enumerate(cur)}
        for x in upsert:
            if x["id"] in gone:
                continue
            if x["id"] in at:
                cur[at[x["id"]]] = x
            else:
                at[x["id"]] = len(cur)
                cur.append(x)
        if len(cur) > MAX_DRAWINGS:
            raise ValueError(f"more than {MAX_DRAWINGS} drawings on one market")
        if cur:
            d[key] = cur
        else:
            d.pop(key, None)
        _write(DRAWINGS, d)
        _cache[str(DRAWINGS)] = d
        _revs[key] = f"{_BOOT}-{next(_count)}"
        return before, _revs[key]


def get_settings() -> dict:
    with _LOCK:
        return dict(_read(SETTINGS))


def change_settings(changes) -> None:
    """Merge the top-level keys a page changed (a null value removes the key)."""
    if not isinstance(changes, dict):
        raise ValueError("settings must be an object")
    with _LOCK:
        d = dict(_read(SETTINGS))
        for k, v in changes.items():
            if v is None:
                d.pop(k, None)
            else:
                d[k] = v
        _write(SETTINGS, d)
        _cache[str(SETTINGS)] = d


# ---------------------------------------------------------------- indicators loaded from a file

def _index() -> list:
    d = _read(SCRIPTS / "index.json")
    items = d.get("scripts")
    return [x for x in items if isinstance(x, dict) and isinstance(x.get("id"), str) and ID_RE.fullmatch(x["id"])] if isinstance(items, list) else []


def script_id(name: str) -> str:
    """A script's id: its title in lower case, words joined by dashes ("TD Sequential" -> "td-sequential")."""
    return re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")[:40].strip("-") or "indicator"


def list_scripts() -> list:
    """The loaded scripts in the order they were first loaded, each with its source: [{id, name, file, added, updated, source}]."""
    with _LOCK:
        out = []
        for e in _index():
            try:
                out.append(dict(e, source=(SCRIPTS / (e["id"] + ".pine")).read_text(encoding="utf-8")))
            except (FileNotFoundError, UnicodeDecodeError):
                continue                                         # a file taken away by hand: the script is simply gone
        return out


def add_script(name, file, source) -> dict:
    """Keep a script the page loaded (and checked): a new one, or a new version of one with the same title."""
    if not isinstance(name, str) or not name.strip() or len(name) > 200:
        raise ValueError("a script needs its title (200 characters at most)")
    if not isinstance(file, str) or len(file) > 260:
        raise ValueError("bad file name")
    if not isinstance(source, str) or not source.strip() or len(source) > MAX_SCRIPT:
        raise ValueError(f"a script's source is text of {MAX_SCRIPT:,} characters at most")
    sid, now = script_id(name), int(time.time())
    with _LOCK:
        items = _index()
        old = next((x for x in items if x["id"] == sid), None)
        if not old and len(items) >= MAX_SCRIPTS:
            raise ValueError(f"{MAX_SCRIPTS} scripts at most: remove one first")
        entry = {"id": sid, "name": name.strip(), "file": os.path.basename(file), "added": old["added"] if old else now, "updated": now}
        body = source.encode("utf-8")
        SCRIPTS.mkdir(parents=True, exist_ok=True)
        X.write_durably(SCRIPTS / (sid + ".pine"), lambda f: f.write(body))
        items = [entry if x["id"] == sid else x for x in items] if old else items + [entry]
        d = {"scripts": items}
        _write(SCRIPTS / "index.json", d)
        _cache[str(SCRIPTS / "index.json")] = d
        return entry


def delete_script(sid) -> bool:
    """Take a script off the list and delete its copy here (the file it was loaded from is not touched)."""
    if not isinstance(sid, str) or not ID_RE.fullmatch(sid):
        raise ValueError("bad script id")
    with _LOCK:
        items = _index()
        if not any(x["id"] == sid for x in items):
            return False
        d = {"scripts": [x for x in items if x["id"] != sid]}
        _write(SCRIPTS / "index.json", d)
        _cache[str(SCRIPTS / "index.json")] = d
        try:
            (SCRIPTS / (sid + ".pine")).unlink()
        except FileNotFoundError:
            pass
        return True
