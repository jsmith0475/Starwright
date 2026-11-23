// Starwright world: owns universal time, all vessels, time warp, rails propagation, SOI changes,
// EVA, science records and recovery. PURE SIMULATION - runs under Node.
import { Vector3, Quaternion, Matrix4 } from '../lib/three.module.min.js';
import { SYSTEM } from './bodies.js';
import { Orbit } from './orbit.js';
import { predictPatches, checkSoiTransition, toParentFrame, toChildFrame } from './trajectory.js';
import { Vessel, TUNING, surfaceAt } from './vessel.js';
import { Craft } from './craft.js';
import { stepTower } from './tower.js';
import { situationOf, EXPERIMENTS, experimentAllowed, BIOME_SITUATIONS } from './career.js';

export const WARP_RATES = Object.freeze([1, 2, 3, 4, 5, 10, 50, 100, 1000, 10000, 100000]);
export const PHYSICS_WARP_MAX = 3;          // highest physics-warp index
export const LOAD_RANGE = 2500;             // m: vessels this close to the active one get full physics
export const MAX_SUBSTEPS = 400;            // per World.step call
export const MAX_TRACKED = 4;               // vessels besides the active one that keep full physics at any distance (see World.isTrackable)
export const MAX_DEBRIS = 24;               // loose pieces flown near the active vessel at once (the lightest go first)
export const SCRAP_MASS = 1000;             // kg: debris lighter than this is removed without a message when it falls behind
// Minimum altitude for each rails-warp index, as a fraction of the body radius (never below the atmosphere top,
// or 1.5 % of the radius on airless bodies).
export const RAIL_ALT_FRAC = Object.freeze([0, 0, 0, 0, 0, 0.05, 0.1, 0.2, 0.5, 1, 2]);
const AIRLESS_MIN_FRAC = 0.015;
const ATMO_MARGIN = 5;                      // s before atmosphere entry at which rails warp drops out
const IMPACT_MARGIN = 20;                   // s before surface impact
const NODE_LEAD = 20;                       // s (plus half the burn) before a maneuver node
/** Docking capture rules (see World._dockingStep). */
export const DOCKING = Object.freeze({
  CAPTURE: 0.25,        // m between port faces at which they latch
  ASSIST: 0.6,          // m: inside this the ports pull each other in gently
  MAX_SPEED: 1.5,       // m/s relative speed of the port faces
  MAX_ANGLE: 15,        // degrees between the port axes (measured from exactly nose to nose)
  ASSIST_K: 0.6,        // 1/s²: spring of the capture assist
  ASSIST_C: 1.2,        // 1/s: damping of the capture assist
  REARM: 1.0,           // m: ports that just undocked can latch again once this far apart
  UNDOCK_SPEED: 0.3,    // m/s separation after undocking
});
const COS_DOCK = Math.cos(DOCKING.MAX_ANGLE * Math.PI / 180);
const _pa = new Vector3(), _pb = new Vector3(), _na = new Vector3(), _nb = new Vector3(), _ua = new Vector3(), _ub = new Vector3(), _sa = new Vector3(), _sb = new Vector3();

const _a = new Vector3(), _b = new Vector3(), _c = new Vector3();
const _qInv = new Quaternion();
export const TRANSMIT_EC = 20;              // electric charge spent sending one record home

/** The run of ladder parts `part` belongs to on vessel `v` (same side of the hull): {x, z, min, max} in vessel part coordinates. */
function ladderRun(v, part) {
  let min = part.pos.y - part.def.h / 2, max = part.pos.y + part.def.h / 2;
  for (const p of v.ladderParts) {
    if (p === part || Math.hypot(p.pos.x - part.pos.x, p.pos.z - part.pos.z) > 0.5) continue;
    min = Math.min(min, p.pos.y - p.def.h / 2); max = Math.max(max, p.pos.y + p.def.h / 2);
  }
  return { x: part.pos.x, z: part.pos.z, min, max };
}
const Y_AXIS = new Vector3(0, 1, 0);

/** Lowest altitude (m) at which rails-warp index `i` is allowed around `body`. */
export function railMinAltitude(body, i) {
  // airless worlds: stay clear of the highest ground (rails vessels do not see mountains)
  const base = body.atmo ? body.atmo.height : Math.max(body.radius * AIRLESS_MIN_FRAC, (body.maxElevation || 0) + 500);
  return Math.max(base, body.radius * (RAIL_ALT_FRAC[i] || 0));
}

export class World {
  constructor({ ut = 0 } = {}) {
    this.ut = ut;
    this.vessels = [];
    this.active = null;
    this.warpIndex = 0;
    this.WARP_RATES = WARP_RATES;
    this.warpTarget = null;
    this.flags = [];
    this.commGroundRange = 6e7;   // m: reach of the home tracking station (the UI sets it from career.limitOf('tracking'))
    this.substeps = 0;            // physics sub-steps done by the last step() (diagnostics)
    this._nextId = 1;
    this._listeners = new Map();
    this._ev = [];
    this._loaded = [];
    this._unloaded = [];
    this._limitReason = 'limit';
    this._dvClock = 0;
    this._before = new Set();
    this._tracked = [];           // vessels flown under full physics far from the active one (rebuilt by _classify)
    this.events = { on: (t, f) => this.on(t, f), off: (t, f) => this.off(t, f), emit: (t, d) => this.emit(t, d) };
  }

  // ------------------------------------------------------------------ events
  /** Subscribe; type '*' receives every event as fn(data, type). Returns an unsubscribe function. */
  on(type, fn) {
    let l = this._listeners.get(type);
    if (!l) this._listeners.set(type, l = []);
    l.push(fn);
    return () => this.off(type, fn);
  }
  off(type, fn) {
    const l = this._listeners.get(type);
    if (!l) return;
    const i = l.indexOf(fn);
    if (i >= 0) l.splice(i, 1);
  }
  emit(type, data) {
    const l = this._listeners.get(type);
    if (l) for (const fn of l.slice()) fn(data, type);
    const all = this._listeners.get('*');
    if (all) for (const fn of all.slice()) fn(data, type);
  }
  get rate() { return WARP_RATES[this.warpIndex]; }

  // ------------------------------------------------------------------ launch
  /** Body-fixed attitude with local X→east, Y→up, Z→south at body-fixed direction `dir`. */
  static padFrame(dir, out = new Quaternion()) {
    const up = _a.copy(dir).normalize();
    const east = _b.crossVectors(Y_AXIS, up);
    if (east.lengthSq() < 1e-12) east.set(0, 0, -1);
    east.normalize();
    const south = _c.crossVectors(east, up);
    return out.setFromRotationMatrix(new Matrix4().makeBasis(east, up, south));
  }

  /** Body-fixed attitude of something standing upright at `dir` with its local +Z (a Pip's visor) toward `fwd`
   *  (a body-fixed direction; only its part along the ground counts). Falls back to padFrame when `fwd` is vertical. */
  static facingFrame(dir, fwd, out = new Quaternion()) {
    const up = _a.copy(dir).normalize();
    const f = _b.copy(fwd).addScaledVector(up, -fwd.dot(up));
    if (f.lengthSq() < 1e-12) return World.padFrame(dir, out);
    f.normalize();
    const right = _c.crossVectors(up, f);
    return out.setFromRotationMatrix(new Matrix4().makeBasis(right, up, f));
  }

  /**
   * Body-fixed attitude of a vehicle standing on its wheels at `dir`, pointing along compass `headingDeg`
   * (0 = north, 90 = east): craft +Y → forward, craft +Z → up, craft +X → right.
   */
  static vehicleFrame(dir, headingDeg = 90, out = new Quaternion()) {
    const up = _a.copy(dir).normalize();
    const east = _b.crossVectors(Y_AXIS, up);
    if (east.lengthSq() < 1e-12) east.set(0, 0, -1);
    east.normalize();
    const north = _c.crossVectors(up, east);
    const h = headingDeg * Math.PI / 180;
    const fwd = new Vector3().addScaledVector(north, Math.cos(h)).addScaledVector(east, Math.sin(h));
    const right = new Vector3().crossVectors(fwd, up);
    return out.setFromRotationMatrix(new Matrix4().makeBasis(right, fwd, up));
  }

  /** Launch sites of the home world: {pad, runway} (see SYSTEM.sites), each {dir, name, heading?, length?, width?}. */
  get sites() { return SYSTEM.sites || { pad: SYSTEM.launchSite }; }

  /**
   * Put a craft on a launch site. `site`: 'pad' (default, standing upright) or 'runway' (a craft with at least two
   * wheels stands on them at the runway's start mark (sites.runway.start, 100 m past the threshold), nose down the runway; anything else stands upright there),
   * or a site record `{ dir (body-fixed), heading (deg) }` to stand somewhere else on the home world.
   */
  launch(craft, { crew = [], site = 'pad' } = {}) {
    const v = Vessel.fromCraft(craft, { crew });
    v.id = this._nextId++;
    v.body = SYSTEM.home;
    const sites = this.sites;
    // `site` may also be a site record of its own ({dir, heading?}: e.g. the flight scene's runway anchor)
    const st = (site && typeof site === 'object' && site.dir) ? site : (site === 'tower' && sites.tower) || (site === 'runway' && sites.runway && (sites.runway.start || sites.runway)) || sites.pad || SYSTEM.launchSite;
    const dir = new Vector3(st.dir.x, st.dir.y, st.dir.z).normalize();
    const wheels = v.wheelParts.filter(p => p.deployed).length;
    const vehicle = st !== sites.pad && wheels >= 2;
    v.landed = true; v.splashed = false; v.launched = false;
    v.surface = { dir, qRel: vehicle ? World.vehicleFrame(dir, st.heading ?? 90) : World.padFrame(dir), h: 0, qTarget: null, vehicle };
    v.launchSite = st === sites.pad ? 'pad' : st === sites.tower ? 'tower' : 'runway';
    if (vehicle) v.ctrl.brake = true;                 // parking brake: release it (B) to roll
    v.situation = 'prelaunch';
    v.ctrl.sas = true;
    v.syncLanded(this.ut);
    v.updateTelemetry(this.ut);
    this.vessels.push(v);
    this.active = v;
    this._setWarp(0, 'launch');
    return v;
  }

  /** Put a craft directly into flight (tests, scenarios, cheats): state relative to `body` in the inertial frame. */
  spawn(craft, { crew = [], body = SYSTEM.home, pos, vel, q = null, makeActive = true } = {}) {
    const v = craft instanceof Vessel ? craft : Vessel.fromCraft(craft, { crew });
    v.id = this._nextId++;
    v.body = body;
    v.pos.copy(pos); v.vel.copy(vel);
    if (q) v.q.copy(q);
    v.landed = false; v.splashed = false; v.surface = null; v.launched = true; v.launchUt = this.ut;
    v.onRails = false;
    v.updateTelemetry(this.ut);
    this.vessels.push(v);
    if (makeActive || !this.active) this.active = v;
    return v;
  }

  // ------------------------------------------------------------------ warp
  maxWarpIndex() {
    const a = this.active;
    const top = WARP_RATES.length - 1;
    if (!a || a.dead) return top;
    if (a.wouldThrust()) { this._limitReason = 'thrust'; return PHYSICS_WARP_MAX; }
    // a vessel being flown under full physics somewhere else (a booster on its way down, an upper stage still
    // climbing) cannot be put on rails: fast warp waits for it, or the player lets it go (World.release)
    const held = this.trackedInFlight();
    if (held) { this._limitReason = `${held.name} in flight`; return PHYSICS_WARP_MAX; }
    if (a.landed) return top;
    if (a.grounded) {
      // rolling or sliding on the ground: physics warp only; once it has all but stopped it is parked and may warp
      // (a vehicle that is being asked to drive is not parked, however slowly it is still moving: this is asked every
      // frame by the HUD, and pinning a rover in the first instant of its drive, before its wheels have taken the
      // weight, left it standing for good at 60 frames a second)
      const driving = a._driven > 0 && Math.abs(a.driveInput()) > 0.01;
      // Only a vehicle on its wheels is parked from here. Anything else comes to rest by the vessel's own rule
      // (Vessel._stepFlight: quiet, carried by the ground, its legs done moving, on a footprint and not a knife
      // edge). This question is asked every frame, and pinning a lander the instant it was slower than 0.3 m/s
      // froze it at the bottom of its touchdown, legs closed or feet in the ground, or in the middle of a rock
      // with feet in the air.
      if (a.groundSpeed > 0.3 || driving || !a._onWheels || !a.pinToGround(this.ut)) { this._limitReason = 'moving on the ground'; return PHYSICS_WARP_MAX; }
      return top;
    }
    const body = a.body;
    const alt = a.pos.length() - body.radius;
    if (body.atmo && alt < body.atmo.height) { this._limitReason = 'atmosphere'; return PHYSICS_WARP_MAX; }
    let idx = PHYSICS_WARP_MAX;
    for (let i = PHYSICS_WARP_MAX + 1; i <= top; i++) { if (alt >= railMinAltitude(body, i)) idx = i; else break; }
    // an automatic warp to a set time (a maneuver, a transfer window) is not held back by a low orbit: on rails a
    // closed orbit that stays clear of the air and the ground is exact at any rate
    if (idx < top && this.warpTarget !== null && a.situation === 'orbit' && a.periapsis >= railMinAltitude(body, PHYSICS_WARP_MAX + 1) && Number.isFinite(a.apoapsis)) idx = top;
    if (idx < top) this._limitReason = 'altitude';
    if (a.onRails && a._patch && (a._patch.endType === 'atmo' || a._patch.endType === 'impact')) {
      const margin = a._patch.endType === 'atmo' ? ATMO_MARGIN : IMPACT_MARGIN;
      if (this.ut >= a._patch.tEnd - margin - 1e-6) { this._limitReason = a._patch.endType === 'atmo' ? 'atmosphere' : 'impact'; return PHYSICS_WARP_MAX; }
    }
    return idx;
  }
  /** Ask for a warp index; returns the index actually set. Cancels a running warpTo. */
  setWarp(index) {
    index = Math.max(0, Math.min(WARP_RATES.length - 1, Math.round(index) || 0));
    const max = this.maxWarpIndex();
    const idx = Math.min(index, max);
    this.warpTarget = null;
    if (idx !== this.warpIndex) this._setWarp(idx, 'user');
    if (index > max) this.emit('message', { text: `Time warp limited to ${WARP_RATES[max]}× (${this._limitReason})` });
    return idx;
  }
  _setWarp(idx, reason) {
    if (idx === this.warpIndex) return;
    this.warpIndex = idx;
    this.emit('warp', { index: idx, rate: WARP_RATES[idx], reason });
  }
  /** Auto-warp to a universal time: picks the fastest allowed rate, slows down and stops exactly there. */
  warpTo(ut) {
    if (!(ut > this.ut)) return false;
    this.warpTarget = ut;
    return true;
  }
  cancelWarpTo() { this.warpTarget = null; }

  // ------------------------------------------------------------------ player actions
  /** Fire the next stage of `vessel` (default: the one being flown; a guidance program may stage a tracked vessel). */
  stage(vessel = this.active) {
    const a = vessel;
    if (!a || a.dead || !this.vessels.includes(a)) return [];
    if (this.warpIndex > PHYSICS_WARP_MAX) this._setWarp(0, 'stage');
    if (a.onRails) this._leaveRails(a);
    const before = this._ev.length;
    a.activateNextStage(this._ev);
    const out = this._ev.slice(before);
    this._processEvents();
    return out;
  }
  switchTo(vessel) {
    if (!vessel || vessel.dead || !this.vessels.includes(vessel)) return false;
    this.active = vessel;
    this.warpTarget = null;
    this._setWarp(0, 'switch');
    return true;
  }
  getVessel(id) { return this.vessels.find(v => v.id === id) || null; }

  // ------------------------------------------------------------------ targeting (round 2)
  /**
   * Set (or clear with null) the target of `vessel`: another Vessel, a Body, or their id (vessel id number /
   * body id string). Returns true if the target changed to something valid (or was cleared).
   * Emits `target {vessel, target}` (target = Vessel | Body | null).
   */
  setTarget(vessel, target) {
    if (!vessel || vessel.dead) return false;
    let id = null, obj = null;
    if (target !== null && target !== undefined) {
      if (typeof target === 'number') obj = this.getVessel(target);
      else if (typeof target === 'string') obj = SYSTEM.byId[target] || null;
      else obj = target;
      if (!obj || obj === vessel || obj.dead) return false;
      if (obj instanceof Vessel) { if (!this.vessels.includes(obj)) return false; id = obj.id; }
      else if (SYSTEM.byId[obj.id] === obj) id = obj.id;
      else return false;
    }
    vessel.targetId = id;
    this._updateTarget(vessel);
    this.emit('target', { vessel, target: obj });
    return true;
  }
  /** The Vessel or Body `vessel` is targeting, or null. */
  getTarget(vessel) {
    const id = vessel ? vessel.targetId : null;
    if (id === null || id === undefined) return null;
    if (typeof id === 'number') { const t = this.getVessel(id); return t && !t.dead ? t : null; }
    return SYSTEM.byId[id] || null;
  }
  /** Refresh vessel.targetInfo (or clear a target that no longer exists). */
  _updateTarget(v) {
    const id = v.targetId;
    if (id === null || id === undefined) { v.targetInfo = null; return null; }
    const t = this.getTarget(v);
    if (!t) {
      v.targetId = null; v.targetInfo = null;
      if (v === this.active) this.emit('message', { text: 'Target lost' });
      this.emit('target', { vessel: v, target: null });
      return null;
    }
    const info = v.targetInfo || (v.targetInfo = { name: '', kind: '', id: null, distance: 0, relSpeed: 0, closing: 0,
      relVel: new Vector3(), dir: new Vector3(), relPos: new Vector3() });
    const rp = info.relPos, rv = info.relVel;
    if (typeof id === 'number') {
      info.kind = 'vessel';
      rp.copy(t.pos).sub(v.pos); rv.copy(v.vel).sub(t.vel);
      if (t.body !== v.body) {
        rp.add(t.body.globalPosAt(this.ut, _a)).sub(v.body.globalPosAt(this.ut, _a));
        rv.sub(t.body.globalVelAt(this.ut, _a)).add(v.body.globalVelAt(this.ut, _a));
      }
    } else {
      info.kind = 'body';
      if (t === v.body) { rp.copy(v.pos).negate(); rv.copy(v.vel); }
      else {
        t.globalPosAt(this.ut, rp).sub(v.body.globalPosAt(this.ut, _a)).sub(v.pos);
        v.body.globalVelAt(this.ut, rv).add(v.vel).sub(t.globalVelAt(this.ut, _a));
      }
    }
    info.name = t.name; info.id = id;
    info.distance = rp.length();
    if (info.distance > 1e-9) info.dir.copy(rp).multiplyScalar(1 / info.distance); else info.dir.set(0, 1, 0);
    info.relSpeed = rv.length();
    info.closing = rv.dot(info.dir);
    return info;
  }

  // ------------------------------------------------------------------ docking (round 2)
  /**
   * Undock at the docking port `partId` of `vessel` (either port of the pair). The side that keeps the
   * control part stays `vessel`; the other side becomes a new vessel. Emits `undock {vessel, other, parts}`.
   * Returns the new vessel, or null if the port is not docked.
   */
  undock(vessel, partId) {
    if (!vessel || vessel.dead || !this.vessels.includes(vessel)) return null;
    const port = vessel.parts.get(partId);
    if (!port || port.dockedTo === null || port.dockedTo === undefined) return null;
    if (this.warpIndex > PHYSICS_WARP_MAX) this._setWarp(0, 'undock');
    if (vessel.onRails) this._leaveRails(vessel);
    const parts = [port.id, port.dockedTo];
    const other = vessel.undockPort(partId, DOCKING.UNDOCK_SPEED);
    if (!other) return null;
    other.id = this._nextId++;
    this.vessels.push(other);
    if (this._loaded.includes(vessel)) this._loaded.push(other);
    other.updateTelemetry(this.ut); vessel.updateTelemetry(this.ut);
    this.emit('undock', { vessel, other, parts });
    return other;
  }

  /** Capture assist and latching between free, compatible docking ports of loaded vessels. */
  _dockingStep(dt) {
    const L = this._loaded;
    for (let i = 0; i < L.length; i++) {
      const a = L[i];
      if (a.dead || a.landed || !a._ports.length) continue;
      for (let j = i + 1; j < L.length; j++) {
        const b = L[j];
        if (b.dead || b.landed || !b._ports.length || b.body !== a.body || a.dead) continue;
        const reach = a._bound + b._bound + 2;
        if (a.pos.distanceToSquared(b.pos) > reach * reach) continue;
        let best = null, bestD = Infinity;
        for (const pa of a._ports) {
          a.portWorld(pa, _pa, _na);
          for (const pb of b._ports) {
            if (pa.def.dock.size !== pb.def.dock.size) continue;
            b.portWorld(pb, _pb, _nb);
            const d = _pa.distanceTo(_pb);
            if (pa.dockReady === false && pb.dockReady === false) {   // the pair that just undocked
              if (d > DOCKING.REARM) { pa.dockReady = true; pb.dockReady = true; } else continue;
            }
            if (d < bestD) { bestD = d; best = [pa, pb]; }
          }
        }
        if (!best || bestD > DOCKING.ASSIST) continue;
        const [pa, pb] = best;
        a.portWorld(pa, _pa, _na); b.portWorld(pb, _pb, _nb);
        const cosAxes = -_na.dot(_nb);                      // 1 = exactly nose to nose
        a.portLocal(pa, _ua); a.pointVelocity(_ua.x, _ua.y, _ua.z, _ua);
        b.portLocal(pb, _ub); b.pointVelocity(_ub.x, _ub.y, _ub.z, _ub);
        _ub.sub(_ua);                                        // velocity of b's port relative to a's
        const speed = _ub.length();
        // side ports also want the two stacks lying parallel (either way round), or the hulls would cross
        const lined = !pa._side || Math.abs(_sa.set(0, 1, 0).applyQuaternion(a.q).dot(_sb.set(0, 1, 0).applyQuaternion(b.q))) >= COS_DOCK;
        if (bestD <= DOCKING.CAPTURE && speed < DOCKING.MAX_SPEED && cosAxes >= COS_DOCK && lined) {
          this._dock(a, pa, b, pb);
          if (a.dead) break;
          continue;
        }
        if (cosAxes < 0.8) continue;                         // badly misaligned: no assist
        // gentle spring-damper between the two ports, shared by mass so momentum is conserved
        _pb.sub(_pa);
        const M = a.mass + b.mass;
        const ax = -DOCKING.ASSIST_K * _pb.x - DOCKING.ASSIST_C * _ub.x;
        const ay = -DOCKING.ASSIST_K * _pb.y - DOCKING.ASSIST_C * _ub.y;
        const az = -DOCKING.ASSIST_K * _pb.z - DOCKING.ASSIST_C * _ub.z;
        const kb = dt * a.mass / M, ka = -dt * b.mass / M;
        b.vel.x += ax * kb; b.vel.y += ay * kb; b.vel.z += az * kb;
        a.vel.x += ax * ka; a.vel.y += ay * ka; a.vel.z += az * ka;
        a._stamp++; b._stamp++;
      }
    }
  }

  /** Latch two ports: the vessel that stays is the active one, else a ship over debris, else the heavier. */
  _dock(a, pa, b, pb) {
    let main = a, mp = pa, other = b, op = pb;
    const rank = v => (v === this.active ? 4 : 0) + (v.type === 'ship' ? 2 : 0);
    if (rank(b) > rank(a) || (rank(b) === rank(a) && b.mass > a.mass)) { main = b; mp = pb; other = a; op = pa; }
    const crew = other.crew.length;
    const res = main.absorb(other, mp, op);
    if (!res) return false;
    this._remove(other);
    for (const v of this.vessels) {
      if (v.targetId !== other.id) continue;
      if (v === main) { v.targetId = null; v.targetInfo = null; this.emit('target', { vessel: v, target: null }); }
      else v.targetId = main.id;
    }
    if (main.targetId === other.id) { main.targetId = null; main.targetInfo = null; }
    main.updateTelemetry(this.ut);
    void crew;
    this._ev.push({ type: 'dock', vessel: main, absorbed: other, parts: [res.portId, res.otherPortId], idMap: res.idMap });
    return true;
  }

  evaStart(vessel, partId) {
    if (!vessel || vessel.dead) return null;
    let part = partId !== undefined && partId !== null ? vessel.parts.get(partId) : null;
    if (!part) part = [...vessel.parts.values()].find(p => p.crew.length);
    if (!part || !part.crew.length) return null;
    this.warpTarget = null;
    this._setWarp(0, 'eva');
    if (vessel.onRails) this._leaveRails(vessel);
    if (!vessel.landed && vessel.grounded && vessel.groundSpeed < 1) vessel.pinToGround(this.ut);
    if (vessel.landed) vessel.syncLanded(this.ut);
    const name = part.crew.pop();
    vessel.crewCount--;
    const pip = Vessel.makePip(name);
    pip.id = this._nextId++;
    pip.body = vessel.body;
    pip.launchUt = this.ut;
    const off = (part.def.r || 0.5) + 0.9;
    vessel.partWorldPos(part, pip.pos);
    _a.set(1, 0, 0).applyQuaternion(vessel.q);
    if (vessel.landed) {
      // step out sideways along the ground
      const up = _b.copy(vessel.pos).normalize();
      _a.addScaledVector(up, -_a.dot(up));
      if (_a.lengthSq() < 1e-6) _a.crossVectors(up, Y_AXIS);
      _a.normalize();
      pip.pos.copy(vessel.pos).addScaledVector(_a, off + 0.6);
      const dir = new Vector3();
      vessel.body.inertialToSurfaceDir(pip.pos.normalize(), this.ut, dir);
      pip.landed = true; pip.splashed = vessel.splashed;
      // back to the hatch, looking out
      const out = vessel.body.inertialToSurfaceDir(_a, this.ut, new Vector3());
      pip.surface = { dir, qRel: World.facingFrame(dir, out), h: 0, qTarget: null };
      pip.syncLanded(this.ut);
    } else {
      pip.pos.addScaledVector(_a, off);
      pip.vel.copy(vessel.vel);
      pip.q.copy(vessel.q);
    }
    pip.updateTelemetry(this.ut);
    this.vessels.push(pip);
    this.active = pip;
    this.emit('eva', { vessel, eva: pip, name });
    return pip;
  }

  /** Board `target` (must be within 3 m of a part with a free seat). Returns true on success. */
  evaBoard(eva, target) {
    if (!eva || eva.type !== 'eva' || eva.dead || !target || target.dead || target === eva) return false;
    if (eva.body !== target.body) return false;
    if (eva.landed && !eva.ladder) eva.syncLanded(this.ut);
    if (target.landed) target.syncLanded(this.ut);
    let seat = null;
    for (const p of target.parts.values()) {
      if (p.def.command !== 'crew' || p.crew.length >= p.def.crew) continue;
      target.partWorldPos(p, _a).sub(eva.pos);
      // standing next to a landed ship counts however tall it is (the Pip climbs up)
      if ((eva.landed && target.landed) || (eva.ladder && eva.ladder.vesselId === target.id)) { _b.copy(eva.pos).normalize(); _a.addScaledVector(_b, -_a.dot(_b)); }
      if (_a.length() <= 3 + (p.def.r || 0)) { seat = p; break; }
    }
    if (!seat) return false;
    const name = eva.crew[0] || eva.name;
    seat.crew.push(name);
    target.crewCount++;
    for (const r of eva.science) {
      if (!target.science.some(x => x.experiment === r.experiment && x.situation === r.situation && x.bodyId === r.bodyId)) target.science.push(r);
    }
    this._remove(eva);
    if (this.active === eva) this.active = target;
    this.emit('board', { vessel: target, name });
    return true;
  }

  plantFlag(eva, name = 'Flag') {
    if (!eva || eva.type !== 'eva' || !eva.landed || eva.splashed || eva.ladder) return null;
    // the pole goes into the ground half a metre in front of the Pip, which is left looking at it
    const s = eva.surface;
    const d = _a.set(0, 0, 1).applyQuaternion(s.qRel).multiplyScalar(TUNING.FLAG_REACH / (eva.body.radius + (s.h || 0))).add(s.dir).normalize();
    const flag = { name, bodyId: eva.body.id, dir: { x: d.x, y: d.y, z: d.z }, ut: this.ut, by: eva.name };
    this.flags.push(flag);
    this.emit('flag', { vessel: eva, flag, body: eva.body });
    return flag;
  }

  /** Run the experiment carried by a part (for an EVA Pip: 'eva_report', or pass 'surface_sample').
   *  Returns the stored record {experiment, bodyId, situation, ut, biome} (the existing one if already taken), or null. */
  runExperiment(vessel, partId, experimentId) {
    if (!vessel || vessel.dead) return null;
    const part = vessel.parts.get(partId) || (vessel.type === 'eva' ? vessel.controlPart : null);
    if (!part) return null;
    const exp = vessel.type === 'eva' ? (experimentId || 'eva_report') : part.def.experiment;
    const def = exp && EXPERIMENTS[exp];
    if (!def) return null;
    if (def.needsCrew && !part.crew.length) return null;
    if (def.eva && vessel.type !== 'eva') return null;
    vessel.updateTelemetry(this.ut);
    const situation = situationOf(vessel);
    if (!def.situations.includes(situation) || !experimentAllowed(exp, vessel.body)) return null;
    const bodyId = vessel.body.id;
    vessel.body.inertialToSurfaceDir(_a.copy(vessel.pos).normalize(), this.ut, _b);
    const biome = vessel.body.biomeAt(_b).id;
    // near the ground each biome is its own result; higher up one per situation
    const perBiome = BIOME_SITUATIONS.includes(situation);
    const old = vessel.science.find(r => r.experiment === exp && r.situation === situation && r.bodyId === bodyId && (!perBiome || r.biome === biome));
    if (old) return old;
    const rec = { experiment: exp, bodyId, situation, ut: this.ut, biome };
    vessel.science.push(rec);
    this.emit('science', { vessel, record: rec });
    return rec;
  }

  /** Recover a vessel that is landed or splashed on the home body. Returns the summary, or null if not allowed. */
  recover(vessel) {
    if (!vessel || vessel.dead || vessel.body !== SYSTEM.home || !this.vessels.includes(vessel)) return null;
    // a vehicle that has rolled to a stop counts as landed
    if (!vessel.landed && vessel.grounded && vessel.groundSpeed < 1) vessel.pinToGround(this.ut);
    if (!vessel.landed) return null;
    let distance = Infinity, site = 'pad';
    const sites = this.sites;
    for (const k in sites) {
      const sd = sites[k].center ? sites[k].center.dir : sites[k].dir;
      const cosA = Math.max(-1, Math.min(1, vessel.surface.dir.x * sd.x + vessel.surface.dir.y * sd.y + vessel.surface.dir.z * sd.z));
      const d = Math.acos(cosA) * vessel.body.radius;
      if (d < distance) { distance = d; site = k; }
    }
    const summary = {
      partsCost: vessel.cost, distance, site, crew: vessel.crew,
      science: vessel.science.map(r => ({ ...r })), bodyId: vessel.body.id, name: vessel.name, vesselId: vessel.id,
      splashed: vessel.splashed,
    };
    this._remove(vessel);
    if (this.active === vessel) this.active = null;
    this.emit('recovered', { vessel, summary });
    return summary;
  }

  /** Take a vessel out of the world (no events). Public form of the old `_remove`. Returns true if it was there. */
  removeVessel(v) {
    const had = this.vessels.includes(v);
    this._remove(v);
    if (this.active === v) this.active = null;
    return had;
  }
  _remove(v) {
    const i = this.vessels.indexOf(v);
    if (i >= 0) this.vessels.splice(i, 1);
    let j = this._loaded.indexOf(v);
    if (j >= 0) this._loaded.splice(j, 1);
    j = this._unloaded.indexOf(v);
    if (j >= 0) this._unloaded.splice(j, 1);
  }
  _destroy(v, reason) {
    if (v.dead) return;
    v.dead = true;
    for (const name of v.crew) this._ev.push({ type: 'crewLost', name, vessel: v });
    this._ev.push({ type: 'destroyed', vessel: v, reason });
  }

  /** An unloaded (on-rails) vessel met the atmosphere or the ground: it is removed, and says so. */
  _destroyUnloaded(v, reason) {
    if (v.dead) return;
    const what = v.type === 'debris' ? 'Debris' : v.type === 'eva' ? 'Pip' : 'Vessel';
    const how = reason === 'atmosphere' ? `burned up in the atmosphere of ${v.body.name}` : `crashed into ${v.body.name}`;
    // (a fin or a panel that fell behind is not news: a break-up would otherwise end in a column of messages)
    if (!(v.type === 'debris' && v.mass < SCRAP_MASS)) this._ev.push({ type: 'message', text: `${what} "${v.name}" ${how}`, vessel: v, reason, kind: 'removed' });
    this._destroy(v, reason);
  }

  /** A break-up may not leave more than MAX_DEBRIS loose pieces in flight near the active vessel: the lightest go. */
  _capDebris() {
    const loose = [];
    for (const v of this._loaded) if (v.type === 'debris' && !v.dead && !v.landed && v !== this.active) loose.push(v);
    if (loose.length <= MAX_DEBRIS) return;
    loose.sort((a, b) => a.mass - b.mass);
    const targets = new Set(this.vessels.map(v => v.targetId).filter(id => id != null));
    for (let i = 0, cut = loose.length - MAX_DEBRIS; i < loose.length && cut > 0; i++) {
      if (targets.has(loose[i].id)) continue;
      this._destroy(loose[i], 'breakup'); cut--;
    }
  }

  _processEvents() {
    const q = this._ev;
    for (let i = 0; i < q.length; i++) {
      const e = q[i];
      switch (e.type) {
        case 'decouple': {
          const d = e.debris;
          d.id = this._nextId++;
          this.vessels.push(d);
          this._loaded.push(d);
          this.emit('decouple', { vessel: e.vessel, debris: d, part: e.part });
          if (d.type === 'debris') this._capDebris();
          break;
        }
        case 'destroyed':
          if (e.vessel.dead) this._remove(e.vessel);
          this.emit('destroyed', { vessel: e.vessel, reason: e.reason });
          break;
        case 'liftoff': this.emit('liftoff', { vessel: e.vessel }); break;
        case 'action':
          if (e.action === 'runExperiment') this.runExperiment(e.vessel, e.part.id);
          else if (e.action === 'undock') this.undock(e.vessel, e.part.id);
          break;
        default: { const { type, ...data } = e; this.emit(type, data); }
      }
    }
    q.length = 0;
  }

  // ------------------------------------------------------------------ stepping
  /** Advance the simulation by realDt seconds of wall-clock time × the current warp rate. */
  step(realDt) {
    if (!(realDt > 0)) return;
    const a = this.active && !this.active.dead ? this.active : null;
    this.substeps = 0;
    if (this.warpTarget !== null) {
      const rem = this.warpTarget - this.ut;
      if (rem <= 1e-9) { this.warpTarget = null; this._setWarp(0, 'warpTo'); }
      else {
        const max = this.maxWarpIndex();
        let idx = 0;
        for (let i = max; i > 0; i--) if (WARP_RATES[i] * 0.5 <= rem) { idx = i; break; }
        this._setWarp(idx, 'warpTo');
      }
    } else if (this.warpIndex > 0) {
      const max = this.maxWarpIndex();
      // losing rails warp altogether drops straight to 1× (resuming is the player's call)
      if (this.warpIndex > max) this._setWarp(this.warpIndex > PHYSICS_WARP_MAX && max <= PHYSICS_WARP_MAX ? 0 : max, this._limitReason);
    }
    let simDt = realDt * WARP_RATES[this.warpIndex];
    // hard stops: warpTo target and maneuver nodes are never overshot
    let stop = Infinity, stopReason = null;
    if (this.warpTarget !== null) { stop = this.warpTarget; stopReason = 'warpTo'; }
    if (a && this.warpIndex > 0 && a.nodes.length) {
      for (const node of a.nodes) {
        if (node.t <= this.ut + 1e-6) continue;
        let bt = a.burnTime(a.nodeDv || Math.hypot(node.dv.prograde, node.dv.normal, node.dv.radial));
        if (!Number.isFinite(bt)) bt = 0;
        const early = node.t - Math.min(bt, 600) / 2 - NODE_LEAD;
        const s = this.ut < early - 1e-6 ? early : node.t;
        if (s < stop) { stop = s; stopReason = 'node'; }
        break;
      }
    }
    let hit = false;
    if (stop - this.ut <= simDt) { simDt = Math.max(0, stop - this.ut); hit = true; }
    if (simDt > 0) {
      if (this.warpIndex > PHYSICS_WARP_MAX) this._railsStep(simDt, realDt);
      else this._physicsStep(simDt);
    }
    if (hit && this.ut >= stop - 1e-7) {
      this.ut = Math.max(this.ut, stop);
      this.warpTarget = null;
      this._setWarp(0, stopReason);
    }
    this._finish(realDt);
  }

  _near(v, a) {
    if (!a || v.body !== a.body) return false;
    return v.pos.distanceToSquared(a.pos) < LOAD_RANGE * LOAD_RANGE;
  }

  // ------------------------------------------------------------------ tracked vessels (reusable boosters)
  /**
   * Should this vessel keep full physics however far it is from the one being flown? Yes for a ship that can be
   * controlled (a guidance ring or a crew aboard), is in flight, has not been let go, and is either running a
   * guidance program, under thrust, inside an atmosphere, or on a path that comes down into the air or the ground.
   * A ship coasting on a closed orbit clear of both rides on rails as before, and so does every piece of debris.
   * Only a vessel that is under full physics already is ever kept there (see _classify): nothing that is on rails
   * is woken up by this rule.
   */
  isTrackable(v) {
    if (!v || v.dead || v.type !== 'ship' || v.landed || v.released || v.stranded || !v._commands.length) return false;
    if (v.program) return true;
    if (v.wouldThrust()) return true;
    const body = v.body;
    const r2 = v.pos.lengthSq();
    const top = body.radius + (body.atmo ? body.atmo.height : Math.max(0, body.maxElevation || 0));
    if (r2 < top * top) return true;
    // the path: the lowest point of the conic through the present state (a hyperbola that is leaving has already
    // passed its own)
    const mu = body.gm, r = Math.sqrt(r2), v2 = v.vel.lengthSq();
    const rv = v.pos.dot(v.vel);
    const energy = v2 / 2 - mu / r;
    _a.crossVectors(v.pos, v.vel);
    const h2 = _a.lengthSq();
    const ecc = Math.sqrt(Math.max(0, 1 + 2 * energy * h2 / (mu * mu)));
    const rp = h2 / (mu * (1 + ecc));
    if (rp >= top) return false;
    return energy < 0 || rv < 0;
  }
  /** The vessels (not the active one) being flown under full physics far away, in the order they were taken on. */
  get tracked() { return this._tracked.filter(v => !v.dead && this.vessels.includes(v)); }
  /** A tracked vessel that is still in flight (it holds fast warp off), or null. */
  trackedInFlight() {
    const a = this.active;
    for (const v of this._tracked) {
      if (v === a || v.dead || v.landed || v.onRails || !this.vessels.includes(v)) continue;
      if (this._near(v, a)) continue;
      if (this.isTrackable(v)) return v;
    }
    return null;
  }
  /**
   * Let a tracked vessel go: it is no longer kept under full physics away from the active vessel, so it meets the
   * fate of anything left behind (on rails if it is clear of the air and the ground, removed if it is not).
   * `release(v, false)` takes it back. → true if the vessel is in this world.
   */
  release(v, released = true) {
    if (!v || !this.vessels.includes(v)) return false;
    v.released = !!released;
    if (released && v.program) v.program = null;
    return true;
  }

  _classify() {
    const a = this.active && !this.active.dead ? this.active : null;
    const loaded = this._loaded, unloaded = this._unloaded;
    const before = this._before;                    // what had full physics in the step before this one
    before.clear();
    for (const v of loaded) before.add(v);
    loaded.length = 0; unloaded.length = 0;
    if (a) {
      if (a.landed) a.syncLanded(this.ut);
      else if (a.onRails) this._leaveRails(a);
      loaded.push(a);
    }
    const was = this._tracked;
    const tracked = this._tracked = [];
    // those already tracked keep their place (oldest first); a vessel that has just fallen behind joins at the end
    for (let pass = 0; pass < 2; pass++) {
      for (const v of (pass === 0 ? was : this.vessels)) {
        if (v === a || v.dead || v.onRails || v.landed || !before.has(v) || tracked.includes(v)) continue;
        if (pass === 0 && !this.vessels.includes(v)) continue;
        if (this._near(v, a) || !this.isTrackable(v)) continue;
        tracked.push(v);
      }
    }
    if (tracked.length > MAX_TRACKED) {
      // too many: the oldest without a guidance program are let fall behind
      for (let i = 0; i < tracked.length && tracked.length > MAX_TRACKED; ) { if (!tracked[i].program) tracked.splice(i, 1); else i++; }
      tracked.length = Math.min(tracked.length, MAX_TRACKED);
    }
    for (const v of this.vessels) {
      if (v === a || v.dead) continue;
      if (v.landed) {
        v.syncLanded(this.ut);
        if (this._near(v, a)) loaded.push(v);
        continue;
      }
      if (this._near(v, a) || tracked.includes(v)) {
        if (v.onRails) this._leaveRails(v);
        loaded.push(v);
      } else {
        // something standing or rolling on the ground is parked where it is, never put on an orbit
        if (!v.onRails && v.grounded && v.pinToGround(this.ut)) continue;
        if (!v.onRails) this._enterRails(v);
        unloaded.push(v);
      }
    }
  }

  _enterRails(v) {
    v.orbit = Orbit.fromState(v.pos, v.vel, v.body.gm, this.ut);
    v._orbitStamp = -2;
    v.onRails = true;
    v._patch = null;
    v.w.set(0, 0, 0);
    v.thrust = 0; v.gForce = 0;
    for (const p of v.parts.values()) { p.thrust = 0; p.level = 0; }
    if (v.structure) v.structure.rest(1);      // coasting on rails: nothing is loaded, and nothing stays bent
  }
  _leaveRails(v) {
    if (v.orbit) { v.orbit._state(this.ut, v.pos, v.vel); }
    v.onRails = false;
    v._patch = null;
    v._stamp++;
  }

  _predict(v, t0) {
    const p = predictPatches(v.orbit, v.body, t0, 1)[0];
    // a patch that nothing ends has only been searched for encounters up to `searchedUntil` (one revolution of
    // a closed orbit): the prediction is good until then, and is made again from there
    let validUntil = Infinity;
    if (!p.endType && p.searchedUntil < Infinity) validUntil = Math.max(p.searchedUntil, t0 + 1e-3);
    return { tEnd: p.tEnd, endType: p.endType, nextBody: p.nextBody, validUntil };
  }

  /** Move a rails vessel to time t, crossing SOI boundaries. Returns 'atmo' | 'impact' if it ran into one, else null. */
  _railsAdvance(v, t) {
    for (let guard = 0; guard < 40; guard++) {
      const p = v._patch || (v._patch = this._predict(v, Math.min(this.ut, t)));
      if (p.endType && p.tEnd <= t) {
        if (p.endType === 'exit' || p.endType === 'enter') {
          const s = v.orbit.stateAt(p.tEnd);
          const nx = p.endType === 'exit' ? toParentFrame(v.body, s.r, s.v, p.tEnd) : toChildFrame(p.nextBody, s.r, s.v, p.tEnd);
          const from = v.body;
          v.body = nx.body;
          v.orbit = Orbit.fromState(nx.pos, nx.vel, nx.body.gm, p.tEnd);
          v._patch = this._predict(v, p.tEnd);
          v.pos.copy(nx.pos); v.vel.copy(nx.vel);
          this._ev.push({ type: 'soi', vessel: v, from, to: nx.body });
          continue;
        }
        v.orbit._state(p.tEnd, v.pos, v.vel);
        v._stamp++;
        return p.endType;
      }
      if (!p.endType && p.validUntil <= t) { v._patch = this._predict(v, p.validUntil); continue; }
      break;
    }
    v.orbit._state(t, v.pos, v.vel);
    v._stamp++;
    return null;
  }

  _canCoast() {
    for (const v of this._loaded) {
      if (v.dead) continue;
      if (v.landed) { if (v.wouldThrust() || (v.type === 'eva' && (v.ctrl.tx || v.ctrl.ty || v.ctrl.tz || v.ctrl.yaw))) return false; continue; }
      if (v.wouldThrust()) return false;
      const c = v.ctrl;
      if (c.tx || c.ty || c.tz) return false;
      const body = v.body;
      const alt = v.pos.length() - body.radius;
      if (alt < (body.atmo ? body.atmo.height : 0) + 3000 + 0.5 * v.vel.length()) return false;
    }
    return true;
  }

  _soiCheck(v) {
    const b = v.body;
    const r2 = v.pos.lengthSq();
    let need = b.parent && r2 > b.soi * b.soi;
    if (!need && b.children.length) {
      const r = Math.sqrt(r2);
      for (const c of b.children) {
        if (r > c.orbit.periapsis - c.soi && r < c.orbit.apoapsis + c.soi) { need = true; break; }
      }
    }
    if (!need) return;
    const tr = checkSoiTransition(b, v.pos, v.vel, this.ut);
    if (!tr) return;
    v.body = tr.body; v.pos.copy(tr.pos); v.vel.copy(tr.vel);
    v._stamp++;
    this._ev.push({ type: 'soi', vessel: v, from: b, to: tr.body });
  }

  _physicsStep(simDt) {
    this._classify();
    const loaded = this._loaded, ev = this._ev;
    // unloaded vessels already inside an atmosphere / below ground are gone
    for (const v of this._unloaded) {
      const alt = v.pos.length() - v.body.radius;
      if (alt < (v.body.atmo ? v.body.atmo.height : 0)) this._destroyUnloaded(v, v.body.atmo ? 'atmosphere' : 'impact');
    }
    let docking = 0;
    for (const v of loaded) if (!v.dead && !v.landed && v._ports.length) docking++;
    let remaining = simDt, n = 0;
    while (remaining > 1e-10 && n < MAX_SUBSTEPS) {
      const dtMax = this.warpIndex > 0 && this._canCoast() ? TUNING.DT_COAST : TUNING.DT_MAX;
      const dt = remaining <= dtMax * 1.000001 ? remaining : dtMax;
      const t1 = this.ut + dt;
      for (let i = 0; i < loaded.length; i++) {
        const v = loaded[i];
        if (v.dead) continue;
        v.simulate(dt, t1, ev);
      }
      this.ut = t1;
      for (let i = 0; i < loaded.length; i++) {
        const v = loaded[i];
        if (v.dead) continue;
        if (v.ladder) this._ladderStep(v, dt); else if (!v.landed) this._soiCheck(v);
      }
      if (docking > 1) this._dockingStep(dt);
      stepTower(this, ev);
      remaining -= dt; n++;
      if (ev.length) this._processEvents();
    }
    this.substeps = n;
    for (const v of this._unloaded) {
      if (v.dead) continue;
      const hit = this._railsAdvance(v, this.ut);
      if (hit) this._destroyUnloaded(v, hit === 'atmo' ? 'atmosphere' : 'impact');
    }
    if (ev.length) this._processEvents();
  }

  _railsStep(simDt, realDt) {
    const a = this.active && !this.active.dead ? this.active : null;
    const target = this.ut + simDt;
    const rails = [];
    for (const v of this.vessels) {
      if (v.dead) continue;
      if (!v.landed && !v.onRails && v.grounded) v.pinToGround(this.ut);
      if (v._labs.length && v.science.length) v.processLabs(simDt, this._ev, true);
      if (v.landed) continue;
      if (!v.onRails) this._enterRails(v);
      rails.push(v);
    }
    this._loaded.length = 0; this._unloaded.length = 0;
    let drop = null;
    for (let guard = 0; guard < 200; guard++) {
      let chunkEnd = target, event = null;
      if (a && !a.landed) {
        const p = a._patch || (a._patch = this._predict(a, this.ut));
        if (p.endType === 'atmo' || p.endType === 'impact') {
          const lim = p.tEnd - (p.endType === 'atmo' ? ATMO_MARGIN : IMPACT_MARGIN);
          if (lim <= this.ut + 1e-6) {
            // too close: hand over to physics at 1×
            this.warpTarget = null;
            this._setWarp(0, p.endType === 'atmo' ? 'atmosphere' : 'impact');
            this._physicsStep(Math.min(realDt, Math.max(0, target - this.ut)));
            return;
          }
          if (lim < chunkEnd) { chunkEnd = lim; event = p.endType === 'atmo' ? 'atmosphere' : 'impact'; }
        } else if (p.endType) {
          if (p.tEnd <= chunkEnd) { chunkEnd = p.tEnd; event = 'soi'; }
        } else if (p.validUntil < chunkEnd) { chunkEnd = p.validUntil; event = 'again'; }
      }
      for (const v of rails) {
        if (v.dead) continue;
        const hitGround = this._railsAdvance(v, chunkEnd);
        if (hitGround && v !== a) this._destroyUnloaded(v, hitGround === 'atmo' ? 'atmosphere' : 'impact');
      }
      this.ut = chunkEnd;
      if (event === 'soi' || event === 'atmosphere' || event === 'impact') { drop = event; break; }
      if (chunkEnd >= target) break;
    }
    if (drop) { this.warpTarget = null; this._setWarp(0, drop); }
    if (this._ev.length) this._processEvents();
  }

  _sunlit(v) {
    const body = v.body;
    if (!body.parent) return true;
    body.globalPosAt(this.ut, _a).negate();         // star relative to the body centre
    _b.copy(_a).sub(v.pos).normalize();              // vessel → star
    const t = -v.pos.dot(_b);
    if (t <= 0) return true;
    _c.copy(v.pos).addScaledVector(_b, t);
    return _c.lengthSq() > body.radius * body.radius;
  }

  /** Sun direction and strength at a vessel, and whether it can reach home by radio. */
  _sun(v) {
    const body = v.body;
    body.globalPosAt(this.ut, _a).add(v.pos);            // vessel relative to the star
    const d = _a.length();
    if (!v.sunDir) v.sunDir = new Vector3();
    if (d > 1) v.sunDir.copy(_a).multiplyScalar(-1 / d); else v.sunDir.set(0, 1, 0);
    const ref = SYSTEM.home.orbit ? SYSTEM.home.orbit.a : d;
    v.sunScale = d > 1 ? Math.min(25, (ref / d) * (ref / d)) : 1;
    if (!body.parent) v.sunScale = Math.min(v.sunScale, 25);
    v.commDistance = this.homeDistance(v);
    v.commLink = v.commRange > 0 && v.commDistance <= Math.max(v.commRange, this.commGroundRange);
  }
  /** Distance (m) from a vessel to the centre of the home world. */
  homeDistance(v) {
    if (v.body === SYSTEM.home) return v.pos.length();
    v.body.globalPosAt(this.ut, _b).add(v.pos);
    SYSTEM.home.globalPosAt(this.ut, _c);
    return _b.distanceTo(_c);
  }

  /**
   * Can this vessel send science home right now? Needs a working antenna, charge, and a link: the distance home
   * must be within the better of the vessel's best antenna range and the tracking station's reach.
   * → {ok, reason: null | 'antenna' | 'power' | 'range', distance, range, rate (records' worth per use: best antenna.rate)}
   */
  canTransmit(vessel) {
    const out = { ok: false, reason: null, distance: 0, range: 0, rate: 0 };
    if (!vessel || vessel.dead) { out.reason = 'antenna'; return out; }
    out.distance = this.homeDistance(vessel);
    out.range = Math.max(vessel.commRange || 0, this.commGroundRange);
    for (const p of vessel.antennaParts) out.rate = Math.max(out.rate, p.def.antenna.rate || 1);
    if (!vessel.antennaParts.length) out.reason = 'antenna';
    else if (!(vessel._total('elec') >= TRANSMIT_EC)) out.reason = 'power';
    else if (out.distance > out.range) out.reason = 'range';
    else out.ok = true;
    return out;
  }
  /**
   * Transmit one stored record (the record object or its index in vessel.science). The record leaves the vessel
   * and TRANSMIT_EC of charge is spent. Emits `transmit {vessel, record}`. → the record, or null (see canTransmit).
   * Crediting it (career.creditRecord(record, 0.5, crew)) is the caller's business.
   */
  transmit(vessel, record) {
    if (!this.canTransmit(vessel).ok) return null;
    const i = typeof record === 'number' ? record : vessel.science.indexOf(record);
    const rec = vessel.science[i];
    if (!rec) return null;
    vessel.science.splice(i, 1);
    vessel._drain('elec', TRANSMIT_EC);
    this.emit('transmit', { vessel, record: rec });
    return rec;
  }

  /** Fire an action group ('1'..'9', 'gear', 'lights', 'brakes', 'abort') on a vessel (default: the active one). → actions done. */
  fireGroup(name, vessel = this.active) {
    if (!vessel || vessel.dead) return 0;
    if (vessel.onRails) this._leaveRails(vessel);
    const n = vessel.fireGroup(name, this._ev);
    this._processEvents();
    return n;
  }

  /**
   * A stranded Pip in a dead pod, for rescue contracts: {bodyId, alt (m), name}. The pod circles the body at that
   * altitude with the Pip aboard. → the new vessel (not made active), or null.
   */
  spawnStranded({ bodyId, alt, name } = {}) {
    const body = SYSTEM.byId[bodyId];
    if (!body || !name) return null;
    const craft = new Craft(`${name}'s Pod`);
    craft.setRoot('pod_acorn');
    const r = body.radius + Math.max(alt || 0, (body.atmo ? body.atmo.height : 0) + 8000, (body.maxElevation || 0) + 3000);
    const sp = Math.sqrt(body.gm / r);
    const ang = (this._nextId * 2.399963) % (Math.PI * 2);
    const pos = new Vector3(Math.cos(ang) * r, 0, Math.sin(ang) * r);
    const vel = new Vector3(Math.sin(ang) * sp, 0, -Math.cos(ang) * sp);
    const v = this.spawn(craft, { crew: [name], body, pos, vel, makeActive: false });
    v.stranded = true;
    this._enterRails(v);
    return v;
  }

  // ------------------------------------------------------------------ ladders
  /** The ladder (of a landed vessel) an EVA Pip could grab from where it stands: {vessel, part} or null. */
  ladderNear(eva) {
    if (!eva || eva.type !== 'eva' || eva.dead) return null;
    let best = null, bestD = TUNING.LADDER_REACH;
    for (const v of this.vessels) {
      if (v === eva || v.dead || v.body !== eva.body || !v.landed || !v.ladderParts.length) continue;
      if (v.pos.distanceToSquared(eva.pos) > (v.boundRadius + 6) * (v.boundRadius + 6)) continue;
      for (const p of v.ladderParts) {
        const run = ladderRun(v, p);
        // nearest point of the run to the Pip
        _pa.copy(eva.pos).sub(v.pos).applyQuaternion(_qInv.copy(v.q).invert()).add(v.com);
        const y = Math.max(run.min, Math.min(run.max, _pa.y));
        const d = Math.hypot(_pa.x - run.x, _pa.y - y, _pa.z - run.z);
        if (d < bestD) { bestD = d; best = { vessel: v, part: p }; }
      }
    }
    return best;
  }
  /** Grab the nearest ladder. While holding it the Pip climbs with ctrl.ty / ctrl.tz (up/forward = up). → true if grabbed. */
  evaGrab(eva) {
    const hit = this.ladderNear(eva);
    if (!hit) return false;
    const { vessel: v, part } = hit;
    const run = ladderRun(v, part);
    _pa.copy(eva.pos).sub(v.pos).applyQuaternion(_qInv.copy(v.q).invert()).add(v.com);
    eva.ladder = { vesselId: v.id, partId: part.id, y: Math.max(run.min, Math.min(run.max, _pa.y)) };
    if (!eva.landed) { eva.landed = true; eva.surface = { dir: new Vector3(), qRel: new Quaternion(), h: 0, qTarget: null, fixed: true }; }
    this._ladderStep(eva, 0);
    this.emit('ladder', { vessel: v, eva, part, state: 'grab' });
    return true;
  }
  /** Let go of the ladder: the Pip stands if the ground is underfoot, otherwise falls (or floats). */
  evaLetGo(eva) {
    if (!eva || !eva.ladder) return false;
    const v = this.getVessel(eva.ladder.vesselId);
    eva.ladder = null;
    const body = eva.body;
    const R = eva.pos.length();
    const dir = new Vector3();
    body.inertialToSurfaceDir(_a.copy(eva.pos).multiplyScalar(1 / R), this.ut, dir);
    const above = R - body.radius - surfaceAt(body, dir);
    if (above < 1.2) {
      // keeps looking the way it was (at the hull it climbed down)
      const fwd = body.inertialToSurfaceDir(_b.set(0, 0, 1).applyQuaternion(eva.q), this.ut, new Vector3());
      eva.landed = true; eva.surface = { dir, qRel: World.facingFrame(dir, fwd), h: 0, qTarget: null }; eva.syncLanded(this.ut);
    }
    else { eva._release(this.ut, this._ev); if (v) eva.vel.copy(v.vel); }
    this.emit('ladder', { vessel: v, eva, state: 'release' });
    return true;
  }
  _ladderStep(eva, dt) {
    const L = eva.ladder;
    const v = L && this.getVessel(L.vesselId);
    const part = v && v.parts.get(L.partId);
    if (!v || v.dead || !part || v.body !== eva.body) { if (L) this.evaLetGo(eva); return; }
    if (v.landed) v.syncLanded(this.ut);      // a landed ship's pose is brought up to date lazily: without this the Pip hung one step of the ground's turning behind its ladder
    const run = ladderRun(v, part);
    const c = eva.ctrl;
    const climb = Math.max(-1, Math.min(1, (c.ty || 0) + (c.tz || 0)));
    L.y = Math.max(run.min - 0.3, Math.min(run.max + 0.3, L.y + climb * TUNING.LADDER_SPEED * dt));
    // 0.45 m out from the rungs, facing the hull
    const ox = part._ox, oz = part._oz;
    _pa.set(run.x + ox * 0.45 - v.com.x, L.y - v.com.y, run.z + oz * 0.45 - v.com.z).applyQuaternion(v.q).add(v.pos);
    eva.pos.copy(_pa); eva.vel.copy(v.vel); eva.w.set(0, 0, 0);
    eva.q.copy(v.q).multiply(_qInv.setFromAxisAngle(Y_AXIS, Math.atan2(-ox, -oz)));      // visor toward the rungs
    const body = eva.body, R = eva.pos.length();
    const s = eva.surface;
    body.inertialToSurfaceDir(_a.copy(eva.pos).multiplyScalar(1 / R), this.ut, s.dir);
    _qInv.setFromAxisAngle(Y_AXIS, -body.rotationAngle(this.ut));
    s.qRel.copy(_qInv).multiply(eva.q).normalize();
    s.h = R - body.radius; s.fixed = true; s.qTarget = null;
    eva.ladderTop = L.y >= run.max - 0.05; eva.ladderBottom = L.y <= run.min + 0.05;
    eva._stamp++;
    // stepping off the bottom onto the ground
    if (dt > 0 && climb < 0 && L.y <= run.min - 0.25) {
      const above = R - body.radius - surfaceAt(body, s.dir);
      if (above < 1.4) this.evaLetGo(eva);
    }
  }

  _targetDir(v, out) {
    const id = v.targetId;
    if (id === null || id === undefined) return null;
    if (typeof id === 'number') {
      const t = this.getVessel(id);
      if (!t || t.body !== v.body) return null;
      return out.copy(t.pos).sub(v.pos);
    }
    const b = SYSTEM.byId[id];
    if (!b) return null;
    b.globalPosAt(this.ut, out);
    v.body.globalPosAt(this.ut, _a);
    return out.sub(_a).sub(v.pos);
  }

  _finish(realDt) {
    const a = this.active;
    for (const v of this.vessels) {
      if (v.dead) continue;
      const from = v.updateTelemetry(this.ut);
      if (from !== null) this.emit('situation', { vessel: v, from, to: v.situation });
    }
    for (const v of this.vessels) {
      if (v.dead) continue;
      if (v.targetId !== null && v.targetId !== undefined) this._updateTarget(v);
      else if (v.targetInfo) v.targetInfo = null;
    }
    for (const v of this._loaded) {
      if (v.dead) continue;
      v.sunlit = this._sunlit(v);
      this._sun(v);
      if (v.nodes.length || v.ctrl.sasMode === 'target' || v.ctrl.sasMode === 'antiTarget' || v.nodeDv) v.updateGuidance(this.ut, this._targetDir(v, _c));
    }
    if (a && !a.dead) {
      if (!this._loaded.includes(a)) {
        a.sunlit = this._sunlit(a);
        this._sun(a);
        if (a.nodes.length || a.nodeDv) a.updateGuidance(this.ut, this._targetDir(a, _c));
      }
      this._dvClock += realDt;
      if (this._dvClock > 0.25) { this._dvClock = 0; a.estimateDeltaV(); }
    }
  }

  // ------------------------------------------------------------------ persistence
  toJSON() {
    return {
      version: 1, ut: this.ut, warpIndex: this.warpIndex, warpTarget: this.warpTarget, nextId: this._nextId,
      activeId: this.active && !this.active.dead ? this.active.id : null,
      tracked: this._tracked.length ? this._tracked.filter(v => !v.dead).map(v => v.id) : undefined,
      flags: this.flags.map(f => ({ ...f, dir: { ...f.dir } })),
      vessels: this.vessels.filter(v => !v.dead).map(v => v.toJSON()),
    };
  }
  static fromJSON(o) {
    if (typeof o === 'string') o = JSON.parse(o);
    const w = new World({ ut: o.ut || 0 });
    w.warpIndex = o.warpIndex || 0;
    w.warpTarget = o.warpTarget ?? null;
    w._nextId = o.nextId || 1;
    w.flags = (o.flags || []).map(f => ({ ...f, dir: { ...f.dir } }));
    for (const j of o.vessels || []) {
      const v = Vessel.fromJSON(j);
      w.vessels.push(v);
      w._nextId = Math.max(w._nextId, v.id + 1);
    }
    w.active = w.vessels.find(v => v.id === o.activeId) || null;
    // vessels that were being flown under full physics far from the active one go on being flown
    for (const id of o.tracked || []) { const v = w.getVessel(id); if (v && !v.onRails) { w._tracked.push(v); w._loaded.push(v); } }
    for (const v of w.vessels) { if (v.landed) v.syncLanded(w.ut); v.updateTelemetry(w.ut); }
    return w;
  }
}
