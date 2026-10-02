"""What the owner makes on the chart and wants back next time: drawings (per market) and the chart's look.

Both live in data/ next to the candles and are written the same crash-safe way (bybit_sync.write_durably):
  data/drawings.json   {"linear:BTCUSDT": [drawing, ...], ...}    one list per market, shared by every bar size
  data/settings.json   {"appearance": {...}, ...}                 whatever the page sends

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
import uuid

import bybit_sync as X

DRAWINGS = X.DATA / "drawings.json"
SETTINGS = X.DATA / "settings.json"
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
