"""Crash-safety tests for the files in data/: durable writes, damaged-file detection, and the server downloading a
damaged market again instead of failing on it forever. Run with `python tests/test_storage.py` or `pytest`."""
import os
import shutil
import sys
import tempfile
import time
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import bybit_sync as X  # noqa: E402
import markets as MK  # noqa: E402

KEY = "linear:TESTUSDT"


class TempData:
    """Points every data path at a fresh temporary folder for the duration of a test."""

    def __enter__(self) -> Path:
        self.d = Path(tempfile.mkdtemp(prefix="dbc-store-"))
        self.old = X.DATA, MK.CACHE, MK.WATCHLIST
        X.DATA, MK.CACHE, MK.WATCHLIST = self.d, self.d / "instruments.json", self.d / "watchlist.json"
        return self.d

    def __exit__(self, *exc):
        X.DATA, MK.CACHE, MK.WATCHLIST = self.old
        shutil.rmtree(self.d, ignore_errors=True)


def candles(n: int, start_ms: int = 1_700_000_000_000) -> pd.DataFrame:
    ts = start_ms + np.arange(n, dtype=np.int64) * X.MINUTE
    px = 100 + np.arange(n) * 0.01
    return pd.DataFrame({"ts": ts, "open": px, "high": px + 1, "low": px - 1, "close": px,
                         "volume": np.ones(n), "turnover": px * 1e4})


def damage(p: Path, keep: float) -> None:
    """What the 2026-09-29 power cut did: the file kept its length, but only the first `keep` of its bytes reached the disk."""
    b = bytearray(p.read_bytes())
    cut = int(len(b) * keep)
    b[cut:] = bytes(len(b) - cut)
    p.write_bytes(bytes(b))


def test_round_trip_leaves_no_tmp():
    with TempData() as d:
        empty = X.load(KEY)                                      # no file yet: an empty frame, not an error
        assert len(empty) == 0 and list(empty.columns) == X.COLS
        df = candles(5000)
        X.save(KEY, df)
        pd.testing.assert_frame_equal(X.load(KEY), df)
        X.save(KEY, candles(6000))                               # replacing an existing file
        assert len(X.load(KEY)) == 6000
        assert [p.name for p in d.iterdir()] == ["bybit_linear_TESTUSDT.parquet"]


def test_bytes_reach_the_disk_before_the_rename():
    """The power-cut fix: every file in data/ is fsynced while still a .tmp, and only then renamed over the old one."""
    calls = []
    real_fsync, real_replace = os.fsync, os.replace

    def fsync(fd):
        calls.append(("fsync", os.fstat(fd).st_size))
        return real_fsync(fd)

    def replace(a, b):
        calls.append(("replace", Path(a).name, Path(b).name))
        return real_replace(a, b)

    with TempData():
        os.fsync, os.replace = fsync, replace
        try:
            X.save(KEY, candles(100))
            MK.save_watchlist(["BTC"])
            MK.save_cache({"spot": [], "linear": []}, {})
        finally:
            os.fsync, os.replace = real_fsync, real_replace
        assert MK.load_watchlist() == ["BTC"] and MK.load_cache() == ({"spot": [], "linear": []}, {})
    renames = [c[1:] for c in calls if c[0] == "replace"]
    assert renames == [("bybit_linear_TESTUSDT.tmp", "bybit_linear_TESTUSDT.parquet"),
                       ("watchlist.tmp", "watchlist.json"), ("instruments.tmp", "instruments.json")], calls
    for i, c in enumerate(calls):
        if c[0] == "replace":
            assert calls[i - 1][0] == "fsync" and calls[i - 1][1] > 0, calls   # the full .tmp was synced right before


def test_damaged_files_are_recognised():
    with TempData():
        p = X.path(KEY)
        spoilers = {
            "zero-filled tail (the 2026-09-29 file)": lambda: damage(p, 0.7),
            "zeros in the middle, footer intact": lambda: p.write_bytes(
                (lambda b: b[:len(b) // 3] + bytes(len(b) // 3) + b[2 * (len(b) // 3):])(p.read_bytes())),
            "truncated": lambda: p.write_bytes(p.read_bytes()[:-100]),
            "empty": lambda: p.write_bytes(b""),
            "all zeros": lambda: p.write_bytes(bytes(5000)),
        }
        for what, spoil in spoilers.items():
            X.save(KEY, candles(20_000))
            spoil()
            try:
                X.load(KEY)
            except X.Damaged as e:
                assert p.name in str(e), (what, e)
            else:
                raise AssertionError(f"{what}: damaged file loaded")
        X.save(KEY, candles(10).drop(columns=["turnover"]))       # a whole parquet, but not a candle file
        try:
            X.load(KEY)
        except X.Damaged as e:
            assert "turnover" in str(e)
        else:
            raise AssertionError("a file without turnover loaded")


def test_unreadable_or_out_of_memory_is_not_damage():
    """A file the OS will not hand over right now, or a machine short of RAM, is retried later, never set aside."""
    with TempData():
        X.path(KEY).mkdir()                                      # opening it fails (PermissionError on Windows)
        try:
            X.load(KEY)
        except X.Damaged:
            raise AssertionError("an unreadable file must not count as damaged")
        except OSError:
            pass
        else:
            raise AssertionError("expected OSError")
        X.path(KEY).rmdir()
        X.save(KEY, candles(100))
        real = pd.read_parquet

        def oom(*a, **k):
            raise MemoryError()
        pd.read_parquet = oom
        try:
            X.load(KEY)
        except MemoryError:
            pass
        else:
            raise AssertionError("expected MemoryError")
        finally:
            pd.read_parquet = real


def test_set_aside_keeps_one_copy():
    with TempData() as d:
        p = X.path(KEY)
        X.save(KEY, candles(1000))
        damage(p, 0.5)
        first = p.read_bytes()
        aside = X.set_aside(KEY)
        assert aside.name == "bybit_linear_TESTUSDT.parquet.damaged" and aside.read_bytes() == first and not p.exists()
        assert len(X.load(KEY)) == 0
        X.save(KEY, candles(2000))
        damage(p, 0.5)
        second = p.read_bytes()
        X.set_aside(KEY)                                         # a second accident replaces the older copy
        assert aside.read_bytes() == second and [x.name for x in d.iterdir()] == [aside.name]


def test_server_downloads_a_damaged_market_again():
    import server as S
    now_ms = int(time.time() * 1000) // X.MINUTE * X.MINUTE
    first = now_ms - 2500 * X.MINUTE
    fetched, notices = [], []

    def fake_fetch(key, start_ms, end_ms, stop=None):
        cap = int(time.time() * 1000) // X.MINUTE * X.MINUTE
        fetched.append(int(start_ms))
        notices.append(S.STATE["markets"][KEY].notice)
        return [[t, 100.0, 101.0, 99.0, 100.5, 10.0, 1e6] for t in range(int(start_ms), min(int(end_ms), cap) + 1, X.MINUTE)]

    with TempData() as d:
        X.save(KEY, candles(3000, start_ms=first))
        damage(X.path(KEY), 0.6)
        old = X.fetch, X.first_candle_ms
        X.fetch, X.first_candle_ms = fake_fetch, (lambda key, quick=False: first)
        try:
            m = S.STATE["markets"][KEY] = S.Market(KEY)
            S.sync_market(m, ("market", KEY))
        finally:
            X.fetch, X.first_candle_ms = old
            S.STATE["markets"].pop(KEY, None)
            S.STATE["index_first"].pop(KEY, None)
        assert m.sync == "live" and m.notice == "", (m.sync, m.notice)
        assert fetched[0] == first and "damaged" in notices[0], (fetched[:2], notices[:1])   # started over, and said why
        assert (d / "bybit_linear_TESTUSDT.parquet.damaged").exists()
        df = X.load(KEY)
        assert df["ts"].iloc[0] == first and df["ts"].iloc[-1] >= now_ms - X.MINUTE and df["ts"].is_monotonic_increasing
        assert m.sets and m.meta["n_candles"] == len(df)


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_"):
            fn()
            print("ok", name)
