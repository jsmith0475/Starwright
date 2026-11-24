// Starwright — parts that span a gap: the Brace Strut and the Sip Fuel Line.
//
// One rule says where the far end of such a part goes, and both the structure (which joints a strut braces) and the
// drawing (how long the strut or hose is, and where its far fitting sits) read it from here, so what is drawn joined
// is what the physics treats as joined.
//
// The part is mounted by one end on its host. From the mount it looks along its own outward axis:
//   1. the rule the structure has always had: its nominal tip (def.rw from the mount) lies within `reach` of another
//      part. Designs braced before are braced the same way now;
//   2. otherwise the first stack part its axis meets within SPAN.MAX metres of the mount.
// No DOM, no three.js: plain numbers in craft coordinates.

export const SPAN = {
  MAX: 4,          // m: the longest a strut or a hose is made
  REACH: 0.25,     // m: how near the nominal tip must come to a part (the same number as STRUCT.STRUT_REACH)
  STEP: 0.02,      // m: step of the search along the axis
};

/** Is this part definition one that spans from its host to another part? */
export const isSpan = def => !!def && (def.shape === 'strut' || def.shape === 'fuelline');
const isStack = d => !!(d.attach && d.attach.stack);

/** Outward axis of a radial part in craft coordinates: Ry(rot) · Rx(flip) · Rz(pitch) applied to +X. */
export function spanAxis(p, out = {}) {
  const pt = p.pitch || 0, cx = Math.cos(pt), sy = Math.sin(pt) * (p.flip ? -1 : 1), a = p.rot || 0;
  out.x = Math.cos(a) * cx; out.y = sy; out.z = -Math.sin(a) * cx;
  return out;
}

/** Radius of a stack part's skin at craft height y (straight taper between its two ends). */
function skinRadius(p, d, y) {
  let rt = d.rTop ?? d.r ?? 0.3, rb = d.rBottom ?? d.r ?? 0.3;
  if (p.flip) { const t = rt; rt = rb; rb = t; }
  const u = Math.min(1, Math.max(0, (y - (p.pos.y - d.h / 2)) / (d.h || 1)));
  return rb + (rt - rb) * u;
}

/** The point of a stack part's skin nearest to (x, y, z), and the outward normal there. */
function onSkin(p, d, x, y, z, out) {
  const yy = Math.min(p.pos.y + d.h / 2, Math.max(p.pos.y - d.h / 2, y));
  let dx = x - p.pos.x, dz = z - p.pos.z, l = Math.hypot(dx, dz);
  if (l < 1e-9) { dx = 1; dz = 0; l = 1; }
  const r = skinRadius(p, d, yy);
  out.nx = dx / l; out.ny = 0; out.nz = dz / l;
  out.x = p.pos.x + out.nx * r; out.y = yy; out.z = p.pos.z + out.nz * r;
  return out;
}

/**
 * Where the far end of a spanning part goes.
 * @param {Iterable} parts   every part of the craft or vessel ({ id, pos, rot, flip?, pitch?, roll? })
 * @param {object} s         the strut or fuel line
 * @param {function} defOf   part → its definition
 * @param {object|null} host the part it is mounted on (never its own target)
 * @param {number} [reach]   SPAN.REACH
 * @returns {null | { part, near, len, x, y, z, nx, ny, nz, tx, ty, tz }}
 *   part = the part reached; near = true when rule 1 found it; len = mount to far end (m); (x, y, z) = the far end
 *   and (nx, ny, nz) the outward normal of the surface there, craft coordinates; (tx, ty, tz) = the point the
 *   structure takes the brace to act at (the nominal tip under rule 1, the far end under rule 2).
 */
export function spanTarget(parts, s, defOf, host, reach = SPAN.REACH) {
  const sd = defOf(s), half = (sd.rw || 0.9) / 2, ax = spanAxis(s, _ax);
  const mx = s.pos.x - ax.x * half, my = s.pos.y - ax.y * half, mz = s.pos.z - ax.z * half;      // the mount
  const tx = s.pos.x + ax.x * half, ty = s.pos.y + ax.y * half, tz = s.pos.z + ax.z * half;      // the nominal tip
  const res = { part: null, near: false, len: 0, x: 0, y: 0, z: 0, nx: 0, ny: 0, nz: 0, tx, ty, tz };
  // 1. the nominal tip is at another part
  for (const p of parts) {
    if (p === s || p === host) continue;
    const d = defOf(p);
    if (isSpan(d)) continue;
    if (isStack(d)) {
      if (Math.abs(ty - p.pos.y) > d.h / 2 + reach) continue;
      const rr = Math.max(d.rTop ?? d.r ?? 0.3, d.rBottom ?? d.r ?? 0.3);
      if (Math.hypot(tx - p.pos.x, tz - p.pos.z) > rr + reach) continue;
      // drawn to the skin where the axis meets it (or, when the axis passes beside the part, the nearest of the skin)
      const hit = alongAxis(p, d, mx, my, mz, ax, 2 * half + reach + 2 * rr) ?? onSkin(p, d, tx, ty, tz, _pt);
      res.x = hit.x; res.y = hit.y; res.z = hit.z; res.nx = hit.nx; res.ny = hit.ny; res.nz = hit.nz;
    } else {
      if (Math.hypot(tx - p.pos.x, ty - p.pos.y, tz - p.pos.z) > Math.max(d.rw || 0.2, d.h || 0.2) / 2 + reach) continue;
      res.x = tx; res.y = ty; res.z = tz; res.nx = ax.x; res.ny = ax.y; res.nz = ax.z;      // a fitting on a fitting: its made length
    }
    res.part = p; res.near = true;
    res.len = Math.hypot(res.x - mx, res.y - my, res.z - mz);
    return res;
  }
  // 2. the first stack part along the axis
  let best = null, bestT = SPAN.MAX;
  for (const p of parts) {
    if (p === s || p === host) continue;
    const d = defOf(p);
    if (!isStack(d) || p.pitch || p.roll) continue;
    // (cheap reject: farther from the mount than the search goes)
    const rr = Math.max(d.rTop ?? d.r ?? 0.3, d.rBottom ?? d.r ?? 0.3);
    if (Math.hypot(p.pos.x - mx, p.pos.z - mz) > SPAN.MAX + rr || Math.abs(p.pos.y - my) > SPAN.MAX + d.h / 2) continue;
    const hit = alongAxis(p, d, mx, my, mz, ax, bestT);
    if (hit && hit.t < bestT) { bestT = hit.t; best = p; res.x = hit.x; res.y = hit.y; res.z = hit.z; res.nx = hit.nx; res.ny = hit.ny; res.nz = hit.nz; }
  }
  if (!best) return null;
  res.part = best; res.len = bestT; res.tx = res.x; res.ty = res.y; res.tz = res.z;
  return res;
}
const _ax = {}, _pt = {}, _hit = {};

/** First point within tMax of the mount where the axis enters the stack part p: { t, x, y, z, nx, ny, nz } or null. */
function alongAxis(p, d, mx, my, mz, ax, tMax) {
  const y0 = p.pos.y - d.h / 2, y1 = p.pos.y + d.h / 2;
  const inside = t => {
    const y = my + ax.y * t;
    if (y < y0 || y > y1) return false;
    return Math.hypot(mx + ax.x * t - p.pos.x, mz + ax.z * t - p.pos.z) <= skinRadius(p, d, y);
  };
  if (inside(0)) return null;            // mounted inside it (a part sunk into its neighbour): not a gap to span
  let a = 0, b = -1;
  for (let t = SPAN.STEP; t <= tMax; t += SPAN.STEP) { if (inside(t)) { b = t; break; } a = t; }
  if (b < 0) return null;
  for (let i = 0; i < 12; i++) { const m = (a + b) / 2; if (inside(m)) b = m; else a = m; }
  const x = mx + ax.x * b, y = my + ax.y * b, z = mz + ax.z * b, h = _hit;
  h.t = b; h.x = x; h.y = y; h.z = z;
  // through the skin, or through an end face
  if (y - y0 < 1e-3 && ax.y > 0) { h.nx = 0; h.ny = -1; h.nz = 0; }
  else if (y1 - y < 1e-3 && ax.y < 0) { h.nx = 0; h.ny = 1; h.nz = 0; }
  else { const dx = x - p.pos.x, dz = z - p.pos.z, l = Math.hypot(dx, dz) || 1; h.nx = dx / l; h.ny = 0; h.nz = dz / l; }
  return h;
}

/** spanTarget for a part of a flying vessel (its host is the one part it is linked to), or of a craft in the builder. */
export function vesselSpan(v, p) {
  const host = p.links && p.links.length ? v.parts.get(p.links[0]) : null;
  return host ? spanTarget(v.parts.values(), p, defOfVessel, host) : null;
}
const defOfVessel = p => p.def;
