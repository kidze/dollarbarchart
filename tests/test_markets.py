"""Search / alias / depth-choice tests on a small fake instrument list. Run with `python tests/test_markets.py` or `pytest`."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import markets as MK  # noqa: E402

RAW = {
    "fetched": 0,
    "spot": [
        {"symbol": "BTCUSDT", "base": "BTC", "quote": "USDT", "name": "", "type": "", "underlying": "", "launch": 0},
        {"symbol": "BTCUSDC", "base": "BTC", "quote": "USDC", "name": "", "type": "", "underlying": "", "launch": 0},
        {"symbol": "PUMPUSDT", "base": "PUMP", "quote": "USDT", "name": "", "type": "", "underlying": "", "launch": 0},
        {"symbol": "NVDAXUSDT", "base": "NVDAX", "quote": "USDT", "name": "", "type": "xstocks", "underlying": "", "launch": 0},
        {"symbol": "LITUSDT", "base": "LIT", "quote": "USDT", "name": "", "type": "", "underlying": "", "launch": 0},
        {"symbol": "PEPEUSDT", "base": "PEPE", "quote": "USDT", "name": "", "type": "", "underlying": "", "launch": 0},
    ],
    "linear": [
        {"symbol": "BTCUSDT", "base": "BTC", "quote": "USDT", "name": "Bitcoin", "type": "", "underlying": "", "launch": 1584230400000},
        {"symbol": "PUMPFUNUSDT", "base": "PUMPFUN", "quote": "USDT", "name": "pump-fun", "type": "", "underlying": "", "launch": 1752119132000},
        {"symbol": "NVDAUSDT", "base": "NVDA", "quote": "USDT", "name": "NVIDIA", "type": "stock", "underlying": "NVDA", "launch": 1778056269000},
        {"symbol": "LITUSDT", "base": "LIT", "quote": "USDT", "name": "Lighter", "type": "", "underlying": "", "launch": 1767089298000},
        {"symbol": "LITEUSDT", "base": "LITE", "quote": "USDT", "name": "Lumentum", "type": "stock", "underlying": "LITE", "launch": 1770000000000},
        {"symbol": "1000PEPEUSDT", "base": "1000PEPE", "quote": "USDT", "name": "", "type": "", "underlying": "", "launch": 1683108271000},
        {"symbol": "HYPERUSDT", "base": "HYPER", "quote": "USDT", "name": "Hyperlane", "type": "", "underlying": "", "launch": 0},
        {"symbol": "HYPEUSDT", "base": "HYPE", "quote": "USDT", "name": "Hyperliquid", "type": "", "underlying": "", "launch": 0},
    ],
}
FIRST = {"linear:BTCUSDT": 1584230400000, "spot:BTCUSDT": 1625486400000, "spot:PUMPUSDT": 1752513000000, "linear:PUMPFUNUSDT": 1752119132000}


def rows():
    return MK.build_rows(RAW, FIRST)


def test_tickers_and_names():
    by = {r["key"]: r for r in rows()}
    assert by["linear:PUMPFUNUSDT"]["ticker"] == "PUMP"
    assert by["spot:NVDAXUSDT"]["ticker"] == "NVDA" and by["spot:NVDAXUSDT"]["stock"]
    assert by["spot:BTCUSDT"]["name"] == "Bitcoin"                  # spot borrows the perp's name
    assert by["spot:NVDAXUSDT"]["name"] == "NVIDIA"
    assert by["linear:1000PEPEUSDT"]["ticker"] == "1000PEPE"


def test_search_ranking():
    r = rows()
    assert [x["key"] for x in MK.search(r, "pump")] == ["linear:PUMPFUNUSDT", "spot:PUMPUSDT"]
    keys = [x["key"] for x in MK.search(r, "LIT")]
    assert keys[:2] == ["linear:LITUSDT", "spot:LITUSDT"] and "linear:LITEUSDT" in keys
    assert [x["key"] for x in MK.search(r, "nvda")] == ["linear:NVDAUSDT", "spot:NVDAXUSDT"]
    assert [x["key"] for x in MK.search(r, "pepe")] == ["linear:1000PEPEUSDT", "spot:PEPEUSDT"]
    assert [x["key"] for x in MK.search(r, "hype")][0] == "linear:HYPEUSDT"
    assert [x["key"] for x in MK.search(r, "btc")] == ["linear:BTCUSDT", "spot:BTCUSDT", "spot:BTCUSDC"]
    assert MK.search(r, "bitcoin")[0]["key"] == "linear:BTCUSDT"
    assert MK.search(r, "") == [] and MK.search(r, "zzz") == []


def test_candidates_and_deepest():
    r = rows()
    c = MK.candidates(r, "btc")
    assert [x["key"] for x in c] == ["linear:BTCUSDT", "spot:BTCUSDT", "spot:BTCUSDC"]
    assert MK.deepest(c)["key"] == "linear:BTCUSDT"
    c = MK.candidates(r, "PUMP")
    assert MK.deepest(c)["key"] == "linear:PUMPFUNUSDT"
    assert MK.deepest(MK.candidates(r, "NVDA")) is None            # depth not probed yet
    assert MK.candidates(r, "nothing") == []


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_"):
            fn()
            print("ok", name)
