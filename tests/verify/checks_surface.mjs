// Group 4: atmosphere and surface. Game vs closed forms and vs the reference integrator (tests/verify/ref.mjs).
import { World, SYSTEM, V, A, capsule, spawn, run } from './harness.mjs';
import { Quaternion, Vector3 } from '../../js/lib/three.module.min.js';
import * as R from './ref.mjs';

const sys = R.readSystem();
const G0 = 9.80665;

// ------------------------------------------------------------------------------------------ 4a atmosphere model
function atmosphere(S) {
  for (const b of sys.bodies) {
    const g = SYSTEM.byId[b.id];
    if (!b.atmo) { S.check(`${b.name}: no atmosphere, density at the surface`, 0, g.density(0), 0, { unit: 'kg/m3' }); continue; }
    const { height, scale, rho0 } = b.atmo;
    let worst = 0;
    for (const f of [0, 0.5, 1, 2, 3, 5, 8]) {
      const h = f * scale; if (h >= 0.92 * height) continue;
      worst = Math.max(worst, Math.abs(g.density(h) / (rho0 * Math.exp(-h / scale)) - 1));
    }
    S.check(`${b.name}: density vs rho0 exp(-h/H) at 0..8 scale heights, below the taper (worst)`, 0, worst, 1e-12, { note: `rho0 ${rho0} kg/m3, H ${scale} m, top ${height} m` });
    S.check(`${b.name}: pressure falls by 1/e per scale height (p(H)/p(0))`, Math.exp(-1), g.pressureAtm(scale) / g.pressureAtm(0), 1e-12);
    S.check(`${b.name}: density above the top of the atmosphere`, 0, g.density(height + 1), 0, { unit: 'kg/m3' });
    const edge = rho0 * Math.exp(-height / scale);
    S.info(`${b.name}: what an untapered exponential would leave at the top (the step the taper removes)`, edge, 'kg/m3', `${(edge / rho0).toExponential(2)} of the surface value`);
    S.info(`${b.name}: surface pressure, game (in Verda atmospheres) / hydrostatic rho0 g H (kPa)`, `${g.pressureAtm(0).toFixed(3)} / ${(rho0 * b.gm / b.radius ** 2 * scale / 1000).toFixed(1)}`, '', 'the game scales pressure with density (isothermal, same temperature everywhere)');
  }
}

// ------------------------------------------------------------------------------------------ 4b drag and terminal velocity
/** Drag area of the bare Acorn capsule falling heat shield first, from the part data: bottom face + wake fraction of the top. */
const CAP = { rB: 0.625, cdBottom: 0.9, cdTop: 0.35, wake: 0.25 };
const capCdA = Math.PI * CAP.rB ** 2 * (CAP.cdBottom + CAP.wake * CAP.cdTop);

function drag(S) {
  const b = sys.byId.verda, mu = b.gm, { scale, rho0 } = b.atmo;
  const w = new World();
  const h0 = 8000, r0 = b.radius + h0;
  // over the north pole: the surface does not move there, so airspeed = inertial speed
  const v = spawn(w, capsule(), 'verda', [0, r0, 0], [0, 0, 0]);
  const m = v.mass;
  S.info('capsule: mass / drag area Cd A falling heat shield first', `${m.toFixed(1)} kg / ${capCdA.toFixed(4)} m2`, '', 'pi r^2 (0.9 + 0.25 x 0.35), from the part data');
  // reference: 1-D fall with inverse-square gravity and quadratic drag
  const deriv = (t, y, o) => {
    const r = y[0], vr = y[1], rho = rho0 * Math.exp(-(r - b.radius) / scale);
    o[0] = vr; o[1] = -mu / (r * r) + 0.5 * rho * vr * vr * capCdA / m * (vr < 0 ? 1 : -1);
  };
  const y = Float64Array.from([r0, 0]); let t = 0;
  for (const T of [10, 25, 45]) {
    run(w, T - t, 0.02); R.integrate(deriv, y, t, T, { rtol: 1e-12, h0: 0.5 }); t = T;
    const rG = v.pos.length(), vG = v.vel.length();
    S.check(`capsule drop from 8 km over the pole, t = ${T} s: altitude vs reference`, y[0] - b.radius, rG - b.radius, 2, { unit: 'm', note: 'the game steps drag at 20 ms, first order in the speed-dependent force' });
    S.check(`capsule drop, t = ${T} s: speed vs reference`, -y[1], vG, 0.1, { unit: 'm/s' });
  }
  const alt = v.pos.length() - b.radius, rho = rho0 * Math.exp(-alt / scale), speed = v.vel.length();
  S.check('dynamic pressure readout vs rho v^2 / 2', 0.5 * rho * speed * speed, v.dynamicPressure, 1e-3, { rel: true, unit: 'Pa' });
  const gLoc = mu / (b.radius + alt) ** 2;
  const vt = Math.sqrt(2 * m * gLoc / (rho * capCdA));
  S.info('terminal velocity sqrt(2 m g / (rho Cd A)) at the current height / actual speed', `${vt.toFixed(1)} / ${speed.toFixed(1)}`, 'm/s', 'the air thickens as the capsule falls, so it is always still slowing down');
  // first-order lag: v_t shrinks by v_t v / 2H per second, and that deceleration needs extra drag
  S.check('terminal velocity with the thickening-air correction v_t sqrt(1 + v_t^2 / (2 g H))', vt * Math.sqrt(1 + vt * vt / (2 * gLoc * scale)), speed, 0.015, { rel: true, unit: 'm/s' });
  S.check('capsule kept its heat shield forward (tilt from vertical)', 0, Math.acos(Math.min(1, Math.abs(new Vector3(0, 1, 0).applyQuaternion(v.q).y))) * 180 / Math.PI, 1, { unit: 'deg' });
  // drag force from the deceleration in one step, at a higher speed: coast sideways in thin air
  const w2 = new World();
  const hh = 30000, v2 = spawn(w2, capsule(), 'verda', [0, b.radius + hh, 0], [0, -150, 0]);
  const before = v2.vel.length(); const dt = 0.02;
  w2.step(dt);
  const rho2 = rho0 * Math.exp(-hh / scale), gg = mu / (b.radius + hh) ** 2;
  const aDrag = gg - (v2.vel.length() - before) / dt;
  S.check('drag deceleration at 150 m/s, 30 km: rho v^2 Cd A / (2 m)', 0.5 * rho2 * 150 * 150 * capCdA / v2.mass, aDrag, 0.01, { rel: true, unit: 'm/s2' });
}

// ------------------------------------------------------------------------------------------ 4c re-entry heating
/** The game's drag rise with Mach number (data from TUNING in vessel.js): 1 below 0.7, 2.0 at 1.1, 1.5 above 2.5. */
const machFactor = M => M <= 0.7 ? 1 : M < 1.1 ? 1 + (M - 0.7) * 2.5 : M < 2.5 ? 2 - (M - 1.1) / 1.4 * 0.5 : 1.5;
const K_HEAT = 1.83e-4;

function entry(b, vE, gamma, { record = true } = {}) {
  const mu = b.gm, { scale, rho0, height } = b.atmo, wy = R.TAU / b.rotPeriod;
  const r0 = b.radius + height + 500;
  const vel = [0, -vE * Math.sin(gamma), vE * Math.cos(gamma)];
  const w = new World();
  // enter over the pole, heat shield (local -Y) along the velocity
  const q = new Quaternion().setFromUnitVectors(new Vector3(0, -1, 0), V(vel).normalize());
  const v = spawn(w, capsule(), 'verda', [0, r0, 0], vel, { q });
  const m = v.mass;
  let dead = null; w.on('destroyed', d => { if (d.vessel === v) dead = d.reason; });
  const g = { peakQ: { flux: 0 }, peakG: { a: 0 }, formulaErr: 0, maxTemp: 0, fluxAbove: v.heatFlux, vmax: 0, gammaAtVmax: gamma, tilt: 0 };
  const dt = 0.02;
  for (let i = 0; i < 30000 && !dead; i++) {
    const s0 = v.vel.length();
    w.step(dt);
    const alt = v.pos.length() - b.radius;
    const ax = v.vel.x - wy * v.pos.z, ay = v.vel.y, az = v.vel.z + wy * v.pos.x, air = Math.hypot(ax, ay, az);
    const rho = R.airDensity(b, alt);
    if (alt < 0.92 * height && v.heatFlux > 0) g.formulaErr = Math.max(g.formulaErr, Math.abs(v.heatFlux / (K_HEAT * Math.sqrt(rho) * air ** 3) - 1));
    if (v.heatFlux > g.peakQ.flux) g.peakQ = { flux: v.heatFlux, alt, speed: air, t: w.ut };
    const a = (s0 - v.vel.length()) / dt;
    if (a > g.peakG.a) g.peakG = { a, alt, speed: air, t: w.ut };
    if (air > g.vmax) { g.vmax = air; g.gammaAtVmax = Math.asin(-v.pos.dot(v.vel) / (v.pos.length() * v.vel.length())); }
    g.maxTemp = Math.max(g.maxTemp, v.maxTempRatio || 0);
    if (v.heatFlux > 1e4) g.tilt = Math.max(g.tilt, new Vector3(0, -1, 0).applyQuaternion(v.q).angleTo(new Vector3(ax, ay, az)));
    if (air < 250) break;
  }
  g.dead = dead; g.m = m;
  // reference: a point mass with gravity and the same drag law in air that turns with the planet
  const ref = { peakQ: { flux: 0 }, peakG: { a: 0 } };
  if (record) {
    const y = Float64Array.from([0, r0, 0, ...vel]);
    const dragAcc = (s, o) => {
      const r = Math.hypot(s[0], s[1], s[2]), alt = r - b.radius;
      const ax = s[3] - wy * s[2], ay = s[4], az = s[5] + wy * s[0], air = Math.hypot(ax, ay, az);
      const rho = R.airDensity(b, alt);
      const k = 0.5 * rho * air * capCdA * machFactor(air / R.soundSpeed(b, alt)) / m;
      if (o) { o[0] = -k * ax; o[1] = -k * ay; o[2] = -k * az; }
      return { rho, air, alt, a: k * air };
    };
    // classical RK4 at 5 ms: the air has a (tiny) step at its top and the drag curve has corners, which a high-order
    // extrapolation integrator dislikes; RK4 at this step is converged to better than 1e-6 here
    const acc = [0, 0, 0], f = (s, o) => {
      const r3 = Math.pow(s[0] * s[0] + s[1] * s[1] + s[2] * s[2], 1.5);
      dragAcc(s, acc);
      o[0] = s[3]; o[1] = s[4]; o[2] = s[5];
      o[3] = -mu * s[0] / r3 + acc[0]; o[4] = -mu * s[1] / r3 + acc[1]; o[5] = -mu * s[2] / r3 + acc[2];
    };
    const k1 = new Float64Array(6), k2 = new Float64Array(6), k3 = new Float64Array(6), k4 = new Float64Array(6), tmp = new Float64Array(6);
    let tt = 0; const h = 0.005;
    for (let i = 0; i < 200000; i++) {
      f(y, k1);
      for (let j = 0; j < 6; j++) tmp[j] = y[j] + 0.5 * h * k1[j]; f(tmp, k2);
      for (let j = 0; j < 6; j++) tmp[j] = y[j] + 0.5 * h * k2[j]; f(tmp, k3);
      for (let j = 0; j < 6; j++) tmp[j] = y[j] + h * k3[j]; f(tmp, k4);
      for (let j = 0; j < 6; j++) y[j] += h / 6 * (k1[j] + 2 * k2[j] + 2 * k3[j] + k4[j]);
      tt += h;
      const d = dragAcc(y, null), flux = K_HEAT * Math.sqrt(d.rho) * d.air ** 3;
      if (flux > ref.peakQ.flux) ref.peakQ = { flux, alt: d.alt, speed: d.air, t: tt };
      f(y, k1);
      const sp = Math.hypot(y[3], y[4], y[5]), slow = -(y[3] * k1[3] + y[4] * k1[4] + y[5] * k1[5]) / sp;   // -d|v|/dt, as measured in the game
      if (slow > ref.peakG.a) ref.peakG = { a: slow, alt: d.alt, speed: d.air, t: tt };
      if (d.air < 250) break;
    }
  }
  return { g, ref };
}

function heating(S) {
  const b = sys.byId.verda, { scale, rho0 } = b.atmo;
  const vE = 2000, gamma = 25 * Math.PI / 180;
  const { g, ref } = entry(b, vE, gamma);
  S.ok('steep 2 km/s entry at 25 deg: the bare capsule survives', !g.dead, g.dead || '');
  S.check('heat flux above the atmosphere', 0, g.fluxAbove, 0, { unit: 'W/m2' });
  S.check('heat flux follows K sqrt(rho) v^3 all the way down (worst)', 0, g.formulaErr, 0.02, { note: 'K = 1.83e-4: Sutton-Graves for Earth air and a nose radius of 0.9 m; compared below the taper at the top, where the density changes by tens of percent within one step' });
  S.check('capsule holds its heat shield into the airflow while it is hot (worst tilt)', 0, g.tilt * 180 / Math.PI, 5, { unit: 'deg' });
  S.check('peak heat flux vs reference point-mass entry', ref.peakQ.flux, g.peakQ.flux, 0.01, { rel: true, unit: 'W/m2' });
  S.check('altitude of peak heating vs reference', ref.peakQ.alt, g.peakQ.alt, 150, { unit: 'm' });
  S.check('peak deceleration (rate of loss of speed) vs reference', ref.peakG.a, g.peakG.a, 0.02, { rel: true, unit: 'm/s2', note: `${(g.peakG.a / G0).toFixed(1)} g` });
  S.check('altitude of peak deceleration vs reference', ref.peakG.alt, g.peakG.alt, 200, { unit: 'm' });
  S.ok('peak heating comes before (and higher than) peak deceleration', g.peakQ.t < g.peakG.t && g.peakQ.alt > g.peakG.alt);
  // Allen-Eggers ballistic entry, from the fastest point of the descent (gravity speeds the fall before the air bites)
  S.check('speed at peak heating / top speed vs Allen-Eggers exp(-1/6)', Math.exp(-1 / 6), g.peakQ.speed / g.vmax, 0.04, { note: `peak ${(g.peakQ.flux / 1000).toFixed(0)} kW/m2 at ${(g.peakQ.alt / 1000).toFixed(1)} km` });
  S.check('speed at peak deceleration / top speed vs Allen-Eggers exp(-1/2)', Math.exp(-1 / 2), g.peakG.speed / g.vmax, 0.05);
  S.check('peak deceleration vs Allen-Eggers v^2 sin(gamma) / (2 e H)', g.vmax ** 2 * Math.sin(g.gammaAtVmax) / (2 * Math.E * scale), g.peakG.a, 0.25, { rel: true, unit: 'm/s2', note: 'rough closed form: it ignores gravity and the curve of the path' });
  const beta = g.m / (capCdA * 1.5);
  S.check('altitude of peak heating vs Allen-Eggers H ln(3 rho0 H / (beta sin gamma))', scale * Math.log(3 * rho0 * scale / (beta * Math.sin(g.gammaAtVmax))), g.peakQ.alt, 1500, { unit: 'm' });
  S.info('hottest part reached, as a fraction of its limit', g.maxTemp, '', 'bare capsule, no heat shield part');
  // trend with entry speed at the same path angle: against the reference, and roughly v^3
  const slow = entry(b, 1500, gamma), fast = entry(b, 2400, gamma);
  S.check('1.5 km/s entry: peak heat flux vs reference', slow.ref.peakQ.flux, slow.g.peakQ.flux, 0.01, { rel: true, unit: 'W/m2' });
  S.check('2.4 km/s entry: peak heat flux vs reference', fast.ref.peakQ.flux, fast.g.peakQ.flux, 0.01, { rel: true, unit: 'W/m2' });
  const expect = Math.pow(fast.g.vmax / slow.g.vmax, 3) * Math.sqrt(Math.sin(fast.g.gammaAtVmax) / Math.sin(slow.g.gammaAtVmax));
  S.check('peak heat flux grows as (top speed)^3 sqrt(sin gamma) between the two', expect, fast.g.peakQ.flux / slow.g.peakQ.flux, 0.15, { rel: true, note: 'rough closed form (Allen-Eggers); the two reference rows above are the strict check' });
  S.ok('faster entry runs hotter', fast.g.maxTemp > g.maxTemp && g.maxTemp > slow.g.maxTemp, `${slow.g.maxTemp.toFixed(2)} < ${g.maxTemp.toFixed(2)} < ${fast.g.maxTemp.toFixed(2)} of the limit${fast.g.dead ? ' (' + fast.g.dead + ')' : ''}`);
}

// ------------------------------------------------------------------------------------------ 4d surface gravity
function gravity(S) {
  for (const b of sys.bodies) {
    const g = SYSTEM.byId[b.id];
    if (b.def && b.def.surfaceG !== undefined) S.check(`${b.name}: GM / R^2 vs the listed surface gravity`, b.def.surfaceG, b.gm / b.radius ** 2, 1e-12, { rel: true, unit: 'm/s2' });
    if (b.id === 'helion') continue;
    // free fall from rest for 20 s well above terrain and air, against the exact radial Kepler solution
    const r0 = b.radius * 1.5 + (b.atmo ? b.atmo.height : 0);
    const w = new World();
    const v = spawn(w, capsule(), b.id, [0, r0, 0], [0, 0, 0]);
    run(w, 20, 0.02);
    const ref = R.keplerUV([0, r0, 0], [0, 1e-9, 0], b.gm, 20);
    const fall = r0 - v.pos.length(), refFall = r0 - R.norm(ref.r);
    S.check(`${b.name}: free fall in 20 s from rest at ${(r0 / b.radius).toFixed(2)} R vs GM/r^2`, refFall, fall, 2e-5, { rel: true, unit: 'm', note: `g there ${(b.gm / r0 ** 2).toFixed(4)} m/s2` });
  }
}

// ------------------------------------------------------------------------------------------ 4e ballistic hop
function hop(S, long) {
  const cases = [['pell', 10000, 300], ['ost', 8000, 60], ['dray', 6000, 25]];
  for (const [id, h0, v0] of cases) {
    const b = sys.byId[id], mu = b.gm, r0 = b.radius + h0;
    // closed form for a vertical (radial) Kepler arc
    const ra = 1 / (1 / r0 - v0 * v0 / (2 * mu)), a = ra / 2;
    const E0 = Math.acos(1 - r0 / a);
    const tUp = Math.sqrt(a ** 3 / mu) * (Math.PI - (E0 - Math.sin(E0)));
    const flat = v0 * v0 / (2 * mu / r0 ** 2);
    const modes = [['1x physics', 0, 0.02], ['4x physics warp', 3, 0.02]];
    if (long || id === 'pell') modes.push(['rails warp 50x', 6, 0.02]);
    for (const [label, warp, slice] of modes) {
      const w = new World();
      const v = spawn(w, capsule(), id, [0, r0, 0], [0, v0, 0]);
      if (warp) w.setWarp(warp);
      let tApex = null, rApex = 0, tBack = null, prev = { t: w.ut, r: r0, vr: v0 };
      for (let i = 0; i < 4e6 && tBack === null; i++) {
        w.step(slice);
        if (warp && w.warpIndex !== warp && tApex === null) w.setWarp(warp);
        const r = v.pos.length(), vr = v.pos.dot(v.vel) / r, t = w.ut;
        if (tApex === null && vr <= 0) {
          const f = prev.vr / (prev.vr - vr); tApex = prev.t + f * (t - prev.t);
          // apex height from the energy of the state (exact for the arc the game is on)
          rApex = 1 / (1 / r - v.vel.lengthSq() / (2 * mu));
        }
        if (tApex !== null && r <= r0) { const f = (prev.r - r0) / (prev.r - r); tBack = prev.t + f * (t - prev.t); }
        prev = { t, r, vr };
        if (v.dead) break;
      }
      S.check(`${b.name} hop at ${v0} m/s from ${h0 / 1000} km, ${label}: apex altitude vs closed form`, ra - b.radius, rApex - b.radius, 0.05, { unit: 'm', note: `flat-ground estimate v^2/2g would give ${(h0 + flat).toFixed(0)} m` });
      S.check(`${b.name} hop, ${label}: time to apex`, tUp, tApex, warp >= 4 ? 0.05 : 0.02, { unit: 's' });
      S.check(`${b.name} hop, ${label}: time back at the starting height`, 2 * tUp, tBack, warp >= 4 ? 0.05 : 0.02, { unit: 's' });
    }
  }
}

export const groups = [
  { name: '4a. Atmosphere: density and pressure vs scale height', fast: true, run: S => atmosphere(S) },
  { name: '4b. Drag: capsule drop vs reference integration, terminal velocity', fast: true, run: S => drag(S) },
  { name: '4c. Re-entry heating: flux law and Allen-Eggers ballistic entry', fast: true, run: S => heating(S) },
  { name: '4d. Gravity: GM/R^2 and free fall on every body', fast: true, run: S => gravity(S) },
  { name: '4e. Vertical ballistic hop on airless moons vs closed form', fast: true, run: (S, long) => hop(S, long) },
];
