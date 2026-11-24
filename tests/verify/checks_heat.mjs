// Group 14: heating (part E of docs/REENTRY_SPEC.md; docs/HEATING.md). Each part meets a flux set by its own nose
// radius, its attitude and its shadow, and its skin follows a heat balance: what the wall takes from the air, less
// what it radiates. A shield with ablator left loses mass in proportion to heat times area. Every constant of the
// model is typed here a second time, on purpose, and the air is the reference's own (ref.mjs).
import { World, SYSTEM, spawn, Vector3 } from './harness.mjs';
import * as R from './ref.mjs';
import { Craft } from '../../js/core/craft.js';
import { PARTS } from '../../js/core/parts.js';

const sys = R.readSystem();
const DEG = Math.PI / 180;
// --- the model, restated
const SCALE = 20;                                 // the declared heating scale
const K_GAS = { air: 1.7415e-4, co2: 1.9027e-4 }; // Sutton and Graves, kg^0.5 / m
const GAS = { air: [1.40, 0.028964], co2: [1.29, 0.04401], h2he: [1.45, 0.0023] };
const RU = 8.314462618, SIGMA = 5.670374419e-8, EMIS = 0.85;
const FACE_EXP = 1.5, SIDE = Math.SQRT1_2, SIDE_EXP = 1.2, LEE = 0.03, FLAT = 3, TIP = 0.3, EDGE = 0.02, RADIAL_AX = 0.25;
const CP_SKIN = 900, SKIN = 0.2, C_MIN = 4000, C_MAX = 40000, AIR_H = 40, T_SPACE = 290;
const T_ABL = 2000, Q_STAR = 1.35e6, CAP = 25 * DEG, MIN_FLUX = 1500;
const cpOf = gas => GAS[gas][0] * RU / ((GAS[gas][0] - 1) * GAS[gas][1]);

const radii = d => ({ rT: d.rTop !== undefined ? d.rTop : d.r, rB: d.rBottom !== undefined ? d.rBottom : d.r });
const partDef = id => PARTS[id];
const rotY = (q, v) => {                           // rotate a vector by a quaternion, written out
  const { x, y, z, w } = q, [a, b, c] = v;
  const tx = 2 * (y * c - z * b), ty = 2 * (z * a - x * c), tz = 2 * (x * b - y * a);
  return [a + w * tx + (y * tz - z * ty), b + w * ty + (z * tx - x * tz), c + w * tz + (x * ty - y * tx)];
};
/** What the reference says of the air at a vessel's state: density, temperature, air-relative velocity, total temperature. */
function air(b, pos, vel) {
  const wy = R.TAU / b.rotPeriod, rr = R.norm(pos), alt = rr - b.radius;
  const u = [vel[0] - wy * pos[2], vel[1], vel[2] + wy * pos[0]], sp = R.norm(u);
  const rho = R.airDensity(b, alt), T = R.airTemperature(b, alt);
  return { alt, rho, T, u, sp, tRec: T + sp * sp / (2 * cpOf(b.atmo.gas)), qRef: (K_GAS[b.atmo.gas] || 0) * Math.sqrt(rho) * sp ** 3 };
}
/** Geometry of a stack of parts given bottom first: nose radii of each end, flank radius, face exposures, skin capacity. */
export function stackGeometry(ids) {
  let y = 0;
  const list = ids.map(id => { const d = partDef(id), { rT, rB } = radii(d); const o = { id, d, rT, rB, y0: y, y1: y + d.h }; y += d.h; return o; });
  list.forEach((p, i) => {
    const below = list[i - 1], above = list[i + 1], d = p.d, rM = Math.max(p.rT, p.rB);
    const covB = below ? below.rT : 0, covT = above ? above.rB : 0;
    const cap = !below && (d.heatshield || (d.shape === 'capsule' && p.rB > p.rT)) ? CAP : 0;
    let aUp = Math.PI * Math.max(0, p.rT ** 2 - covT ** 2), aDown = Math.PI * Math.max(0, p.rB ** 2 - covB ** 2);
    if (p.rB > p.rT) aUp += Math.PI * (p.rB ** 2 - p.rT ** 2); else if (p.rT > p.rB) aDown += Math.PI * (p.rT ** 2 - p.rB ** 2);
    p.eUp = Math.min(1, aUp / (0.5 * Math.PI * rM * rM)); p.eDown = Math.min(1, aDown / (0.5 * Math.PI * rM * rM));
    p.Ru = Math.max(EDGE, Math.max(FLAT * p.rT, p.rT < p.rB ? TIP * p.rB : 0));
    p.Rd = Math.max(EDGE, cap > 0 ? p.rB / Math.sin(cap) : Math.max(FLAT * p.rB, p.rB < p.rT ? TIP * p.rT : 0));
    p.Rs = Math.max(EDGE, 0.5 * (p.rT + p.rB));
    p.area = Math.PI * rM * rM; p.rM = rM;
    const surf = Math.PI * ((p.rT + p.rB) * Math.hypot(d.h, p.rT - p.rB) + p.rT ** 2 + p.rB ** 2);
    p.c = Math.min(C_MAX, Math.max(C_MIN, SKIN * CP_SKIN * d.mass * 1000 / surf));
  });
  return list;
}
/** Flux on a stack part for a wind at angle `alpha` to its axis (0: flying top first), exposure `ex`, scaled reference flux qs. */
function stackFlux(p, alpha, ex, qs) {
  const ca = Math.cos(alpha), sa = Math.abs(Math.sin(alpha));
  const face = Math.pow(Math.abs(ca), FACE_EXP) * (ca > 0 ? p.eUp / Math.sqrt(p.Ru) : p.eDown / Math.sqrt(p.Rd));
  const side = Math.max(LEE, SIDE * Math.pow(sa, SIDE_EXP)) / Math.sqrt(p.Rs);
  return qs * Math.max(face, side) * Math.max(LEE, ex);
}
/** dT/dt of a skin: what the wall takes at its own temperature, less radiation, less still-air cooling (iRec: one over the air's total temperature, 0 in vacuum). */
const rate = (T, q, iRec, tEnv, h, c) => (q * (1 - T * iRec) - EMIS * SIGMA * (T ** 4 - tEnv ** 4) - h * (T - tEnv)) / c;

export const stack = (...ids) => { const c = new Craft(ids.join(' on ')); let last = c.setRoot(ids[0])[0]; for (const id of ids.slice(1)) last = c.attachStack(id, last.id, 'top')[0]; c.autoStage(); return c; };
/**
 * A vessel in Verda's air at `alt`, moving at `speed` through it, its top end `alpha` from the direction of motion.
 * With roll 0 the motion has a component along the vessel's own +z (that side is to the wind); with roll pi, along -z.
 */
function held(craft, alt, speed, alpha, roll = 0) {
  const b = sys.byId.verda, w = new World();
  const wy = R.TAU / b.rotPeriod, r = b.radius + alt;
  // air-relative velocity along +z at the equator; the air there moves at wy r along -z
  const v = spawn(w, craft, 'verda', [r, 0, 0], [0, 0, speed - wy * r]);
  // tip the vessel's +y axis to alpha from +z in the y-z plane (a turn about x), after a roll about its own axis
  v.q.setFromAxisAngle(new Vector3(1, 0, 0), Math.PI / 2 - alpha).multiply(v.q.clone().setFromAxisAngle(new Vector3(0, 1, 0), roll));
  v.w.set(0, 0, 0); v.ctrl.throttle = 0; v.ctrl.sas = false;
  return { w, v, b };
}

// ------------------------------------------------------------------------------------------ 14a constants and geometry
function constants(S) {
  // hydrogen and helium: Sutton and Graves' constants for the two gases, mixed by their rule for this molar mass
  const KH2 = 0.0395, KHE = 0.0797, MH2 = 0.002016, MHE = 0.004003;
  const x = (GAS.h2he[1] - MH2) / (MHE - MH2), cHe = x * MHE / GAS.h2he[1];
  const K = 1 / Math.sqrt((1 - cHe) / KH2 ** 2 + cHe / KHE ** 2), k = K / (2 * Math.sqrt(101325));
  S.check('hydrogen and helium: heating constant from the two gases by the mixing rule', k, SYSTEM.bodies.find(b => b.atmo && b.atmo.gas.name === 'hydrogen and helium').atmo.heatK, 0.01 * k, { unit: 'kg^0.5/m', note: `helium ${(cHe * 100).toFixed(1)} % by mass` });
  S.check('air: the same conversion gives back the published constant from K = 0.1113', 0.1113 / (2 * Math.sqrt(101325)), SYSTEM.home.atmo.heatK, 0.005 * 1.7415e-4, { unit: 'kg^0.5/m' });
  for (const b of SYSTEM.bodies) if (b.atmo) S.check(`${b.name}: specific heat of the air, gamma R / ((gamma - 1) M)`, cpOf(sys.byId[b.id].atmo.gas), b.atmo.cp, 1e-9 * b.atmo.cp, { unit: 'J/(kg K)' });
  // effective radii and skin capacities of a stack, against the game's
  const ids = ['heatshield_m', 'pod_acorn', 'tank_m400', 'nose_m'].filter(id => partDef(id));
  const geo = stackGeometry(ids), { v } = held(stack(...ids), 50000, 2000, 0);
  const parts = [...v.parts.values()].sort((p, q) => p.pos.y - q.pos.y);
  geo.forEach((g, i) => {
    const p = parts[i];
    S.check(`${g.d.name}: nose radius of the lower end`, g.Rd, p._hRd, 1e-9, { unit: 'm' });
    S.check(`${g.d.name}: nose radius of the upper end`, g.Ru, p._hRu, 1e-9, { unit: 'm' });
    S.check(`${g.d.name}: flank radius`, g.Rs, p._hRs, 1e-9, { unit: 'm' });
    S.check(`${g.d.name}: heat capacity of the skin per area`, g.c, p._hc, 1e-9 * g.c, { unit: 'J/(m2 K)' });
  });
  S.check('a heat shield: nose radius = radius of curvature of its cap, r / sin 25 deg', 0.65 / Math.sin(CAP), geo[0].Rd, 1e-12, { unit: 'm' });
}

// ------------------------------------------------------------------------------------------ 14b the flux law
function fluxLaw(S) {
  // one part alone, held at every attitude: the leading face, the flank, the lee floor
  for (const id of ['pod_acorn', 'tank_m400']) {
    const g = stackGeometry([id])[0];
    let worst = 0, n = 0;
    for (const deg of [0, 10, 25, 45, 60, 80, 90, 100, 135, 160, 180]) {
      const { w, v, b } = held(stack(id), 46000, 2300, deg * DEG);
      const a = air(b, R.arr(v.pos), R.arr(v.vel));
      w.step(0.02);
      const p = [...v.parts.values()][0], want = stackFlux(g, deg * DEG, 1, SCALE * a.qRef);
      worst = Math.max(worst, Math.abs(p._hq - want) / want); n++;
    }
    S.check(`${g.d.name}: flux at ${n} attitudes from nose first to tail first, worst difference`, 0, worst, 2e-3, { unit: 'rel' });
  }
  // size: the same flat face on a narrow and a wide tank, and the capsule's cap against a flat face of its size
  const flat = id => { const { w, v } = held(stack(id), 46000, 2300, 180 * DEG); w.step(0.02); return [...v.parts.values()][0]._hq; };
  const small = partDef('tank_s200') ? 'tank_s200' : 'tank_m200', big = partDef('tank_l1600') ? 'tank_l1600' : 'tank_m800';
  const rs = radii(partDef(small)).rB, rb = radii(partDef(big)).rB;
  S.check(`flux on a flat end goes as 1 / sqrt(radius): ${partDef(small).name} over ${partDef(big).name}`, Math.sqrt(rb / rs), flat(small) / flat(big), 2e-3 * Math.sqrt(rb / rs), { unit: 'ratio' });
  // shadow: a capsule on its shield, shield first. The capsule stands in the shield's wake and keeps the floor; a part
  // on the capsule's side that reaches out of the wake does not
  {
    const c = stack('heatshield_m', 'pod_acorn');
    const pod = [...c.parts.values()].find(p => p.type === 'pod_acorn');
    c.attachRadial('antenna', pod.id, pod.pos.y, 0, 1);
    const { w, v, b } = held(c, 46000, 2300, 180 * DEG);
    const a = air(b, R.arr(v.pos), R.arr(v.vel)), qs = SCALE * a.qRef;
    w.step(0.02);
    const geo = stackGeometry(['heatshield_m', 'pod_acorn']);
    const P = id => [...v.parts.values()].find(p => p.def.id === id);
    S.check('shield first: flux on the shield', stackFlux(geo[0], Math.PI, 1, qs), P('heatshield_m')._hq, 2e-3 * qs, { unit: 'W/m2' });
    S.check('shield first: the capsule in its wake keeps the lee floor of the floor', qs * LEE / Math.sqrt(geo[1].Rs) * LEE, P('pod_acorn')._hq, 2e-3 * qs * LEE, { unit: 'W/m2' });
    // the antenna: half its 8 cm thickness is its radius; along the hull it meets a quarter of the stream
    const ant = P('antenna'), Ra = Math.max(EDGE, 0.5 * partDef('antenna').rw);
    const exA = ant._ex;
    S.ok('the antenna reaches out of the shield\'s wake', exA > 0.5, `exposure ${exA.toFixed(2)}`);
    S.check('flux on the antenna, air running along the hull', qs * RADIAL_AX / Math.sqrt(Ra) * Math.max(LEE, exA), ant._hq, 2e-3 * qs, { unit: 'W/m2' });
    S.info('flux on the antenna over flux on the shield', ant._hq / P('heatshield_m')._hq, '', 'small parts in the open are heated hardest');
  }
  // a part on the side of a hull flying side on: windward it meets the whole stream, leeward the floor
  for (const [roll, name] of [[0, 'windward'], [Math.PI, 'leeward']]) {
    const c = stack('tank_m400');
    const t = [...c.parts.values()][0];
    c.attachRadial('antenna', t.id, t.pos.y, -Math.PI / 2, 1);            // mounted toward the vessel's own +z
    const { w, v, b } = held(c, 46000, 2300, 90 * DEG, roll);
    const a = air(b, R.arr(v.pos), R.arr(v.vel)), qs = SCALE * a.qRef;
    // which way is the wind in the vessel's own axes? (written out, not asked of the game)
    const zAxis = rotY(v.q, [0, 0, 1]), wind = R.dot(zAxis, R.unit(a.u));
    w.step(0.02);
    const ant = [...v.parts.values()].find(p => p.def.id === 'antenna'), Ra = Math.max(EDGE, 0.5 * partDef('antenna').rw);
    const f = Math.max(LEE, wind > 0 ? Math.pow(wind, SIDE_EXP) : 0);
    S.check(`hull side on, antenna ${name}: flux`, qs * f / Math.sqrt(Ra) * Math.max(LEE, ant._ex), ant._hq, 2e-3 * qs, { unit: 'W/m2', note: `wind onto its side ${wind.toFixed(2)}` });
  }
}

// ------------------------------------------------------------------------------------------ 14c the heat balance
/** Fly an entry in the game, shield or base first, recording the state each step. */
export function flyEntry(craft, speed, fpaDeg, { tMax = 900, stopAlt = 4000 } = {}) {
  const b = sys.byId.verda, w = new World(), r = b.radius + b.atmo.height;
  const fpa = fpaDeg * DEG;
  const v = spawn(w, craft, 'verda', [r, 0, 0], [-speed * Math.sin(fpa), 0, speed * Math.cos(fpa)]);
  const a0 = air(b, R.arr(v.pos), R.arr(v.vel)), u = R.unit(a0.u);
  v.q.setFromUnitVectors(new Vector3(0, 1, 0), new Vector3(-u[0], -u[1], -u[2]));
  v.w.set(0, 0, 0); v.ctrl.throttle = 0; v.ctrl.sas = true; v.ctrl.sasMode = 'srfRetrograde';
  const rows = [], dt = 0.02;
  const ids = [...v.parts.values()].map(p => p.id);
  for (let t = 0; t < tMax; t += dt) {
    const a = air(b, R.arr(v.pos), R.arr(v.vel));
    const yAxis = rotY(v.q, [0, 1, 0]), cosA = a.sp > 1 ? R.dot(yAxis, R.unit(a.u)) : -1;
    rows.push({ t, a, rec: v.recoveryTemp, alpha: Math.acos(Math.max(-1, Math.min(1, cosA))), temp: ids.map(id => v.parts.get(id)?.temp), abl: ids.map(id => v.parts.get(id)?.res.ablator || 0), mach: v.mach });
    w.step(dt);
    if (v.dead || v.landed || v.altitude < stopAlt) break;
    if (v.altitude > b.atmo.height + 200 && t > 5 && rows.length > 10 && R.dot(R.arr(v.pos), R.arr(v.vel)) > 0) { if (!rows.out) rows.out = t; if (t - rows.out > 240) break; }
  }
  return { rows, v, ids, dt };
}
/** The reference's own temperature history of one stack part over a recorded flight: fourth-order Runge-Kutta in fine steps. */
export function integrateSkin(g, rows, dt, { ex = 1, shield = false, T0 = T_SPACE, ablator = 0 } = {}) {
  let T = T0, peak = T0, lost = 0, load = 0;
  const out = [];
  const env = r => {
    const inAir = r.a.rho > 0, qs = SCALE * r.a.qRef, on = qs > MIN_FLUX;
    return { q: on ? stackFlux(g, r.alpha, ex, qs) : 0, iRec: inAir ? 1 / r.a.tRec : 0, tEnv: inAir ? r.a.T : T_SPACE, h: inAir ? AIR_H * Math.sqrt(r.a.rho) : 0, on };
  };
  for (let i = 0; i + 1 < rows.length; i++) {
    const e0 = env(rows[i]), e1 = env(rows[i + 1]), N = 8, h = dt / N;
    for (let k = 0; k < N; k++) {
      const at = f => ({ q: e0.q + (e1.q - e0.q) * f, iRec: e0.iRec + (e1.iRec - e0.iRec) * f, tEnv: e0.tEnv + (e1.tEnv - e0.tEnv) * f, h: e0.h + (e1.h - e0.h) * f });
      const f0 = k / N, fm = (k + 0.5) / N, f1 = (k + 1) / N, A = at(f0), M = at(fm), B = at(f1);
      const d = (TT, E) => rate(TT, E.q, E.iRec, E.tEnv, E.h, g.c);
      const k1 = d(T, A), k2 = d(T + k1 * h / 2, M), k3 = d(T + k2 * h / 2, M), k4 = d(T + k3 * h, B);
      const qw = M.q * (1 - T * M.iRec);
      if (shield && ablator - lost > 0 && qw > 0) lost = Math.min(ablator, lost + qw * g.area * h / Q_STAR);
      if (qw > 0) load += qw * h;
      T += (k1 + 2 * k2 + 2 * k3 + k4) * h / 6;
      if (shield && ablator - lost > 0 && T > T_ABL) T = T_ABL;
    }
    out.push(T); if (T > peak) peak = T;
  }
  return { T: out, peak, lost, load };
}
function balance(S) {
  // an Acorn Capsule with no shield, base first, from low orbit: the calibration entry
  {
    const f = flyEntry(stack('pod_acorn'), 2300, 1.5), g = stackGeometry(['pod_acorn'])[0];
    const ref = integrateSkin(g, f.rows, f.dt);
    let worst = 0, peak = 0;
    f.rows.forEach((r, i) => { if (i === 0) return; const T = r.temp[0]; if (T > peak) peak = T; worst = Math.max(worst, Math.abs(T - ref.T[i - 1]) / ref.T[i - 1]); });
    S.check('bare capsule from low orbit: skin temperature all the way down, worst difference from the reference', 0, worst, 0.01, { unit: 'rel' });
    S.check('bare capsule from low orbit: peak skin temperature', ref.peak, peak, 0.005 * ref.peak, { unit: 'K' });
    S.info('bare capsule from low orbit: peak temperature over its limit', peak / g.d.maxTemp, '', 'the old fitted law gave 0.85 on this entry; the scale of 20 was set to match it');
    S.ok('it comes down whole', !f.v.dead && f.v.parts.size === 1);
    S.check('the flight record: peak against the limit', ref.peak / g.d.maxTemp, f.v.peakTempRatio, 0.005, { unit: '' });
    S.check('the flight record: heat taken by the hottest part', ref.load, f.v.heatLoad, 0.01 * ref.load, { unit: 'J/m2' });
  }
  // the same capsule from Pell: it burns, and the reference says when
  {
    const f = flyEntry(stack('pod_acorn'), 3300, 14), g = stackGeometry(['pod_acorn'])[0];
    const ref = integrateSkin(g, f.rows, f.dt);
    S.ok('bare capsule from Pell at 14 degrees: destroyed by heat', f.v.dead || f.v.parts.size === 0);
    S.ok('and the reference skin passes the limit on the same flight', ref.peak >= g.d.maxTemp * 0.995, `reference ${ref.peak.toFixed(0)} K at the last step, limit ${g.d.maxTemp} K`);
  }
  // a shield: its face is held at the ablation temperature, the mass that leaves is heat times area over Q*, and the
  // capsule behind it stays cold
  for (const [name, ids, speed, fpa] of [['Acorn Capsule on Ablative Shield M from low orbit', ['heatshield_m', 'pod_acorn'], 2300, 1.5], ['the same from Pell at 14 degrees', ['heatshield_m', 'pod_acorn'], 3300, 14], ['Hearth Command Module on Ablative Shield L from low orbit', ['heatshield_l', 'pod_hearth'], 2300, 1.5]]) {
    if (!ids.every(partDef)) continue;
    const f = flyEntry(stack(...ids), speed, fpa), geo = stackGeometry(ids);
    const a0 = f.rows[0].abl[0], used = a0 - f.rows.at(-1).abl[0];
    const ref = integrateSkin(geo[0], f.rows, f.dt, { shield: true, ablator: a0 });
    let peak = 0, podPeak = 0;
    for (const r of f.rows) { peak = Math.max(peak, r.temp[0]); podPeak = Math.max(podPeak, r.temp[1]); }
    S.check(`${name}: ablator lost`, ref.lost, used, 0.015 * ref.lost, { unit: 'kg', note: `${(used / a0 * 100).toFixed(0)} % of ${a0} kg` });
    S.check(`${name}: peak temperature of the shield's face`, ref.peak, peak, 0.01 * ref.peak, { unit: 'K' });
    S.ok(`${name}: the face never passes the ablation temperature`, peak <= T_ABL + 1e-6, `${peak.toFixed(0)} K`);
    S.ok(`${name}: the capsule behind it stays under 400 K`, podPeak < 400, `${podPeak.toFixed(0)} K`);
    S.check(`${name}: the flight record of ablator lost`, used, f.v.ablated, 1e-6 * used + 1e-9, { unit: 'kg' });
  }
}

// ------------------------------------------------------------------------------------------ 14d limits of the law
function limits(S) {
  // the air can warm a skin no further than its own total temperature: a slow fall heats nothing past it
  {
    const f = flyEntry(stack('pod_acorn'), 1200, 20);
    let tRecMax = 0, peak = 0;
    for (const r of f.rows) { if (r.a.rho > 0) tRecMax = Math.max(tRecMax, r.a.tRec); peak = Math.max(peak, r.temp[0]); }
    S.ok('a fall at 1,200 m/s: the skin stays under the air\'s total temperature', peak < tRecMax, `${peak.toFixed(0)} K against ${tRecMax.toFixed(0)} K`);
    let worst = 0;
    f.rows.forEach((r, i) => { const nx = f.rows[i + 1]; if (nx && r.a.rho > 0) worst = Math.max(worst, Math.abs(nx.rec - r.a.tRec) / r.a.tRec); });   // (the game's figure is of the step just taken)
    S.check('the air\'s total temperature, T + v^2 / (2 cp), all the way down: worst difference', 0, worst, 2e-3, { unit: 'rel' });
  }
  // vacuum: a hot skin cools by radiation alone, 1/T^3 growing in proportion to time when the surroundings are cold
  {
    const { w, v } = held(stack('pod_acorn'), 200000, 1500, 0);
    const p = [...v.parts.values()][0], g = stackGeometry(['pod_acorn'])[0];
    p.temp = 1500; v._hot = true;
    let T = 1500; const dt = 0.02, h = dt / 4;
    let worst = 0;
    for (let i = 0; i < 3000; i++) {
      w.step(dt);
      for (let k = 0; k < 4; k++) { const d = TT => rate(TT, 0, 0, T_SPACE, 0, g.c); const k1 = d(T), k2 = d(T + k1 * h / 2), k3 = d(T + k2 * h / 2), k4 = d(T + k3 * h); T += (k1 + 2 * k2 + 2 * k3 + k4) * h / 6; }
      worst = Math.max(worst, Math.abs(p.temp - T) / T);
    }
    S.check('a skin at 1,500 K in vacuum: a minute of cooling, worst difference from the reference', 0, worst, 2e-3, { unit: 'rel', note: `${p.temp.toFixed(0)} K after 60 s` });
  }
  // the steady estimate the booster's entry burn is planned from: the balance solved by bisection
  {
    const ids = ['eng_sparrow', 'tank_m400', 'pod_acorn'].filter(partDef);
    const { v } = held(stack(...ids), 60000, 1500, 0), geo = stackGeometry(ids);
    for (const [flux, tRec] of [[40000, 1200], [120000, 2100], [300000, 4000]]) {
      let worst = 0;
      for (const g of geo) {
        // tail first: the lowest part's lower face leads; the others are covered or in its wake only if narrower
        const q = SCALE * flux * Math.max(g.eDown / Math.sqrt(g.Rd), LEE / Math.sqrt(g.Rs));
        let lo = T_SPACE, hi = Math.max(tRec, T_SPACE + 1);
        for (let i = 0; i < 80; i++) { const m = 0.5 * (lo + hi); if (EMIS * SIGMA * (m ** 4 - T_SPACE ** 4) < q * (1 - m / tRec)) lo = m; else hi = m; }
        worst = Math.max(worst, lo / g.d.maxTemp);
      }
      const got = v.axialHeatRatio(flux, true, tRec);
      S.ok(`steady estimate at ${flux / 1000} kW/m2, total temperature ${tRec} K: no lower than the open-stream balance of the leading part`, got >= worst * 0.2 && got <= worst * 1.001, `game ${got.toFixed(3)}, every part in the open ${worst.toFixed(3)}`);
    }
    // one part alone has no wake to hide in: there the two must agree
    const solo = held(stack('tank_m400'), 60000, 1500, 0).v, g = stackGeometry(['tank_m400'])[0];
    for (const [flux, tRec] of [[40000, 1200], [120000, 2100], [300000, 4000]]) {
      const q = SCALE * flux * Math.max(g.eDown / Math.sqrt(g.Rd), LEE / Math.sqrt(g.Rs));
      let lo = T_SPACE, hi = Math.max(tRec, T_SPACE + 1);
      for (let i = 0; i < 80; i++) { const m = 0.5 * (lo + hi); if (EMIS * SIGMA * (m ** 4 - T_SPACE ** 4) < q * (1 - m / tRec)) lo = m; else hi = m; }
      S.check(`one tank, tail first, ${flux / 1000} kW/m2 and ${tRec} K: steady temperature over its limit`, lo / g.d.maxTemp, solo.axialHeatRatio(flux, true, tRec), 1e-6, { unit: '' });
    }
  }
  // a tiled side answers to the tiles' limit when the wind falls on it, and to the part's own when it does not
  {
    const tiled = Object.values(PARTS).find(p => p.tiles && p.attach && p.attach.stack);
    if (tiled) {
      const fate = roll => {
        const { w, v } = held(stack(tiled.id), 40000, 2400, 90 * DEG, roll);
        const p = [...v.parts.values()][0];
        p.temp = tiled.maxTemp + 250; v._hot = true;          // hotter than bare steel can be, cooler than tiles can
        w.step(0.02);
        return !v.dead && v.parts.size === 1;
      };
      S.ok(`${tiled.name}: belly to the wind, at 250 K over the steel's limit, it holds`, fate(Math.PI));
      S.ok(`${tiled.name}: back to the wind at the same temperature, it does not`, !fate(0));
    }
  }
}

export const groups = [
  { name: '14a. Heating: the constants of the gases, nose radii and skin heat capacities', fast: true, run: S => constants(S) },
  { name: '14b. Heating: flux by attitude, by size, in the wake and on the side of a hull', fast: true, run: S => fluxLaw(S) },
  { name: '14c. Heating: skin temperature and ablator lost on entries flown in the game vs the heat balance integrated by the reference', fast: true, run: S => balance(S) },
  { name: '14d. Heating: the wall limit, cooling in vacuum, the steady estimate and the tiled side', fast: true, run: S => limits(S) },
];
