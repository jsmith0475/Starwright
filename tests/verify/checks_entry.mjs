// Group 11: entry (part C of docs/REENTRY_SPEC.md; docs/ENTRY.md). A capsule whose centre of mass is moved off its
// axis rests at an angle to the air and lifts; Bank hold turns that lift about the velocity; the entry predictor says
// where the path ends. Game vs the reference's triangle meshes (ref_aero.mjs), vs an independent integrator
// (ref_entry.mjs), vs closed forms, and the predictor vs entries flown in the game's own flight model.
import { World, SYSTEM, spawn } from './harness.mjs';
import * as R from './ref.mjs';
import * as RA from './ref_aero.mjs';
import * as RE from './ref_entry.mjs';
import { Vector3 } from '../../js/lib/three.module.min.js';
import { Craft } from '../../js/core/craft.js';
import { PARTS } from '../../js/core/parts.js';
import { predictEntry } from '../../js/core/entry.js';

const sys = R.readSystem();
const DEG = Math.PI / 180;
const TRIM = 18;                                              // degrees: typed here a second time, on purpose
const HEAT_K = 1.7415e-4;                                       // the heating law's constant, likewise
const CAP = 25 * DEG;

const stackOn = (top, bottom) => { const c = new Craft(top + ' on ' + bottom); const r = c.setRoot(bottom)[0]; c.attachStack(top, r.id, 'top'); c.autoStage(); return c; };
const CRAFT = [
  ['Acorn Capsule on Ablative Shield M', () => stackOn('pod_acorn', 'heatshield_m')],
  ['Hearth Command Module on Ablative Shield L', () => stackOn('pod_hearth', 'heatshield_l')],
];
const radii = d => ({ rT: d.rTop !== undefined ? d.rTop : d.r, rB: d.rBottom !== undefined ? d.rBottom : d.r });

/** A vessel at rest in the reference frame of nothing in particular, Entry trim on: its mass points and geometry. */
function trimmed(make) {
  const b = sys.byId.verda, w = new World();
  const v = spawn(w, make(), 'verda', [0, b.radius + 60000, 0], [0, 0, 2000]);
  const before = { com: [v.com.x, v.com.y, v.com.z], I: [v.inertia.x, v.inertia.y, v.inertia.z] };
  const on = v.setEntryTrim(true);
  const list = [...v.parts.values()].sort((p, q) => p.pos.y - q.pos.y);            // bottom first
  const parts = list.map((p, i) => {
    const d = p.def, { rT, rB } = radii(d), below = list[i - 1], above = list[i + 1];
    const covB = below ? radii(below.def).rT : 0, covT = above ? radii(above.def).rB : 0;
    const cap = !below && (d.heatshield || (d.shape === 'capsule' && rB > rT)) ? CAP : 0;
    return { id: d.id, y: p.pos.y, r: Math.max(rT, rB), tris: RA.mesh({ rB, rT, h: d.h, covB, covT, capB: cap, capT: 0 }), mass: p.mass };
  });
  for (const p of parts) p.shadeBy = parts.filter(c => c !== p && c.r > p.r * 1.02);
  return { w, v, b, on, before, parts, com: [v.com.x, v.com.y], rMax: Math.max(...parts.map(p => p.r)) };
}

// ------------------------------------------------------------------------------------------ 11a the trim
function trim(S) {
  for (const [name, make] of CRAFT) {
    const t = trimmed(make), { v, parts, com } = t;
    S.ok(`${name}: Entry trim switches on`, t.on === true && v.entryTrimOn);
    // the reference finds the angle of no moment about the game's centre of mass, from its own meshes
    const a = RE.trimAngle(parts, com, Math.PI - TRIM * DEG);
    S.check(`${name}: angle to the air at which the reference finds no moment`, TRIM, 180 - a / DEG, 0.5, { unit: 'deg' });
    S.info(`${name}: sideways shift of the centre of mass`, com[0] * 1000, 'mm', `${(com[0] / t.rMax * 100).toFixed(1)} % of the shield's radius`);
    // the capsule is the only part whose mass moved, and the vessel's centre of mass is the mass-weighted mean
    const pod = [...v.parts.values()].find(p => p.trim);
    S.check(`${name}: centre of mass = the capsule's shifted mass over the whole mass`, pod._mx * pod.mass / v.mass, v.com.x, 1e-12, { unit: 'm' });
    // moment of inertia: the shifted mass enters by the parallel-axis rule (compare with the balanced vessel)
    const dI = v.inertia.y - t.before.I[1], want = pod.mass * (pod._mx - v.com.x) ** 2 + (v.mass - pod.mass) * v.com.x ** 2;
    S.check(`${name}: roll inertia grows by the shifted masses times their distances squared`, want, dI, 1e-9 * v.inertia.y + 1e-12, { unit: 'kg m2' });
    // lift over drag there: the game's own figure against the meshes
    const ld = RE.liftOverDrag(parts, Math.PI - TRIM * DEG);
    S.check(`${name}: lift over drag at ${TRIM} deg, the game's figure vs the meshes`, ld, v._trim.ld, 0.01, { rel: true });
    S.ok(`${name}: lift over drag at trim is between 0.25 and 0.34`, ld > 0.25 && ld < 0.34, ld.toFixed(3));
    // off again: exactly as it was (C6)
    v.setEntryTrim(false);
    const back = Math.max(...[0, 1, 2].map(k => Math.abs([v.com.x, v.com.y, v.com.z][k] - t.before.com[k]) + Math.abs([v.inertia.x, v.inertia.y, v.inertia.z][k] - t.before.I[k])));
    S.check(`${name}: switched off, centre of mass and inertia are what they were`, 0, back, 0, { max: true });
  }
  // a spherical cap alone, worked by hand: the force on every element points at the centre of curvature, so the net
  // force passes through it, at the angle atan(C_N / C_A) from the axis, where
  //   C_A = cos²a (1 + cos²phi)/2 + sin²a sin²phi/4,   C_N = sin a cos a sin²phi / 2      (per unit of base area)
  const Rn = 1 / Math.sin(CAP), tris = RA.mesh({ rB: 1, rT: 1, h: 0, covB: 0, covT: 0, capB: CAP, capT: 0 });
  for (const aDeg of [5, 18, 30]) {
    const a = aDeg * DEG, CA = Math.cos(a) ** 2 * (1 + Math.cos(CAP) ** 2) / 2 + Math.sin(a) ** 2 * Math.sin(CAP) ** 2 / 4, CN = Math.sin(a) * Math.cos(a) * Math.sin(CAP) ** 2 / 2;
    const n = RA.newton(tris, [Math.sin(Math.PI - a), Math.cos(Math.PI - a), 0]);
    S.check(`spherical cap of 25 deg at ${aDeg} deg: force angle from the axis, meshes vs atan(C_N / C_A)`, Math.atan(CN / CA) / DEG, Math.atan2(Math.abs(n.F[0]), Math.abs(n.F[1])) / DEG, 0.01, { unit: 'deg' });
    // moment about the centre of curvature (the cap's apex is at y = 0 - the mesh puts the rim at y = 0, the apex below)
    const yc = Rn * Math.cos(CAP), Mc = n.M[2] - (0 * n.F[1] - yc * n.F[0]);
    S.check(`  the same: moment about the centre of curvature (fraction of force x radius of curvature)`, 0, Math.abs(Mc) / (Math.hypot(n.F[0], n.F[1]) * Rn), 2e-4, { max: true });
  }
}

// ------------------------------------------------------------------------------------------ 11b flown at trim, Bank hold
/** The air force per unit mass on a flying vessel over one small step, in the inertial frame. */
function airAccel(w, v, b, dt = 0.02) {
  const p0 = R.arr(v.pos), v0 = R.arr(v.vel);
  w.step(dt);
  const p1 = R.arr(v.pos), g = R.scale(R.add(R.scale(p0, -b.gm / R.norm(p0) ** 3), R.scale(p1, -b.gm / R.norm(p1) ** 3)), 0.5);
  return R.sub(R.scale(R.sub(R.arr(v.vel), v0), 1 / dt), g);
}
function held(S) {
  const [name, make] = CRAFT[0];
  for (const bankDeg of [0, 60, -120, 180]) {
    const t = trimmed(make), { w, v, b, parts } = t;
    const alt = 42000, r = b.radius + alt, wy = R.TAU / b.rotPeriod, speed = 6.5 * R.soundSpeed(b, alt);
    v.pos.set(r, 0, 0); v.vel.set(0, 0, speed + wy * r); v.w.set(0, 0, 0);
    v.ctrl.throttle = 0; v.ctrl.sas = true; v.ctrl.sasMode = 'bankHold'; v.bank = bankDeg * DEG;
    v.q.setFromUnitVectors(new Vector3(0, 1, 0), new Vector3(0, 0, -1));              // shield first, then let the hold take it
    for (let i = 0; i < 400; i++) w.step(0.05);                                       // 20 s
    const pos = R.arr(v.pos), vel = R.arr(v.vel), air = R.unit([vel[0] - wy * pos[2], vel[1], vel[2] + wy * pos[0]]);
    const A = airAccel(w, v, b), D = -R.dot(A, air), Lv = R.add(A, R.scale(air, D)), L = R.norm(Lv);
    const up = R.unit(pos), h = R.unit(R.sub(up, R.scale(air, R.dot(up, air)))), right = R.cross(air, h);
    const bank = Math.atan2(R.dot(Lv, right), R.dot(Lv, h)) / DEG;
    let err = bank - bankDeg; if (err > 180) err -= 360; if (err < -180) err += 360;
    S.check(`${name}, Bank hold at ${bankDeg} deg, Mach 6.5: where the lift really points, from the vessel's acceleration`, 0, err, 1, { unit: 'deg' });
    const axis = new Vector3(0, 1, 0).applyQuaternion(v.q), aoa = 180 - Math.acos(Math.max(-1, Math.min(1, axis.x * air[0] + axis.y * air[1] + axis.z * air[2]))) / DEG;
    S.check(`  the same: angle of the capsule to the air`, TRIM, aoa, 0.5, { unit: 'deg' });
    S.check(`  the same: lift over drag flown vs the meshes`, RE.liftOverDrag(parts, Math.PI - TRIM * DEG), L / D, 0.02, { rel: true });
    S.check(`  the same: turning rate left (rad/s)`, 0, v.w.length(), 0.02, { max: true });
  }
  // let go at the trim angle with no hold: the air alone keeps it there (the moment is a restoring one)
  {
    const t = trimmed(make), { w, v, b } = t;
    const alt = 42000, r = b.radius + alt, wy = R.TAU / b.rotPeriod, speed = 6.5 * R.soundSpeed(b, alt);
    v.pos.set(r, 0, 0); v.vel.set(0, 0, speed + wy * r); v.w.set(0, 0, 0); v.ctrl.throttle = 0; v.ctrl.sas = false; v.bank = 0;
    v.q.copy(v.bankAttitude(v.q.clone()));
    let sum = 0, n = 0, worst = 0;
    for (let i = 0; i < 600; i++) {
      w.step(0.05);
      const pos = R.arr(v.pos), vel = R.arr(v.vel), air = R.unit([vel[0] - wy * pos[2], vel[1], vel[2] + wy * pos[0]]);
      const axis = new Vector3(0, 1, 0).applyQuaternion(v.q), aoa = 180 - Math.acos(Math.max(-1, Math.min(1, axis.x * air[0] + axis.y * air[1] + axis.z * air[2]))) / DEG;
      sum += aoa; n++; worst = Math.max(worst, Math.abs(aoa - TRIM));
    }
    S.check(`${name}, released at its trim attitude with no hold, 30 s at Mach 6.5: mean angle to the air`, TRIM, sum / n, 0.5, { unit: 'deg' });
    S.check(`  the same: furthest it strays from the trim angle`, 0, worst, 1.5, { max: true, unit: 'deg' });
  }
}

// ------------------------------------------------------------------------------------------ 11c the predictor
const entryState = (b, speed, fpaDeg, alt = b.atmo.height - 1) => { const r = b.radius + alt, a = fpaDeg * DEG; return { r: [r, 0, 0], v: [-speed * Math.sin(a), 0.02 * speed, speed * Math.cos(a)] }; };
function predictor(S) {
  const b = sys.byId.verda, gb = SYSTEM.byId.verda, mass = 1200;
  // drag area against Mach number: a table like the game's (tenths of Mach to 12), read by each side in its own way
  const tab = new Float64Array(121);
  for (let i = 0; i <= 120; i++) { const m = i / 10; tab[i] = 1.2 * (m < 0.7 ? 1 : m < 1.1 ? 1 + (m - 0.7) * 1.5 : 1.6 + 0.1 * Math.min(1, (m - 1.1) / 3)); }
  const cdA = m => { const x = Math.min(m, 11.9999) * 10, i = Math.floor(x); return tab[i] + (tab[i + 1] - tab[i]) * (x - i); };
  const cases = [['from low orbit, 1.5 deg, no lift', 2300, 1.5, 0, 0], ['from low orbit, 1.5 deg, lift up', 2300, 1.5, 0.3, 0], ['from low orbit, 1.5 deg, lift 60 deg right', 2300, 1.5, 0.3, 60],
    ['from low orbit, 1.5 deg, lift down', 2300, 1.5, 0.3, 180], ['from Pell, 3300 m/s at 12 deg, lift up', 3300, 12, 0.3, 0], ['from Pell, 3300 m/s at 14 deg, lift up', 3300, 14, 0.3, 0], ['from Pell, 3300 m/s at 14 deg, lift down', 3300, 14, 0.3, 180]];
  for (const [what, speed, fpa, ld, bankDeg] of cases) {
    const s = entryState(b, speed, fpa), floor = 2000;
    const ref = RE.flyEntry(b, s.r, s.v, { mass, cdA, ld, ldFade: [0.7, 1.5], bank: bankDeg * DEG, floor, heatK: HEAT_K });
    const got = predictEntry(gb, new Vector3(...s.r), new Vector3(...s.v), 1000, { mass, drag: tab, ld, ldMach: [0.7, 1.5], bank: bankDeg * DEG, floor, terrain: false });
    S.ok(`${what}: the same ending (${ref.end})`, got.end === ref.end, got.end);
    S.check(`  time to the end`, ref.t, got.t, 0.02, { unit: 's' });
    S.check(`  where it ends`, 0, R.dist(R.arr(got.pos), ref.r), 5, { max: true, unit: 'm' });
    S.check(`  speed at the end`, R.norm(ref.v), got.vel.length(), 1e-4, { rel: true, unit: 'm/s' });
    S.check(`  peak deceleration`, ref.maxG, got.maxG, 3e-3, { rel: true, unit: 'm/s2' });
    S.check(`  peak heat flux`, ref.maxFlux, got.maxFlux, 3e-3, { rel: true, unit: 'W/m2' });
  }
  // Allen and Eggers: a steep ballistic entry with a constant drag coefficient into exponential air meets its peak
  // deceleration at exp(-1/2) of its entry speed and, for heating as sqrt(rho) v³, its peak heating at exp(-1/6)
  {
    const s = entryState(b, 5000, 60), wy = R.TAU / b.rotPeriod, ve = R.norm([s.v[0] - wy * s.r[2], s.v[1], s.v[2] + wy * s.r[0]]);
    const got = predictEntry(gb, new Vector3(...s.r), new Vector3(...s.v), 0, { mass, area: 1.5, floor: 2000, terrain: false });
    S.check('steep fast ballistic entry (5 km/s at 60 deg, constant drag area): speed at peak deceleration over entry speed, vs exp(-1/2)', Math.exp(-0.5), got.maxGSpeed / ve, 0.02);
    S.check('  the same: speed at peak heating over entry speed, vs exp(-1/6)', Math.exp(-1 / 6), got.maxFluxSpeed / ve, 0.02);
    const ref = RE.flyEntry(b, s.r, s.v, { mass, cdA: () => 1.5, floor: 2000, heatK: HEAT_K });
    S.check('  the same: the reference integrator agrees on the speed at peak deceleration', ref.maxGSpeed / ve, got.maxGSpeed / ve, 0.01);
  }
}

// ------------------------------------------------------------------------------------------ 11d predicted vs flown
function flown(S) {
  const [name, make] = CRAFT[0];
  const cases = [['no trim, held against the airflow', 2300, 1.5, null], ['trim on, lift up', 2300, 1.5, 0], ['trim on, lift 60 deg right', 2300, 1.5, 60], ['trim on, lift down', 2300, 1.5, 180],
    ['from Pell at 14 deg, trim on, lift down', 3300, 14, 180], ['from Pell at 12 deg, trim on, lift up', 3300, 12, 0]];
  for (const [what, speed, fpa, bankDeg] of cases) {
    const b = sys.byId.verda, gb = SYSTEM.byId.verda, w = new World(), s = entryState(b, speed, fpa);
    const v = spawn(w, make(), 'verda', s.r, s.v);
    const wy = R.TAU / b.rotPeriod, air = new Vector3(s.v[0] - wy * s.r[2], s.v[1], s.v[2] + wy * s.r[0]).normalize();
    v.ctrl.throttle = 0; v.ctrl.sas = true; v.w.set(0, 0, 0);
    if (bankDeg === null) { v.ctrl.sasMode = 'srfRetrograde'; v.q.setFromUnitVectors(new Vector3(0, 1, 0), air.clone().negate()); }
    else { v.setEntryTrim(true); v.ctrl.sasMode = 'bankHold'; v.bank = bankDeg * DEG; v.q.copy(v.bankAttitude(v.q.clone())); }
    const pr = predictEntry(gb, v.pos, v.vel, w.ut, { ...v.entryModel(), floor: 3000, terrain: false });
    let g = 0, flux = 0, t = 0, out = false;
    while (t < 3000 && !v.dead) {
      w.step(0.05); t += 0.05;
      if (v.gForce > g) g = v.gForce;
      if (v.heatFlux > flux) flux = v.heatFlux;
      if (v.altitude > b.atmo.height && t > 5) { out = true; break; }
      if (v.altitude < 3000) break;
    }
    const tag = `${name}, ${what} (${speed} m/s at ${fpa} deg)`;
    S.ok(`${tag}: predicted at the top to ${pr.end === 'skip' ? 'skip out' : 'come down'}, and it does`, !v.dead && (pr.end === 'skip') === out);
    S.check(`  peak g: flown vs predicted at the top`, pr.maxG / R.G0, g, 0.06, { rel: true, unit: 'g' });
    S.check(`  peak heat flux: flown vs predicted`, pr.maxFlux, flux, 0.05, { rel: true, unit: 'W/m2' });
    const miss = R.dist(R.arr(v.pos), R.arr(pr.pos)) / 1000, range = R.angleBetween(s.r, R.arr(v.pos)) * b.radius / 1000;
    // (the two ends are at different times, so the comparison is made in the frame that turns with the body)
    const dirF = v.pos.clone().applyAxisAngle(new Vector3(0, 1, 0), -gb.rotationAngle(w.ut)).normalize();
    const missS = Math.acos(Math.min(1, dirF.dot(pr.dir))) * b.radius / 1000;
    if (out) S.check(`  speed leaving the air: flown vs predicted`, pr.vel.length(), v.vel.length(), 0.02, { rel: true, unit: 'm/s' });
    else S.check(`  where it comes down: distance from the predicted point, over a path of ${range.toFixed(0)} km`, 0, missS, Math.max(12, 0.03 * range), { max: true, unit: 'km' });
    void miss;
  }
}

export const groups = [
  { name: '11a. Entry trim: the centre of mass moved off the axis, against the meshes and a cap worked by hand', fast: true, run: S => trim(S) },
  { name: '11b. Bank hold: the trim attitude flown, and the lift turned about the velocity', fast: true, run: S => held(S) },
  { name: '11c. Entry predictor vs an independent integrator, and vs Allen and Eggers', fast: true, run: S => predictor(S) },
  { name: '11d. Entries flown in the game vs the prediction made at the top of the air', fast: true, run: S => flown(S) },
];
