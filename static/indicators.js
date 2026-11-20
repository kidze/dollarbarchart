/* Indicators: lines computed from the bars on screen, switched on and off from the Indicators button in the top bar, like
   TradingView's. Each has its own switch; the choices are saved with the other settings (data/settings.json through the
   server).

   There are two, both Bitcoin power laws of the same shape (LIST):

       price = a x (days since the genesis block, 2009-01-03) ^ n

   - "Power law 2013": exactly as "dacoinminster" posted it on Bitcointalk in February 2013 and never refitted since,
     a = 4.41877e-17, n = 5.59807. With it come its multiples at the low and the top of every past cycle.
   - "Power law BlockchainCenter": the fit blockchaincenter.net/bitcoin-power-law showed on 2026-11-20,
     log10(price) = -15.5134 + 5.4066 x log10(days). The site refits its line on the whole price history every day; this
     one is that day's fit, kept fixed. With it comes the site's corridor: its "support" and "top", the 5th and 95th
     percentile of how far the price has been from the line.

   A line depends on the date alone, so it is the same curve on dollar bars and on time bars. Every bar gets the value at
   the moment it closed (the forming bar: its newest minute), so a bar's close and the line under it are from the same
   moment.

   The multiples (levels) are faint lines that run parallel to their line on a log scale, lows solid and tops dashed. They
   are not named on the chart (that made the price axis a wall of words); the menu item's tooltip says what they are.

   They show on Bitcoin charts only; on any other chart the switches are remembered and nothing is drawn.
   Exposes window.DBCIndicators(app). */
(function(){
  'use strict';
  var GENESIS = Date.UTC(2009, 0, 3) / 1000;
  var LIST = [
    // Gold: apart from the candles' green and red and the drawings' blue, also for color-blind eyes, and light enough
    // that the chart writes its price-axis label in black on it. `thin` is for the multiples: thin and faint, the line
    // itself stays the thing to read.
    {id: 'powerLaw2013', name: 'Power law 2013', a: 4.41877e-17, n: 5.59807,
     color: '#E6A820', thin: 'rgba(230,168,32,0.42)',
     tip: 'price = 4.41877e-17 × (days since 2009-01-03) ^ 5.59807, as posted in February 2013. ' +
          'The faint lines are its multiples at past cycle lows (solid: 2015, 2019, 2020, 2022, 2026) and tops (dashed: 2013, 2017, 2021, 2024).',
     // How far from the line the price got at each cycle's low and top: the daily close as a multiple of the line on the
     // day that multiple was the lowest (highest) of the cycle. Coin Metrics daily closes, worked out on 2026-11-12; the
     // month is when the multiple bottomed or topped, which can be after the price did (the line keeps rising under a
     // flat price).
     levels: [
       {k: 0.541, name: 'Aug 2015 low', tag: '2015 low'},
       {k: 0.648, name: 'Nov 2022 low', tag: '2022 low'},
       {k: 0.660, name: 'Jun 2026 low', tag: '2026 low'},
       {k: 0.681, name: 'Mar 2020 low', tag: '2020 low'},
       {k: 0.820, name: 'Feb 2019 low', tag: '2019 low'},
       {k: 2.00,  name: 'Dec 2024 top', tag: '2024 top', top: true},
       {k: 5.21,  name: 'Mar 2021 top', tag: '2021 top', top: true},
       {k: 9.40,  name: 'Dec 2017 top', tag: '2017 top', top: true},
       {k: 15.66, name: 'Nov 2013 top', tag: '2013 top', top: true}
     ]},
    // Light violet: as far from the gold line, the candles and the drawings' blue as a color gets on this chart, for
    // color-blind eyes too (worked out, not eyeballed), and also light enough for a black price-axis label.
    // The numbers are the site's own, read from its page on 2026-11-20 (6,399 daily prices, R² 0.975): intercept and slope
    // of the fit, and the corridor's two offsets in log10.
    {id: 'powerLawBC', name: 'Power law BlockchainCenter', a: Math.pow(10, -15.513437681057946), n: 5.406601360409615,
     color: '#CC9FFF', thin: 'rgba(204,159,255,0.42)',
     tip: 'log10(price) = -15.5134 + 5.4066 × log10(days since 2009-01-03): the fit on blockchaincenter.net on 2026-11-20, kept fixed (the site refits it every day). ' +
          'The faint lines are its corridor: support (solid, 0.37× the line) and top (dashed, 3.51×), the 5th and 95th percentile of the price\'s distance from the line.',
     levels: [
       {k: Math.pow(10, -0.4313367288453278), name: 'Support (5th percentile)', tag: 'support'},
       {k: Math.pow(10, 0.545874799165409),   name: 'Top (95th percentile)',    tag: 'top', top: true}
     ]}
  ];
  var $ = UI.$;

  function value(def, t){ var d = (t - GENESIS) / 86400; return d > 0 ? def.a * Math.pow(d, def.n) : null; }
  // 'all:BTC', or one exchange's Bitcoin market priced in dollars ('linear:BTCUSDT', 'spot:BTCUSDC', 'linear:BTCPERP')
  function isBitcoin(key, info){
    return /^[a-z]+:BTC(USDT|USDC|USD|PERP)?$/.test(key) || !!(info && info.key === key && info.ticker === 'BTC');
  }

  window.DBCIndicators = function(app){
    var LC = window.LightweightCharts;
    var saved = app.store.get('indicators') || {};
    var hovered = null, shown = '';
    var inds = LIST.map(function(def){ return one(def, !!saved[def.id]); });

    function applies(){ return isBitcoin(app.market(), app.marketInfo()); }

    // ------------------------------------------------------------ one indicator: its line, and its multiples
    function one(def, on){
      var lows = def.levels.filter(function(b){ return !b.top; });
      // vals: the line's value at every bar on the chart
      var me = {def: def, on: on, line: null, vals: [], lastT: 0};

      function point(r){ return {time: r.t, value: value(def, r.e || r.t)}; }
      me.drop = function(){
        if (me.line) {
          app.chart.removeSeries(me.line); me.line = null;
          app.chart.applyOptions({});                            // a fresh layout: the price axis drops the line's label at once
        }
        me.vals = []; me.lastT = 0;
      };

      // The multiples are drawn by a primitive on the line's series.
      // Where each multiple leaves the chart on the right: its value and height at the last bar in view.
      me.ends = function(){
        var n = me.vals.length, r = me.line && n ? app.chart.timeScale().getVisibleLogicalRange() : null;
        var i = r ? Math.min(n - 1, Math.floor(r.to)) : -1;
        if (i < 0) return [];
        var h = app.chart.paneSize().height;
        return def.levels.map(function(b){
          var v = me.vals[i] * b.k, y = me.line.priceToCoordinate(v);
          return {k: b.k, name: b.name, tag: b.tag, v: v, y: y, seen: y !== null && y >= 0 && y <= h};
        });
      };
      // Device pixels, so the lines are crisp at any screen scale. Zoomed far out, a few bars share a pixel: every pixel
      // still gets two points, never all 100,000 bars times nine lines.
      function paint(target){
        target.useBitmapCoordinateSpace(function(sc){
          var vals = me.vals, line = me.line, n = vals.length, ts = app.chart.timeScale();
          var r = line && n ? ts.getVisibleLogicalRange() : null;
          if (!r) return;
          var i0 = Math.max(0, Math.floor(r.from)), i1 = Math.min(n - 1, Math.ceil(r.to));
          if (i1 < i0) return;
          var ctx = sc.context, hr = sc.horizontalPixelRatio, vr = sc.verticalPixelRatio, H = sc.mediaSize.height;
          var step = Math.max(1, Math.floor((i1 - i0) / (sc.mediaSize.width * 2))), idx = [], xs = [];
          for (var i = i0; i <= i1; i += step) idx.push(i);
          if (idx[idx.length-1] !== i1) idx.push(i1);
          idx.forEach(function(i){ xs.push(ts.logicalToCoordinate(i)); });
          ctx.lineWidth = Math.max(1, Math.round(hr)); ctx.lineJoin = 'round'; ctx.strokeStyle = def.thin;
          def.levels.forEach(function(b){
            var ya = line.priceToCoordinate(vals[i0] * b.k), yb = line.priceToCoordinate(vals[i1] * b.k);
            if (ya === null || yb === null || ya < -20 || yb > H + 20) return;   // it only rises: all of it is above, or below, the pane
            ctx.setLineDash(b.top ? [6 * hr, 4 * hr] : []);                       // tops dashed, lows solid
            ctx.beginPath();
            for (var j = 0, pen = false; j < idx.length; j++) {
              var x = xs[j], y = line.priceToCoordinate(vals[idx[j]] * b.k);
              if (x === null || y === null) { pen = false; continue; }
              if (pen) ctx.lineTo(x * hr, y * vr); else { ctx.moveTo(x * hr, y * vr); pen = true; }
            }
            ctx.stroke();
          });
          ctx.setLineDash([]);
        });
      }
      var renderer = {draw: paint};
      var paneViews = [{zOrder: function(){ return 'normal'; }, renderer: function(){ return renderer; }}];
      var primitive = {
        updateAllViews: function(){},
        paneViews: function(){ return paneViews; },
        // Auto scale makes room for the lows where they leave the chart on the right, next to the line itself (in a bear
        // market they sit just under the price). Not for all of their length: further left they are lower and would only
        // add empty space. The tops do not count at all: up to 16 times higher, they would squeeze the candles flat.
        autoscaleInfo: function(from, to){
          var i0 = Math.max(0, Math.ceil(from)), i1 = Math.min(me.vals.length - 1, Math.floor(to));
          return i1 < i0 || !lows.length ? null
            : {priceRange: {minValue: me.vals[i1] * lows[0].k, maxValue: me.vals[i1] * lows[lows.length-1].k}};
        }
      };

      me.value = function(t){ return value(def, t); };
      me.reset = function(){ if (me.line) me.line.setData([]); me.vals = []; me.lastT = 0; };
      me.render = function(rows){
        if (!me.on || !applies() || !rows.length) { me.drop(); return; }
        if (!me.line) {
          me.line = app.chart.addSeries(LC.LineSeries, {color: def.color, lineWidth: 2, priceLineVisible: false,
            lastValueVisible: true, crosshairMarkerVisible: false});
          me.line.attachPrimitive(primitive);
        }
        var pts = rows.map(point);
        me.vals = pts.map(function(p){ return p.value; }); me.lastT = rows[rows.length-1].t;
        me.line.setData(pts);
      };
      // Only the newest bar moves the line: an older bar keeps its close time.
      me.update = function(r){
        if (!me.line || r.t < me.lastT) return;
        var p = point(r);
        if (r.t === me.lastT) me.vals[me.vals.length-1] = p.value; else me.vals.push(p.value);
        me.lastT = r.t; me.line.update(p);
      };
      return me;
    }

    // ------------------------------------------------------------ legend: one row under the bar's own
    // Every line's value at the bar the legend is about (before any hover: the newest bar).
    function legend(){
      var r = hovered || app.lastBar(), html = '';
      inds.forEach(function(o){
        var v = o.line && r ? o.value(r.e || r.t) : null;
        if (v) html += '<span><i style="background:' + o.def.color + '"></i>' + o.def.name +
                       ' <b style="color:' + o.def.color + '">' + app.fmtP(v) + '</b></span>';
      });
      if (html !== shown) $('lgInd').innerHTML = shown = html;       // called on every mouse move: write only a change
    }

    // ------------------------------------------------------------ what app.js calls
    // The chart is about to replace its bars: the lines let go of their points first, so no two series ever hold
    // different sets of times (the time axis is the union of them all).
    function reset(){ inds.forEach(function(o){ o.reset(); }); }
    // The bars now on the chart (oldest first, the forming bar last).
    function render(rows){ inds.forEach(function(o){ o.render(rows); }); legend(); }
    // One bar the chart just added or changed.
    function update(r){ inds.forEach(function(o){ o.update(r); }); if (!hovered) legend(); }
    function clear(){ hovered = null; inds.forEach(function(o){ o.drop(); }); legend(); }   // another market is loading
    function hover(r){ hovered = r || null; legend(); }             // null: the mouse left the bars, back to the newest

    function button(){ $('bInd').className = 'tb' + (inds.some(function(o){ return o.on; }) ? ' on' : ''); }
    function toggle(o){
      o.on = !o.on;
      var all = {}; inds.forEach(function(x){ all[x.def.id] = x.on; });
      app.store.set('indicators', all);
      button(); o.reset(); o.render(app.rows()); legend();
    }
    function menu(anchor){
      var note = applies() ? '' : '<span class="tag">Bitcoin only</span>';
      UI.menu(anchor, [{head: 'Indicators'}].concat(inds.map(function(o){
        return {on: o.on, onClick: function(){ toggle(o); },
                html: '<span class="ck">✓</span><span title="' + o.def.tip + '">' + o.def.name + '</span>' + note};
      })));
    }
    button();

    return {reset: reset, render: render, update: update, clear: clear, hover: hover, menu: menu,
            isBitcoin: isBitcoin, list: inds};
  };
})();
