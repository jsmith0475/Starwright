// Starwright — a small TeX-to-MathML converter for the science reference (js/ui/science.js).
// The game runs offline with no outside libraries, and every current browser draws MathML itself, so the equations
// are written in the TeX everybody knows and turned into MathML here. Pure string work: runs in Node for the tests.
//   texToMathML(src, { display })   → '<math …>…</math>'
// Supported: letters, numbers, + - = < > ( ) [ ] | , . ! / and spaces; ^ and _ (with or without braces);
// \frac \dfrac \tfrac \sqrt \sqrt[n]; Greek letters; \dot \ddot \vec \hat \bar \tilde; \mathbf \mathrm \text;
// \left … \right; \int \sum \prod \oint with limits; function names (\sin, \ln, …); the usual relation and
// operator symbols; spacing (\, \; \quad \qquad). Anything unknown throws, so a typo in a chapter fails the tests.

const GREEK = {
  alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ε', varepsilon: 'ε', zeta: 'ζ', eta: 'η', theta: 'θ', vartheta: 'ϑ', iota: 'ι', kappa: 'κ',
  lambda: 'λ', mu: 'μ', nu: 'ν', xi: 'ξ', pi: 'π', rho: 'ρ', sigma: 'σ', tau: 'τ', upsilon: 'υ', phi: 'φ', varphi: 'φ', chi: 'χ', psi: 'ψ', omega: 'ω',
  Gamma: 'Γ', Delta: 'Δ', Theta: 'Θ', Lambda: 'Λ', Xi: 'Ξ', Pi: 'Π', Sigma: 'Σ', Phi: 'Φ', Psi: 'Ψ', Omega: 'Ω',
};
const SYMBOLS = {
  cdot: '·', times: '×', approx: '≈', le: '≤', leq: '≤', ge: '≥', geq: '≥', ne: '≠', neq: '≠', to: '→', rightarrow: '→', Rightarrow: '⇒', leftarrow: '←',
  pm: '±', mp: '∓', propto: '∝', ll: '≪', gg: '≫', equiv: '≡', sim: '∼', simeq: '≃', cdots: '⋯', ldots: '…', dots: '…', circ: '∘', perp: '⊥', parallel: '∥',
  angle: '∠', prime: '′', mid: '|', in: '∈', forall: '∀', exists: '∃', lt: '<', gt: '>', langle: '⟨', rangle: '⟩', lVert: '‖', rVert: '‖', Vert: '‖',
  odot: '⊙', oplus: '⊕', star: '⋆', ast: '∗', div: '÷', lbrace: '{', rbrace: '}',
};
const IDENTS = { infty: '∞', partial: '∂', nabla: '∇', ell: 'ℓ', hbar: 'ℏ' };
const BIGOPS = { int: '∫', sum: '∑', prod: '∏', oint: '∮' };
const FUNCS = new Set(['sin', 'cos', 'tan', 'cot', 'sec', 'csc', 'arcsin', 'arccos', 'arctan', 'sinh', 'cosh', 'tanh', 'ln', 'log', 'exp', 'min', 'max', 'lim', 'det', 'arg', 'atan2']);
const ACCENTS = { dot: '˙', ddot: '¨', vec: '→', hat: '^', bar: '¯', tilde: '˜', overline: '¯' };
const SPACES = { ',': '0.17em', ':': '0.22em', ';': '0.28em', '!': '-0.17em', ' ': '0.28em', quad: '1em', qquad: '2em' };
const DELIMS = { '(': '(', ')': ')', '[': '[', ']': ']', '|': '|', '.': '', '\\{': '{', '\\}': '}', '\\|': '‖', '\\langle': '⟨', '\\rangle': '⟩', '\\lvert': '|', '\\rvert': '|' };

const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function tokenize(src) {
  const out = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '\\') {
      const m = /^\\([a-zA-Z]+|.)/.exec(src.slice(i));
      if (!m) throw new Error('tex: stray backslash');
      out.push({ t: 'cmd', v: m[1] }); i += m[0].length;
      if (/[a-zA-Z]/.test(m[1][0])) while (src[i] === ' ') i++;
    } else if (/[0-9]/.test(c)) {
      const m = /^[0-9]+(?:,[0-9]{3})*(?:\.[0-9]+)?/.exec(src.slice(i));   // 2,337 is one number
      out.push({ t: 'num', v: m[0] }); i += m[0].length;
    } else if (/\s/.test(c)) i++;
    else { out.push({ t: 'chr', v: c }); i++; }
  }
  return out;
}

class Parser {
  constructor(src) { this.src = src; this.tok = tokenize(src); this.i = 0; }
  peek() { return this.tok[this.i]; }
  next() { return this.tok[this.i++]; }
  fail(msg) { throw new Error(`tex: ${msg} in "${this.src}"`); }
  isChr(v) { const t = this.peek(); return !!t && t.t === 'chr' && t.v === v; }
  isCmd(v) { const t = this.peek(); return !!t && t.t === 'cmd' && t.v === v; }

  /** A run of atoms up to a closing token (not consumed). → MathML string of the children. */
  row(stop) {
    const parts = [];
    for (;;) {
      const t = this.peek();
      if (!t) break;
      if (stop && stop(t)) break;
      parts.push(this.scripted());
    }
    return parts.join('');
  }

  group() {
    if (!this.isChr('{')) this.fail('expected {');
    this.next();
    const inner = this.row(t => t.t === 'chr' && t.v === '}');
    if (!this.isChr('}')) this.fail('missing }');
    this.next();
    return `<mrow>${inner}</mrow>`;
  }

  /** One argument: a braced group or a single atom. */
  arg() { return this.isChr('{') ? this.group() : this.atom(); }

  /** Plain text of a braced group (for \text, \mathrm, \mathbf). */
  rawGroup() {
    if (!this.isChr('{')) this.fail('expected {');
    this.next();
    let s = '', depth = 1;
    for (;;) {
      const t = this.next();
      if (!t) this.fail('missing }');
      if (t.t === 'chr' && t.v === '{') depth++;
      if (t.t === 'chr' && t.v === '}' && --depth === 0) break;
      s += t.t === 'cmd' ? (t.v === ' ' || t.v === ',' ? ' ' : (GREEK[t.v] || SYMBOLS[t.v] || t.v)) : t.v;
    }
    return s;
  }

  scripted() {
    const bigop = this.peek().t === 'cmd' && BIGOPS[this.peek().v];
    let base = this.atom(), sub = null, sup = null;
    for (;;) {
      if (this.isChr('_')) { this.next(); if (sub !== null) this.fail('double subscript'); sub = this.arg(); }
      else if (this.isChr('^')) { this.next(); if (sup !== null) this.fail('double superscript'); sup = this.arg(); }
      else if (this.isChr("'")) { this.next(); sup = (sup === null ? '' : sup) + '<mo>′</mo>'; if (sup !== '<mo>′</mo>') sup = `<mrow>${sup}</mrow>`; }
      else break;
    }
    if (sub === null && sup === null) return base;
    if (bigop && this.display && bigop !== '∫' && bigop !== '∮') {
      if (sub !== null && sup !== null) return `<munderover>${base}${sub}${sup}</munderover>`;
      return sub !== null ? `<munder>${base}${sub}</munder>` : `<mover>${base}${sup}</mover>`;
    }
    if (sub !== null && sup !== null) return `<msubsup>${base}${sub}${sup}</msubsup>`;
    return sub !== null ? `<msub>${base}${sub}</msub>` : `<msup>${base}${sup}</msup>`;
  }

  delim() {
    const t = this.next();
    if (!t) this.fail('missing delimiter');
    const key = t.t === 'cmd' ? '\\' + t.v : t.v;
    if (!(key in DELIMS)) this.fail('unknown delimiter ' + key);
    return DELIMS[key];
  }

  atom() {
    const t = this.next();
    if (!t) this.fail('unexpected end');
    if (t.t === 'num') return `<mn>${t.v}</mn>`;
    if (t.t === 'chr') {
      const c = t.v;
      if (c === '{') { this.i--; return this.group(); }
      if (/[a-zA-Z]/.test(c)) return `<mi>${c}</mi>`;
      if (c === '-') return '<mo>−</mo>';
      if (c === '*') return '<mo>·</mo>';
      if ('+=<>,;:!/|'.includes(c)) return `<mo>${esc(c)}</mo>`;
      if ('()[]'.includes(c)) return `<mo stretchy="false">${c}</mo>`;
      if (c === '.') return '<mo>.</mo>';
      if (c === '~') return '<mspace width="0.28em"/>';
      this.fail('unexpected ' + c);
    }
    const c = t.v;
    if (GREEK[c]) return `<mi>${GREEK[c]}</mi>`;
    if (IDENTS[c]) return `<mi mathvariant="normal">${IDENTS[c]}</mi>`;
    if (SYMBOLS[c]) return `<mo>${esc(SYMBOLS[c])}</mo>`;
    if (BIGOPS[c]) return `<mo>${BIGOPS[c]}</mo>`;
    if (FUNCS.has(c)) return `<mi>${c}</mi><mo>&#x2061;</mo>`;
    if (c in SPACES) return `<mspace width="${SPACES[c]}"/>`;
    if (c === 'frac' || c === 'dfrac' || c === 'tfrac') { const a = this.arg(), b = this.arg(); return `<mfrac>${a}${b}</mfrac>`; }
    if (c === 'sqrt') {
      if (this.isChr('[')) {
        this.next();
        const idx = this.row(x => x.t === 'chr' && x.v === ']');
        if (!this.isChr(']')) this.fail('missing ]');
        this.next();
        return `<mroot>${this.arg()}<mrow>${idx}</mrow></mroot>`;
      }
      return `<msqrt>${this.arg()}</msqrt>`;
    }
    if (ACCENTS[c]) return `<mover accent="true">${this.arg()}<mo${c === 'vec' ? ' stretchy="false"' : ''}>${ACCENTS[c]}</mo></mover>`;
    if (c === 'mathbf' || c === 'boldsymbol' || c === 'bm') return `<mi mathvariant="bold" class="bf">${esc(this.rawGroup())}</mi>`;   // browsers ignore mathvariant="bold": the class carries it
    if (c === 'mathrm' || c === 'operatorname') return `<mi mathvariant="normal">${esc(this.rawGroup())}</mi>`;
    if (c === 'text') return `<mtext>${esc(this.rawGroup())}</mtext>`;
    if (c === 'left') {
      const open = this.delim();
      const inner = this.row(x => x.t === 'cmd' && x.v === 'right');
      if (!this.isCmd('right')) this.fail('\\left without \\right');
      this.next();
      const close = this.delim();
      return `<mrow>${open ? `<mo>${esc(open)}</mo>` : ''}<mrow>${inner}</mrow>${close ? `<mo>${esc(close)}</mo>` : ''}</mrow>`;
    }
    if (c === '{' || c === '}') return `<mo>${c}</mo>`;
    if (c === '|') return '<mo>‖</mo>';
    if (c === '%') return '<mo>%</mo>';
    this.fail('unknown command \\' + c);
    return '';
  }
}

/** TeX source → a MathML <math> element as a string. Throws on anything it does not know. */
export function texToMathML(src, { display = false } = {}) {
  const p = new Parser(String(src).trim());
  p.display = display;
  const inner = p.row();
  if (p.peek()) p.fail('unbalanced }');
  return `<math xmlns="http://www.w3.org/1998/Math/MathML"${display ? ' display="block"' : ''}><mrow>${inner}</mrow></math>`;
}

/** The plain-text reading of a formula, for aria-label and for searching: the TeX with the backslashes taken out. */
export function texToText(src) {
  return String(src).replace(/\\(left|right|,|;|:|!|quad|qquad)/g, ' ').replace(/\\([a-zA-Z]+)/g, (m, n) => GREEK[n] || SYMBOLS[n] || IDENTS[n] || BIGOPS[n] || n + ' ').replace(/[{}]/g, ' ').replace(/\s+/g, ' ').trim();
}
