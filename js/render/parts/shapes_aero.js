// Starwright part models: lifting surfaces (fins, wings, elevons, tails, canards, air brakes) and wheels/legs.
// Radial convention: mount face at x = -rw/2, +X outward. Wings: span along X, leading edge toward +Y,
// thickness along Z. Wheels and gear: +X is "down" (toward the ground), the axle runs along Z, they roll along Y.
import * as THREE from '../../lib/three.module.min.js';
import { PB, P, TAU, M, Mrad, mul, sub } from './geo.js';
import { HULL_TILE } from './textures.js';

const clamp = (x, a, b) => Math.min(Math.max(x, a), b);
const lerp = (a, b, t) => a + (b - a) * t;
const AIRFOIL = [[0, 0], [0.025, 0.5], [0.09, 0.82], [0.28, 1], [0.55, 0.8], [0.82, 0.4], [1, 0.07]];

/**
 * Lofted wing panel between a root section at x0 and a tip section at x1. Each section runs from its leading
 * edge yL down to its trailing edge yT with maximum thickness t. Returns nothing; adds to pb.
 */
function wingSolid(pb, { x0, x1, yL0, yT0, yL1, yT1, t0, t1, color = P.hull, edge = P.silver, tipColor, bucket = 'hull', m = null, stations = 2 }) {
  const col = new THREE.Color(), cBody = new THREE.Color(color), cEdge = new THREE.Color(edge), cTip = new THREE.Color(tipColor ?? color);
  const A = pb.hi ? AIRFOIL : [[0, 0], [0.06, 0.75], [0.3, 1], [0.7, 0.6], [1, 0.07]];
  const pos = [], uv = [], cl = [], idx = [];
  const S = Math.max(2, stations), ring = A.length * 2 - 2;        // top LE→TE, then bottom TE→LE (shared LE and TE points)
  const pt = (s, k) => {                                              // k: index round the section
    const u = s / (S - 1), top = k < A.length, a = top ? A[k] : A[ring - k], x = lerp(x0, x1, u), yL = lerp(yL0, yL1, u), yT = lerp(yT0, yT1, u), th = lerp(t0, t1, u);
    return [x, lerp(yL, yT, a[0]), (top ? 1 : -1) * a[1] * th / 2, a[0], u];
  };
  for (let s = 0; s < S; s++) for (let k = 0; k < ring; k++) {
    const p = pt(s, k); pos.push(p[0], p[1], p[2]); uv.push(p[0] / HULL_TILE, p[1] / HULL_TILE);
    col.copy(p[3] < 0.05 ? cEdge : cBody); if (p[4] > 0.93 && S > 2) col.copy(cTip);
    cl.push(col.r, col.g, col.b);
  }
  for (let s = 0; s < S - 1; s++) for (let k = 0; k < ring; k++) { const a = s * ring + k, b = s * ring + (k + 1) % ring, c = a + ring, d = b + ring; idx.push(a, b, c, b, d, c); }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2)); g.setAttribute('color', new THREE.Float32BufferAttribute(cl, 3));
  g.setIndex(idx); g.computeVertexNormals();
  // caps
  const cap = (s, flip) => {
    const cp = [], cu = [], cc = [], ci = [];
    for (let k = 0; k < ring; k++) { const p = pt(s, k); cp.push(p[0], p[1], p[2]); cu.push(p[1] / HULL_TILE, p[2] / HULL_TILE); col.copy(s ? cTip : cBody); cc.push(col.r, col.g, col.b); }
    for (let k = 1; k < ring - 1; k++) ci.push(0, k, k + 1);
    const cg = new THREE.BufferGeometry(); cg.setAttribute('position', new THREE.Float32BufferAttribute(cp, 3)); cg.setAttribute('uv', new THREE.Float32BufferAttribute(cu, 2)); cg.setAttribute('color', new THREE.Float32BufferAttribute(cc, 3)); cg.setIndex(ci); cg.computeVertexNormals();
    const want = Math.sign(x1 - x0) * (flip ? -1 : 1);
    if (cg.attributes.normal.getX(0) * want < 0) { const ix = cg.index.array; for (let k = 0; k < ix.length; k += 3) { const t = ix[k + 1]; ix[k + 1] = ix[k + 2]; ix[k + 2] = t; } cg.computeVertexNormals(); }
    pb.add(cg, null, m, bucket);
  };
  pb.add(g, null, m, bucket); cap(0, true); cap(S - 1, false);
}
// Wing skins are double-checked for winding by building both orders once: the simplest robust approach is a
// double-sided hull material; hull is single-sided, so flip here if the loft comes out inside-out.
function fixWinding(pb, bucket, from) {
  const items = pb.b[bucket]; if (!items) return;
  for (let i = from; i < items.length; i++) {
    const g = items[i].geo; if (!g.index) continue;
    const p = g.attributes.position, n = g.attributes.normal; g.computeBoundingBox(); const c = g.boundingBox.getCenter(new THREE.Vector3());
    let s = 0; for (let k = 0; k < p.count; k++) s += (p.getX(k) - c.x) * n.getX(k) + (p.getY(k) - c.y) * n.getY(k) + (p.getZ(k) - c.z) * n.getZ(k);
    if (s < 0) { const ix = g.index.array; for (let k = 0; k < ix.length; k += 3) { const t = ix[k + 1]; ix[k + 1] = ix[k + 2]; ix[k + 2] = t; } g.computeVertexNormals(); }
  }
}
function loft(pb, o) { const n = (pb.b[o.bucket || 'hull'] || []).length; wingSolid(pb, o); fixWinding(pb, o.bucket || 'hull', n); }

/** A control surface hinged along a (possibly swept) line from (xa, ya) to (xb, yb), chords ca → cb trailing below it.
 *  Creates groups `${name}Hinge` > `name`; partmesh rotates `name` about its X axis. */
function hinged(g, pb, name, xa, ya, xb, yb, ca, cb, t0, t1, color) {
  const hg = sub(g, name + 'Hinge', xa, ya, 0); hg.rotation.z = Math.atan2(yb - ya, xb - xa);
  const inner = sub(hg, name), sp = new PB(pb.q), len = Math.hypot(xb - xa, yb - ya);
  loft(sp, { x0: 0, x1: len, yL0: 0, yT0: -ca, yL1: 0, yT1: -cb, t0, t1, color, edge: P.gun });
  if (sp.med) { sp.rod([0, 0, 0], [len, 0, 0], Math.max(t0 * 0.3, 0.008), P.gun, 'metal', 6); for (const u of [0.15, 0.5, 0.85]) sp.rbox(0.03, Math.min(ca, cb) * 0.5, t0 * 1.3, 0.004, P.iron, M(len * u, -Math.min(ca, cb) * 0.2, 0), 'metal'); }
  sp.build(inner);
  return inner;
}

// planform helper: root LE at +h/2, sweep pushes the tip back, tip chord given as a fraction of the root
function planform(def, tipFrac, sweepDeg) {
  const { h, rw } = def, x0 = -rw / 2, x1 = rw / 2, tipC = h * tipFrac, back = Math.min(Math.tan(sweepDeg * Math.PI / 180) * rw, h - tipC);
  return { x0, x1, yL0: h / 2, yT0: -h / 2, yL1: h / 2 - back, yT1: h / 2 - back - tipC };
}
function rootFairing(pb, def, color = P.gun) {
  const { h, rw, t } = def; pb.rbox(Math.min(0.05, rw * 0.06), h * 0.96, t * 1.5, Math.min(t * 0.3, 0.02), color, M(-rw / 2 + Math.min(0.025, rw * 0.03), 0, 0), 'metal');
}

// ---------------------------------------------------------------------------------------------
export function fin(def, g, pb) {
  const { h, rw, t, variant } = def, ctrl = def.fin && def.fin.control;
  if (variant === 'grid') return gridFin(def, g, pb);
  const pf = variant === 'swept' ? planform(def, 0.36, 38) : variant === 'broad' ? planform(def, 0.5, 30) : planform(def, 0.45, 32);
  const accent = variant === 'broad' ? P.tealDark : P.teal;
  rootFairing(pb, def);
  if (ctrl && variant !== 'broad') {
    // all-moving vane on a pivot
    const piv = sub(g, 'ctrlHinge', -rw / 2 + 0.03, 0, 0), inner = sub(piv, 'ctrl'), sp = new PB(pb.q);
    loft(sp, { ...pf, x0: 0.02, x1: rw - 0.03, yL0: pf.yL0, yT0: pf.yT0, t0: t, t1: t * 0.5, color: P.amber, edge: P.gun, tipColor: P.gun, stations: 3 });
    sp.cyl(t * 1.1, t * 1.1, 0.05, 0, P.gun, 'metal', 14, false, M(0, 0, 0, 0, 0, Math.PI / 2));
    sp.decalFlat('arrowUp', M(rw * 0.35, 0, t * 0.5 + 0.004), rw * 0.14);
    sp.build(inner);
    pb.cyl(t * 1.6, t * 1.6, 0.03, 0, P.iron, 'metal', 16, false, M(-rw / 2 + 0.015, 0, 0, 0, 0, Math.PI / 2));
    return;
  }
  // fixed fin (with a powered trailing edge on the broad steering vane)
  const flapF = ctrl ? 0.3 : 0;
  const yT0 = lerp(pf.yT0, pf.yL0, flapF), yT1 = lerp(pf.yT1, pf.yL1, flapF);
  loft(pb, { ...pf, yT0, yT1, t0: t, t1: t * 0.5, color: P.hull, edge: P.silver, tipColor: accent, stations: 6 });
  if (ctrl) hinged(g, pb, 'ctrl', pf.x0 + rw * 0.06, yT0, pf.x1 - rw * 0.02, yT1, (pf.yL0 - pf.yT0) * flapF, (pf.yL1 - pf.yT1) * flapF, t * 0.7, t * 0.4, P.amber);
  const zc = t * 0.36;
  for (const s of [1, -1]) {
    pb.decalFlat('starmark', M(pf.x0 + rw * 0.36, lerp(pf.yL0, pf.yT0, 0.42) - (pf.yL0 - pf.yL1) * 0.3, s * (zc + 0.004), 0, s > 0 ? 0 : Math.PI, 0), Math.min(rw, h) * 0.26);
  }
}
function gridFin(def, g, pb) {
  const { h, rw, t } = def, x0 = -rw / 2;
  pb.rbox(0.05, h * 0.3, t * 1.6, 0.01, P.gun, M(x0 + 0.025, 0, 0), 'metal');
  const piv = sub(g, 'ctrlHinge', x0 + 0.05, 0, 0), inner = sub(piv, 'ctrl'), sp = new PB(pb.q), w = rw - 0.08, n = pb.hi ? 6 : 4;
  sp.rod([0, 0, 0], [w * 0.2, 0, 0], t * 0.3, P.iron, 'metal', 8);
  const xa = w * 0.16, xb = w, fr = 0.014;
  for (const y of [-h / 2, h / 2]) sp.rbox(xb - xa, 0.03, t, 0.006, P.steel, M((xa + xb) / 2, y - Math.sign(y) * 0.015, 0), 'metal');
  for (const x of [xa, xb]) sp.rbox(0.03, h, t, 0.006, P.steel, M(x + (x === xa ? 0.015 : -0.015), 0, 0), 'metal');
  for (let i = 1; i < n * 2; i++) { const k = i / (n * 2); // diagonal lattice
    const a = [lerp(xa, xb, clamp(k * 2, 0, 1)), lerp(-h / 2, h / 2, clamp(k * 2 - 1, 0, 1))], b = [lerp(xa, xb, clamp(k * 2 - 1, 0, 1)), lerp(-h / 2, h / 2, clamp(k * 2, 0, 1))];
    for (const f of [1, -1]) { const p = [a[0], f * a[1]], q = [b[0], f * b[1]], dx = q[0] - p[0], dy = q[1] - p[1], len = Math.hypot(dx, dy); if (len > 0.02) sp.box(len, fr, t * 0.9, P.silver, M((p[0] + q[0]) / 2, (p[1] + q[1]) / 2, 0, 0, 0, Math.atan2(dy, dx)), 'metal'); }
  }
  sp.build(inner);
}

export function wing(def, g, pb) { return wingShape(def, g, pb); }
function wingShape(def, g, pb) {
  const { h, rw, t, variant } = def, sweep = (def.wing && def.wing.sweep) || 0, ctl = def.wing && def.wing.control;
  const tipFrac = { rect: 0.92, swept: 0.42, delta: 0.07, strake: 0.05, winglet: 0.4, canard: 0.4 }[variant] ?? 0.6;
  const pf = planform(def, tipFrac, variant === 'delta' || variant === 'strake' ? 89 : sweep);
  const hot = variant === 'delta', body = hot ? P.shade : P.hull;
  if (variant === 'canard') {
    // all-moving foreplane on a spindle
    pb.cyl(t * 1.4, t * 1.6, 0.04, 0, P.iron, 'metal', 16, false, M(-rw / 2 + 0.02, 0, 0, 0, 0, Math.PI / 2));
    const piv = sub(g, 'ctrlHinge', -rw / 2 + 0.04, 0, 0), inner = sub(piv, 'ctrl'), sp = new PB(pb.q);
    loft(sp, { ...pf, x0: 0.01, x1: rw - 0.04, t0: t, t1: t * 0.45, color: P.hull, edge: P.gun, tipColor: P.teal, stations: 5 });
    sp.decalFlat('noStep', M(rw * 0.3, pf.yL0 - h * 0.5, t * 0.36 + 0.004), rw * 0.3);
    sp.build(inner); return;
  }
  rootFairing(pb, def, variant === 'strake' ? P.shade : P.gun);
  loft(pb, { ...pf, t0: t, t1: t * (variant === 'rect' ? 0.8 : 0.42), color: body, edge: hot ? P.graphite : P.silver, tipColor: variant === 'winglet' ? P.teal : hot ? P.graphite : P.teal, stations: variant === 'strake' ? 2 : 8 });
  if (variant === 'strake') return;
  const zc = t * 0.4;
  // flap-track fairings under the trailing edge, fuel caps and markings on top
  if (pb.med && rw > 1.5) for (const u of [0.25, 0.6]) { const x = lerp(pf.x0, pf.x1, u), yT = lerp(pf.yT0, pf.yT1, u), c = lerp(pf.yL0, pf.yL1, u) - yT; pb.add(new THREE.CapsuleGeometry(t * 0.22, c * 0.3, 4, 8), P.shade, M(x, yT + c * 0.2, -t * 0.34 * lerp(1, 0.5, u)), 'paint'); }
  if (pb.med && rw > 1) { const x = lerp(pf.x0, pf.x1, 0.3), y = lerp(lerp(pf.yL0, pf.yL1, 0.3), lerp(pf.yT0, pf.yT1, 0.3), 0.3); pb.cyl(t * 0.3, t * 0.3, 0.012, 0, P.steel, 'metal', 12, false, M(x, y, zc * 0.96, Math.PI / 2)); }
  const mx = lerp(pf.x0, pf.x1, 0.42), my = lerp(lerp(pf.yL0, pf.yL1, 0.42), lerp(pf.yT0, pf.yT1, 0.42), 0.45), ds = Math.min(rw, h) * 0.24;
  pb.decalFlat('roundel', M(mx, my, zc * 0.86 + 0.004), ds); pb.decalFlat('roundel', M(mx, my, -zc * 0.86 - 0.004, 0, Math.PI, 0), ds);
  if (rw > 1.5) pb.decalFlat('noStep', M(lerp(pf.x0, pf.x1, 0.2), lerp(pf.yT0, pf.yL0, 0.22), zc + 0.004), Math.min(0.5, rw * 0.2));
  if (pb.med && variant !== 'winglet') { pb.sphere(t * 0.2, variant === 'rect' ? P.green : P.red, M(pf.x1 - 0.01, lerp(pf.yL1, pf.yT1, 0.2), 0), 'lamp', 8, 6); }
  void ctl;
}

export function elevon(def, g, pb) {
  const { h, rw, t } = def;
  // hinge strip along the top edge, surface hanging below it
  pb.rbox(rw, Math.min(0.05, h * 0.14), t * 1.3, 0.006, P.gun, M(0, h / 2 - Math.min(0.025, h * 0.07), 0), 'metal');
  const yh = h / 2 - Math.min(0.05, h * 0.14);
  hinged(g, pb, 'ctrl', -rw / 2 + 0.01, yh, rw / 2 - 0.01, yh, h - 0.05, (h - 0.05) * 0.86, t, t * 0.8, P.hull);
  // accent stripe on the moving surface
  const inner = g.getObjectByName('ctrl'), sp = new PB(pb.q);
  sp.decalStrip('tealstripe', M((rw - 0.02) / 2, -(h - 0.05) * 0.55, t * 0.22 + 0.004), rw * 0.9, Math.min(0.06, h * 0.14));
  sp.build(inner);
}

export function tailfin(def, g, pb) {
  const { h, rw, t, variant } = def, sweep = (def.wing && def.wing.sweep) || 35, small = variant === 'small';
  const pf = planform(def, small ? 0.45 : 0.4, sweep), fl = 0.3;
  rootFairing(pb, def);
  const yT0 = lerp(pf.yT0, pf.yL0, fl), yT1 = lerp(pf.yT1, pf.yL1, fl);
  loft(pb, { ...pf, yT0, yT1, t0: t, t1: t * 0.45, color: P.hull, edge: P.silver, tipColor: P.teal, stations: 7 });
  hinged(g, pb, 'ctrl', pf.x0 + rw * 0.05, yT0, pf.x1 - rw * 0.03, yT1, (pf.yL0 - pf.yT0) * fl, (pf.yL1 - pf.yT1) * fl, t * 0.75, t * 0.4, small ? P.hull : P.teal);
  const mx = lerp(pf.x0, pf.x1, 0.4), my = lerp(lerp(pf.yL0, pf.yL1, 0.4), yT0 + (yT1 - yT0) * 0.4, 0.5), zc = t * 0.36;
  for (const s of [1, -1]) pb.decalFlat(small ? 'starmark' : 'flag', M(mx, my, s * (zc + 0.004), 0, s > 0 ? 0 : Math.PI, 0), Math.min(rw, h) * 0.3);
  if (!small && pb.med) { pb.rod([pf.x1 - 0.02, pf.yL1 - 0.05, 0], [pf.x1 + 0.0, pf.yL1 + 0.16, 0], 0.008, P.steel, 'chrome', 5); pb.sphere(0.02, P.red, M(pf.x1, pf.yL1 + 0.17, 0), 'lamp', 6, 4); }
}

export function airbrake(def, g, pb) {
  const { h, rw, t } = def, x0 = -rw / 2;
  pb.rbox(0.03, h, t, 0.008, P.gun, M(x0 + 0.015, 0, 0), 'metal');
  pb.rbox(0.02, h * 0.8, t * 0.5, 0.004, P.soot, M(x0 + 0.035, -h * 0.04, 0), 'metal');
  // flap hinged at the top (leading) edge, pushed open by a piston
  const hg = sub(g, 'brake', x0 + 0.05, h / 2 - 0.03, 0), sp = new PB(pb.q);
  sp.rbox(0.03, h - 0.04, t * 0.94, 0.01, P.hull, M(0.015, -(h - 0.04) / 2, 0), 'hull');
  sp.decalStrip('hazard', M(0.031, -(h - 0.04) + 0.06, 0, 0, Math.PI / 2, 0), t * 0.9, 0.07);
  if (sp.med) { for (const z of [-0.3, 0.3]) sp.rbox(0.02, h * 0.6, 0.03, 0.004, P.shade, M(0.04, -h * 0.45, z * t), 'paint'); for (let i = 0; i < 5; i++) for (let j = 0; j < 3; j++) sp.cyl(0.02, 0.02, 0.034, 0, P.soot, 'metal', 8, false, M(0.016, -h * (0.25 + i * 0.12), (j - 1) * t * 0.14, 0, 0, Math.PI / 2)); }
  sp.rod([0, 0, -t * 0.47], [0, 0, t * 0.47], 0.014, P.steel, 'chrome', 8);
  sp.build(hg);
  const pis = sub(g, 'brakePiston', x0 + 0.04, -h * 0.34, 0), pp = new PB(pb.q);
  pp.cyl(0.018, 0.018, 1, 0.5, P.silver, 'chrome', 8); pp.build(pis);
  pb.cyl(0.03, 0.03, 0.05, 0, P.gun, 'metal', 10, false, M(x0 + 0.04, -h * 0.34, 0, Math.PI / 2));
}

// ---------------------------------------------------------------------------------------------
// Landing legs: housing on the hull, a main strut that swings down, a sliding piston, a foot pad and a brace.
// Named groups legPivot / legPiston / legFoot / legBrace are driven by partmesh from def.legs { reach, spread }.
// ---------------------------------------------------------------------------------------------
export function legGeometry(def) {
  const { h, rw } = def, s = h / 1.2;
  return { px: -rw / 2 + 0.12 * s, py: h / 2 - 0.1 * s, s };
}
export function leg(def, g, pb) {
  const { h, rw, t, variant } = def, { px, py, s } = legGeometry(def), heavy = variant === 'heavy', x0 = -rw / 2;
  // housing
  pb.rbox(0.07 * s, h, t * 0.8, 0.014 * s, P.hull, M(x0 + 0.035 * s, 0, 0), 'hull');
  pb.rbox(0.05 * s, h * 0.24, t, 0.012 * s, P.gun, M(x0 + 0.06 * s, py - 0.02 * s, 0), 'metal');
  pb.rbox(0.05 * s, h * 0.14, t * 0.9, 0.012 * s, P.gun, M(x0 + 0.06 * s, -h / 2 + 0.1 * s, 0), 'metal');
  pb.decalStrip('hazard', M(x0 + 0.071 * s, 0, 0, 0, Math.PI / 2, Math.PI / 2), h * 0.4, t * 0.34);
  if (pb.med) for (const z of [-1, 1]) pb.cyl(0.03 * s, 0.03 * s, 0.03 * s, 0, P.steel, 'metal', 10, false, M(px, py, z * t * 0.44, Math.PI / 2));
  // main strut (points down its own -Y), piston and foot
  const piv = sub(g, 'legPivot', px, py, 0), sp = new PB(pb.q), L0 = 0.62 * h;
  sp.cyl(0.05 * s, 0.058 * s, L0, -L0 / 2, P.hull, 'paint', 12);
  sp.cyl(0.064 * s, 0.064 * s, 0.05 * s, -L0 + 0.02 * s, P.gun, 'metal', 12); sp.cyl(0.064 * s, 0.064 * s, 0.05 * s, -0.04 * s, P.gun, 'metal', 12);
  sp.cyl(0.03 * s, 0.03 * s, t * 0.86, 0, P.steel, 'metal', 10, false, M(0, 0, 0, Math.PI / 2));
  if (heavy && sp.med) { for (const z of [-1, 1]) sp.rod([0, -0.1 * s, z * t * 0.3], [0, -L0 + 0.06 * s, z * 0.03], 0.016 * s, P.steel, 'metal', 6); }
  sp.build(piv);
  const pis = sub(piv, 'legPiston', 0, -L0, 0), pp = new PB(pb.q), PL = 2.4 * h;
  pp.sphere(0.045 * s, P.gun, M(0, 0, 0), 'metal', 10, 8);
  pp.build(pis);
  const rod = sub(pis, 'legRod', 0, 0, 0), rdp = new PB(pb.q);
  rdp.cyl(0.03 * s, 0.03 * s, 1, 0.5, P.silver, 'chrome', 10); rdp.build(rod); void PL;
  const foot = sub(pis, 'legFoot', 0, 0, 0), fp = new PB(pb.q), fr = (heavy ? 0.26 : 0.2) * s;
  fp.rev([[0.002, -0.07 * s, P.gun], [fr * 0.7, -0.07 * s], [fr, -0.045 * s], [fr, -0.03 * s], [fr * 0.4, -0.01 * s], [0.05 * s, 0.03 * s], [0.002, 0.03 * s]], 'metal', { crease: 0.5, seg: 16 });
  if (fp.hi) fp.around(6, a => fp.box(fr * 0.5, 0.012 * s, 0.012 * s, P.iron, mul(Mrad(a, fr * 0.6, -0.02 * s, -0.25), M(0, 0, 0)), 'metal'));
  fp.build(foot);
  // brace: a unit-length rod scaled by partmesh
  const br = sub(g, 'legBrace', 0, 0, 0), bp = new PB(pb.q);
  bp.cyl(0.022 * s, 0.022 * s, 1, 0.5, P.steel, 'metal', 8); bp.build(br);
}

// ---------------------------------------------------------------------------------------------
// Wheels. Groups: wheelRetract (gear swings about Z at the mount) > wheelSusp (slides along X) > wheelSteer
// (turns about X) > wheelSpin (rolls about Z).
// ---------------------------------------------------------------------------------------------
function tyre(sp, R, w, { knobbly = false, hubColor = P.silver, mesh = false } = {}) {
  const n = sp.seg(R, 1.2), rIn = R * (mesh ? 0.72 : 0.6), sh = w * 0.5, k = knobbly ? 0.86 : 0.93;
  // the profile is revolved about Y, then laid over so the axle is Z
  const lay = M(0, 0, 0, Math.PI / 2);
  const prof = [[rIn, -sh, 0xffffff], [R * k, -sh], [R, -sh * 0.62], [R, sh * 0.62], [R * k, sh], [rIn, sh]];
  sp.rev(prof, 'rubber', { m: lay, seg: n, uRep: Math.max(3, Math.round(TAU * R / 0.42)), vTile: w * 1.4, crease: 0.9, vOff: 0.12 });
  if (knobbly && sp.med) sp.around(Math.round(n * 0.75), a => sp.box(R * 0.09, R * 0.07, w * 0.42, 0x34363a, mul(M(Math.cos(a) * R, Math.sin(a) * R, 0, 0, 0, a), M(0, 0, 0, 0, 0.5, 0)), 'rubber'));
  // rim and hub
  sp.rev([[rIn, -sh * 0.9, hubColor], [rIn * 1.02, -sh * 0.5], [rIn * 0.86, -sh * 0.35], [rIn * 0.3, -sh * 0.5, P.gun], [0.002, -sh * 0.55]], 'metal', { m: lay, crease: 0.5, seg: n });
  sp.rev([[0.002, sh * 0.55, P.gun], [rIn * 0.3, sh * 0.5, hubColor], [rIn * 0.86, sh * 0.35], [rIn * 1.02, sh * 0.5], [rIn, sh * 0.9]], 'metal', { m: lay, crease: 0.5, seg: n });
  if (sp.med) for (const s of [-1, 1]) { sp.around(mesh ? 12 : 5, a => sp.box(rIn * 0.62, rIn * (mesh ? 0.05 : 0.2), sh * 0.1, mesh ? P.steel : P.graphite, M(Math.cos(a) * rIn * 0.6, Math.sin(a) * rIn * 0.6, s * sh * 0.46, 0, 0, a), 'metal')); if (sp.hi) sp.around(5, a => sp.cyl(rIn * 0.05, rIn * 0.05, sh * 0.1, 0, P.steel, 'metal', 6, false, M(Math.cos(a) * rIn * 0.2, Math.sin(a) * rIn * 0.2, s * sh * 0.56, Math.PI / 2))); }
}
function coil(pb, a, b, R, turns, r, color) {
  if (!pb.med) return pb.rod(a, b, R * 0.7, color, 'metal', 6);
  const A = new THREE.Vector3(...a), B = new THREE.Vector3(...b), d = B.clone().sub(A), len = d.length(), q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.clone().normalize());
  const pts = [], n = turns * 8; for (let i = 0; i <= n; i++) { const t = i / n, an = t * turns * TAU, v = new THREE.Vector3(Math.cos(an) * R, t * len, Math.sin(an) * R).applyQuaternion(q).add(A); pts.push([v.x, v.y, v.z]); }
  pb.add(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts.map(p => new THREE.Vector3(...p))), n * 2, r, 5, false), color, null, 'metal');
}
export function wheelGeometry(def) {
  const { rw } = def, R = def.wheel.radius;
  return { R, cx: rw / 2 - R, x0: -rw / 2, travel: R * 0.3 };
}
export function wheel(def, g, pb) {
  const { h, rw, t, variant } = def, w = def.wheel, { R, cx, x0 } = wheelGeometry(def), gear = variant === 'gear', fixed = variant === 'fixed', big = variant === 'big';
  const tw = gear || fixed ? Math.min(R * 0.6, t * 0.36) : Math.min(R * 0.75, t * 0.5), twin = gear && !w.steer;
  // mount plate on the hull
  pb.rbox(0.04, h * (gear ? 0.9 : 0.5), t * (gear ? 0.9 : 0.7), 0.01, P.gun, M(x0 + 0.02, 0, 0), 'metal');
  if (pb.hi) for (const [dy, dz] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) pb.cyl(0.016, 0.016, 0.016, 0, P.steel, 'metal', 6, false, M(x0 + 0.044, dy * h * (gear ? 0.4 : 0.2), dz * t * (gear ? 0.38 : 0.28), 0, 0, Math.PI / 2));
  const ret = sub(g, 'wheelRetract', x0 + 0.05, 0, 0), susp = sub(ret, 'wheelSusp', 0, 0, 0), steer = sub(susp, 'wheelSteer', cx - (x0 + 0.05), 0, 0), spin = sub(steer, 'wheelSpin', 0, 0, 0);
  const L = cx - (x0 + 0.05);   // mount → axle
  const rp = new PB(pb.q), sp = new PB(pb.q), st = new PB(pb.q), wp = new PB(pb.q);
  if (gear || fixed) {
    // oleo strut straight down the X axis to a fork/axle, with a torque link and a drag brace
    rp.cyl(R * 0.26, R * 0.3, L * 0.55, 0, fixed ? P.hull : P.hull, 'paint', 12, false, M(L * 0.275, 0, 0, 0, 0, -Math.PI / 2));
    rp.cyl(R * 0.34, R * 0.34, 0.04, 0, P.gun, 'metal', 12, false, M(L * 0.53, 0, 0, 0, 0, -Math.PI / 2));
    if (gear && rp.med) { rp.rod([0.02, h * 0.36, 0], [L * 0.5, 0, 0], R * 0.1, P.steel, 'metal', 6); rp.cyl(R * 0.16, R * 0.16, t * 0.5, 0, P.gun, 'metal', 10, false, M(0, 0, 0, Math.PI / 2)); }
    rp.build(ret);
    st.cyl(R * 0.17, R * 0.17, L * 0.6, 0, P.silver, 'chrome', 10, false, M(-L * 0.3, 0, 0, 0, 0, -Math.PI / 2));
    st.cyl(R * 0.2, R * 0.2, twin ? tw * 2.9 : tw * 1.5, 0, P.gun, 'metal', 10, false, M(0, 0, 0, Math.PI / 2));
    if (st.med) { st.rod([-L * 0.5, -R * 0.3, 0], [-L * 0.25, -R * 0.62, 0], R * 0.06, P.steel, 'metal', 5); st.rod([-L * 0.25, -R * 0.62, 0], [-R * 0.1, -R * 0.26, 0], R * 0.06, P.steel, 'metal', 5); }
    if (fixed) { // streamlined spat over the wheel
      const pts = []; for (let i = 0; i <= 10; i++) { const a = Math.PI * i / 10; pts.push([-Math.sin(a) * R * 0.55 - R * 0.2, Math.cos(a) * R * 1.5 - R * 0.25]); }
      st.poly(pts, tw * 1.5, tw * 0.3, P.teal, null, 'paint');
    }
    st.build(steer);
    if (twin) for (const s of [-1, 1]) { const one = new PB(pb.q); tyre(one, R, tw, { hubColor: P.silver }); for (const k of Object.keys(one.b)) for (const it of one.b[k]) wp.add(it.geo, it.color, mul(M(0, 0, s * tw * 0.82), it.m || new THREE.Matrix4()), k); }
    else tyre(wp, R, tw, { hubColor: P.silver });
    wp.build(spin);
    return;
  }
  // rover wheel: twin wishbones to an upright, coil-over damper, hub motor, wire-mesh or knobbly tyre
  const zo = tw * 0.5 + R * 0.16;     // arm offset to one side of the tyre
  rp.rbox(L * 0.34, h * 0.36, t * 0.5, 0.02, P.hull, M(L * 0.17, 0, 0), 'hull');
  if (rp.med) rp.decalStrip('hazard', M(L * 0.17, 0, t * 0.25 + 0.003), L * 0.3, h * 0.07);
  rp.build(ret);
  for (const dy of [-1, 1]) { sp.rod([L * 0.2, dy * h * 0.14, zo * 0.5], [L * 0.9, dy * R * 0.3, zo], R * 0.07, P.steel, 'metal', 6); sp.rod([L * 0.2, dy * h * 0.14, -t * 0.2], [L * 0.9, dy * R * 0.3, zo], R * 0.055, P.steel, 'metal', 6); }
  coil(sp, [L * 0.26, 0, zo * 0.7], [L * 0.86, 0, zo * 1.0], R * 0.12, 7, R * 0.028, big ? P.amber : P.teal);
  sp.rod([L * 0.26, 0, zo * 0.7], [L * 0.86, 0, zo * 1.0], R * 0.05, P.silver, 'chrome', 6);
  sp.build(susp);
  st.rbox(R * 0.3, R * 0.9, R * 0.2, 0.01, P.gun, M(-L * 0.08, 0, zo), 'metal');
  st.cyl(R * 0.34, R * 0.3, R * 0.36, 0, P.gold, 'foil', 14, false, M(0, 0, zo - R * 0.02, Math.PI / 2));
  st.cyl(R * 0.1, R * 0.1, zo, 0, P.steel, 'metal', 8, false, M(0, 0, zo * 0.5, Math.PI / 2));
  st.build(steer);
  tyre(wp, R, tw, { knobbly: big, mesh: !big, hubColor: big ? P.yellow : P.silver });
  wp.build(spin);
}
