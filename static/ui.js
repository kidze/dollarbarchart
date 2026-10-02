/* Small UI kit shared by the page: colors, the TradingView-style color picker (palette + custom colors + opacity),
   drop-down menus and draggable dialogs. Plain script, exposes window.UI. */
(function(){
  'use strict';
  var $ = function(id){ return document.getElementById(id); };
  var esc = function(s){ return String(s).replace(/[&<>"]/g, function(c){ return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]; }); };
  function el(tag, cls, html){ var e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; }

  // ---------------------------------------------------------------- colors: stored as 'rgba(r,g,b,a)' strings
  function parse(s){
    s = String(s || '').trim();
    var m = /^#([0-9a-f]{3,8})$/i.exec(s);
    if (m) {
      var h = m[1];
      if (h.length === 3 || h.length === 4) h = h.split('').map(function(c){ return c + c; }).join('');
      if (h.length !== 6 && h.length !== 8) return null;
      return {r:parseInt(h.slice(0,2),16), g:parseInt(h.slice(2,4),16), b:parseInt(h.slice(4,6),16), a: h.length === 8 ? parseInt(h.slice(6,8),16)/255 : 1};
    }
    m = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/i.exec(s);
    if (m) return {r:+m[1], g:+m[2], b:+m[3], a: m[4] === undefined ? 1 : Math.max(0, Math.min(1, +m[4]))};
    return null;
  }
  function rgba(c){ return 'rgba(' + Math.round(c.r) + ',' + Math.round(c.g) + ',' + Math.round(c.b) + ',' + (+c.a.toFixed(3)) + ')'; }
  function hex(c){ return '#' + [c.r, c.g, c.b].map(function(v){ return ('0' + Math.round(v).toString(16)).slice(-2); }).join('').toUpperCase(); }
  function withAlpha(s, a){ var c = parse(s) || {r:0,g:0,b:0,a:1}; c.a = a; return rgba(c); }
  function norm(s){ var c = parse(s); return c ? rgba(c) : s; }

  // TradingView's palette (its 2026 color tokens): a row of greys, a row of base hues, then six rows from lightest tint to darkest shade
  var PALETTE = [
    ['#FFFFFF','#DBDBDB','#B8B8B8','#9C9C9C','#808080','#636363','#4A4A4A','#2E2E2E','#0F0F0F','#000000'],
    ['#F23645','#FF9800','#FFEB3B','#4CAF50','#089981','#00BCD4','#2962FF','#673AB7','#9C27B0','#E91E63'],
    ['#FCCBCD','#FFE0B2','#FFF9C4','#C8E6C9','#ACE5DC','#B2EBF2','#BBD9FB','#D1C4E9','#E1BEE7','#F8BBD0'],
    ['#FAA1A4','#FFCC80','#FFF59D','#A5D6A7','#70CCBD','#80DEEA','#90BFF9','#B39DDB','#CE93D8','#F48FB1'],
    ['#F77C80','#FFB74D','#FFF176','#81C784','#42BDA8','#4DD0E1','#5B9CF6','#9575CD','#BA68C8','#F06292'],
    ['#F7525F','#FFA726','#FFEE58','#66BB6A','#22AB94','#26C6DA','#3179F5','#7E57C2','#AB47BC','#EC407A'],
    ['#B22833','#F57C00','#FBC02D','#388E3C','#056656','#0097A7','#1848CC','#512DA8','#7B1FA2','#C2185B'],
    ['#801922','#E65100','#F57F17','#1B5E20','#00332A','#006064','#0C3299','#311B92','#4A148C','#880E4F']
  ];

  // things that close when you click elsewhere or press Esc: only one at a time
  var popup = null, dismissed = null;                            // dismissed: the press that closed a popup does nothing else
  function closePopup(){ if (popup) { var p = popup; popup = null; p.close(); } }
  document.addEventListener('pointerdown', function(e){ if (popup && !popup.el.contains(e.target) && !(popup.anchor && popup.anchor.contains(e.target))) { closePopup(); dismissed = e; } }, true);
  document.addEventListener('keydown', function(e){ if (e.key === 'Escape' && popup) { e.stopImmediatePropagation(); closePopup(); } }, true);   // Esc closes the picker, not the dialog under it
  function place(box, anchor){
    var r = anchor.getBoundingClientRect(), w = box.offsetWidth, h = box.offsetHeight;
    var x = Math.min(r.left, innerWidth - w - 8), y = r.bottom + 6;
    if (y + h > innerHeight - 8) y = Math.max(8, r.top - h - 6);
    box.style.left = Math.max(8, x) + 'px'; box.style.top = y + 'px';
  }

  /* Color picker. opts: {value, onChange(rgba), custom: [rgba...] (remembered custom colors), onCustom(list), opacity: true} */
  function pickColor(anchor, opts){
    closePopup();
    var c = parse(opts.value) || {r:41,g:98,b:255,a:1};
    var box = el('div', 'cpick');
    var grid = el('div', 'grid');
    PALETTE.forEach(function(row, i){
      row.forEach(function(h){ var b = el('button', 'c'); b.style.background = h; b.dataset.hex = h; b.title = h; grid.appendChild(b); });
      if (i === 1) grid.appendChild(el('i', 'gap'));
    });
    box.appendChild(grid);
    box.appendChild(el('hr'));
    var custom = el('div', 'custom');
    box.appendChild(custom);
    var op = el('div', 'op', '<span>Opacity</span><div class="track chk"><i></i><b class="knob"></b></div><input type="text" inputmode="numeric">');
    if (opts.opacity !== false) { box.appendChild(el('hr')); box.appendChild(op); }
    var native = el('input'); native.type = 'color'; native.style.cssText = 'position:absolute;width:0;height:0;opacity:0;border:0;padding:0';
    box.appendChild(native);
    var track = op.querySelector('.track'), fill = track.querySelector('i'), knob = track.querySelector('.knob'), num = op.querySelector('input');

    function sync(){
      var h = hex(c);
      Array.prototype.forEach.call(box.querySelectorAll('.c'), function(b){ b.classList.toggle('on', b.dataset.hex.toUpperCase() === h); });
      fill.style.background = 'linear-gradient(to right, rgba(' + c.r + ',' + c.g + ',' + c.b + ',0), rgb(' + c.r + ',' + c.g + ',' + c.b + '))';
      knob.style.left = (c.a * 100) + '%';
      if (document.activeElement !== num) num.value = Math.round(c.a * 100) + '%';
    }
    function emit(){ sync(); opts.onChange(rgba(c)); }
    function drawCustom(){
      custom.innerHTML = '';
      (opts.custom || []).forEach(function(s){ var p = parse(s); if (!p) return; var b = el('button', 'c'); b.style.background = hex(p); b.dataset.hex = hex(p); b.title = hex(p); custom.appendChild(b); });
      var add = el('button', 'add', '+'); add.title = 'Add a custom color';
      add.onclick = function(){ native.value = hex(c).toLowerCase(); native.click(); };
      custom.appendChild(add);
      sync();
    }
    box.addEventListener('click', function(e){
      var b = e.target.closest('.c'); if (!b) return;
      var p = parse(b.dataset.hex); c.r = p.r; c.g = p.g; c.b = p.b; emit();
    });
    native.addEventListener('input', function(){ var p = parse(native.value); if (p) { c.r = p.r; c.g = p.g; c.b = p.b; emit(); } });
    native.addEventListener('change', function(){
      var h = hex(c), list = (opts.custom || []).filter(function(s){ var p = parse(s); return p && hex(p) !== h; });
      list.unshift(h); opts.custom = list.slice(0, 29);                    // TradingView keeps 29
      if (opts.onCustom) opts.onCustom(opts.custom);
      drawCustom();
    });
    function dragOpacity(e){
      var r = track.getBoundingClientRect();
      c.a = Math.round(Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * 100) / 100; emit();
    }
    track.addEventListener('pointerdown', function(e){
      track.setPointerCapture(e.pointerId); dragOpacity(e);
      var mv = function(ev){ dragOpacity(ev); }, up = function(){ track.removeEventListener('pointermove', mv); track.removeEventListener('pointerup', up); };
      track.addEventListener('pointermove', mv); track.addEventListener('pointerup', up);
    });
    num.addEventListener('change', function(){ var v = parseFloat(num.value); if (!isNaN(v)) { c.a = Math.max(0, Math.min(100, v)) / 100; } num.value = ''; emit(); });
    num.addEventListener('keydown', function(e){ if (e.key === 'Enter') num.blur(); });

    document.body.appendChild(box);
    drawCustom();
    place(box, anchor);
    popup = {el: box, anchor: anchor, close: function(){ box.remove(); if (opts.onClose) opts.onClose(); }};
  }

  /* A drop-down list under `anchor`. items: [{html, on, onClick}] */
  function menu(anchor, items){
    closePopup();
    var box = el('div', 'menu');
    items.forEach(function(it){
      var b = el('button', it.on ? 'on' : '', it.html);
      b.onclick = function(){ closePopup(); it.onClick(); };
      box.appendChild(b);
    });
    document.body.appendChild(box);
    place(box, anchor);
    popup = {el: box, anchor: anchor, close: function(){ box.remove(); }};
  }

  /* A modal dialog: {title, tabs: [{name, render(body)}], onOk, onCancel, extra: [{html, onClick}] (left of the buttons)}.
     Dragging the title moves it; Esc = cancel, Enter = Ok (unless a field or button has the focus: a focused button does its own thing). */
  function dialog(o){
    closePopup();
    var m = el('div', 'modal'), d = el('div', 'dlg');
    d.innerHTML = '<h3><span>' + esc(o.title) + '</span><button class="x" title="Close">×</button></h3>' +
      (o.tabs.length > 1 ? '<div class="tabs">' + o.tabs.map(function(t, i){ return '<button data-i="' + i + '">' + esc(t.name) + '</button>'; }).join('') + '</div>' : '') +
      '<div class="body"></div><div class="foot"><span class="grow"></span><button class="btn cancel">Cancel</button><button class="btn pri ok">Ok</button></div>';
    m.appendChild(d); document.body.appendChild(m);
    var body = d.querySelector('.body'), done = false;
    (o.extra || []).forEach(function(x){ var b = el('button', 'btn link', x.html); b.onclick = x.onClick; d.querySelector('.foot').insertBefore(b, d.querySelector('.grow')); });
    function show(i){
      Array.prototype.forEach.call(d.querySelectorAll('.tabs button'), function(b){ b.classList.toggle('on', +b.dataset.i === i); });
      body.innerHTML = ''; o.tabs[i].render(body);
    }
    function close(ok){
      if (done) return; done = true; closePopup(); m.remove(); document.removeEventListener('keydown', key, true);
      (ok ? o.onOk : o.onCancel || function(){})();
    }
    function key(e){
      if (popup) return;
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(false); }
      else if (e.key === 'Enter' && !/INPUT|SELECT|TEXTAREA|BUTTON/.test(document.activeElement.tagName)) { e.preventDefault(); close(true); }
    }
    document.addEventListener('keydown', key, true);
    d.querySelector('.x').onclick = function(){ close(false); };
    d.querySelector('.cancel').onclick = function(){ close(false); };
    d.querySelector('.ok').onclick = function(){ close(true); };
    m.addEventListener('pointerdown', function(e){ if (e.target === m && e !== dismissed) close(false); });   // a click that only closed a color picker keeps the dialog
    Array.prototype.forEach.call(d.querySelectorAll('.tabs button'), function(b){ b.onclick = function(){ show(+b.dataset.i); }; });
    var h3 = d.querySelector('h3');
    h3.addEventListener('pointerdown', function(e){
      if (e.target.closest('.x')) return;
      var r = d.getBoundingClientRect(), dx = e.clientX - r.left, dy = e.clientY - r.top;
      d.style.position = 'fixed'; d.style.margin = '0';
      h3.setPointerCapture(e.pointerId);
      var mv = function(ev){ d.style.left = Math.max(0, Math.min(innerWidth - 60, ev.clientX - dx)) + 'px'; d.style.top = Math.max(0, Math.min(innerHeight - 40, ev.clientY - dy)) + 'px'; };
      var up = function(){ h3.removeEventListener('pointermove', mv); h3.removeEventListener('pointerup', up); };
      h3.addEventListener('pointermove', mv); h3.addEventListener('pointerup', up);
    });
    show(0);
    return {close: close, el: d};
  }

  /* A color swatch button for dialogs: shows the color over a checkerboard (so transparency is visible) */
  function swatch(value, onChange, store){
    var b = el('button', 'swatch chk'), i = el('i'); b.appendChild(i);
    var cur = value;
    function paint(){ i.style.background = cur; }
    b.onclick = function(){
      if (b.disabled) return;
      pickColor(b, {value: cur, custom: store ? store.get() : [], onCustom: store ? store.set : null,
                    onChange: function(v){ cur = v; paint(); onChange(v); }});
    };
    paint();
    b.set = function(v){ cur = v; paint(); };
    return b;
  }

  window.UI = {$: $, esc: esc, el: el, parse: parse, rgba: rgba, hex: hex, withAlpha: withAlpha, norm: norm,
               PALETTE: PALETTE, pickColor: pickColor, menu: menu, dialog: dialog, swatch: swatch, closePopup: closePopup,
               // true while a picker, menu or dialog has the keyboard: the chart's shortcuts stand down
               busy: function(e){ return !!popup || !!document.querySelector('.modal') || (e && /INPUT|SELECT|TEXTAREA/.test(e.target.tagName)); }};
})();
