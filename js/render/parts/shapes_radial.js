// Starwright part models: radial structure, power, utility and science parts.
// Radial convention: mount face at x = -rw/2, +X outward, h along Y, t along Z.
import * as THREE from '../../lib/three.module.min.js';
import { PB, P, TAU, M, Mrad, mul, sub, revolve } from './geo.js';

const clamp = (x, a, b) => Math.min(Math.max(x, a), b);
const lerp = (a, b, t) => a + (b - a) * t;
const RX = M(0, 0, 0, 0, 0, -Math.PI / 2);          // turn a +Y-axis primitive to point along +X
const along = (x, y, z) => mul(M(x, y, z), RX);
function bolts4(pb, x, hy, hz, s = 0.014) { if (pb.hi) for (const [a, b] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) pb.cyl(s, s, s, 0, P.steel, 'metal', 6, false, along(x, a * hy, b * hz)); }

// ---------------------------------------------------------------------------------------------
// Structure
// ---------------------------------------------------------------------------------------------
export function radialdec(def, g, pb) {
  const { h, rw, t, variant } = def, x0 = -rw / 2, x1 = rw / 2;
  if (variant === 'truss') {
    // two framed plates (a recessed web inside a raised rim with cross ribs), not plain slabs
    for (const x of [x0 + 0.03, x1 - 0.03]) {
      const inner = x < 0, col = inner ? P.gun : P.hull, bk = inner ? 'metal' : 'paint', s = inner ? 1 : -1;
      pb.rbox(0.035, h * 0.96, t * 0.96, 0.008, col, M(x - s * 0.012, 0, 0), bk);
      for (const z of [-1, 1]) pb.rbox(0.06, h, t * 0.07, 0.01, inner ? P.iron : P.yellow, M(x, 0, z * t * 0.465), bk);
      for (const y of [-1, 0, 1]) pb.rbox(0.06, h * 0.045, t, 0.01, inner ? P.iron : P.yellow, M(x, y * h * 0.4775, 0), bk);
      if (pb.med) for (const y of [-1, 1]) { pb.rbox(0.05, h * 0.03, t * 1.02, 0.006, inner ? P.iron : P.yellow, mul(M(x, y * h * 0.24, 0), M(0, 0, 0, y * 0.9, 0, 0)), bk); }
    }
    for (const y of [-0.36, 0, 0.36]) for (const z of [-0.36, 0.36]) { pb.rod([x0 + 0.06, y * h, z * t], [x1 - 0.06, y * h, z * t], 0.03, P.steel, 'metal', 8); if (y < 0.3) pb.rod([x0 + 0.06, y * h, z * t], [x1 - 0.06, (y + 0.36) * h, z * t], 0.018, P.steel, 'metal', 6); }
    pb.rod([x0 + 0.06, 0.36 * h, -0.36 * t], [x1 - 0.06, 0.36 * h, 0.36 * t], 0.018, P.steel, 'metal', 6); pb.rod([x0 + 0.06, -0.36 * h, 0.36 * t], [x1 - 0.06, -0.36 * h, -0.36 * t], 0.018, P.steel, 'metal', 6);
    for (const y of [-0.3, 0.3]) { pb.cyl(0.06, 0.06, 0.14, 0, P.redPaint, 'paint', 12, false, along(0, y * h, 0)); }
    pb.decalStrip('hazard', M(x1 + 0.002, 0, 0, 0, Math.PI / 2, Math.PI / 2), h * 0.9, t * 0.3); bolts4(pb, x1 + 0.004, h * 0.42, t * 0.4, 0.02);
    return;
  }
  const pin = variant === 'pin';
  // Hull shoe: a ribbed casting with faired ends that hugs the tank, split standoffs with pyro bolts, a spring
  // pusher between them, and an outer cradle whose two angled pads grip the booster.
  const sx = rw * 0.16, cx = rw * 0.14;
  pb.rbox(sx, h, t, 0.014, P.gun, M(x0 + sx / 2, 0, 0), 'metal');
  for (const z of [-1, 1]) pb.rbox(sx * 1.5, h * 0.9, t * 0.1, 0.008, P.iron, M(x0 + sx * 0.75, 0, z * t * 0.36), 'metal');             // stiffening rails
  for (const s of [-1, 1]) {                                                                                                      // faired ends, painted like the hull
    pb.poly([[0, 0], [rw * 0.42, 0], [0, s * h * 0.16]], t * 0.62, 0.006, P.hull, M(x0 + sx, s * (h * 0.5 - h * 0.17), 0), 'paint');
    pb.rbox(sx * 0.5, h * 0.05, t * 0.66, 0.004, P.teal, M(x0 + sx + 0.004, s * h * 0.31, 0), 'paint');
  }
  pb.rbox(cx, h * 0.9, t * 0.8, 0.012, P.hull, M(x1 - cx / 2, 0, 0), 'paint');
  for (const z of [-1, 1]) pb.rbox(rw * 0.3, h * 0.78, t * 0.13, 0.01, P.yellow, mul(M(x1 - cx * 0.2, 0, z * t * 0.43), M(0, 0, 0, 0, z * 0.6, 0)), 'paint');   // cradle pads
  if (pb.med) {
    for (const y of [-1, 1]) for (const z of [-1, 1]) pb.rod([x0 + sx, y * h * 0.2, z * t * 0.3], [x1 - cx, y * h * 0.38, z * t * 0.3], 0.011, P.steel, 'metal', 6);   // bracing
    pb.cyl(t * 0.09, t * 0.09, rw * 0.6, 0, P.silver, 'chrome', 10, false, along(0, 0, 0));                                                        // spring pusher
    pb.torus(t * 0.13, t * 0.03, P.steel, mul(M(0, 0, 0), M(0, 0, 0, 0, Math.PI / 2, 0)), 'metal', 12, 5);
  }
  const n = pin ? 1 : 2;
  for (let i = 0; i < n; i++) { const y = n === 1 ? 0 : (i - 0.5) * h * 0.5; pb.cyl(t * 0.24, t * 0.3, rw * 0.3, 0, P.iron, 'metal', 12, false, along(x0 + rw * 0.35, y, 0)); pb.cyl(t * 0.3, t * 0.24, rw * 0.28, 0, P.steel, 'metal', 12, false, along(x1 - rw * 0.34, y, 0)); pb.cyl(t * 0.12, t * 0.12, rw * 0.08, 0, P.redPaint, 'paint', 8, false, along(0, y, 0)); }
  if (pb.med && !pin) { pb.tube([[x0 + rw * 0.2, h * 0.36, t * 0.2], [0, h * 0.42, t * 0.3], [0, 0, t * 0.34], [x0 + rw * 0.3, -h * 0.25, t * 0.2]], 0.008, P.orange, 'paint', { seg: 5 }); }
  pb.decalStrip('hazard', M(x1 + 0.002, 0, 0, 0, Math.PI / 2, Math.PI / 2), h * 0.86, t * 0.34);
  bolts4(pb, x1 + 0.003, h * 0.42, t * 0.38);
}

// Fixed hardpoint: a streamlined pylon with a hull shoe and a mounting rail at its outer end. A stack part (a jet,
// a pod, a tank) hangs on the rail the way a booster hangs on a radial clamp, but nothing ever lets go.
export function pylon(def, g, pb) {
  const { h, rw, t } = def, x0 = -rw / 2, x1 = rw / 2, sx = Math.min(0.05, rw * 0.14);
  // hull shoe and rail
  pb.rbox(sx, h, t * 1.5, 0.012, P.gun, M(x0 + sx / 2, 0, 0), 'metal');
  pb.rbox(sx, h * 0.92, t * 1.9, 0.012, P.gun, M(x1 - sx / 2, 0, 0), 'metal');
  for (const z of [-1, 1]) pb.rbox(sx * 1.6, h * 0.8, t * 0.22, 0.008, P.iron, M(x1 - sx * 0.8, 0, z * t * 0.84), 'metal');
  // the pylon itself: an elliptical strut that tapers toward the rail, leading edge up the stack
  const seg = pb.hi ? 20 : 12, L = rw - sx * 2;
  const body = new THREE.CylinderGeometry(0.82, 1, L, seg, 1, false);
  pb.add(body, (c, x, y, z) => { c.set(y > L * 0.28 ? P.teal : P.hull); }, mul(along(0, 0, 0), M(0, 0, 0, 0, 0, 0, h * 0.47, 1, t * 0.5)), 'paint');
  // leading-edge wear strip, access panel, sway braces and bolts
  pb.cyl(0.012, 0.012, L * 0.96, 0, P.silver, 'chrome', 6, false, along(0, h * 0.455, 0));
  if (pb.med) {
    for (const z of [-1, 1]) {
      pb.rbox(L * 0.42, h * 0.3, 0.006, 0.003, P.shade, M(-L * 0.08, -h * 0.05, z * t * 0.49), 'paint');
      pb.rod([x1 - sx, -h * 0.34, z * t * 0.8], [x1 - sx - L * 0.4, -h * 0.2, z * t * 0.3], 0.012, P.steel, 'metal', 6);
      pb.rod([x1 - sx, h * 0.3, z * t * 0.8], [x1 - sx - L * 0.4, h * 0.16, z * t * 0.3], 0.012, P.steel, 'metal', 6);
    }
    pb.decalStrip('hazard', M(x1 + 0.002, 0, 0, 0, Math.PI / 2, Math.PI / 2), h * 0.7, t * 0.5);
  }
  bolts4(pb, x1 + 0.003, h * 0.4, t * 0.7); bolts4(pb, x0 + sx + 0.002, h * 0.44, t * 0.6);
}

export function radialtank(def, g, pb) {
  const { h, rw, t, variant } = def, x0 = -rw / 2, r = Math.min(rw, t) / 2 * 0.92, cx = x0 + rw - r - 0.004;
  const saddle = () => { for (const y of variant === 'sphere' ? [0] : [-h * 0.22, h * 0.22]) { pb.rbox(rw - r, Math.min(0.06, h * 0.1), t * 0.5, 0.01, P.gun, M(x0 + (rw - r) / 2, y, 0), 'metal'); } };
  saddle();
  if (variant === 'sphere') {
    pb.sphere(r, P.yellow, M(cx, 0, 0), 'paint', pb.hi ? 24 : 14, pb.hi ? 16 : 10);
    pb.torus(r * 1.0, r * 0.05, P.steel, M(cx, 0, 0, Math.PI / 2), 'metal', 24, 6); pb.torus(r * 1.0, r * 0.05, P.steel, M(cx, 0, 0, 0, Math.PI / 2), 'metal', 24, 6);
    pb.cyl(r * 0.14, r * 0.18, r * 0.2, 0, P.steel, 'metal', 10, false, M(cx, r * 1.02, 0));
    return;
  }
  const xen = variant === 'xenon', cap = variant === 'capsule', dome = r * (cap ? 0.9 : 0.5), a = -h / 2 + dome, b = h / 2 - dome, col = xen ? P.gold : P.hull, n = 6, prof = [];
  for (let i = 0; i <= n; i++) { const an = -Math.PI / 2 + i / n * Math.PI / 2; prof.push([Math.max(r * Math.cos(an), 0.002), a + dome * Math.sin(an), i === 0 ? col : undefined]); }
  if (!xen) prof.push([r, a + (b - a) * 0.6, cap ? P.teal : P.amber], [r, a + (b - a) * 0.72, col]);
  for (let i = 0; i <= n; i++) { const an = i / n * Math.PI / 2; prof.push([Math.max(r * Math.cos(an), 0.002), b + dome * Math.sin(an)]); }
  pb.rev(prof, xen ? 'foil' : 'hull', { m: M(cx, 0, 0), crease: 0.7, uRep: 1, seg: pb.seg(r) });
  for (const y of [-h * 0.22, h * 0.22]) pb.torus(r * 1.005, r * 0.045, P.steel, M(cx, y, 0, Math.PI / 2), 'metal', pb.seg(r), 6);
  pb.cyl(r * 0.12, r * 0.16, r * 0.24, 0, P.steel, 'metal', 10, false, M(cx, h / 2 - r * 0.02, 0));
  if (pb.med) pb.tube([[cx, -h / 2 + 0.01, 0], [cx - r * 0.5, -h / 2 - r * 0.1, 0], [x0 + 0.02, -h / 2 + r * 0.2, 0]], r * 0.07, P.copper, 'metal');
  const m = M(cx, 0, 0);
  const d = new PB(pb.q); d.decal(xen ? 'xenon' : 'fuel', r, a + (b - a) * 0.3, 0.4, r * 1.3, { lift: 0.005 });
  for (const k of Object.keys(d.b)) for (const it of d.b[k]) pb.add(it.geo, it.color, m, k);
}

export function panel(def, g, pb) {
  const { h, rw, t } = def;
  pb.rbox(rw * 0.5, h, t, 0.008, P.hull, M(rw * 0.2, 0, 0), 'hull');
  for (let i = 0; i < 4; i++) pb.rbox(rw * 0.5, h * 0.94, 0.03, 0.006, P.shade, M(-rw * 0.2, 0, (i - 1.5) * t * 0.26), 'paint');
  for (const y of [-0.42, 0.42]) pb.rbox(rw * 0.5, 0.03, t * 0.96, 0.006, P.shade, M(-rw * 0.2, y * h, 0), 'paint');
  bolts4(pb, rw * 0.46, h * 0.44, t * 0.44, 0.016);
  pb.decalFlat('placard', M(rw * 0.455, h * 0.2, t * 0.2, 0, Math.PI / 2, 0), t * 0.18);
}

export function strut(def, g, pb) {
  const { rw, t } = def, x0 = -rw / 2, x1 = rw / 2;
  pb.rod([x0 + 0.03, 0, 0], [x1 - 0.03, 0, 0], t * 0.16, P.silver, 'chrome', 8);
  for (const x of [x0, x1]) { const s = x < 0 ? 1 : -1; pb.rbox(0.024, t * 0.9, t * 0.9, 0.006, P.gun, M(x + s * 0.012, 0, 0), 'metal'); pb.cyl(t * 0.26, t * 0.2, 0.07, 0, P.iron, 'metal', 10, false, along(x + s * 0.055, 0, 0)); pb.sphere(t * 0.22, P.steel, M(x + s * 0.03, 0, 0), 'metal', 10, 8); }
  if (pb.med) pb.cyl(t * 0.22, t * 0.22, 0.12, 0, P.amber, 'paint', 6, false, along(0, 0, 0));
}

export function fuelline(def, g, pb) {
  const { rw, t } = def, x0 = -rw / 2, x1 = rw / 2, r = t * 0.22;
  pb.tube([[x0 + 0.05, 0, 0], [x0 + rw * 0.3, -t * 0.25, 0], [x1 - rw * 0.3, -t * 0.25, 0], [x1 - 0.05, 0, 0]], r, P.yellow, 'paint', { seg: 8 });
  if (pb.med) for (let i = 1; i < 8; i++) { const u = i / 8, x = lerp(x0 + 0.08, x1 - 0.08, u); pb.torus(r * 1.08, r * 0.2, P.brass, M(x, -t * 0.25 * Math.sin(Math.PI * u) ** 0.6, 0, 0, Math.PI / 2), 'metal', 10, 5); }
  for (const x of [x0, x1]) { const s = x < 0 ? 1 : -1; pb.rbox(0.02, t, t, 0.005, P.gun, M(x + s * 0.01, 0, 0), 'metal'); pb.cyl(r * 1.6, r * 1.6, 0.05, 0, P.steel, 'metal', 6, false, along(x + s * 0.04, 0, 0)); }
  pb.decalFlat('arrowUp', M(0, -t * 0.25, r + 0.004, 0, 0, -Math.PI / 2), r * 1.4);
}

// Launch clamp: a braced tower on a base plate with an arm that grips the rocket.
export function clamp_(def, g, pb) {
  const { h, rw, t } = def, x0 = -rw / 2, y0 = -h / 2, y1 = h / 2, tx = x0 + rw * 0.66, tw = rw * 0.3;
  pb.rbox(rw * 0.62, 0.08, t, 0.02, P.gun, M(tx, y0 + 0.04, 0), 'metal');
  pb.decalStrip('hazard', M(tx, y0 + 0.082, 0, -Math.PI / 2), rw * 0.6, t * 0.2);
  const z = t * 0.34, xs = [tx - tw / 2, tx + tw / 2], top = y1 - 0.2, bays = 4;
  for (const x of xs) for (const s of [-1, 1]) pb.rod([x, y0 + 0.08, s * z], [x, top, s * z * 0.7], 0.04, P.redPaint, 'paint', 8);
  for (let i = 0; i <= bays; i++) { const y = lerp(y0 + 0.1, top, i / bays), zz = lerp(z, z * 0.7, i / bays); for (const x of xs) pb.rod([x, y, -zz], [x, y, zz], 0.022, P.redPaint, 'paint', 6); for (const s of [-1, 1]) pb.rod([xs[0], y, s * zz], [xs[1], y, s * zz], 0.022, P.redPaint, 'paint', 6); }
  for (let i = 0; i < bays; i++) { const ya = lerp(y0 + 0.1, top, i / bays), yb = lerp(y0 + 0.1, top, (i + 1) / bays), f = i % 2 ? 1 : -1; for (const s of [-1, 1]) pb.rod([xs[0], f > 0 ? ya : yb, s * z * 0.85], [xs[1], f > 0 ? yb : ya, s * z * 0.85], 0.018, P.redPaint, 'paint', 5); for (const x of xs) pb.rod([x, ya, -f * z * 0.85], [x, yb, f * z * 0.85], 0.018, P.redPaint, 'paint', 5); }
  // head and arm
  pb.rbox(tw + 0.12, 0.2, t * 0.7, 0.03, P.gun, M(tx, top + 0.1, 0), 'metal');
  pb.rbox(tx - x0 - 0.1, 0.12, t * 0.3, 0.02, P.yellow, M((tx + x0) / 2, top + 0.1, 0), 'paint');
  pb.rbox(0.08, 0.34, t * 0.6, 0.02, P.gun, M(x0 + 0.04, top + 0.1, 0), 'metal');
  if (pb.med) { pb.rod([tx, top, 0], [x0 + 0.2, top - 0.5, 0], 0.03, P.silver, 'chrome', 8); pb.tube([[tx - tw / 2, y0 + 0.2, z], [tx - tw, top * 0.3, z * 0.4], [x0 + 0.3, top + 0.02, t * 0.2], [x0 + 0.08, top + 0.1, t * 0.2]], 0.03, P.soot, 'paint', { seg: 6 }); pb.sphere(0.04, P.amber, M(tx, y1 - 0.0, 0), 'lamp', 8, 6); }
}

// ---------------------------------------------------------------------------------------------
// Power
// ---------------------------------------------------------------------------------------------
function panelFace(sp, w, hh, th = 0.016) {
  sp.rbox(w, hh, th, 0.004, P.silver, M(w / 2, 0, 0), 'metal');
  sp.add(new THREE.PlaneGeometry(w - 0.03, hh - 0.03), 0xffffff, M(w / 2, 0, th / 2 + 0.002), 'solar', (w - 0.03) / 0.5, (hh - 0.03) / 0.5);
  // (everything that is not a cell goes in the one 'metal' mesh: each folding segment costs two draw calls, not four)
  if (sp.med) { for (const u of [0.25, 0.75]) sp.box(0.02, hh * 0.96, 0.012, P.shade, M(w * u, 0, -th / 2 - 0.004), 'metal'); sp.box(w * 0.96, 0.02, 0.012, P.shade, M(w / 2, 0, -th / 2 - 0.004), 'metal'); }
}
export function solarLayout(def) {
  const v = def.variant, span = def.solar.span, n = v === 'grand' ? 6 : v === 'wing' ? 6 : 4, base = v === 'grand' ? def.rw + 0.5 : v === 'wing' ? def.rw + 0.25 : def.rw;
  return { n, base, segW: (span - base) / n, R: v === 'fan' ? (span - 0.4) / 2 : 0, gores: 12 };
}
export function solar(def, g, pb) {
  const { h, rw, t, variant } = def, x0 = -rw / 2;
  if (variant === 'fixed') {
    pb.rbox(rw * 0.5, h * 0.3, t * 0.3, 0.004, P.gun, M(x0 + rw * 0.25, 0, 0), 'metal');
    pb.rbox(rw * 0.5, h, t, 0.006, P.silver, M(rw * 0.2, 0, 0), 'metal');
    pb.add(new THREE.PlaneGeometry(t - 0.03, h - 0.03), 0xffffff, M(rw / 2 + 0.002, 0, 0, 0, Math.PI / 2, 0), 'solar', (t - 0.03) / 0.5, (h - 0.03) / 0.5);
    return;
  }
  if (variant === 'fan') {
    const { R, gores } = solarLayout(def), aL = R + 0.2;
    pb.rbox(0.05, h, t * 0.7, 0.01, P.gun, M(x0 + 0.025, 0, 0), 'metal');
    pb.cyl(0.05, 0.05, t * 0.5, 0, P.iron, 'metal', 10, false, M(x0 + 0.1, -h / 2 + 0.08, 0, Math.PI / 2));
    const arm = sub(g, 'fanArm', x0 + 0.1, -h / 2 + 0.08, 0), ap = new PB(pb.q);
    ap.rod([0, 0, 0], [aL, 0, 0], 0.028, P.silver, 'metal', 8); ap.cyl(0.07, 0.07, 0.08, 0, P.gun, 'metal', 14, false, M(aL, 0, 0, Math.PI / 2));
    ap.build(arm);
    const da = TAU / gores;
    for (let i = 0; i < gores; i++) {
      const go = sub(arm, 'fan' + i, aL, 0, (i - gores / 2) * 0.004), gp = new PB(pb.q), sh = new THREE.Shape();
      sh.moveTo(0.06, 0); sh.lineTo(R, 0); sh.absarc(0, 0, R, 0, da, false); sh.lineTo(0.06 * Math.cos(da), 0.06 * Math.sin(da)); sh.closePath();
      const sg = new THREE.ShapeGeometry(sh, 3); // uv = xy in metres
      gp.add(sg, 0xffffff, null, 'solar', 2, 2);     // one mesh per gore: the ribs are part of the cell print
      gp.build(go);
    }
    return;
  }
  // accordion array on a hinged yoke
  const { n, base, segW } = solarLayout(def), grand = variant === 'grand', ph = grand ? h * 0.96 : variant === 'wing' ? h * 0.92 : h * 0.94;
  pb.rbox(0.04, h * 0.7, t * 0.6, 0.01, P.gun, M(x0 + 0.02, 0, 0), 'metal');
  pb.cyl(0.03, 0.03, h * 0.5, 0, P.iron, 'metal', 10, false, M(x0 + 0.06, 0, 0));
  bolts4(pb, x0 + 0.042, h * 0.3, t * 0.24);
  let parent = g;
  for (let i = 0; i < n; i++) {
    const s = sub(parent, 'solarSeg' + i, i === 0 ? x0 + base - rw + 0.06 : segW, 0, 0), sp = new PB(pb.q);
    if (i === 0 && base > rw) { sp.rod([-(base - rw), 0, 0], [0, ph * 0.3, 0], 0.016, P.silver, 'metal', 6); sp.rod([-(base - rw), 0, 0], [0, -ph * 0.3, 0], 0.016, P.silver, 'metal', 6); if (grand) latt(sp, -(base - rw), 0, 0.09); }
    panelFace(sp, segW - 0.012, ph);
    if (sp.med) for (const y of [-0.34, 0.34]) sp.cyl(0.012, 0.012, ph * 0.16, y * ph, P.gun, 'metal', 6);
    sp.build(s); parent = s;
  }
}
function latt(sp, xa, xb, w) { for (const z of [-w, w]) sp.rod([xa, 0, z], [xb, 0, z], 0.012, P.steel, 'metal', 5); for (let i = 0; i < 4; i++) { const x = lerp(xa, xb, i / 4), x2 = lerp(xa, xb, (i + 1) / 4); sp.rod([x, 0, -w], [x2, 0, w], 0.008, P.steel, 'metal', 4); } }

export function battery_radial(def, g, pb) {
  const { h, rw, t } = def;
  pb.rbox(rw, h, t, 0.014, P.slate, null, 'paint');
  pb.rbox(rw * 0.3, h * 0.94, t * 0.5, 0.006, P.yellow, M(rw * 0.38, 0, 0), 'paint');
  for (const y of [-0.3, 0.3]) pb.cyl(0.014, 0.014, 0.02, 0, P.copper, 'metal', 8, false, along(rw / 2 + 0.01, y * h, t * 0.3));
  pb.sphere(0.012, P.green, M(rw / 2 + 0.004, h * 0.34, -t * 0.32), 'lamp', 6, 4);
  pb.decalFlat('bolt', M(rw / 2 + 0.006, 0, 0, 0, Math.PI / 2, 0), t * 0.34);
}

export function rtg(def, g, pb) {
  const { h, rw, t } = def, x0 = -rw / 2, r = Math.min(rw, t) * 0.24, cx = x0 + rw * 0.56;
  pb.rbox(rw * 0.3, h * 0.24, t * 0.4, 0.01, P.gun, M(x0 + rw * 0.15, 0, 0), 'metal');
  // heat source drum, end domes, radial cooling fins
  pb.rev([[0.002, -h / 2, P.gun], [r * 0.7, -h / 2], [r, -h / 2 + r * 0.4, P.graphite], [r, h / 2 - r * 0.4, P.gun], [r * 0.7, h / 2], [0.002, h / 2]], 'metal', { m: M(cx, 0, 0), crease: 0.6 });
  const nf = pb.hi ? 10 : 6;
  for (let i = 0; i < nf; i++) { const a = i * TAU / nf + 0.3; pb.rbox(r * 1.5, h * 0.74, 0.012, 0.003, P.soot, mul(M(cx, 0, 0), Mrad(a, r * 1.6, 0)), 'metal'); }
  pb.sphere(r * 0.4, P.orange, M(cx, h / 2 - 0.004, 0), 'lamp', 8, 6);
  const d = new PB(pb.q); d.decal('atom', r, 0, 0, r * 1.2, { lift: 0.004 }); for (const k of Object.keys(d.b)) for (const it of d.b[k]) pb.add(it.geo, it.color, M(cx, 0, 0), k);
}

export function fuelcell(def, g, pb) {
  const { h, rw, t } = def, x0 = -rw / 2;
  pb.rbox(rw * 0.8, h, t, 0.014, P.hull, M(x0 + rw * 0.4, 0, 0), 'hull');
  // stack of plates, two reactant bottles, a vent
  for (let i = 0; i < 6; i++) pb.rbox(rw * 0.2, h * 0.09, t * 0.9, 0.004, i % 2 ? P.steel : P.graphite, M(x0 + rw * 0.9, -h * 0.34 + i * h * 0.11, 0), 'metal');
  for (const z of [-1, 1]) pb.add(new THREE.CapsuleGeometry(t * 0.13, h * 0.3, 4, 10), z > 0 ? P.yellow : P.teal, M(x0 + rw * 0.86, h * 0.22, z * t * 0.24), 'paint');
  pb.cyl(0.02, 0.028, 0.05, h / 2 + 0.02, P.steel, 'metal', 8, false, M(x0 + rw * 0.4, 0, 0));
  pb.sphere(0.012, P.green, M(x0 + rw * 0.8, -h * 0.42, t * 0.4), 'lamp', 6, 4);
  pb.decalFlat('bolt', M(x0 + rw * 0.3, 0, t / 2 + 0.004), t * 0.3);
}

// ---------------------------------------------------------------------------------------------
// Control and utility
// ---------------------------------------------------------------------------------------------
function nozzleSmall(pb, m, r, len, color = P.steel) {
  pb.add(revolve([[r * 0.4, 0, color], [r, len], [r * 0.82, len, P.soot], [r * 0.3, 0.004]], { seg: pb.med ? 10 : 6, crease: 0.4 }), null, m, 'metal');
}
export function rcs(def, g, pb) {
  const { h, rw, t, variant } = def, x0 = -rw / 2, lin = variant === 'linear', big = variant === 'big';
  pb.rbox(rw * 0.3, h * 0.9, t * 0.9, 0.01, P.gun, M(x0 + rw * 0.15, 0, 0), 'metal');
  if (lin) { pb.cyl(t * 0.3, t * 0.36, rw * 0.3, 0, P.hull, 'paint', 12, false, along(x0 + rw * 0.42, 0, 0)); nozzleSmall(pb, along(x0 + rw * 0.52, 0, 0), t * 0.34, rw * 0.46); return; }
  const cx = x0 + rw * 0.56, s = Math.min(h, t) * 0.3;
  pb.rbox(rw * 0.5, h * 0.56, t * 0.56, 0.014, P.hull, M(cx, 0, 0), 'paint');
  const len = Math.min(h, t) * 0.22;
  nozzleSmall(pb, M(cx, h * 0.28, 0), s * 0.62, len); nozzleSmall(pb, M(cx, -h * 0.28, 0, Math.PI), s * 0.62, len);
  nozzleSmall(pb, M(cx, 0, t * 0.28, Math.PI / 2), s * 0.62, len); nozzleSmall(pb, M(cx, 0, -t * 0.28, -Math.PI / 2), s * 0.62, len);
  if (big) nozzleSmall(pb, along(cx + rw * 0.25, 0, 0), s * 0.62, len);
  if (pb.med) pb.decalStrip('dash', M(cx + rw * 0.252, 0, 0, 0, Math.PI / 2, 0), t * 0.5, 0.012);
}

export function antenna(def, g, pb) {
  const { h, rw, t, variant } = def, x0 = -rw / 2, y0 = -h / 2;
  if (variant === 'dish' || variant === 'bigdish') {
    const big = variant === 'bigdish', R = big ? 1.5 : Math.min(h, t) * 0.5, depth = R * 0.28;
    pb.rbox(0.04, h * 0.4, t * 0.4, 0.01, P.gun, M(x0 + 0.02, 0, 0), 'metal');
    pb.rod([x0 + 0.03, 0, 0], [x0 + rw * 0.5, 0, 0], 0.03, P.iron, 'metal', 8);
    pb.sphere(0.06, P.steel, M(x0 + rw * 0.5, 0, 0), 'metal', 12, 8);
    const head = sub(g, 'dish', x0 + rw * 0.5, 0, 0), hp = new PB(pb.q);
    // feed horn on a tripod
    const fx = (big ? 0.55 : 0.6) * R;
    hp.cyl(0.03, 0.05, 0.1, 0, P.gun, 'metal', 10, false, along(fx, 0, 0));
    for (let i = 0; i < 3; i++) { const a = i * TAU / 3 + 0.4; hp.rod([0.09, Math.cos(a) * R * 0.5, Math.sin(a) * R * 0.5], [fx, Math.cos(a) * 0.03, Math.sin(a) * 0.03], 0.008, P.steel, 'metal', 5); }
    hp.cyl(0.06, 0.09, 0.08, 0, P.gold, 'foil', 12, false, along(0.04, 0, 0));
    if (!big) {
      const n = 10, front = [], back = [];
      for (let i = 0; i <= n; i++) { const u = i / n; front.push([Math.max(R * u, 0.002), 0.06 + depth * u * u, i === 0 ? P.hull : u > 0.9 ? P.teal : P.hull]); }
      hp.add(revolve([...front].reverse().map((p, i) => [p[0], p[1], i === 0 ? P.teal : i === 1 ? P.hull : undefined]), { seg: hp.seg(R), crease: 1.0 }), null, RX, 'paint');   // inside of the bowl (walk inward = faces +X)
      for (let i = 0; i <= n; i++) { const u = i / n; back.push([Math.max(R * u, 0.002), 0.045 + depth * u * u, P.shade]); }
      hp.add(revolve(back, { seg: hp.seg(R), crease: 1.0 }), null, RX, 'paint');
      if (hp.med) hp.around(6, a => hp.rod([0.05, Math.cos(a) * 0.05, Math.sin(a) * 0.05], [0.04 + depth * 0.8, Math.cos(a) * R * 0.9, Math.sin(a) * R * 0.9], 0.008, P.steel, 'metal', 5));
      hp.build(head); return;
    }
    hp.build(head);
    // umbrella of gold mesh petals that fold forward when stowed
    const np = 12;
    for (let i = 0; i < np; i++) {
      const a = i * TAU / np, hinge = sub(head, 'petalRoot' + i, 0.06, Math.cos(a) * 0.07, Math.sin(a) * 0.07); hinge.rotation.x = a;
      const pet = sub(hinge, 'petal' + i, 0, 0, 0), pp = new PB(pb.q), w = TAU * R / np * 0.52, sh = new THREE.Shape();
      sh.moveTo(0, -0.02); sh.lineTo(R, -w); sh.lineTo(R, w); sh.lineTo(0, 0.02); sh.closePath();
      // petal lies in the local X(depth)–Y(radial) plane → build flat in XY then stand it up: radial = +Y
      const sg = new THREE.ShapeGeometry(sh); sg.rotateZ(Math.PI / 2); sg.rotateY(Math.PI / 2);   // radial → +Y, width → Z, normal → X
      pp.add(sg, P.gold, null, 'foil', 3, 3);
      pp.rod([0, 0, 0], [0, R, 0], 0.011, P.silver, 'foil', 5);      // rib in the same mesh as its petal: one draw call each
      pp.build(pet);
    }
    return;
  }
  // whip: base box, spring, tapered mast, tip bead
  pb.rbox(rw, h * 0.1, t, 0.01, P.gun, M(0, y0 + h * 0.05, 0), 'metal');
  pb.cyl(rw * 0.3, rw * 0.36, h * 0.06, y0 + h * 0.13, P.steel, 'metal', 10);
  if (pb.med) { const pts = []; for (let i = 0; i <= 24; i++) { const u = i / 24; pts.push([Math.cos(u * TAU * 4) * rw * 0.18, y0 + h * 0.16 + u * h * 0.07, Math.sin(u * TAU * 4) * rw * 0.18]); } pb.tube(pts, rw * 0.04, P.silver, 'chrome', { seg: 5 }); }
  pb.rev([[rw * 0.1, y0 + h * 0.2, P.silver], [rw * 0.04, h / 2 - 0.03]], 'chrome', { seg: 6 });
  pb.sphere(rw * 0.16, P.teal, M(0, h / 2 - 0.02, 0), 'paint', 10, 8);
}

export function light(def, g, pb) {
  const { h, rw, t, variant } = def, x0 = -rw / 2, flood = variant === 'flood';
  pb.rbox(0.03, h * 0.8, t * (flood ? 0.5 : 0.7), 0.008, P.gun, M(x0 + 0.015, 0, 0), 'metal');
  pb.rod([x0 + 0.02, 0, 0], [x0 + rw * 0.45, 0, 0], 0.016, P.iron, 'metal', 6);
  const heads = flood ? [-t * 0.26, t * 0.26] : [0], r = flood ? Math.min(h * 0.44, t * 0.22) : Math.min(h, t) * 0.44;
  if (flood) pb.rbox(0.03, 0.03, t * 0.7, 0.006, P.iron, M(x0 + rw * 0.45, 0, 0), 'metal');
  for (const z of heads) {
    pb.add(revolve([[r * 0.5, 0, P.yellow], [r, rw * 0.36], [r * 1.06, rw * 0.44, P.gun], [r * 0.94, rw * 0.44], [r * 0.9, rw * 0.38, P.silver], [r * 0.3, 0.02]], { seg: pb.seg(r), crease: 0.5 }), null, along(x0 + rw * 0.42, 0, z), 'paint');
    pb.add(new THREE.CircleGeometry(r * 0.92, pb.seg(r)), 0xfff6dc, M(x0 + rw * 0.42 + rw * 0.4, 0, z, 0, Math.PI / 2, 0), 'beam');
    if (pb.med) for (const f of [0.4, 0.7]) pb.torus(r * lerp(0.5, 1, f), 0.006, P.gun, M(x0 + rw * 0.42 + rw * 0.36 * f, 0, z, 0, Math.PI / 2, 0), 'metal', 12, 4);
  }
}

export function ladder(def, g, pb) {
  const { h, rw, t, variant } = def, x0 = -rw / 2, tele = variant === 'telescopic', z = t * 0.42, xr = x0 + rw * 0.7;
  const rungs = (p, ya, yb, zz, rr) => { const n = Math.max(2, Math.round((yb - ya) / 0.24)); for (let i = 0; i < n; i++) { const y = lerp(ya, yb, (i + 0.5) / n); p.rod([xr, y, -zz], [xr, y, zz], rr, P.silver, 'chrome', 6); } };
  if (!tele) {
    for (const s of [-1, 1]) { pb.rod([xr, -h / 2, s * z], [xr, h / 2, s * z], 0.016, P.steel, 'metal', 6); for (const y of [-h * 0.4, h * 0.4]) pb.rod([x0, y, s * z], [xr, y, s * z], 0.012, P.steel, 'metal', 5); }
    rungs(pb, -h / 2, h / 2, z, 0.013); return;
  }
  pb.rbox(rw * 0.5, h, t, 0.012, P.gun, M(x0 + rw * 0.25, 0, 0), 'metal');
  pb.decalStrip('hazard', M(x0 + rw * 0.25, h / 2 - 0.05, t / 2 + 0.003), rw * 0.4, 0.05);
  for (const s of [-1, 1]) pb.rod([xr, -h / 2, s * z], [xr, h / 2, s * z], 0.02, P.steel, 'metal', 6);
  rungs(pb, -h / 2, h / 2, z, 0.012);
  // two sliding sections
  let parent = g;
  for (let i = 0; i < 2; i++) {
    const s = sub(parent, 'ladderExt' + i, 0, 0, 0), sp = new PB(pb.q), zz = z * (0.86 - i * 0.14);
    for (const k of [-1, 1]) sp.rod([xr + 0.012 * (i + 1), -h / 2, k * zz], [xr + 0.012 * (i + 1), h / 2, k * zz], 0.014, P.silver, 'chrome', 6);
    rungs(sp, -h / 2, h / 2, zz, 0.011);
    if (i === 1) for (const k of [-1, 1]) sp.sphere(0.024, P.amber, M(xr + 0.024, -h / 2, k * zz), 'paint', 8, 6);
    sp.build(s); parent = s;
  }
}

// Side-mounted parachute canister (the canopy itself is added by partmesh).
export function chute_radial(def, g, pb) {
  const { h, rw, t, variant } = def, x0 = -rw / 2, drogue = variant === 'drogue', col = drogue ? P.redPaint : P.hull;
  pb.rbox(rw * 0.2, h * 0.9, t * 0.8, 0.008, P.gun, M(x0 + rw * 0.1, 0, 0), 'metal');
  pb.poly([[x0 + rw * 0.15, -h / 2], [x0 + rw * 0.8, -h / 2 + h * 0.12], [x0 + rw, h * 0.3], [x0 + rw * 0.9, h / 2], [x0 + rw * 0.15, h / 2]], t, 0.03, col, null, 'hull');
  pb.rbox(rw * 0.7, 0.03, t * 0.9, 0.006, drogue ? P.hull : P.amber, M(x0 + rw * 0.52, h / 2 - 0.05, 0), 'paint');
  if (pb.med) { for (const z of [-0.3, 0.3]) pb.rbox(rw * 0.86, 0.012, t * 0.12, 0.003, P.gun, M(x0 + rw * 0.55, h / 2 + 0.004, z * t), 'paint'); pb.torus(0.03, 0.007, P.red, M(x0 + rw * 0.6, h / 2 + 0.03, 0), 'paint', 10, 5); }
  pb.decalFlat('arrowUp', M(x0 + rw * 0.6, -h * 0.05, t / 2 + 0.004), t * 0.26);
}

// ---------------------------------------------------------------------------------------------
// Science
// ---------------------------------------------------------------------------------------------
export function sci_small(def, g, pb) {
  const { h, rw, t, variant, experiment } = def, x0 = -rw / 2;
  if (variant === 'boom') {
    // magnetometer on a long folding boom
    pb.rbox(0.05, h, t, 0.01, P.gun, M(x0 + 0.025, 0, 0), 'metal');
    const bays = 6, w = t * 0.3;
    for (const [y, z] of [[w, 0], [-w * 0.5, w * 0.86], [-w * 0.5, -w * 0.86]]) pb.rod([x0 + 0.05, y, z], [x0 + rw * 0.86, y * 0.5, z * 0.5], 0.008, P.silver, 'chrome', 5);
    for (let i = 0; i <= bays; i++) { const x = lerp(x0 + 0.05, x0 + rw * 0.86, i / bays), k = lerp(1, 0.5, i / bays); pb.torus(w * k, 0.006, P.steel, M(x, 0, 0, 0, Math.PI / 2), 'metal', 3, 4); }
    pb.rbox(rw * 0.1, t * 0.5, t * 0.5, 0.02, P.gold, M(x0 + rw * 0.93, 0, 0), 'foil');
    pb.sphere(0.012, P.teal, M(x0 + rw * 0.99, 0, 0), 'lamp', 6, 4); return;
  }
  pb.rbox(rw * 0.24, h * 0.9, t * 0.9, 0.008, P.gun, M(x0 + rw * 0.12, 0, 0), 'metal');
  const cx = x0 + rw * 0.55;
  if (variant === 'grav') {
    // gimballed proof mass in a gold cage
    pb.rbox(rw * 0.6, h * 0.8, t * 0.8, 0.02, P.gold, M(cx, 0, 0), 'foil');
    pb.torus(t * 0.32, 0.012, P.steel, M(cx + rw * 0.3, 0, 0, 0, Math.PI / 2), 'metal', 16, 6);
    pb.sphere(t * 0.22, P.silver, M(cx + rw * 0.3, 0, 0), 'chrome', 14, 10);
    pb.sphere(0.01, P.green, M(cx + rw * 0.2, h * 0.34, t * 0.3), 'lamp', 6, 4);
  } else if (variant === 'seis') {
    // squat drum with a ground spike and levelling feet
    pb.cyl(t * 0.4, t * 0.44, h * 0.6, 0, P.hull, 'paint', 18, false, M(cx, 0, 0));
    pb.cyl(t * 0.42, t * 0.42, 0.02, h * 0.31, P.teal, 'paint', 18, false, M(cx, 0, 0));
    pb.cyl(0.012, 0.002, h * 0.3, -h * 0.42, P.steel, 'chrome', 6, false, M(cx, 0, 0));
    for (let i = 0; i < 3; i++) { const a = i * TAU / 3; pb.rod([cx + Math.cos(a) * t * 0.3, -h * 0.25, Math.sin(a) * t * 0.3], [cx + Math.cos(a) * t * 0.48, -h * 0.5, Math.sin(a) * t * 0.48], 0.008, P.steel, 'metal', 5); }
    pb.sphere(0.012, P.amber, M(cx, h * 0.33, 0), 'lamp', 6, 4);
  } else if (variant === 'sniffer') {
    // sample inlet funnel, analyser box, exhaust vents
    pb.rbox(rw * 0.6, h * 0.7, t * 0.86, 0.02, P.hull, M(cx, -h * 0.1, 0), 'hull');
    pb.add(revolve([[0.012, 0, P.steel], [t * 0.26, h * 0.2], [t * 0.22, h * 0.2, P.soot], [0.008, 0.01]], { seg: 14, crease: 0.4 }), null, M(cx, h * 0.25, 0), 'metal');
    for (let i = 0; i < 4; i++) pb.box(0.01, h * 0.04, t * 0.5, P.soot, M(cx + rw * 0.302, -h * 0.3 + i * h * 0.08, 0), 'metal');
    pb.decalFlat('vent', M(cx + rw * 0.304, h * 0.1, 0, 0, Math.PI / 2, 0), t * 0.5);
    pb.sphere(0.012, P.green, M(cx + rw * 0.3, -h * 0.4, t * 0.34), 'lamp', 6, 4);
  } else if (experiment === 'pressure') {
    // aneroid gauge with a glass face
    pb.cyl(t * 0.4, t * 0.4, rw * 0.4, 0, P.brass, 'metal', 18, false, along(cx, 0, 0));
    pb.add(new THREE.CircleGeometry(t * 0.34, 18), P.hull, M(cx + rw * 0.202, 0, 0, 0, Math.PI / 2, 0), 'paint');
    pb.box(0.006, t * 0.3, 0.012, P.red, M(cx + rw * 0.206, t * 0.08, 0.02, 0.5, 0, 0), 'paint');
    pb.add(new THREE.SphereGeometry(t * 0.6, 14, 6, 0, TAU, 0, 0.6), 0x16323c, mul(M(cx + rw * 0.2 - t * 0.6 * Math.cos(0.6) + 0.004, 0, 0), RX), 'glass');
    pb.cyl(0.012, 0.012, h * 0.3, h * 0.36, P.steel, 'chrome', 6, false, M(cx, 0, 0));
  } else {
    // thermometer: shielded sensor on a stalk with a white radiation shield stack
    pb.rbox(rw * 0.4, h * 0.5, t * 0.6, 0.012, P.hull, M(cx - rw * 0.1, -h * 0.2, 0), 'paint');
    pb.cyl(0.012, 0.012, h * 0.5, h * 0.15, P.steel, 'chrome', 6, false, M(cx, 0, 0));
    for (let i = 0; i < 4; i++) pb.cyl(t * 0.28, t * 0.34, h * 0.05, h * 0.16 + i * h * 0.08, P.hull, 'paint', 14, false, M(cx, 0, 0));
    pb.sphere(t * 0.14, P.red, M(cx, h * 0.5, 0), 'paint', 10, 8);
    pb.sphere(0.01, P.amber, M(cx + rw * 0.1, -h * 0.3, t * 0.3), 'lamp', 6, 4);
  }
}

export function sci_jar(def, g, pb) {
  const { h, rw, t, variant } = def, x0 = -rw / 2;
  if (variant === 'scope') {
    // survey telescope: foil tube on a fork mount, sun shade, glass objective
    const r = Math.min(rw, t) * 0.4, cx = x0 + rw * 0.58;
    pb.rbox(rw * 0.2, h * 0.4, t * 0.8, 0.01, P.gun, M(x0 + rw * 0.1, -h * 0.1, 0), 'metal');
    for (const z of [-1, 1]) pb.rbox(rw * 0.5, h * 0.12, 0.03, 0.006, P.iron, M(x0 + rw * 0.36, -h * 0.1, z * (r + 0.02)), 'metal');
    pb.rev([[0.002, -h / 2, P.gun], [r * 0.8, -h / 2], [r, -h / 2 + 0.04, P.gold], [r, h * 0.22, P.hull], [r * 1.08, h * 0.24], [r * 1.08, h / 2], [r * 1.0, h / 2, P.soot], [r * 1.0, h * 0.3]], 'foil', { m: M(cx, 0, 0), crease: 0.5 });
    pb.add(new THREE.SphereGeometry(r * 2.2, 18, 6, 0, TAU, 0, 0.46), 0x1a2f55, M(cx, h * 0.3 - r * 2.2 * Math.cos(0.46), 0), 'glass');
    pb.cyl(r * 0.3, r * 0.3, 0.12, -h * 0.2, P.gun, 'metal', 10, false, along(cx + r, -h * 0.0, 0));
    pb.sphere(0.012, P.green, M(cx + r * 0.6, -h * 0.44, r * 0.6), 'lamp', 6, 4); return;
  }
  // sample jar: bracket, metal lid and base, clear glass with bubbling green culture
  const r = Math.min(rw, t) * 0.42, cx = x0 + rw - r - 0.02;
  pb.rbox(rw - r, h * 0.18, t * 0.5, 0.01, P.gun, M(x0 + (rw - r) / 2, -h * 0.3, 0), 'metal'); pb.rbox(rw - r, h * 0.1, t * 0.4, 0.01, P.gun, M(x0 + (rw - r) / 2, h * 0.34, 0), 'metal');
  pb.rev([[0.002, -h / 2, P.gun], [r, -h / 2], [r, -h * 0.34], [r * 0.9, -h * 0.32]], 'metal', { m: M(cx, 0, 0), crease: 0.4 });
  pb.rev([[r * 0.9, h * 0.3, P.teal], [r, h * 0.32], [r, h * 0.44], [r * 0.5, h / 2], [0.002, h / 2]], 'paint', { m: M(cx, 0, 0), crease: 0.4 });
  pb.cyl(r * 0.84, r * 0.84, h * 0.36, -h * 0.14, P.green, 'paint', 18, false, M(cx, 0, 0));
  pb.cyl(r * 0.92, r * 0.92, h * 0.64, -h * 0.01, 0xffffff, 'jar', 18, true, M(cx, 0, 0));
  if (pb.med) for (const [dx, dy, dz, s] of [[0.3, 0.1, 0.2, 0.05], [-0.2, 0.16, -0.3, 0.035], [0.1, 0.2, -0.1, 0.03], [-0.4, 0.08, 0.3, 0.04]]) pb.sphere(r * s * 2.4, 0xd8ffe0, M(cx + dx * r, dy * h, dz * r), 'lamp', 6, 4);
  for (const z of [-1, 1]) pb.rod([cx, -h * 0.34, z * r * 1.0], [cx, h * 0.32, z * r * 1.0], 0.008, P.steel, 'chrome', 5);
}
