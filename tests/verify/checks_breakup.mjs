// 8. Aerodynamic breakup: air ratings, thin roots, open panels, tear-off (docs/AERO_BREAKUP.md).
//
// The game judges a rated part inside its aerodynamics loop, from the velocities it has already worked out there.
// The reference never sees that loop: it takes the vessel's public state BEFORE a step (position, velocity,
// attitude, spin, where each part sits), the body's rotation and atmosphere as parsed from the data table, and
// works the airflow at each part out again from first principles. The tear-off law is then replayed from those
// numbers and has to name the same part on the same step as the game.
import { World, SYSTEM, A, V, spawn } from './harness.mjs';
import * as R from './ref.mjs';
import * as RS from './ref_structure.mjs';
import { jointUtilisation, rootSection, STRUCT } from '../../js/core/structure.js';
import { TUNING } from '../../js/core/vessel.js';
import { MAX_DEBRIS } from '../../js/core/world.js';
import { Craft, stockCrafts } from '../../js/core/craft.js';
import { PARTS, AIR_RATING, airRating } from '../../js/core/parts.js';
import { Quaternion, Vector3 } from '../../js/lib/three.module.min.js';

const sys = R.readSystem();
const DT = TUNING.DT_MAX;
const { add, sub, scale, dot, cross, norm } = RS;
const TAU = 2 * Math.PI;

// ------------------------------------------------------------------------------------------ reference airflow
/** Rotate a world vector into body axes with the quaternion [x, y, z, w] (written out: no game maths). */
function toBody(q, v) {
  const [x, y, z, w] = q, u = [-x, -y, -z];
  const t = scale(cross(u, v), 2);
  return add(add(v, scale(t, w)), cross(u, t));
}
function toWorld(q, v) {
  const u = [q[0], q[1], q[2]], t = scale(cross(u, v), 2);
  return add(add(v, scale(t, q[3])), cross(u, t));
}
/** Public state of a vessel as plain numbers. */
function stateOf(v) {
  return {
    body: v.body.id, pos: A(v.pos), vel: A(v.vel), q: [v.q.x, v.q.y, v.q.z, v.q.w], w: A(v.w), com: A(v.com), mass: v.mass,
    parts: [...v.parts.values()].map(p => ({ id: p.id, type: p.def.id, at: [p.pos.x - v.com.x, p.pos.y - v.com.y, p.pos.z - v.com.z], rot: p.rot || 0, deployed: p.deployed, links: p.links.length, mass: p.mass })),
  };
}
/** Air density and the airflow at a point of the vessel (body axes, m/s), from the state alone. */
function airAt(s, at) {
  const b = sys.byId[s.body];
  const h = norm(s.pos) - b.radius;
  const rho = b.atmo && h < b.atmo.height ? b.atmo.rho0 * Math.exp(-h / b.atmo.scale) : 0;
  // the air turns with the body, about its +Y axis
  const omega = [0, TAU / b.rotPeriodDef, 0];
  const rel = sub(s.vel, cross(omega, s.pos));
  const u = add(toBody(s.q, rel), cross(s.w, at));
  return { rho, u, h };
}
/** The dynamic pressure a part's rating is judged on (Pa), from the state alone. */
function ratedFlow(s, p) {
  const def = PARTS[p.type], r = airRating(def);
  if (!r) return null;
  const { rho, u } = airAt(s, p.at);
  let q;
  if (r.flow === 'open') q = p.deployed ? 0.5 * rho * dot(u, u) : 0;
  else q = 0.5 * rho * (u[0] * u[0] + u[2] * u[2]);      // across the stack axis (+Y) of an untilted part
  if (def.decoupler && r.flow !== 'open' && p.links < 2) q = 0;      // a clamp that holds nothing
  return { q, rated: r.q, open: r.flow === 'open' };
}

const stock = name => stockCrafts().find(c => c.name === name);
/** A stock craft in the air over Verda's equator: `alt` m up, `speed` m/s eastward and upward, nose turned by `q`. */
function inAir(name, { alt = 9000, speed = 420, tilt = [0, 0, 0], spin = [0, 0, 0], craft = null } = {}) {
  const w = new World();
  const b = sys.byId.verda;
  const v = spawn(w, craft || stock(name), 'verda', [b.radius + alt, 0, 0], [speed * 0.8, 0, speed * 0.6 - TAU / b.rotPeriodDef * (b.radius + alt)]);
  // nose along the velocity first (body +Y onto the air-relative velocity), then the asked-for turn about body axes
  const rel = new Vector3(speed * 0.8, 0, speed * 0.6).normalize();
  v.q.setFromUnitVectors(new Vector3(0, 1, 0), rel);
  for (let k = 0; k < 3; k++) if (tilt[k]) v.q.multiply(new Quaternion().setFromAxisAngle(new Vector3(k === 0 ? 1 : 0, k === 1 ? 1 : 0, k === 2 ? 1 : 0), tilt[k]));
  v.w.set(spin[0], spin[1], spin[2]);
  v.ctrl.sas = false; v.ctrl.throttle = 0;
  return { w, v };
}

// ------------------------------------------------------------------------------------------ 8a thin roots
function thinRoots(S) {
  // one case by hand: a fin root 1.0 m long and 0.06 m thick, allowable 300 kN/m
  {
    const h = 1.0, t = 0.06, cap = 3e5;
    const sec = rootSection(h, t);
    S.check('root 1.0 x 0.06 m: flat-wise section h t + t^2/3', 0.0612, sec.zFlap, 1e-12, { unit: 'm2' });
    S.check('root 1.0 x 0.06 m: edge-wise section h t + h^2/3', 0.06 + 1 / 3, sec.zEdge, 1e-12, { unit: 'm2' });
    // a pure flat-wise moment M about the chord (c = +Y), joint axis +X: peak line load M / zFlap, at the long sides
    const L = RS.rootLineLoads([0, 0, 0], [0, 12000, 0], [1, 0, 0], [0, 1, 0], h, t);
    S.check('reference root, 12 kN m flat-wise: peak tension by fitting and walking the sides = M / (h t + t^2/3)', 12000 / 0.0612, L.nT, 1e-9, { rel: true, unit: 'N/m' });
    S.check('reference root: the fitted line load integrates back to the moment', 12000, L.back.Mc, 1e-9, { rel: true, unit: 'N m' });
    S.check('reference root: perimeter and enclosed area from the corners', 0, Math.abs(L.per - 2.12) + Math.abs(L.area - 0.06), 1e-12, { unit: 'm, m2' });
    const g = jointUtilisation([0, 0, 0], [0, 12000, 0], [1, 0, 0], 0.3, cap, cap, cap, { h, t, c: [0, 1, 0] });
    S.check('game, same case: utilisation = M / (zFlap x allowable)', 12000 / 0.0612 / cap, g.util, 1e-12, { rel: true });
    // the same moment edge-wise is carried 6.4 times better: the whole reason a fin tears off flat-wise
    const e = jointUtilisation([0, 0, 0], [0, 0, 12000], [1, 0, 0], 0.3, cap, cap, cap, { h, t, c: [0, 1, 0] });
    S.check('game: the same moment edge-wise loads the root zFlap / zEdge as much', sec.zFlap / sec.zEdge, e.util / g.util, 1e-12, { rel: true });
  }
  const rnd = RS.rng(4242);
  const u = (lo, hi) => lo + (hi - lo) * rnd();
  let wRes = 0, wPeak = 0, wUtil = 0, wBack = 0, modes = 0, modeBad = 0, cases = 0;
  const seen = { tension: 0, compression: 0, shear: 0 };
  for (let k = 0; k < 400; k++) {
    let n = [u(-1, 1), u(-1, 1), u(-1, 1)];
    if (k % 3 === 0) n = [Math.cos(k), 0, -Math.sin(k)];                    // as in the game: outward, chord along +Y
    n = scale(n, 1 / norm(n));
    let c = k % 3 === 0 ? [0, 1, 0] : cross(n, [u(-1, 1), u(-1, 1), u(-1, 1)]);
    c = scale(c, 1 / norm(c));
    const h = Math.exp(u(Math.log(0.3), Math.log(4))), t = Math.exp(u(Math.log(0.03), Math.log(0.3)));
    const fs = Math.exp(u(Math.log(1e2), Math.log(5e6)));
    let F = [u(-1, 1) * fs, u(-1, 1) * fs, u(-1, 1) * fs];
    let M = [u(-1, 1) * fs * t, u(-1, 1) * fs * t, u(-1, 1) * fs * t];
    if (k % 5 === 1) F = scale(n, u(-1, 1) * fs);
    if (k % 5 === 2) M = scale(n, u(-1, 1) * fs * t);
    if (k % 7 === 3) F = add(scale(n, -fs * 20), scale(F, 0.05));
    if (k % 7 === 4) F = add(scale(n, fs * 20), scale(F, 0.05));
    const capT = u(0.3, 2) * 1e6, capC = u(0.3, 2) * 1e6, capS = u(0.2, 1.5) * 1e6;
    const g = jointUtilisation(F, M, n, 0.3, capT, capC, capS, { h, t, c });
    const q = RS.rootUtilisation(F, M, n, c, h, t, capT, capC, capS);
    const sc = Math.max(q.nT, q.nC, q.q, 1e-30);
    wRes = Math.max(wRes, Math.abs(g.axial - q.N) / fs, Math.abs(g.shear - q.V) / fs, Math.abs(g.bending - q.Mb) / (fs * t), Math.abs(g.torsion - q.Mt) / (fs * t));
    wPeak = Math.max(wPeak, Math.abs(g.nT - q.nT) / sc, Math.abs(g.nC - q.nC) / sc, Math.abs(g.q - q.q) / sc);
    wUtil = Math.max(wUtil, Math.abs(g.util - q.util) / Math.max(q.util, 1e-30));
    wBack = Math.max(wBack, Math.abs(q.back.N - q.N) / fs);
    if (q.margin > 1e-6 * q.util) { modes++; if (g.mode !== q.mode) modeBad++; seen[q.mode]++; }
    cases++;
  }
  S.info('random thin roots', `${cases} cases`, '', `governing mode: ${seen.tension} tension, ${seen.compression} compression, ${seen.shear} shear; 0.3 to 4 m long, 3 to 30 cm thick, any axis`);
  S.check('jointUtilisation with a thin root: axial, shear, bending, torsion vs the reference', 0, wRes, 1e-9, { unit: 'rel' });
  S.check('  peak line loads nT, nC, q vs the peaks found on the sides of the rectangle', 0, wPeak, 1e-9, { unit: 'rel', note: 'the reference fits a linear line load by Gauss-Legendre integration round the sides and walks them for the peak' });
  S.check('  utilisation vs max(nT/capT, nC/capC, q/capS)', 0, wUtil, 1e-9, { unit: 'rel' });
  S.check(`  governing mode (${modes} cases with a clear winner)`, 0, modeBad, 0, { unit: 'wrong' });
  S.check('  reference: the fitted line load integrates back to the axial force', 0, wBack, 1e-9, { unit: 'rel' });
}

// ------------------------------------------------------------------------------------------ 8b the airflow on rated parts
const ATTITUDES = [
  ['nose first', [0, 0, 0], [0, 0, 0]],
  ['15 degrees off', [0.26, 0, 0], [0, 0, 0]],
  ['45 degrees off, yawed', [0.5, 0, 0.6], [0, 0, 0]],
  ['broadside', [Math.PI / 2, 0, 0], [0, 0, 0]],
  ['broadside, the other way round', [0, 0, -Math.PI / 2], [0, 0, 0]],
  ['tail first', [Math.PI, 0, 0], [0, 0, 0]],
  ['tumbling end over end at 2 rad/s', [1.1, 0, 0], [2, 0, 0]],
  ['flat spin at 3 rad/s with a roll', [0.9, 0.4, 0.3], [0.4, 1.0, 3]],
];
function ratedAirflow(S, full) {
  const names = full ? ['Colossus', 'Hearthstone Core', 'Whisper Probe', 'Farwind', 'Latch Target', 'Ember Twin'] : ['Colossus', 'Whisper Probe'];
  for (const name of names) {
    let worst = 0, n = 0, peak = 0, kinds = new Set(), wUtil = 0, wWorst = 0;
    for (const [, tilt, spin] of ATTITUDES) {
      const { w, v } = inAir(name, { tilt, spin });
      TUNING.AERO_FAIL = false;
      try {
        const s = stateOf(v);
        w.step(DT);
        if (w.substeps !== 1) { S.ok(`${name}: one physics step per world step`, false, `${w.substeps}`); continue; }
        const got = new Map(v.airLoads().map(a => [a.part, a]));
        let top = 0;
        for (const p of s.parts) {
          const want = ratedFlow(s, p);
          if (!want) { if (got.has(p.id)) worst = Infinity; continue; }
          const g = got.get(p.id);
          if (!g) { worst = Infinity; continue; }
          n++; kinds.add(PARTS[p.type].shape);
          worst = Math.max(worst, Math.abs(g.q - want.q) / Math.max(want.q, 1));
          wUtil = Math.max(wUtil, Math.abs(g.util - want.q / want.rated), Math.abs(g.rated - want.rated));
          peak = Math.max(peak, want.q); top = Math.max(top, want.q / want.rated);
        }
        wWorst = Math.max(wWorst, Math.abs((v.airUtil || 0) - top));
      } finally { TUNING.AERO_FAIL = true; }
    }
    S.check(`${name}: airflow on every rated part vs the reference, ${ATTITUDES.length} attitudes and spins (${n} readings: ${[...kinds].join(', ')})`, 0, worst, 1e-9, { unit: 'rel', note: `largest ${(peak / 1000).toFixed(1)} kPa` });
    S.check(`  ${name}: utilisation = that pressure / the catalog rating, and vessel.airUtil is the largest`, 0, Math.max(wUtil, wWorst), 1e-9, {});
  }
  // an open panel is judged on all of the flow, a stowed one on none; a fixed tile has no rating at all
  {
    const { w, v } = inAir('Latch Target', { tilt: [0, 0, 0], speed: 120, alt: 4000 });
    const panels = [...v.parts.values()].filter(p => p.def.solar);
    TUNING.AERO_FAIL = false;
    try {
      w.step(DT);
      const stowed = v.airLoads().filter(a => a.open).map(a => a.q);
      v.setSolar(true);
      const s = stateOf(v);
      w.step(DT);
      let worst = 0, q0 = 0;
      for (const a of v.airLoads().filter(x => x.open)) { const want = ratedFlow(s, s.parts.find(p => p.id === a.part)); worst = Math.max(worst, Math.abs(a.q - want.q) / want.q); q0 = want.q; }
      S.ok(`Latch Target, nose first at 120 m/s: stowed panels (${panels.length}) read no airflow`, stowed.length > 0 && stowed.every(q => q === 0));
      S.check('  the same panels opened: judged on the whole airflow, 1/2 rho v^2 at the panel', 0, worst, 1e-9, { unit: 'rel', note: `${(q0 / 1000).toFixed(2)} kPa, nose first` });
    } finally { TUNING.AERO_FAIL = true; }
    S.ok('fixed solar tiles and slabs carry no air rating', airRating(PARTS.solar_tile) === null && airRating(PARTS.solar_slab) === null);
    S.ok('every rating in the table belongs to a part in the catalog', Object.keys(AIR_RATING).every(k => Object.values(PARTS).some(d => d.shape === k || d.shape + '_' + d.variant === k)));
  }
}

// ------------------------------------------------------------------------------------------ 8c the open panel as a plate
function openPanel(S) {
  // Two identical probes side by side in the same air, one with its panels open. The difference between what the
  // two do in one step is the force and moment of the open panels: compare with a flat plate, 1.8 x 1/2 rho vn |vn| A.
  const make = () => {
    const c = new Craft('Panel probe');
    const [core] = c.setRoot('probe_keystone');
    const [tank] = c.attachStack('tank_m400', core.id, 'bottom');
    c.attachRadial('solar', tank.id, tank.pos.y, 0, 2);      // a pair, so the probe is balanced; only one is opened
    c.autoStage();
    return c;
  };
  for (const [label, tilt, spin] of [['face on', [Math.PI / 2, 0, 0], [0, 0, 0]], ['45 degrees to the flow', [0.4, 0, 0.8], [0, 0, 0]], ['edge on (nose first)', [0, 0, 0], [0, 0, 0]], ['tumbling', [0.7, 0.2, 0.9], [0.5, 0.3, 1.5]]]) {
    const a = inAir(null, { craft: make(), tilt, spin, speed: 150, alt: 3000 }), b = inAir(null, { craft: make(), tilt, spin, speed: 150, alt: 3000 });
    [...b.v.parts.values()].find(p => p.def.id === 'solar').deployed = true;
    const s = stateOf(b.v), panel = s.parts.find(p => p.type === 'solar' && p.deployed), def = PARTS.solar;
    a.w.step(DT); b.w.step(DT);
    // observed difference of the two (gravity and everything else is the same): force in body axes, and spin change
    const dF = scale(toBody(s.q, sub(A(b.v.vel), A(a.v.vel))), s.mass / DT);
    const I = A(b.v.inertia), dW = sub(A(b.v.w), A(a.v.w));
    const dT = [dW[0] * I[0] / DT, dW[1] * I[1] / DT, dW[2] * I[2] / DT];
    // reference plate: outward o = (cos rot, 0, -sin rot), normal across it in the plane of the hull, area span x h,
    // force at the middle of the span
    const o = [Math.cos(panel.rot), 0, -Math.sin(panel.rot)], nrm = [o[2], 0, -o[0]];
    const arm = (def.rw + def.solar.span) / 2, at = add(panel.at, scale(o, arm));
    const { rho, u } = airAt(s, panel.at);
    const vn = dot(u, nrm);
    const Fp = scale(nrm, -0.5 * rho * 1.8 * def.solar.span * def.h * vn * Math.abs(vn));
    const Tp = cross(at, Fp);
    const sc = Math.max(norm(Fp), 1);
    S.check(`open Sunfoil panel, ${label}: extra force on the probe vs a flat plate 1.8 x 1/2 rho vn|vn| x span x height`, 0, norm(sub(dF, Fp)) / sc, 2e-6, { unit: 'rel', note: `${norm(Fp).toFixed(1)} N` });
    S.check('  its moment about the mass centre vs that force at the middle of the span', 0, norm(sub(dT, Tp)) / Math.max(norm(Tp), 1), 2e-6, { unit: 'rel', note: `${norm(Tp).toFixed(1)} N m` });
    const st = b.v.structure;
    S.check('  Newton still closes with the panel open (residual at the root)', 0, Math.max(st.resF, st.resM) / (s.mass * 9.81), 1e-9, { unit: 'of the weight' });
  }
}

// ------------------------------------------------------------------------------------------ 8d the tear-off law
function tearLaw(S, full) {
  const cases = [
    ['Colossus', { tilt: [Math.PI / 2, 0, 0], speed: 300, alt: 6000 }],
    ['Whisper Probe', { tilt: [1.2, 0, 0.5], spin: [0.6, 0, 0.9], speed: 420, alt: 3000 }],
  ];
  if (full) cases.push(['Hearthstone Core', { tilt: [0, 0, 1.2], spin: [0, 0, 1.4], speed: 340, alt: 7000 }], ['Ember Twin', { tilt: [1.3, 0, 0], spin: [1.5, 0, 0], speed: 400, alt: 4000 }]);
  for (const [name, opts] of cases) {
    const { w, v } = inAir(name, opts);
    const events = [];
    w.on('structure', d => { if (d.vessel === v) events.push({ step, mode: d.mode, air: d.air, joint: d.joint, debris: d.debris }); });
    const damage = new Map();
    let step = 0, predicted = null, wDamage = 0, first = null;
    for (step = 1; step <= 400 && !first; step++) {
      const s = stateOf(v);
      w.step(DT);
      if (w.substeps !== 1) break;
      // replay the law from the state before the step
      const tornNow = [];
      for (const p of s.parts) {
        const f = ratedFlow(s, p);
        if (!f) continue;
        const u = f.q / f.rated;
        let d = damage.get(p.id) || 0;
        if (u > 1) d += (u - 1) * DT / STRUCT.AIR_FAIL_TIME; else if (d > 0) d = Math.max(0, d - DT / STRUCT.HEAL_TIME);
        if (d >= 1) { tornNow.push({ id: p.id, q: f.q, rated: f.rated }); d = 0; }
        damage.set(p.id, d);
      }
      if (!tornNow.length && !events.length) {
        for (const a of v.airLoads()) wDamage = Math.max(wDamage, Math.abs(a.damage - (damage.get(a.part) || 0)));
      }
      if (tornNow.length && !predicted) predicted = { step, parts: tornNow };
      if (events.length) first = { step, events: events.filter(e => e.mode === 'airflow') };
    }
    S.ok(`${name}: something is over its rating and comes off`, !!predicted && !!first, predicted ? `first after ${(predicted.step * DT).toFixed(2)} s` : 'nothing predicted');
    if (!predicted || !first) continue;
    S.check(`${name}: the step on which the first part is torn off, game vs the law replayed from the state`, predicted.step, first.step, 0, { unit: 'steps', note: `${first.events.length} part(s) on that step` });
    const want = predicted.parts.map(p => p.id).sort((a, b) => a - b), got = first.events.map(e => e.air.part).sort((a, b) => a - b);
    S.ok(`  ${name}: the same parts`, want.length === got.length && want.every((id, i) => id === got[i]), `reference ${want.join(',')} / game ${got.join(',')}`);
    let wq = 0;
    for (const e of first.events) { const p = predicted.parts.find(x => x.id === e.air.part); if (p) wq = Math.max(wq, Math.abs(e.air.q - p.q) / p.q, Math.abs(e.air.rated - p.rated)); }
    S.check(`  ${name}: the pressure and rating the event reports`, 0, wq, 1e-9, { unit: 'rel' });
    S.check(`  ${name}: the game's damage counters on the way there vs the replay`, 0, wDamage, 1e-9, {});
  }
  // a brief gust does nothing: 100 % over for half the fail time, then calm
  {
    const { w, v } = inAir('Colossus', { tilt: [Math.PI / 2, 0, 0], speed: 300, alt: 6000 });
    let lost = 0;
    w.on('structure', d => { if (d.mode === 'airflow') lost++; });
    const s = stateOf(v);
    const clamp = s.parts.find(p => p.type === 'dec_radial_l'), f = ratedFlow(s, clamp);
    const over = f.q / f.rated - 1, steps = Math.max(1, Math.floor(0.5 * STRUCT.AIR_FAIL_TIME / over / DT));
    for (let i = 0; i < steps; i++) w.step(DT);
    const dmg = Math.max(...v.airLoads().map(a => a.damage));
    // now turn it nose first and let it recover
    v.q.setFromUnitVectors(new Vector3(0, 1, 0), v.surfaceVel.clone().normalize()); v.w.set(0, 0, 0);
    for (let i = 0; i < Math.ceil(STRUCT.HEAL_TIME / DT) + 2; i++) w.step(DT);
    S.ok(`Colossus broadside for ${(steps * DT).toFixed(2)} s (${(over * 100).toFixed(0)} % over a clamp's rating), then nose first: nothing comes off`, lost === 0, `damage reached ${dmg.toFixed(2)}`);
    S.check('  and the strain is gone again after STRUCT.HEAL_TIME', 0, Math.max(...v.airLoads().map(a => a.damage)), 1e-12, {});
  }
  // with breaking switched off nothing leaves, whatever the airflow
  {
    TUNING.AERO_FAIL = false;
    try {
      const { w, v } = inAir('Colossus', { tilt: [Math.PI / 2, 0, 0], speed: 300, alt: 6000 });
      const n0 = v.parts.size;
      let top = 0;
      for (let i = 0; i < 100; i++) { w.step(DT); top = Math.max(top, v.airUtil); }
      S.ok('TUNING.AERO_FAIL = false: the ratings are still read, and nothing is torn off', v.parts.size === n0 && top > 1, `air utilisation reached ${top.toFixed(2)}`);
    } finally { TUNING.AERO_FAIL = true; }
  }
}

// ------------------------------------------------------------------------------------------ 8e what a tear-off conserves
function conservation(S) {
  // Two worlds in step: in one nothing may break. On the step a part is torn off, the ship and its pieces together
  // must have the mass, the momentum and the mass centre of the unbroken vessel of the other world.
  for (const [name, opts] of [['Colossus', { tilt: [Math.PI / 2, 0, 0], speed: 300, alt: 6000 }], ['Hearthstone Core', { tilt: [0, 0, 1.2], spin: [0, 0, 1.4], speed: 340, alt: 7000 }]]) {
    const re = inAir(name, opts), sh = inAir(name, opts);
    const pieces = [];
    re.w.on('structure', d => { if (d.vessel === re.v && d.debris && !pieces.includes(d.debris)) pieces.push(d.debris); });
    let broke = false;
    for (let i = 0; i < 400 && !broke; i++) {
      TUNING.AERO_FAIL = false; sh.w.step(DT); TUNING.AERO_FAIL = true;
      re.w.step(DT);
      broke = pieces.length > 0;
    }
    if (!S.ok(`${name}: a part is torn off`, broke)) continue;
    const all = [re.v, ...pieces];
    const m = all.reduce((s, x) => s + x.mass, 0);
    const P = all.reduce((s, x) => add(s, scale(A(x.vel), x.mass)), [0, 0, 0]);
    const C = scale(all.reduce((s, x) => add(s, scale(A(x.pos), x.mass)), [0, 0, 0]), 1 / m);
    S.check(`${name}: mass of ship + ${pieces.length} piece(s) vs the unbroken vessel`, sh.v.mass, m, 1e-12, { rel: true, unit: 'kg' });
    S.check('  momentum of ship + pieces vs the unbroken vessel (the push apart is shared by mass)', 0, norm(sub(P, scale(A(sh.v.vel), sh.v.mass))) / (sh.v.mass * norm(A(sh.v.vel))), 1e-12, { unit: 'rel' });
    S.check('  mass centre of ship + pieces vs the unbroken vessel', 0, norm(sub(C, A(sh.v.pos))), 1e-6, { unit: 'm' });
    // each piece leaves at no more than the push and the spin the constants allow
    let wPush = 0, wSpin = 0;
    for (const d of pieces) {
      // velocity of that point of the rigid vessel: v + w x r, r from the ship's mass centre (world)
      const r = sub(A(d.pos), A(sh.v.pos));
      const rigid = add(A(sh.v.vel), toWorld([sh.v.q.x, sh.v.q.y, sh.v.q.z, sh.v.q.w], cross(A(sh.v.w), toBody([sh.v.q.x, sh.v.q.y, sh.v.q.z, sh.v.q.w], r))));
      wPush = Math.max(wPush, norm(sub(A(d.vel), rigid)));
      wSpin = Math.max(wSpin, norm(sub(A(d.w), A(sh.v.w))));
    }
    S.ok(`  no piece leaves faster than STRUCT.DEBRIS_PUSH (${STRUCT.DEBRIS_PUSH} m/s) relative to where it sat`, wPush <= STRUCT.DEBRIS_PUSH * 1.0001, `${wPush.toFixed(3)} m/s`);
    S.ok(`  no piece is given more spin than STRUCT.DEBRIS_SPIN allows (${STRUCT.DEBRIS_SPIN} rad/s an axis)`, wSpin <= STRUCT.DEBRIS_SPIN * 1.5 + 1e-9, `${wSpin.toFixed(3)} rad/s`);
  }
}

// ------------------------------------------------------------------------------------------ 8f stock craft: clean climb, flip
function flyUp(craft, { flip = false, maxT = 150 } = {}) {
  const w = new World();
  const v = w.launch(craft, { crew: ['Ada'] });
  const lost = [], shed = [];
  w.on('structure', d => (d.vessel === v ? lost : shed).push({ name: d.air ? d.air.name : d.joint.bName, mode: d.mode }));
  v.ctrl.throttle = 1; v.ctrl.sas = true; w.stage();
  let t = 0, maxQ = 0, flipped = false, tFlip = 0, peakAir = 0, peakRoot = 0, most = 0;
  const rated0 = v.airLoads().length;
  while (t < maxT && !v.dead) {
    w.step(DT); t += DT;
    const q = v.dynamicPressure;
    if (q > maxQ) maxQ = q;
    if (!flip && v.thrust === 0 && v.stageIndex < v.stages.length) w.stage();
    if (flip && !flipped && (q > 20000 || (t > 20 && q < maxQ * 0.97 && q > 5000))) { flipped = true; tFlip = t; }
    if (flipped) { v.ctrl.sas = false; v.ctrl.pitch = 1; if (t - tFlip > 25) break; }
    peakAir = Math.max(peakAir, v.airUtil || 0);
    if (v.structure) for (const j of v.structure.joints) if (j.rh > 0 && j.util > peakRoot) peakRoot = j.util;
    let loose = 0; for (const x of w.vessels) if (x.type === 'debris' && !x.dead && !x.landed) loose++;
    most = Math.max(most, loose);
  }
  return { v, w, lost, shed, maxQ, peakAir, peakRoot, flipped, rated0, most, clampsLeft: [...v.parts.values()].filter(p => p.def.shape === 'radialdec').length };
}
function stockFlights(S, full) {
  const rockets = stockCrafts().filter(c => c.site !== 'runway' && !/Trundle Scout|Moonstep/.test(c.name));
  const names = full ? rockets.map(c => c.name) : ['Ember Twin', 'Colossus', 'Skylark II'];
  for (const c of rockets) {
    if (!names.includes(c.name)) continue;
    const r = flyUp(c);
    S.ok(`${c.name}, straight up at full throttle through max Q (${(r.maxQ / 1000).toFixed(0)} kPa): the ship loses nothing`, r.lost.length === 0, r.lost.map(l => l.name).join(', '));
    S.ok(`  ${c.name}: no rated part passes half its air rating, no fin root half its strength`, r.peakAir < 0.5 && r.peakRoot < 0.5, `air ${r.peakAir.toFixed(2)}, fin roots ${r.peakRoot.toFixed(2)}`);
  }
  // pitched hard over at max Q and held there
  const boosters = full ? ['Ember Twin', 'Latch Chaser', 'Colossus', 'Farwind', 'Hearthstone Core'] : ['Ember Twin', 'Colossus'];
  for (const name of boosters) {
    const r = flyUp(stock(name), { flip: true });
    const air = r.lost.filter(l => l.mode === 'airflow');
    S.ok(`${name}, pitched hard over at max Q and held: every side booster is torn from its clamp`, r.flipped && r.clampsLeft === 0, `${air.length} part(s) torn off by the airflow: ${air.map(l => l.name).join(', ')}`);
    S.info(`  ${name}: also lost`, r.lost.filter(l => l.mode !== 'airflow').length + r.shed.length, 'parts', `ship (joints): ${r.lost.filter(l => l.mode !== 'airflow').map(l => l.name).join(', ') || 'none'}; from the pieces: ${r.shed.map(l => l.name).join(', ') || 'none'}`);
    S.ok(`  ${name}: never more than MAX_DEBRIS (${MAX_DEBRIS}) loose pieces in flight`, r.most <= MAX_DEBRIS, `most at once: ${r.most}`);
  }
}

// ------------------------------------------------------------------------------------------ 8g the debris limit
function debrisLimit(S) {
  // a core ringed with far more antennas than the limit, thrown broadside into thick air
  const c = new Craft('Hedgehog');
  const [core] = c.setRoot('probe_keystone');
  let last = core;
  const N = 40;
  for (let k = 0; k < 5; k++) {
    const [tank] = c.attachStack('tank_m800', last.id, 'bottom');
    c.attachRadial('antenna', tank.id, tank.pos.y, 0, 8);
    last = tank;
  }
  c.autoStage();
  const { w, v } = inAir(null, { craft: c, tilt: [Math.PI / 2, 0, 0], speed: 320, alt: 5000 });
  const n0 = [...v.parts.values()].filter(p => p.def.antenna).length;
  let most = 0, torn = 0, removed = 0;
  w.on('structure', d => { if (d.mode === 'airflow') torn++; });
  w.on('destroyed', d => { if (d.reason === 'breakup') removed++; });
  for (let i = 0; i < 150; i++) {
    w.step(DT);
    let loose = 0; for (const x of w.vessels) if (x.type === 'debris' && !x.dead && !x.landed) loose++;
    most = Math.max(most, loose);
  }
  S.ok(`${n0} whip antennas (of ${N}) on one core, broadside at 320 m/s: all are torn off`, torn === n0 && n0 === N, `${torn} torn`);
  S.check(`  loose pieces in flight at any one time: never more than MAX_DEBRIS`, MAX_DEBRIS, most, 0, { unit: 'pieces' });
  S.check('  the rest were removed as they came off (lightest first)', n0 - MAX_DEBRIS, removed, 0, { unit: 'pieces' });
  S.ok('  the ship itself is still there', !v.dead && w.vessels.includes(v));
}

export const groups = [
  { name: '8a. Thin roots of fins and wings: strength vs line loads integrated round the rectangle', fast: true, run: S => thinRoots(S) },
  { name: '8b. Live game: the airflow on every rated part vs the vessel\'s state', fast: true, run: (S, full) => ratedAirflow(S, full) },
  { name: '8c. An open solar panel is a flat plate: force and moment vs closed form', fast: true, run: S => openPanel(S) },
  { name: '8d. Tear-off: which part, on which step, vs the law replayed from the state', fast: true, run: (S, full) => tearLaw(S, full) },
  { name: '8e. A tear-off keeps mass, momentum and mass centre', fast: true, run: S => conservation(S) },
  { name: '8f. Stock craft: a clean climb loses nothing, a flip at max Q strips the boosters', fast: true, run: (S, full) => stockFlights(S, full) },
  { name: '8g. The limit on loose pieces', fast: true, run: S => debrisLimit(S) },
];
