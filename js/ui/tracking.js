// Starwright — Tracking Station: the 3D system map without an active vessel, plus flight management.
//
//   createTrackingScreen(app, { loadWorld }?) → screen { enter, exit, update, render, resize }
//
// Left: vessel list (filter by type) or the worlds browser, and the time-warp strip. Right: details of the selected
// vessel (situation, orbit, crew, resources) with Fly / Recover / Terminate, rename and re-type.
//
// The world is restored from app.career.flightState with World.fromJSON (js/core/world.js, imported lazily).
// With no saved flight — or if the world cannot be restored — the station still opens on a vessel-less
// stand-in world so the map of the Helion system stays browsable ("No flights in progress").
// `loadWorld` (optional, async () → world | null) replaces the default loader; tests use it.
//
// Time: nobody is at the controls here, so the station runs the world with NO active vessel (everything coasts on
// rails) and warp is free up to the top rate. Time is held while a craft is in atmospheric flight (it would be lost
// on rails). Warp stops by itself for alarms: a maneuver node coming up, or a craft changing sphere of influence.

import { el, clear, fmt, icon, isModalOpen } from './dom.js';
import { createMapView, situationText } from './mapview.js';
import { SYSTEM } from '../core/bodies.js';
import { ROLES, roleOf, roleName, iconElement, ROLE_COLORS } from './map/glyphs.js';

const TYPE_NAME = { ship: 'Vessel', debris: 'Debris', eva: 'Pip on EVA', flag: 'Flag' };
const FILTERS = ['ship', 'probe', 'lander', 'rover', 'plane', 'station', 'base', 'relay', 'eva', 'flag', 'debris'];
const RES = [['fuel', 'Fuel', '#ffb347', 'kg'], ['solid', 'Solid', '#e6c88a', 'kg'], ['mono', 'Mono', '#c9f27a', 'kg'], ['xenon', 'Xenon', '#b79cff', 'kg'], ['elec', 'Charge', '#6cc4ff', 'EC'], ['ablator', 'Ablator', '#c58a5c', 'kg']];
const NODE_LEAD = 60;                // s: warp stops this long before a planned burn
const DEG = Math.PI / 180;

function crewNames(app, vessel) {
  const f = app.careerModule && app.careerModule.crewOf;
  if (typeof f === 'function') { try { return f(vessel) || []; } catch { /* fall through */ } }
  if (Array.isArray(vessel.crew)) return [...vessel.crew];
  const out = [];
  const parts = vessel.parts instanceof Map ? vessel.parts.values() : (Array.isArray(vessel.parts) ? vessel.parts : []);
  for (const p of parts) if (p && !p.destroyed && Array.isArray(p.crew)) out.push(...p.crew);
  return out;
}
const flyable = v => v && !v.dead && (v.type === 'ship' || v.type === 'eva');

export function createTrackingScreen(app, options = {}) {
  let map = null, root = null, listBox = null, dateLine = null, countChip = null, detail = null, filterBox = null, warpUi = null, tabs = null;
  let world = null, selected = null, restored = false, token = 0;
  let tab = 'vessels';
  let flyId = null;                   // the vessel that was active when the station opened (handed back on save)
  let unsub = null, dirty = false, holdReason = '', lastHold = '', listKey = '', detailTimer = 0, renaming = false, detailShape = '';
  const hidden = new Set();           // filtered-out roles

  function standInWorld() {
    return { ut: (app.career && app.career.ut) || 0, vessels: [], active: null, warpTo() {}, switchTo() {} };
  }

  async function restoreWorld() {
    if (typeof options.loadWorld === 'function') return options.loadWorld();
    const state = app.career && app.career.flightState;
    if (!state) return null;
    try {
      const mod = await import('../core/world.js');
      if (mod.World && typeof mod.World.fromJSON === 'function') { const w = mod.World.fromJSON(state); if (w && app.career && app.career.limitOf) w.commGroundRange = app.career.limitOf('tracking'); return w; }
      console.warn('[tracking] js/core/world.js has no World.fromJSON');
    } catch (err) {
      console.warn('[tracking] could not restore the saved flight:', err && err.message);
    }
    return null;
  }

  const toast = (text, kind = 'info', ms) => { if (app.toast) app.toast(text, kind, ms); };
  const realWorld = () => !!world && typeof world.setWarp === 'function' && typeof world.step === 'function';

  // ------------------------------------------------------------------ persistence
  /** Write the world back to the career (same rule as the flight screen: nothing flyable left → no flight kept). */
  function persist() {
    const career = app.career;
    if (!career || !restored || !world) return;
    const keepActive = world.active;
    try {
      const back = (flyId != null && world.vessels.find(v => v.id === flyId && flyable(v))) || world.vessels.find(flyable) || null;
      world.active = back;
      const keep = world.vessels.some(flyable);
      career.flightState = keep && typeof world.toJSON === 'function' ? world.toJSON() : null;
      if (Number.isFinite(world.ut)) career.ut = Math.max(career.ut || 0, world.ut);
    } catch (err) { console.warn('[tracking] could not save the flight state:', err && err.message); }
    world.active = keepActive;
    dirty = false;
    if (typeof app.save === 'function') app.save();
  }

  // ------------------------------------------------------------------ selection and actions
  function select(v, focus = true) {
    selected = v || null;
    renaming = false;
    if (map) { map.setHighlight(selected); if (selected && focus) map.focus(selected); }
    renderList(true);
    renderDetail(true);
  }

  function fly(v) {
    if (!flyable(v)) return;
    if (realWorld() && world.warpIndex) world.setWarp(0);
    flyId = v.id;
    if (dirty) persist();
    app.goto('flight', { resume: true, vesselId: v.id });
  }

  const confirmFn = (...a) => (typeof app.confirm === 'function' ? app.confirm(...a) : Promise.resolve(window.confirm(a[0] + '\n\n' + a[1])));

  function afterRemoval(v) {
    if (world.active === v) world.active = null;
    if (flyId === v.id) flyId = null;
    persist();
    if (selected === v) select(world.vessels.find(x => x.type === 'ship') || null, false); else { renderList(true); renderDetail(true); }
  }

  async function terminate(v) {
    const crew = crewNames(app, v);
    const text = (v.name || 'This object') + ' will be removed for good.' +
      (crew.length ? ' Mission control will stand the crew down (' + crew.join(', ') + ') and return them to the roster.' : '');
    const yes = await confirmFn('Terminate ' + (TYPE_NAME[v.type] || 'flight').toLowerCase() + '?', text, { okLabel: 'Terminate', danger: true });
    if (!yes || !world) return;
    if (typeof world.removeVessel === 'function') world.removeVessel(v);
    const i = world.vessels.indexOf(v);
    if (i >= 0) world.vessels.splice(i, 1);
    const career = app.career;
    if (career && crew.length && typeof career.releaseCrew === 'function') career.releaseCrew(crew);
    toast((v.name || 'Object') + ' terminated.', 'info');
    afterRemoval(v);
  }

  const canRecover = v => !!v && !v.dead && v.landed && v.body === SYSTEM.home && v.situation !== 'prelaunch' && v.type !== 'flag' && typeof world.recover === 'function';

  async function recover(v) {
    if (!canRecover(v)) { toast('Recovery needs a craft landed or floating on ' + SYSTEM.home.name + '.', 'warn'); return; }
    const yes = await confirmFn('Recover ' + (v.name || 'this craft') + '?', 'The recovery team brings it home: parts value, stored science and the crew come back to the Flight Center.', { okLabel: 'Recover' });
    if (!yes || !world) return;
    const aboard = crewNames(app, v), cost = v.cost;
    let summary = null;
    try { summary = world.recover(v); } catch (err) { console.warn('[tracking] recover failed:', err && err.message); }
    if (!summary) { toast('Recovery is not possible right now.', 'warn'); return; }
    const career = app.career;
    const names = Array.isArray(summary.crew) ? summary.crew.slice() : aboard;
    let funds = 0, sci = 0;
    if (career) {
      try { if (typeof career.creditRecovery === 'function') funds = career.creditRecovery(summary.partsCost ?? cost, summary.distance || 0, names) || 0; } catch { funds = 0; }
      for (const r of summary.science || []) { try { if (typeof career.creditScience === 'function') sci += career.creditScience(r.experiment, r.bodyId, r.situation, 1, names) || 0; } catch { /* keep going */ } }
      try { if (typeof career.returnCrew === 'function') career.returnCrew(names); } catch { /* roster unchanged */ }
    }
    if (app.audio && app.audio.play) { try { app.audio.play('success'); } catch { /* optional */ } }
    const bits = [];
    if (funds && (!career || career.usesFunds !== false)) bits.push(fmt.funds(funds));
    if (sci) bits.push('+' + sci.toFixed(1) + ' science');
    if (names.length) bits.push(names.join(', ') + ' home safe');
    toast((summary.name || v.name || 'Craft') + ' recovered' + (bits.length ? ' · ' + bits.join(' · ') : '') + '.', 'good', 6000);
    afterRemoval(v);
  }

  function rename(v, name) {
    name = String(name || '').replace(/\s+/g, ' ').trim().slice(0, 40);
    renaming = false;
    if (name && name !== v.name) { v.name = name; dirty = true; persist(); }
    renderList(true); renderDetail(true);
  }
  function retype(v, role) {
    if (v.type !== 'ship' || !ROLES.some(r => r.id === role)) return;
    v.role = role; dirty = true; persist();
    renderList(true); renderDetail(true);
  }

  // ------------------------------------------------------------------ time
  const inAtmoFlight = v => !v.dead && !v.landed && v.type !== 'flag' && v.pos && v.body &&
    Math.hypot(v.pos.x, v.pos.y, v.pos.z) - v.body.radius < (v.body.atmo ? v.body.atmo.height : 0);

  function nextAlarm() {
    let t = Infinity, what = '';
    for (const v of world.vessels) {
      if (v.dead || v.type === 'debris' || !Array.isArray(v.nodes)) continue;
      for (const n of v.nodes) { const at = n.t - NODE_LEAD; if (at > world.ut + 1e-3 && at < t) { t = at; what = (v.name || 'A craft') + ': maneuver in ' + fmt.time(NODE_LEAD); } }
    }
    return { t, what };
  }

  function setWarp(i) {
    if (!realWorld()) return;
    if (holdReason) { toast(holdReason, 'warn'); return; }
    const top = (world.WARP_RATES || []).length - 1;
    world.setWarp(Math.max(0, Math.min(top, i)));
    renderWarp();
  }

  function stepWorld(dt) {
    if (!world || typeof world.step !== 'function') return;
    if (!realWorld()) { world.step(dt); return; }                 // test stand-ins: just let them tick
    const stuck = world.vessels.find(inAtmoFlight);
    holdReason = stuck ? 'Time is held: ' + (stuck.name || 'a craft') + ' is in atmospheric flight. Fly it first.' : '';
    if (holdReason) { if (world.warpIndex) world.setWarp(0); world.warpTarget = null; return; }
    const before = world.ut;
    const alarm = nextAlarm();
    const rate = world.rate || 1;
    let hit = false;
    if (world.warpTarget != null && alarm.t < world.warpTarget) world.warpTarget = alarm.t;
    if (world.warpTarget == null && world.warpIndex > 0 && before + rate * dt >= alarm.t) { dt = Math.max(1e-6, (alarm.t - before) / rate); hit = true; }
    const arriving = world.warpTarget;
    world.step(dt);
    if (hit || (arriving != null && world.warpTarget == null && Math.abs(arriving - alarm.t) < 1e-6 && world.ut >= alarm.t - 1e-3)) {
      world.setWarp(0);
      toast('Warp stopped · ' + alarm.what, 'warn', 6000);
      if (app.audio && app.audio.play) { try { app.audio.play('click'); } catch { /* optional */ } }
    }
    if (world.ut - before > 30) dirty = true;
  }

  function onWorldEvent(type, p) {
    const career = app.career;
    if (career && typeof career.onEvent === 'function') { try { career.onEvent(type, p, world); } catch (err) { console.warn('[tracking] career.onEvent failed for ' + type + ':', err && err.message); } }
    if (type === 'soi' && p.vessel && p.vessel.type !== 'debris') {
      if (world.warpIndex > 0 || world.warpTarget != null) { world.warpTarget = null; world.setWarp(0); }
      toast('Warp stopped · ' + (p.vessel.name || 'A craft') + ' entered the sphere of influence of ' + (p.to ? p.to.name : 'another world'), 'warn', 6000);
      dirty = true;
    } else if (type === 'crewLost' && p.name) toast(p.name + ' was lost.', 'bad', 6000);
    else if (type === 'message' && p.text && p.kind === 'removed') { toast(p.text, p.vessel && p.vessel.type === 'debris' ? 'info' : 'warn'); dirty = true; }
    else if (type === 'destroyed') dirty = true;
    else if (type === 'warp') renderWarp();
  }

  // ------------------------------------------------------------------ rendering: list
  function counts() {
    const c = {};
    for (const v of world ? world.vessels : []) { const r = roleOf(v); c[r] = (c[r] || 0) + 1; }
    return c;
  }

  function renderFilters() {
    if (!filterBox) return;
    clear(filterBox);
    const c = counts();
    const anyHidden = hidden.size > 0;
    filterBox.appendChild(el('button', { class: 'trk-filter all' + (anyHidden ? '' : ' on'), text: 'All', tip: 'Show every type', attrs: { type: 'button', 'data-filter': 'all' },
      on: { click: () => { hidden.clear(); renderList(true); } } }));
    for (const r of FILTERS) {
      if (!c[r]) continue;
      const b = el('button', { class: 'trk-filter' + (hidden.has(r) ? '' : ' on'), tip: roleName(r) + ' (' + c[r] + ') — click to show / hide, double-click to show only these',
        attrs: { type: 'button', 'data-filter': r, 'aria-pressed': hidden.has(r) ? 'false' : 'true', 'aria-label': roleName(r) },
        on: {
          click: () => { if (hidden.has(r)) hidden.delete(r); else hidden.add(r); renderList(true); },
          dblclick: () => { hidden.clear(); for (const o of FILTERS) if (o !== r) hidden.add(o); renderList(true); },
        } }, iconElement(r, ROLE_COLORS[r], 18), el('b', { text: String(c[r]) }));
      filterBox.appendChild(b);
    }
  }

  function vesselRow(v) {
    const role = roleOf(v), crew = crewNames(app, v);
    return el('div', { class: 'trk-item' + (v === selected ? ' active' : ''), data: { vessel: v.id, role }, attrs: { role: 'button', tabindex: '0' },
      on: { click: () => select(v), dblclick: () => { if (flyable(v)) fly(v); } } },
      iconElement(role, v === selected ? '#39d0c0' : ROLE_COLORS[role], 20),
      el('div', { class: 'trk-main' },
        el('div', { class: 'trk-name', text: v.name || 'Unnamed' }),
        el('div', { class: 'trk-sub', text: situationText(v) + (crew.length ? ' · Crew: ' + crew.join(', ') : v.type === 'ship' && role !== 'probe' && role !== 'relay' ? ' · No crew' : '') })),
      el('span', { class: 'trk-tag', text: roleName(role) }));
  }

  function bodyRows() {
    const out = [];
    const visited = new Set();
    const log = app.career && app.career.flightLog;
    if (log) for (const k in log) for (const key of ['visited', 'landedOn', 'orbited']) for (const id of (log[k] && log[k][key]) || []) visited.add(id);
    const here = {};
    for (const v of world ? world.vessels : []) if (v.type !== 'debris' && v.body) here[v.body.id] = (here[v.body.id] || 0) + 1;
    const walk = (b, depth) => {
      const focused = map && map.focusTarget === b;
      const sub = b.type === 'star' ? 'Star' : (b.type === 'moon' ? 'Moon' : b.gas ? 'Gas giant' : 'Planet') + ' · ' + fmt.dist(b.radius) + ' radius';
      out.push(el('div', { class: 'trk-item body l' + Math.min(depth, 2) + (focused ? ' active' : ''), data: { body: b.id }, attrs: { role: 'button', tabindex: '0' },
        on: { click: () => { if (map) { map.focus(b); map.select(b.type === 'star' ? null : b); } renderList(true); } } },
        el('span', { class: 'map-swatch', style: { background: '#' + (b.color >>> 0).toString(16).padStart(6, '0').slice(-6) } }),
        el('div', { class: 'trk-main' }, el('div', { class: 'trk-name', text: b.name }), el('div', { class: 'trk-sub', text: sub })),
        el('span', { class: 'trk-tag', text: here[b.id] ? here[b.id] + ' craft' : b === SYSTEM.home ? 'Home' : visited.has(b.id) ? 'Visited' : '' })));
      const kids = [...b.children].sort((p, q) => p.orbit.a - q.orbit.a);
      for (const c of kids) walk(c, depth + 1);
    };
    walk(SYSTEM.star, 0);
    return out;
  }

  function renderList(force) {
    if (!listBox) return;
    const vessels = world ? world.vessels : [];
    const key = tab + '|' + vessels.map(v => v.id + ':' + v.name + ':' + roleOf(v) + ':' + (v.situation || '') + ':' + (v.body ? v.body.id : '')).join(',') + '|' + (selected ? selected.id : '') + '|' + [...hidden].join() +
      '|' + (map && map.focusTarget ? map.focusTarget.id : '');
    if (!force && key === listKey) return;
    listKey = key;
    const scroll = listBox.scrollTop;
    clear(listBox);
    for (const t of tabs.children) t.classList.toggle('active', t.dataset.tab === tab);
    countChip.textContent = vessels.length ? vessels.length + (vessels.length === 1 ? ' object' : ' objects') : 'Idle';
    filterBox.classList.toggle('sw-hidden', tab !== 'vessels' || !vessels.length);
    if (tab === 'worlds') { for (const r of bodyRows()) listBox.appendChild(r); listBox.scrollTop = scroll; return; }
    renderFilters();
    if (!vessels.length) {
      listBox.appendChild(el('div', { class: 'trk-empty', data: { trk: 'empty' } },
        el('b', { text: 'No flights in progress' }),
        'Launch a rocket from the Assembly Hangar and it will show up here. The map of the Helion system is still open for browsing.'));
      return;
    }
    const order = { ship: 0, plane: 0, lander: 1, rover: 1, probe: 2, relay: 2, station: 3, base: 3, eva: 4, flag: 5, debris: 6 };
    const shown = vessels.filter(v => !hidden.has(roleOf(v))).sort((a, b) => (order[roleOf(a)] ?? 9) - (order[roleOf(b)] ?? 9));
    for (const v of shown) listBox.appendChild(vesselRow(v));
    if (!shown.length) listBox.appendChild(el('div', { class: 'trk-empty' }, el('b', { text: 'Nothing matches the filter' }), 'Press All to see every object again.'));
    listBox.scrollTop = scroll;
  }

  // ------------------------------------------------------------------ rendering: detail card
  function kvRow(box, k, v, cls) { box.appendChild(el('span', { text: k })); box.appendChild(el('b', { text: v, class: cls || '' })); }

  function renderDetail(force) {
    if (!detail) return;
    const v = selected;
    detail.classList.toggle('sw-hidden', !v);
    if (map && map.setInsets) map.setInsets({ right: v ? detailInset() : 12 });
    if (!v) return;
    if (!force && renaming) return;                                    // never rebuild under the caret
    const role = roleOf(v), crew = crewNames(app, v);
    // Live values are patched into the existing card; it is only rebuilt when its shape changes, so buttons stay
    // put under the pointer and a click can never land on an element that has just been replaced.
    const shape = [v.id, v.name, role, v.type, renaming ? 1 : 0, v.landed ? 1 : 0, v.body ? v.body.id : '', crew.join('+'), flyable(v) ? 1 : 0, canRecover(v) ? 1 : 0,
      Array.isArray(v.nodes) && v.nodes.length ? 1 : 0, v.launched ? 1 : 0, Array.isArray(v.science) ? v.science.length : 0].join('|');
    const live = !force && shape === detailShape && detail.children.length > 0;
    detailShape = shape;
    const card = detail;
    if (live) detail = document.createElement('div'); else clear(detail);
    try { fillDetail(v, role, crew); } finally {
      if (live) { const fresh = detail; detail = card; if (!patchText(card, fresh)) { clear(card); while (fresh.firstChild) card.appendChild(fresh.firstChild); } }
    }
  }

  /** Copies changed text and bar widths from `b` into `a` when both trees have the same shape. False if they differ. */
  function patchText(a, b) {
    if (a.tagName !== b.tagName || a.children.length !== b.children.length) return false;
    if (!a.children.length) {
      if (a.tagName !== 'CANVAS' && a.tagName !== 'INPUT' && a.textContent !== b.textContent) a.textContent = b.textContent;
      const sa = a.getAttribute('style'), sb = b.getAttribute('style');
      if (sa !== sb && a.tagName !== 'CANVAS') { if (sb == null) a.removeAttribute('style'); else a.setAttribute('style', sb); }
      return true;
    }
    for (let i = 0; i < a.children.length; i++) if (!patchText(a.children[i], b.children[i])) return false;
    return true;
  }

  function fillDetail(v, role, crew) {
    // header: icon, name (rename), type
    const head = el('div', { class: 'trk-d-head' }, iconElement(role, ROLE_COLORS[role], 24));
    if (renaming) {
      const field = el('input', { class: 'sw-input trk-rename', attrs: { type: 'text', maxlength: '40', 'data-trk': 'rename-field', 'aria-label': 'Vessel name' } });
      field.value = v.name || '';
      field.addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Enter') rename(v, field.value); else if (e.key === 'Escape') { renaming = false; renderDetail(true); } });
      field.addEventListener('blur', () => { if (renaming) rename(v, field.value); });
      head.appendChild(field);
      setTimeout(() => { try { field.focus(); field.select(); } catch { /* gone */ } }, 0);
    } else {
      head.appendChild(el('div', { class: 'trk-d-name', text: v.name || 'Unnamed', attrs: { 'data-trk': 'name' } }));
      head.appendChild(el('button', { class: 'sw-btn small ghost', text: 'Rename', tip: 'Give it another name', attrs: { type: 'button', 'data-action': 'rename' }, on: { click: () => { renaming = true; renderDetail(true); } } }));
    }
    detail.appendChild(head);
    detail.appendChild(el('div', { class: 'trk-d-sub', attrs: { 'data-trk': 'situation' }, text: roleName(role) + ' · ' + situationText(v) }));
    if (v.type === 'ship') {
      detail.appendChild(el('div', { class: 'trk-roles', attrs: { 'data-trk': 'roles' } }, ROLES.map(r => el('button', { class: 'trk-role' + (r.id === role ? ' on' : ''), tip: 'Mark as ' + r.name.toLowerCase(),
        attrs: { type: 'button', 'data-role': r.id, 'aria-label': r.name, 'aria-pressed': r.id === role ? 'true' : 'false' }, on: { click: () => retype(v, r.id) } }, iconElement(r.id, r.id === role ? '#39d0c0' : ROLE_COLORS[r.id], 18)))));
    }

    // flight
    const ut = world.ut;
    detail.appendChild(el('div', { class: 'trk-sec', text: v.landed ? 'Location' : 'Orbit' }));
    const kv = el('div', { class: 'trk-kv', attrs: { 'data-trk': 'orbit' } });
    if (v.landed) {
      kvRow(kv, 'World', v.body.name);
      try {
        const dir = v.surface && v.surface.dir ? v.surface.dir : null;
        if (dir && typeof v.body.latLon === 'function') {
          const ll = v.body.latLon(dir), la = ll.lat / DEG, lo = ll.lon / DEG;
          kvRow(kv, 'Position', Math.abs(la).toFixed(2) + '°' + (la >= 0 ? 'N' : 'S') + '  ' + Math.abs(lo).toFixed(2) + '°' + (lo >= 0 ? 'E' : 'W'));
          if (typeof v.body.biomeAt === 'function') kvRow(kv, 'Biome', v.body.biomeAt(dir).name);
        }
      } catch { /* no surface data */ }
    } else {
      let o = null; try { o = v.getOrbit(ut); } catch { o = null; }
      if (o) {
        const R = v.body.radius, r = v.pos ? Math.hypot(v.pos.x, v.pos.y, v.pos.z) : R;
        kvRow(kv, 'Altitude', fmt.dist(r - R));
        if (v.vel) kvRow(kv, 'Speed', fmt.speed(Math.hypot(v.vel.x, v.vel.y, v.vel.z)));
        kvRow(kv, 'Apoapsis', o.hyper ? 'Escape' : fmt.dist(o.apoapsis - R), 'ap');
        kvRow(kv, 'Periapsis', fmt.dist(o.periapsis - R), 'pe');
        kvRow(kv, 'Period', Number.isFinite(o.period) ? fmt.time(o.period) : '—');
        kvRow(kv, 'Inclination', (o.inclination / DEG).toFixed(2) + '°');
      }
    }
    if (Number.isFinite(v.launchUt) && v.launched) kvRow(kv, 'Mission time', fmt.time(Math.max(0, ut - v.launchUt)));
    if (Array.isArray(v.nodes) && v.nodes.length) kvRow(kv, 'Next maneuver', 'T−' + fmt.time(Math.max(0, v.nodes[0].t - ut)));
    detail.appendChild(kv);

    // craft
    if (v.type === 'ship') {
      detail.appendChild(el('div', { class: 'trk-sec', text: 'Craft' }));
      const ck = el('div', { class: 'trk-kv' });
      if (Number.isFinite(v.mass) && v.mass > 0) kvRow(ck, 'Mass', fmt.mass(v.mass));
      if (Number.isFinite(v.deltaV) && v.deltaV > 0) kvRow(ck, 'Δv left', fmt.num(v.deltaV, 0) + ' m/s');
      if (v.parts instanceof Map) kvRow(ck, 'Parts', String(v.parts.size));
      if (Array.isArray(v.science) && v.science.length) kvRow(ck, 'Science aboard', v.science.length + (v.science.length === 1 ? ' result' : ' results'));
      if (ck.children.length) detail.appendChild(ck); else detail.lastChild.remove();
      // resources
      let caps = null;
      try { caps = resourceTotals(v); } catch { caps = null; }
      if (caps && caps.length) {
        detail.appendChild(el('div', { class: 'trk-sec', text: 'Resources' }));
        const rb = el('div', { class: 'trk-res', attrs: { 'data-trk': 'resources' } });
        for (const r of caps) {
          rb.appendChild(el('span', { text: r.name }));
          rb.appendChild(el('div', { class: 'bar', style: { '--c': r.color } }, el('i', { style: { width: Math.round(100 * r.frac) + '%' } })));
          rb.appendChild(el('em', { text: Math.round(100 * r.frac) + '%' }));
        }
        detail.appendChild(rb);
      }
    }
    if (crew.length || (v.type === 'ship' && role !== 'probe' && role !== 'relay')) {
      detail.appendChild(el('div', { class: 'trk-sec', text: 'Crew' }));
      detail.appendChild(crew.length ? el('div', { class: 'trk-crew', attrs: { 'data-trk': 'crew' } }, crew.map(n => el('span', { class: 'sw-chip amber', text: n })))
        : el('div', { class: 'trk-note', attrs: { 'data-trk': 'crew' }, text: 'No crew aboard.' }));
    }

    // actions
    const fl = flyable(v), rec = canRecover(v);
    detail.appendChild(el('div', { class: 'trk-actions' },
      el('button', { class: 'sw-btn small primary', attrs: { type: 'button', 'data-action': 'fly' }, disabled: !fl, tip: fl ? 'Take control of this flight' : 'Nothing aboard to control', on: { click: () => fly(v) } }, 'Fly'),
      el('button', { class: 'sw-btn small', attrs: { type: 'button', 'data-action': 'recover' }, disabled: !rec, tip: rec ? 'Bring it home and bank its science' : 'Only for craft landed or floating on ' + SYSTEM.home.name, on: { click: () => recover(v) } }, 'Recover'),
      el('button', { class: 'sw-btn small danger', attrs: { type: 'button', 'data-action': 'terminate' }, tip: 'Remove it from the tracking station', on: { click: () => terminate(v) } }, 'Terminate')));
  }

  /** Amounts left as fractions of capacity, from the live resource table or the parts themselves. */
  function resourceTotals(v) {
    const have = {}, cap = {};
    if (v.parts instanceof Map) {
      for (const p of v.parts.values()) {
        const def = p && p.def; if (!def || !def.res) continue;
        for (const k in def.res) { cap[k] = (cap[k] || 0) + def.res[k]; have[k] = (have[k] || 0) + ((p.res && p.res[k]) || 0); }
      }
    }
    const out = [];
    for (const [id, name, color] of RES) if (cap[id] > 0) out.push({ id, name, color, frac: Math.max(0, Math.min(1, have[id] / cap[id])) });
    return out;
  }

  // ------------------------------------------------------------------ rendering: warp strip
  function renderWarp() {
    if (!warpUi) return;
    const real = realWorld();
    warpUi.box.classList.toggle('sw-hidden', !real);
    if (!real) return;
    const rates = world.WARP_RATES || [1], idx = world.warpIndex || 0;
    if (warpUi.pips.children.length !== rates.length) { clear(warpUi.pips); for (let i = 0; i < rates.length; i++) warpUi.pips.appendChild(el('i')); }
    for (let i = 0; i < rates.length; i++) warpUi.pips.children[i].classList.toggle('on', !holdReason && i <= idx);
    const txt = holdReason ? 'HELD' : rates[idx].toLocaleString('en-US') + '×';
    if (warpUi.rate.textContent !== txt) warpUi.rate.textContent = txt;
    warpUi.rate.classList.toggle('paused', !!holdReason);
    warpUi.box.title = holdReason || 'Time warp (, and . keys; / for 1×). Warp stops for maneuver nodes and sphere-of-influence changes.';
  }

  function buildDom() {
    listBox = el('div', { class: 'sw-scroll trk-list', data: { trk: 'list' } });
    dateLine = el('div', { class: 'trk-date' });
    countChip = el('span', { class: 'sw-chip teal', text: '' });
    filterBox = el('div', { class: 'trk-filters', data: { trk: 'filters' } });
    const mkTab = (id, text) => el('button', { class: 'trk-tab', text, attrs: { type: 'button', 'data-tab': id }, on: { click: () => { tab = id; renderList(true); } } });
    tabs = el('div', { class: 'trk-tabs' }, mkTab('vessels', 'Flights'), mkTab('worlds', 'Worlds'));
    warpUi = {
      pips: el('div', { class: 'trk-pips' }), rate: el('span', { class: 'trk-rate', text: '1×', attrs: { 'data-trk': 'rate' } }),
    };
    warpUi.box = el('div', { class: 'trk-warp sw-hidden', data: { trk: 'warp' } },
      el('button', { class: 'sw-btn small', text: '◂', tip: 'Slower (,)', attrs: { type: 'button', 'data-action': 'warp-down', 'aria-label': 'Slower' }, on: { click: () => setWarp((world.warpIndex || 0) - 1) } }),
      el('button', { class: 'sw-btn small', text: '1×', tip: 'Back to real time (/)', attrs: { type: 'button', 'data-action': 'warp-stop' }, on: { click: () => { if (realWorld()) { world.warpTarget = null; world.setWarp(0); renderWarp(); } } } }),
      el('button', { class: 'sw-btn small', text: '▸', tip: 'Faster (.)', attrs: { type: 'button', 'data-action': 'warp-up', 'aria-label': 'Faster' }, on: { click: () => setWarp((world.warpIndex || 0) + 1) } }),
      warpUi.pips, warpUi.rate);
    detail = el('div', { class: 'trk-detail sw-panel sw-hidden', data: { trk: 'detail' }, attrs: { 'data-map-avoid': '' } });   // the map keeps its labels clear of this card
    root = el('div', { class: 'trk-root', data: { screen: 'tracking' } },
      el('div', { class: 'trk-side sw-panel', attrs: { 'data-map-avoid': '' } },
        el('div', { class: 'trk-head' }, icon('dish'), el('span', { class: 'sw-title', text: 'Tracking Station' })),
        el('div', { class: 'sw-row' }, dateLine, el('span', { class: 'sw-grow' }), countChip), tabs, filterBox, listBox, warpUi.box,
        el('button', { class: 'sw-btn', attrs: { type: 'button', 'data-action': 'back' }, tip: 'Back to the Flight Center (Esc)', on: { click: () => app.goto('hub') } },
          icon('back'), 'Back to the Flight Center')),
      detail);
  }

  // panel widths mirror css/map.css (the stylesheet may still be loading when the screen opens)
  const narrow = () => (app.size && app.size.w ? app.size.w : window.innerWidth) <= 1100;
  function sideInset() { return (narrow() ? 256 : 292) + 20; }
  function detailInset() { return (narrow() ? 236 : 264) + 20; }

  return {
    is3D: true,
    capturesKeys: true,
    get map() { return map; },          // test hook: the map view (debug(), root)

    async enter() {
      const my = ++token;
      world = standInWorld(); restored = false; selected = null; flyId = null; dirty = false; holdReason = ''; lastHold = ''; listKey = ''; tab = 'vessels'; hidden.clear();
      buildDom();
      app.uiRoot.appendChild(root);
      map = createMapView(app, { getWorld: () => world, allowNodes: false, insets: { left: sideInset(), top: 10, bottom: 10, right: 12 }, focusActiveOnEnter: false, orbitPanel: false });
      map.enter();
      renderList(true); renderWarp();
      let loaded = null;
      try { loaded = await restoreWorld(); } catch (err) { console.warn('[tracking] world loader failed:', err && err.message); }
      if (my !== token || !map) return;                 // left the screen while loading
      if (loaded && Array.isArray(loaded.vessels)) {
        world = loaded; restored = true;
        const first = world.active || world.vessels.find(v => v.type === 'ship') || null;
        if (realWorld()) {
          // nobody flies from here: everything coasts, warp is free
          flyId = world.active ? world.active.id : null;
          world.active = null; world.warpTarget = null;
          if (world.warpIndex) world.setWarp(0);
          if (typeof world.on === 'function') unsub = world.on('*', (data, type) => onWorldEvent(type, data || {}));
        }
        if (first) select(first, true); else renderList(true);
        renderWarp();
      }
    },

    exit() {
      token++;
      if (world && restored && realWorld()) {
        try { if (world.warpIndex) world.setWarp(0); world.warpTarget = null; if (dirty) persist(); } catch (err) { console.warn('[tracking] could not save on exit:', err && err.message); }
      }
      if (unsub) { try { unsub(); } catch { /* old world */ } unsub = null; }
      if (map) { map.dispose(); map = null; }
      if (root) { root.remove(); root = null; }
      listBox = null; detail = null; filterBox = null; warpUi = null; tabs = null; world = null; selected = null;
    },

    update(dt) {
      if (!map) return;
      const inp = app.input;
      const typing = document.activeElement && /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName);
      if (inp && !isModalOpen() && !typing) {
        if (inp.pressed('Escape')) { app.goto('hub'); return; }
        if (realWorld()) {
          if (inp.pressed('Period')) setWarp((world.warpIndex || 0) + 1);
          if (inp.pressed('Comma')) setWarp((world.warpIndex || 0) - 1);
          if (inp.pressed('Slash')) { world.warpTarget = null; world.setWarp(0); renderWarp(); }
        }
      }
      if (!isModalOpen()) stepWorld(dt);
      if (selected && world && (!world.vessels.includes(selected) || selected.dead)) select(world.vessels.find(x => x.type === 'ship') || null, false);
      // a marker clicked in the map selects the vessel here
      const ms = map.selection;
      if (ms && world.vessels.includes(ms)) { map.select(null); if (ms !== selected) { tab = 'vessels'; select(ms, false); } }
      if (dateLine) { const t = fmt.date(world ? world.ut : 0); if (dateLine.textContent !== t) dateLine.textContent = t; }
      if (holdReason !== lastHold) { lastHold = holdReason; renderWarp(); }
      detailTimer -= dt;
      if (detailTimer <= 0) { detailTimer = 0.5; renderList(false); renderDetail(false); renderWarp(); }
      map.update(dt);
    },

    render() { if (map) map.render(); },
    resize(w, h) { if (map) { if (map.setInsets) map.setInsets({ left: sideInset(), right: selected ? detailInset() : 12 }); map.resize(w, h); } },

    // for tests / other screens
    get world() { return world; },
    get map() { return map; },
    get selected() { return selected; },
    select, setWarp,
  };
}
