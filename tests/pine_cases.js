/* The Pine engine (static/pine.js) on made-up bars: small scripts, each checked against what Pine gives for them.
   tests/test_pine.py opens this in a headless browser; the page writes the results as JSON into <pre id="out">. It can
   also be opened by hand next to a page that loads static/pine.js first. */
(function(){
  'use strict';
  var results = [], T0 = Date.UTC(2026, 0, 1), pending = [];
  function test(name, fn){ try { fn(); results.push({name: name, ok: true}); } catch (e) { results.push({name: name, ok: false, msg: String(e && e.stack || e)}); } }
  function later(name, fn){ pending.push({name: name, fn: fn}); }   // fn(done) for cases that wait for the worker's timer
  function assert(c, msg){ if (!c) throw new Error(msg || 'assertion failed'); }
  function near(x, y){ return (x !== x && y !== y) || x === y || (typeof x === 'number' && typeof y === 'number' && Math.abs(x - y) <= 1e-9 * Math.max(1, Math.abs(x), Math.abs(y))); }
  function same(a, b, path){
    path = path || 'value';
    if (typeof a === 'number' || typeof b === 'number') { if (!near(a, b)) throw new Error(path + ': ' + a + ' is not ' + b); return; }
    if (a === b) return;
    if (!a || !b || typeof a !== 'object' || typeof b !== 'object') throw new Error(path + ': ' + JSON.stringify(a) + ' is not ' + JSON.stringify(b));
    var ka = Object.keys(a).filter(function(k){ return a[k] !== undefined; }), kb = Object.keys(b).filter(function(k){ return b[k] !== undefined; });
    if (a.length !== undefined || b.length !== undefined) { if (a.length !== b.length) throw new Error(path + ': length ' + a.length + ' is not ' + b.length); }
    else if (ka.sort().join() !== kb.sort().join()) throw new Error(path + ': keys ' + ka.join() + ' are not ' + kb.join());
    for (var i = 0; i < ka.length; i++) same(a[ka[i]], b[ka[i]], path + '.' + ka[i]);
  }
  function arr(x){ return Array.prototype.slice.call(x); }

  // bars: a random walk that is the same on every run
  function walk(n, seed){
    var s = seed || 7, x = 100, rows = [];
    function rnd(){ s = (s * 16807) % 2147483647; return s / 2147483647; }
    for (var i = 0; i < n; i++) {
      var o = x, c = Math.round((x + (rnd() - 0.5) * 4) * 100) / 100;
      rows.push({o: o, h: Math.max(o, c) + Math.round(rnd() * 100) / 100, l: Math.min(o, c) - Math.round(rnd() * 100) / 100, c: c, v: 10 + Math.round(rnd() * 90)});
      x = c;
    }
    return rows;
  }
  function data(rows, conf){
    var n = rows.length, D = {n: n, conf: conf === undefined ? n : conf};
    ['t', 'e', 'o', 'h', 'l', 'c', 'v'].forEach(function(k){ D[k] = new Float64Array(Math.max(n, 1)); });
    rows.forEach(function(r, i){ D.t[i] = T0 + i * 6e4; D.e[i] = T0 + (i + 1) * 6e4; D.o[i] = r.o; D.h[i] = r.h; D.l[i] = r.l; D.c[i] = r.c; D.v[i] = r.v; });
    return D;
  }
  function run(src, D, opt){ var r = new Pine.Run(src, opt || {}); r.advance(D, 0, D.conf); return r; }
  function plots(r){ return r.output(0).outs.map(function(o){ return o.v ? arr(o.v) : null; }); }
  function errOf(src){ try { run(src, data(walk(5))); } catch (e) { return e; } return null; }
  function head(v, title, more){ return '//@version=' + v + '\n' + (v < 5 ? 'study' : 'indicator') + '("' + (title || 't') + '", overlay = true' + (more || '') + ')\n'; }
  var rows = walk(60), D = data(rows), C = rows.map(function(r){ return r.c; });

  // ------------------------------------------------------------ the language
  test('plot close', function(){ same(plots(run(head(5) + 'plot(close)', D))[0], C); });

  test('var keeps its value; history of a variable', function(){
    var p = plots(run(head(5) + 'var c = 0\nc += 1\nplot(c)\nplot(c[1])\nplot(nz(c[2], -1))', D));
    same(p[0], C.map(function(_, i){ return i + 1; }));
    same(p[1], C.map(function(_, i){ return i ? i : NaN; }));
    same(p[2], C.map(function(_, i){ return i > 1 ? i - 1 : -1; }));
  });

  test('history of a series and of an expression', function(){
    var p = plots(run(head(5) + 'plot(close[2])\nplot((close + open)[1])\nplot(ta.sma(close, 2)[1])', D));
    same(p[0], C.map(function(_, i){ return i > 1 ? C[i - 2] : NaN; }));
    same(p[1], C.map(function(_, i){ return i ? C[i - 1] + rows[i - 1].o : NaN; }));
    same(p[2], C.map(function(_, i){ return i > 1 ? (C[i - 1] + C[i - 2]) / 2 : NaN; }));
  });

  test('ta.sma ema rma atr highest lowest change stdev', function(){
    var p = plots(run(head(5) + 'plot(ta.sma(close, 3))\nplot(ta.ema(close, 3))\nplot(ta.rma(close, 3))\nplot(ta.atr(3))\n' +
                     'plot(ta.highest(high, 4))\nplot(ta.lowest(low, 4))\nplot(ta.change(close))\nplot(ta.stdev(close, 5))', D));
    var sma = [], ema = [], rma = [], tr = [], atr = [], hi = [], lo = [], ch = [], sd = [];
    for (var i = 0; i < C.length; i++) {
      sma[i] = i < 2 ? NaN : (C[i] + C[i - 1] + C[i - 2]) / 3;
      ema[i] = i < 2 ? NaN : i === 2 ? sma[2] : 0.5 * C[i] + 0.5 * ema[i - 1];
      rma[i] = i < 2 ? NaN : i === 2 ? sma[2] : C[i] / 3 + rma[i - 1] * 2 / 3;
      var r = rows[i];
      tr[i] = i === 0 ? r.h - r.l : Math.max(r.h - r.l, Math.abs(r.h - C[i - 1]), Math.abs(r.l - C[i - 1]));
      atr[i] = i < 2 ? NaN : i === 2 ? (tr[0] + tr[1] + tr[2]) / 3 : tr[i] / 3 + atr[i - 1] * 2 / 3;
      hi[i] = i < 3 ? NaN : Math.max(rows[i].h, rows[i - 1].h, rows[i - 2].h, rows[i - 3].h);
      lo[i] = i < 3 ? NaN : Math.min(rows[i].l, rows[i - 1].l, rows[i - 2].l, rows[i - 3].l);
      ch[i] = i ? C[i] - C[i - 1] : NaN;
      if (i < 4) sd[i] = NaN;
      else { var w = C.slice(i - 4, i + 1), m = w.reduce(function(a, b){ return a + b; }) / 5; sd[i] = Math.sqrt(w.reduce(function(a, b){ return a + (b - m) * (b - m); }, 0) / 5); }
    }
    same(p, [sma, ema, rma, atr, hi, lo, ch, sd]);
  });

  test('ta.highest leaves na out of the window', function(){
    var p = plots(run(head(5) + 'x = bar_index % 3 == 0 ? na : close\nplot(ta.highest(x, 3))', D))[0];
    same(p, C.map(function(_, i){
      if (i < 2) return NaN;
      var w = [i - 2, i - 1, i].filter(function(j){ return j % 3 !== 0; }).map(function(j){ return C[j]; });
      return Math.max.apply(null, w);
    }));
  });

  test('if, else if, ternaries, for ... by, while, switch, break, continue', function(){
    var p = plots(run(head(5) +
      'x = close > open ? 1 : close < open ? -1 : 0\n' +
      'y = if x > 0\n    10\nelse if x < 0\n    -10\nelse\n    0\n' +
      's = 0\nfor i = 8 to 0 by 1\n    s += i\n' +
      't = 0\nfor i = 0 to 10 by 2\n    if i == 6\n        continue\n    if i == 10\n        break\n    t += i\n' +
      'w = 0\nk = 0\nwhile k < 5\n    k += 1\n    w += k\n' +
      'sw = switch\n    close > open => 1\n    => 2\n' +
      'plot(x)\nplot(y)\nplot(s)\nplot(t)\nplot(w)\nplot(sw)', D));
    var x = rows.map(function(r){ return r.c > r.o ? 1 : r.c < r.o ? -1 : 0; });
    same(p[0], x);
    same(p[1], x.map(function(v){ return v * 10; }));
    same(p[2], C.map(function(){ return 36; }));
    same(p[3], C.map(function(){ return 14; }));
    same(p[4], C.map(function(){ return 15; }));
    same(p[5], rows.map(function(r){ return r.c > r.o ? 1 : 2; }));
  });

  test('every call of a function has its own history and var', function(){
    var p = plots(run(head(5) + 'prev(x) => x[1]\na = prev(close)\nb = prev(open)\nf(x) =>\n    var n = 0\n    n += 1\n    n + x\n' +
                     'plot(a)\nplot(b)\nplot(f(0))\nplot(f(100))', D));
    same(p[0], C.map(function(_, i){ return i ? C[i - 1] : NaN; }));
    same(p[1], C.map(function(_, i){ return i ? rows[i - 1].o : NaN; }));
    same(p[2], C.map(function(_, i){ return i + 1; }));
    same(p[3], C.map(function(_, i){ return 101 + i; }));
  });

  test('lines that wrap; comments; strings', function(){
    var r = run('//@version=5\nindicator("t",\n     overlay = true)\nx = close +\n     open // a comment\ny = (close\n  + open)\nplot(x - y)\n' +
                'var label l = label.new(0, 0, "")\n' +
                'label.set_text(l, str.tostring(1.5) + "|" + str.tostring(2) + "|" + str.format("{0} {1}", 1234.5678, "a") + "|" + ' +
                'str.tostring(0.123456, "#.##") + "|" + str.tostring(true) + "|" + \'q"\\n\')', D);
    same(plots(r)[0], C.map(function(){ return 0; }));
    same(r.output(0).labels[0].text, '1.5|2|1,234.568 a|0.12|true|q"\n');
  });

  test('v4 and v5 divide fixed whole numbers as whole numbers, v6 does not', function(){
    var src = 'h = 15\nplot(5 / 2)\nplot(h / 2)\nplot(close / 2)';
    same(plots(run(head(5) + src, D)).map(function(p){ return p[0]; }), [2, 7, C[0] / 2]);
    same(plots(run(head(4) + src, D)).map(function(p){ return p[0]; }), [2, 7, C[0] / 2]);
    same(plots(run(head(6) + src, D)).map(function(p){ return p[0]; }), [2.5, 7.5, C[0] / 2]);
  });

  test('v6 works out "and" lazily, v5 both sides', function(){
    var src = 'mk() =>\n    label.new(bar_index, close, "x")\n    true\nx = close < 0 and mk()\nplot(x ? 1 : 0)';
    same(run(head(6) + src, data(walk(10))).output(0).labels.length, 0);
    same(run(head(5) + src, data(walk(10))).output(0).labels.length, 10);
  });

  test('a v4 script: study(), input(type = input.bool), atr(), lowest(), a variable named atr, labels', function(){
    var r = run('//@version=4\nstudy("t", overlay = true)\nshowwave = input(title = "Show wave line?", type = input.bool, defval = false)\n' +
                'atr = 1*atr(3)\nlowest5 = lowest(close, 5)\n' +
                'var lbl = label.new(bar_index, close, text = "", style = label.style_none, yloc = yloc.belowbar)\n' +
                'if close < lowest5[1]\n    label.set_x(lbl, bar_index)\n    label.set_text(lbl, "C")\nplot(atr)', D);
    var info = r.info(), o = r.output(0), last = -1;
    same(info.inputs.map(function(s){ return [s.key, s.type, s.value]; }), [['Show wave line?', 'bool', false]]);
    for (var i = 5; i < C.length; i++) if (C[i] < Math.min.apply(null, C.slice(i - 5, i))) last = i;
    assert(last > 0, 'the test bars have a new low');
    same(o.labels.length, 1);
    same([o.labels[0].x, o.labels[0].text, o.labels[0].style, o.labels[0].yloc, o.labels[0].color], [last, 'C', 'none', 'bl', Pine.palette(4).blue]);
  });

  // ------------------------------------------------------------ drawings
  test('only the last max_labels_count labels stay', function(){
    var o = run(head(5, 't', ', max_labels_count = 5') + 'label.new(bar_index, close, str.tostring(bar_index))', D).output(0);
    same(o.labels.map(function(l){ return l.text; }), ['55', '56', '57', '58', '59']);
  });

  test('line.new, line.set_x2, line.delete', function(){
    var o = run(head(5) + 'var line l = na\nif bar_index % 10 == 0\n    line.delete(l)\n    l := line.new(bar_index, close, bar_index, close)\n' +
                'line.set_x2(l, bar_index)', data(walk(35))).output(0);
    same(o.lines.length, 1);
    same([o.lines[0].x1, o.lines[0].x2, o.lines[0].width, o.lines[0].style], [30, 34, 1, 'solid']);
  });

  test('methods on drawings (v6): lbl.set_text()', function(){
    var o = run(head(6) + 'var l = label.new(0, 0, "a")\nl.set_text("b" + str.tostring(bar_index))\nl.set_x(bar_index)', D).output(0);
    same([o.labels[0].text, o.labels[0].x], ['b59', 59]);
  });

  test('plotshape, plotchar: the bars they show on, offset, show_last, colors, v4 transp', function(){
    var r = run(head(4) + 'plotshape(close > open, style=shape.triangleup, location=location.belowbar, color=color.green, transp=50, text="up")\n' +
                'plotchar(close < open, char="9", color=color.red, offset=-2, show_last=5)', D);
    var o = r.output(0), info = r.info(), up = [], dn = [];
    rows.forEach(function(x, i){ if (x.c > x.o) up.push(i); if (x.c < x.o) dn.push(i); });
    same(o.outs[0].b, up);
    var green = Pine.palette(4).green;
    same(o.outs[0].c[0], Math.floor(green / 256) * 256 + Math.round(255 * 0.5));
    // show_last = 5 with offset -2: the chart shows the bars from 57 on; what is older than that (and a margin) is let go
    var keep = dn.filter(function(b){ return b >= 60 - 5 + 2 - Pine.SOFT - 2; });
    same(o.outs[1].b, keep);
    assert(dn.filter(function(b){ return b - 2 >= 60 - 5; }).every(function(b){ return keep.indexOf(b) >= 0; }), 'every bar it shows is kept');
    same([info.outs[0].style, info.outs[0].loc, info.outs[0].text], ['triup', 'bl', 'up']);
    same([info.outs[1].style, info.outs[1].offset, info.outs[1].show_last, info.outs[1].loc], ['9', -2, 5, 'ab']);
  });

  // ------------------------------------------------------------ inputs
  test('inputs: keys, types, defaults, saved values (kept in range, options checked)', function(){
    var src = head(5) + 'len = input.int(14, "Length", minval = 1, maxval = 50)\nsrc = input.source(close, "Source")\nshow = input(true, "Show")\n' +
              'mult = input.float(2.0, "Mult", step = 0.5)\nmode = input.string("A", "Mode", options = ["A", "B"])\ncol = input.color(color.red, "Color")\n' +
              'n = input.int(3, "N")\nplot(ta.sma(src, len), color = col)\nplotchar(close > open, char = "x", show_last = n)';
    var r = run(src, D), info = r.info();
    same(info.inputs.map(function(s){ return [s.key, s.type, s.value]; }),
         [['Length', 'int', 14], ['Source', 'source', 'close'], ['Show', 'bool', true], ['Mult', 'float', 2], ['Mode', 'string', 'A'],
          ['Color', 'color', Pine.palette(5).red], ['N', 'int', 3]]);
    same(info.outs[1].show_last, 3);
    var r2 = run(src, D, {inputs: {Length: 100, Source: 'open', Mode: 'C', N: 7}}), v = r2.info().inputs;
    same([v[0].value, v[1].value, v[4].value, v[6].value, r2.info().outs[1].show_last], [50, 'open', 'A', 7, 7]);
    var p = plots(r2)[0], O = rows.map(function(x){ return x.o; });
    same(p[59], O.slice(10).reduce(function(a, b){ return a + b; }) / 50);
  });

  // ------------------------------------------------------------ what is refused, with the line
  test('unsupported features are refused with the line and the reason', function(){
    var cases = [
      [head(5) + 'x = request.security(syminfo.tickerid, "D", close)\nplot(x)', /another symbol or timeframe/, 3],
      [head(5) + 'a = array.new_float(5)', /arrays/, 3],
      ['//@version=5\nstrategy("s", overlay = true)', /strategies/, 2],
      ['//@version=5\nindicator("p")\nplot(close)', /pane of its own/, 2],
      [head(5) + 'x = (1 + 2\nplot(x)', /expected|ends too early|unexpected/, 0],
      [head(5) + 'plot(foo)', /"foo" is not defined/, 3],
      ['//@version=3\nstudy("x")', /convert/, 1],
      [head(5) + 'if close > open\n    plot(close)', /top level/, 4],
      [head(5) + 'plot(close, show_last = bar_index)', /fixed value/, 3]
    ];
    cases.forEach(function(c){
      var e = errOf(c[0]);
      assert(e && e.pine, 'no error for: ' + c[0]);
      assert(c[1].test(e.message), 'message "' + e.message + '" for: ' + c[0]);
      if (c[2]) same(e.ln, c[2], 'line of "' + e.message + '"');
    });
  });

  // ------------------------------------------------------------ the forming bar and bars cut again
  function snapshot(r){ var o = r.output(0); delete o.transfer; return o; }
  var LIVE = head(5, 't', ', max_labels_count = 3') + 'var up = 0\nif close > open\n    up += 1\n    label.new(bar_index, high, str.tostring(up))\n' +
             'plotshape(close > open, text = "u")\nplot(ta.ema(close, 5))\nplot(up)\nvar line ln = line.new(0, close, 0, close)\nline.set_x2(ln, bar_index)\n' +
             'line.set_y2(ln, ta.highest(high, 3))';
  test('the forming bar runs again from the last closed bar, as often as it changes', function(){
    var rs = walk(60), Dl = data(rs, 59), r = run(LIVE, Dl);
    for (var k = 0; k < 6; k++) {                                  // new prices on the forming bar
      var c = 100 + (k % 2 ? 3 : -3) + k / 10;
      rs[59] = {o: rs[59].o, h: Math.max(rs[59].o, c) + 0.5, l: Math.min(rs[59].o, c) - 0.5, c: c, v: 50 + k};
      Dl = data(rs, 59);
      r.advance(Dl, 59, 59);
      same(snapshot(r), snapshot(run(LIVE, Dl)), 'tick ' + k);
    }
    rs.push({o: rs[59].c, h: rs[59].c + 1, l: rs[59].c - 1, c: rs[59].c + 0.5, v: 5});   // it closes; the next one forms
    var D2 = data(rs, 60);
    r.advance(D2, 59, 60);
    same(snapshot(r), snapshot(run(LIVE, D2)), 'after the close');
    D2 = data(rs, 61);
    r.advance(D2, 60, 61);
    same(snapshot(r), snapshot(run(LIVE, D2)), 'all closed');
  });

  test('the last closed bars can be cut again without a rerun; further back asks for one', function(){
    var rs = walk(40), Dc = data(rs), r = run(LIVE, Dc);
    rs[39] = {o: rs[39].o, h: rs[39].h + 2, l: rs[39].l, c: rs[39].h + 1.5, v: 1};
    Dc = data(rs); assert(r.advance(Dc, 39, 40)); same(snapshot(r), snapshot(run(LIVE, Dc)), 'last bar');
    rs[38] = {o: rs[38].o, h: rs[38].h, l: rs[38].l - 3, c: rs[38].l - 2, v: 1};
    Dc = data(rs); assert(r.advance(Dc, 38, 40)); same(snapshot(r), snapshot(run(LIVE, Dc)), 'two bars back');
    rs.pop();                                                      // the last bar goes (two bars merged into one)
    Dc = data(rs); assert(r.advance(Dc, 39, 39)); same(snapshot(r), snapshot(run(LIVE, Dc)), 'one bar fewer');
    assert(r.advance(data(rs), 20, 39) === false, 'twenty bars back needs a rerun');
  });

  // ------------------------------------------------------------ the worker's messages
  later('the worker: data, set, out, error, check', function(done){
    var msgs = [], scope = {postMessage: function(m){ msgs.push(m); }};
    Pine.serve(scope);
    var rs = walk(30), Dw = data(rs, 29), cols = {};
    ['t', 'e', 'o', 'h', 'l', 'c', 'v'].forEach(function(k){ cols[k] = Dw[k].slice(0, 30); });
    scope.onmessage({data: {op: 'data', gen: 'g1', sym: {ticker: 'X'}, from: 0, n: 30, conf: 29, cols: cols}});
    scope.onmessage({data: {op: 'set', id: 'a', v: 1, source: head(5) + 'plot(close)', inputs: {}}});
    scope.onmessage({data: {op: 'set', id: 'b', v: 1, source: head(5) + 'plot(foo)', inputs: {}}});
    scope.onmessage({data: {op: 'check', rid: 9, source: head(5) + 'x = input.int(3, "X")\nplot(close)'}});
    setTimeout(function(){
      try {
        var out = msgs.filter(function(m){ return m.op === 'out'; }), err = msgs.filter(function(m){ return m.op === 'error'; });
        var chk = msgs.filter(function(m){ return m.op === 'checked'; });
        same([out.length, err.length, chk.length], [1, 1, 1], 'messages');
        same([out[0].id, out[0].fresh, out[0].n, out[0].from, out[0].info.title], ['a', true, 30, 0, 't']);
        same(arr(out[0].outs[0].v), arr(Dw.c));
        same([err[0].id, err[0].error.ln], ['b', 3]);
        same([chk[0].rid, chk[0].ok, chk[0].info.inputs[0].key], [9, true, 'X']);
        msgs.length = 0;                                           // a new price on the forming bar: only that bar comes back
        var c2 = {}; ['t', 'e', 'o', 'h', 'l', 'c', 'v'].forEach(function(k){ c2[k] = Dw[k].slice(29, 30); });
        c2.c[0] = 123;
        scope.onmessage({data: {op: 'data', gen: 'g1', from: 29, n: 30, conf: 29, cols: c2}});
        setTimeout(function(){
          try {
            var o2 = msgs.filter(function(m){ return m.op === 'out'; });
            same(o2.length, 1, 'only the script without an error runs');
            same([o2[0].fresh, o2[0].from, arr(o2[0].outs[0].v)], [false, 29, [123]]);
            done();
          } catch (e) { done(e); }
        }, 20);
      } catch (e) { done(e); }
    }, 20);
  });

  // ------------------------------------------------------------ report
  function finish(){
    var el = typeof document !== 'undefined' && document.getElementById('out');
    var text = JSON.stringify({cases: results});
    if (el) el.textContent = text; else if (typeof console !== 'undefined') console.log(text);
  }
  (function next(i){
    if (i >= pending.length) return finish();
    var p = pending[i], fin = false;
    function done(e){ if (fin) return; fin = true; results.push(e ? {name: p.name, ok: false, msg: String(e && e.stack || e)} : {name: p.name, ok: true}); next(i + 1); }
    try { p.fn(done); } catch (e) { done(e); }
  })(0);
})();
