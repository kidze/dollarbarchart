# dollarbarchart

A live BTC **dollar-bar** chart that runs on your own machine. Dollar bars are the sampling scheme
López de Prado recommends over time bars in *Advances in Financial Machine Learning* (ch. 2): instead of
closing a candle every N minutes, a bar closes every time **N dollars have traded**. Busy periods produce many
bars, quiet weekends produce few, and every bar carries the same amount of market activity. TradingView
does not draw them, so this does.

![BTC dollar bars](docs/screenshot.png)

* Free data, no keys: Bybit's public BTCUSDT perpetual 1-minute candles (exchange-reported turnover), from
  2020-03-25 to the current minute, polled every 5 seconds so the forming bar moves.
* Bar sizes $1B, $2B, $5B, $10B, $20B, $50B plus the median day's turnover as the default, and ordinary
  time bars (1h, 4h, 1D, 1W, 1M) on the same chart for comparison.
* TradingView-style chart (Lightweight Charts): drag the price or time axis to zoom, double-click to reset,
  `A` auto-scale and `L` log-scale buttons on the price axis, OHLC + bar duration + dollars on hover.
* Bar statistics in the header: bar count, median / fastest / slowest bar duration, busiest and quietest
  month, bars in the last 365 days, how full the forming bar is.
* Updates itself: when the files on disk change, a banner offers **Update now**, which reloads the page or
  restarts the server in place, without closing the window.

## Run

Needs Python 3.10+ with `numpy`, `pandas` and `pyarrow` (`pip install -r requirements.txt`).

* **Windows:** double-click `launch.cmd`. It starts the server, waits for it, and opens the chart as its own
  window in Edge or Chrome (falls back to your default browser).
* **macOS / Linux:** `sh launch.sh`.
* **By hand:** `python server.py`, then open <http://127.0.0.1:8793/>.

The first run downloads about six years of 1-minute candles (3.4 million rows, ~110 MB parquet in `data/`),
which takes around 20 minutes at Bybit's public rate limit; the chart shows the download progress. Every later
start only fetches what is missing. The server quits by itself two minutes after the window is closed.

## How the bars are cut

A dollar bar opens with a 1-minute candle and closes with the candle whose turnover brings the dollars traded
*since the bar opened* to the chosen size. Every completed bar therefore holds at least the size, plus the
overflow of its final minute (at $5.5B the largest overflow in six years is 10%; at $1B a single huge minute
can overshoot by half). The forming bar is the incomplete tail and is redrawn every 5 seconds. Bar times are
open times, like TradingView; the x-axis is bar order, not the clock, so every bar is the same width however
long it took.

Time bars are the usual candles with weeks starting Monday 00:00 UTC and months on the 1st.

## Files

| file | role |
|---|---|
| `bybit_sync.py` | downloads and updates the candle file (`data/bybit_btcusdt_1m.parquet`); resumable, checkpointed, atomic writes |
| `bars.py` | builds dollar bars and time bars from the candles, incrementally as new minutes arrive |
| `server.py` | local HTTP server on port 8793: `/bars` (full history), `/live` (last bars + forming bar), `/ping`, `/restart` |
| `index.html` | the chart page |
| `lightweight-charts.js` | TradingView Lightweight Charts v5.2.1, vendored (Apache-2.0, logo must stay) |
| `tests/test_bars.py` | bar-cutting tests: `python tests/test_bars.py` (or `pytest`) |

Other coins: change `SYMBOL` in `bybit_sync.py` (any Bybit linear perpetual) and delete `data/`.

## Licence

MIT (see `LICENSE`). Lightweight Charts is Apache-2.0, © TradingView, Inc.
