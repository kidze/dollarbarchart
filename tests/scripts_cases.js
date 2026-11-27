/* Cases for static/scripts.js, the indicators loaded from a file. tests/test_scripts.py runs them in a headless browser
   on a page with the chart library, ui.js and scripts.js, and a stand-in for the rest of the app (app.js): bars made up
   here, settings kept in memory, the server's /scripts in memory too (its list held back until a case lets it come).
   The scripts run in the real engine (static/pine.js, in workers). The results go to #out as {cases: [{name, ok, msg}]}. */
(function(){
  'use strict';
  var results = [], cases = [];
  function test(name, fn){ cases.push({name: name, fn: fn}); }
  function assert(c, m){ if (!c) throw new Error(m || 'failed'); }
  function near(a, b, m){ assert(Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(b)), (m || '') + ': ' + a + ' is not ' + b); }
  function wait(cond, what, ms){
    return new Promise(function(ok, no){
      var t0 = Date.now();
      (function poll(){
        var v; try { v = cond(); } catch (e) { v = null; }
        if (v) return ok(v);
        if (Date.now() - t0 > (ms || 10000)) return no(new Error('timed out waiting for ' + what));
        setTimeout(poll, 20);
      })();
    });
  }
  function $(q){ return document.querySelector(q); }

  // ---------------------------------------------------------------- the stand-in app: a chart of made-up bars
  var seed = 7;
  function rnd(){ seed = (seed * 16807) % 2147483647; return seed / 2147483647; }
  function bar(t, p){
    var o = p, c = p * (1 + (rnd() - 0.5) * 0.02), h = Math.max(o, c) * (1 + rnd() * 0.005), l = Math.min(o, c) * (1 - rnd() * 0.005);
    return {t: t, e: t + 3000, o: o, h: h, l: l, c: c, v: 10 + rnd() * 5, d: 1, n: 1};
  }
  var bars = [], forming = null, mode = 'dollar', posted = [], server = [];
  for (var i = 0, p = 100; i < 300; i++) { bars.push(bar(1.7e9 + i * 3600, p)); p = bars[i].c; }
  forming = bar(1.7e9 + 300 * 3600, p);
  function rows(){ return forming ? bars.concat([forming]) : bars; }
  function candle(r){ return {time: r.t, open: r.o, high: r.h, low: r.l, close: r.c}; }
  var chart = LightweightCharts.createChart(document.getElementById('chart'), {width: 900, height: 500});
  var series = chart.addSeries(LightweightCharts.CandlestickSeries, {});
  series.setData(rows().map(candle));
  var store = {d: {}, get: function(k){ return this.d[k]; }, set: function(k, v){ if (v === undefined) delete this.d[k]; else this.d[k] = JSON.parse(JSON.stringify(v)); }};
  function idOf(name){ return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '') || 'indicator'; }
  var app = {
    store: store, chart: chart, series: series, saveState: function(){}, ind: {button: function(){}},
    post: function(url, body){                                   // the server's POST /scripts
      posted.push(body);
      if (body.add) {
        var e = {id: idOf(body.add.name), name: body.add.name, file: body.add.file, added: 1, updated: 2};
        server = server.filter(function(x){ return x.id !== e.id; }).concat([e]);
        return Promise.resolve({ok: true, script: e});
      }
      server = server.filter(function(x){ return x.id !== body.delete; });
      return Promise.resolve({ok: true, deleted: true});
    },
    rows: rows, closed: function(){ return bars.length; }, mode: function(){ return mode; }, tf: function(){ return '1D'; },
    market: function(){ return 'all:TEST'; }, marketInfo: function(){ return {ticker: 'TEST'}; },
    fmtP: function(v){ return v.toFixed(2); }, fmtT: function(t){ return new Date(t * 1000).toISOString(); },
    timeToLogical: function(t){
      var r = rows(), n = r.length, lo = 0, hi = n - 1;
      if (!n || t !== t) return NaN;
      if (t <= r[0].t) return (t - r[0].t) / 3600;
      if (t >= r[n - 1].t) return n - 1 + (t - r[n - 1].t) / 3600;
      while (hi - lo > 1) { var m = (lo + hi) >> 1; if (r[m].t <= t) lo = m; else hi = m; }
      return lo + (t - r[lo].t) / (r[hi].t - r[lo].t);
    }
  };
  // GET /scripts: one indicator kept from before, switched on when the app last closed; its list comes when let
  var KEPT = {id: 'kept', name: 'Kept', file: 'kept.pine', added: 1, updated: 1, source: '//@version=5\nindicator("Kept", overlay = true)\nplot(close, "Close")\n'};
  var release, listed = new Promise(function(ok){ release = ok; }), realFetch = window.fetch;
  window.fetch = function(url){
    if (url !== '/scripts') return realFetch.apply(this, arguments);
    return listed.then(function(){ return new Response(JSON.stringify({scripts: [KEPT].concat(server)}), {headers: {'Content-Type': 'application/json'}}); });
  };
  store.set('script:kept', {on: true, hide: false, inputs: {}, style: {}});
  var S = DBCScripts(app);
  S.render(rows(), true);

  function load(title, body, file){ S.load(new File(['//@version=5\nindicator("' + title + '", overlay = true)\n' + body], file || 'x.pine')); }
  function get(id){ return S.list().filter(function(s){ return s.id === id; })[0]; }
  function sma(n, j){ var r = rows(), m = 0; for (var k = j - n + 1; k <= j; k++) m += r[k].c; return m / n; }
  function matches(s, n, k){                                      // plot 0 of s is k × the n-bar average of the closes, on every bar
    var V = s.out && s.out.outs[0].v, r = rows();
    if (!V || s.out.n !== r.length) return false;
    for (var j = n - 1; j < r.length; j++) if (Math.abs(V[j] - (k || 1) * sma(n, j)) > 1e-9 * sma(n, j)) return false;
    return true;
  }
  function row(id){ return $('#lgScr .sr[data-id="' + id + '"]'); }
  function dialog(){ return $('.dlg'); }
  function gear(id){ row(id).querySelector('button[data-a="gear"]').click(); return wait(dialog, 'the settings'); }
  function shot(){ chart.applyOptions({}); return chart.takeScreenshot().toDataURL(); }   // paints now (an error in it throws here)

  // ---------------------------------------------------------------- cases
  test('a file is checked, kept by the server and run on the bars; its values are in the legend', async function(){
    load('Avg', 'len = input.int(5, "Length")\nplot(ta.sma(close, len), "SMA", color = color.orange)\n', 'avg.pine');
    var s = await wait(function(){ var s = get('avg'); return s && matches(s, 5) && s; }, 'the average');
    assert(!get('kept'), 'the list from the server is not here yet');
    assert(posted.some(function(p){ return p.add && p.add.name === 'Avg' && p.add.file === 'avg.pine' && /ta\.sma/.test(p.add.source); }), 'kept by the server');
    assert(s.on && store.get('script:avg').on, 'on, and saved as on');
    var r = row('avg'), n = rows().length;
    assert(r && r.querySelector('.sn').textContent === 'Avg', 'its row in the legend');
    assert(r.querySelector('.sv b').textContent === sma(5, n - 1).toFixed(2), 'the newest value: ' + r.querySelector('.sv').textContent);
    S.hover(rows()[100]);
    assert(r.querySelector('.sv b').textContent === sma(5, 100).toFixed(2), 'the value at the bar under the mouse');
    S.hover(null);
  });

  test('the list from the server comes later: the one switched on last time runs, the one loaded since stays as it is', async function(){
    var a = get('avg'), v = a.v;
    release();
    var k = await wait(function(){ var k = get('kept'); return k && k.out && k; }, 'the kept indicator');
    var r = rows();
    for (var j = 0; j < r.length; j++) near(k.out.outs[0].v[j], r[j].c, 'bar ' + j);
    assert(get('avg') === a && a.on && a.v === v && matches(a, 5), 'the loaded one is not run again');
    assert(row('kept') && row('avg') && S.list().length === 2, 'both in the legend');
  });

  test('a new price on the forming bar: only that bar runs again', async function(){
    var s = get('avg'), v = s.v;
    forming = Object.assign({}, forming, {c: forming.c * 1.01, h: forming.c * 1.015});
    series.update(candle(forming)); S.update(forming);
    await wait(function(){ return matches(s, 5); }, 'the forming bar again');
    assert(s.v === v, 'not run from the start');
  });

  test('the forming bar closes and the next one starts', async function(){
    var s = get('avg'), v = s.v;
    bars.push(forming); forming = bar(forming.t + 3600, forming.c);
    series.update(candle(bars[bars.length - 1]), true); series.update(candle(forming));
    S.update(bars[bars.length - 1]); S.update(forming);
    await wait(function(){ return matches(s, 5); }, 'one bar more');
    assert(s.v === v && s.out.n === bars.length + 1, 'one bar more, not run from the start');
  });

  test('settings: a changed input runs again at once; Cancel puts it back, Ok keeps it', async function(){
    var s = get('avg'), d = await gear('avg'), inp = d.querySelector('input.num');
    assert(inp && inp.value === '5', 'the input, at its default');
    inp.value = '7'; inp.dispatchEvent(new Event('change'));
    await wait(function(){ return matches(s, 7); }, 'the 7-bar average');
    d.querySelector('.cancel').click();
    await wait(function(){ return matches(s, 5); }, 'back to 5');
    assert(!(store.get('script:avg').inputs || {}).Length, 'nothing saved');
    d = await gear('avg'); inp = d.querySelector('input.num');
    inp.value = '9'; inp.dispatchEvent(new Event('change'));
    d.querySelector('.ok').click();
    await wait(function(){ return matches(s, 9); }, 'the 9-bar average');
    assert(store.get('script:avg').inputs.Length === 9, 'saved');
  });

  test('style: an output switched off leaves the chart and the legend; Defaults brings everything back', async function(){
    var s = get('avg'), d = await gear('avg');
    d.querySelectorAll('.tabs button')[1].click();
    var cb = d.querySelector('.body input[type=checkbox]');
    cb.checked = false; cb.dispatchEvent(new Event('change'));
    assert(s.style[0] && s.style[0].hide && row('avg').querySelector('.sv').textContent === '', 'no value shown');
    d.querySelector('.ok').click();
    assert(store.get('script:avg').style[0].hide, 'saved');
    d = await gear('avg');
    d.querySelector('.foot .btn.link').click();                   // Defaults
    d.querySelector('.ok').click();
    assert(!store.get('script:avg').style[0] && !store.get('script:avg').inputs.Length, 'back to the defaults');
    await wait(function(){ return matches(s, 5) && row('avg').querySelector('.sv').textContent; }, 'the default average, shown again');
  });

  test('the eye hides it; × takes it off the chart; the menu puts it back', async function(){
    var s = get('avg');
    row('avg').querySelector('button[data-a="eye"]').click();
    assert(s.hide && row('avg').classList.contains('off') && store.get('script:avg').hide, 'hidden');
    row('avg').querySelector('button[data-a="eye"]').click();
    assert(!s.hide, 'shown');
    row('avg').querySelector('button[data-a="x"]').click();
    assert(!s.on && !row('avg') && !store.get('script:avg').on && !s.out, 'off the chart');
    var it = S.menuItems().filter(function(x){ return x.html && x.html.indexOf('>Avg<') >= 0; })[0];
    assert(it && !it.on, 'in the menu, switched off');
    it.onClick({target: document.body});
    await wait(function(){ return s.on && matches(s, 5); }, 'on again');
  });

  test('a script that cannot run here: the dialog gives the line and the reason, nothing is kept', async function(){
    var before = posted.length;
    load('Bad', 'x = request.security(syminfo.tickerid, "D", close)\nplot(x)\n', 'bad.pine');
    var d = await wait(dialog, 'the dialog');
    assert(/bad\.pine/.test(d.textContent) && /Line 3: data from another symbol/.test(d.textContent) && /request\.security/.test(d.textContent), d.textContent);
    d.querySelector('.ok').click();
    assert(!get('bad') && posted.length === before, 'not kept');
  });

  test('a script that fails on a later bar: its legend row says where and why', async function(){
    load('Later', 's = 0.0\nif bar_index > 50\n    for i = 0 to 3000000\n        s += i\nplot(close)\n', 'later.pine');
    var s = await wait(function(){ var s = get('later'); return s && s.err && s; }, 'the error');
    var er = await wait(function(){ return row('later').querySelector('.er'); }, 'the mark');
    assert(s.err.ln === 5 && s.err.bar === 51 && /^Line 5: a loop runs too long/.test(er.title), er.title);
  });

  test('the same title again replaces it, after asking, and keeps its settings', async function(){
    var s = get('avg');
    store.set('script:avg', Object.assign({}, store.get('script:avg'), {inputs: {Length: 4}}));
    s.inputs = {Length: 4};
    load('Avg', 'len = input.int(5, "Length")\nplot(ta.sma(close, len) * 2, "SMA x2")\n', 'avg2.pine');
    var d = await wait(dialog, 'the question');
    assert(/Replace/.test(d.textContent) && /avg\.pine/.test(d.textContent), d.textContent);
    d.querySelector('.ok').click();
    await wait(function(){ return s.file === 'avg2.pine' && matches(s, 4, 2); }, 'the new version');
    assert(get('avg') === s && S.list().filter(function(x){ return x.id === 'avg'; }).length === 1 && store.get('script:avg').inputs.Length === 4, 'one of it, with its settings');
  });

  test('× in the menu removes it from the app, after asking', async function(){
    var it = S.menuItems().filter(function(x){ return x.html && x.html.indexOf('>Later<') >= 0; })[0], rm = document.createElement('span');
    rm.className = 'rm'; document.body.appendChild(rm);
    it.onClick({target: rm});
    var d = await wait(dialog, 'the question');
    assert(/Remove/.test(d.textContent), d.textContent);
    d.querySelector('.ok').click();
    await wait(function(){ return !get('later'); }, 'gone');
    assert(!row('later') && store.get('script:later') === undefined && posted.some(function(p){ return p.delete === 'later'; }), 'gone everywhere');
    rm.remove();
  });

  test('every kind of output paints, at any zoom', async function(){
    load('Kinds', [
      'm = ta.sma(close, 10)',
      'p1 = plot(m, "Line", color = close > m ? color.green : color.red, linewidth = 2, trackprice = true)',
      'p2 = plot(m * 1.01, "Step", style = plot.style_stepline, linestyle = plot.linestyle_dashed)',
      'plot(m * 0.99, "Br", style = plot.style_linebr)',
      'plot(m * 0.98, "Area", style = plot.style_area, color = color.new(color.blue, 80))',
      'plot(m * 0.97, "Hist", style = plot.style_histogram, histbase = 90)',
      'plot(m * 0.96, "Cols", style = plot.style_columns, histbase = 90)',
      'plot(m * 0.95, "Cross", style = plot.style_cross)',
      'plot(m * 0.94, "Circles", style = plot.style_circles, join = true)',
      'fill(p1, p2, color = color.new(color.teal, 80), title = "Fill")',
      'fill(p1, p2, top_value = m * 1.01, bottom_value = m, top_color = color.red, bottom_color = color.blue, title = "Gradient")',
      'h1 = hline(95, "H1")',
      'h2 = hline(105, "H2", linestyle = hline.style_solid)',
      'fill(h1, h2, color = color.new(color.gray, 90))',
      'bgcolor(bar_index % 7 == 0 ? color.new(color.yellow, 85) : na)',
      'up = close > open',
      'plotshape(up, "Tri", shape.triangleup, location.belowbar, color.green, text = "u")',
      'plotshape(not up, "Lbl", shape.labeldown, location.abovebar, color.red, text = "d\\n2")',
      'plotshape(bar_index % 5 == 0, "X", shape.xcross, location.top)',
      'plotshape(bar_index % 6 == 0, "Flag", shape.flag, location.bottom, size = size.large)',
      'plotshape(bar_index % 9 == 0 ? close : na, "Abs", shape.diamond, location.absolute)',
      'plotchar(bar_index % 4 == 0, "Char", "★", location.abovebar, color.yellow, text = "s")',
      'plotarrow(bar_index % 8 == 0 ? (up ? 1 : -1) : na, "Arrows")',
      'if bar_index % 20 == 0',
      '    label.new(bar_index, high, "A\\n", yloc = yloc.abovebar, style = label.style_none, textcolor = color.yellow, size = size.large)',
      '    label.new(bar_index, low, "up", style = label.style_label_up, color = color.green, textcolor = color.white)',
      '    label.new(bar_index, close, "c", style = label.style_label_left, textalign = text.align_left)',
      '    label.new(bar_index, close, "o", style = label.style_text_outline, color = color.black, textcolor = color.white)',
      '    label.new(bar_index, close, "", style = label.style_circle, yloc = yloc.belowbar)',
      '    label.new(bar_index, close, "ll", style = label.style_label_lower_left)',
      '    line.new(bar_index - 5, low, bar_index, high, extend = extend.both, style = line.style_arrow_both, color = color.aqua)',
      '    line.new(time[3], low, time, high, xloc = xloc.bar_time, style = line.style_dotted)'
    ].join('\n') + '\n', 'kinds.pine');
    var s = await wait(function(){ var s = get('kinds'); return s && (s.out || s.err) && s; }, 'its outputs');
    assert(!s.err, JSON.stringify(s.err));
    assert(s.info.outs.length === 21 && s.out.labels.length > 20 && s.out.lines.length > 4, s.info.outs.length + ' outputs, ' + s.out.labels.length + ' labels');
    var n = rows().length;
    [[n - 120, n + 5], [0, n + 5], [n - 20, n + 2]].forEach(function(r){
      chart.timeScale().setVisibleLogicalRange({from: r[0], to: r[1]});
      var a = shot();
      row('kinds').querySelector('button[data-a="eye"]').click();   // hidden: the chart without it
      var b = shot();
      row('kinds').querySelector('button[data-a="eye"]').click();
      assert(a !== b, 'nothing of it on the chart at ' + r);
    });
    chart.priceScale('right').applyOptions({mode: 1});            // a log scale: nothing at or under zero to place
    shot();
    chart.priceScale('right').applyOptions({mode: 0});
  });

  test('another set of bars: what was drawn goes at once, every indicator runs on the new bars', async function(){
    var s = get('avg');
    S.clear();
    assert(!s.out && !$('#lgScr .sv b'), 'nothing drawn while the next bars load');
    bars = bars.slice(0, 200); forming = null;
    series.setData(rows().map(candle)); S.render(rows(), true);
    await wait(function(){ return matches(s, 4, 2) && s.out.n === 200; }, 'run on the 200 bars');
  });

  test('time bars: a bar closes when its period ends; timeframe.period is the chart\'s', async function(){
    mode = 'time';
    S.render(rows(), true);
    load('Tf', 'plot(time_close - time, "Length")\nplot(timeframe.period == "D" and timeframe.isdaily ? 1 : 0, "Daily")\n', 'tf.pine');
    var s = await wait(function(){ var s = get('tf'); return s && s.out && s; }, 'its outputs');
    for (var j = 0; j < s.out.n; j++) { near(s.out.outs[0].v[j], 864e5, 'bar ' + j); near(s.out.outs[1].v[j], 1, 'period ' + j); }
    mode = 'dollar';
  });

  // ---------------------------------------------------------------- run them, one after another
  (function next(i){
    if (i >= cases.length) { document.getElementById('out').textContent = JSON.stringify({cases: results}); return; }
    var c = cases[i];
    function done(e){
      var d = dialog(); if (d) d.querySelector('.cancel').click();   // (a failed case may leave its dialog open)
      results.push(e ? {name: c.name, ok: false, msg: String(e && e.stack || e)} : {name: c.name, ok: true});
      next(i + 1);
    }
    try { Promise.resolve(c.fn()).then(function(){ done(); }, done); } catch (e) { done(e); }
  })(0);
})();
