// Starwright: the catch tower (docs/SHEARWATER.md). A stage or ship with two catch pins and no legs does not land:
// it comes down between the tower's two arms, and the arms take it by the pins.
//
// What the physics does. The arms are not solid bodies. While a vessel with catch pins is flying, the tower watches
// it; when its base comes down to the height at which it hangs (TOWER.hang above the launch mount), inside the arms'
// reach, slow, upright and steady enough, the arms have it: the vessel is pinned where it is (`landed`, with
// `surface.held = 'tower'`), stood upright over a moment, and stays until its engines lift it off again. Too fast,
// too far over or too far off the mount and the arms cannot take it: a `catchMissed` event says why, and the vessel
// goes on down to the mount under the ordinary ground contact, which it does not survive.
// The arms close on whatever comes down within their reach, and only then: a stage hovering farther off finds them
// open. The tower's column and its two arms are solid steel (strikeTower): a part that touches them is stopped
// against them, broken off if it meets them faster than it can take, and the whole vessel is lost faster than that.
// The arms in the physics and in the drawing are the same arms: armState glides them and armPose places them, and
// js/render/tower.js draws what those two say.
//
//   TOWER                         the numbers (also drawn from: js/render/tower.js)
//   catchPins(vessel)             how many catch pins it carries
//   towerSite(body)               the tower's site record, or null
//   catchState(world, vessel)     { clearance, offset, tilt, vs, drift, rate } of a vessel near the tower, or null
//   stepTower(world, ev)          called by the world after every physics sub-step
//   armsClosed(world)             0 open … 1 closed: where the arms are heading (they close as a vessel comes down to them)
//   ARM, COLUMN                   the steel: the arms' size and hinges, the column's footprint (metres, the mount's frame)
//   armPose(k, height, dx, dz)    → { y, arms: [{ s, hx, hz, ux, uz }] }: carriage level, hinge and direction of each arm
//   armState(world)               the arms as they stand now (glided), { k, h, x, z }; stepped with the world
//   strikeTower(world, v, ev)     stops, breaks or destroys a vessel that touches the column or the arms
import { Vector3, Quaternion } from '../lib/three.module.min.js';
import { TOWER } from './bodies.js';
import { surfaceAt, TUNING } from './vessel.js';

export { TOWER };
const _u = new Vector3(), _a = new Vector3(), _b = new Vector3(), _d = new Vector3(), _ax = new Vector3();
const _q = new Quaternion(), _qi = new Quaternion();
const Y_AXIS = new Vector3(0, 1, 0), TAU = Math.PI * 2;

// The tower's frame ("the mount's frame"): origin on the launch mount's axis at ground level, +x east, +y up, +z
// south. The column stands 11 m west of the mount, 7.5 m square, 91 m tall (js/render/tower.js draws the same).
export const COLUMN = { x0: -TOWER.offset - 3.75, x1: -TOWER.offset + 3.75, z: 3.75, top: TOWER.height };
// The arms: 22 m long, 1.6 m wide, 3.3 m deep at the root and 1.4 m at the tip, hinged on the carriage that rides the
// column's east face. Open, they stand 50° out from the line through the mount; closed, each one's inner side passes
// `gap` north or south of the axis of the stage they hold. Their deck is `pin` + 0.14 m under the carriage level,
// which is where the pins rest.
export const ARM = { length: 22, half: 0.8, gap: 3.1, open: 50 * Math.PI / 180, park: 45, pin: 0.135, d0: 3.3, d1: 1.4,
  hx: -TOWER.offset + 3.75 + 0.95, hz: 3.1 + 0.8 };

/** Where the arms are: k 0 open … 1 closed round a stage whose axis is (dx, dz) east and south of the mount's
 *  (held to the arms' reach), the carriage at `height` above the ground. → { y, arms: [{ s, hx, hz, ux, uz }] }:
 *  for each arm (s = 1 south, −1 north) its hinge and the level direction it points along. */
export function armPose(k = 0, height = ARM.park, dx = 0, dz = 0, out = { y: 0, arms: [{ s: 1 }, { s: -1 }] }) {
  k = Math.min(1, Math.max(0, +k || 0)); const e = k * k * (3 - 2 * k);
  out.y = Math.min(TOWER.height - 8, Math.max(9, Number.isFinite(height) ? height : ARM.park));
  dx = +dx || 0; dz = +dz || 0;
  const off = Math.hypot(dx, dz); if (off > TOWER.reach) { dx *= TOWER.reach / off; dz *= TOWER.reach / off; }
  for (const a of out.arms) {
    const s = a.s, run = dx - ARM.hx;
    let t = dz / run; for (let i = 0; i < 2; i++) t = (dz + s * ARM.half * (Math.sqrt(1 + t * t) - 1)) / run;
    const closed = s * Math.min(0.36, Math.max(-0.36, Math.atan(t)));
    const ang = ARM.open + (closed - ARM.open) * e;
    a.hx = ARM.hx; a.hz = s * ARM.hz; a.ux = Math.cos(ang); a.uz = s * Math.sin(ang); a.yaw = -s * ang;
  }
  return out;
}

export function catchPins(v) { let n = 0; for (const p of v.partList) if (p.def.catchPin) n++; return n; }
export function towerSite(body) { return body && body.sites && body.sites.tower ? body.sites.tower : null; }

/** Where a vessel is relative to the tower's catch point. Null when it is another world's, landed, or far away. */
export function catchState(world, v, out = {}) {
  const body = v.body, site = towerSite(body);
  if (!site || v.dead || v.landed || v.type === 'eva') return null;
  const R = v.pos.length(), ut = world.ut;
  _u.copy(v.pos).multiplyScalar(1 / R);
  body.surfaceDirToInertial(site.dir, ut, _a).normalize();
  const cosA = _u.dot(_a);
  if (cosA < site.cosNear) return null;
  const ground = site.ground ?? (site.ground = surfaceAt(body, site.dir));
  _qi.copy(v.q).invert();
  const low = v._lowest(_b.copy(_u).applyQuaternion(_qi)).h;
  out.clearance = R - body.radius - ground + low - TOWER.mount;
  _d.copy(_a).multiplyScalar(R).sub(v.pos); _d.addScaledVector(_u, -_d.dot(_u));
  out.offset = _d.length();
  _ax.set(0, 1, 0).applyQuaternion(v.q);
  out.tilt = Math.acos(Math.min(1, Math.max(-1, _ax.dot(_u))));
  const wy = TAU / body.rotPeriod;
  _d.set(v.vel.x - wy * v.pos.z, v.vel.y, v.vel.z + wy * v.pos.x);
  out.vs = _d.dot(_u);
  out.drift = _d.addScaledVector(_u, -out.vs).length();
  out.rate = v.w.length();
  return out;
}

const _st = {};
/** Why the arms cannot take a vessel in this state, or '' when they can. */
export function catchFault(s) {
  if (s.offset > TOWER.reach) return `${s.offset.toFixed(1)} m from the mount, and the arms reach ${TOWER.reach} m`;
  if (-s.vs > TOWER.maxSink) return `coming down at ${(-s.vs).toFixed(1)} m/s, and the arms take ${TOWER.maxSink} m/s`;
  if (s.drift > TOWER.maxDrift) return `sliding sideways at ${s.drift.toFixed(1)} m/s`;
  if (s.tilt > TOWER.maxTilt) return `leaning ${(s.tilt * 180 / Math.PI).toFixed(0)}°`;
  if (s.rate > TOWER.maxRate) return 'still swinging';
  return '';
}

export function stepTower(world, ev) {
  const loaded = world._loaded || world.vessels;
  if (!loaded.some(v => !v.dead && towerSite(v.body))) return;
  const arms = stepArms(world), pose = armPose(arms.k, arms.h, arms.x, arms.z, _pose);
  for (let i = 0; i < loaded.length; i++) { const v = loaded[i]; if (!v.dead && !v.landed && v.type !== 'eva') strikeTower(world, v, ev, pose); }
  for (let i = 0; i < loaded.length; i++) {
    const v = loaded[i];
    if (v.dead || v.landed || v._pinCount === 0) continue;
    if (v._pinStamp !== v.partList.length) { v._pinStamp = v.partList.length; v._pinCount = catchPins(v); if (!v._pinCount) continue; }
    if (v._pinCount < 2 || (v.legParts && v.legParts.length)) continue;
    const s = catchState(world, v, _st);
    if (!s) { v._catchSeen = false; continue; }
    // above the arms: nothing yet. Going up (a lift-off from the mount): nothing either.
    if (s.clearance > TOWER.hang + TOWER.window) { v._catchSeen = s.vs < 0; v._catchMissed = false; continue; }
    if (!v._catchSeen || v._catchMissed || s.clearance < TOWER.hang - 2) continue;
    const fault = catchFault(s);
    if (fault) { v._catchMissed = true; ev.push({ type: 'catchMissed', vessel: v, site: 'tower', reason: fault, ...s }); continue; }
    hold(world, v, s, ev);
  }
}

function hold(world, v, s, ev) {
  const body = v.body, ut = world.ut, R = v.pos.length();
  const dir = new Vector3();
  body.inertialToSurfaceDir(_a.copy(v.pos).multiplyScalar(1 / R), ut, dir);
  _q.setFromAxisAngle(Y_AXIS, -body.rotationAngle(ut));
  const qRel = _q.clone().multiply(v.q).normalize();
  // upright, keeping its heading: the shortest turn that brings its axis onto the vertical
  _ax.set(0, 1, 0).applyQuaternion(qRel);
  const qUp = new Quaternion().setFromUnitVectors(_ax, _b.copy(dir).normalize()).multiply(qRel).normalize();
  // and turned, the shorter way round, until the line through its pins lies north to south: the two rails run east
  // to west, one each side of the stage, and that is the only heading at which a pin sits on each
  const pins = v.partList.filter(p => p.def.catchPin);
  if (pins.length >= 2) {
    _d.copy(pins[0].pos).sub(pins[1].pos); _d.y = 0;
    if (_d.lengthSq() > 1e-6) {
      const up = _b.copy(dir).normalize();
      _d.applyQuaternion(qUp); _d.addScaledVector(up, -_d.dot(up)).normalize();
      const north = new Vector3(0, 1, 0).addScaledVector(up, -up.y);
      if (north.lengthSq() > 1e-9) {
        north.normalize();
        let ang = Math.atan2(_ax.crossVectors(_d, north).dot(up), _d.dot(north));
        if (ang > Math.PI / 2) ang -= Math.PI; else if (ang < -Math.PI / 2) ang += Math.PI;
        qUp.premultiply(_q.setFromAxisAngle(up, ang)).normalize();
      }
    }
  }
  v.landed = true; v.splashed = false;
  v.surface = { dir, qRel, h: R - body.radius, qTarget: qUp, fixed: true, held: 'tower' };
  v.w.set(0, 0, 0);
  v.grounded = false; v._sleepT = 0; v._wake = false; v._nearGround = false; v._catchSeen = false;
  v.ctrl.throttle = 0;
  v.syncLanded(ut);
  ev.push({ type: 'caught', vessel: v, site: 'tower', speed: Math.hypot(s.vs, s.drift), offset: s.offset, tilt: s.tilt, clearance: s.clearance });
}

/** How far closed the arms should be for a stage in state `s`: they start to close 150 m up and are shut 5 m above the
 *  catch, but only while it is over the mount. A stage hovering more than its reach off finds them open (the
 *  operators wait for it), so that a closing arm does not swing into a stage that has drifted out of line. */
function closing(s) {
  const byHeight = 1 - Math.min(1, Math.max(0, (s.clearance - TOWER.hang - 5) / 150));
  const byPlace = s.clearance > 40 ? 1 : Math.min(1, Math.max(0, (TOWER.reach + 2.5 - s.offset) / 2.5));
  return byHeight * byPlace;
}

/** 0 (open) … 1 (closed): closed round a held vessel, closing as one with pins comes down through the last 150 m. */
export function armsClosed(world) {
  let k = 0;
  for (const v of world.vessels) {
    if (v.dead) continue;
    if (v.landed) { if (v.surface && v.surface.held === 'tower') return 1; continue; }
    if (v._pinCount >= 2 && v._catchSeen) { const s = catchState(world, v, _st); if (s && s.offset < 60) k = Math.max(k, closing(s)); }
  }
  return k;
}

const _e = new Vector3(), _s = new Vector3(), _cl = { vessel: null, k: 0, pinH: 0, hang: 0, east: 0, south: 0 };
/** For the drawing: what the arms are busy with. The vessel they hold, else the one they are closing on (the one
 *  armsClosed answers for), or null. → { vessel, k (0 open … 1 closed), pinH (its pins above its base, m), hang
 *  (its base above the ground where the arms have it or will take it, m), east, south (its axis from the mount's, m) }. The same object every call. */
export function towerClient(world, out = _cl) {
  let best = null, k = 0;
  for (const v of world.vessels) {
    if (v.dead) continue;
    if (v.landed) { if (v.surface && v.surface.held === 'tower') { best = v; k = 1; break; } continue; }
    if (v._pinCount >= 2 && v._catchSeen) { const s = catchState(world, v, _st); if (s && s.offset < 60) { const kv = closing(s); if (!best || kv > k) { best = v; k = kv; } } }
  }
  if (!best) return null;
  const site = towerSite(best.body), R = best.pos.length();
  let y = 0, n = 0;
  for (const p of best.partList) if (p.def.catchPin) { y += p.pos.y; n++; }
  best.body.surfaceDirToInertial(site.dir, world.ut, _a).normalize();
  _e.crossVectors(Y_AXIS, _a).normalize(); _s.crossVectors(_e, _a);
  _d.copy(best.pos).addScaledVector(_a, -R);
  const low = best._lowest(Y_AXIS).h;
  out.vessel = best; out.k = k; out.pinH = n ? y / n - best.com.y - low : 0;
  out.hang = best.landed ? R - best.body.radius - (site.ground ?? 0) + low : TOWER.mount + TOWER.hang;
  out.east = _d.dot(_e); out.south = _d.dot(_s);
  return out;
}

// ---------------------------------------------------------------------------------------------
// The arms as they stand, and the steel a vessel can hit
// ---------------------------------------------------------------------------------------------
/** The arms as they stand now: they glide after what towerClient asks for (closing at about 2.5 /s, the carriage
 *  following the pins at 6 /s and no faster than 4 m/s), and park open at 45 m when nothing is there. Stepped by
 *  stepTower; the drawing shows exactly this. → { k, h, x, z } (the same object, kept on the world). */
export function armState(world) { return world._towerArms || (world._towerArms = { k: 0, h: ARM.park, x: 0, z: 0, ut: world.ut }); }
function stepArms(world) {
  const a = armState(world), dt = Math.min(0.1, Math.max(0, world.ut - a.ut)); a.ut = world.ut;
  if (!(dt > 0)) return a;
  const c = towerClient(world);
  let k = c ? c.k : 0;
  const h = c ? c.pinH + c.hang : ARM.park;
  if (k > 0 && c.vessel && !c.vessel.landed && armsBlocked(world, c.vessel, armPose(1, h, c.east, c.south, _poseT))) k = 0;
  const f = 1 - Math.exp(-dt * 2.5), f2 = c ? 1 - Math.exp(-dt * 6) : f;
  a.k += (k - a.k) * f;
  a.h += Math.min(4 * dt, Math.max(-4 * dt, (h - a.h) * f2));
  a.x += ((c ? c.east : 0) - a.x) * f2; a.z += ((c ? c.south : 0) - a.z) * f2;
  return a;
}

const _m = new Vector3(), _o = new Vector3(), _pe = new Vector3(), _ps = new Vector3(), _w = new Vector3(), _n = new Vector3(), _sv = new Vector3();
const _pose = { y: 0, arms: [{ s: 1 }, { s: -1 }] }, _poseT = { y: 0, arms: [{ s: 1 }, { s: -1 }] }, _st2 = {};
/** Distance (m) from a point (x, y, z in the mount's frame) to the steel, with the outward direction there left in
 *  `_n` (mount's frame). */
function steelDistance(x, y, z, pose, arms = true) {
  // the column: a box
  const cx = Math.max(COLUMN.x0, Math.min(COLUMN.x1, x)), cy = Math.max(0, Math.min(COLUMN.top, y)), cz = Math.max(-COLUMN.z, Math.min(COLUMN.z, z));
  const dx = x - cx, dy = y - cy, dz = z - cz, d = Math.hypot(dx, dy, dz);
  _m.set(d > 1e-9 ? dx / d : 1, d > 1e-9 ? dy / d : 0, d > 1e-9 ? dz / d : 0);
  if (!arms) { _n.copy(_m); return d; }
  const da = armDistance(x, y, z, pose);
  if (d <= da) { _n.copy(_m); return d; }
  return da;
}
/** Distance (m) from a point to the nearer arm (each a box along its direction from the hinge, deepest at the root),
 *  with the outward direction left in `_n`. `tall`: the box runs on up without end (what is over an arm now will
 *  come down through it). */
function armDistance(x, y, z, pose, tall = false) {
  let best = Infinity;
  const top0 = pose.y - ARM.pin - 0.14;
  for (const a of pose.arms) {
    const rx = x - a.hx, rz = z - a.hz;
    const u = rx * a.ux + rz * a.uz, wv = -rx * a.uz + rz * a.ux;
    const cu = Math.max(-0.7, Math.min(ARM.length, u)), cw = Math.max(-ARM.half, Math.min(ARM.half, wv));
    const depth = ARM.d0 + (ARM.d1 - ARM.d0) * Math.max(0, Math.min(1, cu / ARM.length));
    const cy = Math.max(top0 - depth, tall ? y : Math.min(top0 + 0.07, y));
    const du = u - cu, dw = wv - cw, dy = y - cy, d = Math.hypot(du, dw, dy);
    if (d < best) {
      best = d;
      if (d > 1e-9) _n.set((du * a.ux - dw * a.uz) / d, dy / d, (du * a.uz + dw * a.ux) / d); else _n.set(0, 1, 0);
    }
  }
  return best;
}

/** Sets the mount's frame for `body` at `ut` (origin _o on the ground at the mount, _pe east, _a up, _ps south). */
function mountFrame(body, site, ut) {
  body.surfaceDirToInertial(site.dir, ut, _a).normalize();
  const ground = site.ground ?? (site.ground = surfaceAt(body, site.dir));
  _o.copy(_a).multiplyScalar(body.radius + ground);
  _pe.crossVectors(Y_AXIS, _a).normalize(); _ps.crossVectors(_pe, _a);
}
/** Every part of `v` but its catch pins as balls, each handed to fn(part, x, y, z, r) in the mount's frame (set by
 *  mountFrame): a stack part as rings of its own radius every 2 m up its length, a plate on the side (a fin, a flap,
 *  a vane) as balls across its face as thick as it is, anything else as one ball as big as it is. fn returning true
 *  moves on to the next part; eachBall returning true means fn stopped it (fn returned 'stop'). */
function eachBall(v, fn) {
  for (const p of v.partList) {
    const d = p.def;
    if (d.catchPin) continue;
    let r0 = null;
    const ball = (lx, ly, lz, r) => {
      if (r0) return;
      _w.set(lx, ly, lz).sub(v.com).applyQuaternion(v.q).add(v.pos).sub(_o);
      r0 = fn(p, _w.dot(_pe), _w.dot(_a), _w.dot(_ps), r);
    };
    if (p._stack) {
      const n = Math.max(1, Math.ceil(d.h / 2)), rB = p._rB ?? d.rBottom, rT = p._rT ?? d.rTop;
      for (let i = 0; i <= n; i++) {
        const f = i / n, r = p.flip ? rT + (rB - rT) * f : rB + (rT - rB) * f;
        ball(p.pos.x, p.pos.y - d.h / 2 + d.h * f, p.pos.z, Math.max(0.1, r));
      }
    } else if (d.rw && d.t && d.attach) {
      const ox = p._ox ?? Math.cos(p.rot || 0), oz = p._oz ?? -Math.sin(p.rot || 0), r = Math.max(0.15, d.t / 2 + 0.05);
      const ny = Math.max(1, Math.ceil(d.h / 0.8)), nr = Math.max(1, Math.ceil(d.rw / 0.8));
      for (let i = 0; i <= ny; i++) for (let j = 0; j <= nr; j++) {
        const y = (i / ny - 0.5) * Math.max(0, d.h - 2 * r), o = (j / nr - 0.5) * Math.max(0, d.rw - 2 * r);
        ball(p.pos.x + ox * o, p.pos.y + y, p.pos.z + oz * o, r);
      }
    } else ball(p.pos.x, p.pos.y, p.pos.z, Math.max(0.15, 0.5 * Math.max(d.h || 0, d.rw || 0, 2 * (d.r || 0))));
    if (r0 === 'stop') return true;
  }
  return false;
}

/** Whether shut arms in `pose` would close onto, or under, something sticking out of `v` (a flap, a fin, a port: not
 *  its body, which they close round, nor its pins) where it is now (with `margin` m to spare). The operators keep them open
 *  until that has passed below them (the ship's aft flaps hang ten metres under its pins). */
export function armsBlocked(world, v, pose, margin = 0) {
  const site = towerSite(v.body);
  if (!site) return false;
  mountFrame(v.body, site, world.ut);
  _cut.arms = pose.arms; _cut.y = pose.y;
  let pinY = 0, n = 0;
  for (const p of v.partList) if (p.def.catchPin) { pinY += p.pos.y; n++; }
  pinY = n ? pinY / n : Infinity;
  // (what is above the pins stays above the arms)
  return eachBall(v, (p, x, y, z, r) => p._stack || p.pos.y > pinY ? true : armDistance(x, y, z, _cut, true) < r + margin ? 'stop' : false);
}
const _cut = { y: 0, arms: null };

/** A vessel against the tower's steel. Every part is tried as balls (a stack part as rings of its own radius every
 *  2 m up its length, any other part as one ball as big as it is). One that touches is stopped against the steel;
 *  met faster than the part can take (its crash tolerance) it breaks off, and faster than TUNING.CRASH_ALL times that,
 *  the whole vessel is lost. Catch pins are left out (they are made to rest on the arms), and so is a vessel the arms
 *  hold. → true when anything touched. */
export function strikeTower(world, v, ev, pose = null) {
  const body = v.body, site = towerSite(body);
  if (!site || v.dead || v.type === 'eva' || (v.landed && v.surface && v.surface.held === 'tower')) return false;
  if (!pose) { const a = armState(world); pose = armPose(a.k, a.h, a.x, a.z, _pose); }
  const ut = world.ut;
  mountFrame(body, site, ut);
  // quick test: the whole vessel against a cylinder 40 m round the column, as tall as the tower
  _d.copy(v.pos).sub(_o);
  const bound = v._bound || 1, up = _d.dot(_a);
  if (up > TOWER.height + bound + 5 || up < -bound - 5) return false;
  if (Math.hypot(_d.dot(_pe) + TOWER.offset, _d.dot(_ps)) > 40 + bound) return false;
  // the velocity over the ground, in the mount's frame (the tower turns with the ground)
  const wy = TAU / body.rotPeriod;
  _sv.set(v.vel.x - wy * v.pos.z, v.vel.y, v.vel.z + wy * v.pos.x);
  const vx = _sv.dot(_pe), vy = _sv.dot(_a), vz = _sv.dot(_ps);
  // A stage with pins coming down within the arms' reach is what they are built to close round: they guide its body
  // in (the real ones squeeze the stage to centre it), so its body meets only the column; what sticks out of it
  // still meets the arms.
  const cs = catchPins(v) >= 2 ? catchState(world, v, _st2) : null;
  const guided = !!(cs && cs.offset < TOWER.reach + 2.5 && cs.clearance < TOWER.hang + 12);
  let worst = 0, hit = null, depth = 0, nx = 0, ny = 0, nz = 0;
  const broken = [];
  let cur = null, pen = -1, px = 0, py = 0, pz = 0;
  const settle = () => {
    // how fast the part met the steel: its speed into the face it touched
    const p = cur, d = p.def;
    if (pen < 0) return false;
    const into = -(vx * px + vy * py + vz * pz), tol = d.tolerance || 6;
    if (!hit || pen > depth) { hit = hit || p; depth = Math.max(depth, pen); nx = px; ny = py; nz = pz; }
    if (into > tol * TUNING.CRASH_ALL) { worst = 2; hit = p; return true; }
    if (into > tol) { broken.push(p.id); worst = Math.max(worst, 1); }
    return false;
  };
  eachBall(v, (p, x, y, z, r) => {
    if (p !== cur) { if (cur && settle()) return 'stop'; cur = p; pen = -1; }
    const dist = steelDistance(x, y, z, pose, !(guided && p._stack));
    if (dist < r && r - dist > pen) { pen = r - dist; px = _n.x; py = _n.y; pz = _n.z; }
    return false;
  });
  if (cur && worst < 2) settle();
  if (!hit) return false;
  const what = ny > 0.7 ? 'the top of a tower arm' : 'the tower';
  if (worst === 2) {
    ev.push({ type: 'towerStrike', vessel: v, part: hit.def.name, what, lost: true, broken: v.parts.size });
    v.destroyParts([...v.parts.keys()], ev, 'tower');
    return true;
  }
  if (broken.length) {
    ev.push({ type: 'towerStrike', vessel: v, part: hit.def.name, what, lost: false, broken: broken.length });
    v.destroyParts(broken, ev, 'tower');
    if (v.dead) return true;
  }
  // stopped against the steel, and set back out of it
  _n.set(0, 0, 0).addScaledVector(_pe, nx).addScaledVector(_a, ny).addScaledVector(_ps, nz);
  const vin = _sv.dot(_n);
  if (vin < 0) v.vel.addScaledVector(_n, -vin * 1.2);
  v.pos.addScaledVector(_n, Math.min(depth, 0.2));
  if (!broken.length && (!v._towerTouch || ut - v._towerTouch > 2)) ev.push({ type: 'towerStrike', vessel: v, part: hit.def.name, what, lost: false, broken: 0 });
  v._towerTouch = ut;
  return true;
}
