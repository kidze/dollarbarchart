/* Indicators loaded from a file: Pine Script, TradingView's language, run on this chart's own bars (dollar bars or time
   bars). The forming bar is worked out again on every change, from the state the last closed bar left, as TradingView
   does on a live bar.

   Indicators → Load indicator… (or a file dropped on the chart) takes a .pine or .txt file. It is checked first: what
   in it cannot run here is said, with its line. Then the server keeps a copy in data/indicators/ (never in the
   repository), so it is there the next time the app opens. A file whose script has the same title as one already
   loaded replaces that one, after asking, and keeps its settings. Each loaded indicator is switched on and off in the
   same menu (hover it there for × to remove it from the app). The ones switched on have a row in the legend: their
   values at the bar under the mouse and, on hover, an eye (hide it but keep it running), a gear (its settings: the
   script's inputs, and which of its outputs show, in what color) and × (off the chart; it stays in the menu). Their
   choices are saved with the other settings, one key per indicator ("script:<id>"), so two app windows never undo
   each other's.

   Each indicator switched on runs in a worker of its own (static/pine.js): a long script never freezes the chart or
   holds up the others, and one that is still busy after SLOW is stopped and says so. The chart's bars go to the
   workers as columns, then each new or changed bar; the workers answer with what the scripts drew. One primitive on
   the candle series paints it all, under the drawings: background colors below the candles; fills, horizontal lines,
   plots in their styles, lines, shapes, characters and labels above them. None of it counts for auto scale, which
   follows the candles alone. Exposes window.DBCScripts(app). */
(function(){
  'use strict';
  var $ = UI.$, esc = UI.esc;
  var ENGINE = (function(){                                      // the engine sits next to this file
    try { return new URL('pine.js', document.currentScript.src).href; } catch (e) { return 'static/pine.js'; }
  })();
  var MAX_SOURCE = 1000000;                                      // characters: what the server keeps at most
  var SLOW = 90000;                                              // ms a worker may stay busy before it is stopped
  var FONT = '-apple-system,"Segoe UI",Inter,Roboto,sans-serif', MONO = 'Consolas,"Cascadia Mono","Courier New",monospace';
  // Sizes as multiples of the chart's font size (which follows the page's UI size): a shape's height (and a
  // character's), and the text of labels and of the words next to shapes.
  var SHAPE_PX = {tiny: 0.55, small: 0.8, normal: 1.05, large: 1.45, huge: 2.1};
  var TEXT_PX = {tiny: 0.62, small: 0.78, normal: 0.92, large: 1.25, huge: 1.75, auto: 0.78};
  var GAP = 0.25;                                                // room between a bar and a shape or label above or below it
  var DASH = {solid: [], dotted: [1, 2], dashed: [4, 4]};        // × the line's width
  var SOURCES = ['open', 'high', 'low', 'close', 'hl2', 'hlc3', 'ohlc4', 'hlcc4', 'volume'];
  var TFS = [['', 'Chart'], ['1', '1 minute'], ['5', '5 minutes'], ['15', '15 minutes'], ['30', '30 minutes'], ['60', '1 hour'],
             ['240', '4 hours'], ['D', '1 day'], ['W', '1 week'], ['M', '1 month']];
  // the chart's time frames as a script sees them: timeframe.period, .multiplier, .isintraday, the unit
  var PERIOD = {'1h': ['60', 60, true, 'm'], '4h': ['240', 240, true, 'm'], '1D': ['D', 1, false, 'D'], '1W': ['W', 1, false, 'W'], '1M': ['M', 1, false, 'M']};
  var TF_S = {'1h': 3600, '4h': 14400, '1D': 86400, '1W': 604800};
  var COLS = ['t', 'e', 'o', 'h', 'l', 'c', 'v'];
  var ICON = {
    eye: '<svg viewBox="0 0 18 18"><g fill="none" stroke="currentColor" stroke-width="1.3"><path d="M1.8 9s2.6-4.8 7.2-4.8S16.2 9 16.2 9s-2.6 4.8-7.2 4.8S1.8 9 1.8 9z"/><circle cx="9" cy="9" r="2.1"/></g></svg>',
    shut: '<svg viewBox="0 0 18 18"><g fill="none" stroke="currentColor" stroke-width="1.3"><path d="M1.8 9s2.6-4.8 7.2-4.8S16.2 9 16.2 9s-2.6 4.8-7.2 4.8S1.8 9 1.8 9z"/><circle cx="9" cy="9" r="2.1"/><path d="M3 15 15 3"/></g></svg>',
    gear: '<svg viewBox="0 0 28 28"><g fill="none" stroke="currentColor" stroke-width="1.7"><circle cx="14" cy="14" r="3.2"/><path d="M14 4.5l1.6 2.6 3-.6.9 2.9 2.8 1.2-.8 2.9 2 2.3-2.2 2 .6 3-2.9.8-1.3 2.8-2.9-.9L14 23.5l-1.8-2.5-2.9.9-1.3-2.8-2.9-.8.6-3-2.2-2 2-2.3-.8-2.9 2.8-1.2.9-2.9 3 .6z"/></g></svg>',
    x: '<svg viewBox="0 0 18 18"><path d="M5 5l8 8M13 5l-8 8" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>'
  };

  // ---------------------------------------------------------------- colors: a script's are numbers 0xRRGGBBAA, na is NaN
  var cssMemo = Object.create(null), cssCount = 0;
  function css(c){
    if (typeof c !== 'number' || c !== c) return null;
    var s = cssMemo[c];
    if (s === undefined) {
      if (++cssCount > 20000) { cssMemo = Object.create(null); cssCount = 0; }   // (gradients make many)
      s = cssMemo[c] = 'rgba(' + (Math.floor(c / 16777216) & 255) + ',' + (Math.floor(c / 65536) & 255) + ',' + (Math.floor(c / 256) & 255) + ',' + +((c & 255) / 255).toFixed(3) + ')';
    }
    return s;
  }
  function shows(c){ return typeof c === 'number' && c === c && (c & 255) > 0; }      // not na, not see-through
  function solid(c){ return 'rgb(' + (Math.floor(c / 16777216) & 255) + ',' + (Math.floor(c / 65536) & 255) + ',' + (Math.floor(c / 256) & 255) + ')'; }
  function ink(c){                                               // black or white text on this color
    var r = Math.floor(c / 16777216) & 255, g = Math.floor(c / 65536) & 255, b = Math.floor(c / 256) & 255;
    return (r * 299 + g * 587 + b * 114) / 1000 > 150 ? '#111' : '#fff';
  }
  function fromCss(s){ var p = UI.parse(s); return p ? (Math.round(p.r) * 65536 + Math.round(p.g) * 256 + Math.round(p.b)) * 256 + Math.round(p.a * 255) : NaN; }

  // a script's id: the server's (userdata.script_id), from its title
  function idOf(name){ return String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '') || 'indicator'; }
  function obj(x){ return x && typeof x === 'object' && !Array.isArray(x) ? x : {}; }
  function copy(x){ return JSON.parse(JSON.stringify(x)); }
  function lower(a, x){ var lo = 0, hi = a.length; while (lo < hi) { var m = (lo + hi) >> 1; if (a[m] < x) lo = m + 1; else hi = m; } return lo; }
  function disp(sp){ return typeof sp.display === 'number' ? sp.display : 15; }        // display.* flags: 1 pane, 4 price scale, 8 status line
  function day(t){ return t ? new Date(t * 1000).toISOString().slice(0, 10) : ''; }
  function nameOf(sp){
    if (sp.title) return sp.title;
    return sp.kind === 'plot' ? 'Plot' : sp.kind === 'shape' ? (sp.sub === 'char' ? 'Characters' : sp.sub === 'arrow' ? 'Arrows' : 'Shapes')
         : sp.kind === 'bg' ? 'Background' : sp.kind === 'hline' ? 'Horizontal line' : 'Fill';
  }

  window.DBCScripts = function(app){
    var chart = app.chart, series = app.series, ts = chart.timeScale();
    var list = [];                                               // the loaded indicators, in the order they were first loaded
    var engines = {};                                            // id -> the worker running that indicator
    var gen = 0, sym = {};                                       // which set of bars the workers hold, and the market as scripts see it
    var D = {n: 0, conf: 0, cap: 0};                             // those bars as columns (times in ms): what a new worker is sent
    COLS.forEach(function(k){ D[k] = new Float64Array(0); });
    var pendT = Infinity, flushTimer = 0, hoverAt = -1, shownRows = '', axisList = [];
    var requestUpdate = function(){};
    var picker = null;
    var colors = {get: function(){ return app.store.get('customColors') || []; }, set: function(l){ app.store.set('customColors', l); }};

    // ------------------------------------------------------------ the list, and what is saved of each
    function stateOf(id){ return obj(app.store.get('script:' + id)); }
    function keep(s){ app.store.set('script:' + s.id, {on: s.on, hide: s.hide, inputs: s.inputs, style: s.style}); }
    function entry(e){
      var st = stateOf(e.id);
      return {id: e.id, name: e.name, file: e.file, added: e.added, updated: e.updated, source: e.source,
              on: !!st.on, hide: !!st.hide, inputs: obj(st.inputs), style: obj(st.style),
              v: 0, sent: null, info: null, out: null, err: null, warn: []};
    }
    function byId(id){ for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i]; return null; }
    function fetchList(){
      var tries = 0;
      (function attempt(){
        fetch('/scripts').then(function(r){ return r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status)); }).then(function(j){
          // (one loaded while the list was on its way stays as it is, running)
          var got = (j.scripts || []).map(function(e){ return byId(e.id) || entry(e); });
          list.forEach(function(s){ if (got.indexOf(s) < 0) got.push(s); });
          list = got; app.saveState('scripts', null);
          list.forEach(function(s){ if (s.on && !engines[s.id]) start(s); });
          button(); changed();
        }, function(err){
          if (++tries >= 4) app.saveState('scripts', 'Indicators not loaded: ' + (err && err.message || 'server not answering'));
          setTimeout(attempt, Math.min(30000, 1000 * Math.pow(2, tries)));
        });
      })();
    }

    // ------------------------------------------------------------ the workers
    function start(s){
      stop(s);
      var w;
      try { w = new Worker(ENGINE); }
      catch (e) { s.err = {message: 'the indicator engine could not start: ' + (e && e.message || e), ln: 0}; return; }
      var E = engines[s.id] = {w: w, s: s, seq: 0, done: 0, since: 0};
      w.onmessage = function(ev){ heard(E, ev.data || {}); };
      w.onerror = function(ev){
        if (ev && ev.preventDefault) ev.preventDefault();
        if (engines[s.id] !== E) return;
        stop(s); s.out = null; s.err = {message: 'the indicator engine failed: ' + (ev && ev.message || 'unknown error'), ln: 0}; changed();
      };
      set(s);
      if (D.n) send(E, 0);
    }
    function stop(s){ var E = engines[s.id]; if (E) { E.w.terminate(); delete engines[s.id]; } }
    function work(E, m){                                         // a message the worker answers with a batch (and then idle)
      m.seq = ++E.seq;
      if (E.done === E.seq - 1) E.since = Date.now();            // it was idle: busy from now
      E.w.postMessage(m);
    }
    function set(s){
      var E = engines[s.id]; if (!E) return;
      s.v++; s.sent = JSON.stringify(s.inputs);
      work(E, {op: 'set', id: s.id, v: s.v, source: s.source, inputs: s.inputs});
    }
    function apply(s){                                           // new inputs: run again (unless those were run already)
      if (!engines[s.id]) { if (s.on) start(s); return; }
      if (JSON.stringify(s.inputs) !== s.sent) set(s);
    }
    function send(E, from){
      var cols = {};
      COLS.forEach(function(k){ cols[k] = D[k].slice(from, D.n); });
      work(E, {op: 'data', gen: gen, sym: sym, from: from, conf: D.conf, cols: cols});
    }
    function sendAll(from){ Object.keys(engines).forEach(function(id){ send(engines[id], from); }); }
    function heard(E, m){
      if (engines[E.s.id] !== E) return;                         // from a worker stopped since
      var s = E.s;
      if (m.op === 'idle') { E.done = Math.max(E.done, m.seq || 0); if (E.done < E.seq) E.since = Date.now(); return; }
      if (m.v !== s.v || m.gen !== gen) return;                  // about settings or bars that have changed since
      if (m.op === 'error') { s.err = m.error || {message: 'it failed', ln: 0}; s.out = null; changed(); return; }
      if (m.op !== 'out') return;
      if (m.fresh) { if (m.info) s.info = m.info; s.out = {n: m.n, outs: m.outs, labels: m.labels, lines: m.lines}; }
      else if (s.out) merge(s.out, m);
      else { set(s); return; }                                   // (cannot happen: a part with nothing to add it to, so all of it again)
      s.err = null; s.warn = m.warn || [];
      changed();
    }
    function grow(a, src, from, n){
      if (!a || a.length < n) { var b = new Float64Array(Math.ceil(n * 1.25) + 16); if (a) b.set(a.subarray(0, Math.min(a.length, from))); a = b; }
      a.set(src, from);
      return a;
    }
    function merge(out, m){                                      // the bars from m.from on, as the worker worked them out again
      var from = m.from;
      m.outs.forEach(function(x, i){
        var o = out.outs[i] || (out.outs[i] = {});
        if (Array.isArray(x.b)) {
          var B = o.b || (o.b = []), k = lower(B, from);
          ['b', 'y', 'c', 'tc'].forEach(function(key){ var a = o[key] || (o[key] = []); a.length = k; Array.prototype.push.apply(a, x[key]); });
        } else ['v', 'c', 'tv', 'bv', 'tcl', 'bcl'].forEach(function(key){ if (x[key]) o[key] = grow(o[key], x[key], from, m.n); });
      });
      out.n = m.n; out.labels = m.labels; out.lines = m.lines;
    }
    // A worker that has not finished after SLOW is stuck on something too heavy: stopped, and its row says so.
    setInterval(function(){
      var now = Date.now();
      Object.keys(engines).forEach(function(id){
        var E = engines[id], s = E.s;
        if (E.done >= E.seq || now - E.since < SLOW) return;
        stop(s); s.out = null;
        s.err = {message: 'it was still working after ' + SLOW / 1000 + ' seconds, so it was stopped (switch it off and on to try again)', ln: 0};
        changed();
      });
    }, 5000);
    // Compiles a file without running it: what is in it (title, inputs, outputs), or why it cannot run here.
    function check(source, inputs){
      return new Promise(function(done){
        var w, t;
        try { w = new Worker(ENGINE); } catch (e) { done({ok: false, error: {message: 'the indicator engine could not start: ' + (e && e.message || e), ln: 0}}); return; }
        function end(m){ clearTimeout(t); w.terminate(); done(m); }
        t = setTimeout(function(){ end({ok: false, error: {message: 'reading it took too long', ln: 0}}); }, 30000);
        w.onmessage = function(ev){ if (ev.data && ev.data.op === 'checked') end(ev.data); };
        w.onerror = function(ev){ if (ev && ev.preventDefault) ev.preventDefault(); end({ok: false, error: {message: 'the indicator engine failed: ' + (ev && ev.message || 'unknown error'), ln: 0}}); };
        w.postMessage({op: 'check', rid: 1, source: source, inputs: inputs || {}, sym: sym});
      });
    }

    // ------------------------------------------------------------ the chart's bars, to the workers
    function room(n){
      if (n <= D.cap) return;
      var cap = Math.max(1024, Math.ceil(n * 1.5));
      COLS.forEach(function(k){ var a = new Float64Array(cap); a.set(D[k].subarray(0, Math.min(D.n, cap))); D[k] = a; });
      D.cap = cap;
    }
    // A time bar closes when its period ends (as time_close says in TradingView), a dollar bar with its last minute.
    function closeOf(t, tf){
      if (tf === '1M') { var d = new Date(t * 1000); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1) / 1000; }
      return t + (TF_S[tf] || 86400);
    }
    function write(rows, from){
      var n = rows.length, time = app.mode() === 'time', tf = app.tf();
      room(n);
      for (var i = from; i < n; i++) {
        var r = rows[i];
        D.t[i] = r.t * 1000; D.e[i] = (time ? closeOf(r.t, tf) : r.e) * 1000;
        D.o[i] = r.o; D.h[i] = r.h; D.l[i] = r.l; D.c[i] = r.c; D.v[i] = typeof r.v === 'number' ? r.v : NaN;
      }
      D.n = n; D.conf = app.closed();
    }
    // syminfo.* and timeframe.*: a dollar bar has no period of its own ("" = the chart's), and counts as intraday when
    // the typical bar takes less than a day.
    function symOf(){
      var info = app.marketInfo() || {}, key = app.market(), kind = key.split(':')[0], p = app.mode() === 'time' ? PERIOD[app.tf()] : null;
      var ticker = info.ticker || key.split(':')[1] || key, prefix = kind === 'all' ? 'COMBINED' : 'BYBIT';
      var pf = series.options().priceFormat || {}, intraday = false;
      if (!p && D.n) {
        var d = [], i0 = Math.max(0, D.n - 201);
        for (var i = i0; i < D.n - 1; i++) d.push(D.e[i] - D.t[i]);
        d.sort(function(a, b){ return a - b; });
        intraday = !d.length || d[d.length >> 1] < 864e5;
      }
      return {ticker: ticker, tickerid: prefix + ':' + (info.symbol || ticker), prefix: prefix, description: info.name || ticker,
              type: info.stock ? 'stock' : 'crypto', mintick: pf.minMove || 0.01,
              period: p ? p[0] : '', multiplier: p ? p[1] : 1, intraday: p ? p[2] : intraday, unit: p ? p[3] : ''};
    }
    // The chart has a new set of bars: every indicator starts again on them. reset = another market, bar size or mode:
    // what the indicators drew goes at once (it belongs to other bars). Otherwise it stays until the new answers come.
    function render(rows, reset){
      clearTimeout(flushTimer); flushTimer = 0; pendT = Infinity;
      gen++; write(rows, 0); sym = symOf();
      list.forEach(function(s){
        if (reset) s.out = null;
        if (engines[s.id]) send(engines[s.id], 0);
        else if (s.on && reset) start(s);                        // one that was stopped gets another try on other bars
      });
      changed();
    }
    // One bar the chart added or changed (several in a row are sent together): from it to the newest, to every worker.
    function update(r){
      if (r.t * 1000 < pendT) pendT = r.t * 1000;
      if (!flushTimer) flushTimer = setTimeout(flush, 0);
    }
    function flush(){
      flushTimer = 0;
      var t = pendT, rows = app.rows(), from = rows.length; pendT = Infinity;
      if (!D.n || !rows.length) return;
      while (from > 0 && rows[from - 1].t * 1000 >= t) from--;
      from = Math.min(from, D.n);
      write(rows, from);
      sendAll(from);
    }
    function clear(){                                            // another market is loading
      clearTimeout(flushTimer); flushTimer = 0; pendT = Infinity;
      gen++; D.n = 0; D.conf = 0; hoverAt = -1;
      list.forEach(function(s){ s.out = null; });
      changed();
    }

    // ------------------------------------------------------------ painting
    function fontPx(){ return chart.options().layout.fontSize || 12; }
    // Where bars and prices are on the pane (CSS pixels): bar p is at x = xa + (p - la) × sp.
    function geo(sc){
      var n = D.n, r = n ? ts.getVisibleLogicalRange() : null;
      if (!r) return null;
      var la = Math.floor(r.from), xa = ts.logicalToCoordinate(la), xb = ts.logicalToCoordinate(la + 1);
      if (xa === null || xb === null) return null;
      return {n: n, la: la, xa: xa, sp: xb - xa, i0: Math.max(0, la - 2), i1: Math.min(n - 1, Math.ceil(r.to) + 2),
              W: sc.mediaSize.width, H: sc.mediaSize.height, hr: sc.horizontalPixelRatio, vr: sc.verticalPixelRatio, f: fontPx(),
              log: chart.priceScale('right').options().mode === 1};
    }
    function X(g, p){ return g.xa + (p - g.la) * g.sp; }
    function Y(g, v){
      if (typeof v !== 'number' || v !== v || (g.log && !(v > 0))) return null;
      return series.priceToCoordinate(v);
    }
    function visible(){ return list.filter(function(s){ return s.on && !s.hide && !s.err && s.out && s.info; }); }
    function drawn(s, i){ var o = s.style[i]; return (disp(s.info.outs[i]) & 1) && !(o && o.hide); }
    function colorOf(s, i){ var o = s.style[i]; return o && typeof o.color === 'number' ? o.color : s.info.outs[i].color; }
    function sample(g){ var px = g.sp * g.hr; return px < 0.5 ? Math.max(1, Math.floor(0.5 / px)) : 1; }   // zoomed far out: two points a device pixel
    function dashOf(style, w){ return (DASH[style] || []).map(function(v){ return v * w; }); }

    // plots: line, linebr, step, stepbr, area, areabr, hist, columns, cross, circles
    function paintPlot(ctx, g, s, i){
      var sp = s.info.outs[i], d = s.out.outs[i], V = d && d.v; if (!V) return;
      var o = s.style[i] || {}, CC = d.c || null, col = colorOf(s, i), n = Math.min(g.n, s.out.n), off = sp.offset || 0;
      var j0 = Math.max(0, g.i0 - off), j1 = Math.min(n - 1, g.i1 - off);
      if (sp.show_last >= 0) j0 = Math.max(j0, g.n - sp.show_last - off);
      if (j1 < j0) return;
      var hr = g.hr, vr = g.vr, lw = Math.max(1, o.lw || sp.lw || 1), st = sp.style || 'line', step = sample(g), j, v, y, x, c;
      var colAt = function(j){ return CC ? CC[j] : col; }, P = new Paths();
      if (st === 'hist' || st === 'columns') {
        var yb = Y(g, sp.histbase || 0), w = st === 'hist' ? Math.max(1, Math.round(lw * hr)) : Math.max(1, Math.round(g.sp * hr * 0.66)), lastX = -1e9;
        if (yb === null) yb = (sp.histbase || 0) > 0 ? 0 : g.H;
        for (j = j0; j <= j1; j++) {
          v = V[j]; c = colAt(j); y = Y(g, v);
          if (y === null || !shows(c)) continue;
          x = Math.round(X(g, j + off) * hr);
          if (x === lastX) continue;
          lastX = x;
          P.of(c).rect(x - (w >> 1), Math.round(Math.min(y, yb) * vr), w, Math.max(1, Math.round(Math.abs(y - yb) * vr)));
        }
        P.fill(ctx);
      } else if (st === 'cross' || st === 'circles') {
        if (sp.join) line(ctx, g, V, CC, col, off, j0, j1, step, false, false, Math.max(1, Math.round(lw * hr)), []);
        var arm = (2 + 1.5 * lw) * hr, rad = (1 + lw) * hr, px = -1e9, cross = st === 'cross';
        for (j = j0; j <= j1; j++) {
          v = V[j]; c = colAt(j); y = Y(g, v);
          if (y === null || !shows(c)) continue;
          x = X(g, j + off) * hr;
          if (x - px < 1) continue;
          px = x; y *= vr;
          var q = P.of(c);
          if (cross) { q.moveTo(x - arm, y); q.lineTo(x + arm, y); q.moveTo(x, y - arm); q.lineTo(x, y + arm); }
          else { q.moveTo(x + rad, y); q.arc(x, y, rad, 0, 2 * Math.PI); }
        }
        if (cross) { ctx.lineWidth = Math.max(1, Math.round(lw * hr)); ctx.lineCap = 'butt'; ctx.setLineDash([]); P.stroke(ctx); } else P.fill(ctx);
      } else {
        var br = /br$/.test(st), stepped = st === 'step' || st === 'stepbr';
        if (st === 'area' || st === 'areabr') area(ctx, g, V, CC, col, off, j0, j1, step, br, sp.histbase || 0);
        line(ctx, g, V, CC, col, off, j0, j1, step, br, stepped, Math.max(1, Math.round(lw * hr)), dashOf(o.dash || sp.dash, Math.max(1, Math.round(lw * hr))));
      }
      if (sp.trackprice) {                                       // a dotted line across the pane at the newest value
        v = V[n - 1]; c = colAt(n - 1); y = Y(g, v);
        if (y !== null && shows(c)) {
          var tw = Math.max(1, Math.round(hr)), Yp = Math.round(y * vr) + (tw % 2 ? 0.5 : 0);
          ctx.lineWidth = tw; ctx.strokeStyle = css(c); ctx.setLineDash([2 * tw, 3 * tw]);
          ctx.beginPath(); ctx.moveTo(0, Yp); ctx.lineTo(g.W * hr, Yp); ctx.stroke(); ctx.setLineDash([]);
        }
      }
    }
    // Paths by color: what one output draws goes into one path per color, each filled or stroked once (a line whose
    // color changes from bar to bar would otherwise take a stroke per segment).
    function Paths(){ this.m = Object.create(null); this.list = []; }
    Paths.prototype.of = function(c){
      var p = this.m[c];
      if (!p) { p = this.m[c] = new Path2D(); p.c = c; p.x = NaN; p.y = NaN; this.list.push(p); }
      return p;
    };
    Paths.prototype.at = function(c){                            // a plain list by color instead (points of text)
      var a = this.m[c];
      if (!a) { a = this.m[c] = []; a.c = c; this.list.push(a); }
      return a;
    };
    Paths.prototype.fill = function(ctx){ this.list.forEach(function(p){ ctx.fillStyle = css(p.c); ctx.fill(p); }); };
    Paths.prototype.stroke = function(ctx){ this.list.forEach(function(p){ ctx.strokeStyle = css(p.c); ctx.stroke(p); }); };
    // A line through the values. The segment that reaches bar j has bar j's color (an na color leaves it out). An na
    // value is stepped over (the line joins the values on both sides of it) unless br: then the line breaks there.
    function line(ctx, g, V, CC, col, off, j0, j1, step, br, stepped, w, dash){
      var hr = g.hr, vr = g.vr, has = false, px = 0, py = 0, P = new Paths();
      for (var k = j0; ; k += step) {
        var j = k < j1 ? k : j1, y = Y(g, V[j]);
        if (y === null) { if (br) has = false; }
        else {
          var x = X(g, j + off) * hr, c = CC ? CC[j] : col;
          y *= vr;
          if (has && shows(c)) {
            var p = P.of(c);
            if (p.x !== px || p.y !== py) p.moveTo(px, py);      // (a run of one color stays one stroke: its joins and dashes carry on)
            if (stepped) p.lineTo(x, py);
            p.lineTo(x, y); p.x = x; p.y = y;
          }
          px = x; py = y; has = true;
        }
        if (j >= j1) break;
      }
      ctx.lineWidth = w; ctx.lineJoin = 'round'; ctx.lineCap = 'butt'; ctx.setLineDash(dash);
      P.stroke(ctx);
      ctx.setLineDash([]);
    }
    // area: the line's color filled down to histbase (or to the pane's edge when that price is not on the scale)
    function area(ctx, g, V, CC, col, off, j0, j1, step, br, base){
      var hr = g.hr, vr = g.vr, yb = Y(g, base), run = [], cur = null;
      yb = (yb === null ? (base > 0 ? 0 : g.H) : yb) * vr;
      function fill(){
        if (run.length > 1) {
          ctx.beginPath(); ctx.moveTo(run[0], yb);
          for (var q = 0; q < run.length; q += 2) ctx.lineTo(run[q], run[q + 1]);
          ctx.lineTo(run[run.length - 2], yb); ctx.closePath(); ctx.fillStyle = css(cur); ctx.fill();
        }
      }
      for (var k = j0; ; k += step) {
        var j = k < j1 ? k : j1, y = Y(g, V[j]), c = CC ? CC[j] : col;
        if (y === null || !shows(c)) { if (y !== null || br) { fill(); run = []; } }
        else {
          var x = X(g, j + off) * hr;
          if (c !== cur) { var lx = run.length ? run.slice(-2) : null; fill(); run = lx || []; cur = c; }
          run.push(x, y * vr);
        }
        if (j >= j1) break;
      }
      fill();
    }
    function paintHline(ctx, g, s, i){
      var sp = s.info.outs[i], o = s.style[i] || {}, c = colorOf(s, i), y = Y(g, sp.price);
      if (y === null || !shows(c)) return;
      var w = Math.max(1, Math.round((o.lw || sp.lw || 1) * g.hr)), Yp = Math.round(y * g.vr) + (w % 2 ? 0.5 : 0);
      ctx.lineWidth = w; ctx.strokeStyle = css(c); ctx.lineCap = 'butt'; ctx.setLineDash(dashOf(o.dash || sp.style, w));
      ctx.beginPath(); ctx.moveTo(0, Yp); ctx.lineTo(g.W * g.hr, Yp); ctx.stroke(); ctx.setLineDash([]);
    }
    // fill between two plots, a plot and an hline, or two hlines (then a band across the pane)
    function paintFill(ctx, g, s, i){
      var sp = s.info.outs[i], d = s.out.outs[i], specs = s.info.outs, A = specs[sp.a], B = specs[sp.b];
      if (!A || !B || !d) return;
      if ((A.kind === 'plot' && !drawn(s, sp.a)) || (B.kind === 'plot' && !drawn(s, sp.b))) return;   // a hidden plot takes its fills with it
      var hr = g.hr, vr = g.vr, n = Math.min(g.n, s.out.n), C = d.c, j;
      if (A.kind === 'hline' && B.kind === 'hline') {
        var c = NaN; if (C) for (j = n - 1; j >= 0 && !(C[j] === C[j]); j--) {}
        if (C && j >= 0) c = C[j];
        var ya = Y(g, A.price), yb = Y(g, B.price);
        if (ya === null || yb === null || !shows(c)) return;
        ctx.fillStyle = css(c); ctx.fillRect(0, Math.round(Math.min(ya, yb) * vr), Math.ceil(g.W * hr), Math.round(Math.abs(yb - ya) * vr));
        return;
      }
      var VA = A.kind === 'plot' ? (s.out.outs[sp.a] || {}).v : null, VB = B.kind === 'plot' ? (s.out.outs[sp.b] || {}).v : null;
      if ((A.kind === 'plot' && !VA) || (B.kind === 'plot' && !VB)) return;
      var off = A.kind === 'plot' ? A.offset || 0 : B.offset || 0, step = sample(g);
      var j0 = Math.max(0, g.i0 - off), j1 = Math.min(n - 1, g.i1 - off);
      if (sp.show_last >= 0) j0 = Math.max(j0, g.n - sp.show_last - off);
      if (j1 < j0) return;
      var prev = null, run = null, cur = null;
      function flush(){
        if (run && run.top.length > 2) {
          ctx.beginPath(); ctx.moveTo(run.top[0], run.top[1]);
          for (var q = 2; q < run.top.length; q += 2) ctx.lineTo(run.top[q], run.top[q + 1]);
          for (q = run.bot.length - 2; q >= 0; q -= 2) ctx.lineTo(run.bot[q], run.bot[q + 1]);
          ctx.closePath(); ctx.fillStyle = css(cur); ctx.fill();
        }
        run = null;
      }
      for (var k = j0; ; k += step) {
        j = k < j1 ? k : j1;
        var ya2 = Y(g, VA ? VA[j] : A.price), yb2 = Y(g, VB ? VB[j] : B.price);
        if (ya2 === null || yb2 === null) { if (!sp.gaps) { flush(); prev = null; } }
        else {
          var x = X(g, j + off) * hr, p = {x: x, a: ya2 * vr, b: yb2 * vr};
          if (sp.grad) {
            if (prev) {
              var t1 = Y(g, d.tv[j]), b1 = Y(g, d.bv[j]), ct = d.tcl[j], cb = d.bcl[j];
              if (t1 !== null && b1 !== null && (shows(ct) || shows(cb))) {
                var gr = Math.abs(b1 - t1) > 0.5 ? ctx.createLinearGradient(0, t1 * vr, 0, b1 * vr) : null;
                if (gr) { gr.addColorStop(0, css(shows(ct) ? ct : cb)); gr.addColorStop(1, css(shows(cb) ? cb : ct)); }
                ctx.fillStyle = gr || css(shows(ct) ? ct : cb);
                ctx.beginPath(); ctx.moveTo(prev.x, prev.a); ctx.lineTo(p.x, p.a); ctx.lineTo(p.x, p.b); ctx.lineTo(prev.x, prev.b); ctx.closePath(); ctx.fill();
              }
            }
          } else {
            var c2 = C ? C[j] : NaN;
            if (!shows(c2)) flush();
            else if (!run || c2 !== cur) { flush(); cur = c2; run = {top: prev ? [prev.x, prev.a] : [], bot: prev ? [prev.x, prev.b] : []}; }
            if (run) { run.top.push(p.x, p.a); run.bot.push(p.x, p.b); }
          }
          prev = p;
        }
        if (j >= j1) break;
      }
      flush();
    }
    function paintBg(ctx, g, s, i){                              // the bar's whole column, from halfway to the bar before to halfway to the next
      var sp = s.info.outs[i], C = (s.out.outs[i] || {}).c; if (!C) return;
      var off = sp.offset || 0, n = Math.min(g.n, s.out.n), hr = g.hr, Hd = Math.ceil(g.H * g.vr), step = sample(g);
      var p0 = g.i0, p1 = g.i1, run = -1, rc = NaN;
      if (sp.show_last >= 0) p0 = Math.max(p0, g.n - sp.show_last);
      function flush(p){
        if (run >= 0 && shows(rc)) {
          var xl = Math.round((X(g, run) - g.sp / 2) * hr), xr = Math.round((X(g, p) - g.sp / 2) * hr);
          ctx.fillStyle = css(rc); ctx.fillRect(xl, 0, Math.max(1, xr - xl), Hd);
        }
      }
      for (var p = p0; p <= p1 + step; p += step) {
        var j = p - off, c = p <= p1 && j >= 0 && j < n ? C[j] : NaN;
        if (c !== rc || p > p1) { flush(Math.min(p, p1 + 1)); run = p; rc = c; }
      }
    }
    // drawn lines (line.new): by bar index or by time, extended, dashed or dotted, with arrow heads
    function xOf(g, x, xloc){
      var l = xloc === 'bt' ? app.timeToLogical(x / 1000) : x;
      return l === null || typeof l !== 'number' || l !== l ? null : X(g, l);
    }
    function head(ctx, x, y, dx, dy, w){                         // an arrow head at (x, y), pointing along (dx, dy)
      var L = Math.hypot(dx, dy); if (!L) return;
      var ux = dx / L, uy = dy / L, a = 4 + 2.5 * w, b = a * 0.55;
      ctx.beginPath(); ctx.moveTo(x - ux * a - uy * b, y - uy * a + ux * b); ctx.lineTo(x, y); ctx.lineTo(x - ux * a + uy * b, y - uy * a - ux * b); ctx.stroke();
    }
    function paintLine(ctx, g, ln){
      if (!shows(ln.color)) return;
      var x1 = xOf(g, ln.x1, ln.xloc), x2 = xOf(g, ln.x2, ln.xloc), y1 = Y(g, ln.y1), y2 = Y(g, ln.y2);
      if (x1 === null || x2 === null || y1 === null || y2 === null) return;
      var hr = g.hr, vr = g.vr, dx = x2 - x1, dy = y2 - y1, L = Math.hypot(dx, dy), ext = ln.ext || 'n';
      var w = Math.max(1, Math.round((ln.width || 1) * hr)), a1 = [x1 * hr, y1 * vr], a2 = [x2 * hr, y2 * vr];
      if (L > 0 && ext !== 'n') {
        var k = (g.W + g.H) * 4 / L;
        if (ext === 'l' || ext === 'b') { x1 -= dx * k; y1 -= dy * k; }
        if (ext === 'r' || ext === 'b') { x2 += dx * k; y2 += dy * k; }
      }
      var lim = 1e5, cl = function(v){ return Math.max(-lim, Math.min(lim, v)); };
      ctx.lineWidth = w; ctx.strokeStyle = css(ln.color); ctx.lineCap = 'butt'; ctx.lineJoin = 'miter';
      ctx.setLineDash(dashOf(ln.style, w));
      ctx.beginPath(); ctx.moveTo(cl(x1 * hr), cl(y1 * vr)); ctx.lineTo(cl(x2 * hr), cl(y2 * vr)); ctx.stroke(); ctx.setLineDash([]);
      if (ln.style === 'aleft' || ln.style === 'aboth') head(ctx, a1[0], a1[1], a1[0] - a2[0], a1[1] - a2[1], w);
      if (ln.style === 'aright' || ln.style === 'aboth') head(ctx, a2[0], a2[1], a2[0] - a1[0], a2[1] - a1[1], w);
    }

    // shapes, in CSS pixels, centered on (x, y), h = height: added to path p (a canvas or a Path2D). Crosses are
    // stroked (lineWidth: crossWidth), the others filled.
    function stroked(st){ return st === 'cross' || st === 'xcross' || !SHAPE[st]; }
    function crossWidth(h){ return Math.max(1.5, h / 6); }
    var SHAPE = {triup: 1, tridn: 1, circle: 1, square: 1, diamond: 1, arrowup: 1, arrowdn: 1, flag: 1, cross: 1, xcross: 1};
    function shapePath(p, st, x, y, h){
      var r = h / 2;
      switch (st) {
        case 'triup': p.moveTo(x, y - r); p.lineTo(x + r, y + r); p.lineTo(x - r, y + r); p.closePath(); return;
        case 'tridn': p.moveTo(x, y + r); p.lineTo(x + r, y - r); p.lineTo(x - r, y - r); p.closePath(); return;
        case 'circle': p.moveTo(x + r, y); p.arc(x, y, r, 0, 2 * Math.PI); return;
        case 'square': p.rect(x - r, y - r, h, h); return;
        case 'diamond': p.moveTo(x, y - r); p.lineTo(x + r * 0.8, y); p.lineTo(x, y + r); p.lineTo(x - r * 0.8, y); p.closePath(); return;
        case 'arrowup': p.moveTo(x, y - r); p.lineTo(x + r * 0.7, y); p.lineTo(x + r * 0.25, y); p.lineTo(x + r * 0.25, y + r); p.lineTo(x - r * 0.25, y + r);
                        p.lineTo(x - r * 0.25, y); p.lineTo(x - r * 0.7, y); p.closePath(); return;
        case 'arrowdn': p.moveTo(x, y + r); p.lineTo(x + r * 0.7, y); p.lineTo(x + r * 0.25, y); p.lineTo(x + r * 0.25, y - r); p.lineTo(x - r * 0.25, y - r);
                        p.lineTo(x - r * 0.25, y); p.lineTo(x - r * 0.7, y); p.closePath(); return;
        case 'flag': p.rect(x - r * 0.75, y - r, Math.max(1, h / 9), h);
                     p.moveTo(x - r * 0.75, y - r); p.lineTo(x + r * 0.85, y - r * 0.55); p.lineTo(x - r * 0.75, y - r * 0.05); p.closePath(); return;
        case 'cross': p.moveTo(x - r, y); p.lineTo(x + r, y); p.moveTo(x, y - r); p.lineTo(x, y + r); return;
        default: p.moveTo(x - r * 0.8, y - r * 0.8); p.lineTo(x + r * 0.8, y + r * 0.8); p.moveTo(x + r * 0.8, y - r * 0.8); p.lineTo(x - r * 0.8, y + r * 0.8);   // xcross
      }
    }
    function shape(ctx, st, x, y, h, c){                         // one shape, drawn now
      ctx.beginPath(); shapePath(ctx, st, x, y, h);
      if (stroked(st)) { ctx.lineWidth = crossWidth(h); ctx.lineCap = 'butt'; ctx.strokeStyle = css(c); ctx.stroke(); }
      else { ctx.fillStyle = css(c); ctx.fill(); }
    }
    function rrect(p, x, y, w, h, r, sharp){                     // a rounded box; sharp: the corner that points ('tl', 'tr', 'br', 'bl')
      var c = {tl: r, tr: r, br: r, bl: r}; if (sharp) c[sharp] = 0;
      p.moveTo(x + c.tl, y);
      p.arcTo(x + w, y, x + w, y + h, c.tr); p.arcTo(x + w, y + h, x, y + h, c.br);
      p.arcTo(x, y + h, x, y, c.bl); p.arcTo(x, y, x + w, y, c.tl); p.closePath();
    }
    // Lines of text in a block whose top is y. An empty line takes its room: "\n5" under a bar puts the 5 a line lower.
    function text(ctx, lines, x, y, lh, align){
      ctx.textAlign = align || 'center'; ctx.textBaseline = 'middle';
      for (var q = 0; q < lines.length; q++) if (lines[q]) ctx.fillText(lines[q], x, y + (q + 0.5) * lh);
    }
    function sizeOf(g, size){                                    // a shape's height; auto follows the bar spacing
      var f = g.f;
      return SHAPE_PX[size] ? SHAPE_PX[size] * f : Math.max(0.4 * f, Math.min(SHAPE_PX.small * f, g.sp * 0.9));
    }
    function paintShapes(ctx, g, s, i){
      var sp = s.info.outs[i], d = s.out.outs[i], B = d && d.b; if (!B || !B.length) return;
      var off = sp.offset || 0, n = g.n, k = lower(B, g.i0 - off), cut = sp.show_last >= 0 ? n - sp.show_last : -Infinity;
      var f = g.f, gap = GAP * f, arrow = sp.sub === 'arrow', isChar = sp.sub === 'char', bubble = sp.style === 'labelup' || sp.style === 'labeldn';
      var h = arrow ? 0 : sizeOf(g, sp.size), lines = sp.text ? String(sp.text).split('\n') : null;
      var tpx = Math.round(TEXT_PX.small * f), lh = Math.round(tpx * 1.2), maxAbs = 0, lastX = -1e9, kk;
      if (arrow) for (kk = k; kk < B.length && B[kk] + off <= g.i1; kk++) maxAbs = Math.max(maxAbs, Math.abs(d.y[kk]));
      var bw = 0, bh = 0, ph = 0;
      if (bubble) {                                              // labelup / labeldown: the text sits inside, the box fits it
        ctx.font = tpx + 'px ' + FONT;
        if (lines) {
          lines.forEach(function(t){ bw = Math.max(bw, ctx.measureText(t).width); });
          bw = Math.max(bw + 2 * Math.round(tpx * 0.45), tpx); bh = lines.length * lh + Math.round(tpx * 0.45); ph = Math.max(3, Math.round(tpx * 0.4));
        } else { bw = h; bh = h * 0.7; ph = Math.max(3, Math.round(h * 0.3)); }
        h = bh + ph;
      }
      // Each mark goes into its color's path (characters and words into lists by color), all drawn at the end.
      var P = new Paths(), chars = new Paths(), words = new Paths(), above = sp.loc === 'ab' || sp.loc === 'top';
      for (; k < B.length; k++) {
        var p = B[k] + off;
        if (p > g.i1) break;
        if (p < cut) continue;
        var x = X(g, p);
        if (g.sp < 1 && Math.abs(x - lastX) < 1) continue;       // zoomed far out: one a pixel
        lastX = x;
        var j = p < n ? p : B[k], c = d.c[k], tc = d.tc[k], yc, y0, q;
        if (arrow) {                                             // plotarrow: up below the bar for a positive value, down above it for a negative one
          var v = d.y[k], len = sp.minh + (sp.maxh - sp.minh) * (maxAbs ? Math.abs(v) / maxAbs : 1), aw = Math.max(4, Math.min(12, g.sp * 0.8));
          var up = v > 0, base = Y(g, up ? D.l[j] : D.h[j]), col = up ? c : tc;
          if (base === null || !shows(col)) continue;
          y0 = up ? base + gap : base - gap;
          var y1 = up ? y0 + len : y0 - len, hd = Math.min(len, aw * 1.2), yh2 = up ? y0 + hd : y0 - hd;
          q = P.of(col);
          q.moveTo(x, y0); q.lineTo(x + aw / 2, yh2); q.lineTo(x + aw / 6, yh2); q.lineTo(x + aw / 6, y1);
          q.lineTo(x - aw / 6, y1); q.lineTo(x - aw / 6, yh2); q.lineTo(x - aw / 2, yh2); q.closePath();
          continue;
        }
        if (sp.loc === 'ab') { var yh = Y(g, D.h[j]); if (yh === null) continue; yc = yh - gap - h / 2; }
        else if (sp.loc === 'bl') { var yl = Y(g, D.l[j]); if (yl === null) continue; yc = yl + gap + h / 2; }
        else if (sp.loc === 'top') yc = gap + h / 2;
        else if (sp.loc === 'bot') yc = g.H - gap - h / 2;
        else { yc = Y(g, d.y[k]); if (yc === null) continue; }
        if (bubble) {
          var dn = sp.style === 'labeldn', top = yc - h / 2, by = dn ? top : top + ph;
          if (shows(c)) {                                        // (each on its own: one path of many overlapping boxes fills slower)
            ctx.fillStyle = css(c); ctx.beginPath(); rrect(ctx, x - bw / 2, by, bw, bh, 3);
            if (dn) { ctx.moveTo(x - ph, by + bh - 0.5); ctx.lineTo(x + ph, by + bh - 0.5); ctx.lineTo(x, by + bh + ph); }
            else { ctx.moveTo(x - ph, by + 0.5); ctx.lineTo(x + ph, by + 0.5); ctx.lineTo(x, top); }
            ctx.closePath(); ctx.fill();
          }
          if (lines && shows(tc)) words.at(tc === c ? (ink(c) === '#111' ? 255 : 0xFFFFFFFF) : tc).push(x, by + (bh - lines.length * lh) / 2);
          continue;
        }
        if (shows(c)) { if (isChar) chars.at(c).push(x, yc); else shapePath(P.of(c), sp.style, x, yc, h); }
        if (lines && shows(tc)) words.at(tc).push(x, above ? yc - h / 2 - 2 - lines.length * lh : yc + h / 2 + 2);   // the words: above a shape above the bar, under it otherwise
      }
      if (stroked(sp.style) && !bubble && !arrow && !isChar) { ctx.lineWidth = crossWidth(h); ctx.lineCap = 'butt'; ctx.setLineDash([]); P.stroke(ctx); }
      else P.fill(ctx);
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      if (isChar) {
        ctx.font = Math.round(h) + 'px ' + FONT;
        chars.list.forEach(function(a){ ctx.fillStyle = css(a.c); for (var m = 0; m < a.length; m += 2) ctx.fillText(sp.style, a[m], a[m + 1]); });
      }
      if (lines) {
        ctx.font = tpx + 'px ' + FONT;
        words.list.forEach(function(a){ ctx.fillStyle = css(a.c); for (var m = 0; m < a.length; m += 2) text(ctx, lines, a[m], a[m + 1], lh); });
      }
    }
    // labels (label.new): the box around the text, placed by its style around the point (x, y) it points at
    var BOX = {down: 1, up: 1, left: 1, right: 1, lleft: 1, lright: 1, uleft: 1, uright: 1, center: 1};
    function paintLabel(ctx, g, lb){
      var l = lb.xloc === 'bt' ? app.timeToLogical(lb.x / 1000) : lb.x;
      if (typeof l !== 'number' || l !== l) return;
      var x = X(g, l);
      if (x < -600 || x > g.W + 600) return;
      var f = g.f, px = Math.round((TEXT_PX[lb.size] || TEXT_PX.normal) * f), lh = Math.round(px * 1.25), st = lb.style || 'down';
      var lines = lb.text ? String(lb.text).split('\n') : [], tw = 0, fmt = +lb.fmt || 0;
      var al = lb.align === 'left' || lb.align === 'right' ? lb.align : 'center';
      ctx.font = (fmt & 2 ? 'italic ' : '') + (fmt & 1 ? '700 ' : '') + px + 'px ' + (lb.font === 'mono' ? MONO : FONT);
      lines.forEach(function(t){ tw = Math.max(tw, ctx.measureText(t).width); });
      var pad = Math.round(px * 0.45), ph = Math.round(px * 0.45), th = lines.length * lh, gap = GAP * f;
      var w, h, top, bot, isBox = BOX[st], isText = st === 'none' || st === 'outline', sh = isBox || isText ? 0 : sizeOf(g, lb.size === 'auto' ? 'small' : lb.size);
      if (isBox) { w = Math.max(tw + 2 * pad, px); h = Math.max(th + pad, px * 0.9); }
      else if (isText) { w = tw; h = th; }
      // the room it takes above and below the point (negative = above)
      if (st === 'down') { top = -(h + ph); bot = 0; } else if (st === 'up') { top = 0; bot = h + ph; }
      else if (st === 'lleft' || st === 'lright') { top = -h; bot = 0; } else if (st === 'uleft' || st === 'uright') { top = 0; bot = h; }
      else if (isBox || isText) { top = -h / 2; bot = h / 2; }
      else { top = -sh / 2 - (lines.length && lb.yloc === 'ab' ? th + 2 : 0); bot = sh / 2 + (lines.length && lb.yloc !== 'ab' ? th + 2 : 0); }
      var y;
      if (lb.yloc === 'ab' || lb.yloc === 'bl') {
        var j = Math.round(l); if (j < 0 || j >= D.n) return;
        var yb = Y(g, lb.yloc === 'ab' ? D.h[j] : D.l[j]); if (yb === null) return;
        y = lb.yloc === 'ab' ? yb - gap - bot : yb + gap - top;
      } else { y = Y(g, lb.y); if (y === null) return; }
      var bg = shows(lb.color) ? css(lb.color) : null, fg = shows(lb.tc) ? css(lb.tc) : null;
      if (isText) {
        if (!fg) return;
        var ty = y - h / 2, tx = al === 'left' ? x - w / 2 : al === 'right' ? x + w / 2 : x;
        if (st === 'outline' && bg) { ctx.lineWidth = Math.max(2, px / 5); ctx.strokeStyle = bg; ctx.lineJoin = 'round'; ctx.textAlign = al; ctx.textBaseline = 'middle';
          for (var q = 0; q < lines.length; q++) if (lines[q]) ctx.strokeText(lines[q], tx, ty + (q + 0.5) * lh); }
        ctx.fillStyle = fg; text(ctx, lines, tx, ty, lh, al);
        return;
      }
      if (!isBox) {                                              // a shape at the point, the text under it (above it when the label is above the bar)
        if (bg) shape(ctx, st, x, y, sh, lb.color);
        if (fg && lines.length) { ctx.fillStyle = fg; text(ctx, lines, x, lb.yloc === 'ab' ? y - sh / 2 - 2 - th : y + sh / 2 + 2, lh, 'center'); }
        return;
      }
      var bx, by, sharp = null;
      switch (st) {
        case 'down': bx = x - w / 2; by = y - ph - h; break;
        case 'up': bx = x - w / 2; by = y + ph; break;
        case 'left': bx = x + ph; by = y - h / 2; break;
        case 'right': bx = x - ph - w; by = y - h / 2; break;
        case 'lleft': bx = x; by = y - h; sharp = 'bl'; break;
        case 'lright': bx = x - w; by = y - h; sharp = 'br'; break;
        case 'uleft': bx = x; by = y; sharp = 'tl'; break;
        case 'uright': bx = x - w; by = y; sharp = 'tr'; break;
        default: bx = x - w / 2; by = y - h / 2;
      }
      if (bg) {
        ctx.fillStyle = bg; ctx.beginPath(); rrect(ctx, bx, by, w, h, Math.min(4, px / 3), sharp); ctx.fill();
        ctx.beginPath();                                         // the pointer
        if (st === 'down') { ctx.moveTo(x - ph, by + h - 0.5); ctx.lineTo(x + ph, by + h - 0.5); ctx.lineTo(x, y); }
        else if (st === 'up') { ctx.moveTo(x - ph, by + 0.5); ctx.lineTo(x + ph, by + 0.5); ctx.lineTo(x, y); }
        else if (st === 'left') { ctx.moveTo(bx + 0.5, y - ph); ctx.lineTo(bx + 0.5, y + ph); ctx.lineTo(x, y); }
        else if (st === 'right') { ctx.moveTo(bx + w - 0.5, y - ph); ctx.lineTo(bx + w - 0.5, y + ph); ctx.lineTo(x, y); }
        ctx.closePath(); ctx.fill();
      }
      if (fg && lines.length) { ctx.fillStyle = fg; text(ctx, lines, al === 'left' ? bx + pad : al === 'right' ? bx + w - pad : bx + w / 2, by + (h - th) / 2, lh, al); }
    }

    function each(g, fn){
      visible().forEach(function(s){
        for (var i = 0; i < s.info.outs.length; i++) if (s.out.outs[i] && drawn(s, i)) fn(s, i, s.info.outs[i].kind);
      });
    }
    var below = {draw: function(target){
      target.useBitmapCoordinateSpace(function(sc){
        var g = geo(sc); if (!g) return;
        each(g, function(s, i, kind){ if (kind === 'bg') paintBg(sc.context, g, s, i); });
      });
    }};
    var above = {draw: function(target){
      var g = null;
      target.useBitmapCoordinateSpace(function(sc){
        g = geo(sc); if (!g) return;
        var ctx = sc.context;
        visible().forEach(function(s){                           // fills, then horizontal lines, plots and drawn lines
          var outs = s.info.outs, i;
          for (i = 0; i < outs.length; i++) if (outs[i].kind === 'fill' && drawn(s, i)) paintFill(ctx, g, s, i);
          for (i = 0; i < outs.length; i++) if (outs[i].kind === 'hline' && drawn(s, i)) paintHline(ctx, g, s, i);
          for (i = 0; i < outs.length; i++) if (outs[i].kind === 'plot' && drawn(s, i)) paintPlot(ctx, g, s, i);
          (s.out.lines || []).forEach(function(ln){ paintLine(ctx, g, ln); });
        });
      });
      if (g) target.useMediaCoordinateSpace(function(sc){
        var ctx = sc.context;
        visible().forEach(function(s){                           // shapes, then labels on top
          for (var i = 0; i < s.info.outs.length; i++) if (s.info.outs[i].kind === 'shape' && drawn(s, i)) paintShapes(ctx, g, s, i);
          (s.out.labels || []).forEach(function(lb){ paintLabel(ctx, g, lb); });
        });
      });
    }};
    var views = [{zOrder: function(){ return 'bottom'; }, renderer: function(){ return below; }},
                 {zOrder: function(){ return 'normal'; }, renderer: function(){ return above; }}];
    series.attachPrimitive({
      attached: function(p){ requestUpdate = p.requestUpdate; },
      detached: function(){ requestUpdate = function(){}; },
      updateAllViews: function(){},
      paneViews: function(){ return views; },
      priceAxisViews: function(){ return axisList; }
    });

    // ------------------------------------------------------------ values: in the legend, and the newest on the price axis
    function abbr(v){
      var a = Math.abs(v);
      return a >= 1e9 ? (v / 1e9).toFixed(2) + 'B' : a >= 1e6 ? (v / 1e6).toFixed(2) + 'M' : a >= 1e3 ? (v / 1e3).toFixed(2) + 'K' : String(+v.toFixed(2));
    }
    function fmt(s, v){
      var inf = s.info, p = inf.precision;
      if (inf.format === 'volume') return abbr(v);
      if (inf.format === 'percent') return v.toFixed(p >= 0 ? Math.min(p, 12) : 2) + '%';
      if (p >= 0) return v.toFixed(Math.min(p, 16));
      if (inf.format === 'mintick') return v.toFixed(Math.max(0, Math.min(12, Math.ceil(-Math.log10(sym.mintick || 0.01) - 1e-9))));
      return app.fmtP(v);
    }
    function at(s, i, j){                                        // plot i at bar j: {v, c}, or null
      var sp = s.info.outs[i], d = s.out.outs[i], k = j - (sp.offset || 0);
      if (!d || !d.v || k < 0 || k >= s.out.n) return null;
      var v = d.v[k], c = d.c ? d.c[k] : colorOf(s, i);
      return v === v ? {v: v, c: c} : null;
    }
    function lastOf(s, i){ var q = s.out && s.out.n ? at(s, i, s.out.n - 1 + (s.info.outs[i].offset || 0)) : null; return q && shows(q.c) ? q : null; }
    function axisView(s, i){
      function y(){ var q = lastOf(s, i); return q ? series.priceToCoordinate(q.v) : null; }
      return {coordinate: function(){ var v = y(); return v === null ? -100 : v; },
              text: function(){ var q = lastOf(s, i); return q ? fmt(s, q.v) : ''; },
              textColor: function(){ var q = lastOf(s, i); return q ? ink(q.c) : '#fff'; },
              backColor: function(){ var q = lastOf(s, i); return q ? solid(q.c) : 'transparent'; },
              visible: function(){ var v = y(); return v !== null && v >= 0 && v <= chart.paneSize().height; },
              tickVisible: function(){ return true; }};
    }
    function axis(){                                             // rebuilt only when what is shown changes: the chart keeps views by identity
      var out = [];
      visible().forEach(function(s){
        s.info.outs.forEach(function(sp, i){ if (sp.kind === 'plot' && (disp(sp) & 4) && drawn(s, i)) out.push(axisView(s, i)); });
      });
      axisList = out;
    }
    function errText(s){
      var e = s.err || {}, bar = typeof e.bar === 'number' && e.bar < D.n ? ' (on the bar of ' + app.fmtT(D.t[e.bar] / 1000) + ')' : '';
      return (e.ln ? 'Line ' + e.ln + ': ' : '') + (e.message || 'it failed') + bar;
    }
    function tipOf(s){ return s.name + '\n' + s.file + (s.updated ? ', loaded ' + day(s.updated) : ''); }
    function rowHtml(s){
      var title = s.info ? s.info.short || s.info.title : s.name;
      var flag = s.err ? '<span class="er" title="' + esc(errText(s)) + '">⚠</span>'
               : s.warn.length ? '<span class="wn" title="' + esc(s.warn.join('\n')) + '">!</span>' : '';
      return '<div class="sr' + (s.hide ? ' off' : '') + (s.err ? ' bad' : '') + '" data-id="' + esc(s.id) + '">' +
        '<span class="sn" title="' + esc(tipOf(s)) + '">' + esc(title) + '</span>' + flag + '<span class="sv"></span>' +
        '<span class="sb"><button data-a="eye" title="' + (s.hide ? 'Show' : 'Hide') + '">' + (s.hide ? ICON.shut : ICON.eye) + '</button>' +
        '<button data-a="gear" title="Settings">' + ICON.gear + '</button><button data-a="x" title="Remove from the chart">' + ICON.x + '</button></span></div>';
    }
    // One row per indicator switched on; its values follow the mouse. The rows are made again only when one comes,
    // goes or changes state, so the buttons under the mouse stay put while values change.
    function legend(){
      var box = $('lgScr'); if (!box) return;
      var on = list.filter(function(s){ return s.on; });
      var key = JSON.stringify(on.map(function(s){ return [s.id, s.hide, s.err && errText(s), s.warn, s.info && s.info.short, s.name]; }));
      if (key !== shownRows) { shownRows = key; box.innerHTML = on.map(rowHtml).join(''); }
      values();
    }
    function values(){
      var box = $('lgScr'); if (!box) return;
      Array.prototype.forEach.call(box.children, function(row){
        var s = byId(row.getAttribute('data-id')), html = '';
        if (s && !s.hide && !s.err && s.out && s.info) {
          var j = hoverAt >= 0 ? hoverAt : D.n - 1;
          s.info.outs.forEach(function(sp, i){
            if (sp.kind !== 'plot' || !(disp(sp) & 8) || (s.style[i] && s.style[i].hide)) return;
            var q = at(s, i, j);
            html += q ? '<b style="color:' + (shows(q.c) ? solid(q.c) : 'var(--tx3)') + '">' + esc(fmt(s, q.v)) + '</b>' : '<b class="na">∅</b>';
          });
        }
        var sv = row.querySelector('.sv');
        if (sv && sv.innerHTML !== html) sv.innerHTML = html;
      });
    }
    function changed(){ axis(); legend(); requestUpdate(); }
    function find(tms){                                          // the index of the bar that opens at tms, or -1
      var lo = 0, hi = D.n - 1;
      while (lo <= hi) { var m = (lo + hi) >> 1, t = D.t[m]; if (t === tms) return m; if (t < tms) lo = m + 1; else hi = m - 1; }
      return -1;
    }
    function hover(r){ var j = r ? find(r.t * 1000) : -1; if (j !== hoverAt) { hoverAt = j; values(); } }

    var lg = $('lgScr');
    if (lg) {
      lg.addEventListener('click', function(e){
        var b = e.target.closest('button[data-a]'), row = e.target.closest('.sr'), s = row && byId(row.getAttribute('data-id'));
        if (!b || !s) return;
        var a = b.getAttribute('data-a');
        if (a === 'eye') { s.hide = !s.hide; keep(s); changed(); }
        else if (a === 'gear') settings(s);
        else if (a === 'x') toggle(s);
      });
      lg.addEventListener('dblclick', function(e){
        var row = e.target.closest('.sr'), s = row && !e.target.closest('button') && byId(row.getAttribute('data-id'));
        if (s) settings(s);
      });
    }

    // ------------------------------------------------------------ switching on and off, loading, removing
    function anyOn(){ return list.some(function(s){ return s.on; }); }
    function button(){ if (app.ind && app.ind.button) app.ind.button(); }
    function toggle(s){
      s.on = !s.on; keep(s);
      if (s.on) start(s); else { stop(s); s.out = null; s.err = null; s.warn = []; }
      button(); changed();
    }
    function message(title, html, okText, onOk){                 // a dialog that says something; with onOk it asks (Cancel / okText)
      var d = UI.dialog({title: title, tabs: [{name: '', render: function(body){ body.classList.add('msg'); body.innerHTML = html; }}], onOk: onOk || function(){}});
      if (!onOk) d.el.querySelector('.cancel').style.display = 'none';
      if (okText) d.el.querySelector('.ok').textContent = okText;
      return d;
    }
    function cannot(file, src, er){
      er = er || {};
      var ln = er.ln, code = ln ? (String(src).split(/\r?\n/)[ln - 1] || '').trim() : '';
      message('Cannot load ' + file, '<p>' + (ln ? 'Line ' + ln + ': ' : '') + esc(er.message || 'unknown error') + '</p>' +
              (code ? '<pre class="src">' + esc(code.length > 200 ? code.slice(0, 200) + '…' : code) + '</pre>' : ''));
    }
    function pick(){
      if (!picker) {
        picker = UI.el('input'); picker.type = 'file'; picker.accept = '.pine,.txt'; picker.style.display = 'none';
        picker.onchange = function(){ var f = picker.files && picker.files[0]; picker.value = ''; if (f) load(f); };
        document.body.appendChild(picker);
      }
      picker.click();
    }
    function load(f){
      if (!/\.(pine|txt)$/i.test(f.name)) return message('Cannot load ' + f.name, '<p>An indicator is a .pine or .txt file.</p>');
      if (f.size > MAX_SOURCE * 4) return message('Cannot load ' + f.name, '<p>The file is larger than an indicator can be.</p>');
      f.text().then(function(src){
        src = src.replace(/^﻿/, '');
        if (!src.trim()) return message('Cannot load ' + f.name, '<p>The file is empty.</p>');
        if (src.length > MAX_SOURCE) return message('Cannot load ' + f.name, '<p>The script is longer than ' + MAX_SOURCE.toLocaleString() + ' characters.</p>');
        return check(src, {}).then(function(m){
          if (!m.ok) return cannot(f.name, src, m.error);
          var title = m.info.title, old = byId(idOf(title));
          if (!old) return keepFile(title, f.name, src);
          message('Replace "' + old.name + '"?', '<p>An indicator with this title is loaded already (from ' + esc(old.file) +
                  (old.updated ? ', ' + day(old.updated) : '') + '). Its settings are kept.</p>', 'Replace', function(){ keepFile(title, f.name, src); });
        });
      }).catch(function(e){ message('Cannot load ' + f.name, '<p>' + esc(e && e.message || String(e)) + '</p>'); });
    }
    function keepFile(title, file, src){
      app.post('/scripts', {add: {name: title, file: file, source: src}}).then(function(j){
        var e = j.script, s = byId(e.id);
        if (s) { s.name = e.name; s.file = e.file; s.updated = e.updated; s.source = src; s.info = null; s.err = null; }
        else { s = entry(Object.assign({source: src}, e)); list.push(s); }
        s.on = true; keep(s);
        if (engines[s.id]) set(s); else start(s);
        button(); changed();
      }, function(err){ message('Cannot keep ' + file, '<p>The server did not take it: ' + esc(err && err.message || String(err)) + '</p>'); });
    }
    function askRemove(s){
      message('Remove "' + s.name + '"?', '<p>It leaves the Indicators menu and its settings are forgotten. ' + esc(s.file) +
              ' itself stays where it is.</p>', 'Remove', function(){
        app.post('/scripts', {delete: s.id}).then(function(){
          stop(s); list = list.filter(function(x){ return x !== s; }); app.store.set('script:' + s.id, undefined);
          button(); changed();
        }, function(err){ message('Cannot remove ' + s.name, '<p>' + esc(err && err.message || String(err)) + '</p>'); });
      });
    }
    // a file dropped on the chart
    var wrap = $('wrap');
    if (wrap) {
      var files = function(e){ return e.dataTransfer && Array.prototype.indexOf.call(e.dataTransfer.types || [], 'Files') >= 0; };
      wrap.addEventListener('dragover', function(e){ if (!files(e)) return; e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; wrap.classList.add('drop'); });
      wrap.addEventListener('dragleave', function(e){ if (e.target === wrap || !wrap.contains(e.relatedTarget)) wrap.classList.remove('drop'); });
      wrap.addEventListener('drop', function(e){
        if (!files(e)) return;
        e.preventDefault(); wrap.classList.remove('drop');
        var f = e.dataTransfer.files && e.dataTransfer.files[0]; if (f) load(f);
      });
    }
    function menuItems(){
      var items = [{head: 'My indicators'}];
      list.forEach(function(s){
        items.push({on: s.on, onClick: function(e){ if (e && e.target && e.target.closest && e.target.closest('.rm')) askRemove(s); else toggle(s); },
                    html: '<span class="ck">✓</span><span title="' + esc(tipOf(s)) + '">' + esc(s.name) + '</span>' +
                          (s.on && s.err ? '<span class="tag bad">error</span>' : '') + '<span class="rm" title="Remove from the app">' + ICON.x + '</span>'});
      });
      items.push({html: '<span class="ck"></span>Load indicator…', onClick: pick});
      return items;
    }

    // ------------------------------------------------------------ settings: the script's inputs, and how its outputs show
    function infoFor(s){                                         // what is in the script (also when it fails while running)
      if (s.info) return Promise.resolve(s.info);
      return check(s.source, s.inputs).then(function(m){
        if (m.ok) { s.info = m.info; return m.info; }
        cannot(s.file, s.source, m.error); return null;
      });
    }
    function settings(s){
      infoFor(s).then(function(info){
        if (!info) return;
        var before = {inputs: copy(s.inputs), style: copy(s.style)}, draft = {inputs: copy(s.inputs), style: copy(s.style)}, timer = 0;
        function rerun(){ clearTimeout(timer); timer = setTimeout(function(){ s.inputs = copy(draft.inputs); apply(s); }, 350); }
        function restyle(){ s.style = copy(draft.style); changed(); }
        var styled = info.outs.some(function(sp){ return disp(sp) & 1; }), tabs = [];
        if (info.inputs.length || !styled) tabs.push({name: 'Inputs', render: function(body){ inputsTab(body, info, draft, rerun); }});
        if (styled) tabs.push({name: 'Style', render: function(body){ styleTab(body, info, draft, restyle); }});
        var dlg = UI.dialog({
          title: info.title, tabs: tabs,
          extra: [{html: 'Defaults', onClick: function(){
            draft.inputs = {}; draft.style = {}; rerun(); restyle();
            var on = dlg.el.querySelector('.tabs button.on'), i = on ? +on.getAttribute('data-i') : 0, body = dlg.el.querySelector('.body');
            body.innerHTML = ''; tabs[i].render(body);
          }}],
          onOk: function(){ clearTimeout(timer); s.inputs = draft.inputs; s.style = draft.style; keep(s); apply(s); changed(); },
          onCancel: function(){ clearTimeout(timer); s.inputs = before.inputs; s.style = before.style; apply(s); changed(); }
        });
        dlg.el.classList.add('ind');
      });
    }
    function tip(t){ var i = UI.el('span', 'tip', 'ⓘ'); i.title = t; return i; }
    function inputsTab(body, info, draft, changedFn){
      if (!info.inputs.length) { body.appendChild(UI.el('div', 'none', 'No inputs')); return; }
      var group = '', row = null, inline = '';
      info.inputs.forEach(function(sp){
        if ((sp.group || '') !== group) {                        // a group's heading; after a group, a little room
          body.appendChild(group && !sp.group ? UI.el('div', 'gap') : UI.el('div', 'sect' + (group ? ' next' : ''), esc(sp.group)));
          group = sp.group || ''; inline = '';
        }
        var val = sp.key in draft.inputs ? draft.inputs[sp.key] : sp.def;
        var put = function(v){ if (v === sp.def) delete draft.inputs[sp.key]; else draft.inputs[sp.key] = v; changedFn(); };
        var same = sp.inline && sp.inline === inline && row;
        if (!same) { row = UI.el('div', 'row'); body.appendChild(row); }
        inline = sp.inline || '';
        var label = sp.title || sp.key, ctl;
        if (sp.type === 'bool') {
          var lb = UI.el('label', same ? 'inl' : 'name'), cb = UI.el('input'); cb.type = 'checkbox'; cb.checked = !!val;
          cb.onchange = function(){ put(cb.checked); };
          lb.appendChild(cb); lb.appendChild(document.createTextNode(label)); row.appendChild(lb);
          if (sp.tooltip) row.appendChild(tip(sp.tooltip));
          return;
        }
        row.appendChild(UI.el('span', same ? 'inl' : 'name', esc(label)));
        if (sp.options && sp.options.length) ctl = choose(sp.options.map(function(o){ return [o, String(o)]; }), val, put);
        else if (sp.type === 'int' || sp.type === 'float') ctl = number(sp, val, put);
        else if (sp.type === 'color') ctl = UI.swatch(css(val) || 'rgba(0,0,0,0)', function(v){ put(fromCss(v)); }, colors);
        else if (sp.type === 'source') ctl = choose(SOURCES.map(function(o){ return [o, o]; }), val, put);
        else if (sp.type === 'timeframe') {
          var opts = TFS.slice(); if (!TFS.some(function(o){ return o[0] === val; })) opts.push([val, val]);
          ctl = choose(opts, val, put);
        } else if (sp.type === 'time') {
          ctl = UI.el('input', 'txt'); ctl.type = 'datetime-local'; ctl.value = isFinite(val) ? new Date(val).toISOString().slice(0, 16) : '';
          ctl.onchange = function(){ var t = Date.parse(ctl.value + ':00Z'); if (isFinite(t)) put(t); };
          ctl.title = 'UTC';
        } else if (sp.type === 'text') {
          ctl = UI.el('textarea', 'txt'); ctl.rows = 3; ctl.value = val;
          ctl.onchange = function(){ put(ctl.value); };
        } else {
          ctl = UI.el('input', 'txt'); ctl.type = 'text'; ctl.value = val; ctl.spellcheck = false;
          ctl.onchange = function(){ put(ctl.value); };
        }
        row.appendChild(ctl);
        if (sp.tooltip) row.appendChild(tip(sp.tooltip));
      });
    }
    function choose(opts, val, put){                             // a select whose options keep their types (numbers stay numbers)
      var sel = UI.el('select');
      opts.forEach(function(o, i){ var op = UI.el('option', null, esc(o[1])); op.value = String(i); if (o[0] === val) op.selected = true; sel.appendChild(op); });
      sel.onchange = function(){ put(opts[+sel.value][0]); };
      return sel;
    }
    function number(sp, val, put){
      var inp = UI.el('input', 'num'); inp.type = 'number'; inp.value = String(val);
      if (typeof sp.min === 'number') inp.min = sp.min;
      if (typeof sp.max === 'number') inp.max = sp.max;
      inp.step = typeof sp.step === 'number' && sp.step > 0 ? sp.step : sp.type === 'int' ? 1 : 'any';
      inp.onchange = function(){
        var v = parseFloat(inp.value);
        if (!isFinite(v)) { inp.value = String(val); return; }
        if (sp.type === 'int') v = Math.round(v);
        if (typeof sp.min === 'number' && v < sp.min) v = sp.min;
        if (typeof sp.max === 'number' && v > sp.max) v = sp.max;
        inp.value = String(v); val = v; put(v);
      };
      return inp;
    }
    function styleTab(body, info, draft, changedFn){
      function mod(i, k, v){
        var o = Object.assign({}, draft.style[i]);
        if (v === undefined || v === false) delete o[k]; else o[k] = v;
        if (Object.keys(o).length) draft.style[i] = o; else delete draft.style[i];
        changedFn();
      }
      info.outs.forEach(function(sp, i){
        if (!(disp(sp) & 1)) return;                             // the script keeps it off the chart
        var o = draft.style[i] || {}, row = UI.el('div', 'row'), nm = UI.el('label', 'name'), cb = UI.el('input');
        cb.type = 'checkbox'; cb.checked = !o.hide; cb.onchange = function(){ mod(i, 'hide', !cb.checked); };
        nm.appendChild(cb); nm.appendChild(document.createTextNode(nameOf(sp)));
        row.appendChild(nm);
        var ctl = UI.el('div', 'ctl');
        if ((sp.kind === 'plot' || sp.kind === 'hline') && typeof sp.color === 'number' && sp.color === sp.color)
          ctl.appendChild(UI.swatch(css(typeof o.color === 'number' ? o.color : sp.color), function(v){ mod(i, 'color', fromCss(v)); }, colors));
        else if (sp.kind === 'plot') ctl.appendChild(UI.el('span', 'swatch-gap'));   // (its colors come from the script, bar by bar)
        if (sp.kind === 'plot' || sp.kind === 'hline') {
          var lws = [1, 2, 3, 4], cur = o.lw || sp.lw || 1; if (lws.indexOf(cur) < 0) lws.push(cur);
          ctl.appendChild(choose(lws.map(function(w){ return [w, w + ' px']; }), cur, function(w){ mod(i, 'lw', w === sp.lw ? undefined : w); }));
        }
        if (sp.kind === 'hline' || (sp.kind === 'plot' && /^(line|linebr|step|stepbr)$/.test(sp.style || 'line'))) {
          var dflt = sp.kind === 'hline' ? sp.style : sp.dash || 'solid';
          ctl.appendChild(choose([['solid', 'Solid'], ['dashed', 'Dashed'], ['dotted', 'Dotted']], o.dash || dflt, function(v){ mod(i, 'dash', v === dflt ? undefined : v); }));
        }
        row.appendChild(ctl); body.appendChild(row);
      });
    }

    fetchList();
    return {render: render, update: update, clear: clear, hover: hover, menuItems: menuItems, anyOn: anyOn, load: load,
            list: function(){ return list; }};
  };
})();
