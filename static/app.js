/* The chart page: loads a market's bar sets from the local server, keeps the forming bar live, the ticker picker,
   watchlist, stats line, hover legend, update banner, and wires the settings dialog (settings.js) and the drawing
   tools (draw.js) to the chart. */
(function(){
  'use strict';
  var app = window.DBCApp = {};                                  // index.html checks this exists (all scripts arrived)
  var LC = window.LightweightCharts, TF = ['1h','4h','1D','1W','1M'];
  var TF_S = {'1h':3600, '4h':14400, '1D':86400, '1W':604800};
  var $ = UI.$, esc = UI.esc;

  var P = {}; try { P = JSON.parse(localStorage.getItem('dollarbars') || '{}'); } catch (e) {}
  var market = (location.hash || '').slice(1) || P.market || 'linear:BTCUSDT';
  var mode = P.mode || 'dollar', sizes = P.sizes || {}, size = sizes[market] || null, tf = P.tf || '1D', logScale = !!P.log;
  var meta = null, bars = [], forming = null, byTime = {}, loading = false, retryTimer = null, restarting = false, update = null;
  var lastFullLoad = 0, qTimer = null, lastRows = [], seq = 0;
  var save = function(){ sizes[market] = size; try { localStorage.setItem('dollarbars', JSON.stringify({market:market, mode:mode, sizes:sizes, tf:tf, log:logScale})); } catch (e) {} };
  var fmtD = function(x){ return x >= 1e9 ? '$' + (x >= 1e10 ? (x/1e9).toFixed(0) : (x/1e9).toFixed(1)) + 'B' : x >= 1e6 ? '$' + (x >= 1e7 ? (x/1e6).toFixed(0) : (x/1e6).toFixed(1)) + 'M' : x >= 1e4 ? '$' + Math.round(x/1e3) + 'K' : x >= 1e3 ? '$' + (x/1e3).toFixed(1) + 'K' : '$' + Math.round(x); };
  var fmtP = function(p){ if (p < 0) return '-' + fmtP(-p); if (p >= 1000) return p.toLocaleString('en-US',{maximumFractionDigits:0}); if (p >= 1) return p.toFixed(p >= 100 ? 1 : 2); if (!(p > 0)) return String(p); return p.toFixed(Math.min(20, 3 - Math.floor(Math.log10(p)))); };
  var fmtT = function(t){ return new Date(t*1000).toISOString().slice(0,16).replace('T',' ') + 'Z'; };
  var fmtDay = function(t){ return new Date(t*1000).toISOString().slice(0,10); };
  var fmtMon = function(ms){ return new Date(ms).toISOString().slice(0,7); };
  var fmtHrs = function(h){ return h >= 48 ? (h/24).toFixed(1) + ' days' : h >= 1 ? h.toFixed(1) + ' h' : Math.round(h*60) + ' min'; };
  var key = function(){ return mode === 'dollar' ? 'd:' + size : 't:' + tf; };
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
  var chart, series, scale, settings, draw;

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
    new ResizeObserver(function(){ chart.applyOptions({width:$('chart').clientWidth, height:$('chart').clientHeight}); }).observe($('chart'));
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

    chart.subscribeCrosshairMove(function(p){
      if (!p || !p.time) return;
      var r = byTime[p.time]; if (!r) return;
      var chg = +(((r.c / r.o - 1) * 100).toFixed(2)), isForming = forming && r.t === forming.t;
      var head = mode === 'dollar'
        ? '<b>' + fmtT(r.t) + ' → ' + fmtT(r.e) + '</b> · ' + (isForming ? 'forming, ' : 'took ') + '<b>' + fmtHrs((r.e - r.t)/3600) + '</b> (' + r.n + ' min) · ' + fmtD(r.d) + (isForming ? ' of ' + fmtD(size) : '') + ' traded'
        : '<b>' + (tf === '1h' || tf === '4h' ? fmtT(r.t) : fmtDay(r.t)) + '</b> (' + tf + (isForming ? ', forming' : '') + ') · ' + fmtD(r.d) + ' traded';
      $('legend').innerHTML = head + '<br>O ' + fmtP(r.o) + ' · H ' + fmtP(r.h) + ' · L ' + fmtP(r.l) +
        ' · C ' + fmtP(r.c) + ' · <span style="color:' + (chg >= 0 ? '#2ebd85' : '#f23645') + '">' + (chg > 0 ? '+' : '') + chg.toFixed(2) + '%</span>';
    });
  }

  // How far you can zoom out: until the whole history fits on screen. Short histories keep the 2 px floor (zooming out further would only add empty space).
  var minSpacing = 2;
  function fitLimit(){
    var n = bars.length + (forming ? 1 : 0), w = chart.timeScale().width();
    var m = n && w ? Math.min(2, w / (n + chart.timeScale().options().rightOffset)) : 2;
    if (m !== minSpacing) { minSpacing = m; chart.applyOptions({timeScale:{minBarSpacing:m}}); }
  }

  function candle(r){ return {time:r.t, open:r.o, high:r.h, low:r.l, close:r.c}; }
  function precisionFor(px){ var p = px >= 1000 ? 0 : px >= 10 ? 2 : px >= 0.1 ? 4 : px >= 0.001 ? 6 : px >= 1e-5 ? 8 : px >= 1e-7 ? 10 : 12; series.applyOptions({priceFormat:{type:'price',precision:p,minMove:Math.pow(10,-p)}}); }
  function setStatus(m, note){
    var s = $('status'); s.className = m.sync === 'live' ? 'live' : (m.sync === 'backfilling' || m.sync === 'loading' || m.sync === 'queued') ? 'busy' : '';
    var txt = note || (m.live_err && (m.sync || '').indexOf('failed') !== 0 ? m.sync + (m.sync === 'live' ? ' (last poll failed: ' : ' (last download attempt failed: ') + m.live_err + ', retrying)' : m.sync);
    s.querySelector('span').textContent = txt + (m.last ? ' · last candle ' + fmtT(m.last).slice(11) : '') +
      (m.updated ? ' · checked ' + new Date(m.updated*1000).toISOString().slice(11,19) + 'Z' : '');
    s.title = s.textContent;
    var pr = $('prog');
    if (m.sync === 'backfilling' && m.progress) {
      pr.className = 'show'; $('progFill').style.width = m.progress.pct + '%'; $('progPct').textContent = m.progress.pct.toFixed(0) + '%';
      $('progText').textContent = (m.notice || 'downloading minute candles') + ' · at ' + fmtDay(m.progress.at) + ' · the chart grows as they arrive';
    } else if (m.sync === 'queued' || m.sync === 'loading') {
      pr.className = 'show'; $('progFill').style.width = '0%'; $('progPct').textContent = ''; $('progText').textContent = m.sync === 'loading' ? 'loading candles from disk…' : 'waiting for the downloader…';
    } else pr.className = '';
  }
  function setTicker(info){
    if (!info) return;
    $('tName').textContent = info.ticker || market;
    $('tSub').textContent = (info.kind === 'perp' ? 'perp' : 'spot') + ' · Bybit ' + (info.symbol || '') + (info.name ? ' · ' + info.name : '');
    $('star').className = 'tb icon' + (info.watch ? ' on' : ''); $('star').textContent = info.watch ? '★' : '☆';
    document.title = (info.ticker || market) + ' dollar bars';
  }
  function stats(){
    var n = bars.length; if (!n) { $('stats').textContent = ''; return; }
    var hrs = bars.map(function(b){ return (b.e - b.t)/3600; }).sort(function(a,b){ return a-b; });
    var med = hrs[Math.floor(n/2)], last365 = bars.filter(function(b){ return b.e >= bars[n-1].e - 365*86400; }).length;
    var months = {}, m0 = fmtDay(bars[0].t).slice(0,7), m1 = fmtDay(bars[n-1].t).slice(0,7);
    for (var d = new Date(m0 + '-01T00:00:00Z'); d.toISOString().slice(0,7) <= m1; d.setUTCMonth(d.getUTCMonth()+1)) months[d.toISOString().slice(0,7)] = 0;
    bars.forEach(function(b){ months[fmtDay(b.t).slice(0,7)]++; });
    var full = Object.keys(months).filter(function(k){ return k !== m0 && k !== m1; });   // drop the two partial months
    var busy = full.slice().sort(function(a,b){ return months[b]-months[a]; })[0], quiet = full.slice().sort(function(a,b){ return months[a]-months[b]; })[0];
    var what = mode === 'dollar' ? 'bars of ' + fmtD(size) : tf + ' bars';
    $('stats').innerHTML = '<b>' + n.toLocaleString() + '</b> ' + what + ' since ' + fmtDay(bars[0].t) +
      (mode === 'dollar' ? ' · median bar <b>' + fmtHrs(med) + '</b> (fastest ' + fmtHrs(hrs[0]) + ', slowest ' + fmtHrs(hrs[n-1]) + ')' : '') +
      (busy ? ' · busiest month <b>' + busy + '</b> ' + months[busy] + ' bars, quietest <b>' + quiet + '</b> ' + months[quiet] : '') +
      ' · last 365 days <b>' + last365 + '</b>' + (forming ? ' · forming: ' + (mode === 'dollar' ? fmtD(forming.d) + ' of ' + fmtD(size) + ' (' + Math.round(forming.d/size*100) + '%)' : 'open since ' + fmtT(forming.t)) : '');
  }
  function render(reset){
    byTime = {}; bars.forEach(function(b){ byTime[b.t] = b; });
    var data = bars.map(candle);
    if (forming) { byTime[forming.t] = forming; data.push(candle(forming)); }
    if (data.length) precisionFor(data[data.length-1].close);
    seq++;
    series.setData(data); fitLimit();
    if (reset) { chart.timeScale().setVisibleLogicalRange({from:Math.max(0, data.length - 260), to:data.length + 4}); scale.applyOptions({autoScale:true}); }
    stats(); settings.priceLine(); draw.refresh();
  }
  function scheduleRetry(){ clearTimeout(retryTimer); retryTimer = setTimeout(function(){ load(true); }, 3000); }
  function load(reset){
    if (loading) return Promise.resolve();
    loading = true;
    var mk = market;
    return fetch('/bars?m=' + encodeURIComponent(mk)).then(function(r){ return r.json(); }).then(function(j){
      if (mk !== market) return;                                            // the user moved on while this was in flight
      if (j.error) { setStatus({sync:'error'}, j.error); $('empty').textContent = j.error; $('empty').className = 'show'; return; }
      meta = j.meta; setStatus(meta); setTicker(meta.market); checkUpdate(meta);
      if (!Object.keys(j.keys).length) {
        $('empty').textContent = meta.sync.indexOf('failed') === 0 ? meta.sync : (meta.notice ? meta.notice + ' · ' : '') + (meta.sync === 'backfilling' ? 'first candles arriving…' : 'waiting for the server to load ' + (meta.market.ticker || mk) + '…') +
          (meta.live_err ? ' — last attempt failed: ' + meta.live_err + ' (retrying)' : '');
        $('empty').className = 'show'; $('stats').textContent = '';
        if (meta.sync.indexOf('failed') !== 0) scheduleRetry();
        return;
      }
      $('empty').className = '';
      if (size === null || meta.sizes.indexOf(size) < 0) size = meta.auto_size;      // sizes are per market (the median day changes)
      var sel = $('size'); sel.innerHTML = meta.sizes.map(function(s){ return '<option value="' + s + '"' + (s === size ? ' selected' : '') + '>' + fmtD(s) + (s === meta.auto_size ? ' (median day)' : '') + '</option>'; }).join('');
      var tsel = $('tf'); if (!tsel.options.length) tsel.innerHTML = TF.map(function(t){ return '<option value="' + t + '"' + (t === tf ? ' selected' : '') + '>' + t + '</option>'; }).join('');
      var k = j.keys[key()]; if (!k) { scheduleRetry(); return; }
      bars = k.bars; forming = k.forming; lastFullLoad = Date.now(); save();
      $('foot').textContent = meta.source + ', ' + fmtDay(meta.first) + ' → now. A dollar bar closes with the minute that brings its turnover to the chosen size, so each holds the size plus that minute\'s overflow. ' +
        'The x-axis is bar order, not the clock: every bar is the same width however long it took. Bar times are open times. Drawings are kept per market and placed by time, so they show on every bar size.';
      render(reset);
    }).catch(function(){ setStatus({sync:'server not answering'}); scheduleRetry(); }).then(function(){ loading = false; if (mk !== market) load(true); });   // the user moved on meanwhile: load what they want now
  }
  function poll(){
    if (restarting) return;
    var kk = key(), mk = market;
    fetch('/live?m=' + encodeURIComponent(mk)).then(function(r){ return r.json(); }).then(function(j){
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
        var b = k.tail[k.tail.length-1]; bars.push(b); byTime[b.t] = b; series.update(candle(b));
      }
      else if (k.n === bars.length && k.n && !sameBar(k.tail[k.tail.length-1], bars[k.n-1])) {   // last bar re-cut with its fuller final minute
        var r = k.tail[k.tail.length-1]; bars[k.n-1] = r; byTime[r.t] = r; series.update(candle(r));
      }
      forming = k.forming;
      if (forming) { byTime[forming.t] = forming; series.update(candle(forming)); }
      if (bars.length + (forming ? 1 : 0) !== before || (forming && forming.t) !== formingT) { seq++; draw.refresh(); }
      fitLimit(); stats(); settings.priceLine();
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
        var known = g.rows.filter(function(r){ return r.first; }), best = null;
        if (known.length) best = known.reduce(function(a, b){ return (b.first < a.first || (b.first === a.first && b.kind === 'perp' && a.kind !== 'perp')) ? b : a; });
        return '<div class="grp"><div class="gh"><b>' + esc(g.ticker) + '</b><span>' + esc(g.name || '') + (g.stock ? ' · tokenized stock / stock perp' : '') + '</span>' +
          (known.length ? '<em>since ' + fmtMon(best.first) + '</em>' : '<em>history: press Enter to check</em>') + '</div><div class="gm">' +
          g.rows.map(function(r){
            var cls = (r.key === market ? 'cur' : (best && r.key === best.key ? 'best' : ''));
            return '<button data-key="' + esc(r.key) + '" class="' + cls + '">' + r.kind + ' ' + esc(r.symbol) +
              ' <span class="tag">' + (r.first ? 'since ' + fmtMon(r.first) : r.first === 0 ? 'no candles' : 'depth ?') + (best && r.key === best.key ? ' ★ most history' : '') + (r.have ? ' · on disk' : '') + (r.status === 'backfilling' ? ' · downloading' : '') + '</span></button>';
          }).join('') + '</div></div>';
      }).join('');
      if (!v && j.pending) html += '<div class="hint">' + j.pending + ' markets still to be depth-checked in the background</div>';
      $('res').innerHTML = html;
      Array.prototype.forEach.call($('res').querySelectorAll('button[data-key]'), function(b){ b.onclick = function(){ go(this.getAttribute('data-key')); }; });
    }).catch(function(){ $('res').innerHTML = '<div class="hint">server not answering</div>'; });
  }
  function go(k){
    closePicker();
    if (k === market) return;
    market = k; size = sizes[market] || null; bars = []; forming = null; meta = null; seq++;
    history.replaceState(null, '', '#' + market);
    series.setData([]); $('stats').textContent = ''; $('legend').textContent = 'hover a bar';
    $('tName').textContent = k.split(':')[1]; $('tSub').textContent = 'loading…';
    draw.setMarket(market);
    save(); load(true);
  }

  // ---------------------------------------------------------------- update banner: page-only changes reload, code changes restart the server in place
  function checkUpdate(m){
    if (restarting) return;
    if (!m || !m.update) { if (update) { update = null; $('banner').className = ''; draw.refresh(); } return; }
    update = m.update;
    $('bannerText').textContent = update.kind === 'reload'
      ? 'Update available: ' + update.files.join(', ') + ' changed (page reload, instant)'
      : 'Update available: ' + update.files.join(', ') + ' changed (server restart, about 10 s)';
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
    restarting = true; $('bannerText').textContent = 'Restarting the server…'; $('bannerBtn').disabled = true; setStatus({sync:'restarting…'});
    var oldPid = null, t0 = Date.now(), iv = null;
    fetch('/restart').then(function(r){ return r.json(); }).then(function(j){
      if (j.ok) { oldPid = j.pid; return; }
      clearInterval(iv); restarting = false; $('bannerBtn').disabled = false; $('bannerText').textContent = 'Not yet: ' + (j.reason || 'try again in a minute');   // files still changing on disk
    }).catch(function(){});
    iv = setInterval(function(){
      fetch('/ping', {cache:'no-store'}).then(function(r){ return r.json(); }).then(function(j){
        if (j.ok && oldPid !== null && j.pid !== oldPid) { clearInterval(iv); location.reload(); }   // the new copy answers: reload onto it
        else if (Date.now() - t0 > 90000) { clearInterval(iv); $('bannerText').textContent = 'The server did not come back. Close this window and run launch.cmd again.'; }
      }).catch(function(){});
    }, 1000);
  }

  function switchTo(m){
    mode = m; $('bDollar').className = m === 'dollar' ? 'on' : ''; $('bTime').className = m === 'time' ? 'on' : '';
    $('lSize').style.display = m === 'dollar' ? '' : 'none'; $('lTf').style.display = m === 'time' ? '' : 'none';
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
      if (!v && lastRows.length) { go(lastRows[0].key); return; }
      if (!v) return;
      $('res').innerHTML = '<div class="hint">checking which market has the most history…</div>';
      fetch('/pick?t=' + encodeURIComponent(v)).then(function(r){ return r.json(); }).then(function(j){
        if (j.key) go(j.key); else $('res').innerHTML = '<div class="hint">' + (j.status && j.status !== 'ok' ? esc(j.status) : 'nothing on Bybit called "' + esc(v) + '"') + '</div>';
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
    $('size').onchange = function(){ size = +this.value; this.blur(); save(); load(true); };   // blur: the keys go back to the chart
    $('tf').onchange = function(){ tf = this.value; this.blur(); save(); load(true); };
    if (mode === 'time') { $('bDollar').className = ''; $('bTime').className = 'on'; $('lSize').style.display = 'none'; $('lTf').style.display = ''; }
    $('bSettings').onclick = function(){ settings.open(); };
  }

  // what settings.js and draw.js see of the page
  app.store = store;
  app.post = post;
  app.saveState = saveState;
  app.lastBar = function(){ return forming || bars[bars.length-1] || null; };
  app.timeToLogical = timeToLogical;
  app.logicalToTime = logicalToTime;
  app.barCount = function(){ return bars.length + (forming ? 1 : 0); };
  app.market = function(){ return market; };
  app.fmtP = fmtP; app.fmtT = fmtT; app.fmtHrs = fmtHrs;
  app.mode = function(){ return mode; };

  store.load().then(function(){
    makeChart();
    app.chart = chart; app.series = series;
    settings = app.settings = DBCSettings(app);
    draw = app.draw = DBCDraw(app);
    wire();
    history.replaceState(null, '', '#' + market);
    draw.setMarket(market);
    load(true).then(function(){ setInterval(poll, 5000); });
  });
})();
