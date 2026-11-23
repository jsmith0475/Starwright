// Starwright reusable boosters, phase 2 (docs/BOOSTERS.md): where a falling stage comes down, and the program that
// flies it back. PURE SIMULATION - runs under Node. Nothing here moves a vessel: the predictor only reads its state,
// and the recovery program only sets the controls a player has (throttle, SAS target, legs), like every other
// program in autopilot.js.
import { Vector3 } from '../lib/three.module.min.js';
import { TUNING, machDrag, surfaceAt } from './vessel.js';

const TAU = Math.PI * 2;
const G0 = 9.80665;
const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);
const _p = new Vector3(), _q = new Vector3(), _r = new Vector3(), _s = new Vector3(), _t = new Vector3();

/** Height (m above body.radius) of the ground or sea under an inertial position at time t. */
export function groundUnder(body, x, y, z, t) {
  body.inertialToSurfaceDir(_p.set(x, y, z), t, _p);
  return surfaceAt(body, _p);
}

/**
 * Integrates a point mass from (pos, vel) at time `ut` down to the ground through air that turns with the planet.
 * The body flies along its own axis, so drag acts against the air-relative velocity with area `area` (m², from
 * Vessel.axialDragArea) times the game's own Mach factor. With `thrust` (N) and `ve` (m/s) set it also burns
 * against the air-relative velocity at `throttle`, from `burnBelow` metres above the ground (default: all the way),
 * losing mass as it goes, never below `dryMass`. With `entry: { flux, speed }` it also burns at full thrust on the
 * way down from where the heating flux reaches `flux` (W/m²) until the air-relative speed is down to `speed`.
 *
 * → { hit, t (s from ut), pos (inertial, at the end), dir (body-fixed unit direction of the end point), alt (m above
 *     the ground at the end), speed, vs (air-relative and vertical speed at the end), maxQ (Pa), maxQAlt, maxFlux
 *     (W/m², the game's heating flux), maxG (m/s², drag deceleration), apogee (m), mass, stopped (the burn brought it
 *     to rest in the air) }
 */
export function predictFall(body, pos, vel, mass, ut, opts = {}) {
  const o = { area: 1, thrust: 0, ve: 0, throttle: 1, burnBelow: Infinity, dryMass: 0, maxT: 2400, floor: 0, coarse: 1, entry: null, ...opts };
  const R = body.radius, gm = body.gm, wy = TAU / body.rotPeriod;
  const atmoTop = body.atmo ? body.atmo.height : 0;
  let x = pos.x, y = pos.y, z = pos.z, vx = vel.x, vy = vel.y, vz = vel.z, m = mass, t = 0;
  const out = { hit: false, t: 0, pos: new Vector3(), dir: new Vector3(), alt: 0, speed: 0, vs: 0, maxQ: 0, maxQAlt: 0, maxFlux: 0, maxG: 0, apogee: -Infinity, mass, stopped: false, speedMax: 0 };
  const F = o.thrust * o.throttle, mdot = o.ve > 0 ? F / o.ve : 0;
  let ax = 0, ay = 0, az = 0, sp = 0, qd = 0, rr = 0, mach = 0, burning = false, entering = false, entryDone = !o.entry, FF = 0;
  // acceleration at a state; leaves the air-relative speed in sp and the dynamic pressure in qd
  const acc = (px, py, pz, ux, uy, uz, mm, gh) => {
    rr = Math.sqrt(px * px + py * py + pz * pz);
    const alt = rr - R, g = -gm / (rr * rr * rr);
    const sx = ux - wy * pz, sy = uy, sz = uz + wy * px;
    sp = Math.sqrt(sx * sx + sy * sy + sz * sz);
    const rho = alt < atmoTop ? body.density(alt) : 0;
    qd = 0.5 * rho * sp * sp;
    mach = rho > 0 ? sp / body.soundSpeed(alt) : 0;
    let k = sp > 1e-6 ? qd * machDrag(mach) * o.area / (mm * sp) : 0;
    burning = F > 0 && mm > o.dryMass && alt - gh < o.burnBelow;
    entering = false;
    if (!entryDone && !burning && o.thrust > 0 && mm > o.dryMass && px * ux + py * uy + pz * uz < 0) {
      if (sp <= o.entry.speed) { if (rho > 0 && TUNING.HEAT_FLUX_K * Math.sqrt(rho) * sp * sp * sp >= o.entry.flux * 0.5) entryDone = true; }
      else if (rho > 0 && TUNING.HEAT_FLUX_K * Math.sqrt(rho) * sp * sp * sp >= o.entry.flux) entering = true;
    }
    FF = burning ? F : entering ? o.thrust : 0;
    if (FF > 0 && sp > 1e-6) k += FF / (mm * sp);
    ax = g * px - k * sx; ay = g * py - k * sy; az = g * pz - k * sz;
  };
  let gh = groundUnder(body, x, y, z, ut), lastSp = Infinity;
  for (let i = 0; i < 40000 && t < o.maxT; i++) {
    acc(x, y, z, vx, vy, vz, m, gh);
    const alt = rr - R, h = alt - gh;
    if (alt > out.apogee) out.apogee = alt;
    if (sp > out.speedMax) out.speedMax = sp;
    if (qd > out.maxQ) { out.maxQ = qd; out.maxQAlt = alt; }
    const dragA = qd * machDrag(mach) * o.area / m;
    if (dragA > out.maxG) out.maxG = dragA;
    if (qd > 0) { const flux = TUNING.HEAT_FLUX_K * Math.sqrt(2 * qd / (sp * sp || 1)) * sp * sp * sp; if (flux > out.maxFlux) out.maxFlux = flux; }
    if (burning && (sp < 0.5 || (sp > lastSp && sp < 15))) { out.stopped = true; break; }
    if (burning) lastSp = sp;
    // step: a second high up, finer in thick air, near the ground and under power
    const rv = (x * vx + y * vy + z * vz) / rr;
    let dt = (h > 20000 ? 1 : h > 3000 ? 0.5 : 0.1) * o.coarse;
    if (burning) dt = Math.min(dt, 0.1);
    if (entering) dt = Math.min(dt, 0.25);
    if (rv < 0 && h + rv * dt < 0) dt = Math.max(0.005, Math.min(dt, h / -rv));
    const ax1 = ax, ay1 = ay, az1 = az;
    const hx = x + vx * dt / 2, hy = y + vy * dt / 2, hz = z + vz * dt / 2;
    const wx2 = vx + ax1 * dt / 2, wy2 = vy + ay1 * dt / 2, wz2 = vz + az1 * dt / 2;
    const wasBurning = burning, F1 = FF;
    acc(hx, hy, hz, wx2, wy2, wz2, m, gh);
    x += wx2 * dt; y += wy2 * dt; z += wz2 * dt;
    vx += ax * dt; vy += ay * dt; vz += az * dt;
    if (F1 > 0) m = Math.max(o.dryMass, m - (o.ve > 0 ? F1 / o.ve : 0) * dt);
    void wasBurning;
    t += dt;
    const r2 = Math.sqrt(x * x + y * y + z * z);
    if (r2 - R < 30000 || (i & 15) === 0) gh = groundUnder(body, x, y, z, ut + t);
    if (r2 - R - gh <= o.floor) { out.hit = true; break; }
  }
  const r = Math.sqrt(x * x + y * y + z * z);
  out.t = t; out.pos.set(x, y, z); out.mass = m;
  body.inertialToSurfaceDir(out.dir.set(x, y, z), ut + t, out.dir).normalize();
  out.alt = r - R - groundUnder(body, x, y, z, ut + t);
  const sx = vx - wy * z, sy = vy, sz = vz + wy * x;
  out.speed = Math.sqrt(sx * sx + sy * sy + sz * sz);
  out.vs = (x * vx + y * vy + z * vz) / r;
  return out;
}

/** Great-circle ground distance (m) between two body-fixed directions. */
export function groundDistance(body, a, b) {
  const c = clamp(_q.copy(a).normalize().dot(_r.copy(b).normalize()), -1, 1);
  return Math.acos(c) * body.radius;
}


/**
 * Flies a separated first stage back to a spot on the ground and lands it there on its engine.
 * opts.target is a body-fixed direction (default: the launch site). The program
 *   flip        turns the stage round,
 *   boostback   burns until the predicted impact point (through the air, on the turning planet) is on the target,
 *   coast       falls engine first,
 *   entry       burns against the fall if the predicted heating would pass opts.heatLimit of any part's rating,
 *   landing     lights the engine at the height from which it stops just above the ground, drag and mass loss included,
 *   final       comes down the last metres upright over the target.
 * c.miss is the predicted (then actual) ground distance to the target in metres, c.prediction the last unpowered
 * prediction, c.result the touchdown record. Like every program it only moves the controls.
 */
export function boosterRecovery(world, vessel, opts = {}) {
  const v = vessel, body = v.body;
  const o = { target: body.launchSite ? body.launchSite.dir : new Vector3(1, 0, 0), stopAlt: 20, touchdownSpeed: 1.2, heatLimit: 0.8,
    landingAccel: 26, period: 0.25, tolerance: 40, reach: 60, maxLean: 0.12, aimShort: 0, aimSwitch: 3500, legAlt: 60, ...opts };
  const c = { name: 'recovery', phase: 'init', done: false, failed: false, log: [], vessel: v, miss: NaN, prediction: null, result: null, target: o.target };
  c.note = msg => { c.log.push({ t: world.ut, msg }); };
  c.finish = (ok, msg) => { c.done = true; c.failed = !ok; c.phase = ok ? 'done' : 'failed'; if (msg) c.note(msg); };
  const st = { tPred: -Infinity, best: Infinity };
  const up = new Vector3(), dir = new Vector3(), miss = new Vector3(), tgt = new Vector3(), srf = new Vector3(), e = new Vector3(), drift = new Vector3(), ax = new Vector3();
  const point = d => { v.ctrl.sas = true; v.ctrl.sasMode = 'direction'; v.sasDir.copy(d).normalize(); };
  const hold = m => { v.ctrl.sas = true; v.ctrl.sasMode = m; };
  const noseError = d => ax.set(0, 1, 0).applyQuaternion(v.q).angleTo(d);
  const cg = () => v.baseHeight || 0;
  const propellant = () => { let m = 0; for (const p of v.partList) m += (p.res.fuel || 0) + (p.res.ox || 0) + (p.res.lox || 0) + (p.res.ch4 || 0); return m; };
  const wy = TAU / body.rotPeriod;
  /** Unpowered prediction from now; fills c.miss and `miss` (inertial vector from the impact point to the target, level). */
  const predict = () => {
    const pw = v.enginePower();
    const plan = st.plan && !st.entryDone ? st.plan : null;
    const pr = predictFall(body, v.pos, v.vel, v.mass, world.ut, { area: v.axialDragArea(true), floor: cg(), entry: plan,
      thrust: plan ? pw.thrust : 0, ve: pw.ve, burnBelow: -Infinity, dryMass: st.dry0 });
    body.surfaceDirToInertial(st.aim || o.target, world.ut + pr.t, tgt).normalize().multiplyScalar(pr.pos.length());
    miss.copy(tgt).sub(pr.pos);
    _s.copy(pr.pos).normalize();
    miss.addScaledVector(_s, -miss.dot(_s));
    c.miss = miss.length(); c.prediction = pr; st.tPred = world.ut;
    return pr;
  };
  /**
   * Decides whether the fall needs an entry burn, and how much: the burn starts where the heating flux reaches a
   * tenth of the unpowered peak and ends at the highest speed from which no part passes heatLimit of its rating.
   */
  const planEntry = () => {
    st.tPlan = world.ut;
    if (st.entryDone) return;
    const pw = v.enginePower(), area = v.axialDragArea(true);
    const free = predictFall(body, v.pos, v.vel, v.mass, world.ut, { area, floor: cg() });
    st.heat = v.axialHeatRatio(free.maxFlux, true);
    if (st.heat <= o.heatLimit || !(pw.thrust > 0)) { st.plan = null; return; }
    const flux = 0.1 * free.maxFlux;
    let lo = 100, hi = Math.max(200, free.speedMax);
    for (let i = 0; i < 7; i++) {
      const mid = 0.5 * (lo + hi);
      const pr = predictFall(body, v.pos, v.vel, v.mass, world.ut, { area, floor: cg(), entry: { flux, speed: mid }, thrust: pw.thrust, ve: pw.ve, burnBelow: -Infinity, dryMass: st.dry0 });
      if (v.axialHeatRatio(pr.maxFlux, true) > o.heatLimit * 0.92) hi = mid; else lo = mid;
    }
    st.plan = { flux, speed: lo };
  };
  /** Where a burn against the fall at `throttle`, started now, would stop: metres above the ground, or −1 if it would not. */
  const stopAlt = throttle => {
    const { thrust, ve } = v.enginePower();
    const pb = predictFall(body, v.pos, v.vel, v.mass, world.ut, { area: v.axialDragArea(true), floor: cg(), thrust, ve, throttle, dryMass: v.mass * 0.3, maxT: 120 });
    st.stop = pb;
    return pb.stopped ? pb.alt - cg() : -1;
  };
  c.update = () => {
    if (c.done) return;
    if (v.dead) return c.finish(false, 'booster lost');
    const ut = world.ut;
    up.copy(v.pos).normalize();
    // the target now, and the level offset to it
    const R = v.pos.length();
    body.surfaceDirToInertial(o.target, ut, tgt).normalize();
    e.copy(tgt).multiplyScalar(R).sub(v.pos); e.addScaledVector(up, -e.dot(up));
    if (v.landed) {
      v.ctrl.throttle = 0; hold('hold');
      if (!st.far) c.miss = e.length(); else c.miss = groundDistance(body, body.inertialToSurfaceDir(up, ut, _t), o.target);
      c.result = { miss: c.miss, ut, fuel: v.estimateDeltaV(), splashed: !!v.splashed };
      const far = c.miss >= 1000 ? (c.miss / 1000).toFixed(1) + ' km' : c.miss.toFixed(0) + ' m';
      if (v.splashed) return c.finish(false, `down in the sea, ${far} from the target`);
      return c.finish(true, `touchdown ${far} from the target`);
    }
    if (v.grounded && c.phase === 'final') {
      v.ctrl.throttle = 0; hold('hold');
      if (ax.set(0, 1, 0).applyQuaternion(v.q).angleTo(up) > 1) { st.down = (st.down || 0) + 1; if (st.down > 100) { c.miss = e.length(); return c.finish(false, 'the stage fell over on landing'); } }
      return;
    }
    srf.set(v.vel.x - wy * v.pos.z, v.vel.y, v.vel.z + wy * v.pos.x);
    const speed = srf.length(), vs = srf.dot(up);
    const power = v.enginePower();
    if (!(power.thrust > 0) && c.phase !== 'coast' && c.phase !== 'init') {
      if (c.phase === 'final' || c.phase === 'landing') { v.ctrl.throttle = 0; hold('srfRetrograde'); if (!st.dry) { st.dry = true; c.note('out of propellant'); } return; }
    }
    // the legs stay folded until just before touchdown
    if (!st.legs && (c.phase === 'landing' || c.phase === 'final') && v.radarAlt < o.legAlt) {
      st.legs = true;
      if (v.legParts.length && !v.legsDown) { v.setLegs(true); c.note(`landing legs down at ${v.radarAlt.toFixed(0)} m`); }
    }
    const acc = power.thrust / v.mass;
    switch (c.phase) {
      case 'init':
        v.setLegs(false);
        if (!(power.thrust > 0)) return c.finish(false, 'no engine to fly back on');
        st.dry0 = v.mass - propellant();
        planEntry();
        predict();
        st.dir0 = miss.clone().normalize();
        // opts.aimShort (m, off by default) holds the aim that far short of the target, on the side the stage comes
        // in from, until it is opts.aimSwitch metres up; the fins then walk it the rest of the way. (Leaning the
        // engine during the landing burn does not move the stage here: the swivelled bell and the fins that hold
        // the lean push the other way about as hard. So the last correction is flown on the air, before the burn.)
        if (o.aimShort > 0 && c.miss > 2000) {
          body.inertialToSurfaceDir(_s.copy(st.dir0), world.ut + c.prediction.t, _s);
          st.aim = o.target.clone().normalize().addScaledVector(_s, -o.aimShort / body.radius).normalize();
        }
        // taken over part of the way down (or handed back by the pilot): pick the flight up where it is
        if (c.miss < 300 || (vs < 0 && v.radarAlt < 15000)) { c.phase = 'coast'; c.note(`taking over at ${(v.altitude / 1000).toFixed(1)} km, ${c.miss.toFixed(0)} m from the aim point`); break; }
        c.phase = 'flip'; c.note(`flip: the stage would come down ${(c.miss / 1000).toFixed(1)} km from the target`);
        break;
      case 'flip': {
        if (ut - st.tPred >= o.period) predict();
        dir.copy(miss).addScaledVector(up, -miss.dot(up)).normalize();
        point(dir);
        const err = noseError(dir);
        // a whisper of thrust once it is more than half way round lets the engine bell help the turn
        v.ctrl.throttle = err < 1.2 && err > 0.25 ? 0.05 : 0;
        if (err <= 0.25) { c.phase = 'boostback'; c.note(`boostback burn at ${(v.altitude / 1000).toFixed(1)} km`); }
        break;
      }
      case 'boostback': {
        if (ut - st.tPlan >= 1) planEntry();
        if (ut - st.tPred >= Math.min(o.period, 0.1)) predict();
        const pr = c.prediction;
        // keep what the landing burn needs: the speed it will arrive with, plus gravity while it burns
        const reserve = o.reserve ?? pr.speed * 1.3 + 150;
        if (v.estimateDeltaV() < reserve) {
          v.ctrl.throttle = 0; c.phase = 'coast'; st.short = true;
          c.note(`cannot reach the target on this propellant: boostback stopped ${(c.miss / 1000).toFixed(1)} km short, landing where it comes down`);
          break;
        }
        dir.copy(miss).addScaledVector(up, -miss.dot(up));
        const m = dir.length();
        dir.normalize();
        // done when the impact point reaches the target, or has passed it
        if (m < o.tolerance || (m < 3000 && dir.dot(st.dir0) < 0) || (m > st.best + 200 && st.best < 2000)) {
          v.ctrl.throttle = 0; c.phase = 'coast';
          c.note(`boostback complete: predicted ${m.toFixed(0)} m from the target, ${(pr.t).toFixed(0)} s to the ground`);
          break;
        }
        if (m < st.best) st.best = m;
        if (!(power.thrust > 0)) { v.ctrl.throttle = 0; c.phase = 'coast'; c.note(`out of propellant in the boostback, ${(m / 1000).toFixed(1)} km short`); break; }
        point(dir);
        const err = noseError(dir);
        // each second of burn moves the impact point about acc · (time left to fall)
        const want = m / Math.max(1, acc * pr.t * 1.2);
        v.ctrl.throttle = err < 0.3 ? clamp(want, 0.02, 1) : 0.05;
        break;
      }
      case 'coast': {
        v.ctrl.throttle = 0;
        // In thick air a stage leaning a few degrees off its fall is carried sideways by its own body, away from the
        // lean (measured: about 0.3 m of ground per metre of height left, per radian). Lean it to walk the impact
        // point onto the target.
        if (st.aim && vs < 0 && v.radarAlt < o.aimSwitch) { st.aim = null; predict(); }
        const qNow = 0.5 * body.density(v.altitude) * speed * speed;
        if (vs < 0 && qNow > 400 && !st.short && c.miss < 20000) {
          const lean = clamp(1.5 * c.miss / (0.3 * v.radarAlt + 100), 0, o.maxLean);
          dir.copy(srf).normalize().negate();
          _t.copy(miss).addScaledVector(up, -miss.dot(up));
          if (_t.lengthSq() > 1e-6) dir.addScaledVector(_t.normalize(), -Math.tan(lean)).normalize();
          point(dir);
        } else hold('srfRetrograde');
        const low = v.radarAlt < 30000 && vs < 0;
        if (!st.entryDone && ut - st.tPlan >= 2) planEntry();
        if (ut - st.tPred >= (low ? 0.5 : o.period * 4)) predict();
        if (!st.entrySaid && vs < 0) {
          st.entrySaid = true;
          c.note(st.plan ? `entry burn needed: predicted skin temperature ${(st.heat * 100).toFixed(0)} % of the limit` : `no entry burn needed: predicted skin temperature ${(st.heat * 100).toFixed(0)} % of the limit`);
        }
        if (st.plan && !st.entryDone && vs < 0 && power.thrust > 0) {
          const flux = TUNING.HEAT_FLUX_K * Math.sqrt(body.density(v.altitude)) * speed * speed * speed;
          if (flux >= st.plan.flux) {
            if (speed > st.plan.speed) { c.phase = 'entry'; c.note(`entry burn at ${(v.altitude / 1000).toFixed(1)} km, ${speed.toFixed(0)} m/s`); break; }
            st.entryDone = true;
          }
        }
        if (vs < 0 && v.radarAlt < 25000 && power.thrust > 0) {
          const h = stopAlt(clamp(o.landingAccel / acc, 0.1, 0.85));
          // light when the stop point comes down to the hover height (or the burn can no longer stop it at all)
          if (h < o.stopAlt + Math.max(2, speed * 0.05)) {
            c.phase = 'landing';
            c.note(`landing burn at ${v.radarAlt.toFixed(0)} m, ${speed.toFixed(0)} m/s`);
          }
        }
        break;
      }
      case 'entry': {
        hold('srfRetrograde');
        const err = noseError(_t.copy(srf).normalize().negate());
        v.ctrl.throttle = err < 0.3 ? 1 : 0;
        if (speed <= st.plan.speed || !(power.thrust > 0)) {
          v.ctrl.throttle = 0; st.entryDone = true; c.phase = 'coast'; predict();
          c.note(`entry burn complete at ${speed.toFixed(0)} m/s, predicted ${c.miss.toFixed(0)} m from the target`);
        }
        break;
      }
      case 'landing': {
        // throttle: the setting whose stop point is the hover height
        let need;
        if (stopAlt(1) < o.stopAlt) need = 1;
        else {
          let lo = 0.1, hi = 1;
          if (stopAlt(lo) > o.stopAlt) need = lo;
          else { for (let i = 0; i < 6; i++) { const mid = 0.5 * (lo + hi); const h = stopAlt(mid); if (h > o.stopAlt || h < 0 && false) hi = mid; else lo = mid; } need = 0.5 * (lo + hi); }
        }
        // steer: against the fall
        // (as the speed runs out "against the fall" loses its meaning: blend to straight up)
        dir.copy(srf).negate();
        if (speed < 80) dir.addScaledVector(up, 15).addScaledVector(_t.copy(srf).addScaledVector(up, -vs), -1.5);   // and kill the drift
        dir.normalize();
        point(dir);
        const err = noseError(dir);
        v.ctrl.throttle = err < 0.5 ? clamp(need, 0.05, 1) : 0.05;
        if (speed < 10 || v.radarAlt < o.stopAlt * 0.5) { c.phase = 'final'; c.note(`final descent from ${v.radarAlt.toFixed(0)} m, ${e.length().toFixed(0)} m from the target`); }
        break;
      }
      case 'final': {
        const g = body.gm / (R * R);
        drift.copy(srf).addScaledVector(up, -vs);
        let off = e.length();
        if (st.far === undefined) {
          st.far = off > o.reach;
          if (st.far && st.short) st.home = body.inertialToSurfaceDir(up, ut, new Vector3()).normalize();
          else if (st.far) { st.home = body.inertialToSurfaceDir(up, ut, new Vector3()).normalize(); c.note(`the target is ${off.toFixed(0)} m away, out of reach: landing here`); }
        }
        if (st.far) {      // land where it is: hold this spot instead
          body.surfaceDirToInertial(st.home, ut, _t).normalize().multiplyScalar(R).sub(v.pos); _t.addScaledVector(up, -_t.dot(up));
          c.miss = off; e.copy(_t); off = e.length();
        } else c.miss = off;
        // Fly towards the target at a speed that shrinks with the distance left. Wait at twelve metres until the
        // sideways drift is gone and the stage is over the spot, then stand it upright and come straight down: a tall
        // stage that touches down still sliding trips over its own legs.
        const hgt = v.radarAlt, tiltNow = noseError(up);
        const vWant = hgt < 6 ? 0 : Math.min(5, off * 0.25, Math.sqrt(1.2 * off));     // (never faster than it can stop from)
        if (off > 1e-3) _s.copy(e).normalize().multiplyScalar(vWant).sub(drift); else _s.copy(drift).negate();
        const settled = drift.length() < 0.4 && (off < 3 || hgt < 6);
        let vsT = -clamp((hgt - 1) / 3, o.touchdownSpeed, 8);
        if (!st.committed) {
          if (v.estimateDeltaV() < 45) st.committed = true;                     // nothing left to wait on
          else if (settled && hgt < 14 && tiltNow < 0.05) st.committed = true;
          else if (hgt < 14) vsT = clamp((12 - hgt) * 0.4, -1.5, 1.5);
        }
        const leanMax = st.committed ? 0.015 : hgt < 16 ? 0.14 : 0.25;
        const lean = Math.min(leanMax, 0.07 * _s.length());
        dir.copy(up);
        if (_s.lengthSq() > 1e-6) dir.addScaledVector(_s.normalize(), Math.tan(lean));
        point(dir);
        v.ctrl.throttle = acc > 0 ? clamp((g + (vsT - vs) * 2.5) / (acc * Math.max(0.5, Math.cos(lean))), 0, 1) : 0;
        break;
      }
      default: break;
    }
  };
  return c;
}

/**
 * The stage the next staging event would drop, if it is one built to come back: it carries a guidance part, a
 * liquid engine that is burning, and landing legs or two catch pins. → { ids (Set of part ids), dry (kg without propellant),
 * prop (kg of propellant in it now) } or null.
 */
export function recoverableStage(vessel) {
  const v = vessel;
  const firing = v.stages[v.stageIndex] || [];
  const ids = v.dropSet(firing);
  if (!ids.size) return null;
  let core = false, engine = false, legs = false, pins = 0, dry = 0, prop = 0;
  for (const id of ids) {
    const p = v.parts.get(id), d = p.def;
    if (d.shape === 'decoupler' && firing.includes(id)) continue;      // the separator ring leaves as a third piece: not the stage's to carry home
    if (d.command) core = true;
    if (d.legs) legs = true;
    if (d.catchPin) pins++;
    if (d.engine && d.engine.type === 'liquid' && p.ignited && !p.flameout) engine = true;
    const fuel = (p.res.fuel || 0) + (p.res.ox || 0) + (p.res.lox || 0) + (p.res.ch4 || 0);
    prop += fuel;
    dry += (p.mass || d.mass * 1000) - fuel - (p.res.mono || 0) - (p.res.solid || 0);
  }
  return core && engine && (legs || pins >= 2) ? { ids, dry, prop, legs, pins } : null;
}

/**
 * Propellant (kg) a recoverable first stage must still hold at separation to fly back to `target` (a body-fixed
 * direction) and land, from where the rocket is now: the boostback has to cancel the sideways speed and cover the
 * ground back in the time the stage takes to fall, and the landing burn has to stop a stage falling at its terminal
 * speed. A deliberately simple estimate with a margin: the boostback itself is closed-loop and uses what it needs.
 * → { kg, have, dv, stage } or null when the next stage to drop is not built to come back.
 */
export function returnReserve(world, vessel, target, opts = {}) {
  const v = vessel, body = v.body;
  const stage = recoverableStage(v);
  if (!stage) return null;
  const o = { landing: 650, margin: 1.25, flip: 15, ...opts };
  const wy = TAU / body.rotPeriod, R = v.pos.length();
  _p.copy(v.pos).normalize();                                                    // up
  _q.set(v.vel.x - wy * v.pos.z, v.vel.y, v.vel.z + wy * v.pos.x);              // air-relative velocity
  const vs = _q.dot(_p);
  _q.addScaledVector(_p, -vs);                                                   // its level part
  const g = body.gm / (R * R), h = Math.max(0, v.altitude);
  const tf = Math.max(20, (vs + Math.sqrt(vs * vs + 2 * g * h)) / g);            // time to fall back, no air
  body.surfaceDirToInertial(target, world.ut, _r).normalize().multiplyScalar(R).sub(v.pos);
  _r.addScaledVector(_p, -_r.dot(_p));                                           // level offset to the target
  _r.addScaledVector(_q, -o.flip);                                               // (it flies on while it turns round)
  _r.multiplyScalar(1 / tf).sub(_q);                                             // velocity change the boostback makes
  const dv = _r.length() * o.margin + o.landing;
  const ve = v.enginePower().ve || 2900;
  return { kg: stage.dry * (Math.exp(dv / ve) - 1), have: stage.prop, dv, stage };
}

void G0;
