// Starwright assembly building — the HUD: top bar, tool strip, parts bin, staging stack, info bar, dialogs.
// createPanels(ed) → { root, refresh*, tick(dt), setStatus(text, kind), dismissHint(), openLoadDialog(), openLaunchDialog(), dispose() }
// `ed` is the editor object built in js/ui/builder.js (state + actions); nothing here touches three.js directly.
import { el, clear, fmt, showModal, tooltip, icon, uiPx } from '../dom.js';
import * as PARTS_MOD from '../../core/parts.js';
import * as CRAFT_MOD from '../../core/craft.js';
const { Craft, stockCrafts } = CRAFT_MOD;
import { SYSTEM } from '../../core/bodies.js';
import { airRatingText } from '../stress.js';

const { PART_LIST, partDef, engineThrust } = PARTS_MOD;
const AUTOSAVE = '__autosave';
const S = 'fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"';
const BICONS = {
  // categories (unknown ids fall back to `generic`)
  command: `<path ${S} d="M8.500 5h7l4 13.500h-15zM4.500 18.500h15M10 10.500h4v3h-4z"/>`,
  tanks: `<rect ${S} x="6.500" y="3" width="11" height="18" rx="3"/><path ${S} d="M6.500 8.500h11M6.500 15.500h11"/>`,
  engines: `<path ${S} d="M9 3h6v4.500l4.500 11h-15L9 7.500zM9 7.500h6M10 21.500l2-2 2 2"/>`,
  structure: `<path ${S} d="M4 7h16M4 17h16M7 7v10M17 7v10M7 17 17 7"/>`,
  coupling: `<path ${S} d="M4 9h16M4 15h16M9 5l3 2.500 3-2.500M9 19l3-2.500 3 2.500"/>`,
  aero: `<path ${S} d="M5 20V9.500L14 3.500V15l5 5z"/>`,
  wings: `<path ${S} d="M3 15.500 12 5l9 10.500-9-3zM12 12.500V21"/>`,
  plane: `<path ${S} d="M12 2.500c1.200 1.500 1.800 3.500 1.800 6v2l7.700 5v2.500l-7.700-2.500v3.500l2.200 1.800V22L12 21l-4 1v-1.200l2.200-1.800v-3.500L2.500 18v-2.500l7.700-5v-2c0-2.500.600-4.500 1.800-6z"/>`,
  wheels: `<circle ${S} cx="12" cy="12" r="8.500"/><circle ${S} cx="12" cy="12" r="3"/><path ${S} d="M12 3.500V9M12 15v5.500M3.500 12H9M15 12h5.500"/>`,
  utility: `<rect ${S} x="3.500" y="7" width="15" height="10" rx="2"/><path ${S} d="M18.500 10.500h2v3h-2M11.500 9.500 9 12.500h3.500l-2.500 3"/>`,
  electrics: `<path ${S} d="M13 2.500 5 13.500h6l-1 8 8-11h-6z"/>`,
  science: `<path ${S} d="M9 3h6M10 3v6l-5 9a2 2 0 0 0 1.800 3h10.400a2 2 0 0 0 1.800-3l-5-9V3M7.500 15h9"/>`,
  comms: `<path ${S} d="M4 5a11 11 0 0 0 15 15zM11.500 12.500 16 8"/><circle cx="17" cy="7" r="1.500" fill="currentColor"/>`,
  rover: `<path ${S} d="M3.500 14V9.500h10l3 3h4V14M3.500 14h17"/><circle ${S} cx="7" cy="16.500" r="2.500"/><circle ${S} cx="17" cy="16.500" r="2.500"/>`,
  payload: `<path ${S} d="M4 8l8-4.500L20 8v8l-8 4.500L4 16zM4 8l8 4.500L20 8M12 12.500v8"/>`,
  generic: `<path ${S} d="M12 3l7.800 4.500v9L12 21l-7.800-4.500v-9z"/>`,
  // actions
  undo: `<path ${S} d="M8 5 4 9l4 4M4 9h10a6 6 0 0 1 0 12h-4"/>`,
  redo: `<path ${S} d="M16 5l4 4-4 4M20 9H10a6 6 0 0 0 0 12h4"/>`,
  folder: `<path ${S} d="M3 7.500V18a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V9.500a2 2 0 0 0-2-2h-7l-2-2.500H5a2 2 0 0 0-2 2.500z"/>`,
  fresh: `<path ${S} d="M6 3.500h8l4.500 4.500v12.500H6zM14 3.500V8h4.500M12 11.500v6M9 14.500h6"/>`,
  search: `<circle ${S} cx="10.500" cy="10.500" r="6"/><path ${S} d="M15 15l5.500 5.500"/>`,
  note: `<path ${S} d="M5 4h14v12l-4 4H5zM15 20v-4h4M8.500 9h7M8.500 13h4"/>`,
  report: `<path ${S} d="M5 20V10M10 20V4M15 20v-8M20 20v-5"/>`,
  warn: `<path ${S} d="M12 3.500 21.500 20h-19zM12 10v4.500M12 17.500h.01"/>`,
  // tools
  place: `<path ${S} d="M6 3.500v13l3.500-3 2.500 6 2.500-1-2.500-6h5z"/>`,
  move: `<path ${S} d="M12 3v18M3 12h18M12 3 9.500 5.500M12 3l2.500 2.500M12 21l-2.500-2.500M12 21l2.500-2.500M3 12l2.500-2.500M3 12l2.500 2.500M21 12l-2.500-2.500M21 12l-2.500 2.500"/>`,
  rotate: `<path ${S} d="M19.500 12a7.500 7.500 0 1 1-2.600-5.700M19.500 4v4.500H15"/>`,
  action: `<rect ${S} x="3.500" y="4" width="7" height="7" rx="1.500"/><rect ${S} x="13.500" y="4" width="7" height="7" rx="1.500"/><rect ${S} x="3.500" y="14" width="7" height="6.500" rx="1.500"/><path ${S} d="M17 13.500v7M13.500 17h7"/>`,
  root: `<circle ${S} cx="12" cy="5.500" r="2.500"/><path ${S} d="M12 8v5M12 13l-6 3.500M12 13l6 3.500M6 16.500v3M18 16.500v3M12 13v6.500"/>`,
  snap: `<path ${S} d="M4 20V5M4 20h15M4 11a9 9 0 0 1 9 9M4 15.500a4.500 4.500 0 0 1 4.500 4.500"/>`,
  loads: `<path ${S} d="M8 8.500V4.500a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v4M8 15.500v4a2 2 0 0 0 2 2h4a2 2 0 0 0 2-2v-4"/><ellipse ${S} stroke-width="2.400" cx="12" cy="12" rx="8.500" ry="3"/>`,
  chevron: `<path ${S} d="M6 14.500l6-6 6 6"/>`,
  mirror: `<path ${S} d="M12 3v18M9 7 4 17h5zM15 7l5 10h-5z" stroke-dasharray="0"/>`,
  radial: `<circle ${S} cx="12" cy="12" r="3"/><circle cx="12" cy="3.500" r="1.800" fill="currentColor"/><circle cx="19.400" cy="16.200" r="1.800" fill="currentColor"/><circle cx="4.600" cy="16.200" r="1.800" fill="currentColor"/>`,
  // stage kinds
  engine: `<path ${S} d="M9 3h6v4.500l4.500 11h-15L9 7.500z"/>`,
  decoupler: `<path ${S} d="M4 9h16M4 15h16M9 5l3 2.500 3-2.500M9 19l3-2.500 3 2.500"/>`,
  chute: `<path ${S} d="M3.500 11a8.500 8.500 0 0 1 17 0zM3.500 11 12 21l8.500-10M12 11v10"/>`,
  grip: `<circle cx="9" cy="7" r="1.500" fill="currentColor"/><circle cx="15" cy="7" r="1.500" fill="currentColor"/><circle cx="9" cy="12" r="1.500" fill="currentColor"/><circle cx="15" cy="12" r="1.500" fill="currentColor"/><circle cx="9" cy="17" r="1.500" fill="currentColor"/><circle cx="15" cy="17" r="1.500" fill="currentColor"/>`,
  minus: `<path ${S} stroke-width="2.400" d="M5 12h14"/>`,
};
const CAT_ICON_ALIASES = { tank: 'tanks', fuel: 'tanks', engine: 'engines', propulsion: 'engines', struct: 'structure', structural: 'structure', couplers: 'coupling', aerodynamics: 'aero', wing: 'wings', aircraft: 'plane', planes: 'plane', spaceplane: 'plane', wheel: 'wheels', gear: 'wheels', ground: 'wheels', electric: 'electrics', electrical: 'electrics', power: 'electrics', communication: 'comms', antenna: 'comms', rovers: 'rover', cargo: 'payload', control: 'command', pods: 'command' };
function bicon(name, cls = '') {
  const n = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  n.setAttribute('viewBox', '0 0 24 24'); n.setAttribute('aria-hidden', 'true');
  if (cls) n.setAttribute('class', cls);
  n.innerHTML = BICONS[name] || BICONS.generic;
  return n;
}
const catIcon = id => bicon(BICONS[id] ? id : CAT_ICON_ALIASES[id] || 'generic');
function symIcon(n, mirror) {
  const node = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  node.setAttribute('viewBox', '0 0 24 24'); node.setAttribute('aria-hidden', 'true');
  if (mirror) { node.innerHTML = `<path ${S} d="M12 2.500v19" stroke-dasharray="2.500 2.500"/><path d="M9.500 7 3.500 17.500h6zM14.500 7l6 10.500h-6z" fill="currentColor"/>`; return node; }
  let h = `<circle cx="12" cy="12" r="4.200" fill="none" stroke="currentColor" stroke-width="2"/>`;
  for (let k = 0; k < n; k++) { const a = -Math.PI / 2 + k * 2 * Math.PI / n; h += `<circle cx="${(12 + Math.cos(a) * 9).toFixed(2)}" cy="${(12 + Math.sin(a) * 9).toFixed(2)}" r="2.100" fill="currentColor"/>`; }
  node.innerHTML = h;
  return node;
}

const SIZE_NAMES = { S: 'Small', M: 'Medium', L: 'Large', XL: 'Extra large', XS: 'Tiny' };
function sizeLabel(code) {
  const sizes = PARTS_MOD.SIZES || {};
  const r = sizes[code];
  return (SIZE_NAMES[code] || code) + (Number.isFinite(r) ? ` (${(r * 2).toFixed(r * 2 >= 1 && Math.abs(r * 2 - Math.round(r * 2 * 4) / 4) < 1e-6 ? 2 : 3).replace(/\.?0+$/, '')} m)` : '');
}
const sizeRank = code => { const r = (PARTS_MOD.SIZES || {})[code]; return Number.isFinite(r) ? r : 0; };
const num = (v, d = 0) => Number.isFinite(v) ? fmt.num(Number(v.toFixed(d))) : '—';
const kindOf = d => d.engine ? 'engine' : d.decoupler ? 'decoupler' : d.chute ? 'chute' : 'other';

export function partStatRows(d) {
  const rows = [];
  const res = d.res || {};
  const wet = d.mass * 1000 + Object.entries(res).reduce((s, [k, v]) => s + (k === 'elec' ? 0 : v), 0);
  rows.push(['Mass', wet > d.mass * 1000 + 0.5 ? `${fmt.mass(wet)} full · ${fmt.mass(d.mass * 1000)} empty` : fmt.mass(d.mass * 1000)]);
  if (d.size) rows.push(['Size', sizeLabel(d.size)]);
  const RES = { fuel: ['Liquid fuel', 'kg'], solid: ['Solid fuel', 'kg'], mono: ['Monoprop', 'kg'], xenon: ['Xenon', 'kg'], elec: ['Charge', 'EC'], ablator: ['Ablator', 'kg'] };
  for (const [k, v] of Object.entries(res)) { if (!v || k === 'evafuel') continue; const [label, unit] = RES[k] || [k[0].toUpperCase() + k.slice(1), '']; rows.push([label, fmt.num(v) + (unit ? ' ' + unit : '')]); }
  if (d.engine) {
    const e = d.engine, type = e.type || 'liquid';
    let asl = 0; try { asl = engineThrust(d, 1) / 1000; } catch { asl = 0; }
    rows.push(['Thrust', type === 'jet' ? `${num(e.thrust, 1)} kN static` : `${num(e.thrust, e.thrust < 10 ? 2 : 0)} kN vac · ${num(asl, asl < 10 ? 1 : 0)} kN sea level`]);
    if (e.ispVac) rows.push(['Isp', `${num(e.ispVac)} s vac · ${num(e.ispAtm)} s sea level`]);
    const TYPE = { solid: 'Solid (no throttle)', liquid: 'Liquid', ion: 'Ion (xenon + charge)', nuclear: 'Nuclear thermal', jet: 'Air-breathing jet' };
    rows.push(['Type', (TYPE[type] || type) + (e.gimbal ? ` · gimbal ${e.gimbal}°` : '')]);
    if (e.elecUse) rows.push(['Power draw', e.elecUse + ' EC/s']);
    if (e.jet) rows.push(['Envelope', `to ${num((e.jet.maxAlt || 0) / 1000, 1)} km · Mach ${e.jet.maxMach ?? '—'}`]);
    if (res.solid && e.thrust && e.ispVac) rows.push(['Burn time', fmt.time(res.solid / (e.thrust * 1000 / (e.ispVac * 9.80665)))]);
  }
  if (d.command) rows.push(['Control', d.command === 'crew' ? `Crewed · ${d.crew} seat${d.crew > 1 ? 's' : ''}` : 'Probe (needs charge)']);
  if (d.torque) rows.push(['Reaction torque', d.torque + ' kN·m']);
  if (d.decoupler) rows.push(['Separation', d.decoupler.force + ' kN kick']);
  // interstage trusses are not parts in the bin: say on the parts that make one what will appear and what it weighs
  if (typeof PARTS_MOD.wantsInterstage === 'function' && PARTS_MOD.wantsInterstage(d)) {
    let kg = 0; try { kg = PARTS_MOD.interstageMass(d.h, d.r, d.r); } catch { kg = 0; }
    rows.push(['Interstage', `Automatic: stack a stage under this engine and an open lattice ring${kg ? ` (about ${Math.round(kg)} kg)` : ''} wraps the bell and carries the load rim to rim`]);
  } else if (d.decoupler && d.attach.stack) rows.push(['Interstage', 'Under an engine it carries a lattice ring up around the bell, and takes it along when it separates']);
  if (d.chute) rows.push(['Parachute', `opens fully below ${d.chute.fullAlt} m · safe under ${d.chute.maxSpeed} m/s`]);
  if (d.wing) rows.push(['Lifting area', `${d.wing.area} m²` + (d.wing.control ? ` · control: ${d.wing.control === true ? 'yes' : d.wing.control}` : '')]);
  if (d.fin) rows.push(['Fin', `${d.fin.area} m²` + (d.fin.control ? ' · steerable' : '')]);
  if (d.wheel) {
    const w = d.wheel;
    rows.push([w.drive ? 'Wheel' : 'Landing gear', `${num((w.radius || 0) * 2, 2)} m` + (w.drive ? ` · ${w.drive} kN drive` : '') + (w.steer ? ' · steers' : '') + (w.retract || d.retract ? ' · retracts' : '')]);
    if (w.brake) rows.push(['Brakes', w.brake + ' kN']);
    if (w.maxSpeed) rows.push(['Top speed', w.maxSpeed + ' m/s']);
  }
  if (d.solar) rows.push(['Output', d.solar.rate + ' EC/s in sunlight']);
  if (d.rcs) rows.push(['Thrusters', `${d.rcs.thrust} kN · ${d.rcs.isp} s`]);
  if (d.legs) rows.push(['Reach', d.legs.reach + ' m']);
  if (d.light) rows.push(['Light', `range ${d.light.range} m`]);
  if (d.antenna) rows.push(['Antenna', d.antenna.rate ? `rate ×${d.antenna.rate}` : 'yes']);
  if (d.dock) rows.push(['Docking', 'size ' + d.dock.size]);
  if (d.heatshield) rows.push(['Heat limit', fmt.num(d.maxTemp) + ' K']);
  if (d.experiment) rows.push(['Experiment', String(d.experiment).replace(/_/g, ' ')]);
  if (Number.isFinite(d.tolerance)) rows.push(['Impact limit', d.tolerance + ' m/s']);
  const air = airRatingText(PARTS_MOD.airRating(d));
  if (air) rows.push(['Air limit', air]);
  rows.push(['Mounts', d.attach.radial ? (d.attach.outer ? 'On surfaces; holds a booster' : 'On surfaces') : d.topOnly ? 'Top of a stack only' : 'Stack nodes, top and bottom']);
  return rows;
}

export function createPanels(ed) {
  const app = ed.app;
  const dom = {};
  let reportOpen = false, loadsOpen = false, statusKey = null, hintGone = false;
  let thumbQueue = [], spin = null;
  const thumbStore = new Map();       // def id → canvas (cached render)
  let disposed = false;

  const career = () => ed.career;
  const craft = () => ed.craft;
  const btn = (label, ico, onClick, extra = {}) => el('button', { class: 'sw-btn ' + (extra.cls || ''), attrs: { type: 'button', 'data-action': extra.action || label.toLowerCase() }, tip: extra.tip, on: { click: onClick } }, ico, label || null);
  const key = t => el('span', { class: 'sw-kbd', text: t });

  // ------------------------------------------------------------------ thumbnails
  const TH = 112;
  function thumbCanvas(def, cls = 'bld-thumb') {
    const c = el('canvas', { class: cls, attrs: { width: TH, height: TH, 'data-thumb': def.id } });
    const cached = thumbStore.get(def.id);
    if (cached) { c.getContext('2d').drawImage(cached, 0, 0); c.dataset.ready = '1'; }
    else thumbQueue.push({ def, canvas: c });
    return c;
  }
  function renderThumb(def, canvas, angle) {
    if (!ed.thumbs) return false;
    try { ed.thumbs.part(def, canvas, angle); } catch (err) { console.warn('[builder] thumbnail failed for ' + def.id + ':', err && err.message); return false; }
    return true;
  }
  function tick(dt) {
    if (disposed) return;
    for (let i = 0; i < 3 && thumbQueue.length; i++) {
      const { def, canvas } = thumbQueue.shift();
      let store = thumbStore.get(def.id);
      if (!store) {
        store = document.createElement('canvas'); store.width = store.height = TH;
        if (renderThumb(def, store, 0.6)) thumbStore.set(def.id, store);
      }
      canvas.getContext('2d').clearRect(0, 0, TH, TH);
      canvas.getContext('2d').drawImage(store, 0, 0);
      canvas.dataset.ready = '1';
    }
    // the card under the pointer turns slowly: a live view of the real mesh
    if (spin && spin.canvas.isConnected && !thumbQueue.length) {
      spin.a += dt * 1.5;
      renderThumb(spin.def, spin.canvas, 0.6 + spin.a);
    }
  }
  function stopSpin() {
    if (!spin) return;
    const s = spin; spin = null;
    const store = thumbStore.get(s.def.id);
    if (store && s.canvas.isConnected) { const c = s.canvas.getContext('2d'); c.clearRect(0, 0, TH, TH); c.drawImage(store, 0, 0); }
  }

  // ------------------------------------------------------------------ parts bin
  function partTip(d) {
    const locked = !ed.unlocked(d.id);
    return el('div', { class: 'bld-tip' },
      el('div', { class: 'bld-tip-head' }, el('b', { text: d.name }), el('span', { class: 'sw-amber', text: fmt.funds(d.cost) })),
      el('p', { text: d.desc || '' }),
      el('dl', {}, partStatRows(d).map(([k, v]) => [el('dt', { text: k }), el('dd', { text: v })])),
      locked ? el('div', { class: 'bld-tip-lock', text: `Locked · research “${ed.techName(d.tech)}”` }) : el('div', { class: 'bld-tip-foot', text: 'Click to pick up · click in the hall to place' }));
  }
  const SORTS = {
    name: (a, b) => a.name.localeCompare(b.name),
    cost: (a, b) => a.cost - b.cost || a.name.localeCompare(b.name),
    mass: (a, b) => a.mass - b.mass || a.name.localeCompare(b.name),
    size: (a, b) => sizeRank(a.size) - sizeRank(b.size) || a.name.localeCompare(b.name),
  };
  function cats() { return (PARTS_MOD.CATEGORIES || []).filter(c => c.id !== 'internal' && PART_LIST.some(d => d.cat === c.id)); }
  function refreshCatalogue() {
    if (!dom.grid) return;
    stopSpin();
    clear(dom.grid); thumbQueue = [];
    const st = ed.state, q = st.search.trim().toLowerCase();
    let list = PART_LIST.filter(d => q ? (d.name + ' ' + (d.desc || '') + ' ' + d.cat + ' ' + d.shape + ' ' + (d.size || '')).toLowerCase().includes(q) : d.cat === st.category);
    if (st.sort && SORTS[st.sort]) list = list.slice().sort(SORTS[st.sort]);
    list = [...list.filter(d => ed.unlocked(d.id)), ...list.filter(d => !ed.unlocked(d.id))];
    for (const b of dom.cats.children) b.classList.toggle('active', !q && b.dataset.cat === st.category);
    const cat = (PARTS_MOD.CATEGORIES || []).find(c => c.id === st.category);
    dom.catName.textContent = q ? `Search · ${list.length} part${list.length === 1 ? '' : 's'}` : `${cat ? cat.name : st.category} · ${list.length}`;
    if (!list.length) { dom.grid.appendChild(el('div', { class: 'sw-empty', text: q ? `No part matches “${st.search.trim()}”.` : 'Nothing here yet.' })); return; }
    const frag = document.createDocumentFragment();
    for (const d of list) {
      const locked = !ed.unlocked(d.id);
      const canvas = thumbCanvas(d);
      const card = el('button', {
        class: 'bld-card' + (locked ? ' locked' : '') + (ed.heldType === d.id ? ' held' : ''),
        attrs: { type: 'button', 'data-part': d.id, 'aria-label': d.name },
        on: {
          click: () => { if (ed.pick(d.id)) ed.sfx('click'); },
          mouseenter: () => { stopSpin(); if (!locked) spin = { def: d, canvas, a: 0 }; },
          mouseleave: () => { if (spin && spin.canvas === canvas) stopSpin(); },
        },
      }, el('span', { class: 'bld-thumb-wrap' }, canvas, d.size ? el('i', { class: 'bld-size', text: d.size }) : null),
        el('span', { class: 'bld-card-name', text: d.name }),
        locked ? el('span', { class: 'bld-card-lock' }, icon('lock'), el('span', { text: ed.techName(d.tech) }))
          : el('span', { class: 'bld-card-cost', text: fmt.funds(d.cost) }));
      tooltip(card, () => partTip(d));
      frag.appendChild(card);
    }
    dom.grid.appendChild(frag);
    dom.grid.scrollTop = 0;
  }
  function refreshCatalogueSelection() {
    if (!dom.grid) return;
    for (const c of dom.grid.querySelectorAll('.bld-card')) c.classList.toggle('held', ed.heldType === c.dataset.part);
  }

  // ------------------------------------------------------------------ staging stack
  function statBody() { return SYSTEM.byId[ed.state.body] || SYSTEM.home; }
  function stageStats() { try { return craft().stats(statBody()); } catch { return []; } }
  function stageGroups(ids) {
    const groups = new Map();
    for (const id of ids) {
      const p = craft().getPart(id);
      if (!p) continue;
      const k = p.type + ':' + (p.sym ? 's' + p.sym : 'p' + p.id);
      if (!groups.has(k)) groups.set(k, { def: partDef(p.type), ids: [] });
      groups.get(k).ids.push(id);
    }
    return [...groups.values()];
  }
  // Pointer-driven drag and drop (HTML5 drag events are unreliable here: restyling the list inside `dragstart`
  // makes Chromium cancel the drag, which is what broke the old staging panel).
  let sdrag = null;
  function dropTargetAt(x, y) {
    const t = document.elementFromPoint(x, y);
    if (!t || !dom.stages.contains(t)) return null;
    const ins = t.closest('.bld-ins'); if (ins) return { node: ins, insert: Number(ins.dataset.insert) };
    const st = t.closest('.bld-stage'); if (st) return { node: st, stage: Number(st.dataset.stage) };
    return null;
  }
  function beginStageDrag(e, payload, source) {
    if (e.button !== 0) return;
    e.preventDefault();
    sdrag = { payload, source, x0: e.clientX, y0: e.clientY, active: false, ghost: null, over: null, id: e.pointerId };
    try { source.setPointerCapture(e.pointerId); } catch { /* synthetic */ }
    const move = ev => {
      if (!sdrag) return;
      if (!sdrag.active) {
        if (Math.hypot(ev.clientX - sdrag.x0, ev.clientY - sdrag.y0) < 5) return;
        sdrag.active = true;
        const r = source.getBoundingClientRect();
        sdrag.ghost = source.cloneNode(true); sdrag.ghost.classList.add('bld-drag-ghost');
        const src = source.querySelector('canvas'), dst = sdrag.ghost.querySelector('canvas');
        if (src && dst) dst.getContext('2d').drawImage(src, 0, 0);
        sdrag.ghost.style.width = uiPx(r.width) + 'px'; sdrag.dx = ev.clientX - r.left; sdrag.dy = ev.clientY - r.top;
        document.body.appendChild(sdrag.ghost);
        root.classList.add('bld-staging-drag'); source.classList.add('drag-src');
      }
      sdrag.ghost.style.transform = `translate(${uiPx(ev.clientX - sdrag.dx)}px, ${uiPx(ev.clientY - sdrag.dy)}px)`;      // zoomed like #ui (css/builder.css)
      const t = dropTargetAt(ev.clientX, ev.clientY);
      if (sdrag.over && (!t || t.node !== sdrag.over.node)) sdrag.over.node.classList.remove('over');
      sdrag.over = t; if (t) t.node.classList.add('over');
    };
    const up = ev => {
      source.removeEventListener('pointermove', move); source.removeEventListener('pointerup', up); source.removeEventListener('pointercancel', up);
      const d = sdrag; sdrag = null;
      if (!d) return;
      if (d.ghost) d.ghost.remove();
      root.classList.remove('bld-staging-drag'); source.classList.remove('drag-src');
      if (d.over) d.over.node.classList.remove('over');
      if (!d.active || ev.type === 'pointercancel') return;
      const t = dropTargetAt(ev.clientX, ev.clientY);
      if (!t) return;
      if (d.payload.ids) {
        if (t.insert != null) ed.stageMove(d.payload.ids, t.insert, { insert: true });
        else if (t.stage !== d.payload.from) ed.stageMove(d.payload.ids, t.stage);
      } else if (d.payload.stage != null) {
        if (t.insert != null) ed.stageReorder(d.payload.stage, t.insert, true);
        else if (t.stage !== d.payload.stage) ed.stageReorder(d.payload.stage, t.stage, false);
      }
    };
    source.addEventListener('pointermove', move); source.addEventListener('pointerup', up); source.addEventListener('pointercancel', up);
  }
  function inserter(index) {
    return el('button', { class: 'bld-ins', attrs: { type: 'button', 'data-insert': index, 'aria-label': 'Add a stage here' }, tip: 'Add an empty stage here (or drop a part or a stage on it)',
      on: { click: () => ed.stageAdd(index) } }, icon('plus'));
  }
  function refreshStaging() {
    if (!dom.stages) return;
    clear(dom.stages);
    const c = craft(), n = c.stages.length, atmo = ed.state.atmo;
    dom.stageMode.textContent = c.autoStaging ? 'Auto' : 'Custom';
    dom.stageMode.className = 'sw-chip ' + (c.autoStaging ? 'teal' : 'amber');
    dom.stageReset.disabled = c.autoStaging || c.isEmpty;
    for (const b of dom.atmo.children) b.classList.toggle('active', (b.dataset.atmo === '1') === atmo);
    const stats = stageStats();
    let total = 0; for (const s of stats) total += atmo ? s.dvAtm : s.dvVac;
    dom.stageTotal.textContent = n ? fmt.num(total) + ' m/s' : '—';
    if (!n) {
      dom.stages.appendChild(el('div', { class: 'sw-empty bld-stage-empty', text: c.isEmpty ? 'Stages stack up here as you add engines, separators and parachutes.' : 'Nothing to stage yet: add an engine, separator or parachute.' }));
      return;
    }
    dom.stages.appendChild(el('div', { class: 'bld-stage-cap', text: 'fires last' }));
    for (let i = n - 1; i >= 0; i--) {
      dom.stages.appendChild(inserter(i + 1));
      const s = stats[i] || {}, ids = c.stages[i];
      const dv = atmo ? s.dvAtm : s.dvVac, twr = atmo ? s.twrAtm : s.twrVac;
      const burns = s.thrust > 0 && s.dvVac > 0.5;
      const grip = el('button', { class: 'bld-stage-grip', attrs: { type: 'button', 'aria-label': 'Drag to reorder stage ' + (n - 1 - i) }, tip: i === 0 ? 'Fires first (first press of Space). Drag to reorder.' : `Fires on Space press ${i + 1}. Drag to reorder.` },
        el('b', { text: String(n - 1 - i) }), bicon('grip'));
      const card = el('div', { class: 'bld-stage' + (ids.length ? '' : ' empty') + (burns ? ' burns' : ''), data: { stage: i, num: n - 1 - i } },
        grip,
        el('div', { class: 'bld-stage-main' },
          burns ? el('div', { class: 'bld-stage-stats' },
            el('span', { class: 'dv', tip: `Delta-v ${atmo ? 'at ' + statBody().name + ' sea level' : 'in vacuum'}` }, el('b', { text: fmt.num(dv) }), ' m/s'),
            el('span', { tip: `Thrust-to-weight at ignition, ${statBody().name} gravity, ${atmo ? 'sea level' : 'vacuum'}`, class: twr < 1 ? 'low' : '' }, 'TWR ', el('b', { text: twr.toFixed(2) })),
            el('span', { tip: 'Burn time at full throttle' }, el('b', { text: fmt.time(s.burnTime) })))
            : el('div', { class: 'bld-stage-stats dim', text: ids.length ? 'no burn' : 'empty stage' }),
          el('div', { class: 'bld-stage-parts' }, stageGroups(ids).map(gr => {
            const kind = kindOf(gr.def);
            const chip = el('div', {
              class: 'bld-chip ' + kind, data: { ids: gr.ids.join(','), type: gr.def.id }, tip: `${gr.def.name}${gr.ids.length > 1 ? ' ×' + gr.ids.length : ''} · drag to another stage`,
              on: { mouseenter: () => ed.setHighlight(gr.ids), mouseleave: () => ed.setHighlight(null), pointerdown: e => beginStageDrag(e, { ids: gr.ids.slice(), from: i }, chip) },
            }, thumbCanvas(gr.def, 'bld-chip-thumb'), el('span', { class: 'bld-chip-kind' }, bicon(kind)), gr.ids.length > 1 ? el('i', { text: '×' + gr.ids.length }) : null);
            return chip;
          }))),
        !ids.length ? el('button', { class: 'bld-stage-del', attrs: { type: 'button', 'data-action': 'stage-remove', 'aria-label': 'Remove this empty stage' }, tip: 'Remove this empty stage', on: { click: () => ed.stageRemove(i) } }, bicon('minus')) : null);
      grip.addEventListener('pointerdown', e => beginStageDrag(e, { stage: i }, card));
      dom.stages.appendChild(card);
    }
    dom.stages.appendChild(inserter(0));
    dom.stages.appendChild(el('div', { class: 'bld-stage-cap', text: 'fires first · Space' }));
  }

  // ------------------------------------------------------------------ info bar, report, toolbar
  function summary() {
    const c = craft(), stats = stageStats(), atmo = ed.state.atmo;
    const first = stats.find(s => s.thrust > 0), size = ed.craftSize();
    return {
      stats, parts: c.parts.length, mass: c.mass(), cost: c.cost(), truss: typeof c.interstageMass === 'function' ? c.interstageMass() : 0,
      dvVac: stats.reduce((s, x) => s + x.dvVac, 0), dvAtm: stats.reduce((s, x) => s + x.dvAtm, 0),
      twr: first ? (first.twr) : 0, size, atmo,
    };
  }
  function refreshInfo() {
    if (!dom.info) return;
    const c = craft(), s = summary(), v = c.isEmpty ? { ok: true, errors: [], warnings: [] } : ed.checkCraft();
    const afford = !career() || career().canAfford(s.cost);
    const stat = (id, label, value, cls = '', tip = '') => el('div', { class: 'bld-stat', data: { stat: id }, tip: tip || null },
      el('span', { class: 'sw-label', text: label }), el('span', { class: 'sw-value ' + cls }, value));
    clear(dom.infoStats);
    dom.infoStats.append(
      stat('parts', 'Parts', String(s.parts)),
      stat('mass', 'Mass', (s.mass / 1000).toFixed(2) + ' t', '', s.truss ? `Fully fuelled mass, including ${Math.round(s.truss)} kg of interstage truss between the stages` : 'Fully fuelled mass'),
      stat('cost', 'Cost', fmt.funds(s.cost), afford ? 'amber' : 'red', afford ? '' : 'More than the programme can afford right now'),
      stat('dv', 'Δv vac / sea', [fmt.num(s.dvVac), el('small', { text: ' / ' + fmt.num(s.dvAtm) })], 'teal', `Total delta-v in m/s: in vacuum / if every stage burned at ${statBody().name} sea-level pressure. Low Verda orbit takes roughly 3,400 m/s.`),
      stat('twr', 'TWR', s.twr ? s.twr.toFixed(2) : '—', s.twr && s.twr < 1 ? 'red' : s.twr > 2.6 ? 'amber' : '', `Thrust-to-weight of the first burning stage on ${statBody().name}. Above 1 to lift off; 1.3–1.9 is comfortable.`),
      stat('size', 'Size', `${s.size.len.toFixed(1)} × ${s.size.wide.toFixed(1)} m`, '', 'Length along the nose axis × widest span'));
    clear(dom.check);
    const issues = [...v.errors.map(t => ['bad', t]), ...v.warnings.map(t => ['warn', t])];
    if (c.isEmpty) dom.check.appendChild(el('span', { class: 'bld-check dim', text: 'Pick a part from the bin to begin' }));
    else if (!issues.length) dom.check.appendChild(el('span', { class: 'bld-check ok' }, icon('check'), ed.site === 'runway' ? 'Ready for the runway' : 'Ready for the pad'));
    else {
      const [kind, text] = issues[0];
      dom.check.appendChild(el('span', { class: 'bld-check ' + kind, tip: issues.map(i => '• ' + i[1]).join('\n') }, bicon('warn'),
        el('span', { class: 'bld-check-text', text }), issues.length > 1 ? el('i', { text: '+' + (issues.length - 1) }) : null));
    }
    if (dom.funds) { dom.funds.textContent = fmt.num(career().funds); dom.fundsWrap.classList.toggle('short', !afford); }
    if (reportOpen) refreshReport(s);
    refreshLoads();
  }
  // ---- structure: the worst joint of the design, and the list of the five most loaded (builder/loads.js)
  function loadBar(row) {
    return el('span', { class: 'bld-ld-bar ' + (row ? row.level : '') + (row && row.util >= 1 ? ' over' : '') }, el('i', { style: { width: ((row ? row.fill : 0) * 100).toFixed(1) + '%' } }));
  }
  const focusOn = { enter: row => () => ed.setLoadFocus(row), leave: () => ed.setLoadFocus(null) };
  function refreshLoads() {
    if (!dom.struct) return;
    const rep = ed.loads, c = craft(), stale = ed.loadsStale, w = rep && !rep.empty && !c.isEmpty ? rep.worst : null;
    clear(dom.struct);
    dom.struct.className = 'bld-struct ' + (w ? w.level : 'none') + (stale ? ' stale' : '') + (loadsOpen ? ' open' : '');
    dom.struct.dataset.level = w ? w.level : '';
    dom.struct.disabled = !w;
    dom.struct.append(el('span', { class: 'sw-label', text: 'Structure' }), loadBar(w));
    if (!w) {
      dom.struct.append(el('b', { class: 'bld-struct-pct', text: '--' }),
        el('span', { class: 'bld-struct-text', text: c.isEmpty ? '' : c.parts.length < 2 ? 'Joint loads show here once two parts are joined' : 'No joint loads to report' }));
      if (loadsOpen) toggleLoadsList(false);
    } else {
      dom.struct.append(el('b', { class: 'bld-struct-pct', text: w.percent }),
        el('span', { class: 'bld-struct-text' }, el('span', { text: w.where + (w.n > 1 ? ' ×' + w.n : '') + ': ' }), `${w.words} ${w.when}`,
          w.braced ? el('em', { class: 'bld-braced', text: 'braced' }) : null,
          w.verdict ? el('strong', { text: ' – ' + w.verdict }) : null),
        el('span', { class: 'bld-struct-more' }, `${rep.count} joint${rep.count === 1 ? '' : 's'}`, bicon('chevron')));
    }
    if (loadsOpen) refreshLoadsList();
  }
  function refreshLoadsList() {
    const rep = ed.loads;
    clear(dom.loadsBody);
    dom.loadsPanel.classList.toggle('stale', !!ed.loadsStale);
    if (!rep || rep.empty) { dom.loadsBody.appendChild(el('div', { class: 'sw-empty', text: 'No joints to report on yet.' })); return; }
    const rows = rep.rows.map(r => {
      const row = el('button', { class: 'bld-ld-row ' + r.level + (ed.loadFocus === r ? ' pinned' : ''), attrs: { type: 'button', 'data-level': r.level, 'aria-label': r.text }, tip: r.text,
        on: { mouseenter: focusOn.enter(r), mouseleave: focusOn.leave,
          click: () => { ed.setLoadFocus(r, { pin: true }); rows.forEach((n, i) => n.classList.toggle('pinned', ed.loadFocus === rep.rows[i])); } } },
        loadBar(r), el('b', { class: 'bld-struct-pct', text: r.percent }),
        el('span', { class: 'bld-ld-text' },
          el('span', { class: 'bld-ld-where' }, r.where + (r.n > 1 ? ' ×' + r.n : ''), r.braced ? el('em', { class: 'bld-braced', tip: 'A brace strut shares the load of this joint', text: 'braced' }) : null),
          el('small', {}, `${r.words} ${r.when}`, r.verdict ? el('strong', { text: ' – ' + r.verdict }) : null)));
      return row;
    });
    dom.loadsBody.append(...rows);
    dom.loadsBody.appendChild(el('p', { class: 'bld-report-note', text: `Each joint at the worst moment of a reference climb from ${SYSTEM.home.name}: lift-off, full steering, a hard turn at 15° to the airflow at max Q, burn-out, and the same after every staging. At 100 % a joint is at its strength; above that it breaks. Hover a row to see the joint, click to look at it.` }));
  }
  function toggleLoadsList(on = !loadsOpen) {
    if (on && (!ed.loads || ed.loads.empty)) on = false;
    loadsOpen = on;
    if (on && reportOpen) toggleReport(false);
    dom.loadsPanel.classList.toggle('sw-hidden', !on);
    dom.struct.classList.toggle('open', on);
    dom.struct.setAttribute('aria-expanded', on ? 'true' : 'false');
    if (on) refreshLoadsList(); else ed.setLoadFocus(null, { force: true });
  }
  function refreshReport(s = summary()) {
    clear(dom.reportBody);
    const n = craft().stages.length;
    if (!s.stats.length) { dom.reportBody.appendChild(el('div', { class: 'sw-empty', text: 'No stages to report on yet.' })); return; }
    const rows = [];
    for (let i = n - 1; i >= 0; i--) {
      const x = s.stats[i]; if (!x) continue;
      const burn = x.thrust > 0 && x.dvVac > 0.5;
      rows.push(el('tr', {},
        el('td', {}, el('span', { class: 'bld-stage-num small', text: String(n - 1 - i) })),
        el('td', { class: 'num', text: burn ? fmt.num(x.dvVac) : '—' }), el('td', { class: 'num', text: burn ? fmt.num(x.dvAtm) : '—' }),
        el('td', { class: 'num', text: burn ? x.twrVac.toFixed(2) : '—' }), el('td', { class: 'num', text: burn ? x.twrAtm.toFixed(2) : '—' }),
        el('td', { class: 'num', text: burn ? fmt.time(x.burnTime) : '—' }),
        el('td', { class: 'num', text: burn ? fmt.num(x.thrust / 1000) : '—' }),
        el('td', { class: 'num', text: (x.startMass / 1000).toFixed(2) }), el('td', { class: 'num', text: (x.endMass / 1000).toFixed(2) })));
    }
    dom.reportBody.appendChild(el('table', { class: 'sw-table bld-report-table' },
      el('thead', {}, el('tr', {}, ['Stage', 'Δv vac', 'Δv sea lvl', 'TWR vac', 'TWR sea lvl', 'Burn', 'Thrust kN', 'Start t', 'End t'].map((h, i) => el('th', { class: i ? 'num' : '', text: h })))),
      el('tbody', {}, rows),
      el('tfoot', {}, el('tr', {}, el('td', { text: 'Total' }), el('td', { class: 'num sw-teal', text: fmt.num(s.dvVac) }), el('td', { class: 'num', text: fmt.num(s.dvAtm) }),
        el('td', { attrs: { colspan: 4 } }), el('td', { class: 'num', text: (s.mass / 1000).toFixed(2) }), el('td', {})))));
    dom.reportBody.appendChild(el('p', { class: 'bld-report-note', text: `Δv in m/s with every engine at full throttle. TWR is against ${statBody().name} surface gravity. Stage 0 fires last.` }));
  }
  function toggleReport(on = !reportOpen) {
    reportOpen = on;
    if (on && loadsOpen) toggleLoadsList(false);
    dom.report.classList.toggle('sw-hidden', !on);
    dom.reportBtn.classList.toggle('active', on);
    if (on) refreshReport();
  }
  function refreshToolbar() {
    if (!dom.sym) return;
    const st = ed.state, mirror = st.symMode === 'mirror';
    clear(dom.sym); dom.sym.append(symIcon(st.symmetry, mirror && st.symmetry > 1), el('b', { text: mirror ? (st.symmetry > 1 ? 'M' : '×1') : '×' + st.symmetry }));
    dom.sym.classList.toggle('active', st.symmetry > 1);
    dom.sym.dataset.count = st.symmetry; dom.sym.dataset.mode = st.symMode;
    clear(dom.symMode); dom.symMode.append(bicon(mirror ? 'mirror' : 'radial')); dom.symMode.classList.toggle('active', mirror); dom.symMode.dataset.mode = st.symMode;
    dom.snap.classList.toggle('active', st.snap); dom.snap.dataset.on = st.snap ? '1' : '0';
    dom.loadsBtn.classList.toggle('active', !!st.show.loads); dom.loadsBtn.dataset.on = st.show.loads ? '1' : '0';
    if (dom.loadsSwitch) dom.loadsSwitch.classList.toggle('active', !!st.show.loads);
    for (const b of dom.tools.querySelectorAll('[data-tool]')) b.classList.toggle('active', b.dataset.tool === st.tool);
    if (dom.right) dom.right.classList.toggle('acting', st.tool === 'action');
    for (const b of dom.markers.querySelectorAll('[data-marker]')) b.classList.toggle('active', !!st.show[b.dataset.marker]);
    dom.undo.disabled = !ed.canUndo; dom.redo.disabled = !ed.canRedo;
  }
  function setStatus(text, kind = '') {
    const k = kind + '|' + (text || '');
    if (k === statusKey || !dom.status) return;
    statusKey = k;
    dom.status.className = 'bld-status ' + kind + (text ? '' : ' sw-hidden');
    dom.status.textContent = text || '';
  }
  function dismissHint(forever) {
    if (!dom.hint) return;
    dom.hint.remove(); dom.hint = null; hintGone = true; ed.hintDismissed();
    if (forever && career() && career().settings) career().settings.seenBuilderHint = true;
  }

  // ------------------------------------------------------------------ action groups (the '5' tool)
  const GROUPS = [...['1', '2', '3', '4', '5', '6', '7', '8', '9'].map(g => [g, g, `Custom group ${g}: the ${g} key in flight`]),
    ['gear', 'Gear', 'Landing gear and legs (G in flight). Empty = every leg and gear'], ['lights', 'Lights', 'Lamps (U in flight). Empty = every lamp'],
    ['brakes', 'Brakes', 'Wheel and air brakes (B in flight). Empty = every brake'], ['abort', 'Abort', 'The abort group. Empty = throttle to zero and engines off']];
  function refreshActions() {
    if (!dom.actGroups) return;
    const c = craft(), cur = ed.actionGroup;
    clear(dom.actGroups);
    for (const [g, label, tip] of GROUPS) {
      const n = c.groupActions(g).length;
      dom.actGroups.appendChild(el('button', { class: 'bld-act-group' + (g === cur ? ' active' : '') + (n ? ' has' : ''), attrs: { type: 'button', 'data-group': g, 'aria-label': 'Action group ' + label }, tip,
        on: { click: () => ed.setActionGroup(g) } }, el('b', { text: label }), n ? el('i', { text: String(n) }) : null));
    }
    // what the group does now
    clear(dom.actList);
    const rows = new Map();
    for (const a of c.groupActions(cur)) {
      const p = c.getPart(a.part); if (!p) continue;
      const k = p.type + ':' + (p.sym ? 's' + p.sym : 'p' + p.id) + ':' + a.action;
      if (!rows.has(k)) rows.set(k, { def: partDef(p.type), action: a.action, ids: [] });
      rows.get(k).ids.push(p.id);
    }
    const gl = (GROUPS.find(x => x[0] === cur) || [cur, cur])[1];
    dom.actListCap.textContent = rows.size ? `Group ${gl} does` : `Group ${gl} is empty`;
    for (const r of rows.values()) {
      const label = (c.actionsOf(r.ids[0]).find(x => x.id === r.action) || { label: r.action }).label;
      dom.actList.appendChild(el('div', { class: 'bld-act-row', data: { ids: r.ids.join(','), action: r.action },
        on: { mouseenter: () => ed.setHighlight(r.ids), mouseleave: () => ed.setHighlight(null), click: () => ed.selectPart(r.ids[0]) } },
        thumbCanvas(r.def, 'bld-chip-thumb'),
        el('span', { class: 'bld-act-text' }, el('b', { text: label }), el('small', { text: r.def.name + (r.ids.length > 1 ? ' ×' + r.ids.length : '') })),
        el('button', { class: 'bld-act-x', text: '×', attrs: { type: 'button', 'aria-label': 'Remove from the group', 'data-action': 'act-remove' }, tip: 'Take this out of the group',
          on: { click: e => { e.stopPropagation(); ed.setHighlight(null); ed.unbindAction(cur, r.ids[0], r.action); } } })));
    }
    if (!rows.size) dom.actList.appendChild(el('div', { class: 'sw-empty', text: ['gear', 'lights', 'brakes', 'abort'].includes(cur) ? 'Nothing chosen: this group keeps its usual job. Add parts to make it do exactly what you want.' : 'Click a part in the hall, then choose what this group does with it.' }));
    // the selected part
    clear(dom.actPart);
    const sel = ed.selected != null ? c.getPart(ed.selected) : null;
    if (!sel) { dom.actPart.appendChild(el('div', { class: 'bld-act-hint' }, bicon('place'), el('span', { text: c.isEmpty ? 'Build something first.' : 'Click a part in the hall to see what it can do.' }))); return; }
    const d = partDef(sel.type), n = c.symmetryGroup(sel).length, acts = c.actionsOf(sel.id);
    dom.actPart.appendChild(el('div', { class: 'bld-act-sel' }, thumbCanvas(d, 'bld-chip-thumb'), el('span', { class: 'bld-act-text' }, el('b', { text: d.name + (n > 1 ? ' ×' + n : '') }), el('small', { text: acts.length ? `Add to group ${gl}:` : 'This part has nothing to switch.' }))));
    const bound = new Set(c.groupActions(cur).filter(a => a.part === sel.id).map(a => a.action));
    for (const a of acts) {
      dom.actPart.appendChild(el('button', { class: 'sw-btn small bld-act-btn' + (bound.has(a.id) ? ' active' : ''), attrs: { type: 'button', 'data-act': a.id, 'aria-pressed': bound.has(a.id) ? 'true' : 'false' },
        on: { click: () => (bound.has(a.id) ? ed.unbindAction(cur, sel.id, a.id) : ed.bindAction(cur, sel.id, a.id)) } }, icon(bound.has(a.id) ? 'check' : 'plus'), a.label));
    }
  }

  // ------------------------------------------------------------------ dialogs
  const craftThumbs = new Map();
  function craftThumb(json, keyName) {
    if (json.thumb) return json.thumb;
    const k = keyName + ':' + (json.parts ? json.parts.length : 0);
    if (!craftThumbs.has(k)) { let url = ''; try { url = ed.thumbs ? ed.thumbs.craft(json, 200, 150, { horizontal: json.site === 'runway' }) : ''; } catch { url = ''; } craftThumbs.set(k, url); }
    return craftThumbs.get(k);
  }
  function craftRow(json, { stock = false, onLoad, onDelete }) {
    let c = null, missing = [];
    try { c = Craft.fromJSON(json); missing = [...new Set(c.parts.filter(p => !ed.unlocked(p.type)).map(p => partDef(p.type).name))]; } catch { c = null; }
    if (!c) return null;
    let dv = { vac: 0 }; try { dv = c.deltaV(); } catch { /* stats unavailable */ }
    const sub = missing.length ? 'Needs: ' + missing.slice(0, 3).join(', ') + (missing.length > 3 ? '…' : '')
      : `${c.parts.length} parts · ${(c.mass() / 1000).toFixed(1)} t · ${fmt.num(dv.vac)} m/s · ${c.stages.length} stage${c.stages.length === 1 ? '' : 's'}`;
    const url = craftThumb(json, (stock ? 's:' : 'u:') + c.name);
    const row = el('div', { class: 'bld-load-row' + (missing.length ? ' disabled' : ''), data: { craft: c.name, stock: stock ? '1' : '' } },
      el('div', { class: 'bld-load-pic' }, url ? el('img', { attrs: { src: url, alt: '', draggable: 'false' } }) : icon(stock ? 'star' : 'rocket'),
        el('span', { class: 'bld-load-tag ' + (json.site === 'runway' ? 'plane' : ''), text: json.site === 'runway' ? 'Runway' : 'Pad' })),
      el('div', { class: 'bld-load-text' },
        el('b', { text: c.name }), el('span', { class: 'sw-item-sub', text: sub }),
        json.desc ? el('p', { class: 'bld-load-desc', text: json.desc }) : null),
      el('div', { class: 'bld-load-side' },
        el('span', { class: 'sw-amber', text: fmt.funds(c.cost()) }),
        el('span', { class: 'bld-load-btns' },
          onDelete ? el('button', { class: 'sw-btn small ghost icon', attrs: { type: 'button', 'data-action': 'delete', 'aria-label': 'Delete ' + c.name }, tip: 'Delete this saved design',
            on: { click: e => { const b = e.currentTarget; if (b.dataset.armed) { onDelete(c.name); row.remove(); } else { b.dataset.armed = '1'; b.classList.remove('ghost', 'icon'); b.classList.add('danger'); b.textContent = 'Delete?'; setTimeout(() => { if (b.isConnected) { delete b.dataset.armed; b.classList.add('ghost', 'icon'); b.classList.remove('danger'); clear(b); b.appendChild(icon('trash')); } }, 2600); } } } }, icon('trash')) : null,
          el('button', { class: 'sw-btn small primary', text: 'Open', disabled: missing.length > 0, attrs: { type: 'button', 'data-action': 'open' }, on: { click: () => onLoad(c, json) } }))));
    return row;
  }
  function openLoadDialog() {
    ed.cancelHeld();
    let modal = null;
    const load = (c, json) => { modal.close(true); if (ed.loadCraft(json)) ed.toast(`Opened “${c.name}”.`, 'good'); };
    const crafts = career().crafts || {};
    const saved = Object.keys(crafts).filter(n => n !== AUTOSAVE).sort((a, b) => a.localeCompare(b));
    const savedList = el('div', { class: 'bld-load-list' });
    for (const n of saved) {
      const r = craftRow(crafts[n], { onLoad: load, onDelete: name => { career().deleteCraft(name); app.save(); if (savedList.querySelectorAll('.bld-load-row').length <= 1) savedList.appendChild(el('div', { class: 'sw-empty', text: 'No saved designs.' })); } });
      if (r) savedList.appendChild(r);
    }
    if (!savedList.children.length) savedList.appendChild(el('div', { class: 'sw-empty', text: 'No saved designs yet. Build something and press Save.' }));
    const stockList = el('div', { class: 'bld-load-list' });
    let stock = []; try { stock = stockCrafts(); } catch (err) { console.warn('[builder] stock designs unavailable:', err && err.message); }
    for (const c of stock) { const j = c.toJSON(); j.site = c.site || (typeof CRAFT_MOD.stockSite === 'function' ? CRAFT_MOD.stockSite(c) : 'pad'); if (c.desc) j.desc = c.desc; const r = craftRow(j, { stock: true, onLoad: load }); if (r) stockList.appendChild(r); }
    modal = showModal({
      title: 'Open a design', wide: true, class: 'bld-load',
      body: el('div', { class: 'bld-load-body' },
        el('div', { class: 'sw-label', text: 'Your designs' }), savedList,
        el('div', { class: 'sw-label', text: 'Starwright reference designs' }), stockList),
      buttons: [{ label: 'Close', value: null }],
    });
    return modal;
  }

  function openLaunchDialog() {
    ed.cancelHeld();
    const c = craft();
    if (c.isEmpty) { ed.toast('Build something first: pick a part from the bin.', 'warn'); return null; }
    c.name = (dom.name.value || '').trim() || c.name || 'Untitled Craft';
    const v = ed.checkCraft({ fresh: true }), s = summary();
    const errors = [...v.errors];
    if (!career().canAfford(s.cost)) errors.push(`Costs ${fmt.funds(s.cost)} but only ${fmt.funds(career().funds)} is available.`);
    const pods = c.parts.map(p => ({ p, d: partDef(p.type) })).filter(x => x.d.command === 'crew' && x.d.crew > 0);
    const seats = pods.reduce((n, x) => n + x.d.crew, 0);
    const hasProbe = c.parts.some(p => partDef(p.type).command === 'probe');
    const crewList = career().availableCrew();
    const selects = [];
    const crewNode = el('div', { class: 'bld-crew' });
    if (!seats) crewNode.appendChild(el('div', { class: 'sw-dim', text: hasProbe ? 'Uncrewed: flown by its probe core.' : 'No seats on this craft.' }));
    else {
      let seatNo = 0;
      for (const { d } of pods) {
        const podNode = el('div', { class: 'bld-pod' }, el('div', { class: 'bld-pod-name' }, bicon('command'), el('span', { text: d.name })));
        for (let k = 0; k < d.crew; k++, seatNo++) {
          const i = seatNo;
          const face = el('span', { class: 'bld-seat-face' }, icon('crew'));
          const sel = el('select', { class: 'sw-input', attrs: { 'data-seat': i, 'aria-label': 'Seat ' + (i + 1) } },
            el('option', { value: '', text: '— empty seat —' }),
            crewList.map(m => el('option', { value: m.name, text: `${m.name} · ${m.trait}${m.flights ? ' · ' + m.flights + ' flight' + (m.flights > 1 ? 's' : '') : ''}` })));
          sel.value = crewList[i] ? crewList[i].name : '';
          const sync = () => face.classList.toggle('filled', !!sel.value);
          sel.addEventListener('change', () => { for (const o of selects) if (o !== sel && o.value && o.value === sel.value) { o.value = ''; o.dispatchEvent(new Event('sync')); } sync(); });
          sel.addEventListener('sync', sync); sync();
          selects.push(sel);
          podNode.appendChild(el('label', { class: 'bld-seat' }, face, el('span', { class: 'sw-label', text: 'Seat ' + (i + 1) }), sel));
        }
        crewNode.appendChild(podNode);
      }
      if (!crewList.length) crewNode.appendChild(el('div', { class: 'sw-msg warn', text: 'No Pips are available right now. Hire or recover crew at the Crew Quarters.' }));
    }
    const hasRunway = !!(SYSTEM.home && SYSTEM.home.sites && SYSTEM.home.sites.runway);
    let site = ed.site;
    const siteBtns = el('div', { class: 'bld-seg bld-site' }, [['pad', 'Launch pad'], ['runway', 'Runway']].map(([id, label]) =>
      el('button', { class: 'sw-btn small' + (id === site ? ' active' : ''), text: label, attrs: { type: 'button', 'data-site': id }, tip: id === 'runway' && !hasRunway ? 'The runway is still being surveyed; this build rolls out to the pad.' : null,
        on: { click: e => { site = id; for (const b of siteBtns.children) b.classList.toggle('active', b === e.currentTarget); } } })));
    const body = el('div', { class: 'bld-launch' },
      el('div', { class: 'bld-launch-issues' },
        errors.map(t => el('div', { class: 'sw-msg bad', text: t })),
        v.warnings.map(t => el('div', { class: 'sw-msg warn', text: t })),
        !errors.length && !v.warnings.length ? el('div', { class: 'sw-msg bld-ok', text: 'All pre-flight checks passed.' }) : null),
      el('dl', { class: 'sw-kv' },
        el('dt', { text: 'Mass at rollout' }), el('dd', { text: (s.mass / 1000).toFixed(2) + ' t' }),
        el('dt', { text: 'Delta-v (vacuum)' }), el('dd', { text: fmt.num(s.dvVac) + ' m/s' }),
        el('dt', { text: 'Liftoff TWR' }), el('dd', { text: s.twr ? s.twr.toFixed(2) : '—' }),
        el('dt', { text: 'Launch cost' }), el('dd', { text: ed.isCareer ? `${fmt.funds(s.cost)} of ${fmt.funds(career().funds)}` : fmt.funds(s.cost) + ' (not charged)' })),
      el('div', { class: 'bld-launch-row' }, el('div', { class: 'sw-label', text: 'Roll out to' }), siteBtns),
      el('div', { class: 'sw-label', text: 'Crew assignment' }), crewNode);
    const go = () => {
      const names = [...new Set(selects.map(x => x.value).filter(Boolean))];
      if (seats && !names.length && !hasProbe) { ed.toast('Assign at least one Pip, or add a probe core to fly it uncrewed.', 'warn'); return false; }
      return ed.launch(names, site) !== false;
    };
    return showModal({
      title: `Launch ${c.name}?`, body, class: 'bld-launch-modal',
      buttons: [{ label: 'Keep building', value: false },
        { label: v.warnings.length && !errors.length ? 'Launch anyway' : 'Launch', value: true, kind: 'primary', disabled: errors.length > 0, onClick: () => go() }],
    });
  }

  function openDescribe() {
    const ta = el('textarea', { class: 'sw-input bld-desc', value: ed.meta.desc || '', attrs: { rows: 4, maxlength: 400, placeholder: 'What is this craft for? Flight notes, staging reminders…', 'aria-label': 'Craft description' } });
    ta.value = ed.meta.desc || '';
    return showModal({
      title: 'Craft notes', class: 'bld-desc-modal',
      body: el('div', {}, el('div', { class: 'sw-label', text: craft().name }), ta),
      buttons: [{ label: 'Cancel', value: false }, { label: 'Keep', value: true, kind: 'primary', onClick: () => { ed.setDesc(ta.value.trim()); refreshToolbarMeta(); } }],
    });
  }
  function refreshToolbarMeta() { if (dom.descBtn) dom.descBtn.classList.toggle('active', !!ed.meta.desc); }

  // ------------------------------------------------------------------ build
  const plane = ed.site === 'runway';
  dom.name = el('input', { class: 'sw-input bld-name', value: craft().name, attrs: { type: 'text', maxlength: 40, spellcheck: 'false', 'aria-label': 'Craft name', placeholder: 'Craft name' },
    on: { input: () => ed.rename(dom.name.value.trim() || 'Untitled Craft'), keydown: e => { if (e.key === 'Enter' || e.key === 'Escape') dom.name.blur(); } } });
  dom.descBtn = btn('', bicon('note'), () => openDescribe(), { cls: 'icon', action: 'describe', tip: 'Craft notes and description' });
  dom.undo = btn('', bicon('undo'), () => ed.undo(), { cls: 'icon', action: 'undo', tip: 'Undo (⌘Z)' });
  dom.redo = btn('', bicon('redo'), () => ed.redo(), { cls: 'icon', action: 'redo', tip: 'Redo (⇧⌘Z)' });
  if (ed.isCareer) {
    dom.funds = el('span', { class: 'sw-value' });
    dom.fundsWrap = el('div', { class: 'sw-stat funds bld-funds', tip: 'Programme funds' }, (() => { const i = icon('funds'); i.style.color = 'var(--sw-amber)'; return i; })(), dom.funds);
  }
  const top = el('div', { class: 'sw-topbar bld-top' },
    btn('Space Centre', icon('back'), () => app.goto('hub'), { action: 'back', cls: 'bld-back', tip: 'Back to the space centre (your design is kept)' }),
    el('span', { class: 'sw-title big bld-title' }, bicon(plane ? 'plane' : 'engines'), el('span', { text: plane ? 'Spaceplane Hangar' : 'Vehicle Assembly' })),
    el('div', { class: 'bld-group bld-namebox' }, dom.name, dom.descBtn),
    el('div', { class: 'bld-group' },
      btn('New', bicon('fresh'), () => ed.newCraft(), { tip: 'Start an empty design' }),
      btn('Open', bicon('folder'), () => openLoadDialog(), { action: 'load', tip: 'Open a saved or reference design' }),
      btn('Save', icon('save'), () => ed.saveCraft(), { tip: 'Save this design to your programme' })),
    el('div', { class: 'bld-group' }, dom.undo, dom.redo),
    el('div', { class: 'sw-grow' }),
    dom.fundsWrap || null,
    el('button', { class: 'sw-btn primary bld-launch-btn', attrs: { type: 'button', 'data-action': 'launch' }, tip: plane ? 'Crew up and roll out to the runway' : 'Crew up and roll out to the pad', on: { click: () => openLaunchDialog() } }, icon('play'), 'Launch'));

  // tool strip
  const toolBtn = (id, ico, label, k) => el('button', { class: 'bld-tool', attrs: { type: 'button', 'data-tool': id, 'aria-label': label }, tip: `${label} (${k})`, on: { click: () => ed.setTool(id) } }, bicon(ico), el('i', { text: k }));
  dom.sym = el('button', { class: 'bld-tool bld-sym', attrs: { type: 'button', 'data-action': 'symmetry', 'aria-label': 'Symmetry' }, tip: 'Symmetry: X steps up, Shift+X down (right-click also steps down)',
    on: { click: e => ed.cycleSymmetry(e.shiftKey ? -1 : 1), contextmenu: e => { e.preventDefault(); ed.cycleSymmetry(-1); } } });
  dom.symMode = el('button', { class: 'bld-tool', attrs: { type: 'button', 'data-action': 'sym-mode', 'aria-label': 'Symmetry mode' }, tip: 'Radial or mirror symmetry (R)', on: { click: () => ed.toggleMirror() } });
  dom.snap = el('button', { class: 'bld-tool', attrs: { type: 'button', 'data-action': 'snap', 'aria-label': 'Angle snap' }, tip: 'Angle snap: 15° steps and tidy heights (C)', on: { click: () => ed.toggleSnap() } }, bicon('snap'), el('i', { text: 'C' }));
  dom.loadsBtn = el('button', { class: 'bld-tool bld-loads-btn', attrs: { type: 'button', 'data-action': 'loads', 'aria-label': 'Load overlay' }, tip: 'Load overlay: a band on every joint, coloured by how much of its strength it uses (L)', on: { click: () => ed.toggleLoads() } }, bicon('loads'), el('i', { text: 'L' }));
  dom.tools = el('div', { class: 'bld-tools', attrs: { role: 'toolbar', 'aria-label': 'Assembly tools' } },
    toolBtn('place', 'place', 'Place and pick up', '1'), toolBtn('move', 'move', 'Move / offset', '2'), toolBtn('rotate', 'rotate', 'Rotate', '3'), toolBtn('root', 'root', 'Re-root', '4'), toolBtn('action', 'action', 'Action groups', '5'),
    el('span', { class: 'bld-tools-sep' }), dom.sym, dom.symMode, dom.snap, el('span', { class: 'bld-tools-sep' }), dom.loadsBtn);

  // left: parts bin
  dom.search = el('input', { class: 'sw-input bld-search', attrs: { type: 'search', placeholder: 'Search parts', spellcheck: 'false', 'aria-label': 'Search parts' },
    on: { input: () => { ed.state.search = dom.search.value; refreshCatalogue(); }, keydown: e => { if (e.key === 'Escape') { dom.search.value = ''; ed.state.search = ''; refreshCatalogue(); dom.search.blur(); } } } });
  dom.sort = el('select', { class: 'sw-input bld-sort', attrs: { 'aria-label': 'Sort parts' }, on: { change: () => { ed.state.sort = dom.sort.value; refreshCatalogue(); } } },
    [['', 'Default'], ['name', 'Name'], ['cost', 'Cost'], ['mass', 'Mass'], ['size', 'Size']].map(([v, t]) => el('option', { value: v, text: t })));
  dom.sort.value = ed.state.sort || '';
  dom.cats = el('div', { class: 'bld-cats', attrs: { role: 'tablist' } }, cats().map(c => el('button', {
    class: 'bld-cat', attrs: { type: 'button', role: 'tab', 'data-cat': c.id, 'aria-label': c.name }, tip: c.name,
    on: { click: () => { ed.state.category = c.id; ed.state.search = ''; dom.search.value = ''; refreshCatalogue(); } },
  }, catIcon(c.id), el('span', { text: c.name }))));
  dom.catName = el('div', { class: 'bld-cat-name' });
  dom.grid = el('div', { class: 'bld-grid sw-scroll' });
  const left = el('div', { class: 'sw-panel glass pad-0 bld-left' },
    el('div', { class: 'bld-left-head' }, el('span', { class: 'bld-search-wrap' }, bicon('search'), dom.search), dom.sort),
    el('div', { class: 'bld-left-body' }, dom.cats, el('div', { class: 'bld-bin' }, dom.catName, dom.grid)));

  // right: staging stack
  dom.stages = el('div', { class: 'bld-stages sw-scroll' });
  dom.stageMode = el('span', { class: 'sw-chip teal', text: 'Auto' });
  dom.stageReset = el('button', { class: 'sw-btn small', text: 'Reset', attrs: { type: 'button', 'data-action': 'reset-staging' }, tip: 'Rebuild the stages automatically from the part tree', on: { click: () => ed.stageReset() } });
  dom.body = el('select', { class: 'sw-input bld-body', attrs: { 'aria-label': 'Reference body for delta-v and TWR' }, tip: 'Body whose gravity and air the numbers use', on: { change: () => { ed.state.body = dom.body.value; refreshStaging(); refreshInfo(); } } },
    SYSTEM.bodies.filter(b => b.type !== 'star' && !b.gas).map(b => el('option', { value: b.id, text: b.name })));
  dom.body.value = ed.state.body;
  dom.atmo = el('div', { class: 'bld-seg' },
    el('button', { class: 'sw-btn small', text: 'Vac', attrs: { type: 'button', 'data-atmo': '0' }, tip: 'Numbers in vacuum', on: { click: () => { ed.state.atmo = false; refreshStaging(); refreshInfo(); } } }),
    el('button', { class: 'sw-btn small', text: 'Sea', attrs: { type: 'button', 'data-atmo': '1' }, tip: 'Numbers at sea level of the chosen body', on: { click: () => { ed.state.atmo = true; refreshStaging(); refreshInfo(); } } }));
  dom.stageTotal = el('b', { class: 'bld-stage-total' });
  dom.actGroups = el('div', { class: 'bld-act-groups' });
  dom.actListCap = el('div', { class: 'sw-label bld-act-cap' });
  dom.actList = el('div', { class: 'bld-act-list sw-scroll' });
  dom.actPart = el('div', { class: 'bld-act-part' });
  const actions = el('div', { class: 'bld-actions', data: { panel: 'actions' } },
    el('div', { class: 'bld-right-head' }, el('span', { class: 'sw-title', text: 'Action groups' }), el('span', { class: 'sw-grow' }),
      el('button', { class: 'sw-btn small bld-act-done', text: 'Done', attrs: { type: 'button', 'data-action': 'act-done' }, tip: 'Back to building (1)', on: { click: () => ed.setTool('place') } })),
    dom.actGroups, dom.actListCap, dom.actList,
    el('div', { class: 'sw-label bld-act-cap', text: 'Selected part' }), dom.actPart,
    el('div', { class: 'bld-right-foot' }, el('span', { class: 'sw-grow' }),
      el('button', { class: 'sw-btn small', text: 'Clear group', attrs: { type: 'button', 'data-action': 'act-clear' }, tip: 'Empty the chosen group', on: { click: () => ed.clearActionGroup(ed.actionGroup) } })));
  const right = dom.right = el('div', { class: 'sw-panel glass pad-0 bld-right' }, actions,
    el('div', { class: 'bld-right-head' }, el('span', { class: 'sw-title', text: 'Staging' }), dom.stageMode, el('span', { class: 'sw-grow' }),
      el('button', { class: 'sw-btn small icon', attrs: { type: 'button', 'data-action': 'stage-add', 'aria-label': 'Add a stage' }, tip: 'Add an empty stage on top (fires last)', on: { click: () => ed.stageAdd(craft().stages.length) } }, icon('plus')),
      el('button', { class: 'sw-btn small icon', attrs: { type: 'button', 'data-action': 'stage-trim', 'aria-label': 'Remove empty stages' }, tip: 'Remove every empty stage', on: { click: () => ed.stageRemove(-1) } }, bicon('minus'))),
    el('div', { class: 'bld-right-opts' }, dom.body, dom.atmo),
    dom.stages,
    el('div', { class: 'bld-right-foot bld-stage-foot' }, el('span', { class: 'sw-label', text: 'Total Δv' }), dom.stageTotal, el('span', { class: 'sw-grow' }), dom.stageReset));

  // bottom: info bar + engineer's report
  dom.infoStats = el('div', { class: 'bld-stats' });
  dom.check = el('div', { class: 'bld-checks' });
  const markerBtn = (id, label, tip) => el('button', { class: 'bld-marker ' + id, attrs: { type: 'button', 'data-marker': id, 'aria-label': tip }, tip, on: { click: () => ed.toggleMarker(id) } }, el('i'), label);
  dom.markers = el('div', { class: 'bld-markers' }, markerBtn('com', 'CoM', 'Show the centre of mass'), markerBtn('cot', 'CoT', 'Show the centre of thrust'), markerBtn('col', 'CoL', 'Show the centre of lift (wings and fins)'));
  dom.reportBtn = el('button', { class: 'sw-btn small bld-report-btn', attrs: { type: 'button', 'data-action': 'report' }, tip: 'Engineer’s report: per-stage numbers', on: { click: () => toggleReport() } }, bicon('report'), el('span', { text: 'Report' }));
  dom.struct = el('button', { class: 'bld-struct none', attrs: { type: 'button', 'data-action': 'structure', 'aria-expanded': 'false' }, tip: 'Structure: the most loaded joint of this design. Click for the five most loaded.',
    on: { click: () => toggleLoadsList(), mouseenter: () => { const r = ed.loads; if (r && r.worst && !loadsOpen) ed.setLoadFocus(r.worst); }, mouseleave: () => { if (!loadsOpen) ed.setLoadFocus(null); } } });
  dom.info = el('div', { class: 'sw-panel glass pad-0 bld-info' }, dom.infoStats, dom.markers, dom.check, dom.reportBtn, dom.struct);
  dom.loadsBody = el('div', { class: 'bld-loads-body sw-scroll' });
  dom.loadsSwitch = el('button', { class: 'sw-btn small bld-loads-switch', attrs: { type: 'button', 'data-action': 'loads-overlay' }, tip: 'Show a band on every joint in the hall (L)', on: { click: () => ed.toggleLoads() } }, bicon('loads'), el('span', { text: 'Show on craft' }), key('L'));
  dom.loadsPanel = el('div', { class: 'sw-panel glass pad-0 bld-report bld-loads sw-hidden', data: { panel: 'loads' } },
    el('div', { class: 'bld-report-head' }, el('span', { class: 'sw-title', text: 'Most loaded joints' }), el('span', { class: 'sw-grow' }), dom.loadsSwitch,
      el('button', { class: 'sw-modal-x', text: '×', attrs: { type: 'button', 'aria-label': 'Close the list' }, on: { click: () => toggleLoadsList(false) } })),
    dom.loadsBody);
  dom.reportBody = el('div', { class: 'bld-report-body sw-scroll' });
  dom.report = el('div', { class: 'sw-panel glass pad-0 bld-report sw-hidden' },
    el('div', { class: 'bld-report-head' }, el('span', { class: 'sw-title', text: 'Engineer’s report' }), el('span', { class: 'sw-grow' }),
      el('button', { class: 'sw-modal-x', text: '×', attrs: { type: 'button', 'aria-label': 'Close report' }, on: { click: () => toggleReport(false) } })),
    dom.reportBody);
  dom.status = el('div', { class: 'bld-status sw-hidden', attrs: { role: 'status' } });

  if (ed.showHint) {
    dom.hint = el('div', { class: 'sw-panel glass bld-hint', attrs: { role: 'note' } },
      el('div', { class: 'bld-hint-head' }, el('span', { class: 'sw-title', text: plane ? 'Welcome to the spaceplane hangar' : 'Welcome to the assembly building' }),
        el('button', { class: 'sw-modal-x', text: '×', attrs: { type: 'button', 'aria-label': 'Dismiss', 'data-action': 'hint-close' }, on: { click: () => dismissHint(false) } })),
      el('ul', {},
        el('li', {}, el('b', { text: 'Click a part' }), ' in the bin, then ', el('b', { text: 'click in the hall' }), '. The first part hangs where you leave it; glowing ', el('b', { text: 'nodes' }), ' show where the next one snaps on, above or below.'),
        el('li', {}, 'Fins, wings and other surface parts stick anywhere on a ', el('b', { text: 'side' }), '. ', key('X'), ' steps symmetry, ', key('R'), ' switches radial / mirror, ', key('C'), ' toggles angle snap, ', key('Alt'), ' snaps to nodes only.'),
        el('li', {}, el('b', { text: 'Click a placed part' }), ' to pull it off with everything attached to it. Drop it on another node, or in mid-air to park it. ', key('Q'), key('E'), ' turn and ', key('W'), key('S'), ' flip or tilt the held part (', key('⇧'), ' for 5° steps).'),
        el('li', {}, key('1'), ' place · ', key('2'), ' move · ', key('3'), ' rotate · ', key('4'), ' re-root · ', key('5'), ' action groups. ', key('⌘'), key('Z'), ' undo, ', key('⌫'), ' delete, ', key('Esc'), ' cancel.'),
        el('li', {}, 'The ', el('b', { text: 'Structure' }), ' line at the bottom names the joint that works hardest; ', key('L'), ' paints every joint by its load.'),
        el('li', {}, el('b', { text: 'Right-drag' }), ' orbits, the ', el('b', { text: 'wheel' }), ' scrolls along the craft, ', key('⇧'), '+wheel zooms, ', el('b', { text: 'middle-drag' }), ' pans, double-click focuses a part, ', key('F'), ' frames the craft.')),
      el('div', { class: 'bld-hint-foot' },
        el('button', { class: 'sw-btn small ghost', text: 'Don’t show again', attrs: { type: 'button', 'data-action': 'hint-never' }, on: { click: () => { dismissHint(true); app.save(); } } }),
        el('button', { class: 'sw-btn small primary', text: 'Got it', attrs: { type: 'button', 'data-action': 'hint-ok' }, on: { click: () => dismissHint(false) } })));
  }

  const root = el('div', { class: 'bld' + (plane ? ' bld-plane' : ''), data: { screen: 'builder', site: ed.site } }, top,
    el('div', { class: 'bld-mid' }, left, dom.tools, right, dom.status, dom.report, dom.loadsPanel, dom.info, dom.hint || null));
  app.uiRoot.appendChild(root);
  if (!ed.state.category || !cats().some(c => c.id === ed.state.category)) ed.state.category = (cats()[0] || { id: 'command' }).id;
  refreshCatalogue(); refreshStaging(); refreshInfo(); refreshToolbar(); refreshToolbarMeta(); refreshActions();

  return {
    root, dom,
    refreshCatalogue, refreshCatalogueSelection, refreshStaging, refreshInfo, refreshToolbar, refreshMeta: refreshToolbarMeta,
    refreshActions, refreshLoads, toggleLoadsList,
    get loadsOpen() { return loadsOpen; },
    refreshAll() { refreshStaging(); refreshInfo(); refreshToolbar(); refreshToolbarMeta(); refreshActions(); },
    setName(n) { if (dom.name) dom.name.value = n; },
    get name() { return dom.name ? dom.name.value.trim() : ''; },
    focusName() { if (dom.name) dom.name.focus(); },
    setStatus, tick, dismissHint, toggleReport,
    get reportOpen() { return reportOpen; },
    get thumbsPending() { return thumbQueue.length; },
    openLoadDialog, openLaunchDialog, openDescribe,
    dispose() { disposed = true; if (sdrag && sdrag.ghost) sdrag.ghost.remove(); sdrag = null; root.remove(); thumbQueue = []; spin = null; },
  };
}
