// Starwright — the science reference: the title menu's "Science" entry.
// A reader for the chapters in js/ui/sciencetext.js: chapter list on the left, the text with typeset equations on the
// right, two live calculators. Equations are TeX turned into MathML by js/ui/tex.js, which every current browser
// draws itself, so the game still needs no outside library and works offline.
//   openScience(app, chapterId?)    opens the reader; resolves when it is closed
//   installScience(app)             adds app.science = { open, chapters }
// Test hooks: .sw-sci (the reader), [data-chapter="<id>"] (list entries), .sw-sci-eq (displayed equations),
// [data-calc="rocket" | "transfer"] (calculators) with [data-out="…"] results.
import { el, clear, showModal } from './dom.js';
import { CHAPTERS, scienceContext, parseBody, parseInline } from './sciencetext.js';
import { texToMathML, texToText } from './tex.js';
import { SYSTEM } from '../core/bodies.js';
import { G0 } from '../core/parts.js';

const CSS = `
.sw-modal.sw-sci-modal { width: min(1180px, 100%); height: min(860px, 100%); display: flex; flex-direction: column; }
.sw-modal.sw-sci-modal .sw-modal-body { flex: 1; min-height: 0; padding: 0; overflow: hidden; }
.sw-sci { display: grid; grid-template-columns: 250px 1fr; height: 100%; min-height: 0; }
.sw-sci-nav { overflow-y: auto; padding: 10px 8px; border-right: 1px solid var(--sw-line); background: rgba(11, 15, 20, 0.5); }
.sw-sci-nav button { display: flex; gap: 8px; align-items: baseline; width: 100%; padding: 8px 10px; border: 0; border-radius: var(--sw-radius-sm); background: transparent;
  color: var(--sw-dim); font: inherit; font-size: 13px; line-height: 1.3; text-align: left; cursor: pointer; }
.sw-sci-nav button i { flex: none; width: 18px; font-style: normal; font-family: var(--sw-mono); font-size: 11px; color: var(--sw-faint); }
.sw-sci-nav button:hover { background: var(--sw-line-soft); color: var(--sw-text); }
.sw-sci-nav button.on { background: rgba(57, 208, 192, 0.12); color: var(--sw-text); }
.sw-sci-nav button.on i { color: var(--sw-teal); }
.sw-sci-page { overflow-y: auto; padding: 22px 34px 30px; scroll-behavior: smooth; }
.sw-sci-page > * { max-width: 760px; }
.sw-sci-kicker { font-size: 10px; letter-spacing: 0.16em; text-transform: uppercase; color: var(--sw-teal); font-weight: 700; margin: 0 0 4px; }
.sw-sci-page h2 { margin: 0 0 6px; font-size: 26px; line-height: 1.2; color: var(--sw-text); letter-spacing: 0.005em; }
.sw-sci-lead { margin: 0 0 18px; font-size: 15px; line-height: 1.5; color: var(--sw-dim); }
.sw-sci-page h3 { margin: 26px 0 8px; font-size: 17px; color: var(--sw-text); padding-top: 14px; border-top: 1px solid var(--sw-line); }
.sw-sci-page p, .sw-sci-page li { font-size: 14.5px; line-height: 1.62; color: #cfd9e2; }
.sw-sci-page p { margin: 0 0 11px; }
.sw-sci-page ul { margin: 0 0 12px; padding-left: 20px; }
.sw-sci-page li { margin: 0 0 5px; }
.sw-sci-page b { color: var(--sw-text); }
.sw-sci-page math { font-size: 1.08em; color: #f2f6fa; font-family: "STIX Two Math", "Cambria Math", "Latin Modern Math", math; }
.sw-sci-page math .bf { font-weight: 700; font-style: normal; }
.sw-sci-eq { display: flex; align-items: center; gap: 12px; margin: 14px 0 16px; padding: 12px 14px; border-radius: var(--sw-radius); background: rgba(29, 38, 49, 0.7);
  border: 1px solid var(--sw-line-soft); overflow-x: auto; }
.sw-sci-eq math { flex: 1; font-size: 1.22em; }
.sw-sci-eq small { flex: none; font-family: var(--sw-mono); font-size: 11px; color: var(--sw-faint); }
.sw-sci-note { margin: 12px 0 14px; padding: 10px 14px 10px 13px; border-left: 3px solid var(--note, var(--sw-teal)); border-radius: 0 var(--sw-radius) var(--sw-radius) 0; background: rgba(29, 38, 49, 0.55); }
.sw-sci-note.example { --note: var(--sw-amber); }
.sw-sci-note .tag { display: block; font-size: 9.5px; letter-spacing: 0.16em; text-transform: uppercase; font-weight: 700; color: var(--note, var(--sw-teal)); margin-bottom: 3px; }
.sw-sci-note p { margin: 0; font-size: 14px; }
.sw-sci-turn { display: flex; justify-content: space-between; gap: 10px; margin-top: 28px; padding-top: 14px; border-top: 1px solid var(--sw-line); }
.sw-sci-turn .sw-btn { height: auto; min-height: 34px; padding: 6px 14px; font-size: 13px; text-align: left; }
.sw-sci-turn .sw-btn.next { margin-left: auto; text-align: right; }
.sw-sci-calc { margin: 18px 0 6px; padding: 14px 16px 12px; border: 1px solid var(--sw-line); border-radius: var(--sw-radius); background: linear-gradient(180deg, rgba(29, 38, 49, 0.96), rgba(20, 26, 34, 0.96)); }
.sw-sci-calc h4 { margin: 0 0 10px; font-size: 11px; letter-spacing: 0.14em; text-transform: uppercase; color: var(--sw-violet); }
.sw-sci-calc .rows { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 8px 14px; }
.sw-sci-calc label { display: flex; flex-direction: column; gap: 3px; font-size: 11px; color: var(--sw-dim); }
.sw-sci-calc input, .sw-sci-calc select { height: 30px; padding: 0 8px; border: 1px solid var(--sw-line); border-radius: var(--sw-radius-sm); background: var(--sw-bg); color: var(--sw-text);
  font: inherit; font-family: var(--sw-mono); font-size: 13px; }
.sw-sci-calc input:focus, .sw-sci-calc select:focus { outline: none; border-color: var(--sw-teal); }
.sw-sci-calc dl { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 8px 14px; margin: 12px 0 0; }
.sw-sci-calc dl div { padding: 7px 10px; border-radius: var(--sw-radius-sm); background: rgba(11, 15, 20, 0.55); }
.sw-sci-calc dt { font-size: 10.5px; color: var(--sw-dim); }
.sw-sci-calc dd { margin: 2px 0 0; font-family: var(--sw-mono); font-size: 15px; color: var(--sw-text); }
.sw-sci-calc .why { margin: 10px 0 0; font-size: 12px; color: var(--sw-dim); line-height: 1.45; }
@media (max-width: 760px) { .sw-sci { grid-template-columns: 1fr; grid-template-rows: auto 1fr; } .sw-sci-nav { display: flex; overflow-x: auto; border-right: 0; border-bottom: 1px solid var(--sw-line); }
  .sw-sci-nav button { width: auto; white-space: nowrap; } .sw-sci-page { padding: 16px 16px 24px; } }
`;

function ensureCss() {
  if (document.getElementById('sw-sci-css')) return;
  const st = document.createElement('style');
  st.id = 'sw-sci-css'; st.textContent = CSS;
  document.head.appendChild(st);
}

/** A MathML node for a TeX string. A formula that fails to convert is shown as its source, never as a blank. */
function math(tex, display = false) {
  const span = document.createElement('span');
  try { span.innerHTML = texToMathML(tex, { display }); } catch (err) { console.warn('[science]', err.message); span.textContent = tex; return span; }
  const node = span.firstChild;
  node.setAttribute('aria-label', texToText(tex));
  return node;
}

/** Running text with inline mathematics, bold and italic → an array of nodes. */
function inline(text) {
  return parseInline(text).map(s => s.math !== undefined ? math(s.math) : s.b !== undefined ? el('b', { text: s.b }) : s.i !== undefined ? el('em', { text: s.i }) : document.createTextNode(s.t));
}

const fmt0 = x => Number.isFinite(x) ? Math.round(x).toLocaleString('en-US') : 'n/a';
const fmtT = s => !Number.isFinite(s) ? 'n/a' : s < 7200 ? (s / 60).toFixed(1) + ' min' : s < 172800 ? (s / 3600).toFixed(1) + ' h' : (s / 86400).toFixed(1) + ' days';
const numIn = (label, value, attrs = {}) => { const i = el('input', { attrs: { type: 'number', value: String(value), step: 'any', ...attrs } }); return [el('label', null, label, i), i]; };
const outRow = (key, label) => { const dd = el('dd', { attrs: { 'data-out': key }, text: '' }); return [el('div', null, el('dt', { text: label }), dd), dd]; };

/** The live calculators a chapter can place with [[calc:name]]. Each returns a node. */
const CALCS = {
  /** Tsiolkovsky: masses and specific impulse → exhaust speed, mass ratio, delta-v, and TWR on a chosen world. */
  rocket(ctx) {
    const [lm0, m0] = numIn('Full mass (t)', 10, { min: '0.01' }), [lm1, m1] = numIn('Empty mass (t)', 4, { min: '0.01' });
    const [lisp, isp] = numIn('Specific impulse (s)', 320, { min: '1' }), [lth, th] = numIn('Thrust (kN)', 200, { min: '0' });
    const world = el('select', null, ...ctx.SYSTEM.bodies.filter(b => b.parent && !b.gas).map(b => el('option', { text: b.name, attrs: { value: b.id, ...(b === ctx.home ? { selected: '' } : {}) } })));
    const [r1, oVe] = outRow('ve', 'Exhaust speed'), [r2, oRatio] = outRow('ratio', 'Mass ratio'), [r3, oDv] = outRow('dv', 'Delta-v'), [r4, oTwr] = outRow('twr', 'Thrust to weight at launch'), [r5, oBurn] = outRow('burn', 'Burn time at full thrust');
    const why = el('p', { class: 'why' });
    const run = () => {
      const a = Number(m0.value), b = Number(m1.value), i = Number(isp.value), f = Number(th.value), body = ctx.B[world.value];
      const ok = a > 0 && b > 0 && a >= b && i > 0;
      const ve = i * ctx.G0, dv = ok ? ve * Math.log(a / b) : NaN;
      oVe.textContent = i > 0 ? fmt0(ve) + ' m/s' : 'n/a';
      oRatio.textContent = ok ? (a / b).toFixed(2) : 'n/a';
      oDv.textContent = ok ? fmt0(dv) + ' m/s' : 'n/a';
      oTwr.textContent = ok && f > 0 ? (f / (a * body.surfaceG)).toFixed(2) + ' on ' + body.name : 'n/a';
      oBurn.textContent = ok && f > 0 ? ((a - b) * 1000 * ve / (f * 1000)).toFixed(0) + ' s' : 'n/a';
      why.textContent = !ok ? 'The full mass must be at least the empty mass, and both above zero.'
        : `Doubling the propellant from here would add ${fmt0(ve * Math.log((2 * a - b) / b) - dv)} m/s, not double the delta-v: the logarithm at work.`;
    };
    const node = el('div', { class: 'sw-sci-calc', attrs: { 'data-calc': 'rocket' } }, el('h4', { text: 'Try it: the rocket equation' }),
      el('div', { class: 'rows' }, lm0, lm1, lisp, lth, el('label', null, 'Launch from', world)), el('dl', null, r1, r2, r3, r4, r5), why);
    node.addEventListener('input', run); run();
    return node;
  },
  /** Hohmann transfer between two worlds that share a parent, from and into low circular orbits. */
  transfer(ctx) {
    const worlds = ctx.SYSTEM.bodies.filter(b => b.parent && b.parent.children.length > 1);
    const opt = (b, sel) => el('option', { text: b.name + ' (around ' + b.parent.name + ')', attrs: { value: b.id, ...(sel ? { selected: '' } : {}) } });
    const from = el('select', null, ...worlds.map(b => opt(b, b === ctx.home))), to = el('select');
    const [lalt, alt] = numIn('Parking orbit altitude (km)', ctx.parkAlt / 1000, { min: '1' });
    const [r1, oVinf] = outRow('vinf', 'Excess speed needed'), [r2, oEj] = outRow('eject', 'Ejection burn'), [r3, oTof] = outRow('tof', 'Coast time'), [r4, oPh] = outRow('phase', 'Phase angle at departure'),
      [r5, oSyn] = outRow('window', 'Window repeats every'), [r6, oCap] = outRow('capture', 'Capture burn (low circular orbit)');
    const why = el('p', { class: 'why' });
    const fillTo = () => {
      const a = ctx.B[from.value], keep = to.value;
      clear(to);
      for (const b of a.parent.children) if (b !== a) to.appendChild(el('option', { text: b.name, attrs: { value: b.id } }));
      if ([...to.options].some(o => o.value === keep)) to.value = keep;
      else if (a === ctx.home && ctx.far.parent === a.parent) to.value = ctx.far.id;
    };
    const run = () => {
      const a = ctx.B[from.value], b = ctx.B[to.value], h = Number(alt.value) * 1000;
      if (!a || !b || !(h > 0)) { for (const o of [oVinf, oEj, oTof, oPh, oSyn, oCap]) o.textContent = 'n/a'; return; }
      const gm = a.parent.gm, t = ctx.hohmann(gm, a.orbit.a, b.orbit.a);
      const capAlt = b.atmo ? b.atmo.height + 20000 : Math.max(10000, b.radius * 0.1);
      const syn = 1 / Math.abs(1 / ctx.period(gm, a.orbit.a) - 1 / ctx.period(gm, b.orbit.a));
      let ph = t.phase * 180 / Math.PI; ph = ((ph + 180) % 360 + 360) % 360 - 180;
      oVinf.textContent = fmt0(t.dv1) + ' m/s';
      oEj.textContent = fmt0(ctx.eject(a, h, t.dv1)) + ' m/s';
      oTof.textContent = fmtT(t.tof);
      oPh.textContent = ph.toFixed(0) + '° ' + (ph >= 0 ? 'ahead' : 'behind');
      oSyn.textContent = fmtT(syn);
      oCap.textContent = b.gas ? 'no surface: ' + fmt0(ctx.eject(b, capAlt, t.dv2)) + ' m/s at ' + fmt0(capAlt / 1000) + ' km' : fmt0(ctx.eject(b, capAlt, t.dv2)) + ' m/s at ' + fmt0(capAlt / 1000) + ' km';
      // the angle between the two orbit normals; 0 if either orbit cannot say (never a NaN on screen)
      const ha = a.orbit.H, hb = b.orbit.H, dot = ha && hb ? ha.x * hb.x + ha.y * hb.y + ha.z * hb.z : 1;
      const tilt = Number.isFinite(dot) ? Math.acos(Math.max(-1, Math.min(1, dot))) * 180 / Math.PI : 0;
      why.textContent = `Circular, coplanar orbits are assumed, so the game's own planner will differ a little: ${a.name} and ${b.name} have eccentricities ${a.orbit.e.toFixed(2)} and ${b.orbit.e.toFixed(2)}` +
        ` and their planes are ${tilt.toFixed(1)}° apart. Leaving ${a.name} outright from that orbit costs ${fmt0(ctx.vesc(a, h) - ctx.vcirc(a, h))} m/s; the rest of the ejection burn is the trip.`;
    };
    const node = el('div', { class: 'sw-sci-calc', attrs: { 'data-calc': 'transfer' } }, el('h4', { text: 'Try it: a Hohmann transfer between worlds' }),
      el('div', { class: 'rows' }, el('label', null, 'From', from), el('label', null, 'To', to), lalt), el('dl', null, r1, r2, r3, r4, r5, r6), why);
    from.addEventListener('change', () => { fillTo(); run(); });
    node.addEventListener('input', run);
    fillTo(); run();
    return node;
  },
};

/** Build one chapter's page into `page`. `go(i)` turns to chapter i. */
function drawChapter(page, index, ctx, go) {
  const ch = CHAPTERS[index];
  clear(page);
  page.appendChild(el('p', { class: 'sw-sci-kicker', text: `Chapter ${index + 1} of ${CHAPTERS.length}` }));
  page.appendChild(el('h2', { text: ch.title }));
  page.appendChild(el('p', { class: 'sw-sci-lead', text: ch.lead }));
  let list = null, eq = 0;
  for (const b of parseBody(ch.body(ctx))) {
    if (b.type !== 'li') list = null;
    if (b.type === 'h') page.appendChild(el('h3', null, ...inline(b.text)));
    else if (b.type === 'p') page.appendChild(el('p', null, ...inline(b.text)));
    else if (b.type === 'li') { if (!list) { list = el('ul'); page.appendChild(list); } list.appendChild(el('li', null, ...inline(b.text))); }
    else if (b.type === 'eq') page.appendChild(el('div', { class: 'sw-sci-eq' }, math(b.text, true), el('small', { text: `(${index + 1}.${++eq})` })));
    else if (b.type === 'game' || b.type === 'example') {
      page.appendChild(el('div', { class: 'sw-sci-note ' + b.type }, el('span', { class: 'tag', text: b.type === 'game' ? 'In Starwright' : 'Worked example' }), el('p', null, ...inline(b.text))));
    } else if (b.type === 'calc' && CALCS[b.text]) page.appendChild(CALCS[b.text](ctx));
  }
  const prev = CHAPTERS[index - 1], next = CHAPTERS[index + 1];
  page.appendChild(el('div', { class: 'sw-sci-turn' },
    prev ? el('button', { class: 'sw-btn', attrs: { type: 'button', 'data-turn': 'prev' }, text: '← ' + prev.title, on: { click: () => go(index - 1) } }) : null,
    next ? el('button', { class: 'sw-btn next', attrs: { type: 'button', 'data-turn': 'next' }, text: next.title + ' →', on: { click: () => go(index + 1) } }) : null));
  page.scrollTop = 0;
}

const KEY = 'starwright.science.chapter';

/** Open the reader (at `chapterId`, or where the player last was). Resolves when it is closed. */
export function openScience(app, chapterId) {
  ensureCss();
  const ctx = scienceContext(SYSTEM, G0);
  let saved = null;
  try { saved = localStorage.getItem(KEY); } catch { /* private mode */ }
  let index = Math.max(0, CHAPTERS.findIndex(c => c.id === (chapterId || saved)));
  const nav = el('nav', { class: 'sw-sci-nav', attrs: { 'aria-label': 'Chapters' } });
  const page = el('article', { class: 'sw-sci-page', attrs: { tabindex: '0' } });
  const go = i => {
    index = Math.max(0, Math.min(CHAPTERS.length - 1, i));
    for (const b of nav.children) b.classList.toggle('on', Number(b.dataset.index) === index);
    drawChapter(page, index, ctx, go);
    try { localStorage.setItem(KEY, CHAPTERS[index].id); } catch { /* ignore */ }
    const on = nav.querySelector('.on'); if (on && on.scrollIntoView) on.scrollIntoView({ block: 'nearest' });
  };
  CHAPTERS.forEach((c, i) => nav.appendChild(el('button', { attrs: { type: 'button', 'data-chapter': c.id, 'data-index': String(i) }, on: { click: () => go(i) } }, el('i', { text: String(i + 1) }), el('span', { text: c.title }))));
  const dlg = showModal({ title: 'Science: the mathematics of orbits and flight', body: el('div', { class: 'sw-sci' }, nav, page), wide: true, class: 'sw-sci-modal', cancelValue: false, buttons: [{ label: 'Close', value: false }] });
  go(index);
  // [ and ] turn the chapter; the arrow keys are left to scrolling and to the calculators' inputs
  const onKey = e => {
    if (!page.isConnected) { document.removeEventListener('keydown', onKey, true); return; }
    if (/^(INPUT|SELECT|TEXTAREA)$/.test((e.target && e.target.tagName) || '')) return;
    if (e.key === ']') { go(index + 1); e.preventDefault(); } else if (e.key === '[') { go(index - 1); e.preventDefault(); }
  };
  document.addEventListener('keydown', onKey, true);
  dlg.then(() => document.removeEventListener('keydown', onKey, true));
  try { page.focus({ preventScroll: true }); } catch { /* ignore */ }
  return dlg;
}

/** Adds app.science (the title menu looks for it). */
export function installScience(app) {
  app.science = { open: id => openScience(app, id), chapters: CHAPTERS.map(c => ({ id: c.id, title: c.title })) };
  return app.science;
}
