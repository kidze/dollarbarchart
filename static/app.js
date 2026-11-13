/* The chart page: loads a market's bar sets from the local server, keeps the forming bar live, the ticker picker,
   watchlist, hover legend, info panel, update banner, and wires the settings dialog (settings.js), the drawing
   tools (draw.js) and the indicators (indicators.js) to the chart. */
(function(){
  'use strict';
  var app = window.DBCApp = {};                                  // index.html checks this exists (all scripts arrived)
  var LC = window.LightweightCharts, TF = ['1h','4h','1D','1W','1M'];
  var TF_S = {'1h':3600, '4h':14400, '1D':86400, '1W':604800};
  var $ = UI.$, esc = UI.esc;

  var PB = (document.querySelector('meta[name="dbc-build"]') || {}).content || '';   // the page build this window was served
  var P = {}, LS = false; try { P = JSON.parse(localStorage.getItem('dollarbars') || '{}'); LS = true; } catch (e) {}
  var market = (location.hash || '').slice(1) || P.market || 'all:BTC';
  var toCombined = LS && !P.combined, toTries = 0, settled = !toCombined;   // once: a Bybit-only chart saved by an older version opens as its combined chart
  var mode = P.mode || 'dollar', sizes = P.sizes || {}, size = sizes[market] || null, tf = P.tf || '1D', logScale = !!P.log;
  var meta = null, bars = [], forming = null, byTime = {}, loading = false, retryTimer = null, restarting = false, update = null;
  var lastFullLoad = 0, qTimer = null, lastRows = [], seq = 0;
  var save = function(){ sizes[market] = size; try { localStorage.setItem('dollarbars', JSON.stringify({market:market, mode:mode, sizes:sizes, tf:tf, log:logScale, combined:settled ? 1 : 0})); } catch (e) {} };
  var fmtD = function(x){ return x >= 1e9 ? '$' + (x >= 1e10 ? (x/1e9).toFixed(0) : (x/1e9).toFixed(1)) + 'B' : x >= 1e6 ? '$' + (x >= 1e7 ? (x/1e6).toFixed(0) : (x/1e6).toFixed(1)) + 'M' : x >= 1e4 ? '$' + Math.round(x/1e3) + 'K' : x >= 1e3 ? '$' + (x/1e3).toFixed(1) + 'K' : '$' + Math.round(x); };
  var fmtP = function(p){ if (p < 0) return '-' + fmtP(-p); if (p >= 1000) return p.toLocaleString('en-US',{maximumFractionDigits:0}); if (p >= 1) return p.toFixed(p >= 100 ? 1 : 2); if (!(p > 0)) return String(p); return p.toFixed(Math.min(20, 3 - Math.floor(Math.log10(p)))); };
  var fmtT = function(t){ return new Date(t*1000).toISOString().slice(0,16).replace('T',' ') + 'Z'; };
  var fmtDay = function(t){ return new Date(t*1000).toISOString().slice(0,10); };
  var fmtMon = function(ms){ return new Date(ms).toISOString().slice(0,7); };
  var fmtHrs = function(h){ return h >= 48 ? (h/24).toFixed(1) + ' days' : h >= 1 ? h.toFixed(1) + ' h' : Math.round(h*60) + ' min'; };
  var adaptive = function(s){ return typeof s === 'string' && s.indexOf('a:') === 0; };   // 'a:6' = about 6 bars a day, sized from the 30 days before
  var key = function(){ return mode === 'dollar' ? (adaptive(size) ? size : 'd:' + size) : 't:' + tf; };
  var capOf = function(r){ return adaptive(size) ? r.z : size; };   // the dollars a bar needed to close
  var sizeLabel = function(s){ return adaptive(s) ? s.slice(2) + ' / day' : fmtD(s); };    // the size button and menu
  // a size that is the median turnover of an hour, day, week…: one such bar takes about that long
  var MEDIAN = [['1h','≈ 1 hour'], ['4h','≈ 4 hours'], ['1D','≈ 1 day'], ['1W','≈ 1 week'], ['1M','≈ 1 month']];
  var sizeNote = function(s){
    var md = meta.medians || {'1D': meta.auto_size}, n = MEDIAN.filter(function(m){ return md[m[0]] === s; }).map(function(m){ return m[1]; });
    return n.join(', ');
  };
  var dur = function(sec){ var h = sec / 3600; return h >= 48 ? (h/24).toFixed(1) + 'd' : h >= 1 ? h.toFixed(1) + 'h' : Math.max(1, Math.round(h*60)) + 'm'; };
  var nearestSize = function(list, s){ return list.reduce(function(a, b){ return Math.abs(Math.log(b/s)) < Math.abs(Math.log(a/s)) ? b : a; }); };
  var sameBar = function(a, b){ return a && b && a.t === b.t && a.o === b.o && a.h === b.h && a.l === b.l && a.c === b.c && a.d === b.d; };

  // ---------------------------------------------------------------- saving to the server
  // A save is an ordinary request whose answer is read. Only the last one, sent as the window closes, is a keepalive request:
  // the browser lets those carry 64 KB at most, counted until their answers are read.
  function post(url, obj, closing){
    var body = JSON.stringify(obj);
    return fetch(url, {method:'POST', headers:{'Content-Type':'application/json'}, body: body,
                       keepalive: !!closing && new Blob([body]).size < 60000})
      .then(function(r){ return r.json().catch(function(){ return {}; }).then(function(j){ if (!r.ok || !j.ok) throw new Error(j.error || 'HTTP ' + r.status); return j; }); });
  }
  // what could not be saved (or loaded) right now, shown in red in the top bar until a retry works
  var failing = {};
  function saveState(what, problem){
    if (problem) failing[what] = problem; else delete failing[what];
    var k = Object.keys(failing), e = $('unsaved');
    e.className = k.length ? 'show' : '';
    e.textContent = k.length ? '⚠ ' + failing[k[0]] : '';
    e.title = k.map(function(w){ return failing[w]; }).join('\n') + '\nRetrying by itself; nothing is lost while this window stays open.';
  }

  // ---------------------------------------------------------------- saved settings (data/settings.json via the server)
  // A save sends only the keys that changed and the server merges them in, so two app windows never undo each other's choices.
  var store = (function(){
    var data = {}, dirty = {}, timer = null, inflight = null, tries = 0;
    function send(closing){
      clearTimeout(timer); timer = null;
      var keys = Object.keys(dirty); if (!keys.length) return Promise.resolve();
      if (inflight && !closing) return inflight.then(function(){ return send(); });
      var out = {}; keys.forEach(function(k){ out[k] = data[k] === undefined ? null : data[k]; }); dirty = {};
      var p = inflight = post('/settings', {settings: out}, closing).then(function(){
        inflight = null; tries = 0; saveState('settings', null);
      }, function(err){
        inflight = null; keys.forEach(function(k){ dirty[k] = true; });
        saveState('settings', 'Settings not saved: ' + err.message);
        clearTimeout(timer); timer = setTimeout(send, Math.min(30000, 1000 * Math.pow(2, tries++)));
      });
      return p;
    }
    return {
      load: function(){                                          // a few tries (the server may still be starting), then go on with defaults
        var n = 0;
        return new Promise(function(done){
          (function attempt(){
            fetch('/settings').then(function(r){ return r.ok ? r.json() : Promise.reject(); }).then(function(j){ data = j.settings || {}; done(); },
              function(){ if (++n < 5) setTimeout(attempt, 1000); else done(); });
          })();
        });
      },
      get: function(k){ return data[k]; },
      set: function(k, v){ data[k] = v; dirty[k] = true; clearTimeout(timer); timer = setTimeout(send, 300); },
      flush: function(closing){ return send(closing); }
    };
  })();
  addEventListener('pagehide', function(){ store.flush(true); });

  // ---------------------------------------------------------------- bar position <-> time (drawings are anchored to time + price)
  // The x-axis is bar order, so a drawing keeps its times and is placed on whatever bars the chart shows: inside the history a
  // time maps between the open times of the bars around it. The newest bar spans its open time to tEnd (for the forming dollar
  // bar: at least up to its latest minute, so a time inside it stays on it); after that, and before the first bar, a time moves
  // one bar per typical bar duration (on 1M, per calendar month).
  var tCache = null, tSeq = -1, stepHead = 60, stepTail = 60, tEnd = 0, monthly = false;
  function medianStep(a, i0, i1){
    var d = []; for (var i = i0; i < i1; i++) d.push(a[i+1] - a[i]);
    if (!d.length) return 60;
    d.sort(function(x, y){ return x - y; }); return d[d.length >> 1] || 60;
  }
  function monthAdd(t, k){                                       // the month start k calendar months after t's month (k may have a fraction)
    var d = new Date(t * 1000), f = Math.floor(k), y = d.getUTCFullYear(), m = d.getUTCMonth() + f;
    var t0 = Date.UTC(y, m, 1) / 1000, t1 = Date.UTC(y, m + 1, 1) / 1000;
    return t0 + (k - f) * (t1 - t0);
  }
  function monthsFrom(t0, t){                                    // calendar months from month start t0 to t, with the fraction (negative before)
    var d0 = new Date(t0 * 1000), d = new Date(t * 1000);
    var k = (d.getUTCFullYear() - d0.getUTCFullYear()) * 12 + d.getUTCMonth() - d0.getUTCMonth();
    var s = monthAdd(t0, k), e = monthAdd(t0, k + 1);
    return k + (t - s) / (e - s);
  }
  function times(){
    if (tSeq !== seq) {
      tCache = bars.map(function(b){ return b.t; }); if (forming) tCache.push(forming.t);
      var n = tCache.length, fixed = mode === 'time' && TF_S[tf], last = forming || bars[n-1];
      monthly = mode === 'time' && tf === '1M';
      stepHead = fixed || medianStep(tCache, 0, Math.min(n - 1, 50));
      stepTail = fixed || medianStep(tCache, Math.max(0, n - 51), n - 1);
      tEnd = !n ? 0 : monthly ? monthAdd(tCache[n-1], 1) : Math.max(tCache[n-1] + stepTail, mode === 'dollar' && last.e || 0);
      tSeq = seq;
    }
    return tCache;
  }
  function timeToLogical(t){
    var a = times(), n = a.length;
    if (!n) return null;
    if (t < a[0]) return monthly ? monthsFrom(a[0], t) : (t - a[0]) / stepHead;
    if (t >= tEnd) return n + (monthly ? monthsFrom(tEnd, t) : (t - tEnd) / stepTail);
    if (t >= a[n-1]) return (n - 1) + (t - a[n-1]) / (tEnd - a[n-1]);
    var lo = 0, hi = n - 1;
    while (hi - lo > 1) { var mid = (lo + hi) >> 1; if (a[mid] <= t) lo = mid; else hi = mid; }
    return lo + (t - a[lo]) / (a[hi] - a[lo]);
  }
  function logicalToTime(l){
    var a = times(), n = a.length;
    if (!n) return null;
    if (l < 0) return monthly ? monthAdd(a[0], l) : a[0] + l * stepHead;
    if (l >= n) return monthly ? monthAdd(tEnd, l - n) : tEnd + (l - n) * stepTail;
    if (l >= n - 1) return a[n-1] + (l - (n - 1)) * (tEnd - a[n-1]);
    var i = Math.floor(l); return a[i] + (l - i) * (a[i+1] - a[i]);
  }

  // ---------------------------------------------------------------- chart
  var rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 14;     // the page's UI size, see html{font-size}
  var chart, series, scale, settings, draw, ind;

  function makeChart(){
    chart = LC.createChart($('chart'), {
      layout:{background:{type:'solid',color:'#0b0c0e'},textColor:'#a8adb8',fontSize:Math.round(rem * 12 / 14)},
      grid:{vertLines:{color:'#16181d'},horzLines:{color:'#16181d'}},
      crosshair:{mode:0}, rightPriceScale:{borderColor:'#23262d', mode: logScale ? 1 : 0},
      timeScale:{borderColor:'#23262d',timeVisible:true,secondsVisible:false,rightOffset:6,barSpacing:8,minBarSpacing:2,
        enableConflation:true},   // bars thinner than a pixel are drawn merged: a fully zoomed-out 57k-bar chart repaints in ~3 ms instead of ~34
      localization:{priceFormatter:fmtP}
    });
    series = chart.addSeries(LC.CandlestickSeries, {upColor:'#2ebd85',downColor:'#f23645',wickUpColor:'#2ebd85',wickDownColor:'#f23645',borderVisible:false,
      priceFormat:{type:'price',precision:2,minMove:0.01}});
    scale = chart.priceScale('right');
    new ResizeObserver(function(){                               // whole pixels that fit: rounding a 861.5 px box up to 862 made the page scroll sideways
      var r = $('chart').getBoundingClientRect(); chart.applyOptions({width: Math.floor(r.width), height: Math.floor(r.height)});
    }).observe($('chart'));
    chart.timeScale().subscribeSizeChange(fitLimit);

    // Mouse-wheel zoom out while the newest bar is on screen keeps it pinned at the right edge, so history is added on the left
    // until all of it fits. Zooming in, or out while scrolled back into history, centres on the mouse. Runs before the chart's handler.
    var pinned = false;
    $('chart').addEventListener('wheel', function(e){
      var r = chart.timeScale().getVisibleLogicalRange(), pin = e.deltaY > 0 && !!r && r.to >= bars.length + (forming ? 1 : 0) - 1;
      if (pin !== pinned) { pinned = pin; chart.applyOptions({timeScale:{rightBarStaysOnScroll:pin}}); }
    }, {capture:true, passive:true});

    // A / L buttons on the price axis, like TradingView. Dragging the axis switches auto scale off; A puts it back.
    $('bAuto').onclick = function(){ scale.applyOptions({autoScale: !scale.options().autoScale}); };
    $('bLog').onclick = function(){ logScale = !logScale; scale.applyOptions({mode: logScale ? 1 : 0}); save(); };
    setInterval(function(){ $('bAuto').className = scale.options().autoScale ? 'on' : ''; $('bLog').className = logScale ? 'on' : ''; }, 300);
    $('bLog').className = logScale ? 'on' : '';

    chart.subscribeCrosshairMove(function(p){                     // over a bar: that bar; anywhere else: the newest
      var r = p && p.time ? byTime[p.time] : null;
      hoverT = r ? r.t : null; legend();
    });
  }

  // Top left of the chart: O H L C and the change, in the bar's color, then how long a dollar bar took (the forming one:
  // how full it is). The time is on the time axis under the crosshair already.
  var hoverT = null;
  function legend(){
    var h = hoverT !== null ? byTime[hoverT] : null, r = h || forming || bars[bars.length-1], e = $('lgBar');
    ind.hover(h);
    if (!r) { e.className = ''; e.innerHTML = ''; return; }
    var chg = (r.c / r.o - 1) * 100, isForming = forming && r.t === forming.t;
    var f = function(k, v){ return '<span><em>' + k + '</em>' + fmtP(v) + '</span>'; };
    var tail = mode === 'dollar' ? (isForming ? Math.min(99, Math.floor(r.d / capOf(r) * 100)) + '% formed' : dur(r.e - r.t)) : isForming ? 'forming' : '';
    e.className = r.c >= r.o ? 'up' : 'dn';
    e.innerHTML = f('O', r.o) + f('H', r.h) + f('L', r.l) + f('C', r.c) + '<span>' + (chg > 0 ? '+' : '') + chg.toFixed(2) + '%</span>' +
      (tail ? '<span class="t">' + tail + '</span>' : '');
  }

  // How far you can zoom out: until the whole history fits on screen. Short histories keep the 2 px floor (zooming out further would only add empty space).
  var minSpacing = 2;
  function fitLimit(){
    var n = bars.length + (forming ? 1 : 0), w = chart.timeScale().width();
    var m = n && w ? Math.min(2, w / (n + chart.timeScale().options().rightOffset)) : 2;
    if (m !== minSpacing) { minSpacing = m; chart.applyOptions({timeScale:{minBarSpacing:m}}); }
  }

  function candle(r){ return {time:r.t, open:r.o, high:r.h, low:r.l, close:r.c}; }
  function put(r){ series.update(candle(r)); ind.update(r); }      // one new or changed bar, to the candles and the indicators
  function precisionFor(px){ var p = px >= 1000 ? 0 : px >= 10 ? 2 : px >= 0.1 ? 4 : px >= 0.001 ? 6 : px >= 1e-5 ? 8 : px >= 1e-7 ? 10 : 12; series.applyOptions({priceFormat:{type:'price',precision:p,minMove:Math.pow(10,-p)}}); }
  // The status dot (green live, amber busy, red trouble) with a word only when it is not simply live; the details are
  // its tooltip. While history downloads, a hairline under the top bar fills up.
  var lastStatus = {};
  function setStatus(m, note){
    lastStatus = m;
    var sync = m.sync || '', s = $('status'), bad = sync === 'error' || sync.indexOf('failed') === 0 || sync === 'server not answering';
    s.className = sync === 'live' && !m.live_err ? 'live' : bad ? 'bad' : 'busy';
    var pct = sync === 'backfilling' && m.progress ? Math.floor(m.progress.pct) : null;
    s.querySelector('span').textContent = sync === 'live' ? (m.live_err ? 'Retrying' : '') : pct !== null ? 'Syncing ' + pct + '%'
      : sync === 'backfilling' ? 'Syncing' : sync === 'loading' ? 'Loading' : sync === 'queued' ? 'Queued' : sync === 'server not answering' ? 'Offline'
      : sync.indexOf('restart') === 0 ? 'Restarting' : bad ? 'Error' : sync.charAt(0).toUpperCase() + sync.slice(1);
    var txt = note || (m.live_err && sync.indexOf('failed') !== 0 ? sync + ' (last ' + (sync === 'live' ? 'poll' : 'download attempt') + ' failed: ' + m.live_err + ', retrying)' : sync);
    s.title = txt + (m.last ? '\nlast candle ' + fmtT(m.last) : '') + (m.updated ? '\nchecked ' + new Date(m.updated*1000).toISOString().slice(11,19) + 'Z' : '') +
      (sync === 'backfilling' && m.venues ? '\n\n' + venueText(m) : sync === 'backfilling' && m.notice ? '\n' + m.notice : '');
    $('prog').className = pct !== null ? 'show' : '';
    if (pct !== null) $('progFill').style.width = m.progress.pct + '%';
  }
  function venueText(m){                                          // a combined market: each exchange's download, one per line
    return m.venues.filter(function(v){ return v.status.indexOf('absent') !== 0; }).map(function(v){
      return v.label + ': ' + (v.status === 'syncing' && v.pct != null ? Math.round(v.pct) + '%' : v.status);
    }).join('\n');
  }
  function setTicker(info){
    if (!info) return;
    $('tName').textContent = info.ticker || market;
    $('tick').title = (info.name ? info.name + ' · ' : '') + 'search a ticker (/)';
    $('star').className = 'tb icon' + (info.watch ? ' on' : ''); $('star').textContent = info.watch ? '★' : '☆';
    $('star').title = info.watch ? 'On the watchlist (kept downloaded): click to remove' : 'Add to the watchlist (kept downloaded while the app is open)';
    document.title = (info.ticker || market) + ' dollar bars';   // the server looks for "dollar bars" in the window title
  }
  // The info panel (i): where the data comes from, how much of it there is, and what a bar is.
  function info(){
    var mm = (meta && meta.market) || {}, n = bars.length, dl = '', ex = [];
    var row = function(k, v, title){ dl += '<dt>' + k + '</dt><dd' + (title ? ' title="' + esc(title) + '"' : '') + '>' + v + '</dd>'; };
    if (mm.kind === 'all') {
      var vs = meta.venues ? meta.venues.filter(function(v){ return v.n > 0; }) : [], seen = {};
      vs.forEach(function(v){ var x = v.label.split(' ')[0]; if (!seen[x]) { seen[x] = 1; ex.push(x); } });
      row('Source', ex.length + ' exchanges, ' + vs.length + ' markets', vs.map(function(v){ return v.label + (v.note ? ' (' + v.note + ')' : ''); }).join('\n') + '\n\n' + (meta.source || ''));
    } else if (mm.symbol) row('Source', 'Bybit ' + esc(mm.kind) + ' ' + esc(mm.symbol), meta.source || '');
    if (n) {
      var secs = bars.map(function(b){ return b.e - b.t; }).sort(function(a, b){ return a - b; });
      row('Bars', n.toLocaleString());
      row('Since', fmtDay(bars[0].t));
      if (mode === 'dollar') row('Typical bar', dur(secs[n >> 1]), 'median; fastest ' + dur(secs[0]) + ', slowest ' + dur(secs[n-1]));
    }
    row('Data', esc($('status').querySelector('span').textContent || 'Live') + (lastStatus.last ? ' · ' + fmtT(lastStatus.last).slice(11) : ''), $('status').title);
    var across = ex.length ? ' across ' + esc(ex.join(', ')) : '';
    var note = mode !== 'dollar' ? esc(tf) + ' candles from the same minute data' + (ex.length ? ', ' + ex.length + ' exchanges combined' : '') + '.'
      : (adaptive(size) ? 'About ' + size.slice(2) + ' bars a day: a bar closes once it holds 1/' + size.slice(2) + ' of a typical day\'s turnover' + across + ' (the past 30 days set the size). '
                        : 'A bar closes once ' + fmtD(size) + ' has traded' + across + '. ') + 'Every bar is drawn the same width, however long it took.';
    return '<h4>' + esc(mm.ticker || market.split(':')[1] || market) + (mm.name ? '<span>' + esc(mm.name) + '</span>' : '') + '</h4><dl>' + dl + '</dl><p>' + note + '</p>';
  }
  function rows(){ return forming ? bars.concat([forming]) : bars; }   // the bars on the chart, oldest first
  function render(reset){
    byTime = {}; bars.forEach(function(b){ byTime[b.t] = b; });
    var data = bars.map(candle);
    if (forming) { byTime[forming.t] = forming; data.push(candle(forming)); }
    if (data.length) precisionFor(data[data.length-1].close);
    seq++;
    ind.reset(); series.setData(data); ind.render(rows()); fitLimit();
    if (reset) { chart.timeScale().setVisibleLogicalRange({from:Math.max(0, data.length - 260), to:data.length + 4}); scale.applyOptions({autoScale:true}); }
    legend(); settings.priceLine(); draw.refresh();
  }
  function scheduleRetry(){ clearTimeout(retryTimer); retryTimer = setTimeout(function(){ load(true); }, 3000); }
  function load(reset){
    if (loading) return Promise.resolve();
    loading = true;
    var mk = market, kk = key(), moved = false;
    return fetch('/bars?m=' + encodeURIComponent(mk) + '&k=' + encodeURIComponent(kk) + '&pb=' + encodeURIComponent(PB)).then(function(r){ return r.json(); }).then(function(j){
      if (mk !== market) return;                                            // the user moved on while this was in flight
      if (kk !== key()) { moved = true; return; }                           // a menu change meanwhile: this answer holds the old set only
      if (j.error) { setStatus({sync:'error'}, j.error); $('empty').textContent = j.error; $('empty').className = 'show'; return; }
      meta = j.meta; setStatus(meta); setTicker(meta.market); checkUpdate(meta);
      if (toCombined) {
        var mm = meta.market || {};
        if (mm.kind !== 'all' && mm.found) { toCombined = false; settled = true; go('all:' + mm.ticker); return; }
        if (mm.kind !== 'all' && meta.index_status === 'loading instruments' && ++toTries < 6) { $('empty').textContent = 'loading the market list…'; $('empty').className = 'show'; scheduleRetry(); return; }
        toCombined = false;
        settled = mm.kind === 'all' || meta.index_status === 'ok';   // a list too slow to arrive: the move is tried again next launch
      }
      if (!Object.keys(j.keys).length) {
        $('empty').textContent = meta.sync.indexOf('failed') === 0 ? meta.sync : (meta.notice ? meta.notice + ' · ' : '') + (meta.sync === 'backfilling' ? 'first candles arriving…' : 'waiting for the server to load ' + (meta.market.ticker || mk) + '…') +
          (meta.live_err ? ' — last attempt failed: ' + meta.live_err + ' (retrying)' : '');
        $('empty').className = 'show';
        if (meta.sync.indexOf('failed') !== 0) scheduleRetry();
        return;
      }
      $('empty').className = '';
      if (size === null || (adaptive(size) && (meta.adaptive || []).indexOf(+size.slice(2)) < 0)) size = meta.auto_size;
      else if (!adaptive(size) && meta.sizes.indexOf(size) < 0) size = nearestSize(meta.sizes, size);    // the medians moved since: the closest size left
      $('bSize').firstChild.textContent = sizeLabel(size);
      var k = j.keys[key()]; if (!k) { scheduleRetry(); return; }
      bars = k.bars; forming = k.forming; lastFullLoad = Date.now(); save();
      render(reset);
    }).catch(function(){ setStatus({sync:'server not answering'}); scheduleRetry(); }).then(function(){ loading = false; if (mk !== market || moved) load(true); });   // the user moved on meanwhile: load what they want now
  }
  function poll(){
    if (restarting) return;
    var kk = key(), mk = market;
    fetch('/live?m=' + encodeURIComponent(mk) + '&pb=' + encodeURIComponent(PB)).then(function(r){ return r.json(); }).then(function(j){
      if (restarting || mk !== market || j.error) return;
      setStatus(j.meta); setTicker(j.meta.market); checkUpdate(j.meta);
      if (kk !== key() || loading) return;                                   // a menu change is in flight: its load() will redraw
      var k = j.keys[kk];
      if (!k) { if (Object.keys(j.keys).length) load(true); return; }         // this size no longer exists (rebuilt after catch-up): reload
      if (j.meta.sync === 'backfilling') { if (Date.now() - lastFullLoad > 15000) load(false); return; }   // history is growing: refresh the whole set now and then
      if (k.n > bars.length + 1) return load(false);                          // missed more than one bar (laptop slept?): reload
      var before = bars.length + (forming ? 1 : 0), formingT = forming && forming.t;
      if (k.n === bars.length + 1) {
        if (bars.length && k.tail.length > 1 && !sameBar(k.tail[0], bars[bars.length-1])) return load(false);   // the previous bar was re-cut while we were not looking
        var b = k.tail[k.tail.length-1]; bars.push(b); byTime[b.t] = b; put(b);
      }
      else if (k.n === bars.length && k.n && !sameBar(k.tail[k.tail.length-1], bars[k.n-1])) {   // last bar re-cut with its fuller final minute
        var r = k.tail[k.tail.length-1]; bars[k.n-1] = r; byTime[r.t] = r; put(r);
      }
      forming = k.forming;
      if (forming) { byTime[forming.t] = forming; put(forming); }
      if (bars.length + (forming ? 1 : 0) !== before || (forming && forming.t) !== formingT) { seq++; draw.refresh(); }
      fitLimit(); legend(); settings.priceLine();
    }).catch(function(){ if (!restarting) setStatus({sync:'server not answering'}); });
  }

  // ---------------------------------------------------------------- ticker picker: type, see spot/perp markets grouped by ticker; Enter = deepest
  function openPicker(){ $('picker').className = 'overlay show'; $('q').value = ''; lastRows = []; $('res').innerHTML = ''; $('q').focus(); runSearch(''); }
  function closePicker(){ $('picker').className = 'overlay'; }
  function pickerOpen(){ return $('picker').classList.contains('show'); }
  function runSearch(v){
    fetch('/search?q=' + encodeURIComponent(v)).then(function(r){ return r.json(); }).then(function(j){
      if ($('q').value.trim() !== v.trim()) return;
      lastRows = j.rows || [];
      if (j.status !== 'ok') { $('res').innerHTML = '<div class="hint">' + esc(j.status) + '</div>'; return; }
      if (!lastRows.length) { $('res').innerHTML = '<div class="hint">' + (v ? 'nothing on Bybit matches "' + esc(v) + '" — try the coin name or symbol' : 'your watchlist is empty: open a ticker and press ☆') + '</div>'; return; }
      var groups = [], byT = {};
      lastRows.forEach(function(r){ if (!byT[r.ticker]) { byT[r.ticker] = {ticker:r.ticker, name:r.name, stock:r.stock, rows:[]}; groups.push(byT[r.ticker]); } byT[r.ticker].rows.push(r); });
      var html = groups.slice(0, 40).map(function(g){
        var all = 'all:' + g.ticker;
        return '<div class="grp"><div class="gh"><b>' + esc(g.ticker) + '</b><span>' + esc(g.name || '') + (g.stock ? ' · stock' : '') + '</span></div><div class="gm">' +
          '<button data-key="' + esc(all) + '" class="' + (all === market ? 'cur' : 'best') + '" title="Every exchange that lists it, dollars summed (the first open downloads them)">All exchanges</button>' +
          g.rows.map(function(r){
            var tag = (r.first ? fmtMon(r.first) : r.first === 0 ? 'no candles' : '') + (r.status === 'backfilling' ? ' · downloading' : '');
            return '<button data-key="' + esc(r.key) + '" class="' + (r.key === market ? 'cur' : '') + '" title="Bybit only' + (r.first ? ', since ' + fmtMon(r.first) : '') + (r.have ? ', on disk' : '') + '">Bybit ' + r.kind + ' ' + esc(r.symbol) +
              (tag ? ' <span class="tag">' + tag + '</span>' : '') + '</button>';
          }).join('') + '</div></div>';
      }).join('');
      $('res').innerHTML = html;
      Array.prototype.forEach.call($('res').querySelectorAll('button[data-key]'), function(b){ b.onclick = function(){ go(this.getAttribute('data-key')); }; });
    }).catch(function(){ $('res').innerHTML = '<div class="hint">server not answering</div>'; });
  }
  function go(k){
    closePicker();
    if (k === market) return;
    market = k; size = sizes[market] || null; bars = []; forming = null; meta = null; seq++;
    history.replaceState(null, '', '#' + market);
    hoverT = null; ind.clear(); series.setData([]); $('lgBar').innerHTML = '';
    $('tName').textContent = k.split(':')[1] || k;
    draw.setMarket(market);
    save(); load(true);
  }

  // ---------------------------------------------------------------- update banner: page-only changes reload, code changes restart the server in place
  function checkUpdate(m){
    if (restarting) return;
    if (!m || !m.update) { if (update) { update = null; $('banner').className = ''; draw.refresh(); } return; }
    update = m.update;
    $('bannerText').textContent = 'Update available';
    $('banner').title = update.stale ? 'This window shows an older version of the chart: a reload brings the new one (instant)'
      : update.files.join(', ') + ' changed: ' + (update.kind === 'reload' ? 'a page reload (instant)' : 'a server restart (about 10 s)');
    if ($('banner').className !== 'show') { $('banner').className = 'show'; draw.refresh(); }   // the drawing toolbar moves out of its way
  }
  function runUpdate(){
    if (!update) return;
    $('bannerBtn').disabled = true;
    var saved = Promise.all([store.flush(), draw.flush()]).catch(function(){});
    var waited = new Promise(function(done){ setTimeout(done, 4000); });
    Promise.race([saved, waited]).then(function(){ restartNow(); });   // unsaved work goes first (but a dead server does not block the update)
  }
  function restartNow(){
    if (update.kind === 'reload') { location.reload(); return; }
    restarting = true; $('bannerText').textContent = 'Restarting…'; $('bannerBtn').style.display = 'none'; setStatus({sync:'restarting…'});
    var oldPid = null, gone = false, t0 = Date.now(), iv = null;
    var say = function(text){ $('bannerText').textContent = text; };
    fetch('/restart').then(function(r){ return r.json(); }).then(function(j){
      if (j.ok) { oldPid = j.pid; return; }
      clearInterval(iv); restarting = false; $('bannerBtn').style.display = ''; $('bannerBtn').disabled = false;
      say('Not yet: ' + (j.reason || 'try again in a minute'));                                        // files still changing on disk
    }).catch(function(){ gone = true; });   // nobody answered: the server had stopped (it does when this window goes 2 minutes without asking)
    iv = setInterval(function(){
      var waited = Date.now() - t0;
      fetch('/ping', {cache:'no-store'}).then(function(r){ return r.json(); }).then(function(j){
        if (j.ok && (oldPid !== null ? j.pid !== oldPid : gone)) { clearInterval(iv); location.reload(); }   // a new copy answers: reload onto it
        else if (waited > 90000) say('The server did not come back: close this window and open the app again.');
      }).catch(function(){                                                                               // still nobody: say so (and keep asking)
        if (gone && waited > 4000) say('The chart server is not running: close this window and open the app again.');
        else if (waited > 90000) say('The server did not come back: close this window and open the app again.');
      });
    }, 1000);
  }

  // Bar size: the fixed sizes (those that are the median hour, day, week… say so), then the adaptive ones
  function sizeMenu(anchor){
    if (!meta || !meta.sizes) return;
    var pick = function(s){ return function(){ size = s; $('bSize').firstChild.textContent = sizeLabel(s); save(); load(true); }; };
    var items = [{head: 'Bar size'}].concat(meta.sizes.map(function(s){
      var n = sizeNote(s);
      return {html: '<span class="ck">✓</span>' + fmtD(s) + (n ? '<span class="tag">' + n + '</span>' : ''), on: s === size, onClick: pick(s)};
    }));
    if (meta.adaptive && meta.adaptive.length) items = items.concat([{head: 'Adaptive: follows volume'}], meta.adaptive.map(function(k){
      var v = 'a:' + k;
      return {html: '<span class="ck">✓</span>' + sizeLabel(v), on: v === size, onClick: pick(v)};
    }));
    UI.menu(anchor, items);
  }

  function switchTo(m){
    mode = m; $('bDollar').className = m === 'dollar' ? 'on' : ''; $('bTime').className = m === 'time' ? 'on' : '';
    $('bSize').style.display = m === 'dollar' ? '' : 'none'; $('bTf').style.display = m === 'time' ? '' : 'none';
    save(); load(true);
  }

  function wire(){
    $('tick').onclick = openPicker;
    $('picker').onclick = function(e){ if (e.target === this) closePicker(); };
    document.addEventListener('keydown', function(e){
      if (e.key === 'Escape' && pickerOpen()) { closePicker(); e.stopImmediatePropagation(); }
      else if (e.key === '/' && !pickerOpen() && !UI.busy(e)) { e.preventDefault(); openPicker(); }
    }, true);
    $('q').oninput = function(){ clearTimeout(qTimer); lastRows = []; var v = this.value; qTimer = setTimeout(function(){ runSearch(v); }, 150); };
    $('q').onkeydown = function(e){
      if (e.key !== 'Enter') return;
      e.preventDefault();
      var v = this.value.trim();
      if (!v && lastRows.length) { go('all:' + lastRows[0].ticker); return; }
      if (!v) return;
      $('res').innerHTML = '<div class="hint">looking it up…</div>';
      fetch('/pick?t=' + encodeURIComponent(v)).then(function(r){ return r.json(); }).then(function(j){
        if (j.key) go(j.key); else $('res').innerHTML = '<div class="hint">' + (j.status && j.status !== 'ok' ? esc(j.status) : 'no exchange lists "' + esc(v) + '"') + '</div>';
      }).catch(function(){ $('res').innerHTML = '<div class="hint">server not answering</div>'; });
    };
    $('star').onclick = function(){
      if (!meta || !meta.market) return;
      var t = meta.market.ticker, on = $('star').classList.contains('on');
      fetch('/watchlist?' + (on ? 'remove' : 'add') + '=' + encodeURIComponent(t)).then(function(r){ return r.json(); }).then(function(j){
        meta.market.watch = j.watchlist.indexOf(t) >= 0; setTicker(meta.market);
      });
    };
    addEventListener('hashchange', function(){ var k = location.hash.slice(1); if (k && k !== market) go(k); });
    $('bannerBtn').onclick = runUpdate;
    $('bDollar').onclick = function(){ switchTo('dollar'); };
    $('bTime').onclick = function(){ switchTo('time'); };
    $('bSize').onclick = function(){ sizeMenu(this); };
    $('bTf').onclick = function(){
      UI.menu(this, [{head: 'Timeframe'}].concat(TF.map(function(t){
        return {html: '<span class="ck">✓</span>' + t, on: t === tf, onClick: function(){ tf = t; $('bTf').firstChild.textContent = t; save(); load(true); }};
      })));
    };
    $('bTf').firstChild.textContent = tf;
    if (mode === 'time') { $('bDollar').className = ''; $('bTime').className = 'on'; $('bSize').style.display = 'none'; $('bTf').style.display = ''; }
    $('bSettings').onclick = function(){ settings.open(); };
    $('bInd').onclick = function(){ ind.menu(this); };
    $('bInfo').onclick = function(){ UI.popover(this, info()); };
  }

  // what settings.js, draw.js and indicators.js see of the page
  app.store = store;
  app.post = post;
  app.saveState = saveState;
  app.lastBar = function(){ return forming || bars[bars.length-1] || null; };
  app.timeToLogical = timeToLogical;
  app.logicalToTime = logicalToTime;
  app.barCount = function(){ return bars.length + (forming ? 1 : 0); };
  app.rows = rows;
  app.market = function(){ return market; };
  app.marketInfo = function(){ return meta && meta.market; };
  app.fmtP = fmtP; app.fmtT = fmtT; app.fmtHrs = fmtHrs;
  app.mode = function(){ return mode; };

  store.load().then(function(){
    app.win = DBCWindow(store);                                   // the app window back to its last size and place
    makeChart();
    app.chart = chart; app.series = series;
    settings = app.settings = DBCSettings(app);
    draw = app.draw = DBCDraw(app);
    ind = app.ind = DBCIndicators(app);
    wire();
    history.replaceState(null, '', '#' + market);
    draw.setMarket(market);
    load(true).then(function(){ setInterval(poll, 5000); });
  });
})();
