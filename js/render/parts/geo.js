// Starwright part geometry kit: a small builder that collects primitives into per-material buckets and
// merges each bucket into one mesh (one draw call per material per part).
//
// Conventions: +Y is the part axis. Angles around the axis: direction(a) = (cos a, 0, sin a), so a = 0
// faces +X ("outward" for radial parts). Hull-type UVs are laid out in metres (see HULL_TILE).
import * as THREE from '../../lib/three.module.min.js';
import { mat, NO_SHADOW, NO_TINT, PALETTE } from './materials.js';
import { HULL_TILE, decalUV, decalRow } from './textures.js';

export const P = PALETTE;
export const TAU = Math.PI * 2;
const _q = new THREE.Quaternion(), _e = new THREE.Euler(), _v = new THREE.Vector3(), _s = new THREE.Vector3(), _c = new THREE.Color();
const UP = new THREE.Vector3(0, 1, 0);

export function M(x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0, sx = 1, sy = 1, sz = 1) {
  return new THREE.Matrix4().compose(_v.set(x, y, z), _q.setFromEuler(_e.set(rx, ry, rz)), _s.set(sx, sy, sz));
}
/** Matrix placing an object whose local axis `from` should point along `dir`, at position p. */
export function Mdir(p, dir, from = UP, s = [1, 1, 1]) {
  return new THREE.Matrix4().compose(p, new THREE.Quaternion().setFromUnitVectors(from, dir.clone().normalize()), new THREE.Vector3(...s));
}
/** Matrix for something mounted on the hull at angle a, radius r, height y: local +X = outward, +Y = up. */
export function Mrad(a, r, y, tilt = 0) {
  return new THREE.Matrix4().makeRotationY(-a).multiply(new THREE.Matrix4().makeTranslation(r, y, 0)).multiply(new THREE.Matrix4().makeRotationZ(tilt));
}
export const mul = (...ms) => ms.reduce((a, b) => a.clone().multiply(b));

/** Merge [{geo, color, m, uScale, vScale}] into one non-indexed geometry with position/normal/uv/color.
 *  color: hex | (THREE.Color, x, y, z, i) => void | null (keep the geometry's own colour attribute). */
export function mergeGeometries(items) {
  let n = 0;
  const parts = items.map(({ geo, color, m, uScale, vScale }) => {
    const g = geo.index ? geo.toNonIndexed() : geo.clone();
    if (m) g.applyMatrix4(m);
    n += g.attributes.position.count;
    return { g, color, uScale: uScale || 1, vScale: vScale || 1 };
  });
  const pos = new Float32Array(n * 3), nor = new Float32Array(n * 3), uv = new Float32Array(n * 2), col = new Float32Array(n * 3);
  let o = 0;
  for (const { g, color, uScale, vScale } of parts) {
    const c = g.attributes.position.count;
    pos.set(g.attributes.position.array.subarray(0, c * 3), o * 3);
    if (g.attributes.normal) nor.set(g.attributes.normal.array.subarray(0, c * 3), o * 3);
    if (g.attributes.uv) {
      const a = g.attributes.uv.array;
      for (let i = 0; i < c; i++) { uv[(o + i) * 2] = a[i * 2] * uScale; uv[(o + i) * 2 + 1] = a[i * 2 + 1] * vScale; }
    }
    if (typeof color === 'function') {
      const pa = g.attributes.position.array;
      for (let i = 0; i < c; i++) { color(_c, pa[i * 3], pa[i * 3 + 1], pa[i * 3 + 2], i); col[(o + i) * 3] = _c.r; col[(o + i) * 3 + 1] = _c.g; col[(o + i) * 3 + 2] = _c.b; }
    } else if ((color === null || color === undefined) && g.attributes.color) {
      col.set(g.attributes.color.array.subarray(0, c * 3), o * 3);
    } else {
      _c.set(color ?? 0xffffff);
      for (let i = 0; i < c; i++) { col[(o + i) * 3] = _c.r; col[(o + i) * 3 + 1] = _c.g; col[(o + i) * 3 + 2] = _c.b; }
    }
    o += c; g.dispose();
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  out.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  out.setAttribute('color', new THREE.BufferAttribute(col, 3));
  out.computeBoundingSphere(); out.computeBoundingBox();
  return out;
}

/**
 * Surface of revolution around +Y. `profile` is a list of [r, y, colour?]; a colour applies from that point on.
 * Walking the profile upward makes an outward-facing wall, walking it downward an inward-facing one, so a closed
 * loop gives a solid with wall thickness. Edges sharper than `crease` radians stay hard; the rest are smoothed.
 * UVs: u = angle fraction × uRep, v = arc length along the profile ÷ vTile (or 0..1 across the profile when vFit).
 */
export function revolve(profile, { seg = 24, uRep = 1, vTile = HULL_TILE, a0 = 0, a1 = TAU, crease = 0.55, color = 0xffffff, vOff = 0, uOff = 0, vFit = false } = {}) {
  const pts = []; let cur = color;
  for (const p of profile) { if (p[2] !== undefined) cur = p[2]; pts.push({ r: Math.max(p[0], 0), y: p[1], c: cur }); }
  const segs = []; let arc = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1], dr = b.r - a.r, dy = b.y - a.y, len = Math.hypot(dr, dy);
    if (len < 1e-6) continue;
    segs.push({ a, b, nr: dy / len, ny: -dr / len, v0: arc, v1: arc + len, c: a.c, i }); arc += len;
  }
  const cosC = Math.cos(crease);
  for (let k = 0; k < segs.length; k++) {
    const s = segs[k], pv = segs[k - 1], nx = segs[k + 1];
    const blend = (o) => { if (!o || o.nr * s.nr + o.ny * s.ny < cosC) return [s.nr, s.ny]; const x = o.nr + s.nr, y = o.ny + s.ny, l = Math.hypot(x, y) || 1; return [x / l, y / l]; };
    s.n0 = blend(pv && pv.b === s.a ? pv : null); s.n1 = blend(nx && nx.a === s.b ? nx : null);
  }
  const closedLoop = segs.length > 1 && Math.abs(pts[0].r - pts[pts.length - 1].r) < 1e-6 && Math.abs(pts[0].y - pts[pts.length - 1].y) < 1e-6;
  if (closedLoop) { // smooth across the join too
    const s = segs[0], e = segs[segs.length - 1];
    if (s.nr * e.nr + s.ny * e.ny >= cosC) { const x = s.nr + e.nr, y = s.ny + e.ny, l = Math.hypot(x, y) || 1; s.n0 = [x / l, y / l]; e.n1 = [x / l, y / l]; }
  }
  const N = segs.length * seg * 6, pos = new Float32Array(N * 3), nor = new Float32Array(N * 3), uv = new Float32Array(N * 2), col = new Float32Array(N * 3);
  let o = 0;
  const cs = [], sn = [];
  for (let i = 0; i <= seg; i++) { const t = a0 + (a1 - a0) * i / seg; cs.push(Math.cos(t)); sn.push(Math.sin(t)); }
  const put = (p, n, i, v, c) => {
    pos[o * 3] = p.r * cs[i]; pos[o * 3 + 1] = p.y; pos[o * 3 + 2] = p.r * sn[i];
    nor[o * 3] = n[0] * cs[i]; nor[o * 3 + 1] = n[1]; nor[o * 3 + 2] = n[0] * sn[i];
    uv[o * 2] = uOff + (a0 + (a1 - a0) * i / seg) / TAU * uRep; uv[o * 2 + 1] = v;
    col[o * 3] = c.r; col[o * 3 + 1] = c.g; col[o * 3 + 2] = c.b; o++;
  };
  const cc = new THREE.Color();
  for (const s of segs) {
    cc.set(s.c);
    const v0 = vFit ? s.v0 / arc : vOff + s.v0 / vTile, v1 = vFit ? s.v1 / arc : vOff + s.v1 / vTile;
    for (let i = 0; i < seg; i++) {
      if (s.a.r > 1e-6) { put(s.a, s.n0, i, v0, cc); put(s.b, s.n1, i, v1, cc); put(s.a, s.n0, i + 1, v0, cc); }
      if (s.b.r > 1e-6) { put(s.b, s.n1, i, v1, cc); put(s.b, s.n1, i + 1, v1, cc); put(s.a, s.n0, i + 1, v0, cc); }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos.subarray(0, o * 3), 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nor.subarray(0, o * 3), 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv.subarray(0, o * 2), 2));
  g.setAttribute('color', new THREE.BufferAttribute(col.subarray(0, o * 3), 3));
  return g;
}

/** Box with all twelve edges chamfered by b. UVs in metres. */
export function chamferBox(w, h, d, b) {
  b = Math.min(b, w / 2 - 1e-4, h / 2 - 1e-4, d / 2 - 1e-4);
  const s = new THREE.Shape(), x = w / 2 - b, y = h / 2 - b;
  s.moveTo(-x, -y); s.lineTo(x, -y); s.lineTo(x, y); s.lineTo(-x, y); s.closePath();
  const g = new THREE.ExtrudeGeometry(s, { depth: d - 2 * b, bevelEnabled: true, bevelSize: b, bevelThickness: b, bevelSegments: 1, curveSegments: 1 });
  g.translate(0, 0, -(d - 2 * b) / 2);
  return g;
}
/** Extrude a 2D outline [[x, y], ...] (in the XY plane) to depth d along Z, centred, optionally bevelled. */
export function extrudePoly(pts, d, bevel = 0) {
  const s = new THREE.Shape(); pts.forEach((p, i) => (i ? s.lineTo(p[0], p[1]) : s.moveTo(p[0], p[1]))); s.closePath();
  const b = Math.min(bevel, d / 2 - 1e-4);
  const g = new THREE.ExtrudeGeometry(s, b > 0 ? { depth: d - 2 * b, bevelEnabled: true, bevelSize: b, bevelThickness: b, bevelSegments: 1, curveSegments: 6 } : { depth: d, bevelEnabled: false, curveSegments: 6 });
  g.translate(0, 0, b > 0 ? -(d - 2 * b) / 2 : -d / 2);
  return g;
}

// Buckets whose UVs are in metres and need scaling to their texture tile.
const TILE = { hull: 1 / HULL_TILE, metal: 1, foil: 2, solar: 2, tile: 1, bell: 1, rubber: 1, canopy: 1 };
// Flat colours used when everything collapses into the single 'lod' material.
const LOD_TINT = { solar: 0x1c3a8a, tile: 0x3a2e28, rubber: 0x55565a, glass: 0x1a2a33, bell: 0x8a8f96, metal: 0xb0b6bd, chrome: 0xd0d4d8, glow: 0x2a1408, beam: 0xfff2d0 };

export class PB {
  /** q: 2 = high, 1 = medium, 0 = low (single flat material, no small detail). */
  constructor(q = 2) { this.q = q; this.b = {}; }
  get hi() { return this.q >= 2; }
  get med() { return this.q >= 1; }
  add(geo, color, m = null, bucket = 'paint', uScale = 1, vScale = 1) {
    (this.b[bucket] = this.b[bucket] || []).push({ geo, color, m, uScale, vScale });
    return this;
  }
  /** Segment count around a circle of radius r at this quality. */
  seg(r, k = 1) {
    const base = r > 1.5 ? 56 : r > 1 ? 48 : r > 0.45 ? 36 : r > 0.2 ? 24 : r > 0.07 ? 14 : 8;
    return Math.max(6, Math.round(base * k * (this.q >= 2 ? 1 : this.q === 1 ? 0.66 : 0.34) / 2) * 2);
  }
  rev(profile, bucket = 'hull', o = {}) {
    let rMax = 0; for (const p of profile) rMax = Math.max(rMax, p[0]);
    const opt = { seg: this.seg(rMax), ...o };
    // foil and solar tiles are 0.5 m square: wrap them at that size so the crinkles are not smeared sideways
    if (opt.uRep === undefined) opt.uRep = bucket === 'hull' ? Math.max(1, Math.round(TAU * rMax / HULL_TILE)) : bucket === 'bell' ? Math.max(1, Math.round(TAU * rMax / 0.9)) : bucket === 'foil' || bucket === 'solar' ? Math.max(1, Math.round(TAU * rMax / 0.5)) : Math.max(1, Math.round(TAU * rMax));
    if (opt.vTile === undefined) opt.vTile = bucket === 'hull' ? HULL_TILE : bucket === 'foil' || bucket === 'solar' ? 0.5 : 1;
    return this.add(revolve(profile, opt), null, o.m || null, bucket);
  }
  // solid of revolution with a rectangular section (flanges, collars, hoops)
  ring(rIn, rOut, y0, y1, color, bucket = 'metal', o = {}) {
    return this.rev([[rIn, y0, color], [rOut, y0], [rOut, y1], [rIn, y1], [rIn, y0]], bucket, { crease: 0.3, ...o });
  }
  cyl(rTop, rBot, h, y, color, bucket = 'paint', seg, open = false, m = null) {
    const p = open ? [[rBot, y - h / 2, color], [rTop, y + h / 2]] : [[0, y - h / 2, color], [rBot, y - h / 2], [rTop, y + h / 2], [0, y + h / 2]];
    return this.rev(p, bucket, { seg: seg || this.seg(Math.max(rTop, rBot)), crease: 0.3, m });
  }
  // flat cap with planar UVs in metres
  disc(r, y, up, color, bucket = 'metal', rIn = 0) {
    const g = rIn > 0 ? new THREE.RingGeometry(rIn, r, this.seg(r), 1) : new THREE.CircleGeometry(r, this.seg(r));
    const p = g.attributes.position, uv = g.attributes.uv;
    for (let i = 0; i < p.count; i++) uv.setXY(i, p.getX(i), p.getY(i));
    const k = TILE[bucket] || 1;
    return this.add(g, color, M(0, y, 0, up ? -Math.PI / 2 : Math.PI / 2), bucket, k, k);
  }
  box(w, h, d, color, m, bucket = 'paint') { return this.add(new THREE.BoxGeometry(w, h, d), color, m, bucket); }
  rbox(w, h, d, bev, color, m, bucket = 'paint') {
    if (!this.med) return this.box(w, h, d, color, m, bucket);
    const k = TILE[bucket] || 1; return this.add(chamferBox(w, h, d, bev), color, m, bucket, k, k);
  }
  poly(pts, d, bevel, color, m, bucket = 'paint') { const k = TILE[bucket] || 1; return this.add(extrudePoly(pts, d, this.med ? bevel : 0), color, m, bucket, k, k); }
  sphere(r, color, m, bucket = 'paint', ws = 14, hs = 10) { return this.add(new THREE.SphereGeometry(r, ws, hs), color, m, bucket); }
  torus(R, r, color, m, bucket = 'paint', seg, tube = 8) { return this.add(new THREE.TorusGeometry(R, r, this.med ? tube : 5, seg || this.seg(R)), color, m, bucket); }
  // hoop around the axis at height y
  hoop(R, r, y, color, bucket = 'metal') { return this.torus(R, r, color, M(0, y, 0, Math.PI / 2), bucket); }
  rod(a, b, r, color, bucket = 'paint', seg = 8) {
    const A = new THREE.Vector3(...a), B = new THREE.Vector3(...b), d = B.clone().sub(A), len = d.length();
    return this.add(new THREE.CylinderGeometry(r, r, len, this.med ? seg : 5), color, Mdir(A.clone().add(B).multiplyScalar(0.5), d), bucket);
  }
  // smooth pipe through points
  tube(pts, r, color, bucket = 'metal', { seg = 7, closed = false, tension = 0.5, m = null } = {}) {
    if (!this.med) { for (let i = 0; i < pts.length - 1; i++) this.rod(pts[i], pts[i + 1], r, color, bucket, 5); return this; }
    const curve = new THREE.CatmullRomCurve3(pts.map(p => new THREE.Vector3(...p)), closed, 'catmullrom', tension);
    return this.add(new THREE.TubeGeometry(curve, Math.max(6, pts.length * (this.hi ? 7 : 4)), r, seg, closed), color, m, bucket);
  }
  around(n, fn, a0 = 0) { for (let i = 0; i < n; i++) fn(a0 + i * TAU / n, i); return this; }
  // bolt heads around a ring, axis along +Y (dir = ±1)
  bolts(r, y, n, s = 0.02, color = P.steel, a0 = 0) {
    if (!this.hi) return this;
    const g = new THREE.CylinderGeometry(s, s, s * 1.1, 6);
    return this.around(n, a => this.add(g, color, M(Math.cos(a) * r, y, Math.sin(a) * r), 'metal'), a0);
  }
  // bolt heads pointing outward from the axis
  studs(r, y, n, s = 0.02, color = P.steel, a0 = 0) {
    if (!this.hi) return this;
    const g = new THREE.CylinderGeometry(s, s, s * 1.1, 6);
    return this.around(n, a => this.add(g, color, mul(Mrad(a, r, y), M(0, 0, 0, 0, 0, -Math.PI / 2)), 'metal'), a0);
  }
  /** Curved plate lying on a cylinder/cone: centred on angle `ang`, `w` metres wide (arc), from y0 to y1.
   *  r0/r1 = surface radius at y0/y1; th = how far it stands proud. */
  patch(r0, r1, y0, y1, ang, w, th, color, bucket = 'hull', o = {}) {
    const rm = (r0 + r1) / 2, da = w / rm, n = Math.max(2, Math.ceil(da / (this.hi ? 0.1 : 0.2)));
    const e = Math.min(th, 0.012);
    const prof = [[r0, y0 - e, color], [r0 + th, y0], [r1 + th, y1], [r1, y1 + e]];
    return this.rev(prof, bucket, { seg: n, a0: ang - da / 2, a1: ang + da / 2, crease: 0.9, ...o });
  }
  /** Stamp from the decal atlas wrapped on a cylinder/cone. w = arc width in metres; slope = dr/dy. */
  decal(name, r, y, ang, w, { slope = 0, h, lift = 0.004 } = {}) {
    if (!this.med) return this;
    const [u0, v0, u1, v1, aspect] = decalUV(name), hh = h ?? w / aspect, da = w / r, n = Math.max(2, Math.ceil(da / 0.1));
    const pos = [], nor = [], uv = [];
    const vert = (i, top) => {
      const a = ang + da / 2 - da * i / n, yy = y + (top ? hh / 2 : -hh / 2), rr = r + slope * (yy - y) + lift;
      pos.push(Math.cos(a) * rr, yy, Math.sin(a) * rr); nor.push(Math.cos(a), 0, Math.sin(a)); uv.push(u0 + (u1 - u0) * i / n, top ? v1 : v0);
    };
    for (let i = 0; i < n; i++) { vert(i, 0); vert(i + 1, 0); vert(i, 1); vert(i + 1, 0); vert(i + 1, 1); vert(i, 1); }
    return this._raw(pos, nor, uv, 'decal');
  }
  /** Tiling band from the decal atlas all the way round at radius r (r2 at the top edge for cones). */
  decalBand(name, r, y, h, { r2 = r, lift = 0.004, reps } = {}) {
    if (!this.med) return this;
    const row = decalRow(name), n = this.seg(r), k = reps ?? Math.max(2, Math.round(TAU * r / (h * row.aspect)));
    const pos = [], nor = [], uv = [];
    const vert = (i, top) => {
      const a = -TAU * i / n, rr = (top ? r2 : r) + lift;
      pos.push(Math.cos(a) * rr, y + (top ? h / 2 : -h / 2), Math.sin(a) * rr); nor.push(Math.cos(a), 0, Math.sin(a)); uv.push(i / n * k * row.tileU, top ? row.v1 : row.v0);
    };
    for (let i = 0; i < n; i++) { vert(i, 0); vert(i + 1, 0); vert(i, 1); vert(i + 1, 0); vert(i + 1, 1); vert(i, 1); }
    return this._raw(pos, nor, uv, 'decal');
  }
  /** Flat stamp: a quad w wide in the local XY plane facing +Z, placed by matrix m. */
  decalFlat(name, m, w, h) {
    if (!this.med) return this;
    const [u0, v0, u1, v1, aspect] = decalUV(name), hh = h ?? w / aspect, g = new THREE.PlaneGeometry(w, hh), uv = g.attributes.uv;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, u0 + (u1 - u0) * uv.getX(i), v0 + (v1 - v0) * uv.getY(i));
    return this.add(g, 0xffffff, m, 'decal');
  }
  /** Flat tiling strip (hazard edging etc.): w long in local X, h tall in local Y. */
  decalStrip(name, m, w, h) {
    if (!this.med) return this;
    const row = decalRow(name), g = new THREE.PlaneGeometry(w, h), uv = g.attributes.uv, k = Math.max(1, Math.round(w / (h * row.aspect)));
    for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * k * row.tileU, row.v0 + (row.v1 - row.v0) * uv.getY(i));
    return this.add(g, 0xffffff, m, 'decal');
  }
  _raw(pos, nor, uv, bucket) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    return this.add(g, 0xffffff, null, bucket);
  }
  /** Merge every bucket into a mesh and add them to `parent`. */
  build(parent) {
    if (this.q === 0) {
      const all = [];
      for (const k of Object.keys(this.b)) {
        if (k === 'decal' || k === 'lamp' || k === 'jar' || k === 'heat') continue;
        const tint = LOD_TINT[k];
        for (const it of this.b[k]) all.push(tint === undefined ? it : { ...it, color: tint });
      }
      if (all.length) { const mesh = new THREE.Mesh(mergeGeometries(all), mat('lod')); mesh.name = 'b_lod'; mesh.castShadow = mesh.receiveShadow = true; parent.add(mesh); }
      return parent;
    }
    for (const k of Object.keys(this.b)) {
      const mesh = new THREE.Mesh(mergeGeometries(this.b[k]), mat(k));
      mesh.name = 'b_' + k;
      mesh.userData = {};
      if (k === 'glow' || k === 'beam' || k === 'heat') mesh.userData.own = true;
      if (k === 'heat') { mesh.visible = false; mesh.renderOrder = 3; }
      if (NO_TINT.has(k)) mesh.userData.noTint = true;
      const sh = !NO_SHADOW.has(k); mesh.castShadow = sh; mesh.receiveShadow = sh;
      if (k === 'decal' || k === 'jar') mesh.renderOrder = 2;
      parent.add(mesh);
    }
    return parent;
  }
}

/** Named child group of g (animated sub-assembly). */
export function sub(g, name, x = 0, y = 0, z = 0) { const o = new THREE.Group(); o.name = name; o.position.set(x, y, z); g.add(o); return o; }

// ---------------------------------------------------------------------------------------------
// Reusable detail pieces
// ---------------------------------------------------------------------------------------------
/** Machined end flange with a bolt circle at the top (dir = +1) or bottom (dir = -1) face of a stack part. */
export function flange(pb, r, y, dir, { h = Math.min(Math.max(r * 0.07, 0.03), 0.09), color = P.gun, lip = 0.012, bolts = true, cap = true } = {}) {
  const ya = dir > 0 ? y - h : y, yb = dir > 0 ? y : y + h;
  pb.ring(r - 0.03, r + lip, ya, yb, color, 'metal');
  if (bolts) pb.studs(r + lip, (ya + yb) / 2, Math.max(8, Math.round(r * 28)), Math.min(0.022, h * 0.3), P.steel, 0.13);
  if (cap) endCap(pb, r - 0.02, dir > 0 ? y - 0.004 : y + 0.004, dir);
  return h;
}
/** Closed end of a stack part: a machined bulkhead with a recessed centre, ribs and a docking boss. */
export function endCap(pb, r, y, dir) {
  const d = Math.min(0.03, r * 0.06) * dir, c = 0x868d96;
  // profile walked so the surface faces along dir
  const prof = [[r, y, c], [r * 0.86, y], [r * 0.8, y - d, 0x5c636d], [r * 0.3, y - d, c], [r * 0.24, y], [0.002, y]];
  pb.rev(dir > 0 ? prof : [...prof].reverse().map((p, i, a) => [p[0], p[1], [c, c, 0x5c636d, c, c, c][i]]), 'metal', { crease: 0.4 });
  if (pb.med) { const n = r > 1 ? 12 : 8; pb.around(n, a => pb.box(r * 0.5, Math.abs(d) * 0.8, Math.min(0.03, r * 0.05), 0x767d86, Mrad(a, r * 0.55, y - d * 0.55), 'metal'), 0.2); }
}
/** Raised hoop profile points for a revolve: a small trapezoid bump centred at y on radius r. */
export function rib(r, y, w, d, color, back) {
  return [[r, y - w / 2 - d * 0.7, color], [r + d, y - w / 2], [r + d, y + w / 2], [r, y + w / 2 + d * 0.7, back]];
}
/** Round porthole on a cylinder/cone wall: frame ring, bolts and domed glass. slope = dr/dy of the wall. */
export function porthole(pb, r, y, ang, rad, { slope = 0, frame = P.gun, glass = 0x14303a } = {}) {
  const tilt = Math.atan(slope), m = Mrad(ang, r, y, -tilt);
  pb.add(new THREE.TorusGeometry(rad, rad * 0.2, pb.med ? 8 : 5, pb.seg(rad * 2)), frame, mul(m, M(0.004, 0, 0, 0, Math.PI / 2, 0)), 'metal');
  pb.add(new THREE.SphereGeometry(rad * 1.6, pb.seg(rad * 2), 6, 0, TAU, 0, 0.68), glass, mul(m, M(-rad * 1.23 + 0.012, 0, 0, 0, 0, -Math.PI / 2)), 'glass');
  if (pb.hi) for (let i = 0; i < 8; i++) { const a = i * TAU / 8; pb.add(new THREE.SphereGeometry(rad * 0.07, 6, 4), P.steel, mul(m, M(rad * 0.2, Math.cos(a) * rad * 1.02, Math.sin(a) * rad * 1.02)), 'metal'); }
}
/** Rectangular window lying on the wall: dark frame patch plus a glass patch. */
export function windowPane(pb, r0, r1, y0, y1, ang, w, { frame = P.gun, glass = 0x14303a, th = 0.014 } = {}) {
  const b = Math.min(w, y1 - y0) * 0.12, k = b / (y1 - y0), ra = r0 + (r1 - r0) * k, rb = r1 - (r1 - r0) * k;
  pb.patch(r0, r1, y0, y1, ang, w, th, frame, 'metal');
  pb.patch(ra + th, rb + th, y0 + b, y1 - b, ang, w - 2 * b, 0.006, glass, 'glass');
}
/** Handrail standing off the wall between two points given as [angle, y]; r = wall radius (slope aware via rAt). */
export function handrail(pb, rAt, a0, y0, a1, y1, { off = 0.05, rad = 0.011, color = P.silver, posts = 2 } = {}) {
  if (!pb.med) return;
  const at = (t, o) => { const a = a0 + (a1 - a0) * t, y = y0 + (y1 - y0) * t, r = rAt(y) + o; return [Math.cos(a) * r, y, Math.sin(a) * r]; };
  const n = Math.max(2, Math.ceil(Math.abs(a1 - a0) / 0.2) + 1), pts = [];
  for (let i = 0; i < n; i++) pts.push(at(i / (n - 1), off));
  pb.tube(pts, rad, color, 'chrome', { seg: 6 });
  for (let i = 0; i < posts; i++) { const t = posts === 1 ? 0.5 : 0.08 + 0.84 * i / (posts - 1); pb.rod(at(t, -0.005), at(t, off), rad * 0.9, color, 'chrome', 6); }
}
/** External cable tray running up the wall at angle `ang`, with clamps. */
export function raceway(pb, r, y0, y1, ang, { w = 0.07, d = 0.035, color = P.shade } = {}) {
  if (!pb.med) return;
  const len = y1 - y0;
  pb.rbox(d, len, w, d * 0.35, color, Mrad(ang, r + d / 2 - 0.004, (y0 + y1) / 2), 'paint');
  if (pb.hi) { const n = Math.max(2, Math.round(len / 0.45)); for (let i = 0; i < n; i++) pb.box(d + 0.008, 0.03, w + 0.016, P.gun, Mrad(ang, r + d / 2 - 0.002, y0 + len * (i + 0.5) / n), 'metal'); }
}
/** Vertical stringers standing proud of the wall. */
export function stringers(pb, r, y0, y1, n, w, d, color, bucket = 'paint', a0 = 0) {
  if (!pb.med) return;
  pb.around(n, a => pb.box(d, y1 - y0, w, color, Mrad(a, r + d / 2 - 0.003, (y0 + y1) / 2), bucket), a0);
}
