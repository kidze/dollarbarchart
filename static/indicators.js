/* Indicators: lines computed from the bars on screen, switched on and off from the Indicators button in the top bar, like
   TradingView's. The choice is saved with the other settings (data/settings.json through the server).

   For now there is one, the Bitcoin power law exactly as "dacoinminster" posted it on Bitcointalk in February 2013 and
   never refitted since:

       price = 4.41877e-17 x (days since the genesis block, 2009-01-03) ^ 5.59807

   It depends on the date alone, so it is the same curve on dollar bars and on time bars. Every bar gets the value at the
   moment it closed (the forming bar: its newest minute), so a bar's close and the line under it are from the same moment.
   It shows on Bitcoin charts only; on any other chart the switch is remembered and nothing is drawn.
   Exposes window.DBCIndicators(app). */
(function(){
  'use strict';
  var GENESIS = Date.UTC(2009, 0, 3) / 1000, A = 4.41877e-17, N = 5.59807;
  // Gold: apart from the candles' green and red and the drawings' blue, also for color-blind eyes, and light enough
  // that the chart writes its price-axis label in black on it.
  var COLOR = '#E6A820';
  var NAME = 'Power law 2013';
  var $ = UI.$;

  function powerLaw(t){ var d = (t - GENESIS) / 86400; return d > 0 ? A * Math.pow(d, N) : null; }
  function point(r){ return {time: r.t, value: powerLaw(r.e || r.t)}; }
  // 'all:BTC', or one exchange's Bitcoin market priced in dollars ('linear:BTCUSDT', 'spot:BTCUSDC', 'linear:BTCPERP')
  function isBitcoin(key, info){
    return /^[a-z]+:BTC(USDT|USDC|USD|PERP)?$/.test(key) || !!(info && info.key === key && info.ticker === 'BTC');
  }

  window.DBCIndicators = function(app){
    var LC = window.LightweightCharts;
    var on = !!(app.store.get('indicators') || {}).powerLaw2013;
    var line = null, lastT = 0, hovered = null, shown = '';

    function applies(){ return isBitcoin(app.market(), app.marketInfo()); }
    function drop(){ if (line) { app.chart.removeSeries(line); line = null; } lastT = 0; }

    // The legend's second line: the line's value at the bar the first line is about (before any hover: the newest bar).
    function legend(){
      var r = hovered || app.lastBar(), v = line && r ? powerLaw(r.e || r.t) : null;
      var html = !v ? '' : '<i style="background:' + COLOR + '"></i>' + NAME + ' <b>' + app.fmtP(v) + '</b> · ' +
        (hovered ? 'close' : 'price') + ' is <b>' + (r.c / v).toFixed(2) + '×</b> the line';
      if (html !== shown) $('lgInd').innerHTML = shown = html;       // called on every mouse move: write only a change
    }

    // The chart is about to replace its bars: the line lets go of its points first, so the two series never hold
    // different sets of times (the time axis is the union of both).
    function reset(){ if (line) line.setData([]); lastT = 0; }
    // The bars now on the chart (oldest first, the forming bar last).
    function render(rows){
      if (!on || !applies() || !rows.length) { drop(); legend(); return; }
      if (!line) line = app.chart.addSeries(LC.LineSeries, {color: COLOR, lineWidth: 2, priceLineVisible: false,
        lastValueVisible: true, crosshairMarkerVisible: false});
      line.setData(rows.map(point)); lastT = rows[rows.length-1].t;
      legend();
    }
    // One bar the chart just added or changed. Only the newest moves the line: an older bar keeps its close time.
    function update(r){
      if (!line || r.t < lastT) return;
      line.update(point(r)); lastT = r.t;
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
        html: '<span class="ck">✓</span><span title="price = 4.41877e-17 × (days since 2009-01-03) ^ 5.59807, as posted in February 2013">' +
              'Bitcoin power law, 2013 formula</span>' + (applies() ? '' : '<span class="tag">Bitcoin charts only</span>')}]);
    }
    button();

    return {reset: reset, render: render, update: update, clear: clear, hover: hover, menu: menu,
            powerLaw: powerLaw, isBitcoin: isBitcoin};
  };
})();
