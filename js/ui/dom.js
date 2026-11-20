// Starwright — tiny DOM helpers shared by every UI module.
//   el(tag, props, ...children)   build an element
//   svg(tag, attrs, ...children)  build an SVG element
//   clear(node)                   remove all children
//   fmt.*                         number / unit / time formatters
//   showModal({title, body, buttons, ...}) → Promise<value>   (promise also has .close(value) and .node)
//   isModalOpen()
//   tooltip(node, textOrFn)       or simply give any element a `data-tip="..."` attribute

const SVG_NS = 'http://www.w3.org/2000/svg';

function append(node, children) {
  for (const c of children) {
    if (c == null || c === false) continue;
    if (Array.isArray(c)) append(node, c);
    else node.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

function applyProps(node, props, isSvg) {
  if (!props) return;
  for (const k of Object.keys(props)) {
    const v = props[k];
    if (v == null || v === false) continue;
    if (k === 'class') { if (isSvg) node.setAttribute('class', v); else node.className = v; }
    else if (k === 'text') node.textContent = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k === 'on') { for (const ev of Object.keys(v)) if (v[ev]) node.addEventListener(ev, v[ev]); }
    else if (k === 'attrs') { for (const a of Object.keys(v)) if (v[a] != null && v[a] !== false) node.setAttribute(a, v[a] === true ? '' : v[a]); }
    else if (k === 'style') { if (typeof v === 'string') node.style.cssText = v; else Object.assign(node.style, v); }
    else if (k === 'data') { for (const d of Object.keys(v)) if (v[d] != null) node.dataset[d] = v[d]; }
    else if (k === 'tip') node.setAttribute('data-tip', v);
    else if (isSvg) node.setAttribute(k, v);
    else if (k in node) { try { node[k] = v; } catch { node.setAttribute(k, v); } }
    else node.setAttribute(k, v === true ? '' : v);
  }
}

/** el('div', {class:'x', text:'hi', on:{click}, attrs:{...}, style:{...}, data:{...}, tip:'tooltip'}, ...children) */
export function el(tag, props, ...children) {
  const node = document.createElement(tag);
  if (props instanceof Node || typeof props === 'string' || Array.isArray(props)) { children.unshift(props); props = null; }
  applyProps(node, props, false);
  return append(node, children);
}

/** svg('circle', {cx:1, cy:2, r:3, class:'c', on:{click}}) — every unknown key becomes an attribute. */
export function svg(tag, props, ...children) {
  const node = document.createElementNS(SVG_NS, tag);
  if (props instanceof Node || typeof props === 'string' || Array.isArray(props)) { children.unshift(props); props = null; }
  applyProps(node, props, true);
  return append(node, children);
}

export function clear(node) {
  if (node) while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}

// ---------------------------------------------------------------- formatters

export const VERDA_DAY = 19800;       // seconds (5.5 h)
export const VERDA_YEAR_DAYS = 460;

const pad2 = n => String(n).padStart(2, '0');
const finite = v => typeof v === 'number' && Number.isFinite(v);

function group(n, digits) {
  const neg = n < 0; n = Math.abs(n);
  const s = n.toFixed(digits);
  const [i, f] = s.split('.');
  const g = i.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return (neg && Number(s) !== 0 ? '−' : '') + g + (f ? '.' + f : '');
}

export const fmt = {
  /** 12345.678 → "12,346" (digits decimals) */
  num(v, digits = 0) { return finite(v) ? group(v, digits) : (v === Infinity ? '∞' : '—'); },

  /** SI prefix formatting: si(12345, 'm') → "12.35 km" */
  si(v, unit = '', sig = 4) {
    if (!finite(v)) return v === Infinity ? '∞ ' + unit : '—';
    const a = Math.abs(v);
    if (a === 0) return '0 ' + unit;
    const steps = [[1e12, 'T'], [1e9, 'G'], [1e6, 'M'], [1e3, 'k'], [1, ''], [1e-3, 'm']];
    let scale = 1, prefix = '';
    for (const [s, p] of steps) { if (a >= s) { scale = s; prefix = p; break; } scale = s; prefix = p; }
    if (a === 0) { scale = 1; prefix = ''; }
    const x = v / scale;
    const intDigits = Math.max(1, Math.floor(Math.log10(Math.max(Math.abs(x), 1))) + 1);
    return group(x, Math.max(0, sig - intDigits)) + ' ' + prefix + unit;
  },

  /** metres → "742 m" / "12.40 km" / "1.250 Mm" / "13.60 Gm" */
  dist(m) {
    if (!finite(m)) return m === Infinity ? '∞' : '—';
    const a = Math.abs(m);
    if (a < 1000) return group(m, a < 10 ? 1 : 0) + ' m';
    if (a < 1e6) return group(m / 1e3, a < 1e5 ? 2 : 1) + ' km';
    if (a < 1e9) return group(m / 1e6, a < 1e8 ? 3 : 2) + ' Mm';
    return group(m / 1e9, a < 1e11 ? 3 : 2) + ' Gm';
  },

  /** m/s → "7.4 m/s" / "2,310 m/s" */
  speed(v) {
    if (!finite(v)) return '—';
    const a = Math.abs(v);
    return group(v, a < 100 ? 1 : 0) + ' m/s';
  },

  /** duration in seconds → "42s" / "3m 07s" / "1h 02m 03s" / "2d 1h 05m" (Verda days) / "1y 12d" */
  time(s) {
    if (!finite(s)) return s === Infinity ? '∞' : '—';
    const neg = s < 0; s = Math.abs(s);
    let out;
    if (s < 60) out = (s < 10 ? s.toFixed(1) : Math.floor(s)) + 's';
    else {
      const t = Math.floor(s);
      const d = Math.floor(t / VERDA_DAY), r = t - d * VERDA_DAY;
      const h = Math.floor(r / 3600), m = Math.floor((r % 3600) / 60), sec = r % 60;
      if (d >= VERDA_YEAR_DAYS) out = Math.floor(d / VERDA_YEAR_DAYS) + 'y ' + (d % VERDA_YEAR_DAYS) + 'd';
      else if (d > 0) out = d + 'd ' + h + 'h ' + pad2(m) + 'm';
      else if (h > 0) out = h + 'h ' + pad2(m) + 'm ' + pad2(sec) + 's';
      else out = m + 'm ' + pad2(sec) + 's';
    }
    return (neg ? '−' : '') + out;
  },

  /** universal time → "Year 1, Day 12, 03:25:07" (5.5 h day, 460-day year, both 1-based) */
  date(ut) {
    const p = fmt.dateParts(ut);
    return `Year ${p.year}, Day ${p.day}, ${pad2(p.h)}:${pad2(p.m)}:${pad2(p.s)}`;
  },
  dateParts(ut) {
    const t = Math.max(0, Math.floor(finite(ut) ? ut : 0));
    const days = Math.floor(t / VERDA_DAY), r = t - days * VERDA_DAY;
    return { year: Math.floor(days / VERDA_YEAR_DAYS) + 1, day: (days % VERDA_YEAR_DAYS) + 1,
      h: Math.floor(r / 3600), m: Math.floor((r % 3600) / 60), s: r % 60 };
  },

  /** funds → "✦ 12,500" (the four-point star is Starwright's currency glyph) */
  funds(v) { return v === Infinity ? '✦ ∞' : finite(v) ? '✦ ' + group(v, 0) : '—'; },

  /** mass in kg → "850 kg" / "12.40 t" */
  mass(kg) {
    if (!finite(kg)) return '—';
    return Math.abs(kg) < 1000 ? group(kg, 0) + ' kg' : group(kg / 1000, 2) + ' t';
  },
  pct(f, digits = 0) { return finite(f) ? (f * 100).toFixed(digits) + '%' : '—'; },
};

// ---------------------------------------------------------------- modal dialogs

const modalStack = [];
function uiRoot() { return document.getElementById('ui') || document.body; }

export function isModalOpen() { return modalStack.length > 0; }

function onModalKey(e) {
  const top = modalStack[modalStack.length - 1];
  if (!top) return;
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target && e.target.tagName || '');
  if (e.key === 'Escape') {
    e.preventDefault();
    if (top.dismissable) top.close(top.cancelValue);
  } else if (e.key === 'Enter' && !(typing && e.target.tagName === 'TEXTAREA')) {
    const focused = document.activeElement;
    if (focused && focused.tagName === 'BUTTON' && top.backdrop.contains(focused)) { e.stopPropagation(); return; } // native click
    if (top.primary) { e.preventDefault(); top.primary.click(); }
  }
  // The game must not see keys while a dialog is up.
  e.stopPropagation();
}

/**
 * showModal({ title, body, buttons, dismissable = true, cancelValue = null, wide = false, class })
 *   body: string | Node | Node[]
 *   buttons: [{ label, value, kind: 'primary'|'danger'|undefined, disabled, onClick(close) → false keeps it open }]
 *            (defaults to a single "OK" button returning true)
 * Resolves with the clicked button's value, or cancelValue on Esc / backdrop click.
 * The returned promise carries `.close(value)` and `.node` (the dialog element).
 */
export function showModal({ title = '', body = '', buttons, dismissable = true, cancelValue = null, wide = false, class: cls = '' } = {}) {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  const entry = { dismissable, cancelValue, primary: null, backdrop: null, close: null };
  const prevFocus = document.activeElement;

  const close = value => {
    const i = modalStack.indexOf(entry);
    if (i < 0) return;
    modalStack.splice(i, 1);
    if (!modalStack.length) document.removeEventListener('keydown', onModalKey, true);
    entry.backdrop.classList.add('closing');
    setTimeout(() => entry.backdrop.remove(), 140);
    if (prevFocus && prevFocus.focus && document.contains(prevFocus)) { try { prevFocus.focus({ preventScroll: true }); } catch { /* ignore */ } }
    resolve(value);
  };
  entry.close = close;

  const bodyNode = el('div', { class: 'sw-modal-body' });
  if (typeof body === 'string') { for (const para of body.split('\n')) bodyNode.appendChild(el('p', { text: para })); }
  else append(bodyNode, [body]);

  const btnRow = el('div', { class: 'sw-modal-buttons' });
  const list = buttons && buttons.length ? buttons : [{ label: 'OK', value: true, kind: 'primary' }];
  for (const b of list) {
    const btn = el('button', {
      class: 'sw-btn' + (b.kind ? ' ' + b.kind : ''), text: b.label, disabled: !!b.disabled,
      attrs: { type: 'button', 'data-value': b.value === undefined ? '' : String(b.value) },
      on: { click: () => { if (b.onClick && b.onClick(close) === false) return; close(b.value); } },
    });
    if (b.tip) btn.setAttribute('data-tip', b.tip);
    if (b.kind === 'primary' && !entry.primary) entry.primary = btn;
    btnRow.appendChild(btn);
  }

  const dialog = el('div', { class: 'sw-modal' + (wide ? ' wide' : '') + (cls ? ' ' + cls : ''), attrs: { role: 'dialog', 'aria-modal': 'true' } },
    title ? el('div', { class: 'sw-modal-head' },
      el('div', { class: 'sw-title', text: title }),
      dismissable ? el('button', { class: 'sw-modal-x', text: '×', attrs: { type: 'button', 'aria-label': 'Close' }, on: { click: () => close(cancelValue) } }) : null) : null,
    bodyNode, btnRow);
  const backdrop = el('div', { class: 'sw-modal-backdrop', on: { mousedown: e => { if (e.target === backdrop && dismissable) close(cancelValue); } } }, dialog);
  entry.backdrop = backdrop;

  if (!modalStack.length) document.addEventListener('keydown', onModalKey, true);
  modalStack.push(entry);
  uiRoot().appendChild(backdrop);
  const focusTarget = dialog.querySelector('[autofocus]') || entry.primary || btnRow.querySelector('button');
  if (focusTarget) { try { focusTarget.focus({ preventScroll: true }); } catch { /* ignore */ } }

  promise.close = close;
  promise.node = dialog;
  return promise;
}

// ---------------------------------------------------------------- tooltips

// ------------------------------------------------------------------ interface size
// The whole 2D interface lives under #ui, which is drawn at `zoom: var(--sw-ui-scale)` (css/style.css). The 3D canvas
// is not zoomed. Anything that places an element under #ui from a screen position (a projected label, a tooltip, a
// drag ghost) works in viewport pixels and must divide by uiScale() before writing left/top/translate; rectangles
// from getBoundingClientRect() and pointer events are in viewport pixels already.
let _uiScale = 1;
export const UI_SCALE_MIN = 0.8, UI_SCALE_MAX = 1.75;
export const uiScale = () => _uiScale;
/** Viewport pixels → pixels inside the zoomed interface. */
export const uiPx = v => v / _uiScale;
/** Auto: 1 up to a 1600 × 900 window, then grows with the window (1.2 at 1920 × 1080, 1.6 at 2560 × 1440). */
export function autoUiScale(w, h) {
  const k = Math.min(w / 1600, h / 900);
  return Math.max(1, Math.min(UI_SCALE_MAX, Math.round(k * 20) / 20));
}
/** The scale in effect for a setting ('auto' or a number) in a w × h window. A chosen size above 100 % never leaves the
 *  interface less than 1280 × 720 of its own pixels to lay itself out in. */
export function resolveUiScale(setting, w, h) {
  if (setting == null || setting === 'auto' || !Number.isFinite(Number(setting))) return autoUiScale(w, h);
  let k = Math.max(UI_SCALE_MIN, Math.min(UI_SCALE_MAX, Number(setting)));
  if (k > 1) k = Math.max(1, Math.min(k, Math.floor(Math.min(w / 1280, h / 720) * 20) / 20));
  return k;
}
export function setUiScale(k) {
  k = Number.isFinite(k) && k > 0 ? k : 1;
  if (k === _uiScale && document.documentElement.style.getPropertyValue('--sw-ui-scale')) return false;
  _uiScale = k;
  document.documentElement.style.setProperty('--sw-ui-scale', String(k));
  return true;
}

let tipNode = null, tipTarget = null, tipTimer = 0;
const tipFns = new WeakMap();

function hideTip() {
  clearTimeout(tipTimer);
  tipTarget = null;
  if (tipNode) tipNode.classList.remove('show');
}

function placeTip(target) {
  if (!tipNode) return;
  const r = target.getBoundingClientRect();
  const t = tipNode.getBoundingClientRect();
  const vw = window.innerWidth, vh = window.innerHeight;
  let x = r.left + r.width / 2 - t.width / 2;
  let y = r.top - t.height - 8 * _uiScale;
  if (y < 6) y = Math.min(vh - t.height - 6, r.bottom + 8 * _uiScale);
  x = Math.max(6, Math.min(vw - t.width - 6, x));
  const k = _uiScale;                                   // .sw-tooltip is zoomed like #ui (css/style.css)
  tipNode.style.transform = `translate(${Math.round(x / k)}px, ${Math.round(y / k)}px)`;
}

function showTip(target) {
  const fn = tipFns.get(target);
  const content = fn ? (typeof fn === 'function' ? fn(target) : fn) : target.getAttribute('data-tip');
  if (!content) return;
  if (!tipNode) tipNode = el('div', { class: 'sw-tooltip', attrs: { role: 'tooltip' } });
  if (!tipNode.isConnected) document.body.appendChild(tipNode);
  clear(tipNode);
  if (content instanceof Node) tipNode.appendChild(content); else tipNode.textContent = String(content);
  tipNode.classList.add('show');
  placeTip(target);
}

let tipsInstalled = false;
function installTips() {
  if (tipsInstalled || typeof document === 'undefined') return;
  tipsInstalled = true;
  document.addEventListener('mouseover', e => {
    const t = e.target instanceof Element ? e.target.closest('[data-tip]') : null;
    if (t === tipTarget) return;
    hideTip();
    if (!t) return;
    tipTarget = t;
    tipTimer = setTimeout(() => { if (tipTarget === t && t.isConnected) showTip(t); }, 350);
  }, true);
  document.addEventListener('mousedown', hideTip, true);
  document.addEventListener('wheel', hideTip, { capture: true, passive: true });
  window.addEventListener('blur', hideTip);
}

/** Attach a tooltip. `content` is a string, a Node, or a function(target) returning either. Returns the node. */
export function tooltip(node, content) {
  installTips();
  if (typeof content === 'string') node.setAttribute('data-tip', content);
  else { node.setAttribute('data-tip', '1'); tipFns.set(node, content); }
  return node;
}

installTips();

// ---------------------------------------------------------------- icons (original, 24×24, stroke = currentColor)

const S = 'fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"';
export const ICONS = {
  star: `<path d="M12 2c.8 6 3.2 8.9 10 10-6.8 1.1-9.2 4-10 10-.8-6-3.2-8.9-10-10 6.8-1.1 9.2-4 10-10z" fill="currentColor"/>`,
  funds: `<path d="M12 2c.8 6 3.2 8.9 10 10-6.8 1.1-9.2 4-10 10-.8-6-3.2-8.9-10-10 6.8-1.1 9.2-4 10-10z" fill="currentColor"/>`,
  science: `<path ${S} d="M9 3h6M10 3v6l-5 9a2 2 0 0 0 1.8 3h10.400a2 2 0 0 0 1.8-3l-5-9V3M7.5 15h9"/>`,
  rep: `<circle ${S} cx="12" cy="9" r="5.5"/><path ${S} d="M8.5 13.5 7 21l5-2.5 5 2.5-1.5-7.5"/>`,
  clock: `<circle ${S} cx="12" cy="12" r="9"/><path ${S} d="M12 7v5l3.5 2"/>`,
  gear: `<circle ${S} cx="12" cy="12" r="3.2"/><path ${S} d="M12 2.500v3M12 18.500v3M2.5 12h3M18.5 12h3M5.3 5.300l2.1 2.100M16.6 16.600l2.1 2.100M5.3 18.700l2.1-2.100M16.6 7.400l2.1-2.1"/>`,
  back: `<path ${S} d="M14.5 5 8 12l6.5 7"/>`,
  hangar: `<path ${S} d="M3 20V11a9 9 0 0 1 18 0v9M3 20h18M8 20v-6h8v6M8 17h8"/>`,
  rocket: `<path ${S} d="M12 2.500c3 2.5 4.5 6 4.5 9.500v4h-9v-4c0-3.5 1.5-7 4.5-9.500zM7.5 13 4.5 16v3l3-1.500M16.5 13l3 3v3l-3-1.500M10 19.500l2 2.5 2-2.5"/><circle ${S} cx="12" cy="9.5" r="1.6"/>`,
  dish: `<path ${S} d="M4 5a11 11 0 0 0 15 15zM11.5 12.5 16 8M12 21h8M9 16.5 7 21"/><circle cx="17" cy="7" r="1.5" fill="currentColor"/>`,
  lab: `<path ${S} d="M4 20a8 8 0 0 1 16 0zM12 12V8M9.5 5.500a2.5 2.5 0 1 1 5 0 2.5 2.5 0 0 1-5 0M2.5 20h19"/>`,
  board: `<rect ${S} x="4" y="3.5" width="16" height="13" rx="2"/><path ${S} d="M8 8.500l1.5 1.500L12 7.500M14 9h3M8 13h9M9 20.500l3-4 3 4"/>`,
  crew: `<circle ${S} cx="12" cy="13" r="7.5"/><path ${S} d="M7 13a5 4 0 0 1 10 0 5 4 0 0 1-10 0M12 5.500V3"/><circle cx="12" cy="2.5" r="1.5" fill="currentColor"/>`,
  lock: `<rect ${S} x="5" y="11" width="14" height="9.5" rx="2"/><path ${S} d="M8 11V8a4 4 0 0 1 8 0v3"/>`,
  check: `<path ${S} stroke-width="2.6" d="M5 12.500l4.5 4.500L19 7.5"/>`,
  open: `<circle ${S} cx="12" cy="12" r="8.5" stroke-dasharray="3 3.5"/>`,
  mouse: `<rect ${S} x="6.5" y="2.5" width="11" height="19" rx="5.5"/><path ${S} d="M12 6.500v4"/>`,
  pilot: `<path ${S} d="M12 4v14M12 9 3.5 14v2l8.5-2 8.5 2v-2zM9 20.500l3-1.5 3 1.5"/>`,
  engineer: `<path ${S} d="M14.5 6a4.5 4.5 0 0 0-6 5.700L3.5 16.700a2 2 0 0 0 2.8 2.800l5-5A4.5 4.5 0 0 0 17 8.500l-2.8 2.8-2.5-2.500z"/>`,
  scientist: `<path ${S} d="M9 3h6M10 3v6l-5 9a2 2 0 0 0 1.8 3h10.400a2 2 0 0 0 1.8-3l-5-9V3M7.5 15h9"/>`,
  play: `<path d="M7 4.500v15l12.5-7.500z" fill="currentColor"/>`,
  trash: `<path ${S} d="M4.5 7h15M9.5 7V4.500h5V7M6.5 7l1 13h9l1-13M10 11v5.500M14 11v5.5"/>`,
  plus: `<path ${S} stroke-width="2.4" d="M12 5v14M5 12h14"/>`,
  keyboard: `<rect ${S} x="2.5" y="6" width="19" height="12" rx="2.5"/><path ${S} d="M6.5 10h.01M10 10h.01M13.5 10h.01M17 10h.01M7 14h10"/>`,
  save: `<path ${S} d="M5 3.500h11l3.5 3.500v13.500H5zM8 3.500v5h7v-5M8 20.500v-6h8v6"/>`,
  exit: `<path ${S} d="M10 4H5v16h5M14 8l4 4-4 4M18 12H9"/>`,
};

/** icon('rocket') → <svg> element (24×24 viewBox, sized by CSS). */
export function icon(name, cls = '') {
  const node = document.createElementNS(SVG_NS, 'svg');
  node.setAttribute('viewBox', '0 0 24 24');
  node.setAttribute('aria-hidden', 'true');
  if (cls) node.setAttribute('class', cls);
  node.innerHTML = ICONS[name] || ICONS.star;
  return node;
}

// ---------------------------------------------------------------- shared page frame for management screens

const MODE_CHIP = { career: ['Career', 'amber'], science: ['Science', 'violet'], sandbox: ['Sandbox', 'teal'] };

/** The funds / science / reputation / date chips. Returns { node, refresh() }. */
export function statsBar(app, { date = true } = {}) {
  const node = el('div', { class: 'sw-stats' });
  let key = '';
  const refresh = () => {
    const c = app.career;
    if (!c) { clear(node); key = ''; return; }
    const k = [c.mode, Math.floor(c.funds), c.science, c.reputation, date ? Math.floor(c.ut) : 0].join('|');
    if (k === key) return;
    key = k;
    clear(node);
    const stat = (id, ico, color, label, value, tip) => node.appendChild(el('div', { class: 'sw-stat ' + id, tip, data: { stat: id } },
      (() => { const i = icon(ico); i.style.color = color; return i; })(),
      el('span', { class: 'sw-label', text: label }), el('span', { class: 'sw-value', text: value })));
    if (c.mode === 'career') stat('funds', 'funds', 'var(--sw-amber)', 'Funds', fmt.num(c.funds), 'Funds: pays for rockets and new crew');
    if (c.mode !== 'sandbox') stat('science', 'science', 'var(--sw-teal)', 'Science', fmt.num(c.science, c.science % 1 ? 1 : 0), 'Science: spend it in the Research Lab');
    if (c.mode === 'career') stat('rep', 'rep', 'var(--sw-violet)', 'Reputation', fmt.num(c.reputation), 'Reputation: earned by completing milestones');
    if (date) stat('date', 'clock', 'var(--sw-dim)', '', fmt.date(c.ut), 'Verda calendar: 5.5-hour days, 460-day years');
    const [name, color] = MODE_CHIP[c.mode] || [c.mode, ''];
    node.appendChild(el('span', { class: 'sw-chip ' + color, text: name, data: { stat: 'mode' } }));
  };
  refresh();
  return { node, refresh };
}

/**
 * screenFrame(app, { name, title, subtitle, onBack }) → { root, page, stats, setSubtitle(text) }
 * A full-window opaque screen with the standard top bar (Back, title, stats). Append content to `page`.
 */
export function screenFrame(app, { name, title, subtitle = '', onBack } = {}) {
  const stats = statsBar(app, { date: false });
  const sub = el('span', { class: 'sw-topbar-sub', text: subtitle });
  const back = el('button', { class: 'sw-btn', attrs: { type: 'button', 'data-action': 'back' }, tip: 'Back to the Flight Center (Esc)',
    on: { click: () => (onBack ? onBack() : app.goto('hub')) } }, icon('back'), 'Flight Center');
  const page = el('div', { class: 'sw-page' });
  const root = el('div', { class: 'sw-screen opaque', data: { screen: name } },
    el('div', { class: 'sw-topbar' }, back, el('span', { class: 'sw-title big', text: title }), sub, stats.node),
    page);
  return { root, page, stats, setSubtitle(t) { sub.textContent = t; } };
}
