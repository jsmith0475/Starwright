// Group 10: the air itself (re-entry and aerodynamics, part A of docs/REENTRY_SPEC.md). Each world's gas, its
// temperature with height, the speed of sound that follows, the Mach number the game flies on, and the taper that
// replaces the step at the top of the atmosphere. Game vs the reference's own atmosphere (tests/verify/ref.mjs) and
// vs closed forms worked from g and H alone.
import { World, SYSTEM, capsule, spawn } from './harness.mjs';
import * as R from './ref.mjs';

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

// ------------------------------------------------------------------------------------------ 10d the drag rise sits on the true Mach number
const CAP = { rB: 0.625, cdBottom: 0.9, cdTop: 0.35, wake: 0.25 };
const capCdA = Math.PI * CAP.rB ** 2 * (CAP.cdBottom + CAP.wake * CAP.cdTop);
/** The game's drag rise with Mach number, restated: 1 below 0.7, 2.0 at 1.1, 1.5 above 2.5. Unchanged by this step. */
const rise = M => M <= 0.7 ? 1 : M < 1.1 ? 1 + (M - 0.7) * 2.5 : M < 2.5 ? 2 - (M - 1.1) / 1.4 * 0.5 : 1.5;

function dragRise(S) {
  const b = sys.byId.verda, mu = b.gm;
  for (const hh of [12000, 20000, 30000]) {
    const a = R.soundSpeed(b, hh), rho = R.airDensity(b, hh), gg = mu / (b.radius + hh) ** 2;
    for (const M of [0.3, 0.6, 0.69, 0.9, 1.1, 1.8, 2.5, 4]) {
      const speed = M * a, w = new World(), dt = 0.02;
      const v = spawn(w, capsule(), 'verda', [0, b.radius + hh, 0], [0, -speed, 0]);       // falling heat shield first, over the pole
      w.step(dt);
      const aDrag = gg - (v.vel.length() - speed) / dt;
      const plain = 0.5 * rho * speed * speed * capCdA / v.mass;
      // first-order stepping: the drag is taken at the start of the step, so the comparison is good to about a dt / tau
      S.check(`${hh / 1000} km, Mach ${M} (${speed.toFixed(0)} m/s): drag / (rho v^2 Cd A / 2) vs the rise at the true Mach number`, rise(M), aDrag / plain, M < 0.7 ? 0.01 : 0.02, { rel: true, note: M < 0.7 ? 'below Mach 0.7 nothing changed: the factor is 1' : `on the old 320 m/s this speed was Mach ${(speed / 320).toFixed(2)}, factor ${rise(speed / 320).toFixed(3)}` });
    }
  }
}

export const groups = [
  { name: '10a. The air: gas, temperature and the speed of sound on every world', fast: true, run: S => gas(S) },
  { name: '10b. Mach number in flight vs airspeed over the true speed of sound', fast: true, run: S => mach(S) },
  { name: '10c. The top of the atmosphere: a taper instead of a step', fast: true, run: S => taper(S) },
  { name: '10d. The drag rise sits on the true Mach number; nothing changes below Mach 0.7', fast: true, run: S => dragRise(S) },
];
