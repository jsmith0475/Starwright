// Group 15: wings, fins and lattice vanes above the speed of sound (part D of docs/REENTRY_SPEC.md; docs/WINGS.md).
// Below Mach 1 a lifting surface keeps the coefficients it always had. Above it, linear supersonic theory (Ackeret)
// caps the lift-curve slope at 4 / sqrt(Ma^2 - 1) and makes the drag due to lift C_L x alpha; profile drag follows the
// slender drag curve; a lattice vane chokes between Mach 0.8 and 1.3. The model is typed here a second time, on
// purpose, the air is the reference's own (ref.mjs) and the slender curve is the reference's (ref_aero.mjs).
import { World, SYSTEM, spawn, Vector3 } from './harness.mjs';
import * as R from './ref.mjs';
import * as RA from './ref_aero.mjs';
import { Craft } from '../../js/core/craft.js';
import { PARTS } from '../../js/core/parts.js';
import { wingCoefficients, machSlope, machInduced, gridChoke } from '../../js/core/vessel.js';

const sys = R.readSystem();
const DEG = Math.PI / 180;
// --- the model, restated
const WING_SLOPE = 3.6, FIN_SLOPE = 1.6, WING_STALL = 0.28, FIN_STALL = 0.45;
const CD0 = 0.012, K_LOW = 0.07, PLATE = 0.9, PLATE_CD = 1.8, SPAN_FRICTION = 0.01, DEFLECT = 0.35;
const GRID = { from: 0.8, peak: 1.0, to: 1.3, lift: 0.4, drag: 1.0 };

const beta = m => Math.sqrt(m * m - 1);
const slopeAt = (a, m) => m > 1 ? Math.min(a, 4 / beta(m)) : a;
const kAt = m => m > 1 ? Math.max(K_LOW, beta(m) / 4) : K_LOW;
const chokeAt = m => m <= GRID.from || m >= GRID.to ? 0 : m <= GRID.peak ? (m - GRID.from) / (GRID.peak - GRID.from) : (GRID.to - m) / (GRID.to - GRID.peak);
/** [C_L, C_D] of a surface at angle of attack a: attached flow blending into a flat plate through the stall. */
function coeff(a, slope, stall, mach = 0, grid = false) {
  const rise = RA.rise(mach, 0), cd0 = CD0 * rise, ch = grid ? chokeAt(mach) : 0;
  const s = slopeAt(slope, mach) * (1 - GRID.lift * ch), K = kAt(mach);
  const sa = Math.sin(a), ca = Math.cos(a);
  let al = a, eff = 1;
  if (ca < 0) { al = a > 0 ? a - Math.PI : a + Math.PI; eff = 0.5; }
  const x = Math.abs(al) / stall;
  let w = x <= 0.85 ? 1 : x >= 1.35 ? 0 : 1 - (x - 0.85) / 0.5;
  w = w * w * (3 - 2 * w);
  const cl = s * eff * al;
  return [w * cl + (1 - w) * PLATE * 2 * sa * ca, (w * (cd0 + K * cl * cl) + (1 - w) * (cd0 + PLATE_CD * sa * sa)) * (1 + GRID.drag * ch)];
}
const conj = q => ({ x: -q.x, y: -q.y, z: -q.z, w: q.w });
const rot = (q, v) => {
  const { x, y, z, w } = q, [a, b, c] = v;
  const tx = 2 * (y * c - z * b), ty = 2 * (z * a - x * c), tz = 2 * (x * b - y * a);
  return [a + w * tx + (y * tz - z * ty), b + w * ty + (z * tx - x * tz), c + w * tz + (x * ty - y * tx)];
};
/** The force (N, vessel axes) on one surface mounted along the unit direction (ox, oz), from the flow u (vessel axes). */
function finForce(def, o, u, rho, mach) {
  const wg = def.wing || def.fin, S = wg.area, grid = def.variant === 'grid';
  const slope = def.wing ? (wg.slope || WING_SLOPE) : FIN_SLOPE, stall = def.wing ? (wg.stall || WING_STALL) : FIN_STALL;
  const n = [o[1], 0, -o[0]];
  const vn = u[0] * n[0] + u[2] * n[2], vy = u[1], vpl = Math.hypot(vy, vn), sp = Math.hypot(u[0], u[1], u[2]);
  const [cl, cd] = coeff(Math.atan2(-vn, vy), slope, stall, mach, grid);
  const qS = 0.5 * rho * vpl * vpl * S, L = qS * cl, D = qS * cd;
  const fn = (L * vy - D * vn) / vpl, fy = (-L * vn - D * vy) / vpl;
  const vs = u[0] * o[0] + u[2] * o[1], ks = 0.5 * rho * sp * S * SPAN_FRICTION * vs;
  return [fn * n[0] - ks * o[0], fy, fn * n[2] - ks * o[1]];
}

/** A tank with `count` surfaces of one kind round it (or none), optionally under a probe core. */
function craftWith(id, count, { core = false } = {}) {
  const c = new Craft('test');
  const tank = c.setRoot('tank_m400')[0];
  if (core) c.attachStack('probe_wisp', tank.id, 'top');
  if (id && count) c.attachRadial(id, tank.id, tank.pos.y, 0, count);
  c.autoStage();
  return c;
}
/** The altitude on Verda where `speed` is Mach `mach` (searched in the reference's own air, below the stratopause). */
function altFor(b, speed, mach) {
  let lo = 0, hi = 11000;      // the reference's temperature falls steadily over this range
  for (let i = 0; i < 60; i++) { const m = 0.5 * (lo + hi); if (speed / R.soundSpeed(b, m) < mach) lo = m; else hi = m; }
  return 0.5 * (lo + hi);
}
/** A vessel in Verda's air at `alt` moving at `speed`, its top end `alpha` from the motion, rolled `roll` about its axis. */
function held(craft, alt, speed, alpha, roll = 0) {
  const b = sys.byId.verda, w = new World();
  const wy = R.TAU / b.rotPeriod, r = b.radius + alt;
  const v = spawn(w, craft, 'verda', [r, 0, 0], [0, 0, speed - wy * r]);
  v.q.setFromAxisAngle(new Vector3(1, 0, 0), Math.PI / 2 - alpha).multiply(v.q.clone().setFromAxisAngle(new Vector3(0, 1, 0), roll));
  v.w.set(0, 0, 0); v.ctrl.throttle = 0; v.ctrl.sas = false;
  return { w, v, b };
}
/** Air force (vessel axes) the game puts on the surfaces alone: the craft with them less the same craft without. */
function measured(id, count, alt, speed, alpha, roll) {
  const A = held(craftWith(id, count), alt, speed, alpha, roll), B = held(craftWith(null, 0), alt, speed, alpha, roll);
  A.w.step(1e-4); B.w.step(1e-4);
  const fa = A.v.aeroLocal, fb = B.v.aeroLocal;
  const fins = [...A.v.parts.values()].filter(p => p.def.id === id);
  return { f: [fa.x - fb.x, fa.y - fb.y, fa.z - fb.z], fins, v: A.v, b: A.b };
}
/** What the reference says the same surfaces feel. */
function expected(m) {
  const { v, b, fins } = m;
  const wy = R.TAU / b.rotPeriod, pos = R.arr(v.pos), vel = R.arr(v.vel), alt = R.norm(pos) - b.radius;
  // the air moves with the ground: u = v - omega x r, and the step moved the vessel by a tenth of a millimetre
  const uW = [vel[0] - wy * pos[2], vel[1], vel[2] + wy * pos[0]], u = rot(conj(v.q), uW);
  const rho = R.airDensity(b, alt), mach = R.norm(uW) / R.soundSpeed(b, alt);
  const f = [0, 0, 0];
  for (const p of fins) {
    const h = Math.hypot(p.pos.x, p.pos.z), ff = finForce(p.def, [p.pos.x / h, p.pos.z / h], u, rho, mach);
    f[0] += ff[0]; f[1] += ff[1]; f[2] += ff[2];
  }
  return { f, u, rho, mach, q: 0.5 * rho * R.norm(uW) ** 2 };
}

// ------------------------------------------------------------------------------------------ 15a the coefficients
function coefficients(S) {
  // the table of section 5 of the specification, worked from 4 / sqrt(Ma^2 - 1)
  for (const [m, wing, fin] of [[1.5, 3.58, 1.6], [2, 2.31, 1.6], [3, 1.41, 1.41], [4, 1.03, 1.03], [5, 0.82, 0.82]]) {
    S.check(`Mach ${m}: lift-curve slope of a wing (3.6 per radian at low speed)`, wing, machSlope(WING_SLOPE, m), 0.006, { unit: '1/rad' });
    S.check(`Mach ${m}: lift-curve slope of a fin (1.6 per radian at low speed)`, fin, machSlope(FIN_SLOPE, m), 0.006, { unit: '1/rad' });
  }
  // where the cap takes hold: 4 / sqrt(Ma^2 - 1) = a  gives  Ma = sqrt(1 + 16 / a^2)
  for (const [name, a, want] of [['wing', WING_SLOPE, 1.49], ['fin', FIN_SLOPE, 2.69]]) {
    const mc = Math.sqrt(1 + 16 / (a * a));
    S.check(`the cap takes hold on a ${name} at Mach sqrt(1 + 16 / a^2)`, want, mc, 0.006, { unit: 'Mach' });
    S.check(`a ${name} just below that Mach number keeps its own slope`, a, machSlope(a, mc - 1e-6), 1e-12, { unit: '1/rad' });
    S.check(`a ${name} just above it: no jump`, a, machSlope(a, mc + 1e-6), 1e-5, { unit: '1/rad' });
  }
  // drag due to lift: K = max(0.07, sqrt(Ma^2 - 1) / 4), and with the capped slope C_D - C_D0 = C_L x alpha (Ackeret's flat plate)
  for (const m of [0.5, 1, 1.03, 1.2, 2, 3, 5]) S.check(`Mach ${m}: drag-due-to-lift factor K`, kAt(m), machInduced(m), 1e-12, { unit: '' });
  S.check('K leaves 0.07 where sqrt(Ma^2 - 1) / 4 passes it, at Mach', Math.sqrt(1 + (4 * K_LOW) ** 2), (() => { let lo = 1, hi = 2; for (let i = 0; i < 60; i++) { const m = 0.5 * (lo + hi); if (machInduced(m) > K_LOW + 1e-15) hi = m; else lo = m; } return lo; })(), 1e-6, { unit: 'Mach' });
  for (const m of [2, 3, 5]) {
    const a = 4 * DEG, [cl, cd] = wingCoefficients(a, WING_SLOPE, WING_STALL, [0, 0], m, RA.rise(m, 0));
    S.check(`Mach ${m}, wing at 4 degrees: C_L = 4 alpha / sqrt(Ma^2 - 1)`, 4 * a / beta(m), cl, 1e-12, { unit: '' });
    S.check(`Mach ${m}, wing at 4 degrees: drag due to lift = C_L x alpha`, cl * a, cd - CD0 * RA.rise(m, 0), 1e-12, { unit: '' });
  }
  // the whole function against the restatement, over angle and Mach number, for a wing, a fin and a lattice vane
  for (const [name, slope, stall, grid] of [['wing', WING_SLOPE, WING_STALL, false], ['fin', FIN_SLOPE, FIN_STALL, false], ['lattice vane', FIN_SLOPE, FIN_STALL, true]]) {
    let worst = 0, n = 0;
    for (const m of [0, 0.5, 0.79, 0.9, 1.0, 1.15, 1.31, 1.6, 2.5, 4, 7, 12]) for (let deg = -180; deg <= 180; deg += 3) {
      const got = wingCoefficients(deg * DEG, slope, stall, [0, 0], m, RA.rise(m, 0), grid ? gridChoke(m) : 0), want = coeff(deg * DEG, slope, stall, m, grid);
      worst = Math.max(worst, Math.abs(got[0] - want[0]), Math.abs(got[1] - want[1])); n++;
    }
    S.check(`${name}: C_L and C_D at ${n} angles and Mach numbers, worst difference`, 0, worst, 1e-9, { unit: '' });
  }
  // below Mach 0.7 nothing changed: the old function is the new one with its defaults
  {
    let worst = 0;
    for (let deg = -180; deg <= 180; deg += 2) for (const m of [0, 0.3, 0.7]) {
      const a = wingCoefficients(deg * DEG), b = wingCoefficients(deg * DEG, WING_SLOPE, WING_STALL, [0, 0], m, RA.rise(m, 0), 0);
      worst = Math.max(worst, Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]));
    }
    S.check('up to Mach 0.7 a wing has the coefficients it always had, worst difference', 0, worst, 1e-12, { unit: '' });
  }
  // post-stall normal force against the Newtonian flat plate: 1.8 sin^2 against 1.84 sin^2 (requirement D4)
  S.check('broadside on, the plate drag (1.8) is within 3 % of the Newtonian value at high Mach', RA.cpMax(20, 1.4), wingCoefficients(Math.PI / 2)[1] - CD0, 0.03 * 1.84, { unit: '' });
  // the lattice vane: nothing outside Mach 0.8 to 1.3, 40 % of the slope gone and the drag doubled at Mach 1
  for (const [m, want] of [[0.8, 0], [0.9, 0.5], [1.0, 1], [1.15, 0.5], [1.3, 0], [2, 0]]) S.check(`lattice vane, Mach ${m}: how far into its choke`, want, gridChoke(m), 1e-12, { unit: '' });
  {
    const a = 3 * DEG, open = wingCoefficients(a, FIN_SLOPE, FIN_STALL, [0, 0], 1.0, 1, 0), choked = wingCoefficients(a, FIN_SLOPE, FIN_STALL, [0, 0], 1.0, 1, 1);
    S.check('lattice vane at Mach 1: lift over the same fin unchoked', 1 - GRID.lift, choked[0] / open[0], 1e-12, { unit: 'ratio' });
    S.check('lattice vane at Mach 1 and no angle: drag over the same fin unchoked', 1 + GRID.drag, wingCoefficients(0, FIN_SLOPE, FIN_STALL, [0, 0], 1.0, 1, 1)[1] / wingCoefficients(0, FIN_SLOPE, FIN_STALL, [0, 0], 1.0, 1, 0)[1], 1e-12, { unit: 'ratio' });
  }
}

// ------------------------------------------------------------------------------------------ 15b forces in the game
function forces(S) {
  const b = sys.byId.verda;
  const kinds = [['fin', 4], ['fin_grid', 4], ['wing_stub', 2]].filter(([id]) => PARTS[id]);
  for (const [id, count] of kinds) {
    const d = PARTS[id];
    let worst = 0, n = 0, worstAt = '';
    for (const mach of [0.5, 0.9, 1.0, 1.2, 2, 3, 5]) for (const deg of [0, 2, 6, 12]) for (const roll of [0, 0.4]) {
      const speed = mach * 300, alt = altFor(b, speed, mach);
      const m = measured(id, count, alt, speed, deg * DEG, roll), e = expected(m);
      const scale = e.q * (d.wing || d.fin).area * count * 0.05;
      const err = Math.hypot(m.f[0] - e.f[0], m.f[1] - e.f[1], m.f[2] - e.f[2]) / scale;
      if (err > worst) { worst = err; worstAt = `Mach ${mach}, ${deg} deg`; }
      n++;
    }
    S.check(`${count} x ${d.name} on a tank: air force at ${n} Mach numbers, angles and rolls, worst difference`, 0, worst, 2e-3, { unit: 'rel', note: `as a share of 0.05 q S; worst at ${worstAt}` });
  }
  // the physics the numbers should show: lift across the flow, falling with Mach number as 4 / sqrt(Ma^2 - 1)
  if (PARTS.fin) {
    const lift = mach => {
      const speed = mach * 300, alt = altFor(b, speed, mach), a = 3 * DEG;
      const m = measured('fin', 4, alt, speed, a, 0), e = expected(m);
      // the part of the force across the flow, per q S alpha of the two fins that lift (the other two are edge on)
      const un = e.u.map(x => x / Math.hypot(...e.u)), along = m.f[0] * un[0] + m.f[1] * un[1] + m.f[2] * un[2];
      const across = Math.hypot(m.f[0] - along * un[0], m.f[1] - along * un[1], m.f[2] - along * un[2]);
      return across / (e.q * 2 * PARTS.fin.fin.area * a);
    };
    const l05 = lift(0.5);
    S.check('four Tail Fins at 3 degrees, Mach 0.5: lift slope of the two that lift', FIN_SLOPE, l05, 0.01 * FIN_SLOPE, { unit: '1/rad' });
    for (const m of [3, 4, 5]) S.check(`the same at Mach ${m}: lift slope 4 / sqrt(Ma^2 - 1)`, 4 / beta(m), lift(m), 0.01 * 4 / beta(m), { unit: '1/rad' });
    S.info('fin lift at Mach 5 over Mach 0.5', lift(5) / l05, '', 'a fin on a returning booster has half its low-speed authority');
  }
  // shadow (D5): a fin in the lee of the hull at a high angle keeps a tenth of its force above Mach 1.5 (at 70 degrees,
  // not 90: broadside the flow runs straight along the fin's span and there is next to no force to compare)
  if (PARTS.fin) {
    const side = roll => {
      const speed = 3 * 300, alt = 30000;
      const A = held(craftWith('fin', 1), alt, speed, 70 * DEG, roll), B = held(craftWith(null, 0), alt, speed, 70 * DEG, roll);
      A.w.step(1e-4); B.w.step(1e-4);
      const fin = [...A.v.parts.values()].find(p => p.def.id === 'fin');
      return { f: Math.hypot(A.v.aeroLocal.x - B.v.aeroLocal.x, A.v.aeroLocal.y - B.v.aeroLocal.y, A.v.aeroLocal.z - B.v.aeroLocal.z), ex: fin._ex, fin };
    };
    // the fin sits on the vessel's +x side; roll pi/2 turns that side to the wind or to the lee
    const a = side(Math.PI / 2), c = side(-Math.PI / 2), wind = a.ex > c.ex ? a : c, lee = a.ex > c.ex ? c : a;
    S.ok('hull at 70 degrees to the flow at Mach 3: the fin to windward stands in the open', wind.ex > 0.99, `exposure ${wind.ex.toFixed(2)}`);
    S.ok('and the fin in the lee is in the hull\'s shadow', lee.ex < 0.5, `exposure ${lee.ex.toFixed(2)}`);
    S.check('the force on the lee fin over the windward fin = 1 - 0.9 x its shade', 1 - 0.9 * (1 - lee.ex), lee.f / wind.f, 0.02, { unit: 'ratio' });
  }
}

// ------------------------------------------------------------------------------------------ 15c steering authority
function authority(S) {
  const b = sys.byId.verda;
  for (const id of ['fin_grid'].filter(i => PARTS[i])) {
    // the turning acceleration a full command would give, less what the reaction wheel gives alone (the same craft in vacuum)
    const torque = (alt, speed) => {
      const { w, v } = held(craftWith(id, 4, { core: true }), alt, speed, 0, 0);
      v.ctrl.sas = true; w.step(1e-4);
      return { t: v.ctrlAccel.x * v.inertia.x, v };
    };
    const base = torque(400000, 300).t;
    const per = mach => { const speed = mach * 300, alt = altFor(b, speed, mach), r = torque(alt, speed); return (r.t - base) / (0.5 * R.airDensity(b, alt) * speed * speed); };
    const p05 = per(0.5);
    S.ok(`${PARTS[id].name}: steering torque at Mach 0.5 is there to measure`, p05 > 0, `${p05.toExponential(3)} N m per Pa`);
    for (const m of [0.9, 1.0, 1.15, 2, 3, 5]) {
      const want = slopeAt(FIN_SLOPE, m) / FIN_SLOPE * (1 - GRID.lift * chokeAt(m));
      S.check(`${PARTS[id].name}: steering torque per unit of dynamic pressure at Mach ${m}, over Mach 0.5`, want, per(m) / p05, 0.01, { unit: 'ratio' });
    }
  }
  void DEFLECT; void SYSTEM;
}

export const groups = [
  { name: '15a. Wings and fins: the supersonic slope cap, drag due to lift, the join at Mach 1 and the lattice vane\'s choke', fast: true, run: S => coefficients(S) },
  { name: '15b. Wings and fins: the air force on surfaces in the game vs the reference, lift against Mach number, and shadow', fast: true, run: S => forces(S) },
  { name: '15c. Wings and fins: steering authority against Mach number', fast: true, run: S => authority(S) },
];
