# dollarbarchart

A live **dollar-bar** chart for any Bybit market, running on your own machine from free data. Dollar bars
are the sampling scheme López de Prado recommends over time bars in *Advances in Financial Machine
Learning* (ch. 2): instead of closing a candle every N minutes, a bar closes every time **N dollars have
traded**. Busy periods produce many bars, quiet weekends produce few, and every bar carries the same
amount of market activity. TradingView does not draw them, so this does.

![BTC dollar bars](docs/screenshot.png)

* **Any ticker.** Type `PUMP`, `HYPE`, `NVDA`… and pick from Bybit's ~470 USDT/USDC spot pairs and ~850
  perpetuals (including tokenized US stocks and stock perps). Enter picks the market with the **most
  history**; the list shows how far back each spot/perp market goes.
* **Free data, no keys:** Bybit's public 1-minute candles with exchange-reported turnover, from each
  market's first trade to the current minute, polled every 5 s so the forming bar moves.
* **All venues** (the last row in every picker group): one series per ticker that **sums the dollars
  traded on Bybit, OKX, Coinbase, KuCoin and Bitfinex** minute by minute, with the deepest history any of
  them has (Bitfinex BTC/USD starts in 2013, Coinbase in 2015, OKX and KuCoin in 2017–18). Prices come
  from the first of those that traded the minute (Bybit perp, then spot, OKX, Coinbase…). Each venue is
  downloaded into its own file while the market is on screen, in order of speed, and the chart is
  re-merged as they arrive; a ticker that means a different coin on some exchange is left out
  automatically (its price is checked against the others first). The first download of BTC is long
  (about 4 hours of open-app time across the five venues; a 2025 coin takes 30–60 minutes), but it
  resumes across sessions and never runs while the window is closed.
* Bar sizes from a tenth of the market's median day to ten times it, plus ordinary time bars
  (1h, 4h, 1D, 1W, 1M) on the same chart for comparison.
* TradingView-style chart (Lightweight Charts): drag the price or time axis to zoom, double-click to reset,
  `A` auto-scale and `L` log-scale buttons, OHLC + bar duration + dollars on hover, bar statistics in the
  header (count, median / fastest / slowest bar, busiest and quietest month, last 365 days, forming bar).
* **Nothing runs while the window is closed.** Downloads happen only while the app is open; two minutes
  after the last page request the server writes what it has to disk and exits. The next launch resumes.
* A **watchlist** (☆ next to the ticker) is downloaded in the background while the app is open, so those
  tickers open instantly later. Everything else is fetched the first time you pick it, and the chart grows
  while the download runs (a few minutes for a young coin, ~20 minutes for the full BTC history).
* Updates itself: when the files on disk change, a banner offers **Update now**, which reloads the page or
  restarts the server in place, without closing the window.

## Run

Needs Python 3.10+ with `numpy`, `pandas` and `pyarrow` (`pip install -r requirements.txt`).

* **Windows:** double-click `launch.cmd`. It starts the server (windowless), waits for it, and opens the
  chart as its own window in Edge or Chrome (falls back to your default browser).
* **macOS / Linux:** `sh launch.sh`.
* **By hand:** `python server.py`, then open <http://127.0.0.1:8793/>.

Candles are stored per market in `data/` (about 16 MB per market-year; the full BTC perpetual history is
~110 MB; "all venues" for BTC adds one file per venue, ~500 MB in total). `data/watchlist.json` holds the
watchlist; edit it or use the ☆ button.

## How the bars are cut

A dollar bar opens with a 1-minute candle and closes with the candle whose turnover brings the dollars traded
*since the bar opened* to the chosen size. Every completed bar therefore holds at least the size, plus the
overflow of its final minute (at $5.5B on BTC the largest overflow in six years is 10%; at $1B a single
huge minute can overshoot by half). The forming bar is the incomplete tail and is redrawn every 5 seconds.
Bar times are open times, like TradingView; the x-axis is bar order, not the clock, so every bar is the
same width however long it took.

Time bars are the usual candles with weeks starting Monday 00:00 UTC and months on the 1st.

## Files

| file | role |
|---|---|
| `bybit_sync.py` | keyless Bybit v5 kline requests; one parquet per market; streaming, resumable, checkpointed backfill that stops within one request when asked |
| `markets.py` | instrument index (cached daily), ticker aliases (PUMPFUN → PUMP, NVDAX → NVDA), search ranking, deepest-history choice, watchlist file |
| `venues.py` | the other exchanges' public 1-minute candles (OKX, KuCoin, Coinbase, Bitfinex; Bybit wrapped alike): instrument lists cached daily, one resumable parquet + sidecar per series, forward paging or OKX's backwards paging |
| `combined.py` | merges several venues' candles into one series: dollars and coin volume summed per minute, prices from the highest-priority venue that has the minute |
| `bars.py` | dollar bars and time bars from the candles, incrementally as new minutes arrive; per-market size menu |
| `server.py` | local HTTP server: `/bars?m=` (full history), `/live?m=` (last bars + forming bar), `/search?q=`, `/pick?t=`, `/watchlist`, `/ping`, `/restart`; one download worker (on-screen market first, then depth probes, then the watchlist); idle exit |
| `index.html` | the chart page and ticker picker |
| `lightweight-charts.js` | TradingView Lightweight Charts v5.2.1, vendored (Apache-2.0, logo must stay) |
| `tests/` | bar-cutting, search and venue-sync tests: `python tests/test_bars.py`, `python tests/test_markets.py`, `python tests/test_venues.py` (or `pytest`) |

Market keys are `linear:SYMBOL` (perpetual), `spot:SYMBOL`, or `all:TICKER` (every venue summed); the page
keeps the current one in the URL hash, so `http://127.0.0.1:8793/#spot:PUMPUSDT` or `#all:BTC` opens that
market directly.

## What "all venues" means, exactly

Coinbase and Bitfinex publish only coin volume per minute, so their dollars are `volume × close`; Bybit,
OKX and KuCoin report quote turnover. Binance is not included (its public API is rate-limited per IP and
this machine's other tools share it) and neither is Hyperliquid (it keeps ~5000 candles per timeframe and
reports no dollar volume). Only one spot and one perpetual per venue are used (the venue's main dollar
quote: USD on Coinbase/Bitfinex, USDT elsewhere), and Bybit's 1000× contracts (1000PEPE) are left out
because their prices are not the coin's. A minute that a venue is missing simply contributes nothing.
During a live session each venue is polled every 5 s; a venue that stops answering keeps its last minute
for up to a minute and then drops out of the forming bar until it answers again (the next launch re-merges
everything from disk).

## Developing without breaking the running app

The server watches its own files, so never edit the folder it runs from. Work on a branch in a separate
checkout on another port, then merge:

```
git worktree add .worktrees/my-feature -b my-feature
set DOLLARBARS_PORT=8794 && python .worktrees\my-feature\server.py      # its own data/ and logs/
```

When the branch is merged and pulled into the main checkout, the running app shows the update banner.

## Licence

MIT (see `LICENSE`). Lightweight Charts is Apache-2.0, © TradingView, Inc.
