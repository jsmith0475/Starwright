// Starwright — flight camera controller.
//
// The flight scene uses a floating origin: the followed vessel's centre of mass is the scene origin, so the
// camera lives a few metres to a few kilometres from (0,0,0) whatever the vessel's real position is.
//
//   const cam = createFlightCamera(app, camera)
//   cam.mode  'orbit' | 'chase' | 'free' | 'locked'        cam.setMode(mode), cam.cycle()
//       orbit   up = local vertical (from the body centre); yaw = compass bearing from the vessel to the camera
//       chase   rides behind the direction of travel (yaw 180° = looking where the vessel is going), horizon level
//       free    inertial frame (up = system north); the vessel can tumble freely in view
//       locked  frame bolted to the vessel's attitude (up = vessel "top", yaw 180° = looking along the nose)
//   cam.yaw, cam.pitch (rad: the commanded angles; the view eases toward them), cam.dist (m), cam.offset
//   cam.frame(vessel)                 pick a default distance/angle for a vessel
//   cam.update(dt, anchor)            anchor = { body, pos (rel. body centre), q, vel?, surfaceVel?, ut?, ground? (m, radius of the terrain below) }
//   cam.attach() / cam.detach()       mouse: wheel zoom, right-drag orbit, middle-drag offset, double-click reset
//   cam.enabled = false               ignore the mouse (e.g. while the map is open)
//   cam.shake = 0..1                  continuous rumble (thrust, air); cam.kick(amount) adds a decaying jolt
//   cam.accel = g                     felt acceleration: widens the field of view a little
//   cam.forward / cam.right / cam.up  world-space unit vectors of the camera after update()
import * as THREE from '../lib/three.module.min.js';

export const CAMERA_MODES = ['orbit', 'chase', 'free', 'locked'];
export const MODE_LABEL = { orbit: 'Orbital camera', chase: 'Chase camera', free: 'Free camera', locked: 'Locked camera' };
const MIN_DIST = 4, MAX_DIST = 3000, BASE_FOV = 55;
const Y_AXIS = new THREE.Vector3(0, 1, 0);
const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);

export function createFlightCamera(app, camera) {
  const input = app.input;
  const bx = new THREE.Vector3(1, 0, 0), by = new THREE.Vector3(0, 1, 0), bz = new THREE.Vector3(0, 0, 1);   // frame: bx = "east", by = up, bz = "north"
  const dir = new THREE.Vector3(), target = new THREE.Vector3(), tmp = new THREE.Vector3(), upW = new THREE.Vector3(), fwd = new THREE.Vector3();
  const fq = new THREE.Quaternion(), fqGoal = new THREE.Quaternion(), m4 = new THREE.Matrix4();
  let fqValid = false, lastMode = '';
  let offs = [];
  let dragBtn = -1;
  let distGoal = 30, yawNow = 2.2, pitchNow = 0.16, jolt = 0, clock = Math.random() * 100, fov = BASE_FOV;

  const cam = {
    mode: 'orbit', yaw: 2.2, pitch: 0.16, dist: 30, enabled: true, shake: 0, accel: 1,
    offset: new THREE.Vector3(),
    forward: new THREE.Vector3(0, 0, -1), right: new THREE.Vector3(1, 0, 0), up: new THREE.Vector3(0, 1, 0),
    defaultDist: 30, bias: 0.12,
    get dragging() { return dragBtn >= 0; },
    get fov() { return fov; },

    setMode(mode) {
      if (!CAMERA_MODES.includes(mode) || mode === cam.mode) return cam.mode;
      // keep looking from roughly the same place: re-express the current offset direction in the new frame
      const d = dir.clone();
      cam.mode = mode;
      cam._pendingDir = d.lengthSq() > 0.5 ? d : null;
      return mode;
    },
    cycle() { return cam.setMode(CAMERA_MODES[(CAMERA_MODES.indexOf(cam.mode) + 1) % CAMERA_MODES.length]); },

    frame(vessel, { keepAngles = false } = {}) {
      const bound = vessel && Number.isFinite(vessel.boundRadius) ? vessel.boundRadius : 4;
      const eva = vessel && vessel.type === 'eva';
      cam.defaultDist = clamp(eva ? 6 : bound * 2.6 + 7, MIN_DIST, 400);
      distGoal = cam.dist = cam.defaultDist;
      cam.offset.set(0, 0, 0);
      if (!keepAngles) { cam.yaw = yawNow = cam.mode === 'chase' || cam.mode === 'locked' ? Math.PI : 2.2; cam.pitch = pitchNow = eva ? 0.3 : 0.16; }
    },
    reset() { distGoal = cam.defaultDist; cam.offset.set(0, 0, 0); cam.yaw = cam.mode === 'chase' || cam.mode === 'locked' ? Math.PI : 2.2; cam.pitch = 0.16; },

    /** Be at the commanded view now, with no easing from the old one (a cut: the demo tour, a change of vessel). */
    snap() { yawNow = cam.yaw; pitchNow = cam.pitch = clamp(cam.pitch, -1.5, 1.5); cam.dist = distGoal; },

    /** The distance the view is easing toward (m); setDist(d) moves it without a wheel event. */
    get goal() { return distGoal; },
    setDist(d) { if (Number.isFinite(d)) distGoal = clamp(d, MIN_DIST, MAX_DIST); return distGoal; },
    zoom(factor) { distGoal = clamp(distGoal / clamp(factor, 0.5, 2), MIN_DIST, MAX_DIST); },
    kick(amount) { jolt = Math.min(2.5, jolt + amount); },

    update(dt, anchor) {
      clock += dt;
      // ---- frame
      by.copy(anchor.pos); if (by.lengthSq() < 1e-9) by.set(0, 1, 0); by.normalize();
      if (cam.mode === 'locked' && anchor.q) {
        bx.set(1, 0, 0).applyQuaternion(anchor.q); by.set(0, 0, 1).applyQuaternion(anchor.q); bz.set(0, 1, 0).applyQuaternion(anchor.q);
        fqValid = false;
      } else if (cam.mode === 'free') {
        bx.set(1, 0, 0); by.set(0, 1, 0); bz.set(0, 0, -1);
        fqValid = false;
      } else if (cam.mode === 'chase') {
        // forward = where the vessel is going (over the ground when low and slow, along the orbit otherwise)
        const sv = anchor.surfaceVel, low = anchor.body && anchor.pos.length() - anchor.body.radius < (anchor.body.atmo ? anchor.body.atmo.height : 20000);
        if (low && sv && sv.lengthSq() > 9) fwd.copy(sv).normalize();
        else if (!low && anchor.vel && anchor.vel.lengthSq() > 9) fwd.copy(anchor.vel).normalize();
        else if (anchor.q) fwd.set(0, 1, 0).applyQuaternion(anchor.q);
        else fwd.set(0, 0, 1);
        // level horizon; in a vertical climb the "up" of the frame falls back to the vessel's back
        tmp.copy(by).addScaledVector(fwd, -by.dot(fwd));
        if (tmp.lengthSq() < 0.02 && anchor.q) { tmp.set(0, 0, -1).applyQuaternion(anchor.q); tmp.addScaledVector(fwd, -tmp.dot(fwd)); }
        if (tmp.lengthSq() < 1e-6) tmp.copy(Y_AXIS).addScaledVector(fwd, -fwd.y);
        tmp.normalize();
        bz.copy(fwd); by.copy(tmp); bx.crossVectors(bz, by).normalize();
        m4.makeBasis(bx, by, tmp.copy(bz).negate()); fqGoal.setFromRotationMatrix(m4);      // (bx, by, −bz) is right-handed
        if (!fqValid || lastMode !== 'chase') { fq.copy(fqGoal); fqValid = true; } else fq.slerp(fqGoal, Math.min(1, dt * 2.6));
        bx.set(1, 0, 0).applyQuaternion(fq); by.set(0, 1, 0).applyQuaternion(fq); bz.set(0, 0, -1).applyQuaternion(fq);
      } else {
        bx.crossVectors(Y_AXIS, by); if (bx.lengthSq() < 1e-9) bx.set(0, 0, -1); bx.normalize();
        bz.crossVectors(by, bx).normalize();
        fqValid = false;
      }
      lastMode = cam.mode;
      if (cam._pendingDir) {
        const d = cam._pendingDir; cam._pendingDir = null;
        cam.pitch = pitchNow = Math.asin(clamp(d.dot(by), -1, 1));
        cam.yaw = yawNow = Math.atan2(d.dot(bx), d.dot(bz));
      }
      // ---- ease toward the commanded view
      const k = Math.min(1, dt * 16);
      cam.pitch = clamp(cam.pitch, -1.5, 1.5);
      yawNow += (cam.yaw - yawNow) * k; pitchNow += (cam.pitch - pitchNow) * k;
      cam.dist += (distGoal - cam.dist) * Math.min(1, dt * 9);
      const cp = Math.cos(pitchNow), sp = Math.sin(pitchNow);
      dir.set(0, 0, 0).addScaledVector(bz, cp * Math.cos(yawNow)).addScaledVector(bx, cp * Math.sin(yawNow)).addScaledVector(by, sp);
      // ---- look-at point (middle-drag offset is in camera right/up metres)
      camera.up.copy(by);
      target.set(0, 0, 0);
      camera.position.copy(dir).multiplyScalar(cam.dist);
      camera.lookAt(target);
      camera.updateMatrixWorld(true);
      cam.right.setFromMatrixColumn(camera.matrixWorld, 0);
      cam.up.setFromMatrixColumn(camera.matrixWorld, 1);
      cam.forward.setFromMatrixColumn(camera.matrixWorld, 2).negate();
      // pan: the middle-drag offset plus a little downward bias so the vessel sits above the instruments
      const oy = cam.offset.y - cam.bias * cam.dist + (cam.lift || 0);    // lift: the scene raises the aim under an open canopy
      if (cam.offset.x !== 0 || oy !== 0) {
        tmp.set(0, 0, 0).addScaledVector(cam.right, cam.offset.x).addScaledVector(cam.up, oy);
        camera.position.add(tmp);
      }
      // ---- never below the ground (terrain radius under the vessel when the scene knows it, else the datum)
      const body = anchor.body;
      if (body) {
        upW.copy(anchor.pos).add(camera.position);
        const r = upW.length();
        let ground = Number.isFinite(anchor.ground) ? anchor.ground : body.radius;
        if (typeof anchor.groundAt === 'function') { try { const g = anchor.groundAt(upW); if (Number.isFinite(g)) ground = g; } catch { /* keep the estimate */ } }
        const floor = ground + Math.max(0.9, camera.near * 2.5);
        if (r < floor) {
          upW.multiplyScalar(1 / (r || 1));
          camera.position.addScaledVector(upW, floor - r);
          camera.lookAt(tmp.set(0, 0, 0).addScaledVector(cam.right, cam.offset.x).addScaledVector(cam.up, oy));
        }
      }
      // ---- shake: engine rumble, air buffet and jolts
      const gain = app.settings && Number.isFinite(app.settings.gfxShake) ? app.settings.gfxShake : 1;
      jolt *= Math.exp(-dt * 5.5);
      const amp = (clamp(cam.shake, 0, 1) * 0.55 + jolt) * gain;
      if (amp > 0.002) {
        const t = clock, a = amp * clamp(cam.dist * 0.006, 0.02, 0.5);
        const sx = Math.sin(t * 71.3) * 0.6 + Math.sin(t * 43.7 + 1.3) * 0.4, sy = Math.sin(t * 59.1 + 0.7) * 0.6 + Math.sin(t * 37.9 + 2.1) * 0.4;
        camera.position.addScaledVector(cam.right, sx * a).addScaledVector(cam.up, sy * a);
        camera.rotateZ(Math.sin(t * 29.3) * amp * 0.004);
      }
      // ---- field of view opens up a little under hard acceleration
      const want = BASE_FOV + clamp((cam.accel || 1) - 1.2, 0, 6) * 1.7 * Math.min(1, gain);
      fov += (want - fov) * Math.min(1, dt * 2.5);
      if (Math.abs(camera.fov - fov) > 0.01) camera.fov = fov;
      camera.near = clamp(cam.dist * 0.02, 0.08, 4);
      camera.updateProjectionMatrix();
      camera.updateMatrixWorld(true);
      cam.right.setFromMatrixColumn(camera.matrixWorld, 0);
      cam.up.setFromMatrixColumn(camera.matrixWorld, 1);
      cam.forward.setFromMatrixColumn(camera.matrixWorld, 2).negate();
    },

    attach() {
      cam.detach();
      offs = [
        input.on('wheel', e => { if (cam.enabled) cam.zoom(e.zoom); }),
        input.on('mousedown', e => { if (cam.enabled && (e.button === 2 || e.button === 1 || e.button === 0)) dragBtn = e.button; }),
        input.on('mouseup', () => { dragBtn = -1; }),
        input.on('mousemove', e => {
          if (!cam.enabled || dragBtn < 0 || !e.buttons) return;
          if (dragBtn === 2 || dragBtn === 0) {
            cam.yaw += e.dx * 0.0065;
            cam.pitch = clamp(cam.pitch + e.dy * 0.0055, -1.5, 1.5);
          } else if (dragBtn === 1) {
            const k = cam.dist * 0.0016;
            const lim = Math.max(20, cam.dist * 0.8);
            cam.offset.x = clamp(cam.offset.x - e.dx * k, -lim, lim);
            cam.offset.y = clamp(cam.offset.y + e.dy * k, -lim, lim);
          }
        }),
        input.on('dblclick', () => { if (cam.enabled) cam.reset(); }),
      ];
    },
    detach() { for (const off of offs) { try { off(); } catch { /* gone */ } } offs = []; dragBtn = -1; },
  };
  return cam;
}
