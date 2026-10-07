/* Chart settings, like TradingView's: Symbol tab (candle body / borders / wick, each on/off with up and down colors) and
   Canvas tab (background, solid or gradient). Every color has an opacity. Changes preview live; Ok keeps them (saved in
   data/settings.json through the server), Cancel puts the chart back. Exposes window.DBCSettings(app). */
(function(){
  'use strict';
  var UP = 'rgba(46,189,133,1)', DN = 'rgba(242,54,69,1)', BG = 'rgba(11,12,14,1)';
  var DEFAULTS = {
    body:   {show:true,  up:UP, down:DN},
    border: {show:false, up:UP, down:DN},
    wick:   {show:true,  up:UP, down:DN},
    bg:     {type:'solid', color:BG, top:'rgba(19,23,34,1)', bottom:BG}
  };
  var NONE = 'rgba(0,0,0,0)';
  function copy(o){ return JSON.parse(JSON.stringify(o)); }
  function merge(def, got){                                     // saved values over defaults, ignoring anything malformed
    var out = copy(def);
    if (!got || typeof got !== 'object') return out;
    Object.keys(out).forEach(function(k){
      var g = got[k]; if (!g || typeof g !== 'object') return;
      Object.keys(out[k]).forEach(function(f){
        if (typeof g[f] === typeof out[k][f] && (typeof g[f] !== 'string' || f === 'type' || UI.parse(g[f]))) out[k][f] = g[f];
      });
    });
    if (out.bg.type !== 'solid' && out.bg.type !== 'gradient') out.bg.type = 'solid';
    return out;
  }

  window.DBCSettings = function(app){
    var look = merge(DEFAULTS, app.store.get('appearance')), shown = look, lineNow = null;

    // The chart draws the last-price line and its axis label in the newest candle's body color. With the body hidden (or
    // nearly see-through) they would vanish, so then they get that color solid. Called again whenever the newest bar changes.
    function priceLine(){
      var b = app.lastBar(), want = '';
      if (b) {
        var c = UI.parse(b.c >= b.o ? shown.body.up : shown.body.down);
        if (c && (!shown.body.show || c.a < 0.2)) want = 'rgb(' + c.r + ',' + c.g + ',' + c.b + ')';
      }
      if (want !== lineNow) { lineNow = want; app.series.applyOptions({priceLineColor: want}); }
    }
    function apply(l){
      shown = l;
      document.getElementById('chart').style.background = l.bg.type === 'gradient'   // the chart is whole even pixels: its box
        ? 'linear-gradient(' + l.bg.top + ',' + l.bg.bottom + ')' : l.bg.color;        // shows round its edges in the same color
      app.chart.applyOptions({layout:{background: l.bg.type === 'gradient'
        ? {type:'gradient', topColor:l.bg.top, bottomColor:l.bg.bottom} : {type:'solid', color:l.bg.color}}});
      app.series.applyOptions({
        upColor: l.body.show ? l.body.up : NONE, downColor: l.body.show ? l.body.down : NONE,
        borderVisible: l.border.show, borderUpColor: l.border.up, borderDownColor: l.border.down,
        wickVisible: l.wick.show, wickUpColor: l.wick.up, wickDownColor: l.wick.down
      });
      priceLine();
    }
    apply(look);

    var colors = {get: function(){ return app.store.get('customColors') || []; }, set: function(list){ app.store.set('customColors', list); }};

    function open(){
      var draft = copy(look), swatches = [];
      function preview(){ apply(draft); }
      function candleRow(body, name, part){
        var row = UI.el('div', 'row');
        var nm = UI.el('label', 'name'), cb = UI.el('input'); cb.type = 'checkbox'; cb.checked = draft[part].show;
        nm.appendChild(cb); nm.appendChild(document.createTextNode(name));
        var ctl = UI.el('div', 'ctl');
        var up = UI.swatch(draft[part].up, function(v){ draft[part].up = v; preview(); }, colors);
        var dn = UI.swatch(draft[part].down, function(v){ draft[part].down = v; preview(); }, colors);
        up.title = name + ' of rising bars'; dn.title = name + ' of falling bars';
        function enable(){ up.disabled = dn.disabled = !cb.checked; }
        cb.onchange = function(){ draft[part].show = cb.checked; enable(); preview(); };
        enable();
        ctl.appendChild(up); ctl.appendChild(dn);
        row.appendChild(nm); row.appendChild(ctl); body.appendChild(row);
        swatches.push(function(){ cb.checked = draft[part].show; up.set(draft[part].up); dn.set(draft[part].down); enable(); });
      }
      var tabs = [
        {name:'Symbol', render: function(body){
          swatches = [];
          body.appendChild(UI.el('div', 'sect', 'Candles'));
          candleRow(body, 'Body', 'body'); candleRow(body, 'Borders', 'border'); candleRow(body, 'Wick', 'wick');
        }},
        {name:'Canvas', render: function(body){
          swatches = [];
          body.appendChild(UI.el('div', 'sect', 'Chart basic styles'));
          var row = UI.el('div', 'row'), ctl = UI.el('div', 'ctl');
          row.appendChild(UI.el('span', 'name', 'Background'));
          var sel = UI.el('select', null, '<option value="solid">Solid</option><option value="gradient">Gradient</option>');
          sel.value = draft.bg.type;
          var one = UI.swatch(draft.bg.color, function(v){ draft.bg.color = v; preview(); }, colors);
          var top = UI.swatch(draft.bg.top, function(v){ draft.bg.top = v; preview(); }, colors);
          var bot = UI.swatch(draft.bg.bottom, function(v){ draft.bg.bottom = v; preview(); }, colors);
          top.title = 'Top'; bot.title = 'Bottom';
          function shape(){ var g = draft.bg.type === 'gradient'; one.style.display = g ? 'none' : ''; top.style.display = bot.style.display = g ? '' : 'none'; }
          sel.onchange = function(){ draft.bg.type = sel.value; shape(); preview(); };
          [sel, one, top, bot].forEach(function(x){ ctl.appendChild(x); });
          row.appendChild(ctl); body.appendChild(row); shape();
          swatches.push(function(){ sel.value = draft.bg.type; one.set(draft.bg.color); top.set(draft.bg.top); bot.set(draft.bg.bottom); shape(); });
        }}
      ];
      UI.dialog({
        title: 'Settings', tabs: tabs,
        extra: [{html: 'Reset settings', onClick: function(){ draft = copy(DEFAULTS); swatches.forEach(function(f){ f(); }); preview(); }}],
        onOk: function(){ look = draft; apply(look); app.store.set('appearance', look); },
        onCancel: function(){ apply(look); }
      });
    }

    return {open: open, apply: function(){ apply(look); }, look: function(){ return look; }, priceLine: priceLine, DEFAULTS: DEFAULTS};
  };
})();
