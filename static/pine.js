/* Pine Script on the chart: runs the TradingView indicators people load from a file of their own (Indicators → Load
   indicator…, a .pine or .txt file holding the script's source) on the chart's bars, dollar bars and time bars alike.

   Pine runs a script once per bar, oldest first, and so does this. It understands the part of Pine v4, v5 and v6 that
   indicators drawn on the price chart use:
     - the language: variables, `var`, history (`x[1]` on any variable, value or expression), if / else, for … to … by,
       while, switch, the ternary, and / or / not, functions of your own (`f(x) =>`, one line or a block), tuples,
       wrapped lines;
     - inputs (they become the indicator's settings), colors, the math, string and time functions, the common `ta.`
       functions (every call keeps its own history, as in Pine);
     - what it draws: plot, plotshape, plotchar, plotarrow, bgcolor, hline, fill, labels and lines.
   A script that needs more (data of another symbol or timeframe, arrays, boxes, tables, strategies, a pane of its own)
   is refused with the line and the reason: never drawn half right.

   The forming bar is worked out like TradingView's realtime bar: every new price runs the script on it again from the
   state the last closed bar left (`var` values, history, labels and lines are rolled back first), and once the bar
   closes it runs one last time as a closed bar.

   It runs in a Web Worker (new Worker('static/pine.js')), so a long history never holds the chart up; it also loads as a
   plain script or a CommonJS module (the tests). Exposes Pine = {Run, version, ...}. */
(function(root){
  'use strict';
  var CAP = 8192, MASK = CAP - 1;                                // history kept per series (Pine itself reaches 5000 bars back)
  var LOOP_MAX = 2e6;                                            // loop turns one bar may take (Pine stops a script after 500 ms a bar)

  function fail(msg, ln){ var e = new Error(msg); e.pine = true; e.ln = ln || 0; throw e; }

  // ---------------------------------------------------------------- values
  // Numbers are numbers and na is NaN; bools are true / false; strings are strings; drawings (labels, lines) are objects.
  // A color is one number, 0xRRGGBBAA (alpha 255 = opaque), so na is NaN for colors too.
  function isNa(v){ return v === null || v === undefined || v !== v; }
  function T(v){ return v === true || (typeof v === 'number' && v !== 0 && v === v); }
  function hexC(s){ var h = s.slice(1), rgb = parseInt(h.slice(0, 6), 16), a = h.length >= 8 ? parseInt(h.slice(6, 8), 16) : 255; return rgb * 256 + a; }
  function rgbC(r, g, b, t){
    if (isNa(r) || isNa(g) || isNa(b)) return NaN;
    var cl = function(x){ return Math.max(0, Math.min(255, Math.round(x))); };
    return (cl(r) * 65536 + cl(g) * 256 + cl(b)) * 256 + alphaOf(t === undefined ? 0 : t);
  }
  function alphaOf(t){ t = isNa(t) ? 0 : Math.max(0, Math.min(100, t)); return Math.round(255 * (100 - t) / 100); }
  function setT(c, t){ if (typeof c !== 'number' || c !== c) return NaN; if (t === undefined || isNa(t)) return c; return Math.floor(c / 256) * 256 + alphaOf(t); }
  function cR(c){ return Math.floor(c / 16777216) & 255; }
  function cG(c){ return Math.floor(c / 65536) & 255; }
  function cB(c){ return Math.floor(c / 256) & 255; }
  function cT(c){ return Math.round((255 - (c & 255)) / 255 * 100); }
  // the named colors: v4 had TradingView's older palette, v5 and v6 changed blue, red and teal
  var NAMED4 = {aqua:'#00BCD4', black:'#363A45', blue:'#2196F3', fuchsia:'#E040FB', gray:'#787B86', green:'#4CAF50', lime:'#00E676',
                maroon:'#880E4F', navy:'#311B92', olive:'#808000', orange:'#FF9800', purple:'#9C27B0', red:'#FF5252', silver:'#B2B5BE',
                teal:'#00897B', white:'#FFFFFF', yellow:'#FFEB3B'};
  function palette(ver){
    var out = {}, k;
    for (k in NAMED4) out[k] = hexC(NAMED4[k]);
    if (ver >= 5) { out.blue = hexC('#2962FF'); out.red = hexC('#F23645'); out.teal = hexC('#089981'); }
    return out;
  }

  function numStr(v){
    if (Number.isInteger(v)) return String(v);
    var s = v.toFixed(10).replace(/0+$/, '').replace(/\.$/, '');
    return s === '-0' ? '0' : s;
  }
  function tostr(v, fmt){
    if (isNa(v)) return 'NaN';
    if (typeof v === 'boolean') return v ? 'true' : 'false';
    if (typeof v === 'string') return v;
    if (typeof v !== 'number') return String(v);
    if (fmt === undefined || fmt === 'inherit' || fmt === 'price') return numStr(v);
    if (fmt === 'mintick') return v.toFixed(2);
    if (fmt === 'percent') return numStr(+v.toFixed(2)) + '%';
    if (fmt === 'volume') { var a = Math.abs(v); return a >= 1e9 ? numStr(+(v/1e9).toFixed(3)) + 'B' : a >= 1e6 ? numStr(+(v/1e6).toFixed(3)) + 'M' : a >= 1e3 ? numStr(+(v/1e3).toFixed(3)) + 'K' : numStr(+v.toFixed(3)); }
    if (typeof fmt === 'string' && /^[#0,]*(\.[#0]*)?%?$/.test(fmt)) {
      var pct = fmt.slice(-1) === '%', f = pct ? fmt.slice(0, -1) : fmt, dot = f.indexOf('.');
      var dec = dot < 0 ? '' : f.slice(dot + 1), fixed = (dec.match(/0/g) || []).length, opt = (dec.match(/#/g) || []).length;
      var s = (pct ? v * 100 : v).toFixed(fixed + opt);
      if (opt) { var cut = 0; while (cut < opt && /0$/.test(s)) { s = s.slice(0, -1); cut++; } s = s.replace(/\.$/, ''); }
      if (f.indexOf(',') >= 0) { var parts = s.split('.'); parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ','); s = parts.join('.'); }
      return s + (pct ? '%' : '');
    }
    return numStr(v);
  }

  // ---------------------------------------------------------------- the lexer: logical lines of tokens
  // A line is one statement. A statement goes on over the next lines while a bracket is open, while the next line is
  // indented by a number of spaces that is not a multiple of four, or when a line ends on an operator and the next is
  // indented more (Pine's rules for wrapping). Blocks are indented by four spaces (or a tab) a level.
  var OPS2 = {':=':1, '+=':1, '-=':1, '*=':1, '/=':1, '%=':1, '==':1, '!=':1, '<=':1, '>=':1, '=>':1};
  var OPS1 = '<>=+-*/%?:()[],.';
  var TAIL = {'+':1, '-':1, '*':1, '/':1, '%':1, '?':1, ':':1, ',':1, '(':1, '[':1, '=':1, ':=':1, '==':1, '!=':1, '<':1, '>':1,
              '<=':1, '>=':1, '+=':1, '-=':1, '*=':1, '/=':1, '%=':1};
  var HEAD = {'?':1, ':':1, '+':1, '*':1, '/':1, '%':1, '==':1, '!=':1, '<':1, '>':1, '<=':1, '>=':1, ')':1, ']':1, ',':1};
  var RE_NUM = /(?:\d+\.?\d*(?:[eE][+-]?\d+)?|\.\d+(?:[eE][+-]?\d+)?)/y, RE_ID = /[A-Za-z_][A-Za-z0-9_]*/y, RE_COL = /#[0-9a-fA-F]{6}(?:[0-9a-fA-F]{2})?(?![0-9a-fA-F])/y;
  function lex(src){
    var lines = String(src).replace(/\r\n?/g, '\n').split('\n'), out = [], cur = null, depth = 0;
    for (var ln = 0; ln < lines.length; ln++) {
      var s = lines[ln], i = 0, ind = 0, L = ln + 1, toks = [], m;
      if (ln === 0 && s.charCodeAt(0) === 0xFEFF) s = s.slice(1);
      while (i < s.length && (s[i] === ' ' || s[i] === '\t')) { ind += s[i] === '\t' ? 4 : 1; i++; }
      while (i < s.length) {
        var ch = s[i];
        if (ch === ' ' || ch === '\t') { i++; continue; }
        if (ch === '/' && s[i + 1] === '/') break;
        if (ch === '"' || ch === "'") {
          var j = i + 1, str = '';
          while (j < s.length && s[j] !== ch) {
            if (s[j] === '\\' && j + 1 < s.length) {
              var e = s[j + 1];
              if (e === 'u' && /^[0-9a-fA-F]{4}$/.test(s.substr(j + 2, 4))) { str += String.fromCharCode(parseInt(s.substr(j + 2, 4), 16)); j += 6; continue; }
              str += e === 'n' ? '\n' : e === 't' ? '\t' : e === 'r' ? '' : e; j += 2; continue;
            }
            str += s[j++];
          }
          if (j >= s.length) fail('a string is not closed on this line', L);
          toks.push({t: 's', v: str, ln: L}); i = j + 1; continue;
        }
        RE_NUM.lastIndex = i;
        if ((ch >= '0' && ch <= '9') || (ch === '.' && s[i + 1] >= '0' && s[i + 1] <= '9')) {
          m = RE_NUM.exec(s);
          toks.push({t: 'n', v: parseFloat(m[0]), int: /^\d+$/.test(m[0]), ln: L}); i += m[0].length; continue;
        }
        if (ch === '#') {
          RE_COL.lastIndex = i; m = RE_COL.exec(s);
          if (!m) fail('a color is written #RRGGBB or #RRGGBBAA', L);
          toks.push({t: 'c', v: hexC(m[0]), ln: L}); i += m[0].length; continue;
        }
        RE_ID.lastIndex = i;
        if ((m = RE_ID.exec(s))) { toks.push({t: 'i', v: m[0], ln: L}); i += m[0].length; continue; }
        var two = s.substr(i, 2);
        if (OPS2[two]) { toks.push({t: 'o', v: two, ln: L}); i += 2; continue; }
        if (OPS1.indexOf(ch) >= 0) { toks.push({t: 'o', v: ch, ln: L}); i++; continue; }
        fail('unexpected character ' + JSON.stringify(ch), L);
      }
      if (!toks.length) continue;
      var last = cur && cur.toks[cur.toks.length - 1], first = toks[0], deeper = cur && ind > cur.ind * 4;
      var wrap = !!cur && (depth > 0 || ind % 4 !== 0 ||
        (deeper && last.t === 'o' && TAIL[last.v]) || (deeper && last.t === 'i' && (last.v === 'and' || last.v === 'or' || last.v === 'not')) ||
        (deeper && first.t === 'o' && HEAD[first.v]) || (deeper && first.t === 'i' && (first.v === 'and' || first.v === 'or')));
      if (wrap) Array.prototype.push.apply(cur.toks, toks);
      else { cur = {ind: ind / 4, toks: toks, ln: L}; out.push(cur); depth = 0; }
      for (var q = 0; q < toks.length; q++) {
        var tk = toks[q];
        if (tk.t === 'o') { if (tk.v === '(' || tk.v === '[') depth++; else if (tk.v === ')' || tk.v === ']') depth = Math.max(0, depth - 1); }
      }
    }
    return out;
  }

  // ---------------------------------------------------------------- the parser: statements and expressions
  var TYPES = {'int':1, 'float':1, 'bool':1, 'color':1, 'string':1, 'label':1, 'line':1, 'box':1, 'table':1, 'linefill':1, 'polyline':1};
  var QUALS = {'series':1, 'simple':1, 'const':1};
  var KEYW = {'if':1, 'else':1, 'for':1, 'to':1, 'by':1, 'while':1, 'switch':1, 'var':1, 'varip':1, 'break':1, 'continue':1, 'and':1, 'or':1,
              'not':1, 'true':1, 'false':1, 'import':1, 'export':1, 'type':1, 'method':1, 'in':1, 'enum':1};
  function desc(x){ return !x ? 'the end of the line' : x.t === 's' ? 'a string' : x.t === 'n' ? String(x.v) : x.t === 'c' ? 'a color' : '"' + x.v + '"'; }

  function Parser(lines){ this.L = lines; this.li = 0; this.t = []; this.p = 0; this.ln = 0; }
  var PP = Parser.prototype;
  PP.peek = function(k){ return this.t[this.p + (k || 0)]; };
  PP.isO = function(v, k){ var x = this.t[this.p + (k || 0)]; return !!x && x.t === 'o' && x.v === v; };
  PP.isK = function(v, k){ var x = this.t[this.p + (k || 0)]; return !!x && x.t === 'i' && x.v === v; };
  PP.isTy = function(k){ var x = this.t[this.p + (k || 0)]; return !!x && x.t === 'i' && (TYPES[x.v] === 1 || QUALS[x.v] === 1); };
  PP.isId = function(k){ var x = this.t[this.p + (k || 0)]; return !!x && x.t === 'i' && !KEYW[x.v]; };
  PP.end = function(){ return this.p >= this.t.length; };
  PP.next = function(){ var x = this.t[this.p++]; if (!x) fail('this line ends too early', this.ln); return x; };
  PP.want = function(v){ var x = this.t[this.p]; if (x && (x.t === 'o' || x.t === 'i') && x.v === v) { this.p++; return x; } fail('expected "' + v + '" but found ' + desc(x), x ? x.ln : this.ln); };
  PP.ident = function(){ var x = this.t[this.p]; if (!x || x.t !== 'i' || KEYW[x.v]) fail('expected a name but found ' + desc(x), x ? x.ln : this.ln); this.p++; return x.v; };
  PP.member = function(){ var x = this.t[this.p]; if (!x || x.t !== 'i') fail('expected a name after "." but found ' + desc(x), x ? x.ln : this.ln); this.p++; return x.v; };
  PP.open = function(){ var L = this.L[this.li++]; this.t = L.toks; this.p = 0; this.ln = L.ln; return L; };
  PP.done = function(){ if (!this.end()) fail('unexpected ' + desc(this.peek()), this.peek().ln); };

  PP.block = function(ind){
    var out = [];
    while (this.li < this.L.length) {
      var L = this.L[this.li];
      if (L.ind < ind) break;
      if (L.ind !== Math.floor(L.ind)) fail('indent blocks by four spaces (or a tab) a level', L.ln);
      if (L.ind > ind) fail('this line is indented further than the block it is in', L.ln);
      out.push(this.stmt(ind));
    }
    return out;
  };
  PP.body = function(ind, ln){                                    // the indented block under if / for / => …: one statement at least
    if (this.li >= this.L.length || this.L[this.li].ind <= ind) fail('an indented block must follow this line', ln);
    return this.block(ind + 1);
  };
  PP.stmt = function(ind){
    var L = this.open(), ln = L.ln, x = this.peek();
    if (x.t === 'i') {
      switch (x.v) {
        case 'if': return this.ifs(ind);
        case 'for': return this.fors(ind);
        case 'while': return this.whiles(ind);
        case 'switch': return this.switches(ind);
        case 'break': this.next(); this.done(); return {k: 'break', ln: ln};
        case 'continue': this.next(); this.done(); return {k: 'continue', ln: ln};
        case 'import': case 'export': case 'type': case 'method': case 'enum':
          fail('"' + x.v + '" (libraries, types of your own, methods, enums) is not supported', ln);
        case 'var': case 'varip': this.next(); return this.decl(ind, x.v);
      }
      if (this.isO('(', 1) && this.fnAhead()) return this.fn(ind);
      if (this.isTy() && this.typedAhead()) return this.decl(ind, '');
      if (x.v === 'array' || x.v === 'matrix' || x.v === 'map') { if (this.isO('<', 1)) fail(x.v + 's are not supported', ln); }
      if (this.isO('=', 1)) return this.decl(ind, '');
      var op = this.peek(1);
      if (op && op.t === 'o' && (op.v === ':=' || op.v === '+=' || op.v === '-=' || op.v === '*=' || op.v === '/=' || op.v === '%=')) {
        var name = this.ident(); this.next();
        return {k: 'assign', name: name, op: op.v, val: this.rhs(ind), ln: ln};
      }
    }
    if (this.isO('[') && this.tupleAhead()) return this.tdecl(ind);
    var e = this.expr(); this.done();
    return {k: 'expr', e: e, ln: ln};
  };
  PP.typedAhead = function(){ var k = 0; while (this.isTy(k)) k++; return k > 0 && this.isId(k) && this.isO('=', k + 1); };
  PP.tupleAhead = function(){ var k = 1; while (this.peek(k) && !this.isO(']', k)) k++; return this.isO('=', k + 1); };
  PP.fnAhead = function(){
    var d = 0, k = 1;
    for (; this.peek(k); k++) {
      if (this.isO('(', k) || this.isO('[', k)) d++;
      else if (this.isO(')', k) || this.isO(']', k)) { d--; if (d === 0) break; }
    }
    return d === 0 && this.isO('=>', k + 1);
  };
  PP.decl = function(ind, mode){
    var ln = this.ln, type = '';
    while (this.isTy() && (this.isTy(1) || this.isId(1))) type = this.next().v;
    if (this.isO('<', 1)) fail('arrays, matrices and maps are not supported', ln);
    if (this.isO('[')) { if (mode) fail('"' + mode + '" cannot declare a tuple', ln); return this.tdecl(ind); }
    var name = this.ident();
    this.want('=');
    return {k: 'decl', name: name, mode: mode, type: type, val: this.rhs(ind), ln: ln};
  };
  PP.tdecl = function(ind){
    var ln = this.ln; this.want('[');
    var names = [this.ident()];
    while (this.isO(',')) { this.next(); names.push(this.ident()); }
    this.want(']'); this.want('=');
    return {k: 'tdecl', names: names, val: this.rhs(ind), ln: ln};
  };
  PP.fn = function(ind){
    var ln = this.ln, name = this.ident(), params = [];
    this.want('(');
    while (!this.isO(')')) {
      while (this.isTy() && this.isTy(1) || this.isTy() && this.isId(1)) this.next();
      var p = {name: this.ident(), def: null};
      if (this.isO('=')) { this.next(); p.def = this.expr(); }
      params.push(p);
      if (this.isO(',')) this.next(); else break;
    }
    this.want(')'); this.want('=>');
    if (this.end()) return {k: 'fn', name: name, params: params, body: this.body(ind, ln), ln: ln};
    return {k: 'fn', name: name, params: params, body: [{k: 'expr', e: this.rhs(ind), ln: ln}], ln: ln};
  };
  PP.rhs = function(ind){                                         // what follows = or := : an expression, or an if / switch / for / while block
    if (this.isK('if')) return this.ifs(ind);
    if (this.isK('switch')) return this.switches(ind);
    if (this.isK('for')) return this.fors(ind);
    if (this.isK('while')) return this.whiles(ind);
    var e = this.expr(); this.done(); return e;
  };
  PP.ifs = function(ind){
    var ln = this.ln; this.want('if');
    var conds = [this.expr()], blocks = [], els = null;
    this.done();
    blocks.push(this.body(ind, ln));
    while (this.li < this.L.length) {
      var L = this.L[this.li];
      if (L.ind !== ind || L.toks[0].t !== 'i' || L.toks[0].v !== 'else') break;
      this.open(); this.next();
      if (this.isK('if')) { this.next(); conds.push(this.expr()); this.done(); blocks.push(this.body(ind, this.ln)); continue; }
      this.done(); els = this.body(ind, this.ln); break;
    }
    return {k: 'if', conds: conds, blocks: blocks, els: els, ln: ln};
  };
  PP.fors = function(ind){
    var ln = this.ln; this.want('for');
    if (this.isO('[') || this.isK('in', 1)) fail('"for … in" loops over arrays: not supported', ln);
    var v = this.ident(); this.want('=');
    var from = this.expr(); this.want('to');
    var to = this.expr(), by = null;
    if (this.isK('by')) { this.next(); by = this.expr(); }
    this.done();
    return {k: 'for', v: v, from: from, to: to, by: by, body: this.body(ind, ln), ln: ln};
  };
  PP.whiles = function(ind){
    var ln = this.ln; this.want('while');
    var c = this.expr(); this.done();
    return {k: 'while', c: c, body: this.body(ind, ln), ln: ln};
  };
  PP.switches = function(ind){
    var ln = this.ln; this.want('switch');
    var subj = this.end() ? null : this.expr(), cases = [];
    this.done();
    if (this.li >= this.L.length || this.L[this.li].ind !== ind + 1) fail('switch needs its cases on the lines under it, indented', ln);
    while (this.li < this.L.length && this.L[this.li].ind === ind + 1) {
      this.open();
      var cl = this.ln, when = this.isO('=>') ? null : this.expr();
      this.want('=>');
      cases.push({when: when, body: this.end() ? this.body(ind + 1, cl) : [{k: 'expr', e: this.rhs(ind + 1), ln: cl}], ln: cl});
    }
    return {k: 'switch', subj: subj, cases: cases, ln: ln};
  };

  // expressions, by Pine's precedence: ?: < or < and < == != < > < >= <= < + - < * / % < unary - not < [] ()
  PP.expr = function(){ return this.tern(); };
  PP.tern = function(){
    var c = this.or();
    if (this.isO('?')) { var ln = this.next().ln, a = this.tern(); this.want(':'); return {k: 'tern', c: c, a: a, b: this.tern(), ln: ln}; }
    return c;
  };
  PP.or = function(){ var a = this.and(); while (this.isK('or')) { var ln = this.next().ln; a = {k: 'or', a: a, b: this.and(), ln: ln}; } return a; };
  PP.and = function(){ var a = this.eq(); while (this.isK('and')) { var ln = this.next().ln; a = {k: 'and', a: a, b: this.eq(), ln: ln}; } return a; };
  PP.eq = function(){ var a = this.rel(); while (this.isO('==') || this.isO('!=')) { var o = this.next(); a = {k: 'bin', op: o.v, a: a, b: this.rel(), ln: o.ln}; } return a; };
  PP.rel = function(){ var a = this.add(); while (this.isO('<') || this.isO('>') || this.isO('<=') || this.isO('>=')) { var o = this.next(); a = {k: 'bin', op: o.v, a: a, b: this.add(), ln: o.ln}; } return a; };
  PP.add = function(){ var a = this.mul(); while (this.isO('+') || this.isO('-')) { var o = this.next(); a = {k: 'bin', op: o.v, a: a, b: this.mul(), ln: o.ln}; } return a; };
  PP.mul = function(){ var a = this.un(); while (this.isO('*') || this.isO('/') || this.isO('%')) { var o = this.next(); a = {k: 'bin', op: o.v, a: a, b: this.un(), ln: o.ln}; } return a; };
  PP.un = function(){
    if (this.isO('-')) { var ln = this.next().ln; return {k: 'neg', a: this.un(), ln: ln}; }
    if (this.isO('+')) { this.next(); return this.un(); }
    if (this.isK('not')) { var l2 = this.next().ln; return {k: 'not', a: this.un(), ln: l2}; }
    return this.post();
  };
  PP.post = function(){
    var e = this.prim();
    for (;;) {
      if (this.isO('[')) { var ln = this.next().ln, i = this.expr(); this.want(']'); e = {k: 'hist', a: e, i: i, ln: ln}; continue; }
      if (this.isO('(')) { e = this.call(e); continue; }
      if (this.isO('.')) {
        var dl = this.next().ln, nm = this.member();
        e = e.k === 'id' ? {k: 'id', name: e.name + '.' + nm, ln: e.ln} : {k: 'member', obj: e, name: nm, ln: dl};
        continue;
      }
      if (this.isO('<') && e.k === 'id' && /^(array|matrix|map)\./.test(e.name)) fail(e.name.split('.')[0] + 's are not supported', e.ln);
      return e;
    }
  };
  PP.call = function(callee){
    var ln = this.next().ln, args = [], named = {}, seen = false;
    while (!this.isO(')')) {
      if (this.isId() && this.isO('=', 1) || (this.peek() && this.peek().t === 'i' && this.isO('=', 1))) {
        var nm = this.next().v; this.next(); named[nm] = this.expr(); seen = true;
      } else {
        if (seen) fail('a plain argument cannot follow a named one', ln);
        args.push(this.expr());
      }
      if (this.isO(',')) this.next(); else break;
    }
    this.want(')');
    if (callee.k === 'id') return {k: 'call', name: callee.name, args: args, named: named, ln: callee.ln};
    if (callee.k === 'member') return {k: 'call', obj: callee.obj, name: callee.name, args: args, named: named, ln: callee.ln};
    fail('this cannot be called', ln);
  };
  PP.prim = function(){
    var x = this.next();
    if (x.t === 'n') return {k: 'num', v: x.v, int: x.int, ln: x.ln};
    if (x.t === 's') return {k: 'str', v: x.v, ln: x.ln};
    if (x.t === 'c') return {k: 'col', v: x.v, ln: x.ln};
    if (x.t === 'i') {
      if (x.v === 'true' || x.v === 'false') return {k: 'bool', v: x.v === 'true', ln: x.ln};
      if (x.v === 'na' && !this.isO('(')) return {k: 'na', ln: x.ln};
      if (KEYW[x.v]) fail('unexpected "' + x.v + '"', x.ln);
      return {k: 'id', name: x.v, ln: x.ln};
    }
    if (x.v === '(') { var e = this.expr(); this.want(')'); return e; }
    if (x.v === '[') {
      var items = [this.expr()];
      while (this.isO(',')) { this.next(); items.push(this.expr()); }
      this.want(']');
      return {k: 'tuple', items: items, ln: x.ln};
    }
    fail('unexpected ' + desc(x), x.ln);
  };

  function version(src){
    var m = /^[ \t]*\/\/[ \t]*@version[ \t]*=[ \t]*(\d+)/m.exec(String(src));
    return m ? +m[1] : 0;
  }
  function parse(src){
    var ver = version(src);
    if (ver < 4) fail(ver ? 'Pine v' + ver + ' is not supported: open the script in TradingView and convert it to v6 (Pine Editor → Convert)'
                          : 'no //@version line: scripts in Pine v1 to v3 are not supported (TradingView converts them to v6)', 1);
    var p = new Parser(lex(src));
    return p.block(0);
  }

  // ---------------------------------------------------------------- run-time state: series cells, call sites, the journal
  // Every variable is a cell. One that the script reads history of ([1], [i]) keeps its last CAP values in a ring; any
  // other keeps its current value only. A cell gets a new entry each time its declaration runs (every bar for a global,
  // every call for a function's own variables, as Pine's history goes) and := rewrites the newest entry.
  // While the forming bar runs, every write also goes to the journal R.J (object, key, old value) so it can be undone.
  function Cell(keep){ this.k = keep; this.n = 0; this.h = keep ? new Array(CAP) : [NaN]; }
  function Frame(){ this.cells = []; this.nsites = 0; }
  function Inst(fr){
    var n = fr.cells.length, c = new Array(n);
    for (var i = 0; i < n; i++) c[i] = new Cell(fr.cells[i].keep);
    this.c = c; this.s = new Array(fr.nsites);
  }
  function cur(c){ return c.k ? c.h[(c.n - 1) & MASK] : c.h[0]; }
  function histC(c, k, ln){
    if (!(k < c.n)) return NaN;
    if (k === 0) return c.k ? c.h[(c.n - 1) & MASK] : c.h[0];
    if (k > MASK) fail('a history reference reaches ' + MASK + ' bars back at most', ln);
    return c.h[(c.n - 1 - k) & MASK];
  }
  function pushV(R, c, v){
    var J = R.J, i = c.k ? c.n & MASK : 0;
    if (J) J.push(c, 'n', c.n, c.h, i, c.h[i]);
    c.n++; c.h[i] = v;
  }
  function setCur(R, c, v){ var i = c.k ? (c.n - 1) & MASK : 0; if (R.J) R.J.push(c.h, i, c.h[i]); c.h[i] = v; }
  function jset(R, o, k, v){ if (R.J) R.J.push(o, k, o[k]); o[k] = v; }
  function rollback(R){ var J = R.J; for (var i = J.length - 3; i >= 0; i -= 3) J[i][J[i + 1]] = J[i + 2]; R.J = null; }
  function idx(v, ln){ if (v !== v || v === undefined) return NaN; if (v < 0) fail('a history index cannot be negative', ln); return Math.floor(v); }
  function Scope(up, f, top){ this.v = Object.create(null); this.up = up; this.f = f; this.top = !!top; }
  function warn(R, m){ if (!R.warnSeen[m]) { R.warnSeen[m] = 1; R.warn.push(m); } }
  function Grow(){ this.a = new Float64Array(256); }
  Grow.prototype.set = function(i, v){
    var a = this.a;
    if (i >= a.length) { var b = new Float64Array(Math.max(i + 1, a.length * 2)); b.set(a); this.a = a = b; }
    a[i] = v;
  };

  function strCat(x, y){ return (typeof x === 'string' ? x : tostr(x)) + (typeof y === 'string' ? y : tostr(y)); }
  var ARITH = {
    '+': function(x, y){ return typeof x === 'string' || typeof y === 'string' ? strCat(x, y) : x + y; },
    '-': function(x, y){ return x - y; },
    '*': function(x, y){ return x * y; },
    '/': function(x, y){ return y === 0 ? NaN : x / y; },
    '%': function(x, y){ return y === 0 ? NaN : x % y; }
  };

  // ---------------------------------------------------------------- the compiler: the parsed script into closures
  // Each node becomes function(I) where I is the instance it runs in: the script's global one, or the one of a call
  // of a function of the script (each place a function is called from has its own, with its own history and `var`s).
  function build(ast, R){
    var GF = new Frame(), GS = new Scope(null, GF, true), USER = Object.create(null);
    var NAF = function(){ return NaN; };
    var CV = [], CG = {c: CV, s: []}, PIDS = Object.create(null);   // the script's variables that hold a fixed value; the plots kept in variables
    var CINT = [];                                                  // … and those that hold a fixed whole number (v4, v5: 15 / 2 is 7)
    var C = {R: R, E: E, bind: bind, constant: constant, isConst: isConst, plotRef: plotRef, NAF: NAF};
    R.GF = GF; R.G0 = {c: [], s: []};

    function look(sc, nm){ for (var s = sc; s; s = s.up) { var k = s.v[nm]; if (k !== undefined) return {f: s.f, k: k}; } return null; }
    function newCell(f, keep){ f.cells.push({keep: !!keep}); return f.cells.length - 1; }
    function declare(sc, nm, ln){
      if (sc.v[nm] !== undefined) fail('"' + nm + '" is already declared in this block', ln);
      var k = newCell(sc.f, false); sc.v[nm] = k; return k;
    }
    function reader(r, sc, ln){
      var k = r.k;
      if (r.f === sc.f) return function(I){ var c = I.c[k]; return c.k ? c.h[(c.n - 1) & MASK] : c.h[0]; };
      if (r.f === GF) return function(){ var c = R.G.c[k]; return c.k ? c.h[(c.n - 1) & MASK] : c.h[0]; };
      fail('internal: a variable of another function', ln);
    }
    // a fixed value is one Pine knows before the first bar: literals, inputs, constants, the functions of fixed values
    // (color.new, math., str. …) and the script's variables that hold one. Titles, styles, locations, show_last … must be.
    function isConst(n, sc){
      switch (n.k) {
        case 'num': case 'str': case 'bool': case 'col': case 'na': return true;
        case 'id':
          var r = look(sc, n.name);
          if (r) return r.f === GF && CV[r.k] !== undefined;
          return constOf(R, n.name) !== undefined || (!!VARS[n.name] && FIXED.test(n.name));
        case 'tern': return isConst(n.c, sc) && isConst(n.a, sc) && isConst(n.b, sc);
        case 'and': case 'or': case 'bin': return isConst(n.a, sc) && isConst(n.b, sc);
        case 'not': case 'neg': return isConst(n.a, sc);
        case 'tuple': for (var i = 0; i < n.items.length; i++) if (!isConst(n.items[i], sc)) return false; return true;
        case 'call':
          if (n.obj || USER[n.name]) return false;
          var b = BI[ALIAS[n.name] || n.name];
          if (!b || !(b.pure === true || (typeof b.pure === 'function' && b.pure(n)))) return false;
          for (var j = 0; j < n.args.length; j++) if (!isConst(n.args[j], sc)) return false;
          for (var key in n.named) if (!isConst(n.named[key], sc)) return false;
          return true;
      }
      return false;
    }
    function constant(node, sc){
      sc = sc || GS;
      if (!isConst(node, sc)) fail('this has to be a fixed value (a number, an input, a constant), not one that changes from bar to bar', node.ln);
      var f = E(node, sc), save = R.G;
      R.G = CG;                                                   // the script's variables read their fixed values
      try { return f(CG); }
      catch (e) { if (e.pine) throw e; fail('this has to be a fixed value', node.ln); }
      finally { R.G = save; }
    }
    function cint(x, sc){                                         // a fixed whole number: 5, -2, a variable set to one, sums of them
      if (intNode(x)) return true;
      if (x.k === 'id') { var r = look(sc, x.name); return !!r && r.f === GF && CINT[r.k] === true; }
      if (x.k === 'bin' && (x.op === '+' || x.op === '-' || x.op === '*' || x.op === '%')) return cint(x.a, sc) && cint(x.b, sc);
      if (x.k === 'neg') return cint(x.a, sc);
      return false;
    }
    function plotRef(node, sc){                                   // fill(p1, p2): the plots (or hlines) it fills between
      if (node.k === 'id') { var r = look(sc, node.name); if (r && r.f === GF && PIDS[r.k]) return {pid: PIDS[r.k].pid, run: null}; }
      if (node.k === 'call') { var f = E(node, sc); if (f.pid !== undefined) return {pid: f.pid, run: f}; }
      fail('fill() fills between two plots or two hlines: the values plot() and hline() give', node.ln);
    }

    function E(n, sc){
      switch (n.k) {
        case 'num': var nv = n.v; return function(){ return nv; };
        case 'str': var sv = n.v; return function(){ return sv; };
        case 'bool': var bv = n.v; return function(){ return bv; };
        case 'col': var cv = n.v; return function(){ return cv; };
        case 'na': return NAF;
        case 'tmpobj': return function(){ return R.tmp; };
        case 'id': return name(n, sc);
        case 'hist': return hist(n, sc);
        case 'call': return call(n, sc);
        case 'member': fail('fields of objects (' + n.name + ') are not supported', n.ln);
        case 'tern':
          var c = E(n.c, sc), a = E(n.a, sc), b = E(n.b, sc);
          return function(I){ return T(c(I)) ? a(I) : b(I); };
        case 'and':
          var a1 = E(n.a, sc), b1 = E(n.b, sc);
          if (R.ver >= 6) return function(I){ return T(a1(I)) && T(b1(I)); };          // v6: the right side only when needed
          return function(I){ var x = a1(I), y = b1(I); return T(x) && T(y); };        // v4, v5: both sides, always
        case 'or':
          var a2 = E(n.a, sc), b2 = E(n.b, sc);
          if (R.ver >= 6) return function(I){ return T(a2(I)) || T(b2(I)); };
          return function(I){ var x = a2(I), y = b2(I); return T(x) || T(y); };
        case 'not':
          var a3 = E(n.a, sc);
          if (R.ver >= 6) return function(I){ return !T(a3(I)); };
          return function(I){ var x = a3(I); return isNa(x) ? NaN : !T(x); };
        case 'neg': var a4 = E(n.a, sc); return function(I){ return -a4(I); };
        case 'bin': return bin(n, sc);
        case 'tuple':
          var its = n.items.map(function(x){ return E(x, sc); }), ni = its.length;
          return function(I){ var o = new Array(ni); for (var i = 0; i < ni; i++) o[i] = its[i](I); return o; };
        case 'if': case 'switch': case 'for': case 'while': return S(n, sc);
      }
      fail('this cannot be worked out', n.ln);
    }

    function bin(n, sc){
      var a = E(n.a, sc), b = E(n.b, sc), op = n.op;
      if ((op === '==' || op === '!=') && (n.b.k === 'num' || n.b.k === 'str' || n.b.k === 'bool')) {   // x == 9: the common case, quicker
        var k = n.b.v;
        return op === '==' ? function(I){ return a(I) === k; } : function(I){ var x = a(I); return !isNa(x) && x !== k; };
      }
      switch (op) {
        case '+': return function(I){ var x = a(I), y = b(I); return typeof x === 'number' && typeof y === 'number' ? x + y : ARITH['+'](x, y); };
        case '-': return function(I){ var x = a(I); return x - b(I); };
        case '*': return function(I){ var x = a(I); return x * b(I); };
        case '/':
          if (R.ver < 6 && cint(n.a, sc) && cint(n.b, sc)) return function(I){ var x = a(I), y = b(I); return y === 0 ? NaN : Math.trunc(x / y); };   // v4, v5: 5 / 2 is 2
          return function(I){ var x = a(I), y = b(I); return y === 0 ? NaN : x / y; };
        case '%': return function(I){ var x = a(I), y = b(I); return y === 0 ? NaN : x % y; };
        case '==': return function(I){ var x = a(I), y = b(I); return !isNa(x) && !isNa(y) && x === y; };
        case '!=': return function(I){ var x = a(I), y = b(I); return !isNa(x) && !isNa(y) && x !== y; };
        case '<': return function(I){ var x = a(I); return x < b(I); };
        case '>': return function(I){ var x = a(I); return x > b(I); };
        case '<=': return function(I){ var x = a(I); return x <= b(I); };
        case '>=': return function(I){ var x = a(I); return x >= b(I); };
      }
      fail('unknown operator ' + op, n.ln);
    }

    function name(n, sc){
      var nm = n.name, r = look(sc, nm);
      if (r) return reader(r, sc, n.ln);
      var dot = nm.indexOf('.');
      if (dot > 0 && look(sc, nm.slice(0, dot))) fail('fields of objects (' + nm + ') are not supported', n.ln);
      var sf = SERIES[nm];
      if (sf) return function(){ return sf(R, R.b); };
      if (VARS[nm]) { var vf = VARS[nm]; return function(){ return vf(R); }; }
      var cv = constOf(R, nm);
      if (cv !== undefined) return function(){ return cv; };
      unsupported(nm, n.ln);
      fail('"' + nm + '" is not defined', n.ln);
    }

    function hist(n, sc){
      var ln = n.ln, ix = E(n.i, sc), kc = n.i.k === 'num' ? n.i.v : null, t = n.a;
      if (kc !== null && (kc < 0 || kc !== Math.floor(kc))) fail('a history index is a whole number, 0 or more', ln);
      if (t.k === 'id') {
        var r = look(sc, t.name);
        if (r) {
          r.f.cells[r.k].keep = true;
          var k = r.k;
          if (r.f === sc.f) {
            if (kc !== null) return function(I){ return histC(I.c[k], kc, ln); };
            return function(I){ return histC(I.c[k], idx(ix(I), ln), ln); };
          }
          if (r.f !== GF) fail('internal: history of a variable of another function', ln);
          if (kc !== null) return function(){ return histC(R.G.c[k], kc, ln); };
          return function(I){ return histC(R.G.c[k], idx(ix(I), ln), ln); };
        }
        var sf = SERIES[t.name];
        if (sf) {
          if (kc !== null) return function(){ var j = R.b - kc; return j >= 0 ? sf(R, j) : NaN; };
          return function(I){ var j = R.b - idx(ix(I), ln); return j >= 0 && j <= R.b ? sf(R, j) : NaN; };
        }
      }
      // anything else (a call, an expression, a built-in that is not a series): the expression keeps its own history,
      // one entry each time it is worked out, as Pine does
      var inner = E(t, sc), ak = newCell(sc.f, true);
      return function(I){ var v = inner(I), c = I.c[ak]; pushV(R, c, v); return histC(c, kc !== null ? kc : idx(ix(I), ln), ln); };
    }

    function call(n, sc){
      var nm = n.name, ln = n.ln;
      if (n.obj) return method(E(n.obj, sc), nm, n, sc);
      var dot = nm.indexOf('.');
      if (dot > 0 && look(sc, nm.slice(0, dot))) return method(name({k: 'id', name: nm.slice(0, dot), ln: ln}, sc), nm.slice(dot + 1), n, sc);
      if (USER[nm]) return userCall(USER[nm], n, sc);
      var cn = ALIAS[nm] || nm, b = BI[cn];
      if (!b) { unsupported(cn, ln); fail('"' + nm + '" is not a function this chart knows', ln); }
      if (b.compile) return b.compile(n, sc, C);
      return generic(cn, b, n, sc);
    }
    // v6 methods on drawings: lbl.set_x(5) is label.set_x(lbl, 5)
    function method(objF, m, n, sc){
      var ln = n.ln, calls = {}, any = false;
      ['label', 'line'].forEach(function(t){
        var b = BI[t + '.' + m];
        if (b) { calls[t] = generic(t + '.' + m, b, {args: [{k: 'tmpobj', ln: ln}].concat(n.args), named: n.named, ln: ln}, sc); any = true; }
      });
      if (!any) fail('".' + m + '()" is not supported', ln);
      return function(I){
        var o = objF(I);
        if (isNa(o)) return NaN;
        var f = calls[o.t];
        if (!f) fail('".' + m + '()" cannot be used on this', ln);
        var save = R.tmp; R.tmp = o;
        var v = f(I); R.tmp = save; return v;
      };
    }
    function bind(ps, n, sc, extra){
      var f = {}, nd = {}, i;
      if (n.args.length > ps.length) fail((n.name || 'this function') + ' takes ' + ps.length + ' arguments at most', n.ln);
      for (i = 0; i < n.args.length; i++) { nd[ps[i]] = n.args[i]; f[ps[i]] = E(n.args[i], sc); }
      for (var key in n.named) {
        if (ps.indexOf(key) < 0 && !(extra && extra.indexOf(key) >= 0)) { warn(R, '"' + key + '" of ' + n.name + ' is ignored (line ' + n.ln + ')'); continue; }
        if (nd[key]) fail('"' + key + '" of ' + n.name + ' is given twice', n.ln);
        nd[key] = n.named[key]; f[key] = E(n.named[key], sc);
      }
      return {f: f, nd: nd};
    }
    function generic(cn, b, n, sc){
      var ln = n.ln, argF;
      if (b.va) {
        for (var key in n.named) fail(cn + ' takes plain arguments only', ln);
        argF = n.args.map(function(a){ return E(a, sc); });
      } else {
        var ps = b.sig ? b.sig(R.ver) : b.p, bd = bind(ps, {name: cn, args: n.args, named: n.named, ln: ln}, sc, b.extra);
        argF = ps.map(function(p){ return bd.f[p] || null; });
        for (var q = 0; q < (b.need || 0); q++) if (!argF[q]) fail(cn + ' needs its "' + ps[q] + '" argument', ln);
      }
      var np = argF.length, site = b.st ? sc.f.nsites++ : -1, f = b.f, init = b.init;
      if (site < 0) {
        if (np === 1) { var a0 = argF[0] || NAF; return function(I){ return f(R, [a0(I)], null, ln); }; }
        return function(I){ var a = new Array(np); for (var i = 0; i < np; i++) { var g = argF[i]; if (g) a[i] = g(I); } return f(R, a, null, ln); };
      }
      return function(I){
        var a = new Array(np);
        for (var i = 0; i < np; i++) { var g = argF[i]; if (g) a[i] = g(I); }
        var S = I.s[site];
        if (S === undefined) { S = init ? init() : {}; jset(R, I.s, site, S); }
        return f(R, a, S, ln);
      };
    }
    function userCall(F, n, sc){
      var ln = n.ln, ps = F.params, np = ps.length, argF = new Array(np), i;
      if (n.args.length > np) fail(F.name + ' takes ' + np + ' arguments', ln);
      for (i = 0; i < n.args.length; i++) argF[i] = E(n.args[i], sc);
      for (var key in n.named) {
        var j = ps.indexOf(key);
        if (j < 0) fail(F.name + ' has no argument "' + key + '"', ln);
        argF[j] = E(n.named[key], sc);
      }
      for (i = 0; i < np; i++) if (!argF[i]) { if (!F.defs[i]) fail(F.name + ' needs its "' + ps[i] + '" argument', ln); argF[i] = F.defs[i]; }
      var site = sc.f.nsites++, pk = F.pk, fr = F.frame, body = F.body;
      return function(I){
        var a = new Array(np), k;
        for (k = 0; k < np; k++) a[k] = argF[k](I);
        var inst = I.s[site];
        if (inst === undefined) { inst = new Inst(fr); jset(R, I.s, site, inst); }
        for (k = 0; k < np; k++) pushV(R, inst.c[pk[k]], a[k]);
        var v = body(inst);
        R.brk = 0;
        return v;
      };
    }

    // ------------------------------------------------------------ statements
    function S(n, sc){
      switch (n.k) {
        case 'expr': return E(n.e, sc);
        case 'decl': return decl(n, sc);
        case 'tdecl': return tdecl(n, sc);
        case 'assign': return assign(n, sc);
        case 'if': return ifs(n, sc);
        case 'for': return fors(n, sc);
        case 'while': return whiles(n, sc);
        case 'switch': return switches(n, sc);
        case 'break': return function(){ R.brk = 1; return NaN; };
        case 'continue': return function(){ R.brk = 2; return NaN; };
        case 'fn': return fnDef(n, sc);
      }
      fail('this statement is not supported', n.ln);
    }
    function blockC(list, sc){
      var bs = new Scope(sc, sc.f, false), fs = list.map(function(s){ return S(s, bs); }), n = fs.length;
      if (n === 1) return fs[0];
      return function(I){ var v; for (var i = 0; i < n; i++) { v = fs[i](I); if (R.brk) return v; } return v; };
    }
    function decl(n, sc){
      var val = E(n.val, sc), k = declare(sc, n.name, n.ln);
      if (sc === GS && !n.mode) {
        if (cint(n.val, sc)) CINT[k] = true;
        if (val.pid !== undefined) PIDS[k] = val;
        else if (isConst(n.val, sc)) {
          try { var c0 = new Cell(false); c0.h[0] = constant(n.val, sc); c0.n = 1; CV[k] = c0; } catch (e) { /* not fixed after all */ }
        }
      }
      if (n.mode) {
        if (n.mode === 'varip') warn(R, 'varip works like var here: the forming bar always starts again from the last closed bar');
        return function(I){
          var c = I.c[k];
          if (c.n === 0) pushV(R, c, val(I));
          else if (c.k) pushV(R, c, c.h[(c.n - 1) & MASK]);
          return c.k ? c.h[(c.n - 1) & MASK] : c.h[0];
        };
      }
      return function(I){ var v = val(I); pushV(R, I.c[k], v); return v; };
    }
    function tdecl(n, sc){
      var tv = E(n.val, sc), ln = n.ln, ks = n.names.map(function(nm){ return nm === '_' ? -1 : declare(sc, nm, ln); }), nk = ks.length;
      return function(I){
        var t = tv(I);
        if (!Array.isArray(t) || t.length < nk) fail('the right side does not give ' + nk + ' values', ln);
        for (var i = 0; i < nk; i++) if (ks[i] >= 0) pushV(R, I.c[ks[i]], t[i]);
        return NaN;
      };
    }
    function assign(n, sc){
      var r = look(sc, n.name), ln = n.ln;
      if (!r) fail('"' + n.name + '" gets a value with ' + n.op + ' before it is declared', ln);
      if (r.f !== sc.f) fail('a function cannot change the variable "' + n.name + '" of the script', ln);
      var k = r.k, val = E(n.val, sc);
      if (r.f === GF) { CV[k] = undefined; CINT[k] = undefined; } // a variable that changes is no fixed value from here on
      if (n.op === ':=') return function(I){ var v = val(I); setCur(R, I.c[k], v); return v; };
      var f2 = ARITH[n.op[0]];
      return function(I){ var c = I.c[k], v = f2(c.k ? c.h[(c.n - 1) & MASK] : c.h[0], val(I)); setCur(R, c, v); return v; };
    }
    function ifs(n, sc){
      var conds = n.conds.map(function(c){ return E(c, sc); }), blocks = n.blocks.map(function(b){ return blockC(b, sc); });
      var els = n.els ? blockC(n.els, sc) : null, nc = conds.length;
      if (nc === 1) {
        var c0 = conds[0], b0 = blocks[0];
        return els ? function(I){ return T(c0(I)) ? b0(I) : els(I); } : function(I){ return T(c0(I)) ? b0(I) : NaN; };
      }
      return function(I){ for (var i = 0; i < nc; i++) if (T(conds[i](I))) return blocks[i](I); return els ? els(I) : NaN; };
    }
    function fors(n, sc){
      var from = E(n.from, sc), to = E(n.to, sc), by = n.by ? E(n.by, sc) : null, ln = n.ln, v6 = R.ver >= 6;
      var ls = new Scope(sc, sc.f, false), k = declare(ls, n.v, ln), body = blockC(n.body, ls);
      return function(I){
        var a = from(I), b = to(I), s = by ? Math.abs(by(I)) : 1, v = NaN, c = I.c[k];
        if (isNa(a) || isNa(b) || !(s > 0)) return NaN;
        var down = a > b;
        for (var i = a; down ? i >= b : i <= b; i = down ? i - s : i + s) {
          if (++R.iters > LOOP_MAX) fail('a loop runs too long (more than ' + LOOP_MAX + ' turns on one bar)', ln);
          pushV(R, c, i);
          v = body(I);
          if (R.brk) { var br = R.brk; R.brk = 0; if (br === 1) break; }
          if (v6) { b = to(I); if (isNa(b)) break; }
        }
        return v;
      };
    }
    function whiles(n, sc){
      var c = E(n.c, sc), body = blockC(n.body, sc), ln = n.ln;
      return function(I){
        var v = NaN;
        while (T(c(I))) {
          if (++R.iters > LOOP_MAX) fail('a loop runs too long (more than ' + LOOP_MAX + ' turns on one bar)', ln);
          v = body(I);
          if (R.brk) { var br = R.brk; R.brk = 0; if (br === 1) break; }
        }
        return v;
      };
    }
    function switches(n, sc){
      var subj = n.subj ? E(n.subj, sc) : null, cs = n.cases.map(function(c){ return {w: c.when ? E(c.when, sc) : null, b: blockC(c.body, sc)}; }), nc = cs.length;
      return function(I){
        var s = subj ? subj(I) : undefined;
        for (var i = 0; i < nc; i++) {
          var c = cs[i];
          if (!c.w) return c.b(I);
          var w = c.w(I);
          if (subj ? (!isNa(s) && s === w) : T(w)) return c.b(I);
        }
        return NaN;
      };
    }
    function fnDef(n, sc){
      if (sc !== GS) fail('functions are declared at the top of the script, not inside a block', n.ln);
      if (USER[n.name]) warn(R, 'the function ' + n.name + ' is declared twice: the second one counts from line ' + n.ln);
      var fr = new Frame(), fs = new Scope(GS, fr, false), pk = [], defs = [];
      n.params.forEach(function(p){ pk.push(declare(fs, p.name, n.ln)); defs.push(p.def ? E(p.def, GS) : null); });
      var body = blockC(n.body, fs);
      USER[n.name] = {name: n.name, params: n.params.map(function(p){ return p.name; }), pk: pk, defs: defs, body: body, frame: fr};
      return NAF;
    }

    var top = ast.map(function(s){ return S(s, GS); }), nt = top.length;
    return function(I){ for (var i = 0; i < nt; i++) top[i](I); };
  }

  // ---------------------------------------------------------------- built-in series, variables and constants
  function trAt(R, j, handle){
    var D = R.D, pc = j > 0 ? D.c[j - 1] : NaN;
    if (isNa(pc)) return handle ? D.h[j] - D.l[j] : NaN;
    return Math.max(D.h[j] - D.l[j], Math.abs(D.h[j] - pc), Math.abs(D.l[j] - pc));
  }
  var SERIES = {
    open: function(R, j){ return R.D.o[j]; }, high: function(R, j){ return R.D.h[j]; }, low: function(R, j){ return R.D.l[j]; },
    close: function(R, j){ return R.D.c[j]; }, volume: function(R, j){ return R.D.v[j]; },
    hl2: function(R, j){ var D = R.D; return (D.h[j] + D.l[j]) / 2; },
    hlc3: function(R, j){ var D = R.D; return (D.h[j] + D.l[j] + D.c[j]) / 3; },
    ohlc4: function(R, j){ var D = R.D; return (D.o[j] + D.h[j] + D.l[j] + D.c[j]) / 4; },
    hlcc4: function(R, j){ var D = R.D; return (D.h[j] + D.l[j] + 2 * D.c[j]) / 4; },
    time: function(R, j){ return R.D.t[j]; }, time_close: function(R, j){ return R.D.e[j]; },
    bar_index: function(R, j){ return j; },
    'ta.tr': function(R, j){ return trAt(R, j, false); }
  };
  SERIES.tr = SERIES['ta.tr'];
  var SOURCES = {open: 1, high: 1, low: 1, close: 1, volume: 1, hl2: 1, hlc3: 1, ohlc4: 1, hlcc4: 1};
  function barDate(R){ return new Date(R.D.t[R.b]); }
  function isoWeek(d){
    var t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())), day = t.getUTCDay() || 7;
    t.setUTCDate(t.getUTCDate() + 4 - day);
    return Math.ceil(((t - Date.UTC(t.getUTCFullYear(), 0, 1)) / 86400000 + 1) / 7);
  }
  var DATEF = {year: function(d){ return d.getUTCFullYear(); }, month: function(d){ return d.getUTCMonth() + 1; },
               dayofmonth: function(d){ return d.getUTCDate(); }, dayofweek: function(d){ return d.getUTCDay() + 1; },
               hour: function(d){ return d.getUTCHours(); }, minute: function(d){ return d.getUTCMinutes(); },
               second: function(d){ return d.getUTCSeconds(); }, weekofyear: isoWeek};
  var VARS = {
    last_bar_index: function(R){ return R.D.n - 1; },
    last_bar_time: function(R){ return R.D.t[R.D.n - 1]; },
    timenow: function(){ return Date.now(); },
    'barstate.isfirst': function(R){ return R.b === 0; },
    'barstate.islast': function(R){ return R.b === R.D.n - 1; },
    'barstate.isconfirmed': function(R){ return R.conf; },
    'barstate.isrealtime': function(R){ return !R.conf; },
    'barstate.ishistory': function(R){ return R.conf; },
    'barstate.isnew': function(){ return true; },
    'barstate.islastconfirmedhistory': function(R){ return R.conf && R.b === R.D.conf - 1; },
    'syminfo.ticker': function(R){ return R.sym.ticker || ''; },
    'syminfo.tickerid': function(R){ return R.sym.tickerid || R.sym.ticker || ''; },
    'syminfo.prefix': function(R){ return R.sym.prefix || ''; },
    'syminfo.root': function(R){ return R.sym.ticker || ''; },
    'syminfo.description': function(R){ return R.sym.description || R.sym.ticker || ''; },
    'syminfo.basecurrency': function(R){ return R.sym.ticker || ''; },
    'syminfo.currency': function(){ return 'USD'; },
    'syminfo.type': function(R){ return R.sym.type || 'crypto'; },
    'syminfo.mintick': function(R){ return R.sym.mintick || 0.01; },
    'syminfo.pointvalue': function(){ return 1; },
    'syminfo.timezone': function(){ return 'Etc/UTC'; },
    'syminfo.session': function(){ return '24x7'; },
    'syminfo.volumetype': function(){ return 'base'; },
    'timeframe.period': function(R){ return R.sym.period || ''; },
    'timeframe.main_period': function(R){ return R.sym.period || ''; },
    'timeframe.multiplier': function(R){ return R.sym.multiplier || 1; },
    'timeframe.isintraday': function(R){ return !!R.sym.intraday; },
    'timeframe.isminutes': function(R){ return !!R.sym.intraday; },
    'timeframe.isdaily': function(R){ return R.sym.unit === 'D'; },
    'timeframe.isweekly': function(R){ return R.sym.unit === 'W'; },
    'timeframe.ismonthly': function(R){ return R.sym.unit === 'M'; },
    'timeframe.isdwm': function(R){ return /^[DWM]$/.test(R.sym.unit || ''); },
    'timeframe.isseconds': function(){ return false; },
    'timeframe.isticks': function(){ return false; }
  };
  Object.keys(DATEF).forEach(function(k){ var f = DATEF[k]; VARS[k] = function(R){ return f(barDate(R)); }; });
  var FIXED = /^(syminfo|timeframe)\./;                          // the same on every bar of a run: fixed values

  var CONSTS = {'math.pi': Math.PI, 'math.e': Math.E, 'math.phi': 1.618033988749895, 'math.rphi': 0.6180339887498948};
  function consts(prefix, pairs){ pairs.split(' ').forEach(function(p){ var kv = p.split('='); CONSTS[prefix + '.' + kv[0]] = kv[1]; }); }
  consts('location', 'abovebar=ab belowbar=bl top=top bottom=bot absolute=abs');
  consts('shape', 'xcross=xcross cross=cross triangleup=triup triangledown=tridn flag=flag circle=circle arrowup=arrowup arrowdown=arrowdn ' +
                  'labelup=labelup labeldown=labeldn square=square diamond=diamond');
  consts('size', 'auto=auto tiny=tiny small=small normal=normal large=large huge=huge');
  consts('plot', 'style_line=line style_linebr=linebr style_stepline=step style_steplinebr=stepbr style_stepline_diamond=step style_histogram=hist ' +
                 'style_cross=cross style_area=area style_areabr=areabr style_columns=columns style_circles=circles linestyle_solid=solid ' +
                 'linestyle_dotted=dotted linestyle_dashed=dashed');
  consts('label', 'style_none=none style_xcross=xcross style_cross=cross style_triangleup=triup style_triangledown=tridn style_flag=flag ' +
                  'style_circle=circle style_arrowup=arrowup style_arrowdown=arrowdn style_label_up=up style_label_down=down style_label_left=left ' +
                  'style_label_right=right style_label_lower_left=lleft style_label_lower_right=lright style_label_upper_left=uleft ' +
                  'style_label_upper_right=uright style_label_center=center style_square=square style_diamond=diamond style_text_outline=outline');
  consts('line', 'style_solid=solid style_dotted=dotted style_dashed=dashed style_arrow_left=aleft style_arrow_right=aright style_arrow_both=aboth');
  consts('hline', 'style_solid=solid style_dotted=dotted style_dashed=dashed');
  consts('extend', 'none=n left=l right=r both=b');
  consts('xloc', 'bar_index=bi bar_time=bt');
  consts('yloc', 'price=price abovebar=ab belowbar=bl');
  consts('text', 'align_left=left align_center=center align_right=right align_top=top align_bottom=bottom wrap_auto=auto wrap_none=none');
  consts('font', 'family_default=default family_monospace=mono');
  // display.* are flags that scripts add and take away (display.all - display.status_line)
  CONSTS['display.none'] = 0; CONSTS['display.pane'] = 1; CONSTS['display.data_window'] = 2; CONSTS['display.price_scale'] = 4;
  CONSTS['display.status_line'] = 8; CONSTS['display.all'] = 15;
  consts('format', 'inherit=inherit price=price volume=volume percent=percent mintick=mintick');
  consts('scale', 'right=right left=left none=none');
  consts('input', 'bool=bool integer=int float=float string=string source=source color=color resolution=timeframe session=session symbol=symbol time=time');
  consts('currency', 'USD=USD NONE=NONE');
  CONSTS['text.format_none'] = 0; CONSTS['text.format_bold'] = 1; CONSTS['text.format_italic'] = 2;
  'sunday monday tuesday wednesday thursday friday saturday'.split(' ').forEach(function(d, i){ CONSTS['dayofweek.' + d] = i + 1; });
  function constOf(R, nm){
    if (CONSTS[nm] !== undefined) return CONSTS[nm];
    if (nm.slice(0, 6) === 'color.' && R.C[nm.slice(6)] !== undefined) return R.C[nm.slice(6)];
    return undefined;
  }

  // what is refused, and why (the message names the line)
  var UNSUP = [
    [/^(request\.|security$|security_lower_tf$)/, 'data from another symbol or timeframe is not supported'],
    [/^strategy(\.|$)/, 'strategies are not supported (this chart runs indicators)'],
    [/^array(\.|$)/, 'arrays are not supported yet'], [/^matrix(\.|$)/, 'matrices are not supported'], [/^map(\.|$)/, 'maps are not supported'],
    [/^box(\.|$)/, 'boxes are not supported yet'], [/^table(\.|$)/, 'tables are not supported yet'],
    [/^linefill(\.|$)/, 'linefills are not supported yet'], [/^polyline(\.|$)/, 'polylines are not supported'],
    [/^chart\./, 'chart.point and the chart.* values are not supported'], [/^ticker\./, 'other tickers are not supported'],
    [/^(plotcandle|plotbar)$/, 'plotcandle and plotbar are not supported yet'], [/^library$/, 'libraries are not supported'],
    [/^input\.(symbol|enum)$/, 'symbol and enum inputs are not supported'],
    [/^(session|dividends|earnings|splits)\./, 'session, dividend, earnings and split data are not supported'],
    [/^math\.random$/, 'math.random is not supported'],
    [/^(label|line|box)\.all$/, 'label.all and line.all are arrays: not supported'],
    [/^(label|line)\.(set_point|set_first_point|set_second_point)$/, 'chart.point is not supported'],
    [/^ta\.(obv|accdist|iii|nvi|pvi|pvt|wad|wvad|vwap)$/, 'the volume series ta.obv, ta.vwap … are not supported yet: work them out with ta.cum'],
    [/^(obv|accdist|iii|nvi|pvi|pvt|wad|wvad|vwap)$/, 'the volume series obv, vwap … are not supported yet: work them out with cum()']
  ];
  function unsupported(nm, ln){ for (var i = 0; i < UNSUP.length; i++) if (UNSUP[i][0].test(nm)) fail(UNSUP[i][1] + ' (' + nm + ')', ln); }

  // the v4 names of what v5 moved into ta. / math. / str.
  var ALIAS = {study: 'indicator', security: 'request.security', tostring: 'str.tostring', tonumber: 'str.tonumber', sum: 'math.sum', tr: 'ta.tr'};
  ('highest lowest highestbars lowestbars sma ema rma wma vwma swma hma alma atr crossover crossunder cross change mom roc rsi stdev variance dev ' +
   'cum barssince valuewhen pivothigh pivotlow rising falling macd bb bbw stoch cci linreg median percentrank mfi tsi wpr kc correlation').split(' ')
    .forEach(function(n){ ALIAS[n] = 'ta.' + n; });
  'abs max min round floor ceil sqrt pow log log10 exp sign avg cos sin tan acos asin atan todegrees toradians'.split(' ')
    .forEach(function(n){ ALIAS[n] = 'math.' + n; });

  // ---------------------------------------------------------------- built-in functions
  // def(name, 'param names', impl(R, args, state, line), options): st = keeps state per call (state from init()),
  // va = takes any number of plain arguments, need = how many leading arguments are required.
  var BI = Object.create(null);
  function def(name, params, f, opt){ var b = {p: params ? params.split(' ') : [], f: f}; if (opt) for (var k in opt) b[k] = opt[k]; BI[name] = b; return b; }
  function stat(init, more){ var o = {st: 1, init: init}; if (more) for (var k in more) o[k] = more[k]; return o; }
  function cellState(){ return {c: new Cell(true)}; }
  function emaState(){ return {c: new Cell(true), p: NaN}; }
  function back(c, i){ return c.h[(c.n - 1 - i) & MASK]; }
  function lenOf(v, ln){ var n = Math.floor(v); if (!(n >= 1)) return 0; if (n > CAP) fail('a length of ' + n + ' bars is more than ' + CAP, ln); return n; }

  def('na', 'x', function(R, a){ return isNa(a[0]); });
  def('nz', 'source replacement', function(R, a){ var x = a[0]; return isNa(x) ? (a[1] === undefined ? 0 : a[1]) : x; });
  def('fixnan', 'source', function(R, a, S){ var x = a[0]; if (isNa(x)) return S.v; jset(R, S, 'v', x); return x; }, stat(function(){ return {v: NaN}; }));
  def('float', 'x', function(R, a){ var x = a[0]; return typeof x === 'number' ? x : x === true ? 1 : x === false ? 0 : NaN; });
  def('int', 'x', function(R, a){ var x = a[0]; return typeof x === 'number' ? (x === x ? Math.trunc(x) : NaN) : x === true ? 1 : x === false ? 0 : NaN; });
  def('bool', 'x', function(R, a){ return T(a[0]); });
  ['string', 'color', 'label', 'line'].forEach(function(t){ def(t, 'x', function(R, a){ return a[0]; }); });
  def('iff', 'condition then_ else_', function(R, a){ return T(a[0]) ? a[1] : a[2]; });
  def('max_bars_back', 'var num', function(){ return NaN; });
  def('alert', 'message freq', function(){ return NaN; });
  def('alertcondition', 'condition title message', function(){ return NaN; });
  def('runtime.error', 'message', function(R, a, S, ln){ fail(tostr(a[0]), ln); });
  ['log.info', 'log.warning', 'log.error'].forEach(function(n){ def(n, '', function(){ return NaN; }, {va: 1}); });

  // math
  var M1 = {abs: Math.abs, floor: Math.floor, ceil: Math.ceil, sqrt: Math.sqrt, exp: Math.exp, log: Math.log, log10: Math.log10, sign: Math.sign,
            sin: Math.sin, cos: Math.cos, tan: Math.tan, asin: Math.asin, acos: Math.acos, atan: Math.atan};
  Object.keys(M1).forEach(function(k){ var f = M1[k]; def('math.' + k, 'number', function(R, a){ return f(a[0]); }); });
  def('math.todegrees', 'radians', function(R, a){ return a[0] * 180 / Math.PI; });
  def('math.toradians', 'degrees', function(R, a){ return a[0] * Math.PI / 180; });
  def('math.pow', 'base exponent', function(R, a){ return Math.pow(a[0], a[1]); });
  def('math.round', 'number precision', function(R, a){
    var x = a[0], p = a[1];
    if (isNa(x)) return NaN;
    if (p === undefined || isNa(p)) return Math.round(x);
    var m = Math.pow(10, p); return Math.round(x * m) / m;
  });
  def('math.round_to_mintick', 'number', function(R, a){ var t = R.sym.mintick || 0.01; return Math.round(a[0] / t) * t; });
  def('math.max', '', function(R, a){ return Math.max.apply(null, a); }, {va: 1});
  def('math.min', '', function(R, a){ return Math.min.apply(null, a); }, {va: 1});
  def('math.avg', '', function(R, a){ var s = 0; for (var i = 0; i < a.length; i++) s += a[i]; return s / a.length; }, {va: 1});
  def('math.sum', 'source length', function(R, a, S, ln){
    var c = S.c, n = lenOf(a[1], ln); pushV(R, c, a[0]);
    if (!n || c.n < n) return NaN;
    var s = 0; for (var i = 0; i < n; i++) s += back(c, i); return s;
  }, stat(cellState));

  // ta: every call keeps the history of what it was given (its own cells), so it works anywhere it is called from
  function extreme(R, c, v, n, dir, bars){
    pushV(R, c, v);
    if (!n || c.n < n) return NaN;
    var m = NaN, at = 0;
    for (var i = 0; i < n; i++) { var x = back(c, i); if (x === x && (m !== m || (dir > 0 ? x > m : x < m))) { m = x; at = i; } }
    return bars ? (m === m ? -at : NaN) : m;
  }
  function hiLo(dir, bars){
    return function(R, a, S, ln){
      var src = a[0], len = a[1];
      if (len === undefined) { len = src; src = dir > 0 ? R.D.h[R.b] : R.D.l[R.b]; }
      else if (src === undefined) src = dir > 0 ? R.D.h[R.b] : R.D.l[R.b];
      return extreme(R, S.c, src, lenOf(len, ln), dir, bars);
    };
  }
  def('ta.highest', 'source length', hiLo(1, false), stat(cellState));
  def('ta.lowest', 'source length', hiLo(-1, false), stat(cellState));
  def('ta.highestbars', 'source length', hiLo(1, true), stat(cellState));
  def('ta.lowestbars', 'source length', hiLo(-1, true), stat(cellState));
  function windowSum(c, n){ var s = 0; for (var i = 0; i < n; i++) s += back(c, i); return s; }
  def('ta.sma', 'source length', function(R, a, S, ln){
    var c = S.c, n = lenOf(a[1], ln); pushV(R, c, a[0]);
    return !n || c.n < n ? NaN : windowSum(c, n) / n;
  }, stat(cellState));
  // ema and rma: seeded with the simple average of the first `length` values, as Pine's own
  function emaStep(R, S, v, n, alpha){
    var c = S.c; pushV(R, c, v);
    var prev = S.p, out;
    if (isNa(prev)) out = !n || c.n < n ? NaN : windowSum(c, n) / n;
    else out = alpha * v + (1 - alpha) * prev;
    jset(R, S, 'p', out);
    return out;
  }
  def('ta.ema', 'source length', function(R, a, S, ln){ var n = lenOf(a[1], ln); return emaStep(R, S, a[0], n, 2 / (n + 1)); }, stat(emaState));
  def('ta.rma', 'source length', function(R, a, S, ln){ var n = lenOf(a[1], ln); return emaStep(R, S, a[0], n, 1 / n); }, stat(emaState));
  def('ta.atr', 'length', function(R, a, S, ln){ var n = lenOf(a[0], ln); return emaStep(R, S, trAt(R, R.b, true), n, 1 / n); }, stat(emaState));
  def('ta.tr', 'handle_na', function(R, a){ return trAt(R, R.b, T(a[0])); });
  def('ta.wma', 'source length', function(R, a, S, ln){
    var c = S.c, n = lenOf(a[1], ln); pushV(R, c, a[0]);
    if (!n || c.n < n) return NaN;
    var s = 0, w = 0; for (var i = 0; i < n; i++) { s += back(c, i) * (n - i); w += n - i; } return s / w;
  }, stat(cellState));
  def('ta.vwma', 'source length', function(R, a, S, ln){
    var n = lenOf(a[1], ln), vol = R.D.v[R.b]; pushV(R, S.c, a[0] * vol); pushV(R, S.v, vol);
    return !n || S.c.n < n ? NaN : windowSum(S.c, n) / windowSum(S.v, n);
  }, stat(function(){ return {c: new Cell(true), v: new Cell(true)}; }));
  function pairState(){ return {a: new Cell(true), b: new Cell(true)}; }
  function crossing(kind){
    return function(R, a, S){
      pushV(R, S.a, a[0]); pushV(R, S.b, a[1]);
      var x = a[0], y = a[1], x1 = histC(S.a, 1), y1 = histC(S.b, 1);
      var up = x > y && x1 <= y1, dn = x < y && x1 >= y1;
      return kind > 0 ? up : kind < 0 ? dn : up || dn;
    };
  }
  def('ta.crossover', 'source1 source2', crossing(1), stat(pairState));
  def('ta.crossunder', 'source1 source2', crossing(-1), stat(pairState));
  def('ta.cross', 'source1 source2', crossing(0), stat(pairState));
  def('ta.change', 'source length', function(R, a, S, ln){
    var c = S.c, x = a[0]; pushV(R, c, x);
    var p = histC(c, a[1] === undefined ? 1 : idx(a[1], ln), ln);
    if (typeof x === 'boolean') return isNa(p) ? false : x !== p;
    return x - p;
  }, stat(cellState));
  def('ta.mom', 'source length', function(R, a, S, ln){ var c = S.c; pushV(R, c, a[0]); return a[0] - histC(c, idx(a[1], ln), ln); }, stat(cellState));
  def('ta.roc', 'source length', function(R, a, S, ln){ var c = S.c; pushV(R, c, a[0]); var p = histC(c, idx(a[1], ln), ln); return 100 * (a[0] - p) / p; }, stat(cellState));
  def('ta.rsi', 'source length', function(R, a, S, ln){
    var n = lenOf(a[1], ln), x = a[0], c = S.c; pushV(R, c, x);
    var p = histC(c, 1, ln), u = emaStep(R, S.u, Math.max(x - p, 0), n, 1 / n), d = emaStep(R, S.d, Math.max(p - x, 0), n, 1 / n);
    return 100 - 100 / (1 + u / d);
  }, stat(function(){ return {c: new Cell(true), u: emaState(), d: emaState()}; }));
  function moments(c, n, biased){
    var m = windowSum(c, n) / n, s = 0;
    for (var i = 0; i < n; i++) { var d = back(c, i) - m; s += d * d; }
    return {mean: m, v: s / (biased ? n : n - 1)};
  }
  def('ta.stdev', 'source length biased', function(R, a, S, ln){
    var c = S.c, n = lenOf(a[1], ln); pushV(R, c, a[0]);
    return !n || c.n < n ? NaN : Math.sqrt(moments(c, n, a[2] === undefined || T(a[2])).v);
  }, stat(cellState));
  def('ta.variance', 'source length biased', function(R, a, S, ln){
    var c = S.c, n = lenOf(a[1], ln); pushV(R, c, a[0]);
    return !n || c.n < n ? NaN : moments(c, n, a[2] === undefined || T(a[2])).v;
  }, stat(cellState));
  function meanDev(c, n){ var m = windowSum(c, n) / n, s = 0; for (var i = 0; i < n; i++) s += Math.abs(back(c, i) - m); return {mean: m, dev: s / n}; }
  def('ta.dev', 'source length', function(R, a, S, ln){
    var c = S.c, n = lenOf(a[1], ln); pushV(R, c, a[0]);
    return !n || c.n < n ? NaN : meanDev(c, n).dev;
  }, stat(cellState));
  def('ta.cci', 'source length', function(R, a, S, ln){
    var c = S.c, n = lenOf(a[1], ln); pushV(R, c, a[0]);
    if (!n || c.n < n) return NaN;
    var md = meanDev(c, n); return (a[0] - md.mean) / (0.015 * md.dev);
  }, stat(cellState));
  def('ta.median', 'source length', function(R, a, S, ln){
    var c = S.c, n = lenOf(a[1], ln); pushV(R, c, a[0]);
    if (!n || c.n < n) return NaN;
    var w = []; for (var i = 0; i < n; i++) w.push(back(c, i));
    w.sort(function(x, y){ return x - y; });
    return n % 2 ? w[n >> 1] : (w[n / 2 - 1] + w[n / 2]) / 2;
  }, stat(cellState));
  def('ta.linreg', 'source length offset', function(R, a, S, ln){
    var c = S.c, n = lenOf(a[1], ln), off = a[2] === undefined ? 0 : a[2]; pushV(R, c, a[0]);
    if (!n || c.n < n) return NaN;
    var sx = 0, sy = 0, sxy = 0, sxx = 0;
    for (var i = 0; i < n; i++) { var x = n - 1 - i, y = back(c, i); sx += x; sy += y; sxy += x * y; sxx += x * x; }
    var slope = (n * sxy - sx * sy) / (n * sxx - sx * sx), icpt = (sy - slope * sx) / n;
    return icpt + slope * (n - 1 - off);
  }, stat(cellState));
  def('ta.cum', 'source', function(R, a, S){ var x = a[0], s = S.s + (isNa(x) ? 0 : x); jset(R, S, 's', s); return s; }, stat(function(){ return {s: 0}; }));
  def('ta.barssince', 'condition', function(R, a, S){
    jset(R, S, 'k', S.k + 1);
    if (T(a[0])) jset(R, S, 'at', S.k);
    return S.at < 0 ? NaN : S.k - S.at;
  }, stat(function(){ return {k: -1, at: -1}; }));
  def('ta.valuewhen', 'condition source occurrence', function(R, a, S, ln){
    if (T(a[0])) pushV(R, S.c, a[1]);
    return histC(S.c, a[2] === undefined ? 0 : idx(a[2], ln), ln);
  }, stat(cellState));
  function pivot(dir){
    return function(R, a, S){
      var src = a[0], left = a[1], right = a[2];
      if (right === undefined) { right = left; left = src; src = dir > 0 ? R.D.h[R.b] : R.D.l[R.b]; }
      var c = S.c; pushV(R, c, src);
      left = Math.floor(left); right = Math.floor(right);
      if (!(left >= 0 && right >= 0) || c.n < left + right + 1) return NaN;
      var p = back(c, right);
      if (isNa(p)) return NaN;
      for (var i = 0; i <= left + right; i++) {
        if (i === right) continue;
        var x = back(c, i);
        if (isNa(x)) return NaN;
        if (i < right ? (dir > 0 ? x >= p : x <= p) : (dir > 0 ? x > p : x < p)) return NaN;   // newer bars: strictly beyond; older: not beyond
      }
      return p;
    };
  }
  def('ta.pivothigh', 'source leftbars rightbars', pivot(1), stat(cellState));
  def('ta.pivotlow', 'source leftbars rightbars', pivot(-1), stat(cellState));
  function trend(dir){
    return function(R, a, S, ln){
      var c = S.c, n = Math.floor(a[1]), x = a[0]; pushV(R, c, x);
      if (!(n >= 1) || c.n <= n) return false;
      for (var i = 1; i <= n; i++) { var p = back(c, i); if (!(dir > 0 ? x > p : x < p)) return false; }
      return true;
    };
  }
  def('ta.rising', 'source length', trend(1), stat(cellState));
  def('ta.falling', 'source length', trend(-1), stat(cellState));
  def('ta.macd', 'source fastlen slowlen siglen', function(R, a, S, ln){
    var f = lenOf(a[1], ln), s = lenOf(a[2], ln), g = lenOf(a[3], ln);
    var m = emaStep(R, S.f, a[0], f, 2 / (f + 1)) - emaStep(R, S.s, a[0], s, 2 / (s + 1)), sig = emaStep(R, S.g, m, g, 2 / (g + 1));
    return [m, sig, m - sig];
  }, stat(function(){ return {f: emaState(), s: emaState(), g: emaState()}; }));
  def('ta.bb', 'series length mult', function(R, a, S, ln){
    var c = S.c, n = lenOf(a[1], ln); pushV(R, c, a[0]);
    if (!n || c.n < n) return [NaN, NaN, NaN];
    var mo = moments(c, n, true), d = a[2] * Math.sqrt(mo.v);
    return [mo.mean, mo.mean + d, mo.mean - d];
  }, stat(cellState));
  def('ta.stoch', 'source high low length', function(R, a, S, ln){
    var n = lenOf(a[3], ln), hh = extreme(R, S.h, a[1], n, 1), ll = extreme(R, S.l, a[2], n, -1);
    return 100 * (a[0] - ll) / (hh - ll);
  }, stat(function(){ return {h: new Cell(true), l: new Cell(true)}; }));

  // the rest of ta. that indicators use
  function wmaOf(c, n){ var s = 0, w = 0; for (var i = 0; i < n; i++) { s += back(c, i) * (n - i); w += n - i; } return s / w; }
  def('ta.hma', 'source length', function(R, a, S, ln){
    var n = lenOf(a[1], ln), h = Math.max(1, Math.floor(n / 2)), q = Math.max(1, Math.floor(Math.sqrt(n)));
    pushV(R, S.c, a[0]);
    var raw = !n || S.c.n < n ? NaN : 2 * wmaOf(S.c, h) - wmaOf(S.c, n);
    pushV(R, S.d, raw);
    return S.d.n < q ? NaN : wmaOf(S.d, q);
  }, stat(function(){ return {c: new Cell(true), d: new Cell(true)}; }));
  def('ta.swma', 'source', function(R, a, S){
    var c = S.c; pushV(R, c, a[0]);
    return c.n < 4 ? NaN : (back(c, 3) + 2 * back(c, 2) + 2 * back(c, 1) + back(c, 0)) / 6;
  }, stat(cellState));
  def('ta.alma', 'series length offset sigma floor', function(R, a, S, ln){
    var c = S.c, n = lenOf(a[1], ln), off = a[2] === undefined ? 0.85 : a[2], sig = a[3] === undefined ? 6 : a[3]; pushV(R, c, a[0]);
    if (!n || c.n < n) return NaN;
    var m = T(a[4]) ? Math.floor(off * (n - 1)) : off * (n - 1), s = n / sig, norm = 0, sum = 0;
    for (var i = 0; i < n; i++) { var w = Math.exp(-((i - m) * (i - m)) / (2 * s * s)); norm += w; sum += back(c, n - 1 - i) * w; }
    return sum / norm;
  }, stat(cellState));
  def('ta.range', 'source length', function(R, a, S, ln){
    var n = lenOf(a[1], ln); return extreme(R, S.h, a[0], n, 1) - extreme(R, S.l, a[0], n, -1);
  }, stat(function(){ return {h: new Cell(true), l: new Cell(true)}; }));
  def('ta.max', 'source', function(R, a, S){ var x = a[0]; if (x === x && !(x <= S.m)) jset(R, S, 'm', x); return S.m; }, stat(function(){ return {m: NaN}; }));
  def('ta.min', 'source', function(R, a, S){ var x = a[0]; if (x === x && !(x >= S.m)) jset(R, S, 'm', x); return S.m; }, stat(function(){ return {m: NaN}; }));
  def('ta.wpr', 'length', function(R, a, S, ln){
    var n = lenOf(a[0], ln), D = R.D, hh = extreme(R, S.h, D.h[R.b], n, 1), ll = extreme(R, S.l, D.l[R.b], n, -1);
    return 100 * (D.c[R.b] - hh) / (hh - ll);
  }, stat(function(){ return {h: new Cell(true), l: new Cell(true)}; }));
  def('ta.bbw', 'series length mult', function(R, a, S, ln){
    var c = S.c, n = lenOf(a[1], ln); pushV(R, c, a[0]);
    if (!n || c.n < n) return NaN;
    var mo = moments(c, n, true); return 2 * a[2] * Math.sqrt(mo.v) / mo.mean;
  }, stat(cellState));
  def('ta.percentrank', 'source length', function(R, a, S, ln){
    var c = S.c, n = lenOf(a[1], ln), x = a[0]; pushV(R, c, x);
    if (!n || c.n <= n || isNa(x)) return NaN;
    var k = 0; for (var i = 1; i <= n; i++) if (back(c, i) <= x) k++;
    return 100 * k / n;
  }, stat(cellState));
  def('ta.correlation', 'source1 source2 length', function(R, a, S, ln){
    var n = lenOf(a[2], ln); pushV(R, S.a, a[0]); pushV(R, S.b, a[1]);
    if (!n || S.a.n < n) return NaN;
    var ma = windowSum(S.a, n) / n, mb = windowSum(S.b, n) / n, sab = 0, saa = 0, sbb = 0;
    for (var i = 0; i < n; i++) { var x = back(S.a, i) - ma, y = back(S.b, i) - mb; sab += x * y; saa += x * x; sbb += y * y; }
    return sab / Math.sqrt(saa * sbb);
  }, stat(pairState));
  def('ta.cmo', 'series length', function(R, a, S, ln){
    var c = S.c, n = lenOf(a[1], ln); pushV(R, c, a[0]);
    if (!n || c.n <= n) return NaN;
    var up = 0, dn = 0;
    for (var i = 0; i < n; i++) { var d = back(c, i) - back(c, i + 1); if (d > 0) up += d; else dn -= d; }
    return 100 * (up - dn) / (up + dn);
  }, stat(cellState));
  function keltner(R, a, S, ln){
    var n = lenOf(a[1], ln), D = R.D, useTr = a[3] === undefined || T(a[3]);
    var mid = emaStep(R, S.m, a[0], n, 2 / (n + 1)), rg = emaStep(R, S.r, useTr ? trAt(R, R.b, true) : D.h[R.b] - D.l[R.b], n, 2 / (n + 1));
    return [mid, mid + rg * a[2], mid - rg * a[2]];
  }
  function kcState(){ return {m: emaState(), r: emaState()}; }
  def('ta.kc', 'series length mult useTrueRange', keltner, stat(kcState));
  def('ta.kcw', 'series length mult useTrueRange', function(R, a, S, ln){ var k = keltner(R, a, S, ln); return (k[1] - k[2]) / k[0]; }, stat(kcState));
  def('ta.mfi', 'series length', function(R, a, S, ln){
    var n = lenOf(a[1], ln), x = a[0], vol = R.D.v[R.b]; pushV(R, S.c, x);
    var ch = x - histC(S.c, 1); pushV(R, S.u, ch > 0 ? vol * x : 0); pushV(R, S.d, ch < 0 ? vol * x : 0);
    if (!n || S.u.n < n) return NaN;
    var up = windowSum(S.u, n), dn = windowSum(S.d, n); return 100 - 100 / (1 + up / dn);
  }, stat(function(){ return {c: new Cell(true), u: new Cell(true), d: new Cell(true)}; }));
  def('ta.tsi', 'source short_length long_length', function(R, a, S, ln){
    var x = a[0], sh = lenOf(a[1], ln), lg = lenOf(a[2], ln); pushV(R, S.c, x);
    var pc = x - histC(S.c, 1);
    var num = emaStep(R, S.n2, emaStep(R, S.n1, pc, lg, 2 / (lg + 1)), sh, 2 / (sh + 1));
    var den = emaStep(R, S.d2, emaStep(R, S.d1, Math.abs(pc), lg, 2 / (lg + 1)), sh, 2 / (sh + 1));
    return num / den;
  }, stat(function(){ return {c: new Cell(true), n1: emaState(), n2: emaState(), d1: emaState(), d2: emaState()}; }));
  def('ta.dmi', 'diLength adxSmoothing', function(R, a, S, ln){
    var n = lenOf(a[0], ln), m = lenOf(a[1], ln), D = R.D, b = R.b;
    var up = b > 0 ? D.h[b] - D.h[b - 1] : NaN, dn = b > 0 ? D.l[b - 1] - D.l[b] : NaN;
    var pdm = isNa(up) ? NaN : up > dn && up > 0 ? up : 0, mdm = isNa(dn) ? NaN : dn > up && dn > 0 ? dn : 0;
    var tr = emaStep(R, S.t, trAt(R, b, false), n, 1 / n);
    var p = 100 * emaStep(R, S.p, pdm, n, 1 / n) / tr, q = 100 * emaStep(R, S.q, mdm, n, 1 / n) / tr;
    if (isNa(p)) p = S.lp; else jset(R, S, 'lp', p);
    if (isNa(q)) q = S.lq; else jset(R, S, 'lq', q);
    var sum = p + q, adx = 100 * emaStep(R, S.a, Math.abs(p - q) / (sum === 0 ? 1 : sum), m, 1 / m);
    return [p, q, adx];
  }, stat(function(){ return {t: emaState(), p: emaState(), q: emaState(), a: emaState(), lp: NaN, lq: NaN}; }));
  def('ta.supertrend', 'factor atrPeriod', function(R, a, S, ln){
    var D = R.D, b = R.b, n = lenOf(a[1], ln), src = (D.h[b] + D.l[b]) / 2, prevAtr = S.atr.p;
    var atr = emaStep(R, S.atr, trAt(R, b, true), n, 1 / n);
    var up = src + a[0] * atr, lo = src - a[0] * atr, pl = isNa(S.lo) ? 0 : S.lo, pu = isNa(S.up) ? 0 : S.up, pc = b > 0 ? D.c[b - 1] : NaN;
    lo = lo > pl || pc < pl ? lo : pl;
    up = up < pu || pc > pu ? up : pu;
    var dir = isNa(prevAtr) ? 1 : S.st === pu ? (D.c[b] > up ? -1 : 1) : (D.c[b] < lo ? 1 : -1), st = dir === -1 ? lo : up;
    jset(R, S, 'lo', lo); jset(R, S, 'up', up); jset(R, S, 'st', st);
    return [st, dir];
  }, stat(function(){ return {atr: emaState(), lo: NaN, up: NaN, st: NaN}; }));
  def('ta.sar', 'start inc max', function(R, a, S){
    var D = R.D, b = R.b, start = a[0], inc = a[1], mx = a[2], first = false, res = S.res, mm = S.mm, acc = S.acc, below = S.below;
    if (b === 1) {
      if (D.c[1] > D.c[0]) { below = true; mm = D.h[1]; res = D.l[0]; } else { below = false; mm = D.l[1]; res = D.h[0]; }
      first = true; acc = start;
    }
    res = res + acc * (mm - res);
    if (below) { if (res > D.l[b]) { first = true; below = false; res = Math.max(D.h[b], mm); mm = D.l[b]; acc = start; } }
    else if (res < D.h[b]) { first = true; below = true; res = Math.min(D.l[b], mm); mm = D.h[b]; acc = start; }
    if (!first) {
      if (below) { if (D.h[b] > mm) { mm = D.h[b]; acc = Math.min(acc + inc, mx); } }
      else if (D.l[b] < mm) { mm = D.l[b]; acc = Math.min(acc + inc, mx); }
    }
    if (below) { res = Math.min(res, D.l[b - 1]); if (b > 1) res = Math.min(res, D.l[b - 2]); }
    else { res = Math.max(res, D.h[b - 1]); if (b > 1) res = Math.max(res, D.h[b - 2]); }
    jset(R, S, 'res', res); jset(R, S, 'mm', mm); jset(R, S, 'acc', acc); jset(R, S, 'below', below);
    return res;
  }, stat(function(){ return {res: NaN, mm: NaN, acc: NaN, below: false}; }));
  // vwap from the start of each UTC day (the session of crypto), with bands when stdev_mult is given
  def('ta.vwap', 'source anchor stdev_mult', function(R, a, S){
    var D = R.D, b = R.b, x = a[0], vol = D.v[b];
    var reset = a[1] === undefined ? b === 0 || Math.floor(D.t[b] / 864e5) !== Math.floor(D.t[b - 1] / 864e5) : T(a[1]);
    var sv = (reset ? 0 : S.sv) + x * vol, s2 = (reset ? 0 : S.s2) + x * x * vol, sw = (reset ? 0 : S.sw) + vol;
    jset(R, S, 'sv', sv); jset(R, S, 's2', s2); jset(R, S, 'sw', sw);
    var v = sv / sw;
    if (a[2] === undefined) return v;
    var dev = Math.sqrt(Math.max(0, s2 / sw - v * v)) * a[2];
    return [v, v + dev, v - dev];
  }, stat(function(){ return {sv: 0, s2: 0, sw: 0}; }));
  ALIAS.vwap = 'ta.vwap';

  // the functions of fixed values give fixed values (an input, a constant …), so they can feed titles, styles and show_last
  ('na nz float int bool string color iff math.todegrees math.toradians math.pow math.round math.round_to_mintick math.max math.min math.avg ' +
   Object.keys(M1).map(function(k){ return 'math.' + k; }).join(' ')).split(' ').forEach(function(k){ BI[k].pure = true; });

  // strings
  function strArg(x){ return typeof x === 'string' ? x : isNa(x) ? null : tostr(x); }
  function str1(name, f){ def('str.' + name, 'source', function(R, a){ var s = strArg(a[0]); return s === null ? NaN : f(s); }, {pure: true}); }
  function str2(name, f){ def('str.' + name, 'source str', function(R, a){ var s = strArg(a[0]), t = strArg(a[1]); return s === null || t === null ? NaN : f(s, t); }, {pure: true}); }
  def('str.tostring', 'value format', function(R, a){
    var v = a[0], f = a[1];
    if (f === 'mintick' && typeof v === 'number') {
      if (isNa(v)) return 'NaN';
      var t = R.sym.mintick || 0.01, d = Math.max(0, Math.min(12, Math.ceil(-Math.log10(t) - 1e-9)));
      return (Math.round(v / t) * t).toFixed(d);
    }
    return tostr(v, f);
  }, {pure: true});
  def('str.tonumber', 'string', function(R, a){
    var s = strArg(a[0]);
    if (s === null) return NaN;
    s = s.trim();
    return /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(s) ? parseFloat(s) : NaN;
  }, {pure: true});
  str1('length', function(s){ return s.length; });
  str1('lower', function(s){ return s.toLowerCase(); });
  str1('upper', function(s){ return s.toUpperCase(); });
  str1('trim', function(s){ return s.trim(); });
  str2('contains', function(s, t){ return s.indexOf(t) >= 0; });
  str2('startswith', function(s, t){ return s.slice(0, t.length) === t; });
  str2('endswith', function(s, t){ return t.length === 0 || s.slice(-t.length) === t; });
  str2('pos', function(s, t){ var i = s.indexOf(t); return i < 0 ? NaN : i; });
  def('str.substring', 'source begin_pos end_pos', function(R, a){
    var s = strArg(a[0]); if (s === null) return NaN;
    return s.substring(a[1], a[2] === undefined || isNa(a[2]) ? s.length : a[2]);
  }, {pure: true});
  def('str.replace', 'source target replacement occurrence', function(R, a){
    var s = strArg(a[0]), t = strArg(a[1]), r = strArg(a[2]) || '', occ = a[3] === undefined ? 0 : Math.floor(a[3]), i = -1;
    if (s === null) return NaN;
    if (!t) return s;
    for (var k = 0; k <= occ; k++) { i = s.indexOf(t, i < 0 ? 0 : i + t.length); if (i < 0) return s; }
    return s.slice(0, i) + r + s.slice(i + t.length);
  }, {pure: true});
  def('str.replace_all', 'source target replacement', function(R, a){
    var s = strArg(a[0]), t = strArg(a[1]); if (s === null) return NaN; return t ? s.split(t).join(strArg(a[2]) || '') : s;
  }, {pure: true});
  def('str.repeat', 'source repeat separator', function(R, a){
    var s = strArg(a[0]), n = Math.min(1e4, Math.max(0, Math.floor(a[1]) || 0)), out = [];
    if (s === null) return NaN;
    for (var i = 0; i < n; i++) out.push(s);
    return out.join(a[2] === undefined ? '' : strArg(a[2]) || '');
  }, {pure: true});
  function groupNum(v){                                             // Java's default number format: 1,234.568
    var s = numStr(+v.toFixed(3)), p = s.split('.');
    p[0] = p[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return p.join('.');
  }
  def('str.format', '', function(R, a){
    var f = strArg(a[0]);
    if (f === null) return NaN;
    return f.replace(/\{(\d+)(?:,\s*(number|date|time)(?:,\s*([^}]*))?)?\}/g, function(m, i, kind, style){
      var v = a[+i + 1];
      if (v === undefined) return m;
      if (kind === 'number') {
        if (isNa(v)) return 'NaN';
        style = (style || '').trim();
        if (style === 'integer') return groupNum(Math.round(v));
        if (style === 'percent') return groupNum(Math.round(v * 100)) + '%';
        if (style === 'currency') return '$' + groupNum(+v.toFixed(2));
        return style ? tostr(v, style) : groupNum(v);
      }
      if (kind) return fmtTime(v, style || (kind === 'date' ? 'yyyy-MM-dd' : 'HH:mm:ss'), '');
      return typeof v === 'string' ? v : typeof v === 'number' && !isNa(v) ? groupNum(v) : tostr(v);
    });
  }, {va: 1, pure: true});
  def('str.format_time', 'time format timezone', function(R, a){ return fmtTime(a[0], a[1] === undefined ? "yyyy-MM-dd'T'HH:mm:ssZ" : a[1], a[2]); }, {pure: true});

  // time: the exchange time zone of crypto is UTC; a time zone argument may be "UTC+3", "GMT-5:30" or a name ("America/New_York")
  var ZF = {};
  function tzOff(t, tz){                                         // minutes east of UTC at time t
    if (typeof tz !== 'string' || !tz || isNa(t)) return 0;
    var m = /^(?:UTC|GMT)?\s*([+-])(\d{1,2})(?::?(\d{2}))?$/.exec(tz.trim());
    if (m) return (m[1] === '-' ? -1 : 1) * (+m[2] * 60 + (+m[3] || 0));
    if (/^(UTC|GMT|Etc\/UTC|Z)$/i.test(tz.trim())) return 0;
    try {
      var f = ZF[tz] || (ZF[tz] = new Intl.DateTimeFormat('en-US', {timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric',
                                                                    hour: 'numeric', minute: 'numeric', second: 'numeric'}));
      var p = {}; f.formatToParts(new Date(t)).forEach(function(x){ p[x.type] = +x.value; });
      return Math.round((Date.UTC(p.year, p.month - 1, p.day, p.hour % 24, p.minute, p.second) - Math.floor(t / 1000) * 1000) / 60000);
    } catch (e) { return 0; }
  }
  var MON = 'January February March April May June July August September October November December'.split(' ');
  var DAYN = 'Sunday Monday Tuesday Wednesday Thursday Friday Saturday'.split(' ');
  function pad(x, n){ x = String(x); while (x.length < n) x = '0' + x; return x; }
  function fmtTime(t, f, tz){                                    // Java's date patterns: yyyy MM MMM dd HH hh mm ss SSS a EEE Z, 'quoted'
    if (isNa(t)) return 'NaN';
    var off = tzOff(t, tz), d = new Date(t + off * 60000);
    return String(f).replace(/'([^']*)'|y+|M+|d+|H+|h+|m+|s+|S+|a|E+|Z+|z+/g, function(m, q){
      if (q !== undefined) return q || "'";
      var n = m.length;
      switch (m[0]) {
        case 'y': return n === 2 ? pad(d.getUTCFullYear() % 100, 2) : pad(d.getUTCFullYear(), n);
        case 'M': return n >= 4 ? MON[d.getUTCMonth()] : n === 3 ? MON[d.getUTCMonth()].slice(0, 3) : pad(d.getUTCMonth() + 1, n);
        case 'd': return pad(d.getUTCDate(), n);
        case 'H': return pad(d.getUTCHours(), n);
        case 'h': return pad(d.getUTCHours() % 12 || 12, n);
        case 'm': return pad(d.getUTCMinutes(), n);
        case 's': return pad(d.getUTCSeconds(), n);
        case 'S': return pad(d.getUTCMilliseconds(), 3).slice(0, n);
        case 'a': return d.getUTCHours() < 12 ? 'AM' : 'PM';
        case 'E': return n >= 4 ? DAYN[d.getUTCDay()] : DAYN[d.getUTCDay()].slice(0, 3);
        default: var s = off < 0 ? '-' : '+', o = Math.abs(off); return s + pad(Math.floor(o / 60), 2) + pad(o % 60, 2);
      }
    });
  }
  Object.keys(DATEF).forEach(function(k){
    var f = DATEF[k];
    def(k, 'time timezone', function(R, a){ var t = a[0]; return isNa(t) ? NaN : f(new Date(t + tzOff(t, a[1]) * 60000)); }, {pure: true, need: 1});
  });
  def('timestamp', '', function(R, a){
    var i = 0, tz = '';
    if (typeof a[0] === 'string' && a.length === 1) {
      var s = a[0].trim();
      if (!/([zZ]|[+-]\d{2}:?\d{2}|GMT|UTC)$/.test(s)) s += /^\d{4}-\d{2}-\d{2}T/.test(s) ? 'Z' : ' UTC';
      var ms = Date.parse(s); return isNaN(ms) ? NaN : ms;
    }
    if (typeof a[0] === 'string') { tz = a[0]; i = 1; }
    var y = a[i], mo = a[i + 1], d = a[i + 2];
    if (isNa(y) || isNa(mo) || isNa(d)) return NaN;
    var t = Date.UTC(y, mo - 1, d, a[i + 3] || 0, a[i + 4] || 0, a[i + 5] || 0);
    return tz ? t - tzOff(t, tz) * 60000 : t;
  }, {va: 1, pure: true});
  // timeframes: "" (the chart's own), "30S", "15" (minutes), "240", "D", "3D", "W", "M", "12M"
  var TFS = {S: 1, m: 60, D: 86400, W: 604800, M: 2628003};
  function tfParse(tf){
    if (typeof tf !== 'string') return null;
    var m = /^(\d*)([SDWM])$/.exec(tf.trim());
    if (m) return {n: +m[1] || 1, u: m[2]};
    if ((m = /^(\d+)$/.exec(tf.trim()))) return {n: +m[1], u: 'm'};
    if ((m = /^(\d+)[hH]$/.exec(tf.trim()))) return {n: +m[1] * 60, u: 'm'};
    return null;
  }
  var MONDAY = 4 * 864e5;                                        // 1970-01-05, the first Monday
  function tfStart(t, p){
    switch (p.u) {
      case 'S': return Math.floor(t / (p.n * 1e3)) * p.n * 1e3;
      case 'm': return Math.floor(t / (p.n * 6e4)) * p.n * 6e4;
      case 'D': return Math.floor(t / (p.n * 864e5)) * p.n * 864e5;
      case 'W': var w = p.n * 7 * 864e5; return Math.floor((t - MONDAY) / w) * w + MONDAY;
    }
    var d = new Date(t), mm = d.getUTCFullYear() * 12 + d.getUTCMonth(), m0 = Math.floor(mm / p.n) * p.n;
    return Date.UTC(Math.floor(m0 / 12), m0 % 12, 1);
  }
  function tfEnd(s, p){
    if (p.u !== 'M') return s + p.n * TFS[p.u] * 1e3;
    var d = new Date(s); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + p.n, 1);
  }
  function inSession(t, sess, tz){
    if (typeof sess !== 'string' || !sess || sess === '24x7') return true;
    var m = /^([\d,\-]+)(?::([1-7]+))?$/.exec(sess.replace(/\s/g, ''));
    if (!m) return true;
    var d = new Date(t + tzOff(t, tz) * 60000), mins = d.getUTCHours() * 60 + d.getUTCMinutes();
    if (m[2] && m[2].indexOf(String(d.getUTCDay() + 1)) < 0) return false;
    return m[1].split(',').some(function(r){
      var q = /^(\d{2})(\d{2})-(\d{2})(\d{2})$/.exec(r);
      if (!q) return false;
      var a = +q[1] * 60 + +q[2], b = +q[3] * 60 + +q[4];
      return a === b || (a < b ? mins >= a && mins < b : mins >= a || mins < b);
    });
  }
  function tfTime(R, tf, sess, tz, close){
    var j = R.b, t = R.D.t[j];
    if (!inSession(t, sess, tz)) return NaN;
    if (tf === undefined || isNa(tf) || tf === '' || tf === R.sym.period) return close ? R.D.e[j] : t;
    var p = tfParse(tf);
    if (!p) { warn(R, 'the timeframe "' + tf + '" is not one this chart understands: the bar\'s own time is used'); return close ? R.D.e[j] : t; }
    var s = tfStart(t, p); return close ? tfEnd(s, p) : s;
  }
  def('time', 'timeframe session timezone', function(R, a){ return tfTime(R, a[0], a[1], a[2], false); });
  def('time_close', 'timeframe session timezone', function(R, a){ return tfTime(R, a[0], a[1], a[2], true); });
  def('timeframe.change', 'timeframe', function(R, a){
    var p = tfParse(a[0]), b = R.b, t = R.D.t;
    if (!p) return true;
    return b === 0 || tfStart(t[b], p) !== tfStart(t[b - 1], p);
  });
  def('timeframe.in_seconds', 'timeframe', function(R, a){
    var p = tfParse(a[0] === undefined || a[0] === '' ? R.sym.period : a[0]); return p ? p.n * TFS[p.u] : NaN;
  }, {pure: true});
  def('timeframe.from_seconds', 'seconds', function(R, a){
    var s = Math.floor(a[0]);
    if (!(s > 0)) return NaN;
    if (s < 60) return s + 'S';
    if (s % 604800 === 0) return s / 604800 + 'W';
    if (s % 86400 === 0) return s / 86400 + 'D';
    return String(Math.max(1, Math.round(s / 60)));
  }, {pure: true});

  // colors
  def('color.new', 'color transp', function(R, a){ return setT(a[0], a[1]); }, {pure: true});
  def('color.rgb', 'red green blue transp', function(R, a){ return rgbC(a[0], a[1], a[2], a[3]); }, {pure: true});
  [['r', cR], ['g', cG], ['b', cB], ['t', cT]].forEach(function(p){ var f = p[1]; def('color.' + p[0], 'color', function(R, a){ return isNa(a[0]) ? NaN : f(a[0]); }, {pure: true}); });
  def('color.from_gradient', 'value bottom_value top_value bottom_color top_color', function(R, a){
    var v = a[0], lo = a[1], hi = a[2], c1 = a[3], c2 = a[4];
    if (isNa(v) || isNa(lo) || isNa(hi) || isNa(c1) || isNa(c2)) return NaN;
    var f = hi === lo ? 1 : Math.max(0, Math.min(1, (v - lo) / (hi - lo))), mix = function(x, y){ return x + (y - x) * f; };
    return rgbC(mix(cR(c1), cR(c2)), mix(cG(c1), cG(c2)), mix(cB(c1), cB(c2)), mix(cT(c1), cT(c2)));
  }, {pure: true});

  // labels and lines: objects; the oldest go once a script has more than max_labels_count / max_lines_count (50 unless
  // indicator() says, 500 at most), as in TradingView. Every change goes through jset, so the forming bar undoes it.
  function Store(max){ this.m = Object.create(null); this.live = 0; this.lo = 0; this.seq = 0; this.max = max; this.made = 0; }
  function addDrawing(R, st, o){
    var id = st.seq;
    jset(R, st, 'seq', id + 1); o.id = id;
    jset(R, st.m, id, o); jset(R, st, 'live', st.live + 1);
    while (st.live > st.max) {
      var lo = st.lo; while (!st.m[lo]) lo++;
      jset(R, st, 'lo', lo + 1);
      killDrawing(R, st, st.m[lo]);
    }
    return o;
  }
  function killDrawing(R, st, o){ if (o && typeof o === 'object' && st.m[o.id] === o) { jset(R, st.m, o.id, undefined); jset(R, st, 'live', st.live - 1); } }
  function isObj(o, t){ return !!o && typeof o === 'object' && o.t === t; }
  function strOf(v){ return typeof v === 'string' ? v : isNa(v) ? '' : tostr(v); }
  function setters(t, list){                                     // [name, 'params', fields to set from the params]
    list.forEach(function(s){
      var keys = s[2].split(' '), conv = s[3], nk = keys.length;
      def(t + '.set_' + s[0], 'id ' + s[1], function(R, a){
        var o = a[0];
        if (!isObj(o, t)) return NaN;
        for (var i = 0; i < nk; i++) if (a[i + 1] !== undefined) jset(R, o, keys[i], conv ? conv(a[i + 1]) : a[i + 1]);
        return NaN;
      });
    });
  }
  def('label.new', 'x y text xloc yloc color style textcolor size textalign tooltip text_font_family force_overlay text_formatting', function(R, a){
    var u = function(i, d){ return a[i] === undefined ? d : a[i]; };
    return addDrawing(R, R.LB, {t: 'label', id: 0, x: a[0], y: a[1], text: strOf(u(2, '')), xloc: u(3, 'bi'), yloc: u(4, 'price'), color: u(5, R.C.blue),
                                style: u(6, 'down'), tc: u(7, BLACK), size: u(8, 'normal'), align: u(9, 'center'), tip: strOf(u(10, '')),
                                font: u(11, 'default'), fmt: u(13, 0)});
  });
  var BLACK = 255;                                               // #000000, opaque
  setters('label', [['x', 'x', 'x'], ['y', 'y', 'y'], ['xy', 'x y', 'x y'], ['text', 'text', 'text', strOf], ['xloc', 'x xloc', 'x xloc'],
                    ['yloc', 'yloc', 'yloc'], ['color', 'color', 'color'], ['style', 'style', 'style'], ['textcolor', 'textcolor', 'tc'],
                    ['size', 'size', 'size'], ['textalign', 'textalign', 'align'], ['tooltip', 'tooltip', 'tip', strOf],
                    ['text_font_family', 'text_font_family', 'font'], ['text_formatting', 'text_formatting', 'fmt']]);
  def('label.get_x', 'id', function(R, a){ return isObj(a[0], 'label') ? a[0].x : NaN; });
  def('label.get_y', 'id', function(R, a){ return isObj(a[0], 'label') ? a[0].y : NaN; });
  def('label.get_text', 'id', function(R, a){ return isObj(a[0], 'label') ? a[0].text : NaN; });
  def('label.delete', 'id', function(R, a){ killDrawing(R, R.LB, a[0]); return NaN; });
  def('label.copy', 'id', function(R, a){
    var o = a[0]; if (!isObj(o, 'label')) return NaN;
    var c = {}; for (var k in o) c[k] = o[k]; return addDrawing(R, R.LB, c);
  });
  def('line.new', 'x1 y1 x2 y2 xloc extend color style width force_overlay', function(R, a){
    var u = function(i, d){ return a[i] === undefined ? d : a[i]; };
    return addDrawing(R, R.LN, {t: 'line', id: 0, x1: a[0], y1: a[1], x2: a[2], y2: a[3], xloc: u(4, 'bi'), ext: u(5, 'n'), color: u(6, R.C.blue),
                                style: u(7, 'solid'), width: u(8, 1)});
  });
  setters('line', [['x1', 'x', 'x1'], ['y1', 'y', 'y1'], ['x2', 'x', 'x2'], ['y2', 'y', 'y2'], ['xy1', 'x y', 'x1 y1'], ['xy2', 'x y', 'x2 y2'],
                   ['xloc', 'x1 x2 xloc', 'x1 x2 xloc'], ['extend', 'extend', 'ext'], ['color', 'color', 'color'], ['style', 'style', 'style'],
                   ['width', 'width', 'width']]);
  ['x1', 'y1', 'x2', 'y2'].forEach(function(k){ def('line.get_' + k, 'id', function(R, a){ return isObj(a[0], 'line') ? a[0][k] : NaN; }); });
  def('line.get_price', 'id x', function(R, a){
    var o = a[0]; if (!isObj(o, 'line')) return NaN;
    return o.x2 === o.x1 ? o.y1 : o.y1 + (o.y2 - o.y1) * (a[1] - o.x1) / (o.x2 - o.x1);
  });
  def('line.delete', 'id', function(R, a){ killDrawing(R, R.LN, a[0]); return NaN; });
  def('line.copy', 'id', function(R, a){
    var o = a[0]; if (!isObj(o, 'line')) return NaN;
    var c = {}; for (var k in o) c[k] = o[k]; return addDrawing(R, R.LN, c);
  });

  // ---------------------------------------------------------------- what the script draws: plots, shapes, background, hlines, fills
  // Each call is one output (R.outs), made when the script is compiled; on every bar it records its value for that bar.
  // Their fixed arguments (title, style, location, show_last …) are worked out once.
  var SIG = {
    plot: ['series title color linewidth style transp trackprice histbase offset join editable show_last display',
           'series title color linewidth style trackprice histbase offset join editable show_last display format precision force_overlay linestyle'],
    plotshape: ['series title style location color transp offset text textcolor editable size show_last display',
                'series title style location color offset text textcolor editable size show_last display format precision force_overlay'],
    plotchar: ['series title char location color transp offset text textcolor editable size show_last display',
               'series title char location color offset text textcolor editable size show_last display format precision force_overlay'],
    plotarrow: ['series title colorup colordown transp offset minheight maxheight editable show_last display',
                'series title colorup colordown offset minheight maxheight editable show_last display format precision force_overlay'],
    bgcolor: ['color transp offset editable show_last title', 'color offset editable show_last title display force_overlay'],
    hline: ['price title color linestyle linewidth editable', 'price title color linestyle linewidth editable display'],
    fill: ['plot1 plot2 color transp title editable show_last fillgaps', 'plot1 plot2 color title editable show_last fillgaps display'],
    fillg: ['', 'plot1 plot2 top_value bottom_value top_color bottom_color title display fillgaps editable']
  };
  function sig(nm, ver){ return SIG[nm][ver < 5 ? 0 : 1].split(' '); }
  function topOnly(sc, nm, ln){ if (!sc.top) fail(nm + ' is used at the top level of the script, not inside a block or a function', ln); }
  function out(R, o){ o.i = R.outs.length; R.outs.push(o); return o; }
  function fixedArgs(C, n, sc, ps, extra){
    var bd = C.bind(ps, n, sc, extra);
    bd.K = function(k, d){ return bd.nd[k] ? C.constant(bd.nd[k], sc) : d; };
    return bd;
  }
  function colorArg(C, node, sc, d){                             // a fixed color, or one that changes from bar to bar
    if (!node) return {c: d};
    if (C.isConst(node, sc)) return {c: C.constant(node, sc)};
    return {f: C.E(node, sc)};
  }
  function withT(c, t){                                          // v4's transp: for colors that have no transparency of their own
    if (t === undefined || isNa(t) || typeof c !== 'number' || c !== c) return c;
    return (c & 255) === 255 ? setT(c, t) : c;
  }
  function isColorNode(x){ return !!x && (x.k === 'col' || ((x.k === 'id' || x.k === 'call') && /^color\./.test(x.name))); }
  function extraT(R){ return R.ver >= 5 ? ['transp'] : null; }

  def('plot', '', null, {compile: function(n, sc, C){
    var R = C.R, ln = n.ln; topOnly(sc, 'plot', ln);
    var bd = fixedArgs(C, n, sc, sig('plot', R.ver), extraT(R)), K = bd.K, f = bd.f;
    if (!f.series) fail('plot needs the series it draws', ln);
    var tr = K('transp', undefined), col = colorArg(C, bd.nd.color, sc, R.C.blue);
    var o = out(R, {kind: 'plot', title: strOf(K('title', '')), style: K('style', 'line'), lw: K('linewidth', 1), trackprice: T(K('trackprice', false)),
                    histbase: K('histbase', 0), offset: Math.trunc(K('offset', 0)) || 0, join: T(K('join', false)), show_last: K('show_last', NaN),
                    display: K('display', 15), dash: K('linestyle', 'solid'), v: new Grow(), c: col.f ? new Grow() : null,
                    color: col.f ? NaN : withT(col.c, tr)});
    var sf = f.series, cf = col.f, pid = o.i, V = o.v, CC = o.c;
    var fn = function(I){
      var v = sf(I), b = R.b;
      V.set(b, typeof v === 'number' ? v : v === true ? 1 : v === false ? 0 : NaN);
      if (cf) CC.set(b, withT(cf(I), tr));
      return pid;
    };
    fn.pid = pid;
    return fn;
  }});

  // plotshape / plotchar / plotarrow: one entry for each bar they show on (most bars show none)
  function shapeC(sub){
    var nm = 'plot' + sub;
    return function(n, sc, C){
      var R = C.R, ln = n.ln; topOnly(sc, nm, ln);
      var bd = fixedArgs(C, n, sc, sig(nm, R.ver), extraT(R)), K = bd.K, f = bd.f, nd = bd.nd;
      if (!f.series) fail(nm + ' needs the series that says on which bars it draws', ln);
      var tr = K('transp', undefined), arrow = sub === 'arrow', col, tcol = null;
      var o = {kind: 'shape', sub: sub, title: strOf(K('title', '')), offset: Math.trunc(K('offset', 0)) || 0, show_last: K('show_last', NaN),
               display: K('display', 15), b: [], y: [], c: [], tc: []};
      if (arrow) {
        col = colorArg(C, nd.colorup, sc, R.C.green); tcol = colorArg(C, nd.colordown, sc, R.C.red);   // tc: the color of the down arrows
        o.loc = 'arrow'; o.minh = K('minheight', 5); o.maxh = K('maxheight', 100);
      } else {
        o.style = sub === 'shape' ? K('style', 'xcross') : Array.from(strOf(K('char', '★')))[0] || '';
        o.loc = K('location', 'ab'); o.size = K('size', 'auto'); o.text = strOf(K('text', ''));
        col = colorArg(C, nd.color, sc, R.C.blue);
        if (nd.textcolor) tcol = colorArg(C, nd.textcolor, sc);   // otherwise the text takes the shape's color
      }
      out(R, o);
      var sf = f.series, abs = o.loc === 'abs', B = o.b, Y = o.y, CS = o.c, TC = o.tc;
      return function(I){
        var v = sf(I), c = withT(col.f ? col.f(I) : col.c, tr), t = tcol ? (tcol.f ? tcol.f(I) : tcol.c) : c;
        if (arrow) { if (typeof v !== 'number' || v !== v || v === 0) return NaN; }
        else if (abs ? typeof v !== 'number' || v !== v : !T(v)) return NaN;
        B.push(R.b); Y.push(arrow || abs ? v : NaN); CS.push(c); TC.push(arrow ? withT(t, tr) : t);
        return NaN;
      };
    };
  }
  def('plotshape', '', null, {compile: shapeC('shape')});
  def('plotchar', '', null, {compile: shapeC('char')});
  def('plotarrow', '', null, {compile: shapeC('arrow')});

  def('bgcolor', '', null, {compile: function(n, sc, C){
    var R = C.R, ln = n.ln; topOnly(sc, 'bgcolor', ln);
    var bd = fixedArgs(C, n, sc, sig('bgcolor', R.ver), extraT(R)), K = bd.K;
    if (!bd.nd.color) fail('bgcolor needs its color', ln);
    var tr = K('transp', R.ver < 5 ? 90 : undefined), col = colorArg(C, bd.nd.color, sc);
    var o = out(R, {kind: 'bg', title: strOf(K('title', '')), offset: Math.trunc(K('offset', 0)) || 0, show_last: K('show_last', NaN),
                    display: K('display', 15), c: new Grow()});
    var G = o.c;
    return function(I){ G.set(R.b, withT(col.f ? col.f(I) : col.c, tr)); return NaN; };
  }});

  def('hline', '', null, {compile: function(n, sc, C){
    var R = C.R, ln = n.ln; topOnly(sc, 'hline', ln);
    var bd = fixedArgs(C, n, sc, sig('hline', R.ver)), K = bd.K;
    if (!bd.nd.price) fail('hline needs its price', ln);
    var o = out(R, {kind: 'hline', price: K('price'), title: strOf(K('title', '')), color: K('color', R.C.gray), style: K('linestyle', 'dashed'),
                    lw: K('linewidth', 1), display: K('display', 15)});
    var pid = o.i, fn = function(){ return pid; };
    fn.pid = pid;
    return fn;
  }});

  def('fill', '', null, {compile: function(n, sc, C){
    var R = C.R, ln = n.ln; topOnly(sc, 'fill', ln);
    var named = {}, k, args = n.args;
    for (k in n.named) named[k === 'hline1' ? 'plot1' : k === 'hline2' ? 'plot2' : k] = n.named[k];
    var p1n = args.length > 0 ? args[0] : named.plot1, p2n = args.length > 1 ? args[1] : named.plot2;
    if (!p1n || !p2n) fail('fill needs the two plots (or hlines) it fills between', ln);
    delete named.plot1; delete named.plot2;
    var grad = R.ver >= 5 && ('top_value' in named || 'bottom_value' in named || 'top_color' in named || 'bottom_color' in named ||
                              (args.length >= 6 && isColorNode(args[4])));
    var ps = (grad ? SIG.fillg[1] : SIG.fill[R.ver < 5 ? 0 : 1]).split(' ').slice(2);
    var bd = fixedArgs(C, {name: 'fill', args: args.slice(2), named: named, ln: ln}, sc, ps, extraT(R)), K = bd.K, nd = bd.nd;
    var p1 = C.plotRef(p1n, sc), p2 = C.plotRef(p2n, sc), r1 = p1.run, r2 = p2.run;
    var o = out(R, {kind: 'fill', a: p1.pid, b: p2.pid, title: strOf(K('title', '')), show_last: K('show_last', NaN), display: K('display', 15),
                    gaps: T(K('fillgaps', false)), grad: grad});
    if (grad) {
      var tv = bd.f.top_value, bv = bd.f.bottom_value, tc = colorArg(C, nd.top_color, sc, NaN), bc = colorArg(C, nd.bottom_color, sc, NaN);
      if (!tv || !bv) fail('a gradient fill needs top_value and bottom_value', ln);
      o.tv = new Grow(); o.bv = new Grow(); o.tcl = new Grow(); o.bcl = new Grow();
      return function(I){
        if (r1) r1(I);
        if (r2) r2(I);
        var b = R.b;
        o.tv.set(b, tv(I)); o.bv.set(b, bv(I)); o.tcl.set(b, tc.f ? tc.f(I) : tc.c); o.bcl.set(b, bc.f ? bc.f(I) : bc.c);
        return NaN;
      };
    }
    var tr = K('transp', R.ver < 5 ? 90 : undefined), col = colorArg(C, nd.color, sc, R.ver < 5 ? R.C.blue : setT(R.C.blue, 90));
    o.c = new Grow();
    return function(I){
      if (r1) r1(I);
      if (r2) r2(I);
      o.c.set(R.b, withT(col.f ? col.f(I) : col.c, tr));
      return NaN;
    };
  }});
  def('barcolor', '', null, {compile: function(n, sc, C){ warn(C.R, 'barcolor is not shown here: the candles keep their own colors'); return C.NAF; }});

  // ---------------------------------------------------------------- inputs: the indicator's settings
  // Each input is known from the code alone; its value is the one saved for this script (R.iv, by its title) or its default.
  var INS = {
    input4: 'defval title type minval maxval confirm step options group inline tooltip',
    input: 'defval title tooltip inline group display active',
    'input.int': 'defval title minval maxval step tooltip inline group confirm display active',
    'input.float': 'defval title minval maxval step tooltip inline group confirm display active',
    opts: 'defval title options tooltip inline group confirm display active',
    'input.bool': 'defval title tooltip inline group confirm display active',
    'input.string': 'defval title options tooltip inline group confirm display active',
    'input.color': 'defval title tooltip inline group confirm display active',
    'input.source': 'defval title tooltip inline group display active',
    'input.timeframe': 'defval title options tooltip inline group confirm display active',
    'input.session': 'defval title options tooltip inline group confirm display active',
    'input.price': 'defval title tooltip inline group confirm display active',
    'input.time': 'defval title tooltip inline group confirm display active',
    'input.text_area': 'defval title tooltip group confirm display active'
  };
  var INTYPE = {'input.int': 'int', 'input.float': 'float', 'input.bool': 'bool', 'input.string': 'string', 'input.color': 'color',
                'input.source': 'source', 'input.timeframe': 'timeframe', 'input.session': 'session', 'input.price': 'float',
                'input.time': 'time', 'input.text_area': 'text'};
  function intNode(x){ return !!x && ((x.k === 'num' && x.int) || (x.k === 'neg' && intNode(x.a))); }
  function srcNode(x){ return !!x && x.k === 'id' && SOURCES[x.name] === 1; }
  function inputSig(cn, n, ver){
    if (cn === 'input') return ver < 5 ? INS.input4 : INS.input;
    if ((cn === 'input.int' || cn === 'input.float') && (n.named.options || (n.args[2] && n.args[2].k === 'tuple'))) return INS.opts;
    return INS[cn];
  }
  function srcInput(n){                                          // input(close) and input(…, type = input.source) change on every bar
    var d = n.args[0] || n.named.defval, t = n.args[2] || n.named.type;
    return srcNode(d) || (!!t && t.k === 'id' && t.name === 'input.source');
  }
  function inputKey(R, title){
    var base = title || 'input ' + (R.inputs.length + 1), k = base, i = 2;
    var has = function(x){ for (var j = 0; j < R.inputs.length; j++) if (R.inputs[j].key === x) return true; return false; };
    while (has(k)) k = base + ' #' + i++;
    return k;
  }
  function coerceInput(sp, v){
    var d = sp.def;
    if (v === undefined || v === null) return d;
    switch (sp.type) {
      case 'int': v = Math.round(+v); break;
      case 'float': case 'time': v = +v; break;
      case 'bool': return typeof v === 'boolean' ? v : d;
      case 'color': return typeof v === 'number' && v >= 0 && v <= 0xFFFFFFFF ? Math.floor(v) : d;
      case 'source': return SOURCES[v] === 1 ? v : d;
      default: if (typeof v !== 'string') return d;
    }
    if (typeof v === 'number') {
      if (!isFinite(v)) return d;
      if (typeof sp.min === 'number' && v < sp.min) v = sp.min;
      if (typeof sp.max === 'number' && v > sp.max) v = sp.max;
    }
    if (sp.options && sp.options.indexOf(v) < 0) return d;
    return v;
  }
  function inputFn(R, sp){
    if (sp.type === 'source') { var sf = SERIES[sp.value]; return function(){ return sf(R, R.b); }; }
    var v = sp.value;
    return function(){ return v; };
  }
  function inputC(cn){
    return function(n, sc, C){
      var R = C.R, ln = n.ln;
      if (n._in) return inputFn(R, n._in);                       // compiled once already (a fixed value is worked out twice)
      var bd = fixedArgs(C, n, sc, inputSig(cn, n, R.ver).split(' ')), K = bd.K, nd = bd.nd;
      if (!nd.defval) fail(cn + ' needs its default value', ln);
      var type = INTYPE[cn], def;
      if (cn === 'input') {
        type = nd.type ? K('type') : '';
        if (type === 'symbol') fail('symbol inputs are not supported', ln);
        if (!type && srcNode(nd.defval)) type = 'source';
      }
      if (type === 'source') {
        if (!srcNode(nd.defval)) fail('the default of a source input is open, high, low, close, hl2, hlc3, ohlc4, hlcc4 or volume', ln);
        def = nd.defval.name;
      } else {
        def = C.constant(nd.defval, sc);
        if (!type) type = typeof def === 'boolean' ? 'bool' : typeof def === 'string' ? 'string' : isColorNode(nd.defval) ? 'color' : intNode(nd.defval) ? 'int' : 'float';
      }
      var sp = {key: '', type: type, title: strOf(K('title', '')), def: def, min: K('minval', undefined), max: K('maxval', undefined),
                step: K('step', undefined), options: nd.options ? K('options') : undefined, tooltip: strOf(K('tooltip', '')),
                group: strOf(K('group', '')), inline: strOf(K('inline', '')), ln: ln};
      if (sp.options !== undefined && !Array.isArray(sp.options)) sp.options = [sp.options];
      sp.key = inputKey(R, sp.title);
      sp.value = coerceInput(sp, R.iv[sp.key]);
      R.inputs.push(sp);
      n._in = sp;
      return inputFn(R, sp);
    };
  }
  def('input', '', null, {compile: inputC('input'), pure: function(n){ return !srcInput(n); }});
  Object.keys(INTYPE).forEach(function(cn){ def(cn, '', null, {compile: inputC(cn), pure: cn !== 'input.source'}); });

  // ---------------------------------------------------------------- indicator() (study() in v4)
  var SIG_IND = ('title shorttitle overlay format precision scale max_bars_back timeframe timeframe_gaps explicit_plot_zorder max_lines_count ' +
                 'max_labels_count max_boxes_count calc_bars_count max_polylines_count dynamic_requests behind_chart').split(' ');
  var SIG_STUDY = 'title shorttitle overlay format precision scale max_bars_back resolution resolution_gaps max_lines_count max_labels_count'.split(' ');
  function countOf(v){ v = Math.floor(v); return v >= 1 ? Math.min(500, v) : 50; }
  def('indicator', '', null, {compile: function(n, sc, C){
    var R = C.R, ln = n.ln, v4 = R.ver < 5, word = v4 ? 'study' : 'indicator'; topOnly(sc, word + '()', ln);
    if (R.meta) fail('the script declares ' + word + '() twice', ln);
    var bd = fixedArgs(C, n, sc, v4 ? SIG_STUDY : SIG_IND), K = bd.K, tf = K(v4 ? 'resolution' : 'timeframe', '');
    if (tf) fail('indicators that run on another timeframe (' + (v4 ? 'resolution' : 'timeframe') + ' = "' + tf + '") are not supported', ln);
    if (!T(K('overlay', false))) fail('this indicator has a pane of its own (overlay is not true): only indicators drawn on the price chart are supported for now', ln);
    var title = strOf(K('title', ''));
    if (!title) fail(word + '() needs a title', ln);
    R.meta = {title: title, short: strOf(K('shorttitle', '')) || title, format: K('format', 'inherit'), precision: K('precision', NaN),
              maxLabels: countOf(K('max_labels_count', 50)), maxLines: countOf(K('max_lines_count', 50)), ln: ln};
    return C.NAF;
  }});

  // ---------------------------------------------------------------- a run: one script on one chart's bars
  // D holds the bars as columns (t and e in ms, o h l c v) with n bars, of which the first conf are closed. advance() runs
  // what is new: the bars that closed since, then the forming bar from the state the last closed bar left. The last SOFT
  // closed bars keep their journal too, so the chart can cut its last bar again (its last minutes came late) without a rerun.
  var SOFT = 2;
  function Run(source, opt){
    opt = opt || {};
    var R = this;
    R.ver = version(source);
    R.C = palette(R.ver);
    R.D = null; R.b = 0; R.conf = true; R.J = null; R.brk = 0; R.iters = 0; R.tmp = null;
    R.outs = []; R.inputs = []; R.iv = bare(opt.inputs || {}); R.meta = null; R.warn = []; R.warnSeen = Object.create(null);
    R.sym = opt.sym || {};
    R.LB = new Store(50); R.LN = new Store(50);
    R.main = build(parse(source), R);
    if (!R.meta) fail('the script has no ' + (R.ver < 5 ? 'study()' : 'indicator()') + ' line', 1);
    R.LB.max = R.meta.maxLabels; R.LN.max = R.meta.maxLines;
    R.G = new Inst(R.GF);
    R.done = 0; R.soft = [];
  }
  function at(e, b){ if (e && typeof e === 'object' && e.bar === undefined) e.bar = b; return e; }
  Run.prototype.bar = function(b, conf){
    var R = this;
    R.b = b; R.conf = conf; R.iters = 0; R.brk = 0; R.tmp = null;
    R.main(R.G);
  };
  Run.prototype.advance = function(D, from, conf){
    var R = this, n = D.n;
    R.D = D;
    conf = Math.max(Math.min(conf, n), n - 1, 0);                // at most one bar is forming
    if (conf < R.done) from = Math.min(from, conf);
    if (R.J) rollback(R);                                        // the forming bar starts again from the last closed bar
    if (from < R.done) {
      if (from < R.done - R.soft.length) return false;           // further back than the kept journals: the caller starts over
      while (R.done > from) { R.J = R.soft.pop(); rollback(R); R.done--; }
    }
    trimShapes(R, R.done);
    for (var b = R.done; b < conf; b++) {
      var soft = b >= conf - SOFT;
      if (soft) R.J = [];
      try { R.bar(b, true); } catch (e) { if (R.J) rollback(R); throw at(e, b); }
      if (soft) { R.soft.push(R.J); R.J = null; if (R.soft.length > SOFT) R.soft.shift(); }
      R.done = b + 1;
    }
    compact(R);
    if (n > conf) {
      R.J = [];
      try { R.bar(conf, false); } catch (e2) { rollback(R); throw at(e2, conf); }
    }
    return true;
  };
  function trimShapes(R, from){                                  // the shapes of the bars that run again
    for (var i = 0; i < R.outs.length; i++) {
      var o = R.outs[i];
      if (o.kind !== 'shape') continue;
      var B = o.b, k = B.length;
      while (k > 0 && B[k - 1] >= from) k--;
      if (k < B.length) { B.length = k; o.y.length = k; o.c.length = k; o.tc.length = k; }
    }
  }
  function compact(R){
    var n = R.D.n;
    for (var i = 0; i < R.outs.length; i++) {                    // shapes that show_last will never show again (the same at
      var o = R.outs[i];                                         // every step, so a live run and a run from scratch agree)
      if (o.kind !== 'shape' || !(o.show_last >= 0)) continue;
      var B = o.b, cut = n - o.show_last - o.offset - SOFT - 2, k = 0;
      while (k < B.length && B[k] < cut) k++;
      if (k) { B.splice(0, k); o.y.splice(0, k); o.c.splice(0, k); o.tc.splice(0, k); }
    }
    [R.LB, R.LN].forEach(function(st){                           // the slots of deleted labels and lines
      if (st.seq - st.made < 4096) return;
      st.made = st.seq;
      for (var k in st.m) if (st.m[k] === undefined) delete st.m[k];
    });
  }
  function sliceG(g, from, n, tr){
    var a = new Float64Array(Math.max(0, n - from)), src = g.a, m = Math.min(n, src.length);
    if (m > from) a.set(src.subarray(from, m));
    for (var i = Math.max(m, from); i < n; i++) a[i - from] = NaN;
    tr.push(a.buffer);
    return a;
  }
  function drawn(st){
    var outv = [];
    for (var k in st.m) { var o = st.m[k]; if (o) { var c = {}; for (var f in o) c[f] = o[f]; outv.push(c); } }
    return outv;
  }
  // what changed from bar `from` on: plot values and colors as arrays from `from` to n, the shapes of those bars, and all
  // the labels and lines there are (they can change anywhere)
  Run.prototype.output = function(from){
    var R = this, n = R.D ? R.D.n : 0, outs = [], tr = [];
    from = Math.max(0, Math.min(from, n));
    for (var i = 0; i < R.outs.length; i++) {
      var o = R.outs[i], x = {};
      if (o.kind === 'shape') {
        var B = o.b, lo = 0, hi = B.length;
        while (lo < hi) { var mid = (lo + hi) >> 1; if (B[mid] < from) lo = mid + 1; else hi = mid; }
        x.b = B.slice(lo); x.y = o.y.slice(lo); x.c = o.c.slice(lo); x.tc = o.tc.slice(lo);
      } else {
        if (o.v) x.v = sliceG(o.v, from, n, tr);
        if (o.c instanceof Grow) x.c = sliceG(o.c, from, n, tr);
        if (o.grad) { x.tv = sliceG(o.tv, from, n, tr); x.bv = sliceG(o.bv, from, n, tr); x.tcl = sliceG(o.tcl, from, n, tr); x.bcl = sliceG(o.bcl, from, n, tr); }
      }
      outs.push(x);
    }
    return {n: n, from: from, outs: outs, labels: drawn(R.LB), lines: drawn(R.LN), warn: R.warn.slice(), transfer: tr};
  };
  Run.prototype.info = function(){
    var R = this, m = R.meta;
    return {title: m.title, short: m.short, ver: R.ver, format: m.format, precision: m.precision,
            inputs: R.inputs.map(function(s){
              return {key: s.key, type: s.type, title: s.title, def: s.def, value: s.value, min: s.min, max: s.max, step: s.step,
                      options: s.options, tooltip: s.tooltip, group: s.group, inline: s.inline};
            }),
            outs: R.outs.map(function(o){
              var x = {}; for (var k in o) { var v = o[k]; if (!(v instanceof Grow) && !Array.isArray(v)) x[k] = v; } return x;
            }),
            warn: R.warn.slice()};
  };
  function errorOf(e){
    if (e && e.pine) return {message: e.message, ln: e.ln || 0, bar: e.bar};
    if (typeof console !== 'undefined') console.error(e);
    return {message: 'internal error: ' + (e && e.message || e), ln: 0, bar: e && e.bar};
  }

  // ---------------------------------------------------------------- the worker
  // The page sends the chart's bars ({op:'data'}: from which bar they changed, how many are closed) and the scripts
  // ({op:'set'} with the source and the saved inputs, {op:'drop'}); after each batch every script runs what is new and
  // its outputs go back ({op:'out'}, or {op:'error'}), then {op:'idle', seq} says the batch is done: seq is the highest
  // `seq` of the messages it covered, so the page can tell a worker that is still busy from one that is stuck.
  // {op:'check'} compiles a file being loaded and says what is in it.
  function Feed(){ this.cap = 0; this.cols = {}; this.n = 0; this.conf = 0; this.gen = null; this.sym = {}; this.dirty = Infinity; }
  var COLS = ['t', 'e', 'o', 'h', 'l', 'c', 'v'];
  Feed.prototype.put = function(m){
    var F = this, len = m.cols && m.cols.t ? m.cols.t.length : 0, need = m.from + len;
    if (m.gen !== F.gen) { F.gen = m.gen; F.sym = m.sym || {}; F.n = 0; F.dirty = 0; }
    if (need > F.cap) {
      var cap = Math.max(1024, need * 2);
      COLS.forEach(function(k){ var a = new Float64Array(cap); if (F.cols[k]) a.set(F.cols[k].subarray(0, Math.min(F.n, cap))); F.cols[k] = a; });
      F.cap = cap;
    }
    var from = Math.min(m.from, F.n);
    COLS.forEach(function(k){ var src = m.cols[k]; if (src) F.cols[k].set(src.length === len ? src : src.slice(0, len), m.from); });
    F.n = need; F.conf = Math.min(m.conf, need);
    F.dirty = Math.min(F.dirty, from);
  };
  Feed.prototype.view = function(){
    var F = this, D = {n: F.n, conf: F.conf};
    COLS.forEach(function(k){ D[k] = F.cols[k]; });
    return D;
  };
  function serve(scope){
    var feed = new Feed(), scripts = {}, timer = 0, seen = 0;
    function post(m, tr){ scope.postMessage(m, tr || []); }
    function schedule(){ if (!timer) timer = setTimeout(tick, 0); }
    function tick(){
      timer = 0;
      var D = feed.view(), from = feed.dirty;
      feed.dirty = Infinity;
      Object.keys(scripts).forEach(function(id){
        var s = scripts[id];
        if (s.err && from > 0) return;                           // stays failed until its source or inputs change, or the bars start over
        if (s.run && from === Infinity) return;                  // nothing new for it
        if (!D.n) return;
        var fresh = false;
        try {
          if (!s.run || from === 0) { s.run = new Run(s.source, {inputs: s.inputs, sym: feed.sym}); fresh = true; }
          var before = s.run.done;
          if (!s.run.advance(D, fresh ? 0 : from, D.conf)) {
            s.run = new Run(s.source, {inputs: s.inputs, sym: feed.sym}); fresh = true;
            s.run.advance(D, 0, D.conf);
          }
          var o = s.run.output(fresh ? 0 : Math.min(from, before));
          s.err = null;
          post({op: 'out', id: id, v: s.v, gen: feed.gen, fresh: fresh, info: fresh ? s.run.info() : null, n: o.n, from: o.from, outs: o.outs,
                labels: o.labels, lines: o.lines, warn: o.warn}, o.transfer);
        } catch (e) {
          s.run = null; s.err = errorOf(e);
          post({op: 'error', id: id, v: s.v, gen: feed.gen, error: s.err});
        }
      });
      post({op: 'idle', seq: seen});
    }
    scope.onmessage = function(ev){
      var m = ev.data || {};
      if (m.seq > seen) seen = m.seq;
      if (m.op === 'data') { feed.put(m); schedule(); }
      else if (m.op === 'set') { scripts[m.id] = {source: m.source, inputs: m.inputs || {}, v: m.v, run: null, err: null}; schedule(); }
      else if (m.op === 'drop') delete scripts[m.id];
      else if (m.op === 'check') {
        try { post({op: 'checked', rid: m.rid, ok: true, info: new Run(m.source, {inputs: m.inputs || {}, sym: m.sym || feed.sym}).info()}); }
        catch (e) { post({op: 'checked', rid: m.rid, ok: false, error: errorOf(e)}); }
      }
    };
  }

  // names a script uses are looked up in these tables: no inherited keys ("constructor", "toString") may answer
  function bare(o){ var x = Object.create(null); for (var k in o) x[k] = o[k]; return x; }
  SERIES = bare(SERIES); VARS = bare(VARS); CONSTS = bare(CONSTS); ALIAS = bare(ALIAS); SOURCES = bare(SOURCES);

  var Pine = {Run: Run, version: version, parse: parse, lex: lex, tostr: tostr, hexC: hexC, palette: palette, serve: serve, SOFT: SOFT};
  if (typeof module === 'object' && module.exports) module.exports = Pine;
  else root.Pine = Pine;
  if (typeof importScripts === 'function' && typeof root.postMessage === 'function' && !root.document) serve(root);
})(typeof self !== 'undefined' ? self : this);
