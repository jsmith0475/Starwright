// Starwright — orbital map view.
//
//   const map = createMapView(app, { getWorld, allowNodes = true, insets = {top,left,right,bottom}, hints = true })
//   map.enter() / map.exit()          show / hide (DOM, listeners and drags are cleaned up on exit)
//   map.update(dt) / map.render()     call BOTH every frame while the map is open
//   map.resize(w, h)                  CSS pixels
//   map.isOpen                        bool
//   map.focus(bodyOrVesselOrBodyId)   smooth camera move
//   map.focusInner()                  the star, framed for the home world and its neighbours (the "Inner" button)
//   map.planTransfer()                the "Plan burn" button of the transfer panel: asks js/core/autopilot.js
//                                     (planHohmannToMoon / planInterplanetary) for the departure burn and adds the node
//   map.setHighlight(vessel|null)     which vessel gets the full trajectory treatment (default: world.active)
//   map.pruneNodes()                  drop maneuver nodes of the active vessel that are in the past → count removed
//   map.selectNode(node|null), map.selectedNode, map.screenPointAtTime(t, chain), map.debug()
//   map.select(vesselOrBody|null), map.selection      the clicked marker shown in the selection panel
//   map.dispose()
//
// Targeting (round 2): a plain click on a vessel / body marker selects it; its panel offers "Set as target", which
// calls world.setTarget(world.active, obj) (fallback: active.targetId = obj.id). The target is read back with
// world.getTarget(active) (fallback: targetId lookup). The target's orbit is drawn in orchid and, for a vessel
// target around the same body (or a body target whose SOI the trajectory does not enter), a "Closest approach"
// marker is placed on the current and on every planned trajectory.
//
// The map never owns the simulation. It reads `getWorld()`:
//   world.ut, world.vessels[] { id, name, type, body, pos, vel, landed, getOrbit(ut), nodes[], maxThrust?, mass? },
//   world.active, world.warpTo(ut), world.switchTo(vessel)   (switchTo is not called by the map itself)
//
// Rendering: bodies, SOI shells and the starfield are three.js objects in a floating-origin scene (origin = the
// focus point, 1 scene unit = the current camera distance, so numbers stay small from 1 km to 1e11 m).
// Orbit lines, trajectories and marker glyphs are drawn on a 2D canvas overlay from double-precision
// projections (crisp at any device pixel ratio, adaptive tessellation, hidden behind bodies); labels, the
// maneuver gizmo handles and the panels are DOM.

import * as THREE from '../lib/three.module.min.js';
import * as GFX from '../render/planetgfx.js';
import { SYSTEM } from '../core/bodies.js';
import { predictPatches, applyManeuver, maneuverBasis } from '../core/trajectory.js';
import * as AUTOPILOT from '../core/autopilot.js';
import { EXPERIMENTS, SITUATIONS } from '../core/career.js';
import { el, clear, fmt, uiScale } from './dom.js';
import { relativeNodes, findApproaches, transferFor } from './map/planning.js';
import { drawIcon, roleOf, roleName, ROLE_COLORS } from './map/glyphs.js';
import { createSky } from './map/sky.js';

const TAU = Math.PI * 2;
const FOV = 45;
const DEG = Math.PI / 180;
let MAX_DIST = 6e11;
for (const b of SYSTEM.bodies) if (b.orbit && b.parent === SYSTEM.star && Number.isFinite(b.orbit.apoapsis)) MAX_DIST = Math.max(MAX_DIST, b.orbit.apoapsis * 7);
const BASE_COLORS = ['#39d0c0', '#ffb347', '#b79cff', '#6cb6ff'];
const TARGET_COLOR = '#e879f9';
const PLAN_COLORS = [['#ffb347', '#ffd58f', '#ff9a5c'], ['#ff7eb6', '#ffb0d2', '#d98cff'], ['#c9f27a', '#e3f7b5', '#9fe0a0']];
const AXES = [
  { axis: 'prograde', sign: 1, name: 'Prograde', cls: 'pro' }, { axis: 'prograde', sign: -1, name: 'Retrograde', cls: 'pro neg' },
  { axis: 'normal', sign: 1, name: 'Normal', cls: 'nrm' }, { axis: 'normal', sign: -1, name: 'Anti-normal', cls: 'nrm neg' },
  { axis: 'radial', sign: 1, name: 'Radial out', cls: 'rad' }, { axis: 'radial', sign: -1, name: 'Radial in', cls: 'rad neg' },
];

let cssInjected = false;
function injectCss() {
  if (cssInjected || typeof document === 'undefined') return;
  cssInjected = true;
  if (document.querySelector('link[data-sw-map-css]')) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = new URL('../../css/map.css', import.meta.url).href;
  link.setAttribute('data-sw-map-css', '1');
  document.head.appendChild(link);
}

const hex = c => '#' + (c >>> 0).toString(16).padStart(6, '0').slice(-6);
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const sstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const isBody = o => !!o && typeof o.globalPosAt === 'function';

// ------------------------------------------------------------------------------------------------ conic helpers

function meanOf(o, A) { return o.hyper ? o.e * Math.sinh(A) - A : A - o.e * Math.sin(A); }

/** Point of the conic at eccentric / hyperbolic anomaly A, relative to the focus body. */
function conicPoint(o, A, out) {
  let x, y;
  if (!o.hyper) { x = o.rp - o.a * (1 - Math.cos(A)); y = o.b * Math.sin(A); }
  else { x = o.rp + o.a * (Math.cosh(A) - 1); y = o.b * Math.sinh(A); }
  const P = o.P, Q = o.Q;
  out[0] = P.x * x + Q.x * y; out[1] = P.y * x + Q.y * y; out[2] = P.z * x + Q.z * y;
  return out;
}
function conicRadius(o, A) { return o.hyper ? o.rp - o.a * o.e * (Math.cosh(A) - 1) : o.rp + o.a * o.e * (1 - Math.cos(A)); }

/** A drawable piece of trajectory: one patch, parameterised by an unwrapped anomaly range [A0, A1]. */
function makeCurve(patch) {
  const o = patch.orbit;
  const c = { patch, o, body: patch.body, A0: o.anomalyAt(patch.tStart), A1: 0, full: false, M0: 0 };
  c.M0 = meanOf(o, c.A0);
  if (Number.isFinite(patch.tEnd)) c.A1 = Math.max(c.A0, curveAnomaly(c, patch.tEnd));
  else if (!o.hyper) { c.A1 = c.A0 + TAU; c.full = true; }
  else {
    const rCap = Math.max(conicRadius(o, c.A0) * 30, o.rp * 60);
    c.A1 = Math.max(c.A0, Math.acosh(1 + (rCap - o.rp) / (Math.abs(o.a) * o.e)));
  }
  return c;
}
function curveTime(c, A) { return c.patch.tStart + (meanOf(c.o, A) - c.M0) / c.o.n; }
/** Unwrapped anomaly of the curve at time t (counts whole revolutions for closed orbits). */
function curveAnomaly(c, t) {
  const o = c.o, Aw = o.anomalyAt(t);
  if (o.hyper) return Aw;
  const Mu = c.M0 + o.n * (t - c.patch.tStart);
  return Aw + TAU * Math.round((Mu - meanOf(o, Aw)) / TAU);
}

function nodesSignature(nodes) {
  let s = '';
  for (const n of nodes) s += n.t.toFixed(2) + ':' + (n.dv.prograde || 0).toFixed(3) + ',' + (n.dv.normal || 0).toFixed(3) + ',' + (n.dv.radial || 0).toFixed(3) + ';';
  return s;
}
const SVG_HEAD = '<svg viewBox="-12 -12 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">';
const HANDLE_SVG = {
  'prograde+': SVG_HEAD + '<circle r="5"/><circle r="1.2" fill="currentColor" stroke="none"/><path d="M0-5V-9.5M-5 0H-9.5M5 0H9.5"/></svg>',
  'prograde-': SVG_HEAD + '<circle r="5"/><path d="M-3.4-3.4 3.4 3.4M3.4-3.4-3.4 3.4M0-5V-9.5M-4.3 2.6-8.2 4.9M4.3 2.6 8.2 4.9"/></svg>',
  'normal+': SVG_HEAD + '<path d="M0-8 7.4 5.2H-7.4Z"/><circle cy="0.8" r="1.2" fill="currentColor" stroke="none"/></svg>',
  'normal-': SVG_HEAD + '<path d="M0 8 7.4-5.2H-7.4Z"/><path d="M0 8V10.5M7.4-5.2 9.6-6.6M-7.4-5.2-9.6-6.6"/></svg>',
  'radial+': SVG_HEAD + '<circle r="4.6"/><circle r="1.2" fill="currentColor" stroke="none"/><path d="M3.3-3.3 7-7M-3.3-3.3-7-7M3.3 3.3 7 7M-3.3 3.3-7 7"/></svg>',
  'radial-': SVG_HEAD + '<circle r="6.2"/><path d="M4.4-4.4 1.8-1.8M-4.4-4.4-1.8-1.8M4.4 4.4 1.8 1.8M-4.4 4.4-1.8 1.8"/></svg>',
};
const SITUATION = { prelaunch: 'On the pad at', landed: 'Landed on', splashed: 'Splashed down on', flying: 'Flying over', suborbital: 'Suborbital over', orbit: 'Orbiting', escape: 'Escaping' };
/** "Orbiting Verda" — shared with the tracking station. */
export function situationText(v) {
  const body = v.body && v.body.name ? v.body.name : 'space';
  if (v.type === 'flag') return 'Planted on ' + body;
  if (v.situation === 'escape' && v.pos && v.vel && v.pos.dot(v.vel) < 0) return 'Arriving at ' + body;      // closest approach still ahead
  return (SITUATION[v.situation] || (v.landed ? 'Landed on' : 'Orbiting')) + ' ' + body;
}
const dvMag = dv => Math.hypot(dv.prograde || 0, dv.normal || 0, dv.radial || 0);

// ------------------------------------------------------------------------------------------------ the view

export function createMapView(app, opts = {}) {
  injectCss();
  const getWorld = opts.getWorld || (() => app.world);
  const allowNodes = opts.allowNodes !== false;
  const input = app.input;

  // ---- camera / focus state
  let open = false;
  let W = 1, H = 1, dpr = 1;
  let focusTarget = SYSTEM.home;
  let yaw = 0.6, pitch = 0.5, dist = SYSTEM.home.radius * 6, distTarget = dist;
  let trans = null;                                // { off: Vector3 (old focus − new focus), t }
  const focusG = new THREE.Vector3();              // focus point, star-relative metres
  const gpos = new Map();                          // Body → Vector3 star-relative
  for (const b of SYSTEM.bodies) gpos.set(b, new THREE.Vector3());
  let highlightOverride;                           // undefined → world.active
  let selNode = null;
  let selObj = null;                               // { kind: 'vessel'|'body', ref } — clicked marker
  let approaches = [];                             // closest approaches to the target, one per chain at most
  let caPr = null, caSig = '', caTgt = null, caBucket = -1;
  let relNodeMarks = [];                           // AN / DN of the trajectory relative to the target's plane
  let relInc = NaN;                                // relative inclination to the target (rad)
  let hoverBody = null;
  let hover = null;                                // { x, y, t, chain }
  let hoverVessel = null;
  let drag = null;
  let downAt = null, downR = null;
  let lastRealCompute = 0, realTime = 0;
  let panelTimer = 0;
  let lastWorld = null;

  // projection scratch (set each frame)
  const P = { cx: 0, cy: 0, cz: 0, rx: 1, ry: 0, rz: 0, ux: 0, uy: 1, uz: 0, fx: 0, fy: 0, fz: -1, fl: 1, zn: 1, ox: 0 };
  let insL = 12, insR = 12, viewOx = NaN;
  const S = { x: 0, y: 0, z: 0, ok: false };
  let occluders = [];
  const v3 = [0, 0, 0];

  // ---- three.js scene
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(FOV, 1, 1e-3, 1e9);
  scene.add(new THREE.AmbientLight(0x9db0d0, 0.55));       // a map: the night side stays readable
  const sunLight = new THREE.PointLight(0xfff3dd, 3.1, 0, 0);
  scene.add(sunLight);
  let starfield = null, sky = null;
  const visuals = new Map();                       // Body → { group, update, dispose, soi }
  const soiGeo = new THREE.SphereGeometry(1, 48, 24);
  let sceneBuilt = false;
  const hiRes = new Set();                         // bodies already given their full-size texture

  function buildScene() {
    if (sceneBuilt) return;
    sceneBuilt = true;
    try {
      if (typeof GFX.createStarfield === 'function') starfield = GFX.createStarfield(6500);
    } catch (err) { console.warn('[map] starfield unavailable:', err && err.message); }
    if (!starfield) {
      const n = 1500, pos = new Float32Array(n * 3);
      let s = 12345; const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
      for (let i = 0; i < n; i++) { const y = rnd() * 2 - 1, a = rnd() * TAU, k = Math.sqrt(1 - y * y); pos.set([k * Math.cos(a), y, k * Math.sin(a)], i * 3); }
      const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      starfield = new THREE.Points(g, new THREE.PointsMaterial({ color: 0xaab6c8, size: 1.5, sizeAttenuation: false, depthTest: false, depthWrite: false }));
      starfield.frustumCulled = false; starfield.renderOrder = -10;
    }
    starfield.scale.setScalar(1e4);
    scene.add(starfield);
    try { sky = createSky(); sky.mesh.scale.setScalar(2e4); scene.add(sky.mesh); } catch (err) { console.warn('[map] sky unavailable:', err && err.message); sky = null; }
    for (const body of SYSTEM.bodies) {
      let vis = null;
      try { if (typeof GFX.createBodyVisual === 'function') vis = GFX.createBodyVisual(body, { quality: 'low', nightFill: 0.3 }); }
      catch (err) { console.warn('[map] body visual unavailable for ' + body.name + ':', err && err.message); }
      if (!vis) {
        const geo = new THREE.SphereGeometry(1, 48, 24);
        const mat = body.type === 'star' ? new THREE.MeshBasicMaterial({ color: body.color }) : new THREE.MeshStandardMaterial({ color: body.color, roughness: 1, metalness: 0 });
        const group = new THREE.Group(); group.add(new THREE.Mesh(geo, mat));
        vis = { group, update() {}, dispose() { geo.dispose(); mat.dispose(); } };
      }
      // a map has to stay readable on the night side: lift the renderer's ambient floor for these copies only
      // (createBodyVisual takes `nightFill` and offers setNightFill; a visual without either gets its uniform lifted by hand)
      try {
        if (typeof vis.setNightFill === 'function') vis.setNightFill(0.3);
        else vis.group.traverse(o => { const u = o.material && o.material.uniforms; if (u && u.uFill && typeof u.uFill.value === 'number') u.uFill.value = Math.max(u.uFill.value, 0.3); });
      } catch { /* stock look */ }
      scene.add(vis.group);
      let soi = null;
      if (Number.isFinite(body.soi)) {
        soi = new THREE.Mesh(soiGeo, new THREE.MeshBasicMaterial({ color: body.color, transparent: true, opacity: 0.05, depthWrite: false, blending: THREE.AdditiveBlending }));
        soi.renderOrder = 5; soi.visible = false;
        scene.add(soi);
      }
      visuals.set(body, { vis, soi });
    }
  }

  // ---- DOM
  let root = null, canvas2d = null, ctx = null, labelLayer = null, gizmoLayer = null, focusVesselBtn = null;
  let bodyPanel = null, orbitPanel = null, nodePanel = null, focusName = null, hintBar = null, selPanel = null, targetPanel = null, transferPanel = null, cardEl = null;
  const selUi = {}, tgtUi = {}, trUi = {};
  let cardKey = '', cardStamp = -1, cardW = 200, cardH = 80, transferInfo = null, coreWindow = null;
  const labelPool = new Map();                     // key → { node, text, cls, used }
  let labelReq = [];
  const handles = [];                              // { def, node, x, y, dx, dy, visible }
  const nodeUi = {};
  let offs = [];

  function buildDom() {
    canvas2d = el('canvas', { class: 'map-canvas' });
    ctx = canvas2d.getContext('2d');
    labelLayer = el('div', { class: 'map-labels' });
    gizmoLayer = el('div', { class: 'map-gizmo' });
    handles.length = 0;
    for (const def of AXES) {
      const node = el('div', { class: 'map-handle ' + def.cls, attrs: { 'data-axis': def.axis, 'data-sign': def.sign, title: def.name + ' — drag outward, or scroll to nudge', 'aria-label': def.name } });
      node.innerHTML = HANDLE_SVG[def.axis + (def.sign > 0 ? '+' : '-')];
      const h = { def, node, x: 0, y: 0, dx: 0, dy: 0, visible: false };
      node.addEventListener('pointerdown', e => startHandleDrag(h, e));
      node.addEventListener('pointermove', e => { if (drag && drag.type === 'handle' && drag.h === h) { drag.mx = e.clientX; drag.my = e.clientY; } });
      const end = e => { if (drag && drag.type === 'handle' && drag.h === h) { drag = null; node.classList.remove('dragging'); try { node.releasePointerCapture(e.pointerId); } catch { /* gone */ } } };
      node.addEventListener('pointerup', end); node.addEventListener('pointercancel', end); node.addEventListener('lostpointercapture', end);
      node.addEventListener('wheel', e => {
        e.preventDefault(); e.stopPropagation();
        if (!selNode) return;
        const d = e.deltaY || e.deltaX; if (!d) return;
        const step = e.shiftKey ? 1 : e.altKey ? 0.01 : 0.1;
        bumpDv(selNode, def.axis, (d < 0 ? 1 : -1) * def.sign * step);
      }, { passive: false });
      node.addEventListener('contextmenu', e => e.preventDefault());
      gizmoLayer.appendChild(node);
      handles.push(h);
    }

    // focus bar
    focusName = el('span', { class: 'map-focus-name', text: '' });

    const focusBar = el('div', { class: 'map-focusbar sw-panel glass pad-sm' },
      el('button', { class: 'sw-btn small icon ghost', text: '‹', tip: 'Previous body (Shift+Tab)', attrs: { type: 'button', 'data-map': 'prev' }, on: { click: () => cycleFocus(-1) } }),
      el('span', { class: 'sw-label', text: 'Focus' }), focusName,
      el('button', { class: 'sw-btn small icon ghost', text: '›', tip: 'Next body (Tab)', attrs: { type: 'button', 'data-map': 'next' }, on: { click: () => cycleFocus(1) } }),
      (focusVesselBtn = el('button', { class: 'sw-btn small', text: 'Vessel', tip: 'Focus the active vessel (`)', attrs: { type: 'button', 'data-map': 'vessel' }, on: { click: () => focusActive() } })),
      el('button', { class: 'sw-btn small', text: 'Inner', tip: 'The inner system: the star out to the home world and its neighbours', attrs: { type: 'button', 'data-map': 'inner' }, on: { click: () => focusInner() } }));

    bodyPanel = el('div', { class: 'map-panel map-body sw-panel glass pad-sm' });
    orbitPanel = el('div', { class: 'map-panel map-orbit sw-panel glass pad-sm' });
    nodePanel = buildNodePanel();
    selPanel = buildSelPanel();
    targetPanel = buildTargetPanel();
    transferPanel = buildTransferPanel();
    cardEl = el('div', { class: 'map-card sw-hidden', data: { map: 'card' } });
    hintBar = el('div', { class: 'map-hint' + (opts.hints === false ? ' sw-hidden' : '') },
      el('span', {}, el('b', { text: 'Right-drag' }), ' rotate'), el('span', {}, el('b', { text: 'Scroll' }), ' zoom'),
      el('span', {}, el('b', { text: 'Tab' }), ' next world'), el('span', {}, el('b', { text: '`' }), ' vessel'),
      el('span', { class: 'wide' }, el('b', { text: 'Click' }), ' select'), el('span', {}, el('b', { text: 'Double-click' }), ' focus'),
      el('span', { class: 'wide' }, el('b', { text: 'Right-click marker' }), ' pin'),
      allowNodes ? el('span', {}, el('b', { text: 'Click orbit' }), ' plan a burn') : null);

    root = el('div', { class: 'map-root' + (allowNodes ? '' : ' browse'), data: { map: 'root' } },
      // the drawing, its labels and the burn handles work in viewport pixels: .map-vp undoes the interface zoom (css/map.css)
      el('div', { class: 'map-vp' }, canvas2d, labelLayer, gizmoLayer),
      focusBar, el('div', { class: 'map-col left' }, bodyPanel, selPanel, targetPanel, transferPanel), el('div', { class: 'map-col right' }, orbitPanel, nodePanel), hintBar, cardEl);
    setInsets(opts.insets || {});
  }
  function setInsets(ins) {
    if (!root || !ins) return;
    for (const k of ['top', 'left', 'right', 'bottom']) if (ins[k] != null) root.style.setProperty('--map-' + k, ins[k] + 'px');
    if (ins.left != null) insL = ins.left;
    if (ins.right != null) insR = ins.right;
  }
  /** Jump the camera (tests, previews, saved views): any of { dist, yaw, pitch } (metres, radians). */
  function setView(v = {}) {
    if (Number.isFinite(v.yaw)) yaw = v.yaw;
    if (Number.isFinite(v.pitch)) pitch = clamp(v.pitch, -89 * DEG, 89 * DEG);
    if (Number.isFinite(v.dist)) { distTarget = clamp(v.dist, distLimits()[0], MAX_DIST); if (v.instant !== false) dist = distTarget; }
  }
  /** Camera distance that frames a body together with its moons (or the planets, for the star). */
  function systemDist(body) {
    let m = body.radius * 7;
    for (const c of body.children) m = Math.max(m, c.orbit.apoapsis * 2.5);
    return Math.min(m, MAX_DIST);
  }

  function buildNodePanel() {
    const btn = (text, tip, fn, cls = '') => el('button', { class: 'sw-btn small ' + cls, text, tip, attrs: { type: 'button' }, on: { click: e => { if (selNode) fn(e); } } });
    nodeUi.title = el('span', { class: 'sw-title', text: 'Maneuver' });
    nodeUi.total = el('span', { class: 'sw-value big amber', text: '0.0 m/s' });
    nodeUi.burn = el('span', { class: 'sw-value', text: '—' });
    nodeUi.tminus = el('span', { class: 'sw-value', text: '—' });
    nodeUi.result = el('div', { class: 'map-node-result sw-dim', text: '' });
    nodeUi.fields = {};
    const rows = [];
    for (const [axis, name, cls] of [['prograde', 'Prograde', 'pro'], ['normal', 'Normal', 'nrm'], ['radial', 'Radial', 'rad']]) {
      const field = el('input', { class: 'sw-input map-num', attrs: { type: 'text', inputmode: 'decimal', 'data-axis': axis, 'aria-label': name + ' delta-v (m/s)' } });
      field.addEventListener('change', () => { if (!selNode) return; const v = parseFloat(field.value.replace(',', '.').replace('−', '-')); if (Number.isFinite(v)) { selNode.dv[axis] = v; } refreshNodePanel(true); });
      field.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === 'Escape') field.blur(); e.stopPropagation(); });
      nodeUi.fields[axis] = field;
      const step = e => (e.shiftKey ? 10 : e.altKey ? 0.1 : 1);
      rows.push(el('div', { class: 'map-dv-row' },
        el('span', { class: 'map-dot ' + cls }), el('span', { class: 'map-dv-name', text: name }),
        btn('−', name + ' −1 m/s (Shift 10, Alt 0.1)', e => bumpDv(selNode, axis, -step(e)), 'icon'),
        field,
        btn('+', name + ' +1 m/s (Shift 10, Alt 0.1)', e => bumpDv(selNode, axis, step(e)), 'icon'),
        el('span', { class: 'map-unit', text: 'm/s' })));
    }
    const shift = dt => shiftNodeTime(selNode, dt);
    nodeUi.orbitMinus = btn('−1 orbit', 'One orbit earlier', () => shift(-(selPeriod() || 0)));
    nodeUi.orbitPlus = btn('+1 orbit', 'One orbit later', () => shift(selPeriod() || 0));
    nodeUi.warp = btn('Warp to node', 'Time-warp until just before the burn', () => warpToNode(), 'primary');
    return el('div', { class: 'map-panel map-node sw-panel glass pad-sm sw-hidden', data: { map: 'node-panel' } },
      el('div', { class: 'sw-row map-panel-head' }, el('span', { class: 'map-diamond' }), nodeUi.title, el('span', { class: 'sw-grow' }),
        el('button', { class: 'sw-btn small icon ghost', text: '‹', tip: 'Previous maneuver', attrs: { type: 'button', 'data-map': 'node-prev' }, on: { click: () => stepNode(-1) } }),
        el('button', { class: 'sw-btn small icon ghost', text: '›', tip: 'Next maneuver', attrs: { type: 'button', 'data-map': 'node-next' }, on: { click: () => stepNode(1) } }),
        el('button', { class: 'sw-btn small icon ghost', text: '×', tip: 'Close (keeps the node)', attrs: { type: 'button' }, on: { click: () => selectNode(null) } })),
      el('div', { class: 'map-node-total' }, el('span', { class: 'sw-label', text: 'Total Δv' }), nodeUi.total),
      ...rows,
      el('div', { class: 'sw-sep' }),
      el('div', { class: 'map-kv' }, el('span', { class: 'sw-label', text: 'Time to node' }), nodeUi.tminus, el('span', { class: 'sw-label', text: 'Est. burn' }), nodeUi.burn),
      el('div', { class: 'map-time-row' },
        btn('−10s', 'Ten seconds earlier', () => shift(-10)), btn('−1s', 'One second earlier', () => shift(-1)),
        btn('+1s', 'One second later', () => shift(1)), btn('+10s', 'Ten seconds later', () => shift(10))),
      el('div', { class: 'map-time-row' }, nodeUi.orbitMinus, nodeUi.orbitPlus),
      nodeUi.result,
      el('div', { class: 'map-time-row' }, nodeUi.warp,
        btn('Delete', 'Delete this maneuver (Del)', () => deleteNode(selNode), 'danger'),
        btn('Clear all', 'Delete every planned maneuver', () => clearNodes(), 'ghost')));
  }

  function buildSelPanel() {
    selUi.swatch = el('span', { class: 'map-swatch' });
    selUi.title = el('span', { class: 'sw-title', text: '' });
    selUi.chip = el('span', { class: 'sw-chip', text: '' });
    selUi.info = el('div', { class: 'map-sel-info sw-dim', text: '' });
    selUi.set = el('button', { class: 'sw-btn small primary', text: 'Set as target', tip: 'Make this the navigation target of the active vessel',
      attrs: { type: 'button', 'data-map': 'set-target' }, on: { click: () => { const w = world(); if (w && selObj) { setTarget(w, selObj.ref); panelTimer = 0; } } } });
    selUi.focus = el('button', { class: 'sw-btn small', text: 'Focus', tip: 'Centre the map on it', attrs: { type: 'button', 'data-map': 'focus-selection' },
      on: { click: () => { if (selObj) focus(selObj.ref); } } });
    return el('div', { class: 'map-panel map-sel sw-panel glass pad-sm sw-hidden', data: { map: 'sel-panel' } },
      el('div', { class: 'sw-row map-panel-head' }, selUi.swatch, selUi.title, el('span', { class: 'sw-grow' }), selUi.chip,
        el('button', { class: 'sw-btn small icon ghost', text: '×', tip: 'Deselect', attrs: { type: 'button' }, on: { click: () => select(null) } })),
      selUi.info,
      el('div', { class: 'map-time-row' }, selUi.set, selUi.focus));
  }

  function buildTargetPanel() {
    tgtUi.title = el('span', { class: 'sw-title', text: '' });
    const val = () => el('span', { class: 'sw-value', text: '—' });
    tgtUi.dist = val(); tgtUi.speed = val(); tgtUi.ca = val(); tgtUi.caSpeed = val(); tgtUi.ca2 = val(); tgtUi.inc = val(); tgtUi.plan = val();
    tgtUi.ca2Label = el('span', { class: 'sw-label', text: '2nd pass' });
    tgtUi.caLabel = el('span', { class: 'sw-label', text: 'Approach' }); tgtUi.caSpeedLabel = el('span', { class: 'sw-label', text: '↳ speed' });
    tgtUi.planLabel = el('span', { class: 'sw-label', text: 'After burn' });
    return el('div', { class: 'map-panel map-target sw-panel glass pad-sm sw-hidden', data: { map: 'target-panel' } },
      el('div', { class: 'sw-row map-panel-head' }, el('span', { class: 'map-tgt-ico' }), tgtUi.title, el('span', { class: 'sw-grow' }), el('span', { class: 'sw-chip', text: 'Target' })),
      el('div', { class: 'map-tgt-kv' }, el('span', { class: 'sw-label', text: 'Distance' }), tgtUi.dist, el('span', { class: 'sw-label', text: 'Rel. speed' }), tgtUi.speed,
        el('span', { class: 'sw-label', text: 'Rel. incl.' }), tgtUi.inc,
        tgtUi.caLabel, tgtUi.ca, tgtUi.caSpeedLabel, tgtUi.caSpeed,
        tgtUi.ca2Label, tgtUi.ca2, tgtUi.planLabel, tgtUi.plan),
      el('div', { class: 'map-time-row' },
        el('button', { class: 'sw-btn small', text: 'Focus', tip: 'Centre the map on the target', attrs: { type: 'button', 'data-map': 'focus-target' },
          on: { click: () => { const w = world(), t = w && targetOf(w); if (t) focus(t); } } }),
        el('button', { class: 'sw-btn small', text: 'Clear target', tip: 'Drop the navigation target', attrs: { type: 'button', 'data-map': 'clear-target' },
          on: { click: () => { const w = world(); if (w) { setTarget(w, null); panelTimer = 0; } } } })));
  }

  // Transfer-window helper: phase angle now vs needed for a Hohmann transfer to the target / selection.
  function buildTransferPanel() {
    trUi.route = el('span', { class: 'sw-title', text: '' });
    trUi.from = el('span', { class: 'map-tr-from', text: '' });
    trUi.dial = el('canvas', { class: 'map-dial', attrs: { width: 132, height: 132, 'aria-hidden': 'true' } });
    const val = () => el('span', { class: 'sw-value', text: '—' });
    trUi.now = val(); trUi.need = val(); trUi.win = val(); trUi.time = val(); trUi.dv = val();
    trUi.dvLabel = el('span', { class: 'sw-label', text: 'Eject Δv' });
    trUi.warp = el('button', { class: 'sw-btn small primary', text: 'Warp to window', tip: 'Time-warp until the transfer window opens', attrs: { type: 'button', 'data-map': 'warp-window' },
      on: { click: () => warpToWindow() } });
    trUi.plan = el('button', { class: 'sw-btn small', text: 'Plan burn', tip: 'Put a maneuver node on your orbit for this transfer', attrs: { type: 'button', 'data-map': 'plan-transfer' },
      on: { click: () => planTransfer() } });
    return el('div', { class: 'map-panel map-transfer sw-panel glass pad-sm sw-hidden', data: { map: 'transfer-panel' } },
      el('div', { class: 'sw-row map-panel-head' }, el('span', { class: 'map-tr-ico' }), trUi.route, trUi.from, el('span', { class: 'sw-grow' }), el('span', { class: 'sw-chip', text: 'Window' })),
      el('div', { class: 'map-tr-body' }, trUi.dial,
        el('div', { class: 'map-tgt-kv' }, el('span', { class: 'sw-label', text: 'Phase now' }), trUi.now, el('span', { class: 'sw-label', text: 'Needed' }), trUi.need,
          el('span', { class: 'sw-label', text: 'Window in' }), trUi.win, el('span', { class: 'sw-label', text: 'Flight time' }), trUi.time, trUi.dvLabel, trUi.dv)),
      el('div', { class: 'map-time-row' }, trUi.warp, trUi.plan));
  }
  /** What "Plan burn" would do now: { v, target, kind: 'planet' | 'moon' } or null (no vessel to plan for, open orbit, …). */
  function plannable(w) {
    const info = transferInfo, v = w && editable(w);
    if (!info || !v || info.kind === 'vessel') return null;
    const target = targetOf(w) || (selObj && selObj.ref);
    if (!isBody(target)) return null;
    let o = null; try { o = v.getOrbit(w.ut); } catch { o = null; }
    if (!o || o.hyper) return null;
    if (info.kind === 'moon' && target.parent === v.body && typeof AUTOPILOT.planHohmannToMoon === 'function') return { v, target, kind: 'moon' };
    if (info.kind === 'planet' && v.body.parent && target.parent === v.body.parent && typeof AUTOPILOT.planInterplanetary === 'function') return { v, target, kind: 'planet' };
    return null;
  }
  let planning = false;
  /** Ask the core planner for the departure burn of the transfer on show and put it on the vessel as a maneuver node. */
  function planTransfer() {
    const w = world(), job = w && plannable(w);
    if (!job || planning) return false;
    planning = true; trUi.plan.disabled = true; setText(trUi.plan, 'Planning…');
    const run = () => {
      planning = false; setText(trUi.plan, 'Plan burn');
      if (!open || world() !== w) return;
      let res = null;
      try { res = job.kind === 'moon' ? AUTOPILOT.planHohmannToMoon(w, job.v, job.target) : AUTOPILOT.planInterplanetary(w, job.v, job.target); }
      catch (err) { console.warn('[map] transfer planner failed:', err && err.message); res = null; }
      if (!res || !res.node) { if (app.toast) app.toast('No transfer found from this orbit. A low, round orbit works best.', 'warn'); return; }
      if (Array.isArray(job.v.nodes)) sortNodes(job.v);
      selectNode(res.node);
      const met = res.periapsis != null;
      if (app.toast) app.toast(`Burn planned: ${fmt.num(res.dv, 0)} m/s in ${fmt.time(Math.max(0, res.node.t - w.ut))}. ` + (met ? `It reaches ${job.target.name}, closest pass ${fmt.dist ? fmt.dist(res.periapsis) : Math.round(res.periapsis / 1000) + ' km'}.` : `It passes near ${job.target.name}: plan a small correction on the way.`), met ? 'good' : 'info');
      if (app.audio && app.audio.play) { try { app.audio.play('click'); } catch { /* optional */ } }
    };
    setTimeout(run, 30);                      // let "Planning…" paint first: the search can take a second
    return true;
  }
  /** The predicted encounter of the highlighted vessel with `body` (last planned chain first), or null. */
  function encounterWith(w, body) {
    const hl = highlighted(w), pr = hl && preds.get(hl);
    if (!pr) return null;
    for (let j = pr.chains.length - 1; j >= 0; j--) {
      const ch = pr.chains[j];
      if (!ch) continue;
      for (let k = 0; k < ch.length; k++) {
        const c = ch[k];
        if (c.patch.endType === 'enter' && c.patch.nextBody === body) return { chain: j, t: c.patch.tEnd, next: ch[k + 1] || null };
        if (c.body === body && k === 0 && j === 0) return { chain: 0, t: w.ut, next: c };
      }
    }
    return null;
  }
  function warpToWindow() {
    const w = world(), info = transferInfo;
    if (!w || !info || typeof w.warpTo !== 'function') return;
    const lead = info.kind === 'planet' ? Math.min(3600, info.synodic * 0.002) : 90;
    const t = w.ut + info.timeToWindow - lead;
    if (t > w.ut + 1) w.warpTo(t); else if (app.toast) app.toast('The transfer window is open now.', 'info');
  }
  function drawDial(info) {
    const c = trUi.dial, g = c.getContext('2d'), s = c.width, m = s / 2, R = s * 0.4, r = s * 0.2;
    g.clearRect(0, 0, s, s);
    const inner = info.r1 <= info.r2;                 // origin on the inner ring?
    const ro = inner ? r : R, rt = inner ? R : r;
    g.lineWidth = 2; g.strokeStyle = 'rgba(150,170,190,0.35)';
    g.beginPath(); g.arc(m, m, R, 0, TAU); g.stroke(); g.beginPath(); g.arc(m, m, r, 0, TAU); g.stroke();
    // needed-phase wedge and the current phase arc (angles counter-clockwise from the origin's direction, drawn at 3 o'clock)
    const ang = a => -a;
    g.beginPath(); g.moveTo(m, m); g.arc(m, m, rt, ang(info.phaseNeeded) - 0.07, ang(info.phaseNeeded) + 0.07); g.closePath();
    g.fillStyle = 'rgba(255,179,71,0.3)'; g.fill();
    g.beginPath(); g.moveTo(m + Math.cos(ang(info.phaseNeeded)) * (rt - 9), m + Math.sin(ang(info.phaseNeeded)) * (rt - 9));
    g.lineTo(m + Math.cos(ang(info.phaseNeeded)) * (rt + 9), m + Math.sin(ang(info.phaseNeeded)) * (rt + 9));
    g.lineWidth = 3; g.strokeStyle = '#ffb347'; g.stroke();
    g.beginPath(); g.arc(m, m, (R + r) / 2, Math.min(0, ang(info.phaseNow)), Math.max(0, ang(info.phaseNow)));
    g.lineWidth = 2; g.setLineDash([4, 4]); g.strokeStyle = 'rgba(232,121,249,0.8)'; g.stroke(); g.setLineDash([]);
    g.fillStyle = '#ffe9b0'; g.beginPath(); g.arc(m, m, 5, 0, TAU); g.fill();
    g.fillStyle = '#39d0c0'; g.beginPath(); g.arc(m + ro, m, 6, 0, TAU); g.fill();
    g.fillStyle = '#e879f9'; g.beginPath(); g.arc(m + Math.cos(ang(info.phaseNow)) * rt, m + Math.sin(ang(info.phaseNow)) * rt, 6, 0, TAU); g.fill();
  }
  function refreshTransfer(w) {
    if (!transferPanel) return;
    const tgt = targetOf(w);
    const obj = tgt || (selObj && selObj.ref) || null;
    const origin = w.active || highlighted(w) || SYSTEM.home;
    let info = null;
    if (obj && obj !== origin) { try { info = transferFor(origin, obj, w.ut); } catch { info = null; } }
    // no window to speak of when the flight already reaches the target (encounter on the books)
    if (info && isBody(obj) && encounterWith(w, obj)) info = null;
    if (info && Math.abs(info.r2 / info.r1 - 1) < 0.04) info = null;          // practically the same orbit: nothing to phase for
    // body-to-body windows come from the core planner when it has one (it follows eccentric orbits; the local
    // estimate assumes circles). The search is costly, so one answer is kept until its window has passed.
    if (info && info.kind === 'planet' && isBody(obj) && info.fromBody && typeof AUTOPILOT.transferWindow === 'function') {
      const key = info.fromBody.id + '>' + obj.id;
      if (!coreWindow || coreWindow.key !== key || w.ut > coreWindow.win.t + 1 || w.ut < coreWindow.at - 1) {
        let win = null; try { win = AUTOPILOT.transferWindow(info.fromBody, obj, w.ut); } catch { win = null; }
        coreWindow = win ? { key, win, at: w.ut } : { key, win: { t: Infinity }, at: w.ut, none: true };
      }
      if (!coreWindow.none) {
        const win = coreWindow.win;
        const wrap = x => { x %= TAU; return x > Math.PI ? x - TAU : x < -Math.PI ? x + TAU : x; };
        const need = wrap(win.phase), a = wrap(info.phaseNow - need);
        info = { ...info, phaseNeeded: need, phaseError: win.t - w.ut < 1 ? 0 : a, timeToWindow: Math.max(0, win.t - w.ut), transferTime: win.tof,
          synodic: win.synodic, vInf: win.vInfDepart, vArr: win.vInfArrive, ejectDv: win.ejectionDv(info.parkingRadius), source: 'core' };
      }
    }
    transferInfo = info;
    transferPanel.classList.toggle('sw-hidden', !info);
    if (!info) return;
    const deg = a => (a / DEG).toFixed(1) + '°';
    setText(trUi.route, 'To ' + info.to);
    setText(trUi.from, 'from ' + info.from);
    setText(trUi.now, deg(info.phaseNow));
    setText(trUi.need, deg(info.phaseNeeded));
    const open = Math.abs(info.phaseError) < 1.5 * DEG;
    setText(trUi.win, open ? 'Open now' : Number.isFinite(info.timeToWindow) ? fmt.time(info.timeToWindow) : '—');
    trUi.win.classList.toggle('good', open);
    setText(trUi.time, fmt.time(info.transferTime));
    setText(trUi.dvLabel, info.kind === 'planet' ? 'Eject Δv' : 'Burn Δv');
    setText(trUi.dv, '≈ ' + fmt.num(info.ejectDv, 0) + ' m/s');
    trUi.warp.classList.toggle('sw-hidden', typeof w.warpTo !== 'function' || opts.windowWarp === false);
    trUi.warp.disabled = open || !Number.isFinite(info.timeToWindow);
    const can = !!plannable(w);
    trUi.plan.classList.toggle('sw-hidden', !allowNodes || !can);
    if (!planning) trUi.plan.disabled = !can;
    drawDial(info);
  }

  // Hover card for vessels and small body markers.
  function updateCard(w, t, mouse) {
    if (!cardEl) return;
    if (!t) { if (cardKey) { cardKey = ''; cardEl.classList.add('sw-hidden'); } return; }
    const key = t.kind + ':' + t.ref.id;
    if (key !== cardKey || realTime - cardStamp > 0.3) {
      const fresh = key !== cardKey;
      cardKey = key; cardStamp = realTime;
      fillCard(w, t);
      cardEl.classList.remove('sw-hidden');
      if (fresh) { cardW = cardEl.offsetWidth || 200; cardH = cardEl.offsetHeight || 80; }
    }
    const k = uiScale(), cw = cardW * k, ch = cardH * k;      // the card is part of the zoomed interface; the mouse is in viewport pixels
    let x = mouse.x + 18, y = mouse.y + 16;
    if (x + cw > W - 8) x = mouse.x - cw - 14;
    if (y + ch > H - 8) y = mouse.y - ch - 12;
    cardEl.style.transform = `translate(${Math.round(Math.max(4, x) / k)}px,${Math.round(Math.max(4, y) / k)}px)`;
  }
  function fillCard(w, t) {
    clear(cardEl);
    const o = t.ref, rows = [];
    let chip = '', sub = '';
    if (t.kind === 'vessel') {
      const role = roleOf(o);
      chip = roleName(role);
      sub = situationText(o);
      const R = o.body.radius, r = o.pos ? Math.hypot(o.pos.x, o.pos.y, o.pos.z) : R;
      if (!o.landed) {
        rows.push(['Altitude', fmt.dist(r - R)]);
        if (o.vel) rows.push(['Speed', fmt.speed(Math.hypot(o.vel.x, o.vel.y, o.vel.z))]);
      }
      let crew = []; try { crew = Array.isArray(o.crew) ? o.crew : []; } catch { crew = []; }
      if (crew.length) rows.push(['Crew', crew.length <= 2 ? crew.join(', ') : crew.length + ' Pips']);
      const a = w.active;
      if (a && a !== o) { vesselGlobal(a, tmpV); vesselGlobal(o, tmpV2); rows.push(['Distance', fmt.dist(tmpV.distanceTo(tmpV2))]); }
      cardEl.appendChild(el('div', { class: 'map-card-head' }, cardIcon(role, o === w.active ? '#39d0c0' : ROLE_COLORS[role]), el('b', { text: o.name || 'Vessel' }), el('span', { class: 'sw-chip', text: chip })));
    } else {
      chip = o.type === 'star' ? 'Star' : o.type === 'moon' ? 'Moon' : o.gas ? 'Gas giant' : 'Planet';
      sub = o.parent ? 'Orbits ' + o.parent.name : 'Centre of the system';
      rows.push(['Radius', fmt.dist(o.radius)], ['Gravity', o.surfaceG.toFixed(2) + ' m/s²'], ['Atmosphere', o.atmo ? fmt.dist(o.atmo.height) : 'None']);
      let n = 0; for (const v of w.vessels || []) if (v.body === o && v.type !== 'debris') n++;
      if (n) rows.push(['Craft here', String(n)]);
      cardEl.appendChild(el('div', { class: 'map-card-head' }, el('span', { class: 'map-swatch', style: { background: hex(o.color) } }), el('b', { text: o.name }), el('span', { class: 'sw-chip', text: chip })));
    }
    cardEl.appendChild(el('div', { class: 'map-card-sub', text: sub }));
    const kvn = el('div', { class: 'map-card-kv' });
    for (const [k, v] of rows) { kvn.appendChild(el('span', { text: k })); kvn.appendChild(el('b', { text: v })); }
    cardEl.appendChild(kvn);
    cardEl.appendChild(el('div', { class: 'map-card-hint', text: 'Click: select · Double-click: focus' }));
  }
  function cardIcon(role, color) {
    const c = el('canvas', { class: 'map-ico', attrs: { width: 36, height: 36 } });
    const g = c.getContext('2d'); g.scale(2, 2);
    drawIcon(g, role, 9, 9, 6.4, color || '#b9c6d3', {});
    return c;
  }

  // ------------------------------------------------------------------------------------------------ world access

  const world = () => { try { return getWorld() || null; } catch { return null; } };
  function highlighted(w) { return highlightOverride !== undefined ? highlightOverride : (w && w.active) || null; }
  function editable(w) { const h = highlighted(w); return allowNodes && h && w && h === w.active && !h.landed ? h : null; }

  /** The active vessel's navigation target (Vessel or Body) or null. */
  function targetOf(w) {
    const a = w && w.active;
    if (!a) return null;
    try {
      if (typeof w.getTarget === 'function') return w.getTarget(a) || null;
      const id = a.targetId;
      if (id === null || id === undefined) return null;
      return typeof id === 'string' ? SYSTEM.byId[id] || null : (w.vessels || []).find(v => v.id === id) || null;
    } catch { return null; }
  }
  function setTarget(w, obj) {
    const a = w && w.active;
    if (!a) return false;
    if (typeof w.setTarget === 'function') return w.setTarget(a, obj || null) !== false;
    a.targetId = obj ? obj.id : null;
    return true;
  }
  function select(obj) {
    selObj = obj ? { kind: isBody(obj) ? 'body' : 'vessel', ref: obj } : null;
    panelTimer = 0;
  }

  function vesselGlobal(v, out) {
    const g = gpos.get(v.body);
    const p = v.pos;
    if (g) out.copy(g); else out.set(0, 0, 0);
    if (p) { out.x += p.x; out.y += p.y; out.z += p.z; }
    return out;
  }

  // ------------------------------------------------------------------------------------------------ predictions

  const preds = new WeakMap();                     // vessel → prediction
  function stateOf(v, ut) {
    if (v.pos && v.vel) return v;
    const s = v.getOrbit(ut).stateAt(ut);
    return { pos: s.r, vel: s.v };
  }
  function baseValid(pr, v, ut) {
    if (!pr || pr.body !== v.body || pr.landed !== !!v.landed) return false;
    if (v.landed) return true;
    if (ut < pr.ut - 1e-6) return false;
    const c0 = pr.chains[0] && pr.chains[0][0];
    if (!c0) return false;
    if (ut > c0.patch.tEnd) return false;
    const s = stateOf(v, ut), o = pr.orbit;
    const r = o.posAt(ut), vel = o.velAt(ut);
    const dr = Math.hypot(r.x - s.pos.x, r.y - s.pos.y, r.z - s.pos.z), dv = Math.hypot(vel.x - s.vel.x, vel.y - s.vel.y, vel.z - s.vel.z);
    return dr <= 1e-5 * r.length() + 0.5 && dv <= 1e-5 * vel.length() + 0.005;
  }

  function computeBase(v, ut, maxPatches) {
    const pr = { ut, real: realTime, body: v.body, landed: !!v.landed, orbit: null, chains: [null], infos: [], sig: '', maxPatches };
    if (!v.landed) {
      try {
        pr.orbit = v.getOrbit(ut);
        pr.chains[0] = predictPatches(pr.orbit, v.body, ut, maxPatches).map(makeCurve);
      } catch (err) { console.warn('[map] prediction failed for ' + v.name + ':', err && err.message); pr.chains[0] = null; }
    }
    return pr;
  }

  function findCurve(chain, t) {
    if (!chain) return null;
    for (const c of chain) if (t >= c.patch.tStart - 1e-6 && t <= c.patch.tEnd) return c;
    return null;
  }

  function computeNodes(pr, v) {
    const nodes = Array.isArray(v.nodes) ? v.nodes : [];
    pr.chains.length = 1; pr.infos = [];
    pr.sig = nodesSignature(nodes);
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i], host = pr.chains[i];
      const info = { node, index: i, valid: false, curve: null, A: 0, pos: new THREE.Vector3(), body: null, basis: null };
      pr.infos.push(info);
      const c = findCurve(host, node.t);
      if (!c) { pr.chains.push(null); continue; }
      try {
        const st = c.o.stateAt(node.t);
        info.valid = true; info.curve = c; info.A = curveAnomaly(c, node.t); info.pos.copy(st.r); info.body = c.body;
        info.basis = maneuverBasis(st.r, st.v);
        const o2 = applyManeuver(c.o, node.t, node.dv);
        pr.chains.push(predictPatches(o2, c.body, node.t, 3).map(makeCurve));
      } catch (err) { console.warn('[map] maneuver prediction failed:', err && err.message); pr.chains.push(null); }
    }
  }

  let otherCursor = 0;
  function refreshPredictions(w) {
    const ut = w.ut, hl = highlighted(w);
    if (hl) {
      let pr = preds.get(hl);
      const nodes = allowNodes && Array.isArray(hl.nodes) ? hl.nodes : [];
      const valid = baseValid(pr, hl, ut);
      const sig = nodesSignature(nodes);
      const since = realTime - lastRealCompute;
      if ((!valid || pr.maxPatches < 4 || (realTime - pr.real > 4 && ut !== pr.ut)) && (since >= 0.2 || !pr)) {
        pr = computeBase(hl, ut, 4);
        preds.set(hl, pr);
        if (allowNodes) computeNodes(pr, hl);
        lastRealCompute = realTime;
      } else if (pr && allowNodes && sig !== pr.sig && since >= 0.1) {
        computeNodes(pr, hl);
        lastRealCompute = realTime;
      }
    }
    // one background vessel per frame at most
    const vs = w.vessels || [];
    if (vs.length) {
      otherCursor = (otherCursor + 1) % vs.length;
      const v = vs[otherCursor];
      if (v !== hl) {
        const pr = preds.get(v);
        if (!baseValid(pr, v, ut) || realTime - pr.real > 6) preds.set(v, computeBase(v, ut, 2));
      }
    }
  }

  // ------------------------------------------------------------------------------------------------ projection

  function setupProjection() {
    const cp = Math.cos(pitch), dx = cp * Math.sin(yaw), dy = Math.sin(pitch), dz = cp * Math.cos(yaw);
    P.cx = dx * dist; P.cy = dy * dist; P.cz = dz * dist;
    P.fx = -dx; P.fy = -dy; P.fz = -dz;
    // right = Y × d, up = d × right
    let rx = dz, rz = -dx; const rl = Math.hypot(rx, rz) || 1; rx /= rl; rz /= rl;
    P.rx = rx; P.ry = 0; P.rz = rz;
    P.ux = dy * rz - dz * 0; P.uy = dz * rx - dx * rz; P.uz = dx * 0 - dy * rx;
    P.fl = (H / 2) / Math.tan(FOV * DEG / 2);
    P.zn = dist * 2e-4;
    // wide side panels (tracking station): centre the view on the free area between them
    P.ox = insL > 100 || insR > 100 ? Math.round((insL - insR) / 2 * uiScale()) : 0;
    if (P.ox !== viewOx) { viewOx = P.ox; if (P.ox) camera.setViewOffset(W, H, -P.ox, 0, W, H); else camera.clearViewOffset(); }
    camera.position.set(dx, dy, dz);
    camera.up.set(0, 1, 0);
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld();
  }

  /** Project a focus-relative point (metres). Writes S.x, S.y (CSS px), S.z (depth, m), S.ok (in front). */
  function proj(x, y, z) {
    const ex = x - P.cx, ey = y - P.cy, ez = z - P.cz;
    const d = ex * P.fx + ey * P.fy + ez * P.fz;
    S.z = d;
    if (d <= P.zn) { S.ok = false; S.x = S.y = 0; return false; }
    const k = P.fl / d;
    S.x = W / 2 + P.ox + (ex * P.rx + ey * P.ry + ez * P.rz) * k;
    S.y = H / 2 - (ex * P.ux + ey * P.uy + ez * P.uz) * k;
    S.ok = true;
    return true;
  }

  function occluded(x, y, z) {
    const dx = x - P.cx, dy = y - P.cy, dz = z - P.cz;
    const a = dx * dx + dy * dy + dz * dz;
    for (let i = 0; i < occluders.length; i++) {
      const o = occluders[i];
      const ox = P.cx - o.x, oy = P.cy - o.y, oz = P.cz - o.z;
      const b = 2 * (ox * dx + oy * dy + oz * dz);
      const c = ox * ox + oy * oy + oz * oz - o.r2;
      const disc = b * b - 4 * a * c;
      if (disc <= 0) continue;
      const t = (-b - Math.sqrt(disc)) / (2 * a);
      if (t > 0 && t < 1) return true;
    }
    return false;
  }

  // ---- adaptive curve stroking. evalFn(A, v3) → focus-relative point. rec(ax, ay, aA, bx, by, bA) per drawn piece.
  // Pieces are sorted into depth buckets (near side bright, far side dim) so orbits read as 3D rings, and get an
  // additive glow pass underneath.
  let curEval = null, curRec = null, curFade = false;
  const MARGIN = 300, NB = 5;
  const BUCKET_ALPHA = [1, 0.84, 0.66, 0.5, 0.36];
  const bucketPath = new Array(NB).fill(null), bucketPenX = new Float64Array(NB), bucketPenY = new Float64Array(NB);
  const MID = Array.from({ length: 10 }, () => ({ x: 0, y: 0, z: 0, ok: false, occ: false }));
  function sample(A, o) {
    curEval(A, v3);
    proj(v3[0], v3[1], v3[2]);
    o.x = S.x; o.y = S.y; o.z = S.z; o.ok = S.ok; o.occ = S.ok ? occluded(v3[0], v3[1], v3[2]) : false;
  }
  function segment(aA, ax, ay, az, aok, aocc, bA, bx, by, bz, bok, bocc, level) {
    if (!aok && !bok) return;
    const both = aok && bok;
    if (both && level >= 2) {
      if ((ax < -MARGIN && bx < -MARGIN) || (ax > W + MARGIN && bx > W + MARGIN) || (ay < -MARGIN && by < -MARGIN) || (ay > H + MARGIN && by > H + MARGIN)) return;
    }
    if (level < 9) {
      let split = !both || level < 2;
      const mA = 0.5 * (aA + bA);
      sample(mA, MID[level]);
      const mx = MID[level].x, my = MID[level].y, mz = MID[level].z, mok = MID[level].ok, mocc = MID[level].occ;
      if (!split) {
        if (!mok) split = true;
        else { const ex = mx - 0.5 * (ax + bx), ey = my - 0.5 * (ay + by); if (ex * ex + ey * ey > 0.12 || (aocc !== bocc && level < 7)) split = true; }
      }
      if (split) {
        segment(aA, ax, ay, az, aok, aocc, mA, mx, my, mz, mok, mocc, level + 1);
        segment(mA, mx, my, mz, mok, mocc, bA, bx, by, bz, bok, bocc, level + 1);
        return;
      }
    }
    if (!both || aocc || bocc) return;
    if (Math.abs(ax) > 2e4 || Math.abs(ay) > 2e4 || Math.abs(bx) > 2e4 || Math.abs(by) > 2e4) return;
    let k = 0;
    if (curFade) { const q = (0.5 * (az + bz) / dist - 0.82) / 1.5; k = q <= 0 ? 0 : q >= 1 ? NB - 1 : Math.floor(q * NB); }
    const path = bucketPath[k] || (bucketPath[k] = new Path2D());
    if (bucketPenX[k] !== ax || bucketPenY[k] !== ay) path.moveTo(ax, ay);
    path.lineTo(bx, by);
    bucketPenX[k] = bx; bucketPenY[k] = by;
    if (curRec) curRec(ax, ay, aA, bx, by, bA);
  }
  /** style: { color, width, alpha, dash, halo (dark under-stroke, default true), glow (0..1 additive bloom), fade (depth) } */
  function strokeCurve(evalFn, A0, A1, n, style, rec) {
    if (!(A1 > A0)) return;
    curEval = evalFn; curRec = rec || null; curFade = !!style.fade;
    for (let k = 0; k < NB; k++) { bucketPath[k] = null; bucketPenX[k] = NaN; bucketPenY[k] = NaN; }
    const a = { x: 0, y: 0, z: 0, ok: false, occ: false }, b = { x: 0, y: 0, z: 0, ok: false, occ: false };
    sample(A0, a);
    let aA = A0;
    for (let i = 1; i <= n; i++) {
      const bA = i === n ? A1 : A0 + (A1 - A0) * (i / n);
      sample(bA, b);
      segment(aA, a.x, a.y, a.z, a.ok, a.occ, bA, b.x, b.y, b.z, b.ok, b.occ, 0);
      a.x = b.x; a.y = b.y; a.z = b.z; a.ok = b.ok; a.occ = b.occ; aA = bA;
    }
    const alpha = style.alpha == null ? 1 : style.alpha;
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    for (let k = 0; k < NB; k++) {
      const path = bucketPath[k];
      if (!path) continue;
      const ka = alpha * BUCKET_ALPHA[k];
      ctx.setLineDash(style.dash || []);
      if (style.halo !== false) { ctx.globalAlpha = Math.min(1, ka); ctx.strokeStyle = 'rgba(5,8,12,0.55)'; ctx.lineWidth = style.width + 2; ctx.stroke(path); }
      if (style.glow) {
        ctx.globalCompositeOperation = 'lighter';
        ctx.strokeStyle = style.color;
        ctx.globalAlpha = Math.min(1, ka * style.glow * 0.14); ctx.lineWidth = style.width + 9; ctx.stroke(path);
        ctx.globalAlpha = Math.min(1, ka * style.glow * 0.26); ctx.lineWidth = style.width + 3.5; ctx.stroke(path);
        ctx.globalCompositeOperation = 'source-over';
      }
      ctx.globalAlpha = Math.min(1, ka); ctx.strokeStyle = style.color; ctx.lineWidth = style.width;
      ctx.stroke(path);
    }
    ctx.setLineDash([]); ctx.globalAlpha = 1;
  }

  // ------------------------------------------------------------------------------------------------ labels

  function label(key, x, y, text, cls, prio, placement) {
    labelReq.push({ key, x, y, text, cls, prio, placement: placement || 'below' });
  }
  let panelRects = [], panelRectStamp = -1;
  /** Screen boxes of the visible panels, measured a few times a second (layout reads are not free). */
  function measurePanels() {
    if (!root || Math.abs(realTime - panelRectStamp) < 0.3) return;
    panelRectStamp = realTime;
    panelRects = [];
    const o = root.getBoundingClientRect();
    const outside = root.parentNode ? root.parentNode.querySelectorAll('[data-map-avoid]') : [];   // a host screen's own cards over the map
    for (const p of [...root.querySelectorAll('.map-panel, .map-focusbar, .map-hint'), ...outside]) {
      if (p.classList.contains('sw-hidden') || !p.offsetWidth) continue;
      const r = p.getBoundingClientRect();
      panelRects.push([r.left - o.left - 4, r.top - o.top - 4, r.right - o.left + 4, r.bottom - o.top + 4]);
    }
  }
  function flushLabels() {
    measurePanels();
    labelReq.sort((a, b) => b.prio - a.prio);
    const placed = panelRects.slice();               // pills never slide under a panel
    const ks = uiScale(), kTail = ks === 1 ? '' : ` scale(${ks})`;      // labels grow with the interface size
    for (const e of labelPool.values()) e.used = false;
    for (const r of labelReq) {
      const pill = r.cls.indexOf('pill') >= 0;
      const w = (r.text.length * (pill ? 6.7 : 7.6) + (pill ? 18 : 8)) * ks, h = (pill ? 22 : 18) * ks;
      const off = (r.placement === 'far' ? 26 : 15) * ks;
      const cands = r.placement === 'right' ? [[w / 2 + 12, 0], [0, off], [0, -off], [-w / 2 - 12, 0]]
        : r.placement === 'above' ? [[0, -off], [0, off], [w / 2 + 12, 0], [-w / 2 - 12, 0]]
          : [[0, off], [0, -off], [w / 2 + 12, 0], [-w / 2 - 12, 0]];
      let px = 0, py = 0, ok = false;
      for (const [ox, oy] of cands) {
        px = r.x + ox; py = r.y + oy;
        if (px + w / 2 < 0 || px - w / 2 > W || py + h / 2 < 0 || py - h / 2 > H) continue;
        if (w < W - 12) px = clamp(px, w / 2 + 4, W - w / 2 - 4);                 // a pill near the edge slides back into view
        const x0 = px - w / 2, x1 = px + w / 2, y0 = py - h / 2, y1 = py + h / 2;
        let clash = false;
        for (const q of placed) if (x0 < q[2] && x1 > q[0] && y0 < q[3] && y1 > q[1]) { clash = true; break; }
        if (!clash) { ok = true; placed.push([x0 - 2, y0 - 1, x1 + 2, y1 + 1]); break; }
        if (r.prio >= 1000) { ok = true; break; }
      }
      if (!ok) continue;
      let e = labelPool.get(r.key);
      if (!e) { e = { node: el('div', { class: 'map-label' }), text: '', cls: '', used: false, shown: false }; labelPool.set(r.key, e); labelLayer.appendChild(e.node); }
      e.used = true;
      if (e.text !== r.text) { e.text = r.text; e.node.textContent = r.text; }
      if (e.cls !== r.cls) { e.cls = r.cls; e.node.className = 'map-label ' + r.cls; }
      e.node.style.transform = `translate(${px.toFixed(1)}px,${py.toFixed(1)}px) translate(-50%,-50%)${kTail}`;
      if (!e.shown) { e.shown = true; e.node.style.display = ''; }
    }
    for (const [key, e] of labelPool) {
      if (e.used) continue;
      if (e.shown) { e.shown = false; e.node.style.display = 'none'; }
      else if (labelPool.size > 160) { e.node.remove(); labelPool.delete(key); }
    }
    labelReq = [];
  }

  // ------------------------------------------------------------------------------------------------ glyphs

  function glyphChevron(x, y, ang, size, fill, stroke) {
    const c = Math.cos(ang), s = Math.sin(ang);
    const pts = [[1, 0], [-0.75, -0.72], [-0.28, 0], [-0.75, 0.72]];
    ctx.beginPath();
    pts.forEach(([px, py], i) => { const X = x + (px * c - py * s) * size, Y = y + (px * s + py * c) * size; if (i) ctx.lineTo(X, Y); else ctx.moveTo(X, Y); });
    ctx.closePath();
    ctx.lineJoin = 'round';
    ctx.lineWidth = 3; ctx.strokeStyle = stroke; ctx.stroke();
    ctx.fillStyle = fill; ctx.fill();
  }
  function glyphDiamond(x, y, r, fill, ring) {
    ctx.beginPath(); ctx.moveTo(x, y - r); ctx.lineTo(x + r, y); ctx.lineTo(x, y + r); ctx.lineTo(x - r, y); ctx.closePath();
    ctx.lineJoin = 'round'; ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(8,11,16,0.9)'; ctx.stroke();
    ctx.fillStyle = fill; ctx.fill();
    if (ring) { ctx.beginPath(); ctx.arc(x, y, r + 5, 0, TAU); ctx.lineWidth = 1.5; ctx.strokeStyle = ring; ctx.stroke(); }
  }
  function glyphDot(x, y, r, fill, stroke) {
    ctx.beginPath(); ctx.arc(x, y, r, 0, TAU);
    if (stroke) { ctx.lineWidth = 3; ctx.strokeStyle = stroke; ctx.stroke(); }
    ctx.fillStyle = fill; ctx.fill();
  }
  function glyphTick(x, y, color) {            // apsis / event marker: ring with a core
    ctx.beginPath(); ctx.arc(x, y, 4.5, 0, TAU); ctx.fillStyle = 'rgba(8,11,16,0.9)'; ctx.fill();
    ctx.lineWidth = 1.6; ctx.strokeStyle = color; ctx.stroke();
    ctx.beginPath(); ctx.arc(x, y, 1.6, 0, TAU); ctx.fillStyle = color; ctx.fill();
  }
  function glyphCross(x, y, color) {
    ctx.lineCap = 'round';
    for (const [w, c] of [[5, 'rgba(8,11,16,0.9)'], [2.2, color]]) {
      ctx.beginPath(); ctx.moveTo(x - 5, y - 5); ctx.lineTo(x + 5, y + 5); ctx.moveTo(x + 5, y - 5); ctx.lineTo(x - 5, y + 5);
      ctx.lineWidth = w; ctx.strokeStyle = c; ctx.stroke();
    }
  }

  function glyphTri(x, y, color, up) {          // ascending (up) / descending (down) node
    const k = up ? -1 : 1;
    ctx.beginPath(); ctx.moveTo(x, y + 6 * k); ctx.lineTo(x + 5.5, y - 4 * k); ctx.lineTo(x - 5.5, y - 4 * k); ctx.closePath();
    ctx.lineJoin = 'round'; ctx.lineWidth = 3.2; ctx.strokeStyle = 'rgba(8,11,16,0.9)'; ctx.stroke();
    ctx.fillStyle = 'rgba(8,11,16,0.9)'; ctx.fill(); ctx.lineWidth = 1.6; ctx.strokeStyle = color; ctx.stroke();
  }
  function glyphSoi(x, y, color) {              // sphere-of-influence change: ring broken by an arrow gap
    ctx.beginPath(); ctx.arc(x, y, 5.5, 0, TAU); ctx.fillStyle = 'rgba(8,11,16,0.9)'; ctx.fill();
    ctx.lineWidth = 1.6; ctx.strokeStyle = color; ctx.setLineDash([3.2, 2.2]); ctx.stroke(); ctx.setLineDash([]);
    ctx.beginPath(); ctx.arc(x, y, 1.8, 0, TAU); ctx.fillStyle = color; ctx.fill();
  }
  function glyphApproach(x, y, color, n) {      // closest approach: bracket ring with one or two pips
    ctx.beginPath(); ctx.arc(x, y, 5.5, 0, TAU); ctx.fillStyle = 'rgba(8,11,16,0.9)'; ctx.fill();
    ctx.lineWidth = 1.7; ctx.strokeStyle = color; ctx.stroke();
    ctx.fillStyle = color;
    if (n <= 1) { ctx.beginPath(); ctx.arc(x, y, 1.8, 0, TAU); ctx.fill(); }
    else { ctx.beginPath(); ctx.arc(x - 2.1, y, 1.4, 0, TAU); ctx.arc(x + 2.1, y, 1.4, 0, TAU); ctx.fill(); }
  }
  const colorCache = new Map();
  /** Orbit-line colour of a body: its own hue, lifted so dark worlds still read against space. */
  function orbitColor(body) {
    let c = colorCache.get(body);
    if (c) return c;
    const k = new THREE.Color(body.color);
    const hsl = { h: 0, s: 0, l: 0 }; k.getHSL(hsl);
    k.setHSL(hsl.h, Math.min(0.75, hsl.s * 0.9 + 0.12), clamp(hsl.l, 0.56, 0.72));
    c = '#' + k.getHexString();
    colorCache.set(body, c);
    return c;
  }

  // ------------------------------------------------------------------------------------------------ frame data

  let targets = [];                                // { x, y, r, kind, ref }
  let segs = [];                                   // flat: chain, curveIdx, ax, ay, aA, bx, by, bA
  let chainsDrawn = null;                          // prediction of the highlighted vessel used this frame
  let lastBodyScreen = new Map();
  let nodeScreen = [];                             // { info, x, y, visible }

  function relBody(body, out) {
    const g = gpos.get(body);
    out[0] = g.x - focusG.x; out[1] = g.y - focusG.y; out[2] = g.z - focusG.z;
    return out;
  }

  function updateFocus(w, dt) {
    const ut = w.ut;
    for (const b of SYSTEM.bodies) b.globalPosAt(ut, gpos.get(b));
    // a focused vessel that no longer exists → fall back to its body
    if (!isBody(focusTarget) && !(w.vessels || []).includes(focusTarget)) focusTarget = focusTarget.body || SYSTEM.home;
    if (isBody(focusTarget)) focusG.copy(gpos.get(focusTarget)); else vesselGlobal(focusTarget, focusG);
    if (trans) {
      trans.t += dt / 0.75;
      if (trans.t >= 1) trans = null;
      else { const k = Math.pow(1 - trans.t, 4); focusG.addScaledVector(trans.off, k); }
    }
    const lim = distLimits();
    distTarget = clamp(distTarget, lim[0], lim[1]);
    const k = 1 - Math.exp(-dt * (trans ? 5 : 14));
    dist = Math.exp(Math.log(dist) + (Math.log(distTarget) - Math.log(dist)) * k);
    if (Math.abs(dist / distTarget - 1) < 1e-4) dist = distTarget;
  }

  function distLimits() {
    if (isBody(focusTarget)) return [focusTarget.radius * 1.25, MAX_DIST];
    return [focusTarget.landed ? 2000 : 800, MAX_DIST];
  }

  function defaultDist(t) {
    if (isBody(t)) {
      if (t.type === 'star') { let m = t.radius * 8; for (const c of t.children) m = Math.max(m, c.orbit.apoapsis * 2.35); return m; }
      return t.radius * 7;
    }
    const r = t.pos ? Math.hypot(t.pos.x, t.pos.y, t.pos.z) : t.body.radius * 2;
    if (t.landed) return t.body.radius * 3.2;
    let size = r;
    try { const o = t.getOrbit(lastWorld ? lastWorld.ut : 0); if (!o.hyper && o.apoapsis < t.body.soi) size = Math.max(r, o.apoapsis); } catch { /* keep r */ }
    return Math.min(size * 3.4, Number.isFinite(t.body.soi) ? t.body.soi * 3 : size * 3.4);
  }

  function focus(target, { instant = false, keepDist = false } = {}) {
    if (typeof target === 'string') target = SYSTEM.byId[target] || (lastWorld && (lastWorld.vessels || []).find(v => v.id === target || v.name === target));
    if (!target) return false;
    if (target === focusTarget && !instant) {
      // asking again for the focused body toggles between the close-up and its whole moon system
      if (!keepDist) { const d0 = defaultDist(target); distTarget = isBody(target) && target.children.length && Math.abs(Math.log(distTarget / d0)) < 0.2 ? systemDist(target) : d0; }
      return true;
    }
    const old = focusG.clone();
    focusTarget = target;
    const w = world();
    if (w) {
      for (const b of SYSTEM.bodies) b.globalPosAt(w.ut, gpos.get(b));
      const now = new THREE.Vector3();
      if (isBody(target)) now.copy(gpos.get(target)); else vesselGlobal(target, now);
      trans = instant || !open ? null : { off: old.sub(now), t: 0 };
    }
    if (!keepDist) distTarget = defaultDist(target);
    if (instant || !open) dist = clamp(distTarget, distLimits()[0], MAX_DIST);
    panelTimer = 0;
    return true;
  }
  function cycleFocus(dir) {
    const list = SYSTEM.bodies;
    const cur = isBody(focusTarget) ? focusTarget : focusTarget.body;
    let i = list.indexOf(cur);
    i = isBody(focusTarget) ? (i + dir + list.length) % list.length : i;
    focus(list[i]);
  }
  /** The star with the camera pulled back just far enough for the home planet and the worlds near its orbit. */
  function focusInner() {
    const star = SYSTEM.bodies.find(b => b.type === 'star') || SYSTEM.bodies[0];
    let p = SYSTEM.home; while (p.parent && p.parent !== star) p = p.parent;
    let m = p.orbit ? p.orbit.apoapsis : star.radius * 60;
    for (const c of star.children) if (p.orbit && c.orbit.a <= p.orbit.a * 2.3) m = Math.max(m, c.orbit.apoapsis);
    if (focusTarget !== star) focus(star, { keepDist: true });
    distTarget = clamp(m * 2.5, distLimits()[0], MAX_DIST);
    return true;
  }
  function focusActive() {
    const w = world(); const v = w && (w.active || highlighted(w));
    if (v) focus(v);
  }

  // ------------------------------------------------------------------------------------------------ node editing

  function sortNodes(v) { if (v && Array.isArray(v.nodes)) v.nodes.sort((a, b) => a.t - b.t); }
  function bumpDv(node, axis, amount) {
    if (!node) return;
    node.dv[axis] = Math.round(((node.dv[axis] || 0) + amount) * 1000) / 1000;
    refreshNodePanel(true);
  }
  function selInfo() {
    const w = world(), h = w && highlighted(w), pr = h && preds.get(h);
    if (!pr || !selNode) return null;
    return pr.infos.find(i => i.node === selNode) || null;
  }
  function selPeriod() { const i = selInfo(); const p = i && i.curve ? i.curve.o.period : Infinity; return Number.isFinite(p) ? p : 0; }
  function shiftNodeTime(node, dt) {
    const w = world(), v = w && editable(w);
    if (!node || !v || !dt) return;
    node.t = Math.max(w.ut + 1, node.t + dt);
    sortNodes(v);
    refreshNodePanel(true);
  }
  function burnTime(v, node) {
    const dv = dvMag(node.dv);
    if (!v || !(v.maxThrust > 0) || !(v.mass > 0)) return null;
    return dv * v.mass / v.maxThrust;
  }
  function warpToNode() {
    const w = world(), v = w && editable(w);
    if (!w || !selNode || typeof w.warpTo !== 'function') return;
    const bt = burnTime(v, selNode) || 0;
    const t = selNode.t - bt / 2 - 15;
    if (t > w.ut) w.warpTo(t); else if (app.toast) app.toast('The burn is less than ' + fmt.time(bt / 2 + 15) + ' away.', 'warn');
  }
  function addNode(t) {
    const w = world(), v = w && editable(w);
    if (!v) return null;
    if (!Array.isArray(v.nodes)) v.nodes = [];
    const node = { t, dv: { prograde: 0, normal: 0, radial: 0 } };
    v.nodes.push(node);
    sortNodes(v);
    selectNode(node);
    if (app.audio && app.audio.play) { try { app.audio.play('click'); } catch { /* optional */ } }
    return node;
  }
  function deleteNode(node) {
    const w = world(), v = w && editable(w);
    if (!v || !node) return false;
    const i = v.nodes.indexOf(node);
    if (i < 0) return false;
    v.nodes.splice(i, 1);
    if (selNode === node) selectNode(null);
    return true;
  }
  function stepNode(dir) {
    const w = world(), v = w && editable(w);
    if (!v || !v.nodes.length) return;
    const i = v.nodes.indexOf(selNode);
    selectNode(v.nodes[(i + dir + v.nodes.length) % v.nodes.length]);
  }
  function clearNodes() {
    const w = world(), v = w && editable(w);
    if (!v) return;
    v.nodes.length = 0;
    selectNode(null);
  }
  function selectNode(node) {
    selNode = node || null;
    if (drag && drag.type === 'handle') drag = null;
    refreshNodePanel(true);
  }
  function pruneNodes() {
    const w = world(), v = w && w.active;
    if (!v || !Array.isArray(v.nodes)) return 0;
    let n = 0;
    for (let i = v.nodes.length - 1; i >= 0; i--) if (v.nodes[i].t < w.ut) { if (v.nodes[i] === selNode) selNode = null; v.nodes.splice(i, 1); n++; }
    if (n) refreshNodePanel(true);
    return n;
  }

  function startHandleDrag(h, e) {
    if (e.button !== 0 || !selNode) return;
    e.preventDefault(); e.stopPropagation();
    try { h.node.setPointerCapture(e.pointerId); } catch { /* synthetic */ }
    h.node.classList.add('dragging');
    drag = { type: 'handle', h, sx: e.clientX, sy: e.clientY, mx: e.clientX, my: e.clientY, dx: h.dx, dy: h.dy, pull: 0 };
  }

  // ------------------------------------------------------------------------------------------------ picking

  /** Nearest recorded trajectory point to (x, y) on `chain` whose time lies in (tLo, tHi). */
  function pickOnChain(pr, chain, x, y, tLo, tHi, maxDist) {
    let best = null, bd = maxDist * maxDist;
    const curves = pr.chains[chain];
    if (!curves) return null;
    for (let i = 0; i < segs.length; i += 8) {
      if (segs[i] !== chain) continue;
      const ax = segs[i + 2], ay = segs[i + 3], bx = segs[i + 5], by = segs[i + 6];
      const ex = bx - ax, ey = by - ay, l2 = ex * ex + ey * ey;
      let u = l2 > 0 ? ((x - ax) * ex + (y - ay) * ey) / l2 : 0; u = clamp(u, 0, 1);
      const qx = ax + ex * u, qy = ay + ey * u, d2 = (x - qx) * (x - qx) + (y - qy) * (y - qy);
      if (d2 >= bd) continue;
      const c = curves[segs[i + 1]];
      const A = segs[i + 4] + (segs[i + 7] - segs[i + 4]) * u;
      let t = curveTime(c, A);
      if (c.full) { const Pd = c.o.period; if (t <= tLo) t += Pd * Math.ceil((tLo - t) / Pd + 1e-9); }
      if (!(t > tLo && t < tHi)) continue;
      bd = d2; best = { x: qx, y: qy, t, chain, curve: c };
    }
    return best;
  }
  function chainWindow(w, v, j) {
    const nodes = v.nodes || [];
    return [j === 0 ? w.ut + 5 : nodes[j - 1].t + 1, j < nodes.length ? nodes[j].t - 1 : Infinity];
  }
  function pickHover(x, y) {
    const w = world(), v = w && editable(w), pr = v && preds.get(v);
    if (!pr || pr !== chainsDrawn) return null;
    // a marker under the pointer wins over the orbit line, except the disc of a world drawn large: the line in front
    // of the planet must stay clickable (a low or suborbital arc seen from its own side lies wholly over the disc)
    for (const t of targets) { if (t.kind === 'body' && t.rr > 14) continue; if (Math.hypot(t.x - x, t.y - y) < Math.max(t.r, 10)) return null; }
    let best = null;
    for (let j = pr.chains.length - 1; j >= 0; j--) {
      if (!pr.chains[j] || j > (v.nodes || []).length) continue;
      const [lo, hi] = chainWindow(w, v, j);
      const p = pickOnChain(pr, j, x, y, lo, hi, 13);
      if (p && (!best || Math.hypot(p.x - x, p.y - y) < Math.hypot(best.x - x, best.y - y) - 2)) best = p;
    }
    return best;
  }
  function pickNode(x, y) {
    let best = null, bd = 14;
    for (const n of nodeScreen) { if (!n.visible) continue; const d = Math.hypot(n.x - x, n.y - y); if (d < bd) { bd = d; best = n; } }
    return best;
  }
  function pickTarget(x, y) {
    let best = null, bd = Infinity;
    // small markers (vessels, body dots) win over a large body disc they sit in front of
    for (const t of targets) { const d = Math.hypot(t.x - x, t.y - y); if (d < Math.max(t.r, 12) && Math.max(d - 12, d - t.r) < bd) { bd = Math.max(d - 12, d - t.r); best = t; } }
    return best;
  }

  // ------------------------------------------------------------------------------------------------ input

  function onMouseDown(e) {
    if (!open) return;
    if (e.button === 0) {
      const n = allowNodes ? pickNode(e.x, e.y) : null;
      downAt = { x: e.x, y: e.y, node: n ? n.info.node : null, moved: false };
      if (n) { selectNode(n.info.node); drag = { type: 'node', node: n.info.node }; }
      else drag = { type: 'orbit', button: 0 };
    } else if (e.button === 2 || e.button === 1) { drag = { type: 'orbit', button: e.button }; downR = { x: e.x, y: e.y, moved: false, key: hoverMarkerKey }; }
  }
  function onMouseMove(e) {
    if (!open) return;
    if (downAt && !downAt.moved && Math.hypot(e.x - downAt.x, e.y - downAt.y) > 4) downAt.moved = true;
    if (downR && !downR.moved && Math.hypot(e.x - downR.x, e.y - downR.y) > 4) downR.moved = true;
    if (!drag) return;
    if (drag.type === 'orbit') {
      if (drag.button === 0 && !(downAt && downAt.moved)) return;
      yaw -= e.dx * 0.0055;
      pitch = clamp(pitch + e.dy * 0.0055, -89 * DEG, 89 * DEG);
    } else if (drag.type === 'node' && downAt && downAt.moved) {
      const w = world(), v = w && editable(w), pr = v && preds.get(v);
      if (!pr) return;
      const i = v.nodes.indexOf(drag.node);
      if (i < 0) { drag = null; return; }
      const lo = i === 0 ? w.ut + 2 : v.nodes[i - 1].t + 1, hi = i + 1 < v.nodes.length ? v.nodes[i + 1].t - 1 : Infinity;
      const p = pickOnChain(pr, i, e.x, e.y, lo, hi, 1e4);
      if (p) { drag.node.t = p.t; }
    }
  }
  function onMouseUp(e) {
    if (!open) return;
    if (e.button === 0) {
      const d = downAt; downAt = null;
      if (drag && (drag.type === 'node' || (drag.type === 'orbit' && drag.button === 0))) drag = null;
      if (d && !d.moved && !e.released) {
        if (d.node) return;                         // plain click on a node: already selected
        const h = allowNodes ? pickHover(e.x, e.y) : null;
        if (h) addNode(h.t);
        else { const t = pickTarget(e.x, e.y); if (t) select(t.ref); else { selectNode(null); select(null); } }
      }
    } else {
      if (drag && drag.type === 'orbit' && drag.button === e.button) drag = null;
      // a right-click that did not turn into a drag pins / unpins the marker under the mouse
      if (e.button === 2 && downR && !downR.moved && downR.key) { if (pinned.has(downR.key)) pinned.delete(downR.key); else pinned.add(downR.key); }
      if (e.button === 2) downR = null;
    }
  }
  function onWheel(e) {
    if (!open) return;
    distTarget = clamp(distTarget / e.zoom, distLimits()[0], MAX_DIST);
  }
  function onDblClick(e) {
    if (!open) return;
    const t = pickTarget(e.x, e.y);
    if (t) focus(t.ref);
  }
  function onKeyDown(e) {
    if (!open || e.repeat) return;
    if (e.code === 'Tab') cycleFocus(e.shift ? -1 : 1);
    else if (e.code === 'Backquote') focusActive();
    else if ((e.code === 'Delete' || e.code === 'Backspace') && selNode) deleteNode(selNode);
  }

  // ------------------------------------------------------------------------------------------------ panels

  function kv(rows) {
    const dl = el('dl', { class: 'sw-kv' });
    for (const [k, v, cls] of rows) { dl.appendChild(el('dt', { text: k })); dl.appendChild(el('dd', { text: v, class: cls || '' })); }
    return dl;
  }
  let bodyPanelKey = '';
  function refreshPanels(w) {
    const body = isBody(focusTarget) ? focusTarget : focusTarget.body;
    const fname = isBody(focusTarget) ? focusTarget.name : (focusTarget.name || 'Vessel');
    if (focusName.textContent !== fname) focusName.textContent = fname;
    // no button for a vessel that is not there (the Tracking Station with nothing flying or nothing picked)
    if (focusVesselBtn) { const w0 = world(), none = !(w0 && (w0.active || highlighted(w0))); if (focusVesselBtn._none !== none) { focusVesselBtn._none = none; focusVesselBtn.classList.toggle('sw-hidden', none); } }
    const sci = bodyScience(body);
    const bkey = body.id + '|' + (sci ? sci.earned + '/' + sci.full : '');
    if (bodyPanelKey !== bkey) {
      bodyPanelKey = bkey;
      clear(bodyPanel);
      const kind = body.type === 'star' ? 'Star' : body.type === 'moon' ? 'Moon of ' + body.parent.name : body.gas ? 'Gas giant' : 'Planet';
      bodyPanel.appendChild(el('div', { class: 'sw-row map-panel-head' },
        el('span', { class: 'map-swatch', style: { background: hex(body.color) } }), el('span', { class: 'sw-title', text: body.name }),
        el('span', { class: 'sw-grow' }), el('span', { class: 'sw-chip', text: kind })));
      bodyPanel.appendChild(kv([
        ['Radius', fmt.dist(body.radius)],
        ['Surface gravity', body.surfaceG.toFixed(2) + ' m/s²'],
        ['Atmosphere', body.atmo ? fmt.num(body.atmo.height / 1000, 0) + ' km' + (body.atmo.oxygen ? ' · O₂' : '') : 'None'],
        ['Sphere of influence', Number.isFinite(body.soi) ? fmt.dist(body.soi) : '—'],
        ['Rotation period', fmt.time(body.rotPeriod) + (body.tidal ? ' (locked)' : '')],
        body.orbit ? ['Orbit period', fmt.time(body.orbit.period)] : null,
        body.orbit ? ['Orbit radius', fmt.dist(body.orbit.a)] : null,
        sci ? ['Science gathered', sci.full > 0 ? fmt.num(sci.earned, 1) + ' / ' + fmt.num(sci.full, 0) : '—', 'sci'] : null,
      ].filter(Boolean)));
      if (sci && sci.full > 0) bodyPanel.appendChild(el('div', { class: 'map-bar' }, el('i', { style: { width: Math.round(100 * clamp(sci.earned / sci.full, 0, 1)) + '%' } })));
      if (body.biomes && body.biomes.length) {
        bodyPanel.appendChild(el('div', { class: 'sw-label map-sub', text: 'Biomes' }));
        bodyPanel.appendChild(el('div', { class: 'map-biomes' }, body.biomes.map(b => el('span', { class: 'sw-chip', text: b.name }))));
      }
    }
    // vessel orbit panel
    const v = opts.orbitPanel === false ? null : highlighted(w);
    if (!v) { orbitPanel.classList.add('sw-hidden'); }
    else {
      orbitPanel.classList.remove('sw-hidden');
      clear(orbitPanel);
      orbitPanel.appendChild(el('div', { class: 'sw-row map-panel-head' }, el('span', { class: 'map-chev' }), el('span', { class: 'sw-title', text: v.name || 'Vessel' }),
        el('span', { class: 'sw-grow' }), el('span', { class: 'sw-chip teal', text: v.body.name })));
      if (v.landed) orbitPanel.appendChild(el('div', { class: 'sw-dim', text: 'On the surface of ' + v.body.name + '.' }));
      else {
        let o = null; try { o = v.getOrbit(w.ut); } catch { o = null; }
        if (o) {
          const R = v.body.radius, tAp = o.timeToApoapsis(w.ut), tPe = o.timeToPeriapsis(w.ut);
          orbitPanel.appendChild(kv([
            ['Apoapsis', o.hyper ? 'Escape' : fmt.dist(o.apoapsis - R), 'ap'],
            ['Periapsis', fmt.dist(o.periapsis - R), 'pe'],
            ['Time to Ap', Number.isFinite(tAp) ? fmt.time(tAp) : '—'],
            ['Time to Pe', Number.isFinite(tPe) && tPe >= 0 ? fmt.time(tPe) : '—'],
            ['Period', Number.isFinite(o.period) ? fmt.time(o.period) : '—'],
            ['Inclination', (o.inclination / DEG).toFixed(2) + '°'],
            ['Eccentricity', o.e.toFixed(4)],
          ]));
        }
      }
    }
    refreshTargetPanels(w);
    refreshTransfer(w);
    refreshNodePanel(false);
    // a busy left column: fold the body card down to its headline rows
    const busy = (!selPanel.classList.contains('sw-hidden') ? 1 : 0) + (!targetPanel.classList.contains('sw-hidden') ? 1 : 0) + (!transferPanel.classList.contains('sw-hidden') ? 1 : 0);
    bodyPanel.classList.toggle('compact', busy >= 2 || (busy >= 1 && H < 860) || (!allowNodes && W < 1100 && !isBody(focusTarget)));   // narrow tracking lane: a craft is the subject
  }

  /** Science banked for a body so far vs everything its experiments could yield (career data; null without a career). */
  function bodyScience(body) {
    const career = app.career;
    if (!career || !career.scienceLog || body.type === 'star') return null;
    let earned = 0, full = 0;
    const tag = '@' + body.id + ':';
    for (const k in career.scienceLog) if (k.indexOf(tag) >= 0) earned += career.scienceLog[k] || 0;
    if (typeof career.scienceValue === 'function') {
      try { for (const id in EXPERIMENTS) for (const sit of SITUATIONS) { const v = career.scienceValue(id, body, sit); if (v && v.valid) full += v.full; } } catch { full = 0; }
    }
    return { earned: Math.round(earned * 10) / 10, full: Math.round(full) };
  }

  const setText = (node, text) => { if (node.textContent !== text) node.textContent = text; };
  const caText = (a, ut) => fmt.dist(a.distance) + (a.t - ut < 1 ? ' now' : ' in ' + fmt.time(a.t - ut));
  function refreshTargetPanels(w) {
    if (!selPanel || !targetPanel) return;
    const a = w.active || null, tgt = targetOf(w);
    if (selObj && selObj.kind === 'vessel' && (!(w.vessels || []).includes(selObj.ref) || selObj.ref.dead)) selObj = null;
    selPanel.classList.toggle('sw-hidden', !selObj);
    if (selObj) {
      const o = selObj.ref, body = selObj.kind === 'body';
      setText(selUi.title, o.name || 'Vessel');
      selUi.swatch.style.background = body ? hex(o.color) : ROLE_COLORS[roleOf(o)] || '#aab5c2';
      setText(selUi.chip, body ? (o.type === 'star' ? 'Star' : o.type === 'moon' ? 'Moon' : 'Planet') : o === a ? 'Active' : roleName(roleOf(o)));
      let info = body ? (o.parent ? 'Orbits ' + o.parent.name : 'Centre of the system') : (o.landed ? 'Landed on ' : 'In flight at ') + o.body.name;
      if (!body && !o.landed && o.pos) info += ' · ' + fmt.dist(Math.hypot(o.pos.x, o.pos.y, o.pos.z) - o.body.radius) + ' up';
      if (a && o !== a) {
        vesselGlobal(a, tmpV);
        if (body) tmpV2.copy(gpos.get(o)); else vesselGlobal(o, tmpV2);
        info += ' · ' + fmt.dist(Math.max(0, tmpV.distanceTo(tmpV2) - (body ? o.radius : 0))) + ' away';
      }
      setText(selUi.info, info);
      const can = !!a && o !== a;
      selUi.set.classList.toggle('sw-hidden', !can);
      selUi.set.disabled = o === tgt;
      setText(selUi.set, o === tgt ? 'Targeted' : 'Set as target');
    }
    targetPanel.classList.toggle('sw-hidden', !tgt);
    if (tgt) {
      setText(tgtUi.title, tgt.name || 'Vessel');
      const ti = a.targetInfo;
      let d = NaN, rs = NaN;
      if (ti && Number.isFinite(ti.distance)) { d = ti.distance; rs = ti.relSpeed; }
      else {
        vesselGlobal(a, tmpV);
        if (isBody(tgt)) {
          tmpV2.copy(gpos.get(tgt)); d = tmpV.distanceTo(tmpV2);
          try {                                            // speed relative to the world, both taken in the star's frame
            const vb = tgt.globalVelAt(w.ut, new THREE.Vector3()), va = a.body.globalVelAt(w.ut, new THREE.Vector3());
            if (a.vel) rs = Math.hypot(va.x + a.vel.x - vb.x, va.y + a.vel.y - vb.y, va.z + a.vel.z - vb.z);
          } catch { rs = NaN; }
        }
        else { vesselGlobal(tgt, tmpV2); d = tmpV.distanceTo(tmpV2); if (tgt.body === a.body && a.vel && tgt.vel) rs = Math.hypot(a.vel.x - tgt.vel.x, a.vel.y - tgt.vel.y, a.vel.z - tgt.vel.z); }
      }
      setText(tgtUi.dist, fmt.dist(d));
      setText(tgtUi.speed, Number.isFinite(rs) ? fmt.num(rs, rs < 100 ? 1 : 0) + ' m/s' : '—');
      const base = approaches.find(q => q.chain === 0 && q.rank === 0), second = approaches.find(q => q.chain === 0 && q.rank === 1);
      let plan = null; for (const q of approaches) if (q.chain > 0 && q.rank === 0) plan = q;
      const enc = !base && isBody(tgt) ? encounterWith(w, tgt) : null;
      setText(tgtUi.caLabel, enc ? 'Encounter' : 'Approach');
      setText(tgtUi.caSpeedLabel, enc ? 'Periapsis' : '↳ speed');
      if (enc) {
        setText(tgtUi.ca, enc.t - w.ut < 1 ? 'now' : 'in ' + fmt.time(enc.t - w.ut));
        setText(tgtUi.caSpeed, enc.next ? fmt.dist(enc.next.o.periapsis - tgt.radius) : '—');
      } else {
        setText(tgtUi.ca, base ? caText(base, w.ut) : '—');
        setText(tgtUi.caSpeed, base ? fmt.num(base.relSpeed, base.relSpeed < 100 ? 1 : 0) + ' m/s' : '—');
      }
      setText(tgtUi.inc, Number.isFinite(relInc) ? (relInc / DEG).toFixed(2) + '°' : '—');
      tgtUi.ca2Label.classList.toggle('sw-hidden', !second); tgtUi.ca2.classList.toggle('sw-hidden', !second);
      if (second) setText(tgtUi.ca2, caText(second, w.ut));
      tgtUi.planLabel.classList.toggle('sw-hidden', !plan); tgtUi.plan.classList.toggle('sw-hidden', !plan);
      if (plan) setText(tgtUi.plan, caText(plan, w.ut));
    }
  }

  /** Closest approaches (two intercepts) and AN / DN of each drawn chain of the active vessel relative to its target
   *  (cached; recomputed about once a second). */
  function refreshApproaches(w) {
    const a = w.active, hl = highlighted(w), pr = hl && preds.get(hl), tgt = a && targetOf(w);
    if (!a || hl !== a || !pr || !tgt || a.landed) { approaches = []; relNodeMarks = []; relInc = NaN; caPr = null; return; }
    const bucket = Math.floor(realTime);
    if (caPr === pr && caSig === pr.sig && caTgt === tgt && caBucket === bucket) return;
    caPr = pr; caSig = pr.sig; caTgt = tgt; caBucket = bucket;
    approaches = []; relNodeMarks = []; relInc = NaN;
    const ut = w.ut, body = isBody(tgt);
    let ref = null, to = null;
    if (body) { ref = tgt.parent; to = tgt.orbit; }
    else if (!tgt.landed) { ref = tgt.body; try { to = tgt.getOrbit(ut); } catch { to = null; } }
    if (!ref || !to) return;
    for (let j = 0; j < pr.chains.length; j++) {
      const ch = pr.chains[j];
      if (!ch) continue;
      if (j > 0 && (!pr.infos[j - 1] || dvMag(pr.infos[j - 1].node.dv) < 1e-4)) continue;
      const nx = pr.infos[j];
      const hi = nx && nx.valid && dvMag(nx.node.dv) >= 1e-4 ? nx.node.t : Infinity;
      // relative nodes on the first patch around the target's parent
      for (const c of ch) {
        if (c.body !== ref) continue;
        const t0 = Math.max(c.patch.tStart, ut), t1 = Math.min(c.patch.tEnd, hi, c.full ? t0 + c.o.period : Infinity);
        try {
          const rn = relativeNodes(c.o, to, t0);
          if (j === 0 || !Number.isFinite(relInc)) relInc = rn.relInc;
          if (rn.relInc > 0.0005) for (const kind of ['an', 'dn']) { const n = rn[kind]; if (n && n.t >= t0 && n.t <= t1) relNodeMarks.push({ chain: j, curve: c, kind, t: n.t, relInc: rn.relInc, visible: false }); }
        } catch { /* degenerate geometry */ }
        break;
      }
      // a body whose SOI the trajectory enters already gets the encounter markers
      if (body && ch.some(c => c.body === tgt || (c.patch.endType === 'enter' && c.patch.nextBody === tgt && c.patch.tEnd <= hi))) continue;
      let found = [];
      for (const c of ch) {
        if (c.body !== ref) continue;
        const t0 = Math.max(c.patch.tStart, ut), Pv = c.o.period, Pt = to.period;
        const span = Math.max(Number.isFinite(Pv) ? Pv : 0, Number.isFinite(Pt) ? Pt : 0);
        const t1 = Math.min(c.patch.tEnd, hi, span > 0 ? t0 + span : Infinity);
        if (!(t1 > t0) || !Number.isFinite(t1)) continue;
        let list = [];
        try { list = findApproaches(c.o, to, t0, t1, { max: 6 }); } catch { list = []; }
        for (const ca of list) if (Number.isFinite(ca.distance)) found.push({ chain: j, curve: c, orbit: to, t: ca.t, distance: ca.distance, relSpeed: ca.relSpeed, rank: 0, x: 0, y: 0, visible: false });
      }
      if (!found.length) continue;
      found.sort((p, q) => p.distance - q.distance);
      const best = found[0];
      approaches.push(best);
      // the second intercept: the next-closest minimum at a clearly different place on the orbit
      const p0 = best.curve.o.posAt(best.t, tmpV).clone().normalize();
      for (let i = 1; i < found.length; i++) {
        const q = found[i];
        if (q.distance > 0.35 * to.a && q.distance > 3 * best.distance) break;
        const p1 = q.curve.o.posAt(q.t, tmpV2).normalize();
        if (q.curve === best.curve && p0.dot(p1) > 0.94) continue;      // same crossing, one revolution later
        q.rank = 1; approaches.push(q);
        break;
      }
    }
  }

  function refreshNodePanel(force) {
    if (!nodePanel) return;
    const w = world(), v = w && editable(w);
    if (!selNode || !v || !v.nodes.includes(selNode)) { nodePanel.classList.add('sw-hidden'); return; }
    nodePanel.classList.remove('sw-hidden');
    const i = v.nodes.indexOf(selNode);
    nodeUi.title.textContent = v.nodes.length > 1 ? 'Burn ' + (i + 1) + ' / ' + v.nodes.length : 'Maneuver';
    nodeUi.total.textContent = fmt.num(dvMag(selNode.dv), 1) + ' m/s';
    for (const axis of ['prograde', 'normal', 'radial']) {
      const f = nodeUi.fields[axis];
      if (document.activeElement !== f || force === 'all') { const s = (selNode.dv[axis] || 0).toFixed(2); if (f.value !== s) f.value = s; }
    }
    nodeUi.tminus.textContent = 'T−' + fmt.time(Math.max(0, selNode.t - w.ut));
    const bt = burnTime(v, selNode);
    nodeUi.burn.textContent = bt == null ? '—' : fmt.time(bt);
    const per = selPeriod();
    nodeUi.orbitMinus.disabled = !per || selNode.t - per < w.ut + 1; nodeUi.orbitPlus.disabled = !per;
    nodeUi.warp.disabled = typeof w.warpTo !== 'function';
    // result summary
    const pr = preds.get(v), ch = pr && pr.chains[i + 1], c = ch && ch[0];
    let txt = '';
    if (c) {
      const R = c.body.radius, o = c.o;
      txt = 'After burn: ' + (o.hyper ? 'escape' : 'Ap ' + fmt.dist(o.apoapsis - R)) + ' · Pe ' + fmt.dist(o.periapsis - R);
      const last = ch[ch.length - 1];
      for (const cc of ch) if (cc.patch.endType === 'enter') { txt += ' · ' + cc.patch.nextBody.name + ' encounter'; break; }
      if (last.patch.endType === 'impact') txt += ' · impact'; else if (last.patch.endType === 'atmo') txt += ' · atmosphere entry';
    } else if (pr && pr.infos[i] && !pr.infos[i].valid) txt = 'This node is beyond the predicted trajectory.';
    if (nodeUi.result.textContent !== txt) nodeUi.result.textContent = txt;
  }

  // ------------------------------------------------------------------------------------------------ update

  function update(dt) {
    if (!open) return;
    const w = world();
    if (!w) return;
    lastWorld = w;
    realTime += dt;
    if (selNode) { const v = editable(w); if (!v || !v.nodes.includes(selNode)) selNode = null; }
    // continuous handle drag: rate grows with the square of the pull distance (fine control near the centre)
    if (drag && drag.type === 'handle' && selNode) {
      const pull = (drag.mx - drag.sx) * drag.dx + (drag.my - drag.sy) * drag.dy;
      drag.pull = pull;
      const a = Math.max(0, Math.abs(pull) - 3);
      const rate = Math.sign(pull) * Math.min(400, 0.008 * a * a);
      if (rate) {
        const def = drag.h.def;
        selNode.dv[def.axis] = (selNode.dv[def.axis] || 0) + def.sign * rate * dt;
      }
    }
    updateFocus(w, dt);
    refreshPredictions(w);
    refreshApproaches(w);
    panelTimer -= dt;
    if (panelTimer <= 0) { panelTimer = 0.2; refreshPanels(w); }
  }

  // ------------------------------------------------------------------------------------------------ render

  const tmpV = new THREE.Vector3(), tmpV2 = new THREE.Vector3();
  const rb = [0, 0, 0];

  function render() {
    if (!open) return;
    const w = world();
    if (!w) return;
    const ut = w.ut;
    setupProjection();
    const inv = 1 / dist;

    // ---- three.js: bodies, SOI shells, light
    const focusBodyNow = isBody(focusTarget) ? focusTarget : focusTarget.body;
    occluders = [];
    const bodyScreen = new Map();
    lastBodyScreen = bodyScreen;
    for (const body of SYSTEM.bodies) {
      const e = visuals.get(body);
      relBody(body, rb);
      const d = Math.hypot(rb[0] - P.cx, rb[1] - P.cy, rb[2] - P.cz);
      proj(rb[0], rb[1], rb[2]);
      const rs = d > body.radius ? P.fl * body.radius / Math.sqrt(d * d - body.radius * body.radius) : 1e6;
      bodyScreen.set(body, { x: S.x, y: S.y, ok: S.ok, rs, d, rx: rb[0], ry: rb[1], rz: rb[2] });
      if (rs > 1.2) occluders.push({ x: rb[0], y: rb[1], z: rb[2], r2: body.radius * body.radius * 0.985 });
      if (e) {
        const g = e.vis.group;
        g.visible = rs > 0.6 || body.type === 'star';
        g.position.set(rb[0] * inv, rb[1] * inv, rb[2] * inv);
        g.scale.setScalar(body.radius * inv);
        if (body.type === 'star') sunLight.position.copy(g.position);
        else { const gp = gpos.get(body); tmpV.set(-gp.x, -gp.y, -gp.z).normalize(); }
        try { e.vis.update(ut, body.type === 'star' ? null : tmpV); } catch { /* visual without update */ }
        if (e.soi) {
          const ss = d > body.soi ? P.fl * body.soi / Math.sqrt(d * d - body.soi * body.soi) : 0;
          const a = ss ? sstep(10, 40, ss) * (1 - sstep(H * 0.9, H * 2.2, ss)) : 0;
          e.soi.visible = a > 0.01;
          if (e.soi.visible) { e.soi.position.copy(g.position); e.soi.scale.setScalar(body.soi * inv); e.soi.material.opacity = 0.055 * a; }
          bodyScreen.get(body).soiR = ss; bodyScreen.get(body).soiA = a;
        }
      }
    }
    // the body being looked at up close gets the full-size texture (baked in the background, cached by planetgfx)
    if (focusBodyNow && !hiRes.has(focusBodyNow)) {
      const q = bodyScreen.get(focusBodyNow), e = visuals.get(focusBodyNow);
      if (q && q.rs > 140 && e && typeof e.vis.setTextureSize === 'function') { hiRes.add(focusBodyNow); try { e.vis.setTextureSize(2048, 1024); } catch { /* keeps the small one */ } }
    }
    if (starfield) starfield.position.copy(camera.position);
    if (sky) sky.mesh.position.copy(camera.position);
    const r = app.renderer;
    if (r) {
      r.setRenderTarget(null);
      r.setClearColor(0x05080c, 1);
      r.render(scene, camera);
    }

    // ---- 2D overlay
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    targets = []; segs = []; nodeScreen = []; markers = [];
    const focusBody = isBody(focusTarget) ? focusTarget : null;
    const tgt = targetOf(w);

    // the star's glare, in screen space so it reads at any zoom
    {
      const ss = bodyScreen.get(SYSTEM.star);
      if (ss && ss.ok && ss.rs < H * 0.6 && ss.x > -200 && ss.x < W + 200 && ss.y > -200 && ss.y < H + 200) {
        const R = clamp(ss.rs * 3.2, 46, 150);
        ctx.globalCompositeOperation = 'lighter';
        const g = ctx.createRadialGradient(ss.x, ss.y, 0, ss.x, ss.y, R);
        g.addColorStop(0, 'rgba(255,236,190,0.75)'); g.addColorStop(0.12, 'rgba(255,214,140,0.38)'); g.addColorStop(0.4, 'rgba(255,170,90,0.1)'); g.addColorStop(1, 'rgba(255,150,70,0)');
        ctx.fillStyle = g; ctx.beginPath(); ctx.arc(ss.x, ss.y, R, 0, TAU); ctx.fill();
        for (const [len, th, a] of [[R * 2.3, 1.1, 0.22], [R * 1.2, 2.4, 0.12]]) {       // thin horizontal streak
          const sg = ctx.createLinearGradient(ss.x - len, 0, ss.x + len, 0);
          sg.addColorStop(0, 'rgba(255,220,160,0)'); sg.addColorStop(0.5, `rgba(255,230,180,${a})`); sg.addColorStop(1, 'rgba(255,220,160,0)');
          ctx.fillStyle = sg; ctx.fillRect(ss.x - len, ss.y - th, len * 2, th * 2);
        }
        ctx.globalCompositeOperation = 'source-over';
      }
    }

    // body orbit lines
    for (const body of SYSTEM.bodies) {
      if (!body.orbit) continue;
      const o = body.orbit, ps = bodyScreen.get(body.parent), bs = bodyScreen.get(body);
      const sizePx = P.fl * o.a / Math.max(ps.d, dist * 0.2);
      if (sizePx < 9) continue;
      const fade = sstep(0.0006, 0.006, dist / o.a) * sstep(9, 22, sizePx);
      if (fade < 0.02) continue;
      const px = ps.rx, py = ps.ry, pz = ps.rz;
      const A0 = o.anomalyAt(ut);
      strokeCurve((A, out) => { conicPoint(o, A, out); out[0] += px; out[1] += py; out[2] += pz; }, A0, A0 + TAU, 128,
        { color: orbitColor(body), width: body.type === 'moon' ? 1.1 : 1.3, alpha: (body === focusBody || body === hoverBody ? 0.95 : 0.7) * fade, halo: false, fade: true, glow: 0.8 });
      bs.orbitPx = sizePx;
      if (body === tgt) strokeCurve((A, out) => { conicPoint(o, A, out); out[0] += px; out[1] += py; out[2] += pz; }, A0, A0 + TAU, 128,
        { color: TARGET_COLOR, width: 1.7, alpha: 0.9, halo: false, fade: true, glow: 1 });
    }
    // SOI rims
    for (const body of SYSTEM.bodies) {
      const bs = bodyScreen.get(body);
      if (!bs.ok || !bs.soiA || bs.soiA < 0.02) continue;
      ctx.beginPath(); ctx.arc(bs.x, bs.y, bs.soiR, 0, TAU);
      ctx.setLineDash([2, 5]); ctx.lineWidth = 1; ctx.globalAlpha = 0.35 * bs.soiA; ctx.strokeStyle = hex(body.color); ctx.stroke();
      ctx.setLineDash([]); ctx.globalAlpha = 1;
    }

    // trajectories
    const hl = highlighted(w);
    const mouse = input ? input.mouse : { x: -1e4, y: -1e4, over: false };
    const vessels = w.vessels || [];
    const crowded = vessels.length > 24;
    for (const v of vessels) {
      if (v === hl || v.landed) continue;
      const pr = preds.get(v), ch = pr && pr.chains[0];
      if (!ch) continue;
      const isHover = v === hoverVessel || v === focusTarget || (selObj && selObj.ref === v);
      if (v === tgt) { drawChain(ch, ut, [TARGET_COLOR], { width: 1.6, alpha: 0.9, halo: false, glow: 1, fade: true }, -1, true); continue; }
      if (crowded && !isHover && !(selObj && selObj.ref === v)) continue;      // dozens of vessels: only show orbits on demand
      drawChain(ch, ut, [isHover ? '#dbe4ee' : v.type === 'debris' ? '#77828f' : '#9aa8b8'], { width: isHover ? 1.4 : 1.1, alpha: v.type === 'debris' ? (isHover ? 0.7 : 0.24) : (isHover ? 0.9 : 0.45), halo: false, fade: true, glow: isHover ? 0.8 : 0 }, -1, true);
    }
    chainsDrawn = null;
    const hlPr = hl && preds.get(hl);
    if (hlPr) {
      chainsDrawn = hlPr;
      const live = hl === w.active;
      if (hlPr.chains[0]) {
        drawChain(hlPr.chains[0], ut, BASE_COLORS, { width: 2, alpha: 1, glow: 1.25 }, 0, true);
        markChain(hlPr.chains[0], ut, 'b', '', true, BASE_COLORS);
      }
      for (let j = 1; j < hlPr.chains.length; j++) {
        const ch = hlPr.chains[j], info = hlPr.infos[j - 1];
        if (!ch || !info) continue;
        const cols = PLAN_COLORS[(j - 1) % PLAN_COLORS.length];
        const zero = dvMag(info.node.dv) < 1e-4;
        drawChain(ch, ut, cols, { width: 1.8, alpha: zero ? 0 : 1, dash: [7, 5], glow: zero ? 0 : 0.9 }, j, false);
        if (!zero) markChain(ch, ut, 'p' + j, ' plan', false, cols);
      }
      void live;
      drawApproaches(ut);
    }

    // bodies: dots + labels + pick targets
    for (const body of SYSTEM.bodies) {
      const bs = bodyScreen.get(body);
      if (!bs.ok) continue;
      let hideLabel = false;
      if (body.parent) {
        const ps = bodyScreen.get(body.parent);
        const sep = Math.hypot(bs.x - ps.x, bs.y - ps.y);
        if (ps.ok && sep < Math.max(16, ps.rs + 8) && body !== focusBody) { if (body.type === 'moon' && (sep < 7 || bs.rs < 2)) continue; hideLabel = true; }
        else if (ps.ok && sep < (body.type === 'moon' ? 34 : 14) && body !== focusBody) hideLabel = true;
      }
      const min = body.type === 'star' ? 4.5 : body.type === 'moon' ? 2.6 : 3.6;
      const hot = body === hoverBody;
      if (bs.rs < min) {
        const oc = orbitColor(body);
        const gr = body.type === 'star' ? 20 : min * 3.4;
        const g = ctx.createRadialGradient(bs.x, bs.y, 0, bs.x, bs.y, gr);
        g.addColorStop(0, body.type === 'star' ? 'rgba(255,225,150,0.6)' : oc + '77'); g.addColorStop(1, body.type === 'star' ? 'rgba(255,225,150,0)' : oc + '00');
        ctx.globalCompositeOperation = 'lighter'; ctx.fillStyle = g; ctx.beginPath(); ctx.arc(bs.x, bs.y, gr, 0, TAU); ctx.fill(); ctx.globalCompositeOperation = 'source-over';
        glyphDot(bs.x, bs.y, min, body.type === 'star' ? '#ffe9b0' : oc, 'rgba(8,11,16,0.85)');
        ctx.beginPath(); ctx.arc(bs.x, bs.y, min + 2.8, 0, TAU); ctx.lineWidth = 1; ctx.strokeStyle = hot ? 'rgba(232,238,244,0.85)' : 'rgba(232,238,244,0.3)'; ctx.stroke();
      }
      const rr = Math.max(bs.rs, min);
      if (body === tgt) bracketMark(bs.x, bs.y, Math.min(rr, 4000) + 7, TARGET_COLOR);
      else if (selObj && selObj.ref === body) ringMark(bs.x, bs.y, Math.min(rr, 4000) + 6, 'rgba(232,238,244,0.8)', true);
      if (bs.x > -rr && bs.x < W + rr && bs.y > -rr && bs.y < H + rr) targets.push({ x: bs.x, y: bs.y, r: Math.min(rr, 4000) + 4, rr, kind: 'body', ref: body });
      if (!hideLabel && rr < H * 0.45) {
        label('body:' + body.id, bs.x, bs.y + Math.min(rr, H) , body.name, 'body' + (body === focusBody ? ' focus' : '') + (body.type === 'moon' ? ' moon' : body.type === 'star' ? ' star' : ''),
          hot ? 95 : body === focusBody ? 90 : body === tgt ? 88 : body === SYSTEM.home ? 62 : body.type === 'star' ? 60 : body.type === 'planet' ? 40 + Math.min(15, Math.log10(body.orbit.a) - 9) * 1 + (body.radius > 3e5 ? 4 : 0) : 30, 'below');
      }
    }

    // landing sites on the home world: the Return Pad by the launch site and the barge out at sea, once the globe is
    // drawn large enough to tell them apart (the barge is 40 km from the pad: a sixteenth of the radius)
    { const hb = SYSTEM.home, hs = bodyScreen.get(hb), sites = hb.sites;
      if (sites && hs && hs.ok && hs.rs > 110) {
        relBody(hb, rb);
        for (const [id, st] of [['landing', sites.landing], ['barge', sites.barge], ['tower', sites.tower]]) {
          if (!st) continue;
          hb.surfaceDirToInertial(st.dir, ut, tmpV2).multiplyScalar(hb.radius + (st.top || 0));
          const x = rb[0] + tmpV2.x, y = rb[1] + tmpV2.y, z = rb[2] + tmpV2.z;
          // (not drawn when it is round the far side of the globe)
          if (tmpV2.x * (P.cx - x) + tmpV2.y * (P.cy - y) + tmpV2.z * (P.cz - z) <= 0 || !proj(x, y, z)) continue;
          if (S.x < -20 || S.x > W + 20 || S.y < -20 || S.y > H + 20) continue;
          glyphTick(S.x, S.y, id === 'barge' ? '#7fd8ff' : id === 'tower' ? '#c9a6ff' : '#f2c14e');
          mark('site:' + id, S.x, S.y, st.name, id === 'barge' ? 'landing barge, ' + Math.round(Math.acos(Math.min(1, st.dir.dot(sites.pad.dir))) * hb.radius / 1000) + ' km downrange' : id === 'tower' ? 'launch mount and catch arms for a stage with catch pins' : 'where a booster flying back lands', 'pill soi', 58, id === 'landing' ? 'below' : 'above');
        }
      }
    }
    // vessels: role icons (badges), pins for landed craft and flags
    for (const v of vessels) {
      vesselGlobal(v, tmpV2);
      const x = tmpV2.x - focusG.x, y = tmpV2.y - focusG.y, z = tmpV2.z - focusG.z;
      if (!proj(x, y, z)) continue;
      const sx = S.x, sy = S.y;
      if (sx < -20 || sx > W + 20 || sy < -20 || sy > H + 20) continue;
      const isHl = v === hl, isActive = v === w.active, isTgt = v === tgt, isSel = !!selObj && selObj.ref === v;
      const vb = bodyScreen.get(v.body);
      const onDot = vb && vb.ok && vb.rs < 6 && Math.hypot(sx - vb.x, sy - vb.y) < 9;   // lost in its body's dot
      if (onDot && !isHl && v !== focusTarget) continue;
      const hidden = occluded(x, y, z);
      const role = roleOf(v);
      const emph = isHl || isTgt || isSel || v === focusTarget || v === hoverVessel;
      const col = isHl ? (isActive ? '#39d0c0' : '#e8eef4') : isTgt ? TARGET_COLOR : ROLE_COLORS[role] || '#b9c6d3';
      const size = emph ? 6.4 : role === 'debris' ? 4.2 : 5.4;
      const alpha = hidden ? 0.3 : role === 'debris' && !emph ? 0.62 : 1;
      let ix = sx, iy = sy;
      if (v.landed || role === 'flag') {
        iy = sy - 17;
        ctx.globalAlpha = alpha;
        ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(sx, iy + size); ctx.lineWidth = 3.2; ctx.strokeStyle = 'rgba(8,11,16,0.9)'; ctx.stroke();
        ctx.lineWidth = 1.4; ctx.strokeStyle = col; ctx.stroke();
        glyphDot(sx, sy, 1.8, col, null);
        ctx.globalAlpha = 1;
      } else if (isHl && v.vel) {
        // prograde tick outside the badge
        const sp = Math.hypot(v.vel.x, v.vel.y, v.vel.z) || 1, L = dist * 0.02 / sp;
        if (proj(x + v.vel.x * L, y + v.vel.y * L, z + v.vel.z * L) && Math.hypot(S.x - sx, S.y - sy) > 0.5) {
          const ang = Math.atan2(S.y - sy, S.x - sx);
          ctx.globalAlpha = alpha;
          glyphChevron(sx + Math.cos(ang) * 15.5, sy + Math.sin(ang) * 15.5, ang, 4.6, col, 'rgba(8,11,16,0.92)');
          ctx.globalAlpha = 1;
        }
      }
      drawIcon(ctx, role, ix, iy, size, col, { badge: role !== 'debris' || emph, alpha, ring: emph ? col : null });
      if (isTgt) bracketMark(ix, iy, 13.5, TARGET_COLOR);
      else if (isSel) ringMark(ix, iy, 13, 'rgba(232,238,244,0.8)', true);
      if (!onDot) targets.push({ x: ix, y: iy, r: 11, rr: 11, kind: 'vessel', ref: v });
      // at system scale the craft sits on top of its world's marker: the world's name is enough there
      const bq = lastBodyScreen.get(v.body);
      const lost = bq && v !== focusTarget && v !== hoverVessel && Math.hypot(bq.x - ix, bq.y - iy) < 12;
      if (!lost && (isHl || v === focusTarget || isTgt || isSel)) label('ves:' + v.id, ix, iy - 6, v.name || 'Vessel', 'vessel' + (isHl ? ' active' : isTgt ? ' target' : ''), isTgt ? 72 : 70, 'above');
    }

    // what is under the mouse → hover card, orbit highlight
    {
      const t = mouse.over && !drag ? pickTarget(mouse.x, mouse.y) : null;
      hoverVessel = t && t.kind === 'vessel' ? t.ref : null;
      hoverBody = t && t.kind === 'body' ? t.ref : null;
      const show = t && (t.kind === 'vessel' || t.rr < 70) ? t : null;
      updateCard(w, show, mouse);
      let mk = null, md = 13;
      if (mouse.over && !drag) for (const m of markers) { const d = Math.hypot(m.x - mouse.x, m.y - mouse.y); if (d < md) { md = d; mk = m.key; } }
      hoverMarkerKey = mk;
    }

    // maneuver nodes + gizmo
    let selScreen = null;
    if (hlPr && allowNodes) {
      for (const info of hlPr.infos) {
        if (!info.valid) continue;
        const px = curvePx(info.curve);
        if (px < 12 && info.node !== selNode) continue;
        relBody(info.body, rb);
        const x = rb[0] + info.pos.x, y = rb[1] + info.pos.y, z = rb[2] + info.pos.z;
        const ok = proj(x, y, z);
        const sx = S.x, sy = S.y, sz = S.z;
        const sel = info.node === selNode;
        nodeScreen.push({ info, x: sx, y: sy, visible: ok });
        if (!ok) continue;
        if (sel) selScreen = { info, x: sx, y: sy, z: sz, wx: x, wy: y, wz: z };
        else glyphDiamond(sx, sy, 6.5, info.index % 2 ? '#ff7eb6' : '#ffb347', null);
        const dv = dvMag(info.node.dv);
        if (!sel && px >= 34) label('node:' + info.index, sx, sy, (dv >= 0.05 ? fmt.num(dv, 1) + ' m/s · ' : '') + 'T−' + fmt.time(Math.max(0, info.node.t - ut)),
          'pill node' + (info.index % 2 ? ' alt' : ''), 84, 'below');
      }
    }
    for (const h of handles) h.visible = false;
    if (selScreen) {
      const { info, x, y } = selScreen;
      const L = selScreen.z * 0.05, full = P.fl * 0.05;
      // the orbital plane through the node, as a faint foreshortened disc: a depth cue for the six handles
      {
        const pa = info.basis.prograde, ra = info.basis.radial, LR = selScreen.z * 0.105;
        ctx.beginPath(); let first = true;
        for (let i = 0; i <= 48; i++) {
          const t = i / 48 * TAU, cs = Math.cos(t) * LR, sn = Math.sin(t) * LR;
          if (!proj(selScreen.wx + pa.x * cs + ra.x * sn, selScreen.wy + pa.y * cs + ra.y * sn, selScreen.wz + pa.z * cs + ra.z * sn)) { first = true; continue; }
          if (first) ctx.moveTo(S.x, S.y); else ctx.lineTo(S.x, S.y); first = false;
        }
        ctx.fillStyle = 'rgba(255,179,71,0.055)'; ctx.fill();
        ctx.lineWidth = 1; ctx.strokeStyle = 'rgba(255,179,71,0.3)'; ctx.stroke();
      }
      for (const h of handles) {
        const d = info.basis[h.def.axis], s = h.def.sign;
        if (!proj(selScreen.wx + d.x * L * s, selScreen.wy + d.y * L * s, selScreen.wz + d.z * L * s)) continue;
        let ex = S.x - x, ey = S.y - y; const len = Math.hypot(ex, ey);
        if (len < 1e-6) { ex = 0; ey = -1; } else { ex /= len; ey /= len; }
        const ratio = clamp(len / full, 0, 1);
        let rad = 34 + 38 * ratio;
        if (drag && drag.type === 'handle' && drag.h === h) rad += clamp(drag.pull, -18, 90);
        else { h.dx = ex; h.dy = ey; }
        const hx = x + h.dx * rad, hy = y + h.dy * rad;
        h.x = hx; h.y = hy; h.visible = true; h.scale = 0.8 + 0.28 * ratio;
        // stem
        ctx.beginPath(); ctx.moveTo(x + h.dx * 9, y + h.dy * 9); ctx.lineTo(hx - h.dx * 10, hy - h.dy * 10);
        ctx.lineWidth = 3.5; ctx.strokeStyle = 'rgba(8,11,16,0.7)'; ctx.stroke();
        ctx.lineWidth = 1.6; ctx.strokeStyle = h.def.axis === 'prograde' ? '#74dd92' : h.def.axis === 'normal' ? '#b79cff' : '#6cb6ff';
        if (s < 0) ctx.setLineDash([3, 3]);
        ctx.stroke(); ctx.setLineDash([]);
      }
      glyphDiamond(x, y, 8, info.index % 2 ? '#ff7eb6' : '#ffb347', 'rgba(255,255,255,0.75)');
    }
    for (const h of handles) {
      if (h.visible) { h.node.style.display = ''; h.node.style.transform = `translate(${h.x.toFixed(1)}px,${h.y.toFixed(1)}px) translate(-50%,-50%) scale(${((h.scale || 1) * uiScale()).toFixed(3)})`; }
      else if (h.node.style.display !== 'none') h.node.style.display = 'none';
    }

    // hover ghost
    hover = null;
    if (allowNodes && mouse.over && !drag && !pickNode(mouse.x, mouse.y)) hover = pickHover(mouse.x, mouse.y);
    if (hover) {
      ctx.beginPath(); ctx.arc(hover.x, hover.y, 9, 0, TAU); ctx.fillStyle = 'rgba(20,26,34,0.85)'; ctx.fill();
      ctx.lineWidth = 1.5; ctx.strokeStyle = '#ffb347'; ctx.setLineDash([3, 3]); ctx.stroke(); ctx.setLineDash([]);
      ctx.beginPath(); ctx.moveTo(hover.x - 4.5, hover.y); ctx.lineTo(hover.x + 4.5, hover.y); ctx.moveTo(hover.x, hover.y - 4.5); ctx.lineTo(hover.x, hover.y + 4.5);
      ctx.lineWidth = 2; ctx.lineCap = 'round'; ctx.strokeStyle = '#ffb347'; ctx.stroke();
      label('ghost', hover.x, hover.y, 'Add maneuver · T−' + fmt.time(hover.t - ut), 'pill ghost', 1000, 'far');
    }
    const cur = hover ? 'copy' : hoverVessel || hoverBody ? 'pointer' : (drag && drag.type === 'orbit' && (drag.button !== 0 || (downAt && downAt.moved))) ? 'grabbing' : (pickNode(mouse.x, mouse.y) ? 'grab' : '');
    if (app.canvas && app.canvas.style.cursor !== cur) app.canvas.style.cursor = cur;

    flushLabels();
  }

  /** Rough on-screen size (px) of a curve, to drop markers of orbits that are only a few pixels wide. */
  function curvePx(c) {
    relBody(c.body, rb);
    const d = Math.hypot(rb[0] - P.cx, rb[1] - P.cy, rb[2] - P.cz);
    const size = c.full ? c.o.apoapsis : Math.min(Math.max(conicRadius(c.o, c.A0), conicRadius(c.o, c.A1)), Number.isFinite(c.body.soi) ? c.body.soi : Infinity);
    return P.fl * size / Math.max(d, size * 0.5);
  }

  /** Stroke every curve of a chain; chainIdx ≥ 0 records pick segments. `fromNow` trims the first patch to ut. */
  function drawChain(chain, ut, colors, style, chainIdx, fromNow) {
    for (let k = 0; k < chain.length; k++) {
      const c = chain[k];
      if (curvePx(c) < 4) continue;
      relBody(c.body, rb);
      const bx = rb[0], by = rb[1], bz = rb[2], o = c.o;
      let A0 = c.A0;
      if (fromNow && k === 0 && !c.full) A0 = clamp(curveAnomaly(c, ut), c.A0, c.A1);
      const rec = chainIdx >= 0 ? (ax, ay, aA, qx, qy, bA) => { segs.push(chainIdx, k, ax, ay, aA, qx, qy, bA); } : null;
      const st = { color: colors[k % colors.length], width: style.width, alpha: style.alpha, dash: style.dash, halo: style.halo, glow: style.glow, fade: style.fade };
      if (st.alpha === 0) { st.alpha = 0.001; st.halo = false; }
      strokeCurve((A, out) => { conicPoint(o, A, out); out[0] += bx; out[1] += by; out[2] += bz; }, A0, c.A1, c.full ? 144 : 96, st, rec);
    }
  }

  // ---- markers: every glyph with a pill registers here so the mouse can expand it (hover) or pin it (right-click)
  let markers = [];                                // this frame: { key, x, y }
  let hoverMarkerKey = null;                       // marker under the mouse, found at the end of the previous frame
  const pinned = new Set();

  function mark(key, sx, sy, text, more, cls, prio, placement) {
    markers.push({ key, x: sx, y: sy });
    const hov = hoverMarkerKey === key, pin = pinned.has(key);
    label(key, sx, sy, (hov || pin) && more ? text + ' · ' + more : text, cls + (pin ? ' pinned' : '') + (hov ? ' hot' : ''), hov ? 1000 : pin ? prio + 8 : prio, placement);
  }
  function markAt(c, A, key, text, more, cls, prio, glyph, color, placement) {
    relBody(c.body, rb);
    conicPoint(c.o, A, v3);
    const x = rb[0] + v3[0], y = rb[1] + v3[1], z = rb[2] + v3[2];
    if (!proj(x, y, z)) return false;
    const sx = S.x, sy = S.y;
    if (sx < -30 || sx > W + 30 || sy < -30 || sy > H + 30) return false;
    const hid = occluded(x, y, z);
    if (hid && glyph !== 'cross') return false;        // an impact / entry point behind the limb still matters
    if (glyph === 'cross') { ctx.globalAlpha = hid ? 0.55 : 1; glyphCross(sx, sy, color); ctx.globalAlpha = 1; }
    else if (glyph === 'an' || glyph === 'dn') glyphTri(sx, sy, color, glyph === 'an');
    else if (glyph === 'soi') glyphSoi(sx, sy, color);
    else glyphTick(sx, sy, color);
    mark(key, sx, sy, text, more, cls, prio, placement);
    return true;
  }

  /** Target / selection ring around a marker. */
  function ringMark(x, y, r, color, dashed) {
    ctx.beginPath(); ctx.arc(x, y, r, 0, TAU);
    ctx.lineWidth = 3.4; ctx.strokeStyle = 'rgba(8,11,16,0.6)'; ctx.stroke();
    if (dashed) ctx.setLineDash([4, 4]);
    ctx.lineWidth = 1.5; ctx.strokeStyle = color; ctx.stroke(); ctx.setLineDash([]);
  }
  /** Four-corner target brackets. */
  function bracketMark(x, y, r, color) {
    const k = r * 0.45;
    for (const [w, c] of [[3.6, 'rgba(8,11,16,0.7)'], [1.6, color]]) {
      ctx.beginPath();
      for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) { ctx.moveTo(x + sx * r, y + sy * (r - k)); ctx.lineTo(x + sx * r, y + sy * r); ctx.lineTo(x + sx * (r - k), y + sy * r); }
      ctx.lineWidth = w; ctx.strokeStyle = c; ctx.lineJoin = 'round'; ctx.lineCap = 'round'; ctx.stroke();
    }
  }

  /** Closest-approach markers: a tick on the vessel's trajectory, a ring where the target will be, a tie line. */
  function drawApproaches(ut) {
    for (const a of approaches) {
      a.visible = false;
      const c = a.curve;
      if (curvePx(c) < 12) continue;
      relBody(c.body, rb);
      const bx = rb[0], by = rb[1], bz = rb[2];
      conicPoint(c.o, curveAnomaly(c, a.t), v3);
      const x = bx + v3[0], y = by + v3[1], z = bz + v3[2];
      if (!proj(x, y, z)) continue;
      const sx = S.x, sy = S.y;
      a.x = sx; a.y = sy;
      if (sx < -30 || sx > W + 30 || sy < -30 || sy > H + 30 || occluded(x, y, z)) continue;
      a.visible = true;
      a.orbit.posAt(a.t, tmpV);
      if (proj(bx + tmpV.x, by + tmpV.y, bz + tmpV.z)) {
        const tx = S.x, ty = S.y;
        if (Math.hypot(tx - sx, ty - sy) > 6) {
          ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(tx, ty); ctx.setLineDash([2, 4]); ctx.lineWidth = 1.2; ctx.globalAlpha = 0.75; ctx.strokeStyle = TARGET_COLOR; ctx.stroke();
          ctx.setLineDash([]); ctx.globalAlpha = 1;
          ringMark(tx, ty, 5, TARGET_COLOR, false);
        }
      }
      glyphApproach(sx, sy, TARGET_COLOR, a.rank + 1);
      const when = a.t - ut < 1 ? 'now' : 'in ' + fmt.time(a.t - ut);
      const sp = fmt.num(a.relSpeed, a.relSpeed < 100 ? 1 : 0) + ' m/s';
      const cls = 'pill ca' + (a.chain > 0 ? ' plan' : '');
      if (a.rank === 0) mark('ca:' + a.chain + ':0', sx, sy, 'Closest approach ' + fmt.dist(a.distance) + ' · ' + sp + ' ' + when, '', cls, 87, a.chain > 0 ? 'below' : 'above');
      else mark('ca:' + a.chain + ':1', sx, sy, '2nd approach ' + fmt.dist(a.distance), sp + ' ' + when, cls, 79, a.chain > 0 ? 'above' : 'below');
    }
    // ascending / descending nodes relative to the target's plane
    for (const n of relNodeMarks) {
      n.visible = false;
      const c = n.curve;
      if (curvePx(c) < 30 || n.t < ut) continue;
      const deg = (n.relInc / DEG).toFixed(n.relInc / DEG < 10 ? 2 : 1) + '°';
      n.visible = markAt(c, curveAnomaly(c, n.t), 'rn:' + n.chain + ':' + n.kind, (n.kind === 'an' ? 'AN ' : 'DN ') + deg, 'T−' + fmt.time(n.t - ut),
        'pill ca' + (n.chain > 0 ? ' plan' : ''), 60, n.kind, TARGET_COLOR, n.kind === 'an' ? 'above' : 'below');
    }
  }

  function latLonText(body, pos, t) {
    try {
      const d = body.inertialToSurfaceDir(tmpV.copy(pos).normalize(), t, tmpV2);
      const ll = body.latLon(d);
      const la = ll.lat / DEG, lo = ll.lon / DEG;
      return Math.abs(la).toFixed(1) + '°' + (la >= 0 ? 'N' : 'S') + ' ' + Math.abs(lo).toFixed(1) + '°' + (lo >= 0 ? 'E' : 'W');
    } catch { return ''; }
  }

  /** Ap / Pe / SOI / impact markers of a chain. */
  function markChain(chain, ut, keyPrefix, clsExtra, fromNow, colors) {
    for (let k = 0; k < chain.length; k++) {
      const c = chain[k], o = c.o, body = c.body, R = body.radius, p = c.patch;
      const col = colors[k % colors.length];
      if (curvePx(c) < 34) continue;
      let A0 = c.A0;
      if (fromNow && k === 0 && !c.full) A0 = clamp(curveAnomaly(c, ut), c.A0, c.A1);
      const tag = k > 0 || body !== (chain[0] && chain[0].body) ? body.name + ' ' : '';
      const key = keyPrefix + ':' + k;
      const tm = A => { let t = curveTime(c, A); if (c.full && t < ut) t += o.period * Math.ceil((ut - t) / o.period); return 'T−' + fmt.time(Math.max(0, t - ut)); };
      if (!o.hyper && o.e > 1e-5) {
        const Aap = Math.PI + TAU * Math.ceil((A0 - Math.PI) / TAU - 1e-12);
        if (Aap <= c.A1 + 1e-9) markAt(c, Aap, key + ':ap', tag + 'Ap ' + fmt.dist(o.apoapsis - R), tm(Aap), 'pill ap' + clsExtra, 82, 'tick', col, 'above');
      }
      if (o.e > 1e-5) {
        const Ape = o.hyper ? 0 : TAU * Math.ceil(A0 / TAU - 1e-12);
        if (Ape >= A0 - 1e-9 && Ape <= c.A1 + 1e-9) markAt(c, Ape, key + ':pe', tag + 'Pe ' + fmt.dist(o.periapsis - R), tm(Ape), 'pill pe' + clsExtra, 83, 'tick', col, 'below');
      }
      if (p.endType && Number.isFinite(p.tEnd) && p.tEnd >= ut) {
        const dtxt = fmt.time(p.tEnd - ut);
        if (p.endType === 'impact' || p.endType === 'atmo') {
          let more = '';
          try { const st = o.stateAt(p.tEnd); more = fmt.speed(st.v.length()) + ' · ' + latLonText(body, st.r, p.tEnd); } catch { more = ''; }
          if (p.endType === 'impact') {
            if (markAt(c, c.A1, key + ':end', 'Impact in ' + dtxt, more, 'pill bad' + clsExtra, 88, 'cross', '#ff6b6b', 'above')) impactRing(c, '#ff6b6b');
          } else markAt(c, c.A1, key + ':end', 'Atmosphere in ' + dtxt, more, 'pill warn' + clsExtra, 88, 'cross', '#ffb347', 'above');
        } else if (p.endType === 'exit') markAt(c, c.A1, key + ':end', 'Leave ' + body.name + ' SOI in ' + dtxt, body.parent ? 'into ' + body.parent.name + ' space' : '', 'pill soi' + clsExtra, 80, 'soi', col, 'above');
        else if (p.endType === 'enter' && p.nextBody) {
          markAt(c, c.A1, key + ':end', 'Enter ' + p.nextBody.name + ' SOI in ' + dtxt, 'encounter', 'pill soi' + clsExtra, 86, 'soi', colors[(k + 1) % colors.length], 'above');
          // ghost of the target body where it will be at the encounter
          const nb = p.nextBody;
          relBody(body, rb); nb.posAt(p.tEnd, tmpV);
          const gx = rb[0] + tmpV.x, gy = rb[1] + tmpV.y, gz = rb[2] + tmpV.z;
          if (proj(gx, gy, gz)) {
            const d = S.z, sx = S.x, sy = S.y;
            const rr = P.fl * nb.soi / Math.max(d, 1), rbody = Math.max(3, P.fl * nb.radius / Math.max(d, 1));
            if (rr > 5 && rr < 4000) { ctx.beginPath(); ctx.arc(sx, sy, rr, 0, TAU); ctx.setLineDash([3, 5]); ctx.lineWidth = 1.1; ctx.globalAlpha = 0.5; ctx.strokeStyle = hex(nb.color); ctx.stroke(); ctx.setLineDash([]); ctx.globalAlpha = 1; }
            ctx.beginPath(); ctx.arc(sx, sy, Math.min(rbody, 2000), 0, TAU); ctx.lineWidth = 1.2; ctx.globalAlpha = 0.7; ctx.strokeStyle = hex(nb.color); ctx.stroke(); ctx.globalAlpha = 1;
            if (rr > 26) label(key + ':ghost', sx, sy + Math.min(rbody, 200), nb.name + ' at arrival', 'body ghostbody', 20, 'below');
          }
        }
      }
    }
  }

  /** A foreshortened ring lying on the surface around the predicted impact point. */
  function impactRing(c, color) {
    conicPoint(c.o, c.A1, v3);
    const px = v3[0], py = v3[1], pz = v3[2], r = Math.hypot(px, py, pz) || 1;
    const ux = px / r, uy = py / r, uz = pz / r;
    // two tangents
    let ax = uz, ay = 0, az = -ux; let al = Math.hypot(ax, az);
    if (al < 1e-6) { ax = 1; ay = 0; az = 0; al = 1; }
    ax /= al; az /= al;
    const bx = uy * az - uz * ay, by = uz * ax - ux * az, bz = ux * ay - uy * ax;
    relBody(c.body, rb);
    const rad = Math.max(c.body.radius * 0.035, dist * 0.012);
    ctx.beginPath();
    let first = true, any = false;
    for (let i = 0; i <= 40; i++) {
      const t = i / 40 * TAU, cs = Math.cos(t) * rad, sn = Math.sin(t) * rad;
      const x = rb[0] + px * 1.002 + ax * cs + bx * sn, y = rb[1] + py * 1.002 + ay * cs + by * sn, z = rb[2] + pz * 1.002 + az * cs + bz * sn;
      if (!proj(x, y, z)) { first = true; continue; }
      if (first) ctx.moveTo(S.x, S.y); else ctx.lineTo(S.x, S.y);
      first = false; any = true;
    }
    if (!any) return;
    ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(8,11,16,0.7)'; ctx.stroke();
    ctx.lineWidth = 1.4; ctx.strokeStyle = color; ctx.setLineDash([4, 3]); ctx.stroke(); ctx.setLineDash([]);
  }

  // ------------------------------------------------------------------------------------------------ lifecycle

  function resize(w, h) {
    W = Math.max(1, Math.round(w || (app.size && app.size.w) || window.innerWidth));
    H = Math.max(1, Math.round(h || (app.size && app.size.h) || window.innerHeight));
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    camera.aspect = W / H; viewOx = NaN; camera.clearViewOffset(); camera.updateProjectionMatrix();
    if (canvas2d) {
      canvas2d.width = Math.round(W * dpr); canvas2d.height = Math.round(H * dpr);
      canvas2d.style.width = W + 'px'; canvas2d.style.height = H + 'px';
    }
  }

  function enter() {
    if (open) return;
    buildScene();
    if (!root) buildDom();
    (app.uiRoot || document.body).appendChild(root);
    open = true;
    resize(app.size && app.size.w, app.size && app.size.h);
    if (input) {
      offs = [input.on('mousedown', onMouseDown), input.on('mousemove', onMouseMove), input.on('mouseup', onMouseUp),
        input.on('wheel', onWheel), input.on('dblclick', onDblClick), input.on('keydown', onKeyDown)];
    }
    const w = world();
    lastWorld = w;
    drag = null; downAt = null; hover = null; trans = null; panelTimer = 0; bodyPanelKey = '';
    if (w) {
      for (const b of SYSTEM.bodies) b.globalPosAt(w.ut, gpos.get(b));
      // a stale vessel focus (from a previous world) falls back to the active vessel / home
      if (!isBody(focusTarget) && !(w.vessels || []).includes(focusTarget)) focusTarget = null;
      if (!focusTarget || (opts.focusActiveOnEnter !== false && w.active && !enteredOnce)) {
        const t = w.active || highlighted(w) || SYSTEM.home;
        focusTarget = t; distTarget = dist = clamp(defaultDist(t), distLimits()[0], MAX_DIST);
      }
      enteredOnce = true;
      if (isBody(focusTarget)) focusG.copy(gpos.get(focusTarget)); else vesselGlobal(focusTarget, focusG);
    }
    if (!focusTarget) focusTarget = SYSTEM.home;
  }
  let enteredOnce = false;

  function exit() {
    if (!open) return;
    open = false;
    for (const off of offs) { try { off(); } catch { /* already removed */ } }
    offs = [];
    drag = null; downAt = null; downR = null; hover = null; hoverVessel = null; hoverBody = null; hoverMarkerKey = null;
    if (cardEl) { cardEl.classList.add('sw-hidden'); cardKey = ''; }
    for (const h of handles) h.node.classList.remove('dragging');
    if (root) root.remove();
    if (app.canvas) app.canvas.style.cursor = '';
  }

  function dispose() {
    exit();
    for (const { vis, soi } of visuals.values()) {
      scene.remove(vis.group);
      try { if (vis.dispose) vis.dispose(); } catch { /* best effort */ }
      if (soi) { scene.remove(soi); soi.material.dispose(); }
    }
    visuals.clear(); hiRes.clear();
    soiGeo.dispose();
    if (sky) { scene.remove(sky.mesh); sky.dispose(); sky = null; }
    if (starfield) {
      scene.remove(starfield);
      starfield.traverse(o => { if (o.geometry) o.geometry.dispose(); if (o.material) { if (o.material.map) o.material.map.dispose(); o.material.dispose(); } });
      starfield = null;
    }
    sceneBuilt = false;
    labelPool.clear();
    root = null; canvas2d = null; ctx = null; nodePanel = null; selPanel = null; targetPanel = null; transferPanel = null; cardEl = null; cardKey = '';
  }

  /** Screen position (CSS px) of the highlighted vessel's trajectory at time t on a chain (default: the last one). */
  function screenPointAtTime(t, chainIdx) {
    const w = world(), h = w && highlighted(w), pr = h && preds.get(h);
    if (!pr) return null;
    let j = chainIdx == null ? pr.chains.length - 1 : chainIdx;
    while (j > 0 && !pr.chains[j]) j--;
    const c = findCurve(pr.chains[j], t) || (pr.chains[j] && pr.chains[j][pr.chains[j].length - 1]);
    if (!c) return null;
    relBody(c.body, rb);
    conicPoint(c.o, curveAnomaly(c, t), v3);
    const ok = proj(rb[0] + v3[0], rb[1] + v3[1], rb[2] + v3[2]);
    return { x: S.x, y: S.y, visible: ok && !occluded(rb[0] + v3[0], rb[1] + v3[1], rb[2] + v3[2]) };
  }

  function debug() {
    const w = world(), h = w && highlighted(w), pr = h && preds.get(h);
    const sum = ch => (ch && ch[0] ? { ap: ch[0].o.apoapsis - ch[0].body.radius, pe: ch[0].o.periapsis - ch[0].body.radius, body: ch[0].body.id,
      patches: ch.map(c => ({ body: c.body.id, end: c.patch.endType, next: c.patch.nextBody ? c.patch.nextBody.id : null })) } : null);
    return {
      open, focus: isBody(focusTarget) ? focusTarget.id : (focusTarget && focusTarget.name), focusIsBody: isBody(focusTarget),
      dist, distTarget, yaw, pitch, hover: hover ? { x: hover.x, y: hover.y, t: hover.t, chain: hover.chain } : null,
      selected: h && selNode ? (h.nodes || []).indexOf(selNode) : -1,
      nodes: h && h.nodes ? h.nodes.map(n => ({ t: n.t, dv: { ...n.dv } })) : [],
      chains: pr ? pr.chains.map(sum) : [],
      nodeScreen: nodeScreen.map(n => ({ x: n.x, y: n.y, visible: n.visible })),
      bodies: Object.fromEntries([...lastBodyScreen].map(([b, q]) => [b.id, { x: q.x, y: q.y, visible: q.ok, r: q.rs }])),
      labels: [...labelPool.values()].filter(e => e.shown).map(e => e.text),
      target: (() => { const t = w && targetOf(w); return t ? { kind: isBody(t) ? 'body' : 'vessel', id: t.id, name: t.name } : null; })(),
      selection: selObj ? { kind: selObj.kind, id: selObj.ref.id, name: selObj.ref.name } : null,
      approaches: approaches.map(a => ({ chain: a.chain, rank: a.rank, t: a.t, distance: a.distance, relSpeed: a.relSpeed, x: a.x, y: a.y, visible: a.visible })),
      relNodes: relNodeMarks.map(n => ({ chain: n.chain, kind: n.kind, t: n.t, relInc: n.relInc, visible: n.visible })),
      relInc,
      markers: markers.map(m => ({ key: m.key, x: m.x, y: m.y })),
      pinned: [...pinned],
      hoverMarker: hoverMarkerKey,
      card: cardKey || null,
      transfer: transferInfo ? { from: transferInfo.from, to: transferInfo.to, kind: transferInfo.kind, phaseNow: transferInfo.phaseNow, phaseNeeded: transferInfo.phaseNeeded, timeToWindow: transferInfo.timeToWindow, transferTime: transferInfo.transferTime, ejectDv: transferInfo.ejectDv } : null,
      vessels: targets.filter(t => t.kind === 'vessel').map(t => ({ id: t.ref.id, name: t.ref.name, x: t.x, y: t.y, role: roleOf(t.ref) })),
    };
  }

  return {
    enter, exit, update, render, resize, focus, focusInner, planTransfer, dispose, pruneNodes, selectNode, screenPointAtTime, debug, select,
    get selection() { return selObj ? selObj.ref : null; },
    setHighlight(v) { highlightOverride = v === undefined ? undefined : v; selNode = null; panelTimer = 0; pinned.clear(); },
    cycleFocus, focusActive, setInsets, setView, systemDist,
    get transfer() { return transferInfo; },
    get hoverTarget() { return hoverVessel || hoverBody || null; },
    get isOpen() { return open; },
    get selectedNode() { return selNode; },
    get focusTarget() { return focusTarget; },
    get root() { return root; },
  };
}
