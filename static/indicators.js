/* Indicators: lines computed from the bars on screen, switched on and off from the Indicators button in the top bar, like
   TradingView's. The choice is saved with the other settings (data/settings.json through the server).

   For now there is one, the Bitcoin power law exactly as "dacoinminster" posted it on Bitcointalk in February 2013 and
   never refitted since:

       price = 4.41877e-17 x (days since the genesis block, 2009-01-03) ^ 5.59807

   It depends on the date alone, so it is the same curve on dollar bars and on time bars. Every bar gets the value at the
   moment it closed (the forming bar: its newest minute), so a bar's close and the line under it are from the same moment.

   With it come its multiples at the low and the top of every past cycle (LEVELS): thinner lines that run parallel to it
   on a log scale, each named on the price axis where it leaves the chart. The legend says between which two the price is.

   It shows on Bitcoin charts only; on any other chart the switch is remembered and nothing is drawn.
   Exposes window.DBCIndicators(app). */
(function(){
  'use strict';
  var GENESIS = Date.UTC(2009, 0, 3) / 1000, A = 4.41877e-17, N = 5.59807;
  // Gold: apart from the candles' green and red and the drawings' blue, also for color-blind eyes, and light enough
  // that the chart writes its price-axis label in black on it.
  var COLOR = '#E6A820';
  var THIN = 'rgba(230,168,32,0.8)', CHIP = '#33290d', INK = '#F5C65A';   // the multiples: thinner lines, quieter axis labels
  var NAME = 'Power law 2013';
  // How far from the line the price got at each cycle's low and top: the daily close as a multiple of the line on the day
  // that multiple was the lowest (highest) of the cycle. Coin Metrics daily closes, worked out on 2026-11-12; the month is
  // when the multiple bottomed or topped, which can be after the price did (the line keeps rising under a flat price).
  var LEVELS = [
    {k: 0.541, name: 'Aug 2015 low', tag: '2015 low'},
    {k: 0.648, name: 'Nov 2022 low', tag: '2022 low'},
    {k: 0.660, name: 'Jun 2026 low', tag: '2026 low'},
    {k: 0.681, name: 'Mar 2020 low', tag: '2020 low'},
    {k: 0.820, name: 'Feb 2019 low', tag: '2019 low'},
    {k: 2.00,  name: 'Dec 2024 top', tag: '2024 top', top: true},
    {k: 5.21,  name: 'Mar 2021 top', tag: '2021 top', top: true},
    {k: 9.40,  name: 'Dec 2017 top', tag: '2017 top', top: true},
    {k: 15.66, name: 'Nov 2013 top', tag: '2013 top', top: true}
  ];
  var LOWS = LEVELS.filter(function(b){ return !b.top; });
  var LADDER = LEVELS.concat([{k: 1, name: 'the line'}]).sort(function(a, b){ return a.k - b.k; });
  var $ = UI.$;

  function powerLaw(t){ var d = (t - GENESIS) / 86400; return d > 0 ? A * Math.pow(d, N) : null; }
  function point(r){ return {time: r.t, value: powerLaw(r.e || r.t)}; }
  // 'all:BTC', or one exchange's Bitcoin market priced in dollars ('linear:BTCUSDT', 'spot:BTCUSDC', 'linear:BTCPERP')
  function isBitcoin(key, info){
    return /^[a-z]+:BTC(USDT|USDC|USD|PERP)?$/.test(key) || !!(info && info.key === key && info.ticker === 'BTC');
  }
  function times(k){ return (k >= 10 ? k.toFixed(1) : k.toFixed(2)) + '×'; }

  window.DBCIndicators = function(app){
    var LC = window.LightweightCharts;
    var on = !!(app.store.get('indicators') || {}).powerLaw2013;
    var line = null, vals = [], lastT = 0, hovered = null, shown = '';   // vals: the line's value at every bar on the chart

    function applies(){ return isBitcoin(app.market(), app.marketInfo()); }
    function drop(){
      if (line) {
        app.chart.removeSeries(line); line = null;
        app.chart.applyOptions({});                              // a fresh layout: the price axis, widened for the level names, goes back to its width at once
      }
      vals = []; lastT = 0;
    }

    // ------------------------------------------------------------ the multiples: drawn by a primitive on the line's series
    // Where each multiple leaves the chart on the right: its value and height at the last bar in view (what its axis label shows).
    function ends(){
      var n = vals.length, r = line && n ? app.chart.timeScale().getVisibleLogicalRange() : null;
      var i = r ? Math.min(n - 1, Math.floor(r.to)) : -1;
      if (i < 0) return [];
      var h = app.chart.paneSize().height;
      return LEVELS.map(function(b){
        var v = vals[i] * b.k, y = line.priceToCoordinate(v);
        return {k: b.k, name: b.name, tag: b.tag, v: v, y: y, seen: y !== null && y >= 0 && y <= h};
      });
    }
    // Device pixels, so the lines are crisp at any screen scale. Zoomed far out, a few bars share a pixel: every pixel still
    // gets two points, never all 100,000 bars times nine lines.
    function paint(target){
      target.useBitmapCoordinateSpace(function(sc){
        var n = vals.length, ts = app.chart.timeScale(), r = line && n ? ts.getVisibleLogicalRange() : null;
        if (!r) return;
        var i0 = Math.max(0, Math.floor(r.from)), i1 = Math.min(n - 1, Math.ceil(r.to));
        if (i1 < i0) return;
        var ctx = sc.context, hr = sc.horizontalPixelRatio, vr = sc.verticalPixelRatio, H = sc.mediaSize.height;
        var step = Math.max(1, Math.floor((i1 - i0) / (sc.mediaSize.width * 2))), idx = [], xs = [];
        for (var i = i0; i <= i1; i += step) idx.push(i);
        if (idx[idx.length-1] !== i1) idx.push(i1);
        idx.forEach(function(i){ xs.push(ts.logicalToCoordinate(i)); });
        ctx.lineWidth = Math.max(1, Math.round(hr)); ctx.lineJoin = 'round'; ctx.strokeStyle = THIN;
        LEVELS.forEach(function(b){
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
    var now = [], renderer = {draw: paint};
    var paneViews = [{zOrder: function(){ return 'normal'; }, renderer: function(){ return renderer; }}];
    var axisViews = LEVELS.map(function(b, i){                    // the chart keeps views by identity: always this same array
      return {
        coordinate: function(){ return now[i] && now[i].y !== null ? now[i].y : -100; },
        text: function(){ return now[i] ? app.fmtP(now[i].v) + '  ' + b.tag : ''; },
        textColor: function(){ return INK; },
        backColor: function(){ return CHIP; },
        visible: function(){ return !!(now[i] && now[i].seen); },  // off screen: hide it (the chart would pin it to the axis edge)
        tickVisible: function(){ return true; }
      };
    });
    var primitive = {
      updateAllViews: function(){},
      paneViews: function(){ return paneViews; },
      priceAxisViews: function(){ now = ends(); return axisViews; },
      // Auto scale makes room for the lows where they leave the chart on the right, next to the line itself (in a bear
      // market they sit just under the price). Not for all of their length: further left they are lower and would only
      // add empty space. The tops do not count at all: up to 16 times higher, they would squeeze the candles flat.
      autoscaleInfo: function(from, to){
        var i0 = Math.max(0, Math.ceil(from)), i1 = Math.min(vals.length - 1, Math.floor(to));
        return i1 < i0 ? null : {priceRange: {minValue: vals[i1] * LOWS[0].k, maxValue: vals[i1] * LOWS[LOWS.length-1].k}};
      }
    };

    // ------------------------------------------------------------ legend: two more lines under the bar's own
    // The line's value at the bar the legend is about (before any hover: the newest bar), the close as a multiple of it,
    // and the two levels that multiple sits between.
    function between(q, v){
      var lo = null, hi = null;
      LADDER.forEach(function(b){ if (b.k <= q) lo = b; else if (!hi) hi = b; });
      function say(b){ return b.k === 1 ? 'the line' : '<b>' + times(b.k) + '</b> ' + b.name + ' (' + app.fmtP(v * b.k) + ')'; }
      return lo && hi ? 'between ' + say(lo) + ' and ' + say(hi) : lo ? 'above ' + say(lo) : 'below ' + say(hi);
    }
    function legend(){
      var r = hovered || app.lastBar(), v = line && r ? powerLaw(r.e || r.t) : null;
      var html = !v ? '' : '<i style="background:' + COLOR + '"></i>' + NAME + ' <b>' + app.fmtP(v) + '</b> · ' +
        (hovered ? 'close' : 'price') + ' is <b>' + (r.c / v).toFixed(2) + '×</b> the line<div class="sub">' + between(r.c / v, v) + '</div>';
      if (html !== shown) $('lgInd').innerHTML = shown = html;       // called on every mouse move: write only a change
    }

    // ------------------------------------------------------------ what app.js calls
    // The chart is about to replace its bars: the line lets go of its points first, so the two series never hold
    // different sets of times (the time axis is the union of both).
    function reset(){ if (line) line.setData([]); vals = []; lastT = 0; }
    // The bars now on the chart (oldest first, the forming bar last).
    function render(rows){
      if (!on || !applies() || !rows.length) { drop(); legend(); return; }
      if (!line) {
        line = app.chart.addSeries(LC.LineSeries, {color: COLOR, lineWidth: 2, priceLineVisible: false,
          lastValueVisible: true, crosshairMarkerVisible: false});
        line.attachPrimitive(primitive);
      }
      var pts = rows.map(point);
      vals = pts.map(function(p){ return p.value; }); lastT = rows[rows.length-1].t;
      line.setData(pts);
      legend();
    }
    // One bar the chart just added or changed. Only the newest moves the line: an older bar keeps its close time.
    function update(r){
      if (!line || r.t < lastT) return;
      var p = point(r);
      if (r.t === lastT) vals[vals.length-1] = p.value; else vals.push(p.value);
      lastT = r.t; line.update(p);
      if (!hovered) legend();
    }
    function clear(){ hovered = null; drop(); legend(); }           // another market is loading
    function hover(r){ hovered = r; legend(); }

    function button(){ $('bInd').className = 'tb' + (on ? ' on' : ''); }
    function toggle(){
      on = !on; app.store.set('indicators', {powerLaw2013: on});
      button(); reset(); render(app.rows());
    }
    function menu(anchor){
      UI.menu(anchor, [{on: on, onClick: toggle,
        html: '<span class="ck">✓</span><span title="price = 4.41877e-17 × (days since 2009-01-03) ^ 5.59807, as posted in February 2013, ' +
              'and its multiples at the low and the top of every cycle since">Bitcoin power law, 2013 formula, with past cycle lows and tops</span>' +
              (applies() ? '' : '<span class="tag">Bitcoin charts only</span>')}]);
    }
    button();

    return {reset: reset, render: render, update: update, clear: clear, hover: hover, menu: menu,
            powerLaw: powerLaw, isBitcoin: isBitcoin, ends: ends, LEVELS: LEVELS};
  };
})();
