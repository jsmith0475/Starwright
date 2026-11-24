// Starwright: the space centre is solid. A vessel that flies into a building, a lightning mast, the service tower, a
// propellant tank or the launch mount under the pad is stopped against it, and breaks by the same rules as on the
// ground: a part that meets it faster than its crash tolerance breaks off, and faster than TUNING.CRASH_ALL times that
// the whole vessel is lost.
//
// What is solid, and where it comes from:
//   - everything fixed that the space centre's drawing builds (js/render/basegfx.js), as boxes, rods, drums and balls
//     recorded from the drawing itself into js/core/sitesolids.js (tests/tools/site_solids.mjs writes it; a unit test
//     fails when the drawing changes and it was not written again), plus the Tall Bay beside the Catch Tower;
//   - the launch mount the pad is fitted with for the rocket on it (js/render/padfit.js planPadFit and drawMount: the
//     same plan, recorded the same way), from the moment that rocket stands there. The rocket it was fitted to rests on
//     the deck inside it, so the mount is not solid to that rocket until it has risen clear of it; after that, falling
//     back, it lands on the ring, not through it. The clamps and the tower's swing arms are not solid (they swing away
//     at lift-off), nor are trees, cars, lamps' heads, fences, paving and markings.
// The Catch Tower's column and arms are js/core/tower.js; this file uses its pieces (eachBall, strikeSteel), so a part
// meets a building exactly as it meets the tower.
//
//   stepStructures(world, ev)   called by the world after every physics sub-step
//   structureDistance(x, y, z)  distance (m) from a point in the pad's frame to the nearest solid, for tests and tools
//   STRUCTURES                  { solid: true } (false switches it off, as tests of other things may want)
import { SITE_SOLIDS, SITE_GROUPS } from './sitesolids.js';
import { planPadFit, drawMount } from '../render/padfit.js';
import { siteFrame, strikeSteel, STEEL_N } from './tower.js';
import { SYSTEM } from './bodies.js';
import { Vector3 } from '../lib/three.module.min.js';

export const STRUCTURES = { solid: true };

const NAMES = {
  hangar: 'the Vehicle Assembly Building', pad: 'the launch pad', runway: 'the runway buildings', spaceplane: 'the Spaceplane Hangar',
  tracking: 'the Tracking Station', research: 'the Research Lab', missions: 'Mission Control', crew: 'the Crew Quarters',
  school: 'the Flight School', admin: 'the Administration building', scenery: 'a building', crawler: 'the crawler',
  bay: 'the Tall Bay', mount: 'the launch mount',
};

// ---------------------------------------------------------------------------------------------
// Shapes: each compiled to { t, …, x0, x1, y0, y1, z0, z1 (its box), name }
// ---------------------------------------------------------------------------------------------
function compile(s, name) {
  const o = { t: s[0], name };
  if (s[0] === 'box') {
    const [, cx, cy, cz, hx, hy, hz, m] = s;
    Object.assign(o, { cx, cy, cz, hx, hy, hz, m: m || null });
    let ex = hx, ey = hy, ez = hz;
    if (m) {   // the box's reach along the frame's axes
      ex = Math.abs(m[0]) * hx + Math.abs(m[3]) * hy + Math.abs(m[6]) * hz;
      ey = Math.abs(m[1]) * hx + Math.abs(m[4]) * hy + Math.abs(m[7]) * hz;
      ez = Math.abs(m[2]) * hx + Math.abs(m[5]) * hy + Math.abs(m[8]) * hz;
    }
    Object.assign(o, { x0: cx - ex, x1: cx + ex, y0: cy - ey, y1: cy + ey, z0: cz - ez, z1: cz + ez });
  } else if (s[0] === 'cap') {
    const [, ax, ay, az, bx, by, bz, r] = s;
    const dx = bx - ax, dy = by - ay, dz = bz - az, L2 = dx * dx + dy * dy + dz * dz;
    Object.assign(o, { ax, ay, az, dx, dy, dz, L2, r, x0: Math.min(ax, bx) - r, x1: Math.max(ax, bx) + r, y0: Math.min(ay, by) - r, y1: Math.max(ay, by) + r, z0: Math.min(az, bz) - r, z1: Math.max(az, bz) + r });
  } else if (s[0] === 'cyl') {
    const [, x, y0, z, r, h] = s;
    Object.assign(o, { x, z, r, yb: y0, yt: y0 + h, x0: x - r, x1: x + r, y0, y1: y0 + h, z0: z - r, z1: z + r });
  } else {
    const [, x, y, z, r, sy] = s;
    Object.assign(o, { x, y, z, r, sy: sy || 1, x0: x - r, x1: x + r, y0: y - r * (sy || 1), y1: y + r * (sy || 1), z0: z - r, z1: z + r });
  }
  return o;
}

/** Signed distance (m) from (x, y, z) to shape o (negative inside), with its outward direction left in STEEL_N. */
function distanceTo(o, x, y, z) {
  if (o.t === 'box') {
    let lx = x - o.cx, ly = y - o.cy, lz = z - o.cz;
    const m = o.m;
    if (m) { const a = lx * m[0] + ly * m[1] + lz * m[2], b = lx * m[3] + ly * m[4] + lz * m[5], c = lx * m[6] + ly * m[7] + lz * m[8]; lx = a; ly = b; lz = c; }
    const qx = Math.abs(lx) - o.hx, qy = Math.abs(ly) - o.hy, qz = Math.abs(lz) - o.hz;
    let nx, ny, nz, d;
    if (qx > 0 || qy > 0 || qz > 0) {
      const ox = Math.max(qx, 0), oy = Math.max(qy, 0), oz = Math.max(qz, 0);
      d = Math.hypot(ox, oy, oz);
      nx = Math.sign(lx) * ox / d; ny = Math.sign(ly) * oy / d; nz = Math.sign(lz) * oz / d;
    } else {
      d = Math.max(qx, qy, qz); nx = ny = nz = 0;
      if (d === qy) ny = ly < 0 ? -1 : 1; else if (d === qx) nx = lx < 0 ? -1 : 1; else nz = lz < 0 ? -1 : 1;
    }
    if (m) STEEL_N.set(nx * m[0] + ny * m[3] + nz * m[6], nx * m[1] + ny * m[4] + nz * m[7], nx * m[2] + ny * m[5] + nz * m[8]);
    else STEEL_N.set(nx, ny, nz);
    return d;
  }
  if (o.t === 'cap') {
    const px = x - o.ax, py = y - o.ay, pz = z - o.az;
    const t = o.L2 > 1e-12 ? Math.max(0, Math.min(1, (px * o.dx + py * o.dy + pz * o.dz) / o.L2)) : 0;
    const ex = px - o.dx * t, ey = py - o.dy * t, ez = pz - o.dz * t, l = Math.hypot(ex, ey, ez);
    if (l > 1e-9) STEEL_N.set(ex / l, ey / l, ez / l); else STEEL_N.set(0, 1, 0);
    return l - o.r;
  }
  if (o.t === 'cyl') {
    const dx = x - o.x, dz = z - o.z, rr = Math.hypot(dx, dz), qr = rr - o.r, qy = Math.max(o.yb - y, y - o.yt);
    if (qr > 0 || qy > 0) {
      const a = Math.max(qr, 0), b = Math.max(qy, 0), d = Math.hypot(a, b), up = y > o.yt ? 1 : -1;
      const h = rr > 1e-9 ? a / d / rr : 0;
      STEEL_N.set(dx * h, up * b / d, dz * h);
      return d;
    }
    if (qy > qr) STEEL_N.set(0, y > (o.yb + o.yt) / 2 ? 1 : -1, 0); else if (rr > 1e-9) STEEL_N.set(dx / rr, 0, dz / rr); else STEEL_N.set(1, 0, 0);
    return Math.max(qr, qy);
  }
  // a ball, squashed upright by sy (near enough: measured in the stretched space, scaled back by the smaller axis)
  const dx = x - o.x, dy = (y - o.y) / o.sy, dz = z - o.z, l = Math.hypot(dx, dy, dz);
  if (l > 1e-9) { const n = Math.hypot(dx, dy / o.sy, dz); STEEL_N.set(dx / n, dy / o.sy / n, dz / n); } else STEEL_N.set(0, 1, 0);
  return (l - o.r) * Math.min(1, o.sy);
}

// ---------------------------------------------------------------------------------------------
// The fixed space centre, in 32 m cells
// ---------------------------------------------------------------------------------------------
const CELL = 32;
let FIXED = null;
function fixed() {
  if (FIXED) return FIXED;
  const list = [];
  for (const [g, [a, b]] of Object.entries(SITE_GROUPS)) for (let i = a; i < b; i++) list.push(compile(SITE_SOLIDS[i], NAMES[g] || 'a building'));
  const cells = new Map();
  let X0 = Infinity, X1 = -Infinity, Z0 = Infinity, Z1 = -Infinity, Y1 = 0;
  for (const o of list) {
    X0 = Math.min(X0, o.x0); X1 = Math.max(X1, o.x1); Z0 = Math.min(Z0, o.z0); Z1 = Math.max(Z1, o.z1); Y1 = Math.max(Y1, o.y1);
    for (let i = Math.floor(o.x0 / CELL); i <= Math.floor(o.x1 / CELL); i++) for (let j = Math.floor(o.z0 / CELL); j <= Math.floor(o.z1 / CELL); j++) {
      const k = i * 4096 + j; let c = cells.get(k); if (!c) cells.set(k, c = []); c.push(o);
    }
  }
  return (FIXED = { list, cells, X0, X1, Z0, Z1, Y1 });
}

/** The candidates near a box in the pad's frame, gathered into `out` (each once). */
let _stamp = 0;
function gather(x0, x1, y0, y1, z0, z1, out, mount) {
  const F = fixed(), st = ++_stamp;
  out.length = 0;
  if (x1 >= F.X0 && x0 <= F.X1 && z1 >= F.Z0 && z0 <= F.Z1 && y0 <= F.Y1) {
    for (let i = Math.floor(x0 / CELL); i <= Math.floor(x1 / CELL); i++) for (let j = Math.floor(z0 / CELL); j <= Math.floor(z1 / CELL); j++) {
      const c = F.cells.get(i * 4096 + j); if (!c) continue;
      for (const o of c) if (o._st !== st && o.x1 >= x0 && o.x0 <= x1 && o.y1 >= y0 && o.y0 <= y1 && o.z1 >= z0 && o.z0 <= z1) { o._st = st; out.push(o); }
    }
  }
  if (mount) for (const o of mount) if (o.x1 >= x0 && o.x0 <= x1 && o.y1 >= y0 && o.y0 <= y1 && o.z1 >= z0 && o.z0 <= z1) out.push(o);
  return out;
}

// ---------------------------------------------------------------------------------------------
// The launch mount fitted to the rocket on the pad
// ---------------------------------------------------------------------------------------------
/** drawMount's shapes, as solids (the drawing puts the plan 8.5 cm up, on the deck the rocket rests on). */
function mountSolids(plan) {
  const out = [], up = 0.085, keep = s => { if (s[0] === 'box' ? s[2] + s[5] > 0.12 : true) out.push(compile(s, NAMES.mount)); };
  const k = {
    box(bucket, x, y0, z, w, h, d, color, ry = 0) {
      const s = ['box', x, y0 + up + h / 2, z, w / 2, h / 2, d / 2];
      if (ry) { const c = Math.cos(ry), sn = Math.sin(ry); s.push([c, 0, -sn, 0, 1, 0, sn, 0, c]); }
      keep(s);
    },
    beam(bucket, a, b, th) { keep(['cap', a[0], a[1] + up, a[2], b[0], b[1] + up, b[2], th * 0.6]); },
    cyl() { /* bolts */ }, tube() {},
  };
  drawMount(k, plan);
  return out;
}
/** Keeps world._padMount in step with the rocket standing on the pad, as the drawing does (js/ui/flightscene.js
 *  fitPadTo): a new one is planned when a rocket stands there, and the steel stays until another comes. */
function stepMount(world, home) {
  let pv = null;
  for (const v of world.vessels) if (!v.dead && v.launchSite === 'pad' && v.landed && !v.launched && v.situation === 'prelaunch' && v.body === home) { pv = v; break; }
  if (!pv) return world._padMount || null;
  const key = pv.id + ':' + pv.parts.size;
  const m = world._padMount;
  if (m && m.key === key) return m;
  let plan = null;
  try { plan = planPadFit(pv); } catch { plan = null; }
  return (world._padMount = { key, owner: pv, clear: false, top: plan ? plan.columns.reduce((t, c) => Math.max(t, c.top ?? c.h), 0) : 0, solids: plan ? mountSolids(plan) : [] });
}

// ---------------------------------------------------------------------------------------------
// Stepping
// ---------------------------------------------------------------------------------------------
const _near = [], _rel = { x: 0, y: 0, z: 0 };
let R_BODY = 1;
const _hit = {
  type: 'structureStrike', reason: 'structure', near: _near, name: '',
  distance(p, x, y, z, r) {
    // the frame is flat, the ground is not: a point d metres out stands d²/2R higher above the ground than it seems
    const yy = y + (x * x + z * z) / (2 * R_BODY), r2 = (r + 0.05) * (r + 0.05);
    let best = Infinity, bx = 0, by = 1, bz = 0, nm = '';
    for (let i = 0; i < this.near.length; i++) {
      const o = this.near[i];
      // (only what the ball's own box reaches is measured)
      const ox = x < o.x0 ? o.x0 - x : x > o.x1 ? x - o.x1 : 0, oy = yy < o.y0 ? o.y0 - yy : yy > o.y1 ? yy - o.y1 : 0, oz = z < o.z0 ? o.z0 - z : z > o.z1 ? z - o.z1 : 0;
      if (ox * ox + oy * oy + oz * oz > r2) continue;
      const d = distanceTo(o, x, yy, z);
      if (d < best) { best = d; bx = STEEL_N.x; by = STEEL_N.y; bz = STEEL_N.z; nm = o.name; }
    }
    STEEL_N.set(bx, by, bz); if (best < r) this.name = nm;
    return best;
  },
  what() { return this.name || 'a building'; },
};

/** How far the vessel's parts reach from its centre of mass: along its own axis (lo … hi) and out from it (r). Kept
 *  for a second, or until it loses or gains a part. */
function shape(v, ut) {
  let s = v._structShape;
  if (s && s.n === v.parts.size && ut - s.ut < 1 && ut >= s.ut) return s;
  s = v._structShape = { n: v.parts.size, ut, lo: 0, hi: 0, r: 0 };
  const c = v.com;
  for (const p of v.partList) {
    const d = p.def, h = (d.h || 0) / 2, big = Math.max(d.r || 0, d.rBottom || 0, d.rTop || 0, d.rw || 0, h, 0.3);
    const y = p.pos.y - c.y;
    s.lo = Math.min(s.lo, y - big); s.hi = Math.max(s.hi, y + big);
    s.r = Math.max(s.r, Math.hypot(p.pos.x - c.x, p.pos.z - c.z) + big);
  }
  return s;
}
const _u = new Vector3();

/** For tests and tools: the distance (m) from a point in the pad's frame (on a flat frame: no curvature) to the nearest
 *  fixed solid, and that solid's name. → { d, name, n: [x, y, z] } */
export function structureDistance(x, y, z, world = null) {
  const near = gather(x - 60, x + 60, y - 60, y + 60, z - 60, z + 60, [], world && world._padMount ? world._padMount.solids : null);
  let best = Infinity, name = '', n = [0, 1, 0];
  for (const o of near) { const d = distanceTo(o, x, y, z); if (d < best) { best = d; name = o.name; n = [STEEL_N.x, STEEL_N.y, STEEL_N.z]; } }
  return { d: best, name, n };
}

/** After every physics sub-step: each loaded vessel near the space centre against its solids. */
export function stepStructures(world, ev) {
  if (!STRUCTURES.solid) return;
  const pad = SYSTEM.sites && SYSTEM.sites.pad, home = SYSTEM.home;
  const loaded = world._loaded || world.vessels;
  if (!pad || !home) return;
  let any = false;
  for (const v of loaded) if (!v.dead && v.body === home) { any = true; break; }
  if (!any) return;
  const mount = stepMount(world, home);
  const F = fixed();
  for (let i = 0; i < loaded.length; i++) {
    const v = loaded[i];
    if (v.dead || v.landed || v.body !== home || v.type === 'eva') continue;
    const fr = siteFrame(home, pad, world.ut);
    // quick test: the vessel's ball against the space centre's box
    _rel.x = v.pos.x - fr.o.x; _rel.y = v.pos.y - fr.o.y; _rel.z = v.pos.z - fr.o.z;
    const ex = _rel.x * fr.east.x + _rel.y * fr.east.y + _rel.z * fr.east.z;
    const sz = _rel.x * fr.south.x + _rel.y * fr.south.y + _rel.z * fr.south.z;
    const b = (v._bound || 1) + 2;
    if (ex + b < F.X0 || ex - b > F.X1 || sz + b < F.Z0 || sz - b > F.Z1) continue;
    R_BODY = home.radius;
    const uy = (_rel.x * fr.up.x + _rel.y * fr.up.y + _rel.z * fr.up.z) + (ex * ex + sz * sz) / (2 * R_BODY);
    if (uy - b > F.Y1 + 2) continue;
    // the mount is not solid to the rocket it was fitted round until that has risen clear of it
    let ms = mount && mount.solids.length ? mount.solids : null;
    if (ms && mount.owner === v && !mount.clear) {
      if (Math.hypot(ex, sz) > 40 || uy - (v._bound || 1) > mount.top + 1) mount.clear = true;
      else ms = null;
    }
    // the vessel as a drum along its own axis (a tall rocket is narrow: its ball would take in the service tower)
    const sh = shape(v, world.ut), ax = _u.set(0, 1, 0).applyQuaternion(v.q);
    const ux = ax.dot(fr.east), uu = ax.dot(fr.up), us = ax.dot(fr.south), rr = sh.r + 1;
    const ax0 = ex + ux * sh.lo, ay0 = uy + uu * sh.lo, az0 = sz + us * sh.lo, ax1 = ex + ux * sh.hi, ay1 = uy + uu * sh.hi, az1 = sz + us * sh.hi;
    if (!gather(Math.min(ax0, ax1) - rr, Math.max(ax0, ax1) + rr, Math.min(ay0, ay1) - rr, Math.max(ay0, ay1) + rr, Math.min(az0, az1) - rr, Math.max(az0, az1) + rr, _near, ms).length) continue;
    _hit.name = '';
    strikeSteel(world, v, ev, _hit);
  }
}
