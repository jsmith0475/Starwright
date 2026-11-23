// Group 10: the air itself (re-entry and aerodynamics, part A of docs/REENTRY_SPEC.md). Each world's gas, its
// temperature with height, the speed of sound that follows, the Mach number the game flies on, and the taper that
// replaces the step at the top of the atmosphere. Game vs the reference's own atmosphere (tests/verify/ref.mjs) and
// vs closed forms worked from g and H alone.
import { World, SYSTEM, capsule, spawn } from './harness.mjs';
import * as R from './ref.mjs';
import * as RA from './ref_aero.mjs';
import { Vector3 } from '../../js/lib/three.module.min.js';
import { Craft } from '../../js/core/craft.js';
import { PARTS } from '../../js/core/parts.js';
import { TUNING } from '../../js/core/vessel.js';
import { newtonTable, pitotCp, NEWTON_ROWS } from '../../js/core/aero.js';

const sys = R.readSystem();
const airy = sys.bodies.filter(b => b.atmo);
const GAMMA = { air: 1.40, co2: 1.29, h2he: 1.45 };          // typed here a second time, on purpose

// ------------------------------------------------------------------------------------------ 10a gas, temperature, sound
function gas(S) {
  for (const b of airy) {
    const g = SYSTEM.byId[b.id], { scale, height } = b.atmo, grav = b.gm / b.radius ** 2;
    // hydrostatics ties temperature to the scale height the world already has: H = R T / (M g)
    S.check(`${b.name} (${b.atmo.gas}): isothermal temperature M g H / R`, R.isoTemperature(b), g.atmo.tIso, 1e-12, { rel: true, unit: 'K' });
    let wT = 0, wA = 0, wId = 0;
    for (let i = 0; i <= 200; i++) {
      const h = height * i / 200;
      wT = Math.max(wT, Math.abs(g.temperature(h) / R.airTemperature(b, h) - 1));
      wA = Math.max(wA, Math.abs(g.soundSpeed(h) / R.soundSpeed(b, h) - 1));
      // a route with no gas constant and no molar mass in it: a^2 = gamma g H (T / T_iso)
      wId = Math.max(wId, Math.abs(g.soundSpeed(h) ** 2 / (GAMMA[b.atmo.gas] * grav * scale * (g.temperature(h) / g.atmo.tIso)) - 1));
    }
    S.check(`${b.name}: temperature vs the reference profile, 201 heights (worst)`, 0, wT, 1e-12);
    S.check(`${b.name}: speed of sound vs sqrt(gamma R T / M), 201 heights (worst)`, 0, wA, 1e-12);
    S.check(`${b.name}: a^2 = gamma g H (T / T_iso), with no gas constant in it (worst)`, 0, wId, 1e-12);
    // no kinks the profile does not have: the largest change of temperature over one metre
    let jump = 0;
    for (let h = 0; h < height; h += 1) jump = Math.max(jump, Math.abs(g.temperature(h + 1) - g.temperature(h)));
    S.ok(`${b.name}: temperature is continuous (largest change over 1 m is under 0.1 K)`, jump < 0.1, `${jump.toExponential(2)} K`);
    S.check(`${b.name}: speed of sound above the top holds the value at the top`, g.soundSpeed(height), g.soundSpeed(height * 3), 0, { unit: 'm/s' });
    S.info(`${b.name}: speed of sound at the surface / coldest / top`, `${g.soundSpeed(0).toFixed(1)} / ${Math.min(...Array.from({ length: 201 }, (_, i) => g.soundSpeed(height * i / 200))).toFixed(1)} / ${g.soundSpeed(height).toFixed(1)}`, 'm/s', `was 320 everywhere; surface temperature ${g.temperature(0).toFixed(0)} K`);
  }
  // Verda by hand: g 9.6 m/s2, H 5800 m, air. a_iso = sqrt(1.4 x 9.6 x 5800) = 279.19; at the surface x sqrt(1.18)
  S.check('Verda by hand: speed of sound at the surface, sqrt(1.4 x 9.6 x 5800 x 1.18)', 303.28, SYSTEM.byId.verda.soundSpeed(0), 0.01, { unit: 'm/s' });
  S.check('Verda by hand: in the cold layer (1.5 to 2.8 scale heights), sqrt(1.4 x 9.6 x 5800 x 0.88)', 261.91, SYSTEM.byId.verda.soundSpeed(2 * 5800), 0.01, { unit: 'm/s' });
  for (const b of sys.bodies.filter(x => !x.atmo && x.parent).slice(0, 2)) {
    S.ok(`${b.name}: no air, so no speed of sound (infinite) and no temperature`, SYSTEM.byId[b.id].soundSpeed(0) === Infinity && SYSTEM.byId[b.id].temperature(0) === 0);
  }
}

// ------------------------------------------------------------------------------------------ 10b the Mach number in flight
function mach(S) {
  const cases = [
    ['verda', 'pole', 500, 100], ['verda', 'pole', 8000, 250], ['verda', 'pole', 20000, 600], ['verda', 'pole', 45000, 1800], ['verda', 'pole', 70000, 2300],
    ['verda', 'equator', 12000, 400], ['rusk', 'pole', 6000, 300], ['murk', 'equator', 15000, 500],
  ];
  for (const [id, where, alt, speed] of cases) {
    const b = sys.byId[id]; if (!b || !b.atmo || alt >= b.atmo.height) continue;
    const w = new World(), r = b.radius + alt;
    // at the pole the ground does not move; at the equator the air is carried round with the planet
    const v = where === 'pole' ? spawn(w, capsule(), id, [0, r, 0], [speed, 0, 0]) : spawn(w, capsule(), id, [r, 0, 0], [0, 0, -speed]);
    w.step(0.02);
    const pos = [v.pos.x, v.pos.y, v.pos.z], vel = [v.vel.x, v.vel.y, v.vel.z];
    const air = R.norm(R.sub(vel, R.cross([0, R.TAU / b.rotPeriod, 0], pos))), h = R.norm(pos) - b.radius;
    S.check(`${b.name}, ${where}, ${alt / 1000} km, ${speed} m/s: Mach readout vs airspeed / reference speed of sound`, air / R.soundSpeed(b, h), v.mach, 1e-6, { rel: true, note: `sound ${R.soundSpeed(b, h).toFixed(1)} m/s; on the old 320 m/s this read ${(air / 320).toFixed(3)}` });
  }
  const moon = sys.bodies.find(x => !x.atmo && x.parent && x.parent.parent);
  if (moon) {
    const w = new World(), v = spawn(w, capsule(), moon.id, [0, moon.radius + 5000, 0], [200, 0, 0]);
    w.step(0.02);
    S.check(`${moon.name} (no air): Mach readout`, 0, v.mach, 0);
  }
  const g = SYSTEM.byId.verda;
  S.info('Verda: speed at Mach 1 at 0 / 10 / 20 / 40 / 60 km', [0, 10000, 20000, 40000, 60000].map(h => g.soundSpeed(h).toFixed(0)).join(' / '), 'm/s', 'was 320 at every height');
}

// ------------------------------------------------------------------------------------------ 10c the taper at the top
function taper(S) {
  for (const b of airy) {
    const g = SYSTEM.byId[b.id], { scale, rho0, height } = b.atmo, start = 0.92 * height;
    let wBelow = 0, wIn = 0, wP = 0, mono = true, prev = Infinity, jump = 0;
    for (let i = 0; i <= 400; i++) {
      const h = start * i / 400;
      wBelow = Math.max(wBelow, Math.abs(g.density(h) / (rho0 * Math.exp(-h / scale)) - 1));
    }
    for (let i = 0; i < 400; i++) {
      const h = start + (height - start) * i / 400, d = g.density(h);
      wIn = Math.max(wIn, Math.abs(d / R.airDensity(b, h) - 1));
      // pressure fades with the density: p / rho keeps its exponential value
      wP = Math.max(wP, Math.abs((g.pressureAtm(h) / g.pressureAtm(0)) / (d / rho0) - 1));
    }
    for (let h = 0; h <= height + 50; h += 5) { const d = g.density(h); if (d > prev) mono = false; jump = Math.max(jump, (prev - d) / rho0); prev = d; }
    S.check(`${b.name}: below the taper (0 to 92% of the top) the density is the plain exponential (worst)`, 0, wBelow, 1e-12);
    S.check(`${b.name}: inside the taper, density vs the reference's cubic fade (worst)`, 0, wIn, 1e-10);
    S.check(`${b.name}: pressure fades with the density through the taper (worst)`, 0, wP, 1e-10);
    S.check(`${b.name}: density at the top and above it`, 0, g.density(height) + g.density(height + 1), 0, { unit: 'kg/m3' });
    S.ok(`${b.name}: density never rises with height`, mono);
    // the slope does not kink where the taper starts, and the density meets zero flat at the top
    const e = 0.5, sBelow = (g.density(start) - g.density(start - e)) / e, sAbove = (g.density(start + e) - g.density(start)) / e;
    S.check(`${b.name}: slope of density just above the start of the taper vs just below`, sBelow, sAbove, 2e-3, { rel: true, unit: 'kg/m4' });
    const edge = rho0 * Math.exp(-height / scale);
    S.ok(`${b.name}: one metre under the top the density is under a millionth of the old step`, g.density(height - 1) < 1e-6 * edge, `${(g.density(height - 1) / edge).toExponential(2)} of the ${edge.toExponential(2)} kg/m3 step that was there`);
    // what the taper costs: air removed from the column, as a fraction of the whole column
    let lost = 0; const n = 2000, dh = (height - start) / n;
    for (let i = 0; i < n; i++) { const h = start + (i + 0.5) * dh; lost += (rho0 * Math.exp(-h / scale) - R.airDensity(b, h)) * dh; }
    S.info(`${b.name}: air removed by the taper, as a fraction of the whole column`, (lost / (rho0 * scale)).toExponential(2), '', `taper from ${(start / 1000).toFixed(1)} to ${(height / 1000).toFixed(1)} km`);
  }
  // In flight: a capsule coming in at orbital speed crosses the top. The drag used to switch on in one step.
  const b = sys.byId.verda, g = SYSTEM.byId.verda, w = new World();
  const v = spawn(w, capsule(), 'verda', [0, b.radius + b.atmo.height + 600, 0], [2300, -300, 0]);
  const edge = b.atmo.rho0 * Math.exp(-b.atmo.height / b.atmo.scale);
  let last = null, worst = 0, entered = false, top = 0;
  for (let i = 0; i < 900; i++) {
    const before = [v.vel.x, v.vel.y, v.vel.z], p0 = [v.pos.x, v.pos.y, v.pos.z];
    w.step(0.02);
    const p1 = [v.pos.x, v.pos.y, v.pos.z], r0 = R.norm(p0), r1 = R.norm(p1);
    // acceleration over the step less gravity (mean of the two ends): what the air did
    const grav = R.scale(R.add(R.scale(p0, -b.gm / r0 ** 3), R.scale(p1, -b.gm / r1 ** 3)), 0.5);
    const a = R.norm(R.sub(R.scale(R.sub([v.vel.x, v.vel.y, v.vel.z], before), 1 / 0.02), grav));
    if (r1 - b.radius < b.atmo.height) entered = true;
    if (last !== null) worst = Math.max(worst, Math.abs(a - last));
    last = a; top = Math.max(top, a);
    if (r1 - b.radius < 0.90 * b.atmo.height) break;
  }
  const speed = Math.hypot(2300, 300);
  const oldStep = 0.5 * edge * speed * speed * Math.PI * 0.625 ** 2 * 0.9 * 1.5 / v.mass;       // the jump an untapered edge gave this capsule
  S.ok('capsule crossing the top of the atmosphere at 2,320 m/s: it did enter', entered);
  S.check('largest change of air deceleration from one step to the next, through the whole taper', 0, worst, 0.05 * oldStep, { unit: 'm/s2', note: `the step at an untapered top was ${oldStep.toExponential(2)} m/s2 at once; tolerance is a twentieth of it` });
  S.info('air deceleration reached by the bottom of the taper', top.toExponential(2), 'm/s2');
}

// ------------------------------------------------------------------------------------------ 10d-10h forces on bodies (part B)
// The game is asked only for what it did: a part is put in still air over the pole at a chosen speed and attitude,
// one 20 ms step is taken, and the force and the torque are read from the change of velocity and of spin. The
// reference (tests/verify/ref_aero.mjs) works the same force out from the part data by its own route.
const FACE_CP = TUNING.FACE_CP;                                  // the empirical righting arm: data, like a coefficient
const geoOf = (id, cov = {}) => {
  const d = PARTS[id], rT = d.rTop !== undefined ? d.rTop : d.r, rB = d.rBottom !== undefined ? d.rBottom : d.r;
  const cap = d.capPhi !== undefined ? d.capPhi : (d.heatshield || (d.shape === 'capsule' && rB > rT)) ? 25 : 0;
  return { geo: { rB, rT, h: d.h, covB: cov.bottom || 0, covT: cov.top || 0, capB: cov.bottom ? 0 : cap * Math.PI / 180, capT: 0 }, cd: d.drag };
};
const meshes = new Map();
const meshOf = g => { const k = JSON.stringify(g); if (!meshes.has(k)) meshes.set(k, RA.mesh(g)); return meshes.get(k); };

/** One step of a craft at (alt, speed, angle of attack in degrees): the air force and torque the game applied, body axes. */
function measure(craft, alt, speed, alphaDeg, spinUp = null) {
  const b = sys.byId.verda, w = new World(), a = alphaDeg * Math.PI / 180;
  const v = spawn(w, craft, 'verda', [0, b.radius + alt, 0], [speed * Math.sin(a), speed * Math.cos(a), 0]);
  v.ctrl.sas = false; v.ctrl.throttle = 0;
  if (spinUp) spinUp(v);
  const qi = v.q.clone().invert(), toBody = x => { const t = new Vector3(x[0], x[1], x[2]).applyQuaternion(qi); return [t.x, t.y, t.z]; };
  const p0 = [v.pos.x, v.pos.y, v.pos.z], v0 = [v.vel.x, v.vel.y, v.vel.z], w0 = [v.w.x, v.w.y, v.w.z], m = v.mass, I = [v.inertia.x, v.inertia.y, v.inertia.z];
  const parts = [...v.parts.values()].map(p => ({ id: p.def.id, r: [p.pos.x - v.com.x, p.pos.y - v.com.y, p.pos.z - v.com.z] }));
  const vb = toBody(v0);
  const dt = 0.02; w.step(dt);
  const p1 = [v.pos.x, v.pos.y, v.pos.z], r0 = R.norm(p0), r1 = R.norm(p1);
  const g = R.scale(R.add(R.scale(p0, -b.gm / r0 ** 3), R.scale(p1, -b.gm / r1 ** 3)), 0.5);
  const F = toBody(R.sub(R.scale(R.sub([v.vel.x, v.vel.y, v.vel.z], v0), 1 / dt), g)).map(x => x * m);
  const T = [0, 1, 2].map(k => I[k] * ([v.w.x, v.w.y, v.w.z][k] - w0[k]) / dt);
  return { F, T, vb, m, parts, rho: R.airDensity(b, alt), mach: speed / R.soundSpeed(b, alt), substeps: w.substeps };
}
/** The reference's force and torque about the mass centre for a list of [geometry, coefficients, offset, shade]. */
function refWrench(list, vb, env) {
  const F = [0, 0, 0], T = [0, 0, 0];
  for (const it of list) {
    const r = RA.partWrench(it.geo, it.cd, vb, { ...env, shade: it.shade || 0 }, { cpArm: FACE_CP, tris: meshOf(it.geo) });
    const arm = R.cross(it.r, r.F);
    for (let k = 0; k < 3; k++) { F[k] += r.F[k]; T[k] += r.M[k] + arm[k]; }
  }
  return { F, T };
}
const single = id => { const c = new Craft(id); c.setRoot(id); c.autoStage(); return c; };
/** Two parts in a stack, `top` on `bottom`. */
const pair = (top, bottom) => { const c = new Craft(top + ' on ' + bottom); const r = c.setRoot(bottom)[0]; c.attachStack(top, r.id, 'top'); c.autoStage(); return c; };
const MACHS = [0.5, 0.69, 0.9, 1.3, 2, 3, 5, 8];

function newtonForms(S) {
  // the reference mesh against closed forms, and the game's table against both
  const disc = RA.mesh({ rB: 1, rT: 1, h: 0 });
  for (const a of [0, 20, 50]) { const u = [Math.sin(a * Math.PI / 180), Math.cos(a * Math.PI / 180), 0]; S.check(`flat disc at ${a} deg: axial force / (q Cp,max) = -pi cos^2`, -Math.PI * Math.cos(a * Math.PI / 180) ** 2, RA.newton(disc, u).F[1], 1e-3, { rel: true, unit: 'm2' }); }
  const cyl = RA.mesh({ rB: 1, rT: 1, h: 4, covB: 1, covT: 1 });
  S.check('cylinder broadside: cross force / (q Cp,max) = -(2/3) x diameter x length', -(2 / 3) * 2 * 4, RA.newton(cyl, [1, 0, 0]).F[0], 1e-3, { rel: true, unit: 'm2' });
  const half = Math.atan(1 / 2), cone = RA.mesh({ rB: 1, rT: 0, h: 2, covB: 1 });
  S.check('cone nose first: axial force / (q Cp,max) = -pi r^2 sin^2(half-angle)', -Math.PI * Math.sin(half) ** 2, RA.newton(cone, [0, 1, 0]).F[1], 1e-3, { rel: true, unit: 'm2' });
  const phi = 25 * Math.PI / 180, capM = RA.mesh({ rB: 1, rT: 1, h: 0, covT: 1, capB: phi });
  for (const a of [0, 10, 20, 30]) {
    const al = a * Math.PI / 180, r = RA.newton(capM, [Math.sin(al), -Math.cos(al), 0]);
    S.check(`spherical cap (25 deg) leading, tilted ${a} deg: axial coefficient = cos^2 a (1 + cos^2 phi)/2 + sin^2 a sin^2 phi / 4`, Math.cos(al) ** 2 * (1 + Math.cos(phi) ** 2) / 2 + Math.sin(al) ** 2 * Math.sin(phi) ** 2 / 4, r.F[1] / Math.PI, 1e-3, { rel: true });
    if (a) S.check(`spherical cap, tilted ${a} deg: normal coefficient = (sin^2 phi / 2) sin a cos a`, Math.sin(phi) ** 2 / 2 * Math.sin(al) * Math.cos(al), -r.F[0] / Math.PI, 2e-3, { rel: true });
  }
  // the game's tables, every row, against the mesh
  for (const [name, g] of [['Canister M-400', geoOf('tank_m400').geo], ['Shroud Nose M', geoOf('nose_m').geo], ['Acorn Capsule', geoOf('pod_acorn').geo], ['Ablative Shield M', geoOf('heatshield_m').geo], ['adapter L to M', geoOf('adapter_lm').geo]]) {
    const t = newtonTable(g.rB, g.rT, g.h, g.covB, g.covT, g.capB, g.capT), tris = meshOf(g), scale = Math.PI * Math.max(g.rB, g.rT) ** 2 + 2 * Math.max(g.rB, g.rT) * g.h;
    let wF = 0, wM = 0;
    for (let k = 0; k < NEWTON_ROWS; k++) {
      const a = k * Math.PI / (NEWTON_ROWS - 1), r = RA.newton(tris, [Math.sin(a), Math.cos(a), 0]);
      wF = Math.max(wF, Math.abs(t[k * 3] - r.F[1]), Math.abs(t[k * 3 + 1] - r.F[0])); wM = Math.max(wM, Math.abs(t[k * 3 + 2] - r.M[2]));
    }
    S.check(`${name}: the game's Newtonian table vs the triangle mesh, every row, force (worst, as a fraction of the part's area)`, 0, wF / scale, 2e-3);
    S.check(`${name}: the same, moment about the centre (worst, as a fraction of area x length)`, 0, wM / (scale * Math.max(g.h, g.rB)), 2e-3);
  }
  // Rayleigh pitot against the textbook: Mach 2 in air gives p02/p1 = 5.640; the high Mach limit is 1.839
  S.check('C_p,max at Mach 2, gamma 1.4: (5.640 - 1) / (0.7 x 4)', (5.640 - 1) / 2.8, pitotCp(2, 1.4), 2e-4, { rel: true });
  S.check('C_p,max at Mach 50, gamma 1.4 (limit 1.839)', 1.839, pitotCp(50, 1.4), 1e-3);
  let wCp = 0; for (const g of [1.29, 1.4, 1.45]) for (const m of [0.5, 1, 1.2, 2, 4, 8, 20]) wCp = Math.max(wCp, Math.abs(pitotCp(m, g) / RA.cpMax(m, g) - 1));
  S.check('C_p,max, game vs reference, three gases and seven Mach numbers (worst)', 0, wCp, 1e-12);
}

function partForces(S) {
  // each case: a name, how to build it, and its parts with what covers each face (typed here, not read from the game)
  const cases = [
    ['Canister M-400', () => single('tank_m400'), { tank_m400: {} }],
    ['Shroud Nose M on a Canister M-400', () => pair('nose_m', 'tank_m400'), { nose_m: { bottom: 0.625 }, tank_m400: { top: 0.625 } }],
    ['Acorn Capsule', () => single('pod_acorn'), { pod_acorn: {} }],
    ['Acorn Capsule on an Ablative Shield M', () => pair('pod_acorn', 'heatshield_m'), { pod_acorn: { bottom: 0.65 }, heatshield_m: { top: 0.625 } }],
    ['adapter L to M', () => single('adapter_lm'), { adapter_lm: {} }],
  ];
  for (const [name, build, covers] of cases) {
    const model = Object.fromEntries(Object.entries(covers).map(([id, cov]) => [id, geoOf(id, cov)]));
    const big = Object.values(model).reduce((a, m) => Math.max(a, m.geo.rB, m.geo.rT), 0), len = Object.values(model).reduce((a, m) => a + m.geo.h, 0);
    for (const band of [[0, 0.7, 'below Mach 0.7 (today\'s model, unchanged)'], [0.7, 1.5, 'Mach 0.7 to 1.5 (two curves, fading wake)'], [1.5, 4, 'Mach 1.5 to 4 (blend)'], [4, 99, 'above Mach 4 (Newtonian)']]) {
      let wF = 0, wT = 0, n = 0, note = '';
      for (const M of MACHS.filter(x => x >= band[0] && x < band[1])) for (let a = 0; a <= 180; a += 15) {
        const alt = M > 3.5 ? 50000 : 25000, speed = M * R.soundSpeed(sys.byId.verda, alt);      // thinner air for the fastest cases: a light part alone must not be thrown about within one step
        const g = measure(build(), alt, speed, a);
        if (g.substeps !== 1) continue;
        // a part behind a wider one is in its wake: the reference works the shelter out from the same two positions
        const dir = g.vb.map(x => x / speed), rad = pt => Math.max(model[pt.id].geo.rB, model[pt.id].geo.rT);
        const ref = refWrench(g.parts.map(pt => ({ ...model[pt.id], r: pt.r, shade: Math.max(0, ...g.parts.filter(o => o !== pt).map(o => RA.shade(pt.r, rad(pt), o.r, rad(o), dir))) })), g.vb, { rho: g.rho, mach: g.mach, gamma: 1.4 });
        const q = 0.5 * g.rho * speed * speed, A = Math.PI * big * big + 2 * big * len;
        const eF = R.norm(R.sub(g.F, ref.F)) / (q * A), eT = R.norm(R.sub(g.T, ref.T)) / (q * A * Math.max(len, big));
        if (eF > wF) { wF = eF; note = `worst at Mach ${M}, ${a} deg`; }
        wT = Math.max(wT, eT); n++;
      }
      // below Mach 1.5 the two sides are the same closed form; above it the game interpolates a 5 degree table
      const tol = band[0] < 1.5 ? 1e-6 : 4e-3;
      S.check(`${name}, ${band[2]}: force vs reference over ${n} attitudes and speeds (worst, fraction of q x area)`, 0, wF, tol, { note });
      S.check(`${name}, ${band[2]}: torque about the mass centre vs reference (worst, fraction of q x area x length)`, 0, wT, tol);
    }
  }
}

function capsuleNumbers(S) {
  // what a pilot will notice, as numbers: drag heat shield first, and lift when the capsule is held at an angle
  const { geo, cd } = geoOf('pod_acorn'), A = Math.PI * 0.625 ** 2, b = sys.byId.verda;
  const rows = [];
  for (const M of [0.5, 1.1, 2, 3, 5, 8]) {
    const g = measure(single('pod_acorn'), 30000, M * R.soundSpeed(b, 30000), 180), q = 0.5 * g.rho * (M * R.soundSpeed(b, 30000)) ** 2;
    rows.push(`${M}: ${(g.F[1] / (q * A)).toFixed(2)}`);
  }
  S.info('Acorn Capsule heat shield first: drag coefficient on its base area, by Mach number', rows.join(', '), '', 'before this step: 0.99 below Mach 0.7, 1.98 at Mach 1.1, 1.48 above Mach 2.5');
  for (const M of [5, 8]) {
    const al = 20 * Math.PI / 180, speed = M * R.soundSpeed(b, 40000), g = measure(single('pod_acorn'), 40000, speed, 160);
    const u = g.vb.map(x => x / speed), D = -R.dot(g.F, u), Lv = R.sub(g.F, R.scale(u, -D)), LD = R.norm(Lv) / D;
    const phi = 25 * Math.PI / 180, CA = Math.cos(al) ** 2 * (1 + Math.cos(phi) ** 2) / 2 + Math.sin(al) ** 2 * Math.sin(phi) ** 2 / 4, CN = Math.sin(phi) ** 2 / 2 * Math.sin(al) * Math.cos(al);
    // lift and drag from the axial and normal coefficients of the cap alone: the windward flank adds a little normal force
    const capLD = (CA * Math.sin(al) - CN * Math.cos(al)) / (CA * Math.cos(al) + CN * Math.sin(al));
    S.check(`Acorn Capsule held 20 deg off at Mach ${M}: lift / drag vs the closed form for its spherical cap`, capLD, LD, 0.03, { note: 'the lift points away from the tilt: a blunt body lifts opposite to a wing; before this step the game gave 0.20' });
  }
  const ref = refWrench([{ geo, cd, r: [0, 0, 0] }], [0, -1, 0], { rho: 2, mach: 8, gamma: 1.4 });
  S.check('Acorn Capsule heat shield first at Mach 8: drag coefficient = C_p,max (1 + cos^2 25 deg) / 2', pitotCp(8, 1.4) * (1 + Math.cos(25 * Math.PI / 180) ** 2) / 2, ref.F[1] / A, 2e-3, { rel: true });
}

function shadows(S) {
  const b = sys.byId.verda, alt = 30000;
  // a small tank standing on a wide heat shield, falling shield first: the tank is in the shield's wake
  const hidden = () => pair('tank_s100', 'heatshield_l');
  const tk = geoOf('tank_s100', { bottom: 0.3125 }), hs = geoOf('heatshield_l', { top: 0.3125 });
  hs.geo.capB = 25 * Math.PI / 180;
  for (const M of [0.5, 1.1, 2, 6]) for (const a of [180, 170, 150, 120, 90, 30]) {
    const speed = M * R.soundSpeed(b, alt), g = measure(hidden(), alt, speed, a);
    const pt = g.parts.find(p => p.id === 'tank_s100'), ps = g.parts.find(p => p.id === 'heatshield_l');
    const u = g.vb.map(x => x / speed), sh = RA.shade(pt.r, 0.3125, ps.r, 1.3, u);
    const ref = refWrench([{ ...tk, r: pt.r, shade: sh }, { ...hs, r: ps.r }], g.vb, { rho: g.rho, mach: g.mach, gamma: 1.4 });
    const q = 0.5 * g.rho * speed * speed, A = Math.PI * 1.3 ** 2;
    S.check(`tank behind a wide shield, Mach ${M}, ${a} deg (tank ${(sh * 100).toFixed(0)}% in the wake): force vs reference (fraction of q x shield area)`, 0, R.norm(R.sub(g.F, ref.F)) / (q * A), M < 1.5 ? 1e-6 : 4e-3);
  }
  // parts of one width do not shadow each other: a stack of three tanks at an angle feels the air on all its length
  const three = () => { const c = new Craft('three'); let t = c.setRoot('tank_m400')[0]; t = c.attachStack('tank_m400', t.id, 'bottom')[0]; c.attachStack('tank_m400', t.id, 'bottom'); c.autoStage(); return c; };
  for (const a of [10, 45, 90]) {
    const speed = 6 * R.soundSpeed(b, alt), g = measure(three(), alt, speed, a);
    const ys = g.parts.map(p => p.r[1]).sort((x, y) => x - y);
    const list = g.parts.map(p => ({ ...geoOf('tank_m400', { top: p.r[1] === ys[2] ? 0 : 0.625, bottom: p.r[1] === ys[0] ? 0 : 0.625 }), r: p.r }));
    const ref = refWrench(list, g.vb, { rho: g.rho, mach: g.mach, gamma: 1.4 }), q = 0.5 * g.rho * speed * speed;
    S.check(`three equal tanks in a stack, Mach 6, ${a} deg: no shadow, force vs reference (fraction of q x side area)`, 0, R.norm(R.sub(g.F, ref.F)) / (q * 2 * 0.625 * 11.25), 4e-3);
  }
  S.check('the shadow rule: a part 3 diameters behind is half sheltered, 4 diameters behind not at all', 0.5, RA.shade([0, -7.8, 0], 0.3, [0, 0, 0], 1.3, [0, 1, 0]), 1e-12);
  S.check('the shadow rule: ahead of the wide part there is no shadow', 0, RA.shade([0, 2, 0], 0.3, [0, 0, 0], 1.3, [0, 1, 0]), 0);
}

function foldedArrays(S) {
  // A folded solar array is a flat package against the hull: h tall, t wide, rw thick. Two of them on opposite sides
  // of a tank; the same tank without them is flown at the same state, and the difference is the force on the pair.
  const b = sys.byId.verda, d = PARTS.solar_wing, CD = 0.8;
  const faces = { 'along the stack (edge on)': d.t * d.rw, 'straight at its big face': d.h * d.t, 'along the curve of the hull (side on)': d.h * d.rw };
  const withWings = rot => { const c = new Craft('tank with arrays'); const r = c.setRoot('tank_m400')[0]; c.attachRadial('solar_wing', r.id, r.pos.y, rot, 2); c.autoStage(); return c; };
  const cases = [['along the stack (edge on)', 0, 0], ['straight at its big face', 0, 90], ['along the curve of the hull (side on)', Math.PI / 2, 90]];
  for (const M of [0.5, 3]) for (const [what, rot, alpha] of cases) {
    if (M > 0.7 && alpha !== 0) continue;                         // across the flow above Mach 0.7 the lee array is in the tank's wake
    const alt = 30000, speed = M * R.soundSpeed(b, alt);
    const g1 = measure(withWings(rot), alt, speed, alpha), g0 = measure(single('tank_m400'), alt, speed, alpha);
    const q = 0.5 * g1.rho * speed * speed, u = g1.vb.map(x => x / speed);
    const F = R.sub(g1.F, g0.F), along = -R.dot(F, u), across = R.norm(R.sub(F, R.scale(u, -along)));
    const want = 2 * q * CD * faces[what] * RA.riseBlunt(M);
    S.check(`two folded ${d.name}s, Mach ${M}, flow ${what}: drag = 2 q x ${CD} x ${faces[what].toFixed(3)} m2${M > 0.7 ? ' x the blunt rise' : ''}`, want, along, 1e-6, { rel: true, unit: 'N' });
    S.check(`  the same: no force across the flow (fraction of the drag)`, 0, across / want, 1e-9, { max: true });
  }
  S.info(`${d.name} folded: the area it showed the air from every side before this step`, d.h * d.t * CD, 'm2', `now ${(d.t * d.rw * CD).toFixed(3)} edge on, ${(d.h * d.rw * CD).toFixed(3)} side on, and the same ${(d.h * d.t * CD).toFixed(3)} face on`);
}

export const groups = [
  { name: '10a. The air: gas, temperature and the speed of sound on every world', fast: true, run: S => gas(S) },
  { name: '10b. Mach number in flight vs airspeed over the true speed of sound', fast: true, run: S => mach(S) },
  { name: '10c. The top of the atmosphere: a taper instead of a step', fast: true, run: S => taper(S) },
  { name: '10d. Newtonian theory: closed forms, the game\'s tables, the pitot pressure', fast: true, run: S => newtonForms(S) },
  { name: '10e. Force and torque on single parts at every attitude, Mach 0.5 to 8, vs the reference', fast: true, run: S => partForces(S) },
  { name: '10f. The capsule: drag by Mach number, and lift when it is held at an angle', fast: true, run: S => capsuleNumbers(S) },
  { name: '10g. Shadow: parts in the wake of a wider part, and parts that are not', fast: true, run: S => shadows(S) },
  { name: '10h. Folded solar arrays: a flat package shows each direction its own face', fast: true, run: S => foldedArrays(S) },
];
