/* Drawing tools, TradingView style. For now one tool: the trend line.

   Draw: pick the tool (left toolbar or Alt+T), then click two points, or press, drag and release. Holding Shift keeps the
   line horizontal (while placing it or dragging an end; while moving a whole line, Shift keeps the move straight across or
   straight up and down). Hover a line to see its ends; click to select it; drag the line to move it or an end to reshape
   it; Delete removes it; double-click (or the gear) opens its settings; Ctrl+Z / Ctrl+Y undo and redo; Esc cancels.
   The floating toolbar of the selected line changes color (with opacity), width and style.

   Drawings are kept per market and anchored by time + price, so they sit on the same moments whatever bar size or time
   frame is shown (the x-axis is bar order, app.timeToLogical places a time on it). They are saved to data/drawings.json
   through the server a moment after each change. Drawn by a Lightweight Charts series primitive. Exposes window.DBCDraw(app).

   Mouse handling: a capture-phase mousedown on the chart's container. When the press lands on a drawing (or a drawing tool
   is active) it is cancelled before the chart sees it, so the chart does not pan, while the chart still gets mousemove and
   keeps its crosshair on the mouse during the drag. Presses on empty chart go through untouched (pan, zoom). */
(function(){
  'use strict';
  var HIT = 6, HANDLE = 5.5, DRAG_MIN = 4;                       // px: hit distance, handle radius, a press that moves less is a click
  var BASE_STYLE = {color:'rgba(41,98,255,1)', width:2, dash:0, extL:false, extR:false, mid:false, labels:false, stats:false};
  var DASHES = [[], [7, 5], [2, 3]];                             // solid, dashed, dotted (scaled by width)
  var $ = UI.$;

  window.DBCDraw = function(app){
    var chart = app.chart, series = app.series, ts = chart.timeScale(), store = app.store, host = $('chart');
    var ui = Object.assign({stay:false, lock:false, hide:false, dtb:null}, store.get('drawUi') || {});
    var defaults = Object.assign({}, BASE_STYLE, (store.get('drawDefaults') || {}).trendline || {});
    var items = [], marketKey = null, loadSeq = 0;
    var tool = 'cursor', selected = null, hover = null, placing = null, drag = null, shift = false, lastMove = null;
    var undo = [], redo = [], saveTimer = null, pendingSave = null, lastDown = null;
    var colors = {get: function(){ return store.get('customColors') || []; }, set: function(l){ store.set('customColors', l); }};

    // ------------------------------------------------------------ geometry: anchors {t, p} <-> pane pixels
    function paneH(){ return host.clientHeight - ts.height(); }
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
    function hitAt(x, y){
      if (ui.hide) return null;
      var w = ts.width(), h = paneH();
      for (var i = items.length - 1; i >= 0; i--) {
        var d = items[i], a = toPx(d.points[0]), b = toPx(d.points[1]);
        if (!a || !b) continue;
        if (d === selected || d === hover) {
          if (Math.hypot(x - a.x, y - a.y) <= HANDLE + 3) return {d:d, part:0};
          if (Math.hypot(x - b.x, y - b.y) <= HANDLE + 3) return {d:d, part:1};
        }
        var sp = span(a, b, d.style, w, h);
        if (segDist(x, y, sp[0], sp[1]) <= HIT) return {d:d, part:'line'};
      }
      return null;
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
      bx = Math.max(2, Math.min(size.width - w - 2, bx)); by = Math.max(2, Math.min(size.height - hh - 2, by));   // stay inside the pane
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
        out.push({d:d, a:a, b:b, sp:span(a, b, d.style, size.width, size.height), solid:'rgb(' + c.r + ',' + c.g + ',' + c.b + ')',
                  ink: (c.r*299 + c.g*587 + c.b*114) / 1000 > 150 ? '#111' : '#fff',
                  hot: d === selected || d === hover || (placing && placing.d === d)});
      });
      return out;
    }
    function handleFill(){
      var bg = app.settings ? app.settings.look().bg : null, c = UI.parse(bg ? (bg.type === 'gradient' ? bg.bottom : bg.color) : '#0b0c0e');
      return c ? 'rgb(' + c.r + ',' + c.g + ',' + c.b + ')' : '#0b0c0e';
    }
    function paintLines(ctx, hr, vr, list){                      // device pixels: crisp at any screen scale
      list.forEach(function(q){
        var s = q.d.style, lw = Math.max(1, Math.round(s.width * hr)), half = lw % 2 ? 0.5 : 0;
        var X1 = q.sp[0].x * hr, Y1 = q.sp[0].y * vr, X2 = q.sp[1].x * hr, Y2 = q.sp[1].y * vr;
        if (Math.abs(Y1 - Y2) < 0.5) Y1 = Y2 = Math.round(Y1) + half;     // horizontal and vertical lines on whole pixels
        if (Math.abs(X1 - X2) < 0.5) X1 = X2 = Math.round(X1) + half;
        ctx.lineWidth = lw; ctx.strokeStyle = s.color; ctx.lineCap = 'butt';
        ctx.setLineDash(DASHES[s.dash].map(function(v){ return v * Math.max(1, s.width * 0.75) * hr; }));
        ctx.beginPath(); ctx.moveTo(X1, Y1); ctx.lineTo(X2, Y2); ctx.stroke();
        ctx.setLineDash([]);
        if (s.mid) { ctx.fillStyle = q.solid; ctx.beginPath(); ctx.arc((q.a.x + q.b.x)/2 * hr, (q.a.y + q.b.y)/2 * vr, 3 * hr, 0, 2*Math.PI); ctx.fill(); }
        if (q.hot) {
          var fill = handleFill();
          [q.a, q.b].forEach(function(p){
            ctx.beginPath(); ctx.arc(p.x * hr, p.y * vr, HANDLE * hr, 0, 2*Math.PI);
            ctx.fillStyle = fill; ctx.fill(); ctx.lineWidth = Math.max(1, Math.round(1.5 * hr)); ctx.strokeStyle = q.solid; ctx.stroke();
          });
        }
      });
    }
    function paintLabels(ctx, size, list){                       // CSS pixels: text keeps the page's font size
      list.forEach(function(q){
        var d = q.d, s = d.style, a = q.a, b = q.b;
        if (s.labels) {
          label(ctx, size, app.fmtP(d.points[0].p), a.x, a.y, q.solid, q.ink, a.x > b.x, a.y < b.y);
          label(ctx, size, app.fmtP(d.points[1].p), b.x, b.y, q.solid, q.ink, b.x > a.x, b.y < a.y);
        }
        if (s.stats) {
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
        return {cursorStyle: 'pointer', externalId: h.d.id, zOrder: 'normal'};
      }
    });
    function redrawAll(){ requestUpdate(); toolbar(); }

    // ------------------------------------------------------------ saving, undo
    function snapshot(){ return JSON.stringify(items); }
    function pushUndo(snap){ undo.push(snap); if (undo.length > 200) undo.shift(); redo = []; buttons(); }
    function remember(){ pushUndo(snapshot()); }
    function changed(){
      var key = marketKey, list = JSON.parse(JSON.stringify(items));
      pendingSave = function(){ return fetch('/drawings?m=' + encodeURIComponent(key), {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({drawings:list}), keepalive:true}).catch(function(){}); };
      clearTimeout(saveTimer); saveTimer = setTimeout(flush, 400);
      if (selected && items.indexOf(selected) < 0) selected = null;
      redrawAll(); buttons();
    }
    function flush(){ clearTimeout(saveTimer); if (pendingSave) { var f = pendingSave; pendingSave = null; f(); } }
    addEventListener('pagehide', flush);
    function restore(snap){
      var id = selected && selected.id;
      items = JSON.parse(snap); selected = items.filter(function(d){ return d.id === id; })[0] || null; hover = null; changed();
    }
    function doUndo(){ if (!undo.length || placing || drag) return; redo.push(snapshot()); restore(undo.pop()); }
    function doRedo(){ if (!redo.length || placing || drag) return; undo.push(snapshot()); restore(redo.pop()); }
    function buttons(){ $('bUndo').disabled = !undo.length; $('bRedo').disabled = !redo.length; }
    function newId(){ return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
    function saveUi(){ store.set('drawUi', ui); }
    function setDefaults(style){ defaults = Object.assign({}, style); var dd = store.get('drawDefaults') || {}; dd.trendline = defaults; store.set('drawDefaults', dd); }

    function setMarket(key){
      flush();
      placing = null; drag = null; host.style.cursor = tool === 'cursor' ? '' : 'crosshair';
      marketKey = key; items = []; selected = hover = null; undo = []; redo = []; buttons(); redrawAll();
      var mySeq = ++loadSeq;
      fetch('/drawings?m=' + encodeURIComponent(key)).then(function(r){ return r.json(); }).then(function(j){
        if (mySeq !== loadSeq) return;                           // another market was opened meanwhile
        items = (j.drawings || []).filter(function(d){ return d && d.type === 'trendline' && d.points && d.points.length === 2; })
          .map(function(d){ d.style = Object.assign({}, BASE_STYLE, d.style || {}); return d; });
        redrawAll();
      }).catch(function(){});
    }

    // ------------------------------------------------------------ tools and the left toolbar
    function setTool(t){
      placing = null;
      tool = t;
      host.style.cursor = t === 'cursor' ? '' : 'crosshair';
      Array.prototype.forEach.call(document.querySelectorAll('#tools [data-tool]'), function(b){ b.classList.toggle('on', b.dataset.tool === t); });
      if (t !== 'cursor') { selected = null; hover = null; }
      redrawAll();
    }
    Array.prototype.forEach.call(document.querySelectorAll('#tools [data-tool]'), function(b){ b.onclick = function(){ setTool(b.dataset.tool); }; });
    function sideButtons(){
      $('tStay').classList.toggle('on', ui.stay); $('tLock').classList.toggle('on', ui.lock); $('tHide').classList.toggle('on', ui.hide);
      $('tHide').title = (ui.hide ? 'Show all drawings' : 'Hide all drawings') + ' (Ctrl+Alt+H)';
      $('tLock').title = ui.lock ? 'Unlock all drawings' : 'Lock all drawings';
    }
    function toggleHide(){ ui.hide = !ui.hide; if (ui.hide) { selected = hover = null; } saveUi(); sideButtons(); redrawAll(); }
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
      var s = d.style, locked = !!d.locked;
      dtb.innerHTML = '<i class="grip" title="Drag to move this toolbar"></i>' +
        '<button data-a="color" title="Line color"><i class="sw chk"><i style="display:block;width:100%;height:100%;border-radius:.15rem;background:' + s.color + '"></i></i></button>' +
        '<button data-a="width" title="Line width">' + lineSvg(Math.min(s.width, 4), 0, 'width:1.6rem') + '<span>' + s.width + 'px</span></button>' +
        '<button data-a="dash" title="Line style">' + lineSvg(2, s.dash, 'width:1.8rem') + '</button>' +
        '<button data-a="settings" title="Settings">' + ICON.gear + '</button>' +
        '<button data-a="lock" class="' + (locked ? 'on' : '') + '" title="' + (locked ? 'Unlock' : 'Lock') + '">' + (locked ? ICON.lock : ICON.unlock) + '</button>' +
        '<button data-a="delete" title="Remove (Delete)">' + ICON.trash + '</button>';
      dtb.className = 'show';
      var pos = ui.dtb, wrap = $('wrap');
      if (pos) { dtb.style.left = Math.max(0, Math.min(wrap.clientWidth - dtb.offsetWidth, pos.x)) + 'px'; dtb.style.top = Math.max(0, Math.min(wrap.clientHeight - dtb.offsetHeight, pos.y)) + 'px'; dtb.style.transform = ''; }
      else { dtb.style.left = '50%'; dtb.style.top = '.6rem'; dtb.style.transform = 'translateX(-50%)'; }
    }
    function restyle(patch){ if (!selected) return; remember(); Object.assign(selected.style, patch); setDefaults(selected.style); changed(); }
    dtb.addEventListener('click', function(e){
      var b = e.target.closest('button'); if (!b || !selected) return;
      var a = b.dataset.a, d = selected;
      if (a === 'color') {
        var before = snapshot(), touched = false;
        UI.pickColor(b, {value: d.style.color, custom: colors.get(), onCustom: colors.set,
          onChange: function(v){ if (!touched) { pushUndo(before); touched = true; } d.style.color = v; setDefaults(d.style); changed(); }});
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

    // ------------------------------------------------------------ trend line settings dialog (double-click a line, or the gear)
    function openSettings(d){
      var before = snapshot(), orig = JSON.parse(JSON.stringify(d));
      function live(){ setDefaults(d.style); redrawAll(); }
      function check(body, name, field){
        var row = UI.el('div', 'row'), lab = UI.el('label', 'name'), cb = UI.el('input'); cb.type = 'checkbox'; cb.checked = !!d.style[field];
        cb.onchange = function(){ d.style[field] = cb.checked; live(); };
        lab.appendChild(cb); lab.appendChild(document.createTextNode(name)); row.appendChild(lab); body.appendChild(row);
      }
      UI.dialog({title: 'Trend line', tabs: [
        {name:'Style', render: function(body){
          var row = UI.el('div', 'row'), ctl = UI.el('div', 'ctl');
          row.appendChild(UI.el('span', 'name', 'Line'));
          ctl.appendChild(UI.swatch(d.style.color, function(v){ d.style.color = v; live(); }, colors));
          var w = UI.el('select', null, [1,2,3,4].map(function(v){ return '<option value="' + v + '">' + v + 'px</option>'; }).join('')); w.value = d.style.width;
          w.onchange = function(){ d.style.width = +w.value; live(); };
          var st = UI.el('select', null, '<option value="0">Solid</option><option value="1">Dashed</option><option value="2">Dotted</option>'); st.value = d.style.dash;
          st.onchange = function(){ d.style.dash = +st.value; live(); };
          ctl.appendChild(w); ctl.appendChild(st); row.appendChild(ctl); body.appendChild(row);
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
      onOk: function(){ if (JSON.stringify(d) !== JSON.stringify(orig)) pushUndo(before); changed(); },
      onCancel: function(){ d.points = orig.points; d.style = orig.style; d.locked = orig.locked; setDefaults(d.style); changed(); }});
    }

    // ------------------------------------------------------------ mouse: placing, selecting, dragging
    function local(e){ var r = host.getBoundingClientRect(); return {x: e.clientX - r.left, y: e.clientY - r.top}; }
    function inPane(p){ return p.x >= 0 && p.y >= 0 && p.x < ts.width() && p.y < paneH(); }
    function take(e){ e.preventDefault(); e.stopPropagation(); }  // the chart never sees this press: no pan, no click
    function horizontal(pt, other){ return shift && other ? {t: pt.t, p: other.p} : pt; }

    host.addEventListener('mousedown', function(e){
      if (e.button !== 0 || UI.busy()) return;
      var p = local(e); if (!inPane(p)) return;
      shift = e.shiftKey;
      if (tool === 'trendline') {
        take(e);
        var a = toAnchor(p.x, p.y); if (!a) return;
        if (placing) { placing.d.points[1] = horizontal(a, placing.d.points[0]); finish(); return; }   // second click
        if (ui.hide || ui.lock) { ui.hide = ui.lock = false; saveUi(); sideButtons(); }   // a new drawing shows them again, like TradingView
        placing = {d: {id:newId(), type:'trendline', points:[a, a], style:Object.assign({}, defaults)}, from:p, down:true, dragged:false};
        redrawAll(); return;
      }
      var h = hitAt(p.x, p.y);
      if (!h) { lastDown = null; if (selected) { selected = null; redrawAll(); } return; }   // empty chart: deselect and let it pan
      take(e);
      var dbl = e.detail >= 2 && lastDown && lastDown.d === h.d;  // double-click = settings
      lastDown = dbl ? null : {d:h.d};
      selected = h.d; hover = null;
      if (dbl) { drag = null; redrawAll(); openSettings(h.d); return; }
      if (!ui.lock && !h.d.locked) {
        drag = {d:h.d, part:h.part, from:p, before:snapshot(), moved:false, l0: ts.coordinateToLogical(p.x),
                orig: h.d.points.map(function(pt){ var q = toPx(pt); return {l: q.l, y: q.y}; })};
      }
      redrawAll();
    }, true);

    function move(p){
      lastMove = p;
      if (placing) {
        if (placing.down && Math.hypot(p.x - placing.from.x, p.y - placing.from.y) > DRAG_MIN) placing.dragged = true;
        var a = toAnchor(p.x, p.y); if (a) placing.d.points[1] = horizontal(a, placing.d.points[0]);
        requestUpdate(); return;
      }
      if (drag) {
        if (!drag.moved && Math.hypot(p.x - drag.from.x, p.y - drag.from.y) <= DRAG_MIN) return;
        if (!drag.moved) { drag.moved = true; host.style.cursor = 'grabbing'; }
        var d = drag.d;
        if (drag.part === 'line') {
          var l1 = ts.coordinateToLogical(p.x); if (l1 === null || drag.l0 === null) return;
          var dl = Math.round(l1 - drag.l0), dy = p.y - drag.from.y;
          if (shift) { if (Math.abs(p.x - drag.from.x) >= Math.abs(dy)) dy = 0; else dl = 0; }   // Shift: straight across or straight up/down
          var pts = drag.orig.map(function(o){ var pr = series.coordinateToPrice(o.y + dy), t = app.logicalToTime(o.l + dl); return pr === null || t === null ? null : {t:t, p:pr}; });
          if (pts[0] && pts[1]) d.points = pts;
        } else {
          var a2 = toAnchor(p.x, p.y); if (!a2) return;
          d.points[drag.part] = horizontal(a2, d.points[1 - drag.part]);
        }
        requestUpdate(); return;
      }
      if (tool === 'cursor' && !UI.busy()) {                     // hover: show the ends of the line under the mouse
        var h = inPane(p) ? hitAt(p.x, p.y) : null, d2 = h ? h.d : null;
        if (d2 !== hover) { hover = d2; requestUpdate(); }
      }
    }
    document.addEventListener('mousemove', function(e){
      if (!placing && !drag && !host.contains(e.target)) { if (hover) { hover = null; requestUpdate(); } return; }
      shift = e.shiftKey; move(local(e));
    });
    document.addEventListener('mouseup', function(e){
      if (e.button !== 0) return;
      var p = local(e); shift = e.shiftKey;
      if (placing) {
        placing.down = false;
        if (placing.dragged) { move(p); finish(); }             // press, drag, release: done
        return;                                                  // a click: the second click places the other end
      }
      if (drag) {
        var dr = drag; drag = null; host.style.cursor = '';
        if (dr.moved) { pushUndo(dr.before); changed(); } else redrawAll();
      }
    });
    host.addEventListener('dblclick', function(e){                // the chart's own double-click stays off drawings
      var p = local(e); if (tool === 'cursor' && inPane(p) && hitAt(p.x, p.y)) take(e);
    }, true);
    function finish(){
      var d = placing.d; placing = null;
      var a = toPx(d.points[0]), b = toPx(d.points[1]);
      if (!a || !b || (Math.abs(a.x - b.x) < 1 && Math.abs(a.y - b.y) < 1)) { redrawAll(); return; }   // nothing drawn
      remember(); items.push(d);
      if (!ui.stay) setTool('cursor');
      selected = d;                                              // the new line stays selected, its toolbar shows
      changed();
    }

    // ------------------------------------------------------------ keyboard
    document.addEventListener('keydown', function(e){
      if (e.key === 'Shift' && !shift) { shift = true; if (lastMove && (placing || drag)) move(lastMove); }
      if (UI.busy(e) || $('picker').classList.contains('show')) return;
      var ctrl = e.ctrlKey || e.metaKey, k = e.key.toLowerCase();
      if (e.key === 'Escape') {                                  // cancel what is being drawn, back to the cursor, nothing selected
        placing = null;
        if (tool !== 'cursor') setTool('cursor');
        selected = null; redrawAll();
      }
      else if ((e.key === 'Delete' || e.key === 'Backspace') && selected && !drag && !selected.locked && !ui.lock) { e.preventDefault(); remove(selected); }
      else if (e.altKey && ctrl && e.code === 'KeyH') { e.preventDefault(); toggleHide(); }
      else if (e.altKey && !ctrl && e.code === 'KeyT') { e.preventDefault(); setTool('trendline'); }
      else if (ctrl && k === 'z' && !e.shiftKey) { e.preventDefault(); doUndo(); }
      else if (ctrl && (k === 'y' || (k === 'z' && e.shiftKey))) { e.preventDefault(); doRedo(); }
    });
    document.addEventListener('keyup', function(e){ if (e.key === 'Shift') { shift = false; if (lastMove && (placing || drag)) move(lastMove); } });
    addEventListener('blur', function(){ shift = false; });

    return {
      setMarket: setMarket,
      refresh: function(){ requestUpdate(); if (selected) toolbar(); },
      flush: flush,
      _state: function(){ return {tool:tool, items:items, selected:selected && selected.id, undo:undo.length, redo:redo.length, placing:!!placing}; },   // tests, console
      _px: function(i){ return items[i] ? items[i].points.map(toPx) : null; }
    };
  };
})();
