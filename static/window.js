/* The app window remembers its size and place, like a desktop app (data/settings.json, key 'window').

   Edge opens an --app window at the size of the Edge window used last, and when Edge is already running it ignores size
   flags (tested 2026-10-07: --window-size, --app-window-size, --window-position; a freshly started Edge would apply them to
   every window it opens afterwards, so launch.cmd passes none). An app window may move and resize itself, so the page puts
   its window back. Nothing saved yet: 90% of the screen's work area, centred. A maximized window is remembered as "fills the
   work area" (a page cannot maximize its window).

   Screens: a page may not move its window to another screen (Edge keeps it on the screen it opened on unless the site has the
   window-management permission), so the place is saved relative to its screen's work area and restored at the same spot on
   the screen Edge opens it on (the screen of the Edge window used last).

   Only in the app window (display-mode: standalone); a browser tab is left alone. A reload (F5, Update now) leaves the
   window where it is once a size is saved; before that it gets the default too, so the update bringing this file in does not
   save the old Edge-chosen size. A second app window steps 30 px down and right of the first instead of covering it.
   Only what the user does is saved, not the page's own placing: moves fire no event, so the window is checked on resize,
   every second and as it closes; the window closed last wins. Exposes window.DBCWindow(store). */
(function(){
  'use strict';
  var MIN_W = 400, MIN_H = 300, STEP = 30, SETTLE_MS = 1500;

  function area(s){ return {l: s.availLeft || 0, t: s.availTop || 0, w: s.availWidth, h: s.availHeight}; }

  // where the window goes: saved {x, y, w, h, sx, sy, max} (sx, sy: top left of its screen's work area) or nothing, on screen s
  function target(saved, s){
    var a = area(s);
    if (saved && saved.max) return {x:a.l, y:a.t, w:a.w, h:a.h};
    if (!saved || !(saved.w >= MIN_W && saved.h >= MIN_H) || !isFinite(saved.x) || !isFinite(saved.y)) {
      var w = Math.round(a.w * 0.9), h = Math.round(a.h * 0.9);
      return {x: a.l + Math.round((a.w - w) / 2), y: a.t + Math.round((a.h - h) / 2), w: w, h: h};
    }
    var x = saved.x, y = saved.y;
    if (isFinite(saved.sx) && isFinite(saved.sy)) { x += a.l - saved.sx; y += a.t - saved.sy; }   // the same spot on this screen
    var w2 = Math.min(saved.w, a.w), h2 = Math.min(saved.h, a.h);
    return {x: Math.max(a.l, Math.min(a.l + a.w - w2, x)), y: Math.max(a.t, Math.min(a.t + a.h - h2, y)), w: w2, h: h2};
  }

  window.DBCWindow = function(store){
    var api = {target: target, placed: null};
    if (!matchMedia('(display-mode: standalone)').matches) return api;      // a browser tab: not ours to size

    var nav = (performance.getEntriesByType && performance.getEntriesByType('navigation')[0]) || {};
    var fresh = nav.type !== 'reload', saved = store.get('window'), settling = 0, put = null;
    if (fresh || !saved) {
      var t = put = api.placed = target(saved, screen);
      settling = Date.now() + SETTLE_MS;
      moveTo(t.x, t.y); resizeTo(t.w, t.h); moveTo(t.x, t.y);               // move again: a move before the resize can be held back by the old size
    }

    // a second window: the one already open answers, the new one steps aside from where it was put (smaller if it would leave
    // the work area). From that place, not screenX/outerWidth: those lag behind the page's own move, and do not change at all
    // while other windows cover this one.
    var me = Math.random().toString(36).slice(2), stepped = false;
    var ch = window.BroadcastChannel ? new BroadcastChannel('dollarbars-window') : null;
    if (ch) {
      ch.onmessage = function(e){
        var m = e.data || {}, p = api.placed;
        if (m.hello && m.hello !== me) ch.postMessage({here: me, to: m.hello});
        else if (m.to === me && !stepped && p) {
          stepped = true; settling = Date.now() + SETTLE_MS;
          var a = area(screen), w = Math.min(p.w, a.l + a.w - p.x - STEP), h = Math.min(p.h, a.t + a.h - p.y - STEP);
          if (w >= MIN_W && h >= MIN_H) { put = {x: p.x + STEP, y: p.y + STEP, w: w, h: h}; moveTo(put.x, put.y); resizeTo(w, h); moveTo(put.x, put.y); }
        }
      };
      if (fresh) ch.postMessage({hello: me});
    }

    var last = JSON.stringify(saved || null), mine = false;
    function check(closing){
      var a = area(screen), b = {x: screenX, y: screenY, w: outerWidth, h: outerHeight, sx: a.l, sy: a.t};
      if (b.w < MIN_W || b.h < MIN_H || b.x < -20000 || b.y < -20000) return;   // minimized: Windows reports -32000,-32000 and 160x28
      // (not visibilityState: a window that other windows cover completely also reads 'hidden', and it can still be moved)
      var v = b.w >= a.w && b.h >= a.h ? Object.assign({}, store.get('window') || b, {max: true}) : b;   // maximized: keep the size it had before
      var j = JSON.stringify(v);
      if (j !== last) {
        last = j;
        // the page's own placing, not the user's (also when it shows late: the window was covered as it opened)
        if (Date.now() < settling || (!mine && put && b.x === put.x && b.y === put.y && b.w === put.w && b.h === put.h)) return;
        mine = true; store.set('window', v);
      }
      else if (closing && mine) store.set('window', v);                     // closed last: its place wins over another window's
    }
    addEventListener('resize', function(){ check(false); });
    setInterval(function(){ check(false); }, 1000);
    addEventListener('pagehide', function(){ check(true); store.flush(true); });
    return api;
  };
})();
