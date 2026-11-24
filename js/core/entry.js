// Entry prediction: where a vessel's path through an atmosphere ends (docs/ENTRY.md).
//
// A point mass is flown from a state on or above the atmosphere down to the ground, or back out of the top of the
// air if it skips. The forces are gravity, drag against the air-relative velocity, and lift across it: lift is the
// drag times a lift-to-drag ratio, turned about the velocity by the bank angle (0 = straight up, positive = to the
// right of the path looking along it). The air turns with the body. No engines, no parachutes, no winds, and the
// attitude is taken as held: the vessel keeps the drag area, lift-to-drag and bank it is given.
//
// Inertial body-centred frame, the same one Vessel.pos and Vessel.vel are in. No three.js objects are made inside
// the loop, so this can run twice a second for the map.

import { Vector3 } from '../lib/three.module.min.js';
import { TUNING } from './vessel.js';

const TAU = Math.PI * 2;
const _d = new Vector3();

/**
 * predictEntry(body, pos, vel, ut, opts) → {
 *   end: 'land' | 'skip' | 'orbit' | 'time',   landed, left through the top of the air, never met the air, ran out of time
 *   t (s from ut to the end), pos, vel (inertial, at the end), dir (body-fixed unit direction of the end point),
 *   tEntry (s from ut to the first air, or null), maxG (m/s², drag and lift together), maxGT, maxGSpeed (air-relative
 *   speed then), maxFlux (W/m²), maxFluxT, maxFluxSpeed,
 *   maxQ (Pa), minAlt (m), path: Float64Array of [x, y, z, t] rows in the inertial frame from the first air to the end
 *   (null unless opts.path), n (rows)
 * }
 * opts: mass (kg); drag: Float64Array, drag area (m²) against Mach 0 to 12 in tenths (Vessel.axialDragTable), or
 * area (m², constant); dragScale (multiplies the table: a capsule held at its trim angle shows less than head on);
 * ld (lift over drag); ldMach: [from, full] the Mach numbers between which the lift fades in (default always full);
 * bank (rad); maxT (s); path (true to record the path); floor (m, stop this high above the ground); terrain (false:
 * the ground is the body's datum radius everywhere).
 */
export function predictEntry(body, pos, vel, ut, opts = {}) {
  const o = { mass: 1000, drag: null, area: 1, dragScale: 1, ld: 0, ldMach: null, bank: 0, maxT: 4000, path: false, floor: 0, terrain: true, ...opts };
  const R = body.radius, gm = body.gm, wy = TAU / body.rotPeriod;
  const top = body.atmo ? body.atmo.height : 0, scaleH = body.atmo ? body.atmo.scale : 1;
  const cb = Math.cos(o.bank), sb = Math.sin(o.bank);
  const dragArea = o.drag ? m => { const x = m >= 12 ? 119.999 : m * 10, i = x | 0; return (o.drag[i] + (o.drag[i + 1] - o.drag[i]) * (x - i)) * o.dragScale; } : () => o.area * o.dragScale;
  const out = { end: 'time', t: 0, pos: new Vector3(), vel: new Vector3(), dir: new Vector3(), tEntry: null, maxG: 0, maxGT: 0, maxGSpeed: 0, maxFlux: 0, maxFluxT: 0, maxFluxSpeed: 0, maxQ: 0, minAlt: Infinity, path: null, n: 0 };
  let x = pos.x, y = pos.y, z = pos.z, vx = vel.x, vy = vel.y, vz = vel.z, t = 0;
  let path = o.path ? new Float64Array(4 * 512) : null, n = 0;
  const push = () => {
    if (!path) return;
    if (n * 4 >= path.length) { const p2 = new Float64Array(path.length * 2); p2.set(path); path = p2; }
    path[n * 4] = x; path[n * 4 + 1] = y; path[n * 4 + 2] = z; path[n * 4 + 3] = t; n++;
  };
  let ax = 0, ay = 0, az = 0, rr = 0, sp = 0, qd = 0, rho = 0, aero = 0;
  const acc = (px, py, pz, ux, uy, uz) => {
    rr = Math.sqrt(px * px + py * py + pz * pz);
    const alt = rr - R, g = -gm / (rr * rr * rr);
    ax = g * px; ay = g * py; az = g * pz;
    rho = alt < top ? body.density(alt) : 0; qd = 0; aero = 0;
    if (!(rho > 0)) { sp = 0; return; }
    const sx = ux - wy * pz, sy = uy, sz = uz + wy * px;
    sp = Math.sqrt(sx * sx + sy * sy + sz * sz);
    if (sp < 1e-6) return;
    qd = 0.5 * rho * sp * sp;
    const mach = sp / body.soundSpeed(alt);
    const D = qd * dragArea(mach) / o.mass;                      // drag deceleration
    const ex = sx / sp, ey = sy / sp, ez = sz / sp;
    ax -= D * ex; ay -= D * ey; az -= D * ez;
    let ld = o.ld;
    if (ld && o.ldMach) { const f = (mach - o.ldMach[0]) / (o.ldMach[1] - o.ldMach[0]); ld *= f <= 0 ? 0 : f >= 1 ? 1 : f * f * (3 - 2 * f); }
    aero = D;
    if (ld) {
      // straight up seen across the flow, and the right-hand side of the path
      const dn = (px * ex + py * ey + pz * ez) / rr;
      let hx = px / rr - dn * ex, hy = py / rr - dn * ey, hz = pz / rr - dn * ez;
      const hl = Math.sqrt(hx * hx + hy * hy + hz * hz);
      if (hl > 1e-6) {
        hx /= hl; hy /= hl; hz /= hl;
        const rx = ey * hz - ez * hy, ry = ez * hx - ex * hz, rz = ex * hy - ey * hx;
        const L = D * ld;
        ax += L * (cb * hx + sb * rx); ay += L * (cb * hy + sb * ry); az += L * (cb * hz + sb * rz);
        aero = D * Math.sqrt(1 + ld * ld);
      }
    }
  };
  // above the air: nothing to integrate until it comes down to the top (the caller's orbit already says whether it does)
  let inAir = false, wasIn = false;
  let px = 0, py = 0, pz = 0, pvx = 0, pvy = 0, pvz = 0, pt = 0, pAbove = -1, pAlt = Infinity;
  for (let i = 0; i < 60000 && t < o.maxT; i++) {
    acc(x, y, z, vx, vy, vz);
    const alt = rr - R;
    if (alt < out.minAlt) out.minAlt = alt;
    inAir = alt < top;
    if (inAir && !wasIn) { if (out.tEntry === null) out.tEntry = t; push(); }
    if (inAir) {
      if (aero > out.maxG) { out.maxG = aero; out.maxGT = t; out.maxGSpeed = sp; }
      if (qd > out.maxQ) out.maxQ = qd;
      const flux = TUNING.HEAT_FLUX_K * Math.sqrt(rho) * sp * sp * sp;
      if (flux > out.maxFlux) { out.maxFlux = flux; out.maxFluxT = t; out.maxFluxSpeed = sp; }
    }
    const vr = (x * vx + y * vy + z * vz) / rr;
    if (wasIn && !inAir && vr > 0) {
      // back along the last step to the top of the air
      if (pAlt < top && alt > pAlt) { const f = (alt - top) / (alt - pAlt); x += (px - x) * f; y += (py - y) * f; z += (pz - z) * f; vx += (pvx - vx) * f; vy += (pvy - vy) * f; vz += (pvz - vz) * f; t += (pt - t) * f; }
      out.end = 'skip'; break;
    }
    if (!inAir && !wasIn && vr >= 0 && t > 0) {
      // climbing above the air: does the orbit come back down into it? (energy and angular momentum)
      const v2 = vx * vx + vy * vy + vz * vz, en = v2 / 2 - gm / rr;
      const hx = y * vz - z * vy, hy = z * vx - x * vz, hz = x * vy - y * vx, h2 = hx * hx + hy * hy + hz * hz;
      const ecc = Math.sqrt(Math.max(0, 1 + 2 * en * h2 / (gm * gm)));
      if (en >= 0 || h2 / (gm * (1 + ecc)) >= R + top) { out.end = 'orbit'; break; }
    }
    if (inAir) {
      _d.set(x, y, z).applyAxisAngle(Y, -body.rotationAngle(ut + t)).normalize();
      const gh = o.terrain && alt < 12000 ? Math.max(body.terrainHeight(_d, 0), body.ocean ? body.seaLevel || 0 : -Infinity) : 0;
      const above = alt - gh - o.floor;
      if (above <= 0) {
        // back along the last step to where it crossed
        if (pAbove > 0) { const f = above / (above - pAbove); x += (px - x) * f; y += (py - y) * f; z += (pz - z) * f; vx += (pvx - vx) * f; vy += (pvy - vy) * f; vz += (pvz - vz) * f; t += (pt - t) * f; }
        out.end = 'land'; break;
      }
      px = x; py = y; pz = z; pvx = vx; pvy = vy; pvz = vz; pt = t; pAbove = above; pAlt = alt;
    }
    wasIn = wasIn || inAir;
    // step: long above the air, a second in thin air, finer where the drag is strong or the ground is near
    let dt = !inAir ? Math.max(1, Math.min(20, (alt - top) / Math.max(50, Math.abs(vr)) * 0.5)) : alt < 3000 ? 0.25 : aero > 5 ? 0.5 : 1;
    // ... and never further than a small part of a scale height up or down in one step
    if (inAir && Math.abs(vr) * dt > 0.05 * scaleH) dt = Math.max(0.1, 0.05 * scaleH / Math.abs(vr));
    if (t + dt > o.maxT) dt = o.maxT - t;
    // classical Runge-Kutta
    const k1x = ax, k1y = ay, k1z = az;
    const h2 = dt / 2;
    acc(x + vx * h2, y + vy * h2, z + vz * h2, vx + k1x * h2, vy + k1y * h2, vz + k1z * h2);
    const k2x = ax, k2y = ay, k2z = az;
    acc(x + vx * h2 + k1x * dt * dt / 4, y + vy * h2 + k1y * dt * dt / 4, z + vz * h2 + k1z * dt * dt / 4, vx + k2x * h2, vy + k2y * h2, vz + k2z * h2);
    const k3x = ax, k3y = ay, k3z = az;
    acc(x + vx * dt + k2x * dt * dt / 2, y + vy * dt + k2y * dt * dt / 2, z + vz * dt + k2z * dt * dt / 2, vx + k3x * dt, vy + k3y * dt, vz + k3z * dt);
    const k4x = ax, k4y = ay, k4z = az;
    x += vx * dt + (k1x + k2x + k3x) * dt * dt / 6; y += vy * dt + (k1y + k2y + k3y) * dt * dt / 6; z += vz * dt + (k1z + k2z + k3z) * dt * dt / 6;
    vx += (k1x + 2 * k2x + 2 * k3x + k4x) * dt / 6; vy += (k1y + 2 * k2y + 2 * k3y + k4y) * dt / 6; vz += (k1z + 2 * k2z + 2 * k3z + k4z) * dt / 6;
    t += dt;
    if (inAir || wasIn) push();
  }
  out.t = t; out.pos.set(x, y, z); out.vel.set(vx, vy, vz);
  out.dir.set(x, y, z).applyAxisAngle(Y, -body.rotationAngle(ut + t)).normalize();
  if (path) { push(); out.path = path.subarray(0, n * 4); out.n = n; }
  return out;
}
const Y = new Vector3(0, 1, 0);
