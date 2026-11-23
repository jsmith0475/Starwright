// Starwright: the catch tower (docs/SHEARWATER.md). A stage or ship with two catch pins and no legs does not land:
// it comes down between the tower's two arms, and the arms take it by the pins.
//
// What the physics does. The arms are not solid bodies. While a vessel with catch pins is flying, the tower watches
// it; when its base comes down to the height at which it hangs (TOWER.hang above the launch mount), inside the arms'
// reach, slow, upright and steady enough, the arms have it: the vessel is pinned where it is (`landed`, with
// `surface.held = 'tower'`), stood upright over a moment, and stays until its engines lift it off again. Too fast,
// too far over or too far off the mount and the arms cannot take it: a `catchMissed` event says why, and the vessel
// goes on down to the mount under the ordinary ground contact, which it does not survive.
// The arms close on whatever comes down, wherever it is within their reach, so the limits below are the whole of the
// model: there is no arm to hit on the way in and none to hit on the way out.
//
//   TOWER                         the numbers (also drawn from: js/render/tower.js)
//   catchPins(vessel)             how many catch pins it carries
//   towerSite(body)               the tower's site record, or null
//   catchState(world, vessel)     { clearance, offset, tilt, vs, drift, rate } of a vessel near the tower, or null
//   stepTower(world, ev)          called by the world after every physics sub-step
//   armsClosed(world)             0 open … 1 closed: for the drawing (the arms close as a vessel comes down to them)
import { Vector3, Quaternion } from '../lib/three.module.min.js';
import { TOWER } from './bodies.js';
import { surfaceAt } from './vessel.js';

export { TOWER };
const _u = new Vector3(), _a = new Vector3(), _b = new Vector3(), _d = new Vector3(), _ax = new Vector3();
const _q = new Quaternion(), _qi = new Quaternion();
const Y_AXIS = new Vector3(0, 1, 0), TAU = Math.PI * 2;

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
  v.landed = true; v.splashed = false;
  v.surface = { dir, qRel, h: R - body.radius, qTarget: qUp, fixed: true, held: 'tower' };
  v.w.set(0, 0, 0);
  v.grounded = false; v._sleepT = 0; v._wake = false; v._nearGround = false; v._catchSeen = false;
  v.ctrl.throttle = 0;
  v.syncLanded(ut);
  ev.push({ type: 'caught', vessel: v, site: 'tower', speed: Math.hypot(s.vs, s.drift), offset: s.offset, tilt: s.tilt, clearance: s.clearance });
}

/** 0 (open) … 1 (closed): closed round a held vessel, closing as one with pins comes down through the last 150 m. */
export function armsClosed(world) {
  let k = 0;
  for (const v of world.vessels) {
    if (v.dead) continue;
    if (v.landed) { if (v.surface && v.surface.held === 'tower') return 1; continue; }
    if (v._pinCount >= 2 && v._catchSeen) { const s = catchState(world, v, _st); if (s && s.offset < 60) k = Math.max(k, 1 - Math.min(1, Math.max(0, (s.clearance - TOWER.hang - 5) / 150))); }
  }
  return k;
}
