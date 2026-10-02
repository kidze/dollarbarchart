"""What the owner makes on the chart and wants back next time: drawings (per market) and the chart's look.

Both live in data/ next to the candles and are written the same crash-safe way (bybit_sync.write_durably):
  data/drawings.json   {"linear:BTCUSDT": [drawing, ...], ...}    one list per market, shared by every bar size
  data/settings.json   {"appearance": {...}, ...}                 whatever the page sends
The page owns the format of a drawing and of the settings; this module only checks shape and size, keeps a copy
in memory and writes the file. A file that cannot be parsed is kept aside as <name>.damaged and treated as empty,
so one bad file never stops the chart from opening.
"""
import json
import os
import re
import threading

import bybit_sync as X

DRAWINGS = X.DATA / "drawings.json"
SETTINGS = X.DATA / "settings.json"
MAX_BODY = 4_000_000                                             # bytes of one POST
MAX_DRAWINGS = 5_000                                             # per market
KEY_RE = re.compile(r"[a-z]+:[A-Za-z0-9._-]{1,40}")              # market keys: linear:BTCUSDT, spot:PUMPUSDT

_LOCK = threading.Lock()
_cache = {}                                                      # file path -> parsed dict


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


def forget() -> None:
    """Drop the in-memory copies (tests point the paths somewhere else)."""
    with _LOCK:
        _cache.clear()


def get_drawings(key: str) -> list:
    with _LOCK:
        return list(_read(DRAWINGS).get(key, []))


def put_drawings(key: str, drawings) -> None:
    if not isinstance(key, str) or not KEY_RE.fullmatch(key):
        raise ValueError(f"bad market key {key!r}")
    if not isinstance(drawings, list) or not all(isinstance(x, dict) for x in drawings):
        raise ValueError("drawings must be a list of objects")
    if len(drawings) > MAX_DRAWINGS:
        raise ValueError(f"more than {MAX_DRAWINGS} drawings on one market")
    with _LOCK:
        d = dict(_read(DRAWINGS))
        if drawings:
            d[key] = drawings
        else:
            d.pop(key, None)
        _write(DRAWINGS, d)
        _cache[str(DRAWINGS)] = d


def get_settings() -> dict:
    with _LOCK:
        return dict(_read(SETTINGS))


def put_settings(settings) -> None:
    if not isinstance(settings, dict):
        raise ValueError("settings must be an object")
    with _LOCK:
        _write(SETTINGS, settings)
        _cache[str(SETTINGS)] = dict(settings)
