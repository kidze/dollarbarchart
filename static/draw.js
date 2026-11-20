/* Drawing tools, TradingView style: the trend line and the rectangle.

   Draw: pick the tool (left toolbar, Alt+T for the line, Alt+Shift+R for the rectangle), then click two points, or press,
   drag and release. Holding Shift keeps a line horizontal and makes a rectangle a square (while placing it or dragging an
   end or corner; while moving a whole drawing, Shift keeps the move straight across or straight up and down). Hover a
   drawing to see its grips; click to select it; drag it to move it, or a grip to reshape it (a rectangle has eight: a
   corner moves two sides, a side's middle moves that side); Delete removes it; double-click (or the gear) opens its
   settings; Ctrl+Z / Ctrl+Y undo and redo; Esc cancels. The floating toolbar of the selected drawing changes color (with
   opacity), width and style. A rectangle with a background is picked up anywhere inside it, one without by its border.

   Magnet (left toolbar): while a point is being placed or a grip dragged, its price snaps to the open, high, low or close
   of the bar under the mouse when the mouse is within MAGNET pixels of it (TradingView's weak magnet); a small ring shows
   where it caught. Holding Ctrl flips the magnet for as long as it is held.

   Drawings are kept per market and anchored by time + price, so they sit on the same moments whatever bar size or time
   frame is shown (the x-axis is bar order, app.timeToLogical places a time on it). They are saved to data/drawings.json
   through the server a moment after each change. Drawn by a Lightweight Charts series primitive. Exposes window.DBCDraw(app).

   Mouse handling: a capture-phase mousedown on the chart's container. When the press lands on a drawing (or a drawing tool
   is active) it is cancelled before the chart sees it, so the chart does not pan, while the chart still gets mousemove and
   keeps its crosshair on the mouse during the drag. Presses on empty chart go through untouched (pan, zoom). */
(function(){
  'use strict';
  var HIT = 6, HANDLE = 5.5, DRAG_MIN = 4;                       // px: hit distance, handle radius, a press that moves less is a click
  var MAGNET = 10;                                               // px: how near a bar's open, high, low or close the mouse must be to snap
  // The kinds of drawing: each is two points {t, p} and a style. A new one starts from the last style used for its kind.
  // The rectangle's colors are TradingView's own defaults for it.
  var TYPES = {
    trendline: {name: 'Trend line', base: {color:'rgba(41,98,255,1)', width:2, dash:0, extL:false, extR:false, mid:false, labels:false, stats:false}},
    rectangle: {name: 'Rectangle',  base: {color:'rgba(156,39,176,1)', width:1, dash:0, fill:true, bg:'rgba(156,39,176,0.2)', extL:false, extR:false}}
  };
  var DASHES = [[], [7, 5], [2, 3]];                             // solid, dashed, dotted (scaled by width)
  var $ = UI.$;

  window.DBCDraw = function(app){
    var chart = app.chart, series = app.series, ts = chart.timeScale(), store = app.store, host = $('chart');
    var ui = Object.assign({stay:false, lock:false, hide:false, magnet:false, dtb:null}, store.get('drawUi') || {});
    var defaults = {};
    Object.keys(TYPES).forEach(function(k){ defaults[k] = Object.assign({}, TYPES[k].base, (store.get('drawDefaults') || {})[k] || {}); });
    var items = [];
    var tool = 'cursor', selected = null, hover = null, placing = null, drag = null, shift = false, ctrl = false, lastMove = null;
    var mark = null;                                             // the point the magnet caught, shown as a ring while placing or reshaping
    var undo = [], redo = [], lastDown = null;
    var colors = {get: function(){ return store.get('customColors') || []; }, set: function(l){ store.set('customColors', l); }};

    // ------------------------------------------------------------ geometry: anchors {t, p} <-> pane pixels
    function paneH(){ return chart.paneSize().height; }            // the chart's own size (its box can be a pixel or two taller)
    function xOf(l){                                             // the chart maps only whole bar numbers to x (a fraction gives 0)
      var f = Math.floor(l), x0 = ts.logicalToCoordinate(f);
      if (x0 === null || l === f) return x0;
      var x1 = ts.logicalToCoordinate(f + 1); return x1 === null ? null : x0 + (l - f) * (x1 - x0);
    }
    function toPx(pt){
      if (!(pt.p > 0) && chart.priceScale('right').options().mode === 1) return null;   // no place for it on a log scale
      var l = app.timeToLogical(pt.t); if (l === null) return null;
      var x = xOf(l), y = series.priceToCoordinate(pt.p);
      return x === null || y === null ? null : {x:x, y:y, l:l};
    }
    function toAnchor(x, y){                                     // ends sit on bars (or bar slots past the last bar), like TradingView
      var l = ts.coordinateToLogical(x), p = series.coordinateToPrice(y);   // coordinateToLogical already rounds to a whole bar
      if (l === null || p === null) return null;
      var t = app.logicalToTime(Math.round(l)); return t === null ? null : {t:t, p:p};
    }
    // The magnet (weak, like TradingView's): the anchor under the mouse, its price moved onto the open, high, low or close
    // of the bar under the mouse when one of them is within MAGNET pixels. Ctrl flips the toolbar's switch while held.
    function magnetOn(){ return !!ui.magnet !== ctrl; }
    function anchorAt(x, y, plain){                              // plain: no snapping (Shift rules decide the price, or it is not used)
      var a = toAnchor(x, y); mark = null;
      if (!a || plain || !magnetOn()) return a;
      var l = ts.coordinateToLogical(x), r = l === null ? null : app.rows()[Math.round(l)];
      if (!r) return a;                                          // past the newest bar: nothing to snap to
      var best = null, near = MAGNET;
      [r.o, r.h, r.l, r.c].forEach(function(v){
        var yv = series.priceToCoordinate(v), dist = yv === null ? Infinity : Math.abs(yv - y);
        if (dist <= near) { near = dist; best = v; }
      });
      if (best !== null) { a.p = best; mark = {t: a.t, p: best}; }
      return a;
    }
    function squared(p, f){                                      // Shift on a rectangle: a square on screen, from its fixed corner f
      if (!f) return p;
      var dx = p.x - f.x, dy = p.y - f.y, s = Math.max(Math.abs(dx), Math.abs(dy));
      return {x: f.x + (dx < 0 ? -s : s), y: f.y + (dy < 0 ? -s : s)};
    }
    // A rectangle on screen: its box (an extended side runs to the pane's edge) and its eight grips. A grip names the end
    // whose time it moves (hx) and the end whose price it moves (hy): a corner has both, the middle of a side has one.
    function box(a, b, s, w){
      var x0 = Math.min(a.x, b.x), x1 = Math.max(a.x, b.x);
      return {x0: s.extL ? Math.min(0, x0) : x0, x1: s.extR ? Math.max(w, x1) : x1, y0: Math.min(a.y, b.y), y1: Math.max(a.y, b.y)};
    }
    function grips(a, b){
      var mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      return [{x:a.x, y:a.y, hx:0, hy:0}, {x:b.x, y:b.y, hx:1, hy:1}, {x:a.x, y:b.y, hx:0, hy:1}, {x:b.x, y:a.y, hx:1, hy:0},
              {x:a.x, y:my, hx:0, hy:null}, {x:b.x, y:my, hx:1, hy:null}, {x:mx, y:a.y, hx:null, hy:0}, {x:mx, y:b.y, hx:null, hy:1}];
    }
    // The mouse cursor over a rectangle's grip g: arrows the way it moves. A side's middle goes up-down or left-right; a
    // corner goes along its diagonal, which depends on where it sits on screen (the two ends can be any two opposite corners).
    function gripCursor(d, g){
      if (g.hx === null) return 'ns-resize';
      if (g.hy === null) return 'ew-resize';
      var a = toPx(d.points[0]), b = toPx(d.points[1]); if (!a || !b) return 'move';
      var e = [a, b], right = e[g.hx].x >= e[1 - g.hx].x, low = e[g.hy].y >= e[1 - g.hy].y;
      return right === low ? 'nwse-resize' : 'nesw-resize';      // bottom right and top left share one diagonal
    }
    function segDist(px, py, a, b){
      var dx = b.x - a.x, dy = b.y - a.y, len = dx*dx + dy*dy, u = len ? ((px - a.x)*dx + (py - a.y)*dy) / len : 0;
      u = Math.max(0, Math.min(1, u)); var x = a.x + u*dx - px, y = a.y + u*dy - py; return Math.sqrt(x*x + y*y);
    }
    function span(a, b, s, w, h){                                // the drawn segment, stretched to the pane edges on extended sides
      var dx = b.x - a.x, dy = b.y - a.y;
      if (!dx && !dy) return [a, b];
      function stretch(p, dirx, diry){
        var k = Infinity;
        if (dirx > 0) k = Math.min(k, (w - p.x) / dirx); else if (dirx < 0) k = Math.min(k, -p.x / dirx);
        if (diry > 0) k = Math.min(k, (h - p.y) / diry); else if (diry < 0) k = Math.min(k, -p.y / diry);
        if (!isFinite(k) || k < 0) k = 0;
        return {x: p.x + dirx*k, y: p.y + diry*k};
      }
      return [s.extL ? stretch(a, -dx, -dy) : a, s.extR ? stretch(b, dx, dy) : b];
    }
    // What is under the mouse: {d, part}. part is 0 or 1 (a line's end), a rectangle's grip {hx, hy}, 'line' (the line, or
    // a rectangle's border) or 'fill' (inside a rectangle that has a background). Lines, borders and grips come first,
    // whatever the stacking: a line inside a filled rectangle can still be picked up.
    function hitAt(x, y){
      if (ui.hide) return null;
      var w = ts.width(), h = paneH(), inside = null;
      for (var i = items.length - 1; i >= 0; i--) {
        var d = items[i], a = toPx(d.points[0]), b = toPx(d.points[1]);
        if (!a || !b) continue;
        if (d.type === 'rectangle') {
          if (d === selected || d === hover) {
            var g = grips(a, b);
            for (var k = 0; k < g.length; k++) if (Math.hypot(x - g[k].x, y - g[k].y) <= HANDLE + 3) return {d:d, part:{hx:g[k].hx, hy:g[k].hy}};
          }
          var r = box(a, b, d.style, w);
          if (x < r.x0 - HIT || x > r.x1 + HIT || y < r.y0 - HIT || y > r.y1 + HIT) continue;
          if (Math.abs(x - r.x0) <= HIT || Math.abs(x - r.x1) <= HIT || Math.abs(y - r.y0) <= HIT || Math.abs(y - r.y1) <= HIT) return {d:d, part:'line'};
          if (d.style.fill && !inside) inside = {d:d, part:'fill'};
          continue;
        }
        if (d === selected || d === hover) {
          if (Math.hypot(x - a.x, y - a.y) <= HANDLE + 3) return {d:d, part:0};
          if (Math.hypot(x - b.x, y - b.y) <= HANDLE + 3) return {d:d, part:1};
        }
        var sp = span(a, b, d.style, w, h);
        if (segDist(x, y, sp[0], sp[1]) <= HIT) return {d:d, part:'line'};
      }
      return inside;
    }

    // ------------------------------------------------------------ painting (a series primitive: above the candles, under the crosshair)
    function fmtDur(sec){
      var s = Math.abs(sec), d = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600), m = Math.round(s % 3600 / 60);
      return d ? d + 'd' + (h ? ' ' + h + 'h' : '') : h ? h + 'h' + (m ? ' ' + m + 'm' : '') : m + 'm';
    }
    function fontPx(){ return chart.options().layout.fontSize || 12; }
    function roundRect(ctx, x, y, w, h, r){ ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath(); }
    function label(ctx, size, text, x, y, bg, fg, alignRight, above){
      ctx.font = '600 ' + Math.round(fontPx() * 0.92) + 'px -apple-system,"Segoe UI",Inter,Roboto,sans-serif';
      var lines = String(text).split('\n'), lh = fontPx() * 1.25, pad = 5;
      var w = Math.max.apply(null, lines.map(function(t){ return ctx.measureText(t).width; })) + pad*2, hh = lines.length * lh + pad;
      var bx = alignRight ? x - w - 8 : x + 8, by = above ? y - hh - 8 : y + 8;
      bx = Math.max(2, Math.min(size.width - w - 2, bx)); by = Math.max(2, Math.min(size.height - hh - 2, by));   // an end near the edge: the box stays inside
      ctx.fillStyle = bg; roundRect(ctx, bx, by, w, hh, 4); ctx.fill();
      ctx.fillStyle = fg; ctx.textBaseline = 'top';
      lines.forEach(function(t, i){ ctx.fillText(t, bx + pad, by + pad*0.6 + i*lh + (lh - fontPx())/2); });
    }
    function shapes(size){                                       // what to draw this frame, in CSS pixels
      if (ui.hide) return [];
      var all = placing ? items.concat([placing.d]) : items, out = [];
      all.forEach(function(d){
        var a = toPx(d.points[0]), b = toPx(d.points[1]); if (!a || !b) return;
        var c = UI.parse(d.style.color) || {r:41,g:98,b:255,a:1};
        out.push({d:d, a:a, b:b, solid:'rgb(' + c.r + ',' + c.g + ',' + c.b + ')',
                  sp: d.type === 'rectangle' ? null : span(a, b, d.style, size.width, size.height),
                  box: d.type === 'rectangle' ? box(a, b, d.style, size.width) : null,
                  ink: (c.r*299 + c.g*587 + c.b*114) / 1000 > 150 ? '#111' : '#fff',
                  hot: d === selected || d === hover || (placing && placing.d === d)});
      });
      return out;
    }
    function handleFill(){
      var bg = app.settings ? app.settings.look().bg : null, c = UI.parse(bg ? (bg.type === 'gradient' ? bg.bottom : bg.color) : '#0b0c0e');
      return c ? 'rgb(' + c.r + ',' + c.g + ',' + c.b + ')' : '#0b0c0e';
    }
    function grip(ctx, hr, vr, p, fill, stroke, square){         // a round grip (a line's end, a corner) or a square one (a side's middle)
      var r = HANDLE * hr;
      ctx.beginPath();
      if (square) ctx.rect(p.x * hr - r * 0.85, p.y * vr - r * 0.85, r * 1.7, r * 1.7); else ctx.arc(p.x * hr, p.y * vr, r, 0, 2*Math.PI);
      ctx.fillStyle = fill; ctx.fill(); ctx.lineWidth = Math.max(1, Math.round(1.5 * hr)); ctx.strokeStyle = stroke; ctx.stroke();
    }
    function paintBox(ctx, hr, vr, q){                           // a rectangle: background, then the border (no border on an extended side)
      var s = q.d.style, lw = Math.max(1, Math.round(s.width * hr)), half = lw % 2 ? 0.5 : 0, r = q.box;
      var lim = 1e5;                                             // far off screen is far enough (a canvas goes wrong on huge numbers)
      var X0 = Math.round(Math.max(-lim, Math.min(lim, r.x0 * hr))) + half, X1 = Math.round(Math.max(-lim, Math.min(lim, r.x1 * hr))) + half;
      var Y0 = Math.round(Math.max(-lim, Math.min(lim, r.y0 * vr))) + half, Y1 = Math.round(Math.max(-lim, Math.min(lim, r.y1 * vr))) + half;
      if (s.fill) { ctx.fillStyle = s.bg; ctx.fillRect(X0, Y0, X1 - X0, Y1 - Y0); }
      ctx.lineWidth = lw; ctx.strokeStyle = s.color; ctx.lineCap = 'butt';
      ctx.setLineDash(DASHES[s.dash].map(function(v){ return v * Math.max(1, s.width * 0.75) * hr; }));
      ctx.beginPath();
      ctx.moveTo(X0, Y0); ctx.lineTo(X1, Y0); ctx.moveTo(X0, Y1); ctx.lineTo(X1, Y1);
      if (!s.extL) { ctx.moveTo(X0, Y0); ctx.lineTo(X0, Y1); }
      if (!s.extR) { ctx.moveTo(X1, Y0); ctx.lineTo(X1, Y1); }
      ctx.stroke(); ctx.setLineDash([]);
      if (q.hot) { var fill = handleFill(); grips(q.a, q.b).forEach(function(g){ grip(ctx, hr, vr, g, fill, q.solid, g.hx === null || g.hy === null); }); }
    }
    function paintMark(ctx, hr, vr){                             // where the magnet caught: a ring on that open, high, low or close
      var q = mark && !ui.hide ? toPx(mark) : null; if (!q) return;
      ctx.beginPath(); ctx.arc(q.x * hr, q.y * vr, 4 * hr, 0, 2*Math.PI);
      ctx.lineWidth = Math.max(1, Math.round(1.5 * hr)); ctx.strokeStyle = '#e6e8ec'; ctx.stroke();
    }
    function paintLines(ctx, hr, vr, list){                      // device pixels: crisp at any screen scale
      list.forEach(function(q){
        if (q.box) { paintBox(ctx, hr, vr, q); return; }
        var s = q.d.style, lw = Math.max(1, Math.round(s.width * hr)), half = lw % 2 ? 0.5 : 0;
        var X1 = q.sp[0].x * hr, Y1 = q.sp[0].y * vr, X2 = q.sp[1].x * hr, Y2 = q.sp[1].y * vr;
        if (Math.abs(Y1 - Y2) < 0.5) Y1 = Y2 = Math.round(Y1) + half;     // horizontal and vertical lines on whole pixels
        if (Math.abs(X1 - X2) < 0.5) X1 = X2 = Math.round(X1) + half;
        ctx.lineWidth = lw; ctx.strokeStyle = s.color; ctx.lineCap = 'butt';
        ctx.setLineDash(DASHES[s.dash].map(function(v){ return v * Math.max(1, s.width * 0.75) * hr; }));
        ctx.beginPath(); ctx.moveTo(X1, Y1); ctx.lineTo(X2, Y2); ctx.stroke();
        ctx.setLineDash([]);
        if (s.mid) { ctx.fillStyle = q.solid; ctx.beginPath(); ctx.arc((q.a.x + q.b.x)/2 * hr, (q.a.y + q.b.y)/2 * vr, 3 * hr, 0, 2*Math.PI); ctx.fill(); }
        if (q.hot) { var fill = handleFill(); [q.a, q.b].forEach(function(p){ grip(ctx, hr, vr, p, fill, q.solid); }); }
      });
      paintMark(ctx, hr, vr);
    }
    function paintLabels(ctx, size, list){                       // CSS pixels: text keeps the page's font size
      function seen(p){ return p.x >= -1 && p.x <= size.width + 1 && p.y >= -1 && p.y <= size.height + 1; }   // labels follow their end off screen
      list.forEach(function(q){
        var d = q.d, s = d.style, a = q.a, b = q.b;
        if (s.labels) {
          if (seen(a)) label(ctx, size, app.fmtP(d.points[0].p), a.x, a.y, q.solid, q.ink, a.x > b.x, a.y < b.y);
          if (seen(b)) label(ctx, size, app.fmtP(d.points[1].p), b.x, b.y, q.solid, q.ink, b.x > a.x, b.y < a.y);
        }
        if (s.stats && seen(b)) {
          var p0 = d.points[0].p, p1 = d.points[1].p, dl = Math.round(b.l - a.l), dp = p1 - p0;
          var txt = (dp >= 0 ? '+' : '−') + app.fmtP(Math.abs(dp)) + ' (' + (dp >= 0 ? '+' : '−') + Math.abs(dp / p0 * 100).toFixed(2) + '%)\n' +
                    Math.abs(dl) + ' bars, ' + fmtDur(d.points[1].t - d.points[0].t);
          label(ctx, size, txt, b.x, b.y, 'rgba(26,28,32,0.92)', '#e6e8ec', b.x < a.x, b.y > a.y);
        }
      });
    }
    // price and time of the selected line's ends, highlighted on the axes like TradingView
    var NONE = [], axisCache = {d:null, price:NONE, time:NONE};
    function axisViews(kind){
      var d = placing ? placing.d : selected; if (!d || ui.hide) return NONE;
      if (axisCache.d !== d) {                                   // the chart keeps views by identity: same arrays while the line is the same
        var mk = function(k){ return [0, 1].map(function(i){
          function col(){ return UI.parse(d.style.color) || {r:41,g:98,b:255}; }
          return {
            coordinate: function(){ var q = toPx(d.points[i]); return q ? (k === 'price' ? q.y : q.x) : -100; },
            text: function(){ return k === 'price' ? app.fmtP(d.points[i].p) : app.fmtT(d.points[i].t); },
            textColor: function(){ var c = col(); return (c.r*299 + c.g*587 + c.b*114) / 1000 > 150 ? '#111' : '#fff'; },
            backColor: function(){ var c = col(); return 'rgb(' + c.r + ',' + c.g + ',' + c.b + ')'; },
            visible: function(){                                 // off screen: hide it (the chart would pin it to the axis edge)
              var q = toPx(d.points[i]); if (!q) return false;
              var v = k === 'price' ? q.y : q.x; return v >= 0 && v <= (k === 'price' ? paneH() : ts.width());
            },
            tickVisible: function(){ return true; }
          };
        }); };
        axisCache = {d:d, price:mk('price'), time:mk('time')};
      }
      return axisCache[kind];
    }
    var requestUpdate = function(){};
    var renderer = {draw: function(target){
      var list = null;
      target.useBitmapCoordinateSpace(function(sc){ list = shapes(sc.mediaSize); paintLines(sc.context, sc.horizontalPixelRatio, sc.verticalPixelRatio, list); });
      target.useMediaCoordinateSpace(function(sc){ paintLabels(sc.context, sc.mediaSize, list); });
    }};
    var paneViews = [{zOrder: function(){ return 'normal'; }, renderer: function(){ return renderer; }}];
    series.attachPrimitive({
      attached: function(p){ requestUpdate = p.requestUpdate; },
      detached: function(){ requestUpdate = function(){}; },
      updateAllViews: function(){},
      paneViews: function(){ return paneViews; },
      priceAxisViews: function(){ return axisViews('price'); },
      timeAxisViews: function(){ return axisViews('time'); },
      hitTest: function(x, y){                                    // the chart asks this to pick the mouse cursor
        if (tool !== 'cursor' || drag || placing) return null;
        var h = hitAt(x, y); if (!h) return null;
        var grip = typeof h.part === 'object' && !ui.lock && !h.d.locked;   // a rectangle's grip that can be dragged: resize arrows
        return {cursorStyle: grip ? gripCursor(h.d, h.part) : 'pointer', externalId: h.d.id, zOrder: 'normal'};
      }
    });
    function redrawAll(){ requestUpdate(); toolbar(); }

    // ------------------------------------------------------------ saving: only what changed, so app windows never wipe each other
    // mk.base is what the server is known to hold for the market on screen (id -> JSON). A save sends the drawings that differ
    // from it and the ids that are gone, never the whole list, so a window with an out-of-date copy cannot delete what another
    // window drew. The server answers with the revision the change was applied on: if this page had not seen that one, another
    // window changed the market meanwhile, and the list is fetched again and merged. Other windows hear of every save at once
    // (BroadcastChannel) and the list is checked again when the window gets the focus back. A save or load that fails is
    // retried until it works and shown in red in the top bar meanwhile; a market left with unsaved changes keeps retrying.
    var mk = null, left = [];
    var bc = window.BroadcastChannel ? new BroadcastChannel('dollarbars-drawings') : null;
    function listOf(m){ return m === mk ? items : m.items; }
    function older(a, b){                                        // is revision a from before b? ("<server start>-<count>"; a restarted server's are all new)
      if (!a || !b) return false;
      var x = a.split('-'), y = b.split('-'); return x[0] === y[0] && +x[1] < +y[1];
    }
    function opsOf(m){
      var up = [], del = [], seen = {};
      listOf(m).forEach(function(d){ seen[d.id] = 1; if (m.base[d.id] !== JSON.stringify(d)) up.push(d); });
      Object.keys(m.base).forEach(function(id){ if (!seen[id]) del.push(id); });
      return {upsert: up, delete: del};
    }
    function status(){
      left = left.filter(function(m){ return m.inflight || m.failed; });
      var f = left.concat(mk ? [mk] : []).filter(function(m){ return m.failed; })[0];
      app.saveState('drawings', f ? 'Drawings not saved: ' + f.failed : mk && !mk.loaded && mk.loadTries ? 'Drawings not loaded yet, retrying' : null);
    }
    function save(m, closing){
      clearTimeout(m.timer); m.timer = null;
      if (m.inflight && !closing) { m.again = true; return m.inflight; }
      var o = opsOf(m);
      if (!o.upsert.length && !o.delete.length) return m.inflight || Promise.resolve();
      var sent = {}; o.upsert.forEach(function(d){ sent[d.id] = JSON.stringify(d); });
      var p = m.inflight = app.post('/drawings?m=' + encodeURIComponent(m.key), o, closing).then(function(j){
        if (m.inflight === p) m.inflight = null;
        Object.keys(sent).forEach(function(id){ m.base[id] = sent[id]; }); o.delete.forEach(function(id){ delete m.base[id]; });
        var others = j.prev !== m.rev; if (!older(j.rev, m.rev)) m.rev = j.rev; m.failed = null; m.tries = 0;
        if (bc) bc.postMessage(m.key);
        if (others && m === mk) fetchList(m, true);
        var again = m.again; m.again = false; status();
        if (again) return save(m);
      }, function(err){
        if (m.inflight === p) m.inflight = null;
        m.again = false; m.failed = err.message || 'server not answering'; status();
        clearTimeout(m.timer); m.timer = setTimeout(function(){ save(m); }, Math.min(30000, 1000 * Math.pow(2, m.tries++)));
      });
      return p;
    }
    function changed(){
      if (selected && items.indexOf(selected) < 0) selected = null;
      if (mk) { var m = mk; clearTimeout(m.timer); m.timer = setTimeout(function(){ save(m); }, m.failed ? 0 : 400); }
      redrawAll(); buttons(); settle();
    }
    function flush(closing){ return Promise.all(left.concat(mk ? [mk] : []).map(function(m){ return save(m, closing); })); }
    addEventListener('pagehide', function(){ flush(true); });

    function clean(d){                                           // a saved drawing this version can show (others stay on the server untouched)
      if (!d || !TYPES[d.type] || typeof d.id !== 'string' || !Array.isArray(d.points) || d.points.length !== 2) return null;
      d.style = Object.assign({}, TYPES[d.type].base, d.style || {}); return d;
    }
    function editing(){ return placing || drag || document.querySelector('.modal'); }
    function fetchList(m, force){
      if (m.fetching) { if (force) m.refetch = true; return; }
      m.fetching = true;
      fetch('/drawings?m=' + encodeURIComponent(m.key)).then(function(r){ return r.ok ? r.json() : Promise.reject(); }).then(function(j){
        if (!Array.isArray(j.drawings)) throw new Error('bad reply');
        m.fetching = false; m.loaded = true; m.loadTries = 0;
        if (m === mk && !older(j.rev, m.rev)) {                   // (a reply that left before a save that has since come back is out of date)
          if (editing()) m.held = true; else merge(m, j.drawings, j.rev);   // not under the user's hands: after the gesture
        }
        if (m.refetch) { m.refetch = false; fetchList(m); }
        status();
      }).catch(function(){
        m.fetching = false; m.refetch = false;
        if (m !== mk || m.loaded) return;
        m.loadTries++; status();
        clearTimeout(m.loadTimer); m.loadTimer = setTimeout(function(){ fetchList(m); }, Math.min(15000, 500 * Math.pow(2, m.loadTries)));
      });
    }
    function settle(){ if (mk && mk.held && !editing()) { mk.held = false; fetchList(mk, true); } }
    function merge(m, server, rev){                              // the server's list + what this window changed and has not saved yet
      var o = opsOf(m), gone = {}, mine = {}, cur = {}, next = [], base = {};
      o.delete.forEach(function(id){ gone[id] = 1; });
      o.upsert.forEach(function(d){ mine[d.id] = d; });
      items.forEach(function(d){ cur[d.id] = d; });
      server.forEach(function(raw){
        var d = clean(raw); if (!d) return;
        var j = JSON.stringify(d); base[d.id] = j;
        if (gone[d.id]) return;
        if (mine[d.id]) { next.push(mine[d.id]); delete mine[d.id]; return; }
        next.push(cur[d.id] && JSON.stringify(cur[d.id]) === j ? cur[d.id] : d);
      });
      o.upsert.forEach(function(d){ if (mine[d.id]) next.push(d); });   // drawn here, not on the server yet
      next.sort(function(x, y){ return x.id < y.id ? -1 : x.id > y.id ? 1 : 0; });   // oldest first (ids start with the time drawn): the same stacking in every window
      m.base = base; m.rev = rev;
      if (JSON.stringify(next) === JSON.stringify(items)) return;
      var sel = selected && selected.id;
      if (undo.length || redo.length) { undo = []; redo = []; buttons(); }   // an undo step from before the server's list came in could wipe it
      items = next; selected = items.filter(function(d){ return d.id === sel; })[0] || null; hover = null;
      redrawAll();
    }
    function recheck(){ if (mk && mk.loaded && document.visibilityState === 'visible') fetchList(mk); }
    addEventListener('focus', recheck);
    document.addEventListener('visibilitychange', recheck);
    if (bc) bc.onmessage = function(e){ if (mk && e.data === mk.key) fetchList(mk, true); };   // another window saved this market

    // ------------------------------------------------------------ undo
    function snapshot(){ return JSON.stringify(items); }
    function pushUndo(snap){ undo.push(snap); if (undo.length > 200) undo.shift(); redo = []; buttons(); }
    function remember(){ pushUndo(snapshot()); }
    function restore(snap){
      var id = selected && selected.id;
      items = JSON.parse(snap); selected = items.filter(function(d){ return d.id === id; })[0] || null; hover = null; changed();
    }
    function doUndo(){ if (!undo.length || placing || drag) return; redo.push(snapshot()); restore(undo.pop()); }
    function doRedo(){ if (!redo.length || placing || drag) return; undo.push(snapshot()); restore(redo.pop()); }
    function buttons(){ $('bUndo').disabled = !undo.length; $('bRedo').disabled = !redo.length; }
    function newId(){ return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
    function saveUi(){ store.set('drawUi', ui); }
    function setDefaults(d){                                     // the next new drawing of this kind looks like this one
      defaults[d.type] = Object.assign({}, d.style);
      var dd = Object.assign({}, store.get('drawDefaults') || {}); dd[d.type] = defaults[d.type]; store.set('drawDefaults', dd);
    }

    function setMarket(key){
      if (mk) { mk.items = items; save(mk); left.push(mk); }      // the market being left saves in the background
      placing = null; drag = null; mark = null; host.style.cursor = tool === 'cursor' ? '' : 'crosshair';
      mk = left.filter(function(m){ return m.key === key; })[0] || {key:key, base:{}, rev:null, items:[], loaded:false, loadTries:0, tries:0};
      left = left.filter(function(m){ return m !== mk; });
      items = mk.items; selected = hover = null; undo = []; redo = []; buttons(); redrawAll(); status();
      fetchList(mk, true);
    }

    // ------------------------------------------------------------ tools and the left toolbar
    function setTool(t){
      placing = null; mark = null;
      tool = t;
      host.style.cursor = t === 'cursor' ? '' : 'crosshair';
      Array.prototype.forEach.call(document.querySelectorAll('#tools [data-tool]'), function(b){ b.classList.toggle('on', b.dataset.tool === t); });
      if (t !== 'cursor') { selected = null; hover = null; }
      redrawAll();
    }
    Array.prototype.forEach.call(document.querySelectorAll('#tools [data-tool]'), function(b){ b.onclick = function(){ setTool(b.dataset.tool); }; });
    function sideButtons(){
      $('tStay').classList.toggle('on', ui.stay); $('tLock').classList.toggle('on', ui.lock); $('tHide').classList.toggle('on', ui.hide);
      $('tMagnet').classList.toggle('on', !!ui.magnet);
      $('tMagnet').title = 'Magnet ' + (ui.magnet ? 'on' : 'off') + ': while drawing, a point snaps to a nearby open, high, low or close (hold Ctrl to flip it)';
      $('tHide').title = (ui.hide ? 'Show all drawings' : 'Hide all drawings') + ' (Ctrl+Alt+H)';
      $('tLock').title = ui.lock ? 'Unlock all drawings' : 'Lock all drawings';
    }
    function toggleHide(){ ui.hide = !ui.hide; if (ui.hide) { selected = hover = null; } saveUi(); sideButtons(); redrawAll(); }
    $('tMagnet').onclick = function(){ ui.magnet = !ui.magnet; saveUi(); sideButtons(); };
    $('tStay').onclick = function(){ ui.stay = !ui.stay; saveUi(); sideButtons(); };
    $('tLock').onclick = function(){ ui.lock = !ui.lock; saveUi(); sideButtons(); redrawAll(); };
    $('tHide').onclick = toggleHide;
    $('tRemove').onclick = function(){                           // like TradingView: straight away (Ctrl+Z brings them back), asks only for locked ones
      if (!items.length) return;
      function all(){ remember(); items = []; selected = hover = null; changed(); }
      var locked = items.filter(function(d){ return d.locked; }).length;
      if (!locked) { all(); return; }
      UI.dialog({title:'Remove drawings', tabs:[{name:'', render:function(b){ b.style.minHeight = '0';
        b.textContent = locked + ' of the ' + items.length + ' drawings on this market ' + (locked > 1 ? 'are' : 'is') + ' locked. Remove them too? (Ctrl+Z brings them back)'; }}],
        onOk: all});
    };
    $('bUndo').onclick = doUndo; $('bRedo').onclick = doRedo;
    sideButtons(); buttons();

    // ------------------------------------------------------------ the floating toolbar of the selected drawing
    var dtb = $('dtb');
    var ICON = {
      gear: '<svg viewBox="0 0 28 28"><g fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="14" cy="14" r="3"/><path d="M14 5l1.5 2.4 2.8-.6.8 2.7 2.6 1.1-.7 2.7 1.9 2.1-2 1.9.5 2.8-2.7.7-1.2 2.6-2.7-.8L14 23l-1.6-2.3-2.7.8-1.2-2.6-2.7-.7.5-2.8-2-1.9 1.9-2.1-.7-2.7 2.6-1.1.8-2.7 2.8.6z"/></g></svg>',
      lock: '<svg viewBox="0 0 28 28"><g fill="none" stroke="currentColor" stroke-width="1.4"><rect x="8.5" y="13" width="11" height="8.5" rx="1.5"/><path d="M11 13v-3a3 3 0 0 1 6 0v3"/></g></svg>',
      unlock: '<svg viewBox="0 0 28 28"><g fill="none" stroke="currentColor" stroke-width="1.4"><rect x="8.5" y="13" width="11" height="8.5" rx="1.5"/><path d="M11 13v-3a3 3 0 0 1 6-.5"/></g></svg>',
      trash: '<svg viewBox="0 0 28 28"><g fill="none" stroke="currentColor" stroke-width="1.4"><path d="M8 9.5h12M12 9.5v-2h4v2M9.5 9.5l.9 11.5h7.2l.9-11.5"/></g></svg>'
    };
    function lineSvg(width, dash, css){
      var da = DASHES[dash].map(function(v){ return v * Math.max(1, width * 0.75); }).join(' ');
      return '<svg viewBox="0 0 40 10"' + (css ? ' style="' + css + '"' : '') + '><path d="M2 5h36" stroke="currentColor" stroke-width="' + width + '"' + (da ? ' stroke-dasharray="' + da + '"' : '') + '/></svg>';
    }
    function toolbar(){
      var d = selected;
      if (!d || ui.hide || tool !== 'cursor') { dtb.className = ''; return; }
      var s = d.style, locked = !!d.locked, rect = d.type === 'rectangle';
      var sw = function(c){ return '<i class="sw chk"><i style="display:block;width:100%;height:100%;border-radius:.15rem;background:' + c + '"></i></i>'; };
      dtb.innerHTML = '<i class="grip" title="Drag to move this toolbar"></i>' +
        (rect ? '<button data-a="color" title="Border color"><i class="sw ring" style="border-color:' + s.color + '"></i></button>' +
                '<button data-a="bg" title="Background' + (s.fill ? '' : ' (off)') + '">' + sw(s.fill ? s.bg : 'transparent') + '</button>'
              : '<button data-a="color" title="Line color">' + sw(s.color) + '</button>') +
        '<button data-a="width" title="Line width">' + lineSvg(Math.min(s.width, 4), 0, 'width:1.6rem') + '<span>' + s.width + 'px</span></button>' +
        '<button data-a="dash" title="Line style">' + lineSvg(2, s.dash, 'width:1.8rem') + '</button>' +
        '<button data-a="settings" title="Settings">' + ICON.gear + '</button>' +
        '<button data-a="lock" class="' + (locked ? 'on' : '') + '" title="' + (locked ? 'Unlock' : 'Lock') + '">' + (locked ? ICON.lock : ICON.unlock) + '</button>' +
        '<button data-a="delete" title="Remove (Delete)">' + ICON.trash + '</button>';
      dtb.className = 'show';
      // where the user dragged it, else the top right of the pane; never under the update banner (nor, in its own spot, the legend)
      var wrap = $('wrap'), wr = wrap.getBoundingClientRect(), w = dtb.offsetWidth, h = dtb.offsetHeight;
      var x = Math.max(0, Math.min(wrap.clientWidth - w, ui.dtb ? ui.dtb.x : ts.width() - w - 12)), y = ui.dtb ? ui.dtb.y : 8;
      var avoid = ui.dtb ? [$('banner')] : [$('legend'), $('banner')];
      for (var k = 0; k < 2; k++) avoid.forEach(function(o){
        var r = o.getBoundingClientRect(), ox = r.left - wr.left, oy = r.top - wr.top;
        if (r.width && x < ox + r.width && x + w > ox && y < oy + r.height && y + h > oy) y = oy + r.height + 6;
      });
      dtb.style.left = x + 'px'; dtb.style.top = Math.max(0, Math.min(wrap.clientHeight - h, y)) + 'px';
    }
    ts.subscribeSizeChange(function(){ if (selected) toolbar(); });   // the window was resized: keep it inside and clear of the banner
    function restyle(patch){ if (!selected) return; remember(); Object.assign(selected.style, patch); setDefaults(selected); changed(); }
    dtb.addEventListener('click', function(e){
      var b = e.target.closest('button'); if (!b || !selected) return;
      var a = b.dataset.a, d = selected;
      if (a === 'color' || a === 'bg') {                         // the line or border color; a rectangle's background (picking one switches it on)
        var before = snapshot(), touched = false, key = a === 'bg' ? 'bg' : 'color';
        UI.pickColor(b, {value: d.style[key], custom: colors.get(), onCustom: colors.set,
          onChange: function(v){ if (!touched) { pushUndo(before); touched = true; } d.style[key] = v; if (key === 'bg') d.style.fill = true; setDefaults(d); changed(); }});
      }
      else if (a === 'width') UI.menu(b, [1,2,3,4].map(function(w){ return {html: lineSvg(w, 0) + w + 'px', on: d.style.width === w, onClick: function(){ restyle({width:w}); }}; }));
      else if (a === 'dash') UI.menu(b, ['Line','Dashed line','Dotted line'].map(function(n, i){ return {html: lineSvg(2, i) + n, on: d.style.dash === i, onClick: function(){ restyle({dash:i}); }}; }));
      else if (a === 'settings') openSettings(d);
      else if (a === 'lock') { remember(); d.locked = !d.locked; changed(); }
      else if (a === 'delete') remove(d);
    });
    dtb.addEventListener('pointerdown', function(e){
      if (!e.target.classList.contains('grip')) return;
      e.preventDefault();
      var wrap = $('wrap').getBoundingClientRect(), r = dtb.getBoundingClientRect(), dx = e.clientX - r.left, dy = e.clientY - r.top;
      dtb.setPointerCapture(e.pointerId);
      var mv = function(ev){ ui.dtb = {x: ev.clientX - wrap.left - dx, y: ev.clientY - wrap.top - dy}; toolbar(); };
      var up = function(){ dtb.removeEventListener('pointermove', mv); dtb.removeEventListener('pointerup', up); saveUi(); };
      dtb.addEventListener('pointermove', mv); dtb.addEventListener('pointerup', up);
    });
    function remove(d){ remember(); items = items.filter(function(x){ return x !== d; }); if (selected === d) selected = null; hover = null; changed(); }

    // ------------------------------------------------------------ a drawing's settings dialog (double-click it, or the gear)
    function openSettings(d){
      var before = snapshot(), orig = JSON.parse(JSON.stringify(d)), rect = d.type === 'rectangle';
      function live(){ redrawAll(); }
      function check(body, name, field){
        var row = UI.el('div', 'row'), lab = UI.el('label', 'name'), cb = UI.el('input'); cb.type = 'checkbox'; cb.checked = !!d.style[field];
        cb.onchange = function(){ d.style[field] = cb.checked; live(); };
        lab.appendChild(cb); lab.appendChild(document.createTextNode(name)); row.appendChild(lab); body.appendChild(row);
        return row;
      }
      UI.dialog({title: TYPES[d.type].name, tabs: [
        {name:'Style', render: function(body){
          var row = UI.el('div', 'row'), ctl = UI.el('div', 'ctl');
          row.appendChild(UI.el('span', 'name', rect ? 'Border' : 'Line'));
          ctl.appendChild(UI.swatch(d.style.color, function(v){ d.style.color = v; live(); }, colors));
          var w = UI.el('select', null, [1,2,3,4].map(function(v){ return '<option value="' + v + '">' + v + 'px</option>'; }).join('')); w.value = d.style.width;
          w.onchange = function(){ d.style.width = +w.value; live(); };
          var st = UI.el('select', null, '<option value="0">Solid</option><option value="1">Dashed</option><option value="2">Dotted</option>'); st.value = d.style.dash;
          st.onchange = function(){ d.style.dash = +st.value; live(); };
          ctl.appendChild(w); ctl.appendChild(st); row.appendChild(ctl); body.appendChild(row);
          if (rect) {
            var bgRow = check(body, 'Background', 'fill'), bgCtl = UI.el('div', 'ctl');
            bgCtl.appendChild(UI.swatch(d.style.bg, function(v){ d.style.bg = v; live(); }, colors)); bgRow.appendChild(bgCtl);
            check(body, 'Extend left', 'extL'); check(body, 'Extend right', 'extR');
            return;
          }
          check(body, 'Extend left line', 'extL'); check(body, 'Extend right line', 'extR');
          check(body, 'Middle point', 'mid'); check(body, 'Price labels', 'labels'); check(body, 'Stats', 'stats');
        }},
        {name:'Coordinates', render: function(body){
          d.points.forEach(function(pt, i){
            var row = UI.el('div', 'row'), ctl = UI.el('div', 'ctl');
            row.appendChild(UI.el('span', 'name', '#' + (i + 1) + ' price'));
            var inp = UI.el('input'); inp.type = 'number'; inp.step = 'any'; inp.value = +pt.p.toPrecision(10);
            inp.style.cssText = 'width:9rem;background:var(--bg);color:var(--tx);border:1px solid var(--bd2);border-radius:.3rem;padding:.3rem .5rem;font:inherit';
            inp.oninput = function(){ var v = parseFloat(inp.value); if (v > 0) { d.points[i] = {t: d.points[i].t, p: v}; live(); } };
            ctl.appendChild(inp); ctl.appendChild(UI.el('span', null, '<small style="color:var(--tx3)">' + app.fmtT(pt.t) + '</small>'));
            row.appendChild(ctl); body.appendChild(row);
          });
        }}
      ],
      onOk: function(){
        if (JSON.stringify(d) !== JSON.stringify(orig)) pushUndo(before);
        if (JSON.stringify(d.style) !== JSON.stringify(orig.style)) setDefaults(d);   // the next new one of its kind looks like this one
        changed();
      },
      onCancel: function(){ d.points = orig.points; d.style = orig.style; d.locked = orig.locked; changed(); }});
    }

    // ------------------------------------------------------------ mouse: placing, selecting, dragging
    function local(e){ var r = host.getBoundingClientRect(); return {x: e.clientX - r.left, y: e.clientY - r.top}; }
    function inPane(p){ return p.x >= 0 && p.y >= 0 && p.x < ts.width() && p.y < paneH(); }
    function take(e){ e.preventDefault(); e.stopPropagation(); }  // the chart never sees this press: no pan, no click
    function horizontal(pt, other){ return shift && other ? {t: pt.t, p: other.p} : pt; }
    // The second point of the drawing being placed, at mouse position p. Shift decides first (a line stays level, a
    // rectangle stays square); without it, the magnet.
    function endAt(p){
      var d = placing.d, q = shift && d.type === 'rectangle' ? squared(p, toPx(d.points[0])) : p;
      var a = anchorAt(q.x, q.y, shift); if (!a) return;
      d.points[1] = d.type === 'rectangle' ? a : horizontal(a, d.points[0]);
    }

    host.addEventListener('mousedown', function(e){
      if (e.button !== 0 || UI.busy()) return;
      var ae = document.activeElement;                           // the keys go back to the chart (Delete, Esc, Ctrl+Z…), not to a menu or button
      if (ae && /INPUT|SELECT|TEXTAREA|BUTTON/.test(ae.tagName)) ae.blur();
      var p = local(e); if (!inPane(p)) return;
      shift = e.shiftKey; ctrl = e.ctrlKey || e.metaKey;
      if (tool !== 'cursor') {
        take(e);
        if (placing) { endAt(p); finish(); return; }             // second click
        var a = anchorAt(p.x, p.y); if (!a) return;
        if (ui.hide || ui.lock) { ui.hide = ui.lock = false; saveUi(); sideButtons(); }   // a new drawing shows them again, like TradingView
        placing = {d: {id:newId(), type:tool, points:[a, {t:a.t, p:a.p}], style:Object.assign({}, defaults[tool])}, from:p, down:true, dragged:false};
        redrawAll(); return;
      }
      var h = hitAt(p.x, p.y);
      if (!h) { lastDown = null; if (selected) { selected = null; redrawAll(); } return; }   // empty chart: deselect and let it pan
      var free = !ui.lock && !h.d.locked;
      if (free || h.part !== 'fill') take(e);                    // inside a locked rectangle the chart still pans under the mouse (a click selects it)
      var dbl = e.detail >= 2 && lastDown && lastDown.d.id === h.d.id;  // double-click = settings
      lastDown = dbl ? null : {d:h.d};
      selected = h.d; hover = null;
      if (dbl) { drag = null; redrawAll(); openSettings(h.d); return; }
      if (free) {
        drag = {d:h.d, part:h.part, from:p, before:snapshot(), moved:false, l0: ts.coordinateToLogical(p.x),
                orig: h.d.points.map(function(pt){ var q = toPx(pt); return {l: q.l, y: q.y}; })};
        if (typeof h.part === 'object') host.style.cursor = gripCursor(h.d, h.part);   // the arrows stay for the whole drag (the chart stops asking hitTest)
      }
      redrawAll();
    }, true);

    function move(p){
      lastMove = p;
      if (placing) {
        if (placing.down && Math.hypot(p.x - placing.from.x, p.y - placing.from.y) > DRAG_MIN) placing.dragged = true;
        endAt(p);
        requestUpdate(); return;
      }
      if (drag) {
        if (!drag.moved && Math.hypot(p.x - drag.from.x, p.y - drag.from.y) <= DRAG_MIN) return;
        var d = drag.d;
        if (!drag.moved) { drag.moved = true; if (typeof drag.part !== 'object') host.style.cursor = 'grabbing'; }
        if (drag.part === 'line' || drag.part === 'fill') {      // the whole drawing moves (no magnet: nothing of it is being placed)
          var l1 = ts.coordinateToLogical(p.x); if (l1 === null || drag.l0 === null) return;
          var dl = Math.round(l1 - drag.l0), dy = p.y - drag.from.y;
          if (shift) { if (Math.abs(p.x - drag.from.x) >= Math.abs(dy)) dy = 0; else dl = 0; }   // Shift: straight across or straight up/down
          var pts = drag.orig.map(function(o){ var pr = series.coordinateToPrice(o.y + dy), t = app.logicalToTime(o.l + dl); return pr === null || t === null ? null : {t:t, p:pr}; });
          if (pts[0] && pts[1]) d.points = pts;
        } else if (typeof drag.part === 'object') {              // a rectangle's grip: a corner moves a time and a price, a side's middle one of them
          var g = drag.part, corner = g.hx !== null && g.hy !== null, q = p;
          if (shift && corner) q = squared(p, toPx({t: d.points[1 - g.hx].t, p: d.points[1 - g.hy].p}));   // square from the opposite corner
          var a3 = anchorAt(q.x, q.y, g.hy === null || (shift && corner)); if (!a3) return;
          var np = d.points.map(function(pt){ return {t: pt.t, p: pt.p}; });
          if (g.hx !== null) np[g.hx].t = a3.t;
          if (g.hy !== null) np[g.hy].p = a3.p;
          d.points = np;
          host.style.cursor = gripCursor(d, g);                  // a corner dragged past its opposite one: the diagonal turns
        } else {
          var a2 = anchorAt(p.x, p.y, shift); if (!a2) return;
          d.points[drag.part] = horizontal(a2, d.points[1 - drag.part]);
        }
        requestUpdate(); return;
      }
      if (tool !== 'cursor') {                                   // a tool is up, nothing placed yet: show where the magnet would catch the first point
        var was = mark;
        if (inPane(p) && !UI.busy()) anchorAt(p.x, p.y); else mark = null;
        if ((was && was.t) !== (mark && mark.t) || (was && was.p) !== (mark && mark.p)) requestUpdate();
        return;
      }
      if (!UI.busy()) {                                          // hover: show the grips of the drawing under the mouse
        var h = inPane(p) ? hitAt(p.x, p.y) : null, d2 = h ? h.d : null;
        if (d2 !== hover) { hover = d2; requestUpdate(); }
      }
    }
    document.addEventListener('mousemove', function(e){
      if (!placing && !drag && !host.contains(e.target)) { if (hover || mark) { hover = null; mark = null; requestUpdate(); } return; }
      shift = e.shiftKey; ctrl = e.ctrlKey || e.metaKey; move(local(e));
    });
    document.addEventListener('mouseup', function(e){
      if (e.button !== 0) return;
      var p = local(e); shift = e.shiftKey; ctrl = e.ctrlKey || e.metaKey;
      if (placing) {
        placing.down = false;
        if (placing.dragged) { move(p); finish(); }             // press, drag, release: done
        return;                                                  // a click: the second click places the other end
      }
      if (drag) {
        var dr = drag; drag = null; mark = null; host.style.cursor = '';
        if (dr.moved) { pushUndo(dr.before); changed(); } else { redrawAll(); settle(); }
      }
    });
    host.addEventListener('dblclick', function(e){                // the chart's own double-click stays off drawings
      var p = local(e); if (tool === 'cursor' && inPane(p) && hitAt(p.x, p.y)) take(e);
    }, true);
    function finish(){
      var d = placing.d; placing = null; mark = null;
      var a = toPx(d.points[0]), b = toPx(d.points[1]);
      if (!a || !b || (Math.abs(a.x - b.x) < 1 && Math.abs(a.y - b.y) < 1)) { redrawAll(); settle(); return; }   // nothing drawn
      remember(); items.push(d);
      if (!ui.stay) setTool('cursor');
      selected = d;                                              // the new line stays selected, its toolbar shows
      changed();
    }

    // ------------------------------------------------------------ keyboard
    document.addEventListener('keydown', function(e){
      if (e.key === 'Shift' && !shift) { shift = true; if (lastMove && (placing || drag)) move(lastMove); }
      if ((e.key === 'Control' || e.key === 'Meta') && !ctrl) { ctrl = true; if (lastMove && (placing || drag || tool !== 'cursor')) move(lastMove); }   // the magnet flips at once
      if (UI.busy(e) || $('picker').classList.contains('show')) return;
      var mod = e.ctrlKey || e.metaKey, k = e.key.toLowerCase();
      if (e.key === 'Escape') {                                  // cancel what is being drawn, back to the cursor, nothing selected
        placing = null; mark = null;
        if (tool !== 'cursor') setTool('cursor');
        selected = null; redrawAll(); settle();
      }
      else if ((e.key === 'Delete' || e.key === 'Backspace') && selected && !drag && !selected.locked && !ui.lock) { e.preventDefault(); remove(selected); }
      else if (e.altKey && mod && e.code === 'KeyH') { e.preventDefault(); toggleHide(); }
      else if (e.altKey && !mod && e.code === 'KeyT') { e.preventDefault(); setTool('trendline'); }
      else if (e.altKey && !mod && e.shiftKey && e.code === 'KeyR') { e.preventDefault(); setTool('rectangle'); }
      else if (mod && k === 'z' && !e.shiftKey) { e.preventDefault(); doUndo(); }
      else if (mod && (k === 'y' || (k === 'z' && e.shiftKey))) { e.preventDefault(); doRedo(); }
    });
    document.addEventListener('keyup', function(e){
      if (e.key === 'Shift') { shift = false; if (lastMove && (placing || drag)) move(lastMove); }
      if (e.key === 'Control' || e.key === 'Meta') { ctrl = false; if (lastMove && (placing || drag || tool !== 'cursor')) move(lastMove); }
    });
    addEventListener('blur', function(){ shift = false; ctrl = false; });

    return {
      setMarket: setMarket,
      refresh: function(){ requestUpdate(); if (selected) toolbar(); },
      flush: flush,
      _state: function(){ return {tool:tool, items:items, selected:selected && selected.id, undo:undo.length, redo:redo.length, placing:!!placing,
                                  magnet: !!ui.magnet, mark: mark, hover: hover && hover.id,
                                  loaded: !!(mk && mk.loaded), rev: mk && mk.rev, failed: mk && mk.failed, left: left.length}; },   // tests, console
      _px: function(i){ return items[i] ? items[i].points.map(toPx) : null; }
    };
  };
})();
