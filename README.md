# kidze chart

A live **dollar-bar** chart for any coin, combined across the big exchanges, running on your own machine from
free data. Dollar bars
are the sampling scheme López de Prado recommends over time bars in *Advances in Financial Machine
Learning* (ch. 2): instead of closing a candle every N minutes, a bar closes every time **N dollars have
traded**. Busy periods produce many bars, quiet weekends produce few, and every bar carries the same
amount of market activity. TradingView does not draw them, so this does.

![kidze chart: BTC dollar bars](docs/screenshot.png)

* **Combined across exchanges (the default).** A ticker's chart is every exchange that lists it, spot and
  perpetual: Binance, Bybit, OKX, Coinbase, Bitstamp, Kraken, KuCoin, Bitfinex. Dollars are summed; each minute's open,
  high, low and close is the dollar-weighted median of the exchanges that traded it, so one exchange's bad print
  cannot move the chart. A price 2x away from the minutes around it that no second exchange shows within a
  minute is a bad print even when nobody can outvote it (Bitfinex sold BTC at $0.01 in April 2013, when it was
  the only exchange trading): it takes the other exchanges' price, or the candle's body when there are none.
  A minute only one exchange traded, while an exchange with 3x its dollars over the day before traded within 5
  minutes of it, may print at most 3% beyond that exchange's range there (Kraken's thin 2014 BTC/USD book sold at
  $295 while the market was at $400). A crash every exchange shows stays. History goes back as far as the oldest exchange (BTC: Bitstamp 2011). A market an
  exchange lists under the same ticker but for another coin is left out (latest price more than 10% off
  Bybit's), and so is history from before an exchange handed the symbol to this coin (a gap of 14+ days
  across which the price does not carry on, a 4x price jump in a day that Bybit did not make, or three days
  within a month more than 30% off Bybit's price). A gap where the price does carry on is only missing data
  (Bitfinex has no BTC minutes for April-May 2016): the history before it stays, and the hours an exchange
  serves no minutes for are filled from its 5-minute or hourly candles where it has them (Bitfinex BTC
  2014-11/12, 2015-05, 2016-04/05; ETH 2016-04/05). Coinbase's minutes go back to its opening day 2015-01-26
  and Binance's oldest perps to their listing (BTC 2019-09), before the archive starts. The header says how
  many exchanges and markets are in; hover it for the list.
* **Any ticker.** Type `PUMP`, `HYPE`, `NVDA`… Enter opens the combined chart; the picker also lists each
  Bybit spot/perp market on its own, with how far back it goes.
* **Free data, no keys:** public 1-minute candles with exchange-reported turnover (Coinbase, Bitstamp, Kraken
  and Bitfinex report coin volume, so their dollars are volume × close), from each market's first trade to the current
  minute, polled every 5 s so the forming bar moves. Binance's history comes from its public archive
  (data.binance.vision, one file per month) and its live minutes from its websocket stream, so the app adds
  almost nothing to the request weight other Binance users on the same machine spend. Binance's archive is
  licensed for personal, non-commercial use. Kraken's history comes from its free OHLCVT archive (1-minute
  candles of every pair from its first trade: ETH from 2015-08, ZEC from 2016-10; a 9.5 GB zip of which only
  the pair's file is read, with range requests), the weeks after the archive from its public trades summed into
  minutes (about one request a second: BTC's first download takes a while), the last hours from its OHLC feed.
* Bar sizes from a tenth of the market's median day to ten times it, plus the median 1h, 4h, week and month
  (last 365 days, whole UTC periods with trades), each labelled in the menu, plus ordinary time bars
  (1h, 4h, 1D, 1W, 1M) on the same chart for comparison.
* **Adaptive sizes** (≈24, ≈6 or ≈1 bar a day): each bar's size is the median of the 30 days with trades
  before it, divided by the target, so a coin whose trading grew 100x keeps a steady number of bars through its
  whole history instead of squashing its early years into a handful of bars. Only past days set a size; days
  without any candle (a hole in the data, a halted market) are skipped, not counted as $0.
* TradingView-style chart (Lightweight Charts): drag the price or time axis to zoom, double-click to reset,
  `A` auto-scale and `L` log-scale buttons, OHLC + bar duration + dollars on hover, bar statistics in the
  header (count, median / fastest / slowest bar, busiest and quietest month, last 365 days, forming bar).
  Zooming out goes as far as the whole history.
* **Trend lines and rectangles**, drawn like on TradingView: pick the tool in the left toolbar (`Alt+T` for the
  line, `Alt+Shift+R` for the rectangle), click two points or press-drag-release; hold `Shift` for a horizontal
  line or a square. Click a drawing to select it, drag it or its grips (a rectangle has eight: corners and the
  middle of each side), `Delete` removes it, double-click opens its settings (color with opacity, width, style,
  extend left/right; a line's middle point, price labels and stats; a rectangle's background), `Ctrl+Z` /
  `Ctrl+Y` undo and redo, `Esc` cancels. The **magnet** in the left toolbar snaps a point being placed or
  dragged to the open, high, low or close of the bar under the mouse when the mouse is within 10 pixels of it
  (hold `Ctrl` to flip it for a moment). The left toolbar also
  has stay-in-drawing-mode, lock all, hide all (`Ctrl+Alt+H`) and remove all. Drawings are saved per market
  and anchored by time and price, so they show on every bar size and time frame. Two app windows open at once
  show each other's changes and never overwrite each other; if a save fails (server restarting) the top bar
  says so in red and it is retried until it works.
* **Indicators** (button in the top bar): lines computed from the bars, each switched on or off from the menu
  and remembered. Two so far, both Bitcoin power laws, `price = a × (days since 2009-01-03) ^ n`, on Bitcoin
  charts only. A line depends on the date alone, so it is the same curve on dollar bars and time bars; each
  bar gets the value at the moment it closed. The legend shows each line's value at the bar under the mouse.
  * **Power law 2013** (gold): exactly as posted on Bitcointalk in February 2013 and never refitted,
    `price = 4.41877e-17 × days ^ 5.59807`. With it come thinner lines at its multiples where every past
    cycle bottomed (0.54× Aug 2015, 0.82× Feb 2019, 0.68× Mar 2020, 0.65× Nov 2022, 0.66× Jun 2026) and
    topped (15.7× Nov 2013, 9.4× Dec 2017, 5.2× Mar 2021, 2.0× Dec 2024; dashed): the daily close as a
    multiple of the line on the day that multiple was lowest or highest.
  * **Power law BlockchainCenter** (violet): the fit shown on blockchaincenter.net/bitcoin-power-law on
    2026-11-20, `log10(price) = -15.5134 + 5.4066 × log10(days)`. The site refits its line every day; this
    is that day's fit, kept fixed. With it come the site's corridor, support (0.37× the line) and top
    (3.51×, dashed), the 5th and 95th percentile of the price's distance from the line, and the line's
    multiples at the same five cycle lows, worked out the same way (0.35× Aug 2015, 0.57× Feb 2019,
    0.48× Mar 2020, 0.48× Nov 2022, 0.51× Jun 2026).

  Auto scale follows the candles only: no line and no multiple makes the price axis wider.
* **Auto scale leaves an abnormal candle's far end out.** One wick to a tenth of a cent (a bad fill, a flash
  crash on one exchange), or the first bar of a long history (years of prices in one candle), would squeeze
  every other candle into a strip. Auto scale fits the candles on screen without that far end: it runs off
  the edge, the legend still shows the candle's real prices, and dragging the price axis shows all of it.
  Abnormal means the end sticks out further than all the candles around it (the ones on screen, a hundred at
  least) are tall together, so it is the same candle at every zoom. Closes where the price stayed for two
  bars or more, and the price now, are always in view. With no abnormal candle on screen the fit is the
  chart's own: every high and low, 10% free above and below.
* **Chart settings** (gear in the top bar): candle body, borders and wick on/off with up and down colors, and
  a solid or gradient background, all with opacity, in a TradingView-style color picker (its palette, your
  own custom colors, an opacity slider). Changes preview live; Cancel puts the chart back.
* **Nothing runs while the window is closed.** Downloads happen only while the app is open; two minutes
  after the window is closed the server writes what it has to disk and exits. The next launch resumes. A
  window left open but hidden, minimized or asleep (Edge slows or stops its requests) keeps the server: it
  looks for a visible Edge or Chrome window titled "… kidze chart" before it stops.
* A **watchlist** (☆ next to the ticker) is downloaded in the background while the app is open, so those
  tickers open instantly later. Everything else is fetched the first time you pick it, all exchanges at once,
  and the chart grows while the download runs (a few minutes for a young coin; hours for the full BTC history
  on every exchange, because OKX and Coinbase hand out 300 minutes a request).
* Updates itself: when the files on disk change, a banner offers **Update now**, which reloads the page or
  restarts the server in place, without closing the window.

## Run

Needs Python 3.10+ with `numpy`, `pandas` and `pyarrow` (`pip install -r requirements.txt`).

* **Windows:** double-click `launch.cmd`. It starts the server (windowless), waits for it, and opens the
  chart as its own window in Edge or Chrome (falls back to your default browser). The window opens at the
  size and place you left it (the first time: 90% of the screen).
* **macOS / Linux:** `sh launch.sh`.
* **By hand:** `python server.py`, then open <http://127.0.0.1:8793/>.

Candles are stored per market in `data/` (about 16 MB per market-year; the full BTC perpetual history is
~110 MB). `data/watchlist.json` holds the watchlist; edit it or use the ☆ button. Your drawings are in
`data/drawings.json` and the chart settings in `data/settings.json`.

Every file in `data/` is written to a temporary file, forced to the disk, then swapped in, so a crash or a
power cut leaves either the old version or the new one. A market file that is damaged anyway (for example
by a power cut before this was in place) is moved aside as `<name>.parquet.damaged` and the market is
downloaded again; the chart says so while it happens. The `.damaged` copy can be deleted.

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
| `venues.py` | the other exchanges' 1-minute candles (Binance archive + REST + websocket, OKX, Coinbase, Bitstamp, Kraken archive + trades + OHLC, KuCoin, Bitfinex with its coarser candles for minute holes, and Bybit wrapped alike); one parquet per series in `data/<exchange>_<symbol>.parquet`; resumable syncs; which market means a ticker on each exchange |
| `combined.py` | the merge (dollars summed, dollar-weighted median prices), the repair of bad prints no second exchange confirms, and the same-coin history check |
| `bars.py` | dollar bars and time bars from the candles, incrementally as new minutes arrive; per-market size menu |
| `server.py` | local HTTP server: `/bars?m=&k=` (full history of the set shown), `/live?m=` (last bars + forming bar), `/search?q=`, `/pick?t=`, `/watchlist`, `/drawings?m=`, `/settings`, `/static/…`, `/ping`, `/restart`; one download worker (on-screen market first, then depth probes, then the watchlist); idle exit |
| `userdata.py` | saved drawings (per market) and chart settings, written crash-safe like the candles; only the app's own page may change them |
| `index.html` | the page layout: top bar, drawing toolbar, chart |
| `static/app.js` | loading and live-updating the chart, ticker picker, watchlist, stats, legend, update banner |
| `static/draw.js` | the drawing tools (trend line, rectangle, magnet), their toolbars and settings, undo/redo, saving |
| `static/indicators.js` | the indicators (two Bitcoin power laws), their menu and legend row |
| `static/settings.js` | the chart settings dialog (candles, background) |
| `static/window.js` | the app window's size and place, remembered between launches |
| `static/ui.js`, `static/app.css` | color picker, menus, dialogs; the page's styles |
| `lightweight-charts.js` | TradingView Lightweight Charts v5.2.1, vendored (Apache-2.0, logo must stay) |
| `tests/` | bar-cutting, search, crash-safety, saved-drawings and exchange/merge tests: `python tests/test_bars.py`, `python tests/test_markets.py`, `python tests/test_storage.py`, `python tests/test_userdata.py`, `python tests/test_venues.py` (or `pytest`) |

Market keys are `linear:SYMBOL` (perpetual) or `spot:SYMBOL`; the page keeps the current one in the URL
hash, so `http://127.0.0.1:8793/#spot:PUMPUSDT` opens that market directly.

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
