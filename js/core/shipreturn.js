// Starwright: bringing a ship home belly first (docs/SHEARWATER.md, "The ship's return"). PURE SIMULATION.
//
// A ship with body flaps falls broadside to the air, which slows it far more than falling end on, and steers by
// tilting: leaning the belly a little off the wind turns part of the drag into a sideways push. This program
//   plan      picks the moment for the braking burn, so that the fall ends over the target
//   turn      points the engines forward
//   deorbit   burns
//   coast     waits for the air, belly to the path
//   entry     flies the fast part: the angle to the air sets how far the ship carries, and it is steered to be over
//             the target while still high (opts.overAlt)
//   terminal  falls flat from there, sliding to stay over the target, level speed dying away
//   flip      lights the engines and swings tail down
//   landing   hands over to the booster's landing program (booster.js), which flies it to the ground or the arms
//
// What it knows about the ship comes from a wind tunnel: a copy of the vessel in a scratch world, held at a few
// angles and speeds for one step each, and the forces read off. Nothing here is fitted to one design.
import { Vector3, Quaternion } from '../lib/three.module.min.js';
import { predictEntry } from './entry.js';
import { predictFall, boosterRecovery } from './booster.js';
import { Orbit } from './orbit.js';
import { TUNING } from './vessel.js';

const TAU = Math.PI * 2, DEG = Math.PI / 180;
const clamp = (x, a, b) => x < a ? a : x > b ? b : x;
const TUNNEL_MACH = [0.3, 0.6, 0.9, 1.2, 1.6, 2.5, 4, 7];
const _a = new Vector3(), _b = new Vector3(), _c = new Vector3();

/** True for a vessel this program can fly: body flaps fore and aft that fold, an engine, and a way to steer in space. */
export function bellyFlyer(v) {
  if (!v || v.dead || !v._flaps || v._flaps.length < 4) return false;
  let fore = 0, aft = 0;
  for (const p of v._flaps) if (p._flap) { if (p.pos.y > v.com.y) fore++; else aft++; }
  return fore >= 2 && aft >= 2 && v.engines.length > 0;
}

/**
 * Forces on the vessel falling belly first, measured on a copy. → { aoa: [rad…], rows: [{ aoa, drag (Float64Array,
 * drag area in m² against Mach 0 to 12 in tenths), ld (lift over drag above Mach 2), ldLow (below Mach 0.9) }] }
 */
export function windTunnel(world, v, aoas = [50 * DEG, 70 * DEG, 88 * DEG]) {
  const W = world.constructor, body = v.body, w = new W();
  const copy = v.constructor.fromJSON(v.toJSON());
  const wy = TAU / body.rotPeriod, top = body.atmo.height;
  const pos = new Vector3(body.radius + 0.3 * top, 0, 0), vel = new Vector3();
  const c = w.spawn(copy, { body, pos, vel: vel.set(0, 0, 100), makeActive: true });
  c.ctrl.throttle = 0; c.ctrl.sas = false; c.ctrl.rcs = false;
  const rows = [], q = new Quaternion(), v0 = new Vector3(), acc = new Vector3(), u = new Vector3(0, 0, 1), up = new Vector3(1, 0, 0);
  const dt = 0.02, Q = 4000;
  // each speed is run where the air presses about as hard (4 kPa), so that no reading is lost in the weight
  const altFor = m => { let lo = 0, hi = top; for (let i = 0; i < 30; i++) { const h = (lo + hi) / 2, sp = m * body.soundSpeed(h); if (0.5 * body.density(h) * sp * sp > Q) lo = h; else hi = h; } return lo; };
  for (const aoa of aoas) {
    const cd = [], ld = [];
    for (const m of TUNNEL_MACH) {
      const alt = altFor(m), R = body.radius + alt, g = body.gm / (R * R), sp = m * body.soundSpeed(alt), rho = body.density(alt);
      // twice: the first step only brings the vessel's own record of the air (Mach number, density) to this point
      let ok = true;
      for (let k = 0; k < 2 && ok; k++) {
        c.pos.set(R, 0, 0); c.vel.set(0, 0, sp - wy * R); c.w.set(0, 0, 0); c.landed = false; c.dead = false;
        c.bellyAoa = aoa; c.bellyLift = null; c.bellyNose = null;
        for (const p of c._flaps) { p.fold = TUNING.FLAP_REST; p._foldCmd = p.fold; }
        if (!c.bellyAttitude(q)) { ok = false; break; }
        c.q.copy(q);
        v0.copy(c.vel);
        w.step(dt);
      }
      if (!ok) { cd.push(0); ld.push(0); continue; }
      acc.copy(c.vel).sub(v0).multiplyScalar(1 / dt).addScaledVector(up, g);
      const qd = 0.5 * rho * sp * sp, D = -acc.dot(u) * c.mass / qd, L = acc.dot(up) * c.mass / qd;
      cd.push(D); ld.push(D > 0 ? L / D : 0);
    }
    const drag = new Float64Array(121);
    for (let i = 0; i <= 120; i++) {
      const m = i / 10; let j = 0;
      while (j < TUNNEL_MACH.length - 2 && m > TUNNEL_MACH[j + 1]) j++;
      const f = clamp((m - TUNNEL_MACH[j]) / (TUNNEL_MACH[j + 1] - TUNNEL_MACH[j]), 0, 1);
      drag[i] = cd[j] + (cd[j + 1] - cd[j]) * f;
    }
    rows.push({ aoa, drag, ld: (ld[5] + ld[6] + ld[7]) / 3, ldLow: (ld[0] + ld[1]) / 2 });
  }
  return { aoa: aoas, rows, mass: v.mass };
}

/**
 * shipReturn(world, vessel, opts) → controller { phase, done, failed, log, miss, update() }.
 * opts.target: body-fixed direction of the place to come down (default: the launch site). opts.floor, opts.sets:
 * as for boosterRecovery (a ship that is to be caught is flown to the arms).
 */
export function shipReturn(world, vessel, opts = {}) {
  const v = vessel, body = v.body;
  const o = { target: body.launchSite ? body.launchSite.dir : new Vector3(1, 0, 0), periapsis: 0.42 * body.atmo.height, aoa: 70 * DEG, aoaMin: 52 * DEG, aoaMax: 86 * DEG,
    overAlt: 11000, lightAlt: 4000, slideGain: 0.35, carry: 4.7, noseRate: 0.12, minTwr: 1.4, maxTilt: 0.6, flipTime: 2.5, burnThrottle: 0.9, floor: 0, sets: null, period: 2, landing: {}, useWarp: false, ...opts };
  const c = { name: 'return', phase: 'init', done: false, failed: false, log: [], vessel: v, miss: NaN, target: o.target, tunnel: null, landing: null, burnAt: null, warning: null };
  c.note = msg => { c.log.push({ t: world.ut, msg }); };
  c.finish = (ok, msg) => { c.done = true; c.failed = !ok; c.phase = ok ? 'done' : 'failed'; if (msg) c.note(msg); };
  const st = { tPred: -Infinity, aoa: o.aoa, bank: 0 };
  const wy = TAU / body.rotPeriod;
  const up = new Vector3(), tgt = new Vector3(), miss = new Vector3(), along = new Vector3(), cross = new Vector3(), srf = new Vector3(), e = new Vector3(), lift = new Vector3(), nose = new Vector3();
  const propellant = () => { let m = 0; for (const p of v.partList) m += (p.res.fuel || 0) + (p.res.ox || 0) + (p.res.lox || 0) + (p.res.ch4 || 0); return m; };
  const engineSet = m => { if (m == null) return; for (const en of v.engines) { const p = en.part; if (p.def.engine.modes && p.def.engine.modes[m] && (p.mode || 0) !== m) v.setEngineMode(p.id, m); } };
  /** Thrust (N) of the engines in the air at the ground, in engine set `mode` (default: as they are set now). */
  const seaThrust = mode => {
    let F = 0;
    for (const en of v.engines) {
      const d = en.part.def.engine, m = d.modes ? d.modes[mode != null && d.modes[mode] ? mode : (en.part.mode || 0)] : null;
      if (d.rings) { for (let i = 0; i < d.rings.length; i++) if (!m || m.rings.includes(i)) { const r = d.rings[i]; F += r.n * r.thrust * 1000 * r.ispAtm / r.ispVac; } }
      else F += d.thrust * 1000 * (d.ispAtm || d.ispVac) / d.ispVac;
    }
    return F;
  };
  const belly = () => { v.ctrl.sas = true; v.ctrl.sasMode = 'belly'; };
  const row = aoa => {
    // the tunnel's rows, mixed for an angle between them
    const r = c.tunnel.rows; let j = 0;
    while (j < r.length - 2 && aoa > r[j + 1].aoa) j++;
    const f = clamp((aoa - r[j].aoa) / (r[j + 1].aoa - r[j].aoa), 0, 1);
    if (!st.mix) st.mix = new Float64Array(121);
    for (let i = 0; i < 121; i++) st.mix[i] = r[j].drag[i] + (r[j + 1].drag[i] - r[j].drag[i]) * f;
    return { drag: st.mix, ld: r[j].ld + (r[j + 1].ld - r[j].ld) * f };
  };
  /** Where a fall from (pos, vel) at time t ends, flown at `aoa`: fills `miss` (level vector from there to the target). */
  const fall = (pos, vel, t, aoa, floor = 0, flat = 0, carry = 0) => {
    const r = row(aoa);
    let pr = predictEntry(body, pos, vel, t, { mass: v.mass, drag: r.drag, ld: r.ld, ldMach: [0.7, 1.5], floor: o.floor + floor, terrain: false, maxT: 6000 });
    if (pr.end !== 'land') return null;
    if (flat > 0 && floor > flat) {
      // second leg: flat from there down to `flat` metres up
      const r2 = row(o.aoaMax);
      const p2 = predictEntry(body, pr.pos, pr.vel, t + pr.t, { mass: v.mass, drag: r2.drag, ld: r2.ld, ldMach: [0.7, 1.5], floor: o.floor + flat, terrain: false, maxT: 600 });
      if (p2.end === 'land') { p2.t += pr.t; pr = p2; }
    }
    body.surfaceDirToInertial(o.target, t + pr.t, tgt).normalize().multiplyScalar(pr.pos.length());
    miss.copy(tgt).sub(pr.pos);
    up.copy(pr.pos).normalize();
    if (carry > 0) { miss.x -= (pr.vel.x - wy * pr.pos.z) * carry; miss.y -= pr.vel.y * carry; miss.z -= (pr.vel.z + wy * pr.pos.x) * carry; }
    miss.addScaledVector(up, -miss.dot(up));
    // along the track: the way the ship is going over the ground at the start, carried to the end point
    along.set(vel.x - wy * pos.z, vel.y, vel.z + wy * pos.x);
    cross.crossVectors(pos, along).normalize();                 // the orbit's pole, near enough
    along.crossVectors(cross, up).normalize();
    cross.crossVectors(along, up);                              // to the right of the track
    return { pr, along: miss.dot(along), cross: miss.dot(cross), dist: miss.length() };
  };
  /** The braking burn: how much, and when. Tries each moment of the next orbit and keeps the one that ends nearest. */
  const plan = () => {
    const orb = Orbit.fromState(v.pos, v.vel, body.gm, world.ut);
    if (orb.hyper || orb.periapsis < body.radius + body.atmo.height) return null;
    const P = orb.period, pos = new Vector3(), vel = new Vector3();
    const at = t => {
      orb.posAt(t, pos); orb.velAt(t, vel);
      const r1 = pos.length(), r2 = body.radius + o.periapsis, a = (r1 + r2) / 2;
      const dv = vel.length() - Math.sqrt(Math.max(0, body.gm * (2 / r1 - 1 / a)));
      _a.copy(vel).normalize(); vel.addScaledVector(_a, -dv);
      const f = fall(pos, vel, t, o.aoa, o.overAlt, o.lightAlt);
      return f ? { t, dv, along: f.along, cross: f.cross, dist: f.dist } : null;
    };
    // a coarse sweep for where the along-track miss changes sign with the ship coming up on the target, then halve
    const N = 72, lead = 90;
    let prev = null, best = null;
    for (let i = 0; i <= N; i++) {
      const s = at(world.ut + lead + P * i / N);
      if (s && prev && prev.along > 0 && s.along <= 0 && Math.abs(prev.along) + Math.abs(s.along) < 0.5 * body.radius) {
        let lo = prev, hi = s;
        for (let k = 0; k < 14; k++) { const m = at((lo.t + hi.t) / 2); if (!m) break; if (m.along > 0) lo = m; else hi = m; }
        const r = Math.abs(lo.along) < Math.abs(hi.along) ? lo : hi;
        if (!best || Math.abs(r.cross) < Math.abs(best.cross)) best = r;
      }
      prev = s;
    }
    return best;
  };
  const burnTime = dv => { const pw = v.enginePower(); return pw.thrust > 0 ? v.mass * pw.ve / pw.thrust * (1 - Math.exp(-dv / pw.ve)) : Infinity; };

  c.update = () => {
    if (c.done) return;
    if (v.dead) { c.finish(false, 'the ship was lost'); return; }
    if (c.landing) {
      c.landing.update();
      c.miss = c.landing.miss; c.warning = c.landing.warning;
      if (c.landing.done) c.finish(!c.landing.failed);
      return;
    }
    const alt = v.altitude, top = body.atmo.height;
    up.copy(v.pos).normalize();
    switch (c.phase) {
      case 'init': {
        if (!bellyFlyer(v)) { c.finish(false, 'this vessel has no flaps to fall on'); break; }
        {
          // can the engines set it down? Low in the air they must give half as much again as the ship weighs
          const F = seaThrust(o.sets && o.sets.burn), g0 = body.gm / (body.radius * body.radius), most = o.burnThrottle * F / (o.minTwr * g0);
          if (v.mass > most) { c.finish(false, `too heavy to set down: ${((v.mass - most) / 1000).toFixed(0)} t over what its engines can stop`); break; }
        }
        c.tunnel = windTunnel(world, v);
        c.note(`wind tunnel: ${c.tunnel.rows.map(r => `${(r.aoa / DEG).toFixed(0)} deg ${r.drag[60].toFixed(0)} m2 L/D ${r.ld.toFixed(2)}`).join(', ')}`);
        v.ctrl.throttle = 0;
        if (alt < top || Orbit.fromState(v.pos, v.vel, body.gm, world.ut).periapsis < body.radius + top) { c.phase = 'coast'; c.note('already on the way down'); break; }
        const p = plan();
        if (!p) { c.finish(false, 'no braking burn on this orbit comes down at the target'); break; }
        st.plan = p; c.burnAt = p.t - burnTime(p.dv) / 2;
        c.note(`braking burn of ${p.dv.toFixed(0)} m/s in ${(c.burnAt - world.ut).toFixed(0)} s; the fall should end ${(Math.abs(p.cross) / 1000).toFixed(1)} km to one side of the target (${(p.along / 1000).toFixed(1)} km along)`);
        if (Math.abs(p.cross) > 25000) c.warning = 'the orbit does not pass over the target';
        c.phase = 'turn';
        break;
      }
      case 'turn': {
        v.ctrl.sas = true; v.ctrl.sasMode = 'retrograde'; v.ctrl.throttle = 0;
        engineSet(o.sets && o.sets.deorbit);
        if (o.useWarp && world.warpTarget === null && world.ut < c.burnAt - 50) world.warpTo(c.burnAt - 40);
        if (world.ut >= c.burnAt) { st.v0 = v.vel.length(); st.dvLeft = st.plan.dv; c.phase = 'deorbit'; c.note('braking burn'); }
        break;
      }
      case 'deorbit': {
        v.ctrl.sas = true; v.ctrl.sasMode = 'retrograde';
        const pw = v.enginePower();
        if (!(pw.thrust > 0) || propellant() <= 0) { v.ctrl.throttle = 0; c.finish(false, 'no engine for the braking burn'); break; }
        // burn until the periapsis is where the plan put it
        const orb = Orbit.fromState(v.pos, v.vel, body.gm, world.ut);
        const left = orb.periapsis - (body.radius + o.periapsis);
        if (left <= 0) { v.ctrl.throttle = 0; c.phase = 'coast'; c.note(`burn over: periapsis ${((orb.periapsis - body.radius) / 1000).toFixed(1)} km`); break; }
        const aNow = pw.thrust / v.mass;
        v.ctrl.throttle = clamp(left / 4000 * (2 / Math.max(aNow, 0.1)), 0.05, 1);
        break;
      }
      case 'coast': {
        v.ctrl.throttle = 0; v.bellyAoa = st.aoa; v.bellyLift = null; v.bellyNose = null; belly();
        if (o.useWarp && alt > top + 3000 && world.warpTarget === null && st.warped !== true) {
          // skip the quiet fall to the air, once the ship has turned its belly to it
          st.settle = (st.settle || 0) + 1;
          if (st.settle > 600) {
            st.warped = true;
            try { const tIn = Orbit.fromState(v.pos, v.vel, body.gm, world.ut).timeAtRadius(body.radius + top + 2500, true, world.ut); if (Number.isFinite(tIn) && tIn > world.ut + 30) world.warpTo(tIn); } catch { /* fly it out at 1x */ }
          }
        }
        if (alt < top) { c.phase = 'entry'; c.note(`into the air at ${(v.surfaceVel.length()).toFixed(0)} m/s`); }
        break;
      }
      case 'entry': {
        belly(); v.ctrl.rcs = true;
        if (world.ut - st.tPred >= o.period) {
          st.tPred = world.ut;
          // three falls from here, shallow, middle and steep: the angle whose fall ends on the target, and the bank
          const lo = fall(v.pos, v.vel, world.ut, o.aoaMin, o.overAlt, o.lightAlt), hi = fall(v.pos, v.vel, world.ut, o.aoaMax, o.overAlt, o.lightAlt), mid = fall(v.pos, v.vel, world.ut, st.aoa, o.overAlt, o.lightAlt);
          if (lo && hi && mid) {
            // lo (more lift) carries farther, so its along-track miss is the smallest. The angle whose fall would end
            // on the target lies between the present one and whichever end is on the other side of it.
            let want;
            if (mid.along > 0) want = lo.along >= 0 ? o.aoaMin : st.aoa + (o.aoaMin - st.aoa) * mid.along / (mid.along - lo.along);
            else want = hi.along <= 0 ? o.aoaMax : st.aoa + (o.aoaMax - st.aoa) * mid.along / (mid.along - hi.along);
            st.aoa += clamp(want - st.aoa, -0.1, 0.1);
            c.miss = mid.dist; st.cross = mid.cross; st.togo = mid.pr.t;
            if (o.debug) c.note(`alt ${(alt / 1000).toFixed(1)} lo ${(lo.along / 1000).toFixed(1)} hi ${(hi.along / 1000).toFixed(1)} mid ${(mid.along / 1000).toFixed(1)} cross ${(mid.cross / 1000).toFixed(1)} aoa ${(st.aoa / DEG).toFixed(0)}`);
            const reach = Math.max(2000, 0.15 * v.surfaceVel.length() * mid.pr.t * 0.3);
            st.bank = clamp(mid.cross / reach, -1, 1) * 0.7;
          }
        }
        // lift: its size from the angle to the air, turned about the path by the bank
        const u = v.airDirection(_a);
        if (u) {
          _b.copy(up).addScaledVector(u, -up.dot(u)).normalize();
          _c.crossVectors(u, _b);
          const m = 1 / Math.tan(st.aoa);
          lift.copy(_b).multiplyScalar(m * Math.cos(st.bank)).addScaledVector(_c, m * Math.sin(st.bank));
          v.bellyLift = lift; v.bellyNose = null;
        }
        if (v.radarAlt < o.overAlt) {
          c.phase = 'terminal';
          nose.copy(v.surfaceVel).addScaledVector(up, -v.surfaceVel.dot(up));
          if (nose.lengthSq() < 1) nose.set(0, 1, 0).applyQuaternion(v.q).addScaledVector(up, -nose.dot(up));
          nose.normalize(); st.noseFixed = body.inertialToSurfaceDir(nose, world.ut, new Vector3());
          c.note(`falling flat from ${(alt / 1000).toFixed(1)} km, ${(c.miss / 1000).toFixed(1)} km from the target`);
        }
        break;
      }
      case 'terminal': {
        belly(); v.ctrl.rcs = true; v.ctrl.throttle = 0;
        // slide toward the target: a level speed wanted in proportion to the distance still to go, so that the
        // ship closes in ever more slowly and is falling straight down when it gets there. The lean is the push that
        // brings the level speed to that in a few seconds, with what the air takes from the level speed anyway given
        // back, as a share of the drag.
        body.surfaceDirToInertial(o.target, world.ut, tgt).normalize();
        e.copy(tgt).addScaledVector(up, -tgt.dot(up));
        const dist = Math.asin(clamp(e.length(), 0, 1)) * (body.radius + alt);
        if (e.lengthSq() > 1e-16) e.normalize();
        srf.copy(v.surfaceVel).addScaledVector(up, -v.surfaceVel.dot(up));
        const vs = -v.surfaceVel.dot(up), sp = Math.max(v.surfaceVel.length(), 1);
        const D = Math.max(0.5 * 9.81, v.gForce * 9.81);
        if (!st.lift) st.lift = new Vector3();
        if (world.ut - (st.tFlat || -Infinity) >= 0.5) {
          st.tFlat = world.ut;
          // where will the flat fall from here be when the engines light, and how fast over the ground? The turn
          // and the burn carry it on from there for about `carry` seconds at that speed. Lean toward the target
          // from where that ends, harder the farther off it is for the time left.
          const hl = Math.max(0, (st.hb > 0 ? st.hb : o.lightAlt) - 50);
          const f = v.radarAlt - o.floor > hl + 150 ? fall(v.pos, v.vel, world.ut, o.aoaMax, hl, 0, o.carry) : null;
          if (f) {
            const tgo = Math.max(3, f.pr.t), reach = 0.25 * D * tgo * tgo * o.slideGain;
            st.lift.copy(miss).multiplyScalar(1 / Math.max(reach, 1));
            st.pred = f.dist;
          }
        }
        // (leaning to speed up is kept small: every degree of it has to be swung back through to slow down again)
        { const m = st.lift.length(), cap = Math.tan(o.maxTilt); if (m > cap) st.lift.multiplyScalar(cap / m); }
        c.miss = dist; st.level = srf.length();
        // the hull pushes sideways only along its own length: the nose is laid along the lean, whichever way round
        // is the smaller turn, and left where it is when there is next to no lean to make
        if (st.lift) v.bellyLift = lift.copy(st.lift); else v.bellyLift = null;
        body.surfaceDirToInertial(st.noseFixed, world.ut, nose);
        if (st.lift && st.lift.lengthSq() > 0.02) {
          _a.copy(st.lift).addScaledVector(up, -st.lift.dot(up));
          if (_a.lengthSq() > 1e-8) {
            _a.normalize(); if (_a.dot(nose) < 0) _a.negate();
            // (turned toward it at a rate the flaps can follow: a nose that chases a lean that wanders spins the ship)
            const ang = Math.acos(clamp(_a.dot(nose), -1, 1)), step = o.noseRate * (world.ut - (st.tNose || world.ut));
            if (ang > 1e-4) { nose.lerp(_a, Math.min(1, step / ang)).addScaledVector(up, -nose.dot(up)).normalize(); body.inertialToSurfaceDir(nose, world.ut, st.noseFixed); }
          }
        }
        st.tNose = world.ut;
        v.bellyNose = nose;
        c.miss = st.flat !== undefined ? st.flat : dist;
        // when to light: the height the burn needs to stop the fall, once the ship is tail down, and the time to turn
        if (world.ut - st.tPred >= 0.5) {
          st.tPred = world.ut;
          const thrust = seaThrust(o.sets && o.sets.burn);
          if (thrust > 0) {
            // the flat fall from here, a quarter of a second at a time, down to the height where what is left is
            // what the turn and the burn need at the speed it will have by then (it is still slowing in thicker air)
            const g = body.gm / v.pos.lengthSq(), aNet = o.burnThrottle * thrust / v.mass - g;
            if (aNet > 0.5) {
              const drag = row(o.aoaMax).drag, gh = alt - v.radarAlt;
              let h = v.radarAlt - o.floor, w = Math.max(vs, 1);
              st.hb = h;
              for (let i = 0; i < 2000 && h > 0; i++) {
                if (h <= w * w / (2 * aNet) + w * o.flipTime) break;
                const a = h + o.floor + gh, mach = w / body.soundSpeed(a), x = mach >= 12 ? 119.999 : mach * 10, k = x | 0;
                const cda = drag[k] + (drag[k + 1] - drag[k]) * (x - k);
                w += (g - 0.5 * body.density(a) * w * w * cda / v.mass) * 0.25;
                h -= w * 0.25;
                st.hb = h;
              }
            } else st.hb = Infinity;
          }
        }
        if (st.hb === Infinity) { c.finish(false, 'the engines cannot stop this ship'); break; }
        if (st.hb > 0 && v.radarAlt - o.floor <= st.hb && vs > 0) {
          c.phase = 'flip';
                    c.note(`flip at ${(v.radarAlt).toFixed(0)} m, ${vs.toFixed(0)} m/s down, ${dist.toFixed(0)} m from the target, ${st.level.toFixed(1)} m/s over the ground, aim off by ${(st.pred || 0).toFixed(0)} m`);
          st.tFlip = world.ut;
        }
        break;
      }
      case 'flip': {
        // engines on and tail down; the landing program takes it from here
        engineSet(o.sets && o.sets.burn);
        v.bellyLift = null; v.bellyNose = null;
        for (const en of v.engines) if (!en.part.ignited && !en.part.flameout) en.part.ignited = true;
        c.landing = boosterRecovery(world, v, { target: o.target, floor: o.floor, sets: o.sets ? { burn: o.sets.burn, final: o.sets.final } : null, aimBurn: true, terrain: false, heatLimit: Infinity, maxLean: 0.05, steerBurn: 0.25, clearAlt: 150, reach: 120, thrustScale: (() => { const pw = v.enginePower(); return pw.thrust > 0 ? clamp(seaThrust(o.sets && o.sets.burn) / pw.thrust, 0.3, 1) : 1; })(), ...o.landing });
        c.phase = 'landing';
        break;
      }
    }
  };
  return c;
}
