// Starwright part models: stack parts (pods, tanks, structure, utility rings). See geo.js for conventions.
import * as THREE from '../../lib/three.module.min.js';
import { PB, P, TAU, M, Mrad, mul, sub, flange, endCap, rib, porthole, windowPane, handrail, raceway, stringers } from './geo.js';

const clamp = (x, a, b) => Math.min(Math.max(x, a), b);
export const DORSAL = Math.PI / 2;   // plane parts: the canopy / roof side faces +Z
const SIZE_DECAL = r => (r < 0.4 ? 'sizeS' : r < 0.8 ? 'sizeM' : r < 1.5 ? 'sizeL' : 'sizeXL');
const SCHEME = {            // paint per size class: body, accent band, secondary
  S: { body: P.hull, band: P.amber, dark: P.gun },
  M: { body: P.hull, band: P.teal, dark: P.gun },
  L: { body: P.hull, band: P.tealDark, dark: P.graphite },
  XL: { body: P.foam, band: P.hull, dark: P.graphite },
};
const scheme = def => SCHEME[def.size] || SCHEME.M;
const lerp = (a, b, t) => a + (b - a) * t;

// Both end flanges of a stack part; returns the usable y range between them.
function ends(pb, def, o = {}) {
  const { h } = def, rT = def.rTop ?? def.r, rB = def.rBottom ?? def.r;
  const ft = o.top === false ? 0 : flange(pb, rT, h / 2, 1, o), fb = o.bottom === false ? 0 : flange(pb, rB, -h / 2, -1, o);
  return [-h / 2 + fb, h / 2 - ft];
}

// ---------------------------------------------------------------------------------------------
// Tanks
// ---------------------------------------------------------------------------------------------
export function tank(def, g, pb) {
  const { r, size } = def, sc = scheme(def), [a, b] = ends(pb, def), L = b - a;
  const d = clamp(r * 0.018, 0.006, 0.02), e = Math.min(0.12, L * 0.14), bh = clamp(L * 0.13, 0.05, 0.32), yb = b - e - bh * 0.9;
  const prof = [[r - 0.004, a, sc.body], ...rib(r, a + e, d * 2.4, d, sc.dark, sc.body)];
  const xl = size === 'XL', big = size === 'L' || xl;
  if (L > 2.6) prof.push(...rib(r, a + L * 0.5, d * 2, d * 0.8, sc.body, sc.body));
  if (L > 5) { prof.push(...rib(r, a + L * 0.25, d * 2, d * 0.8, sc.body, sc.body)); prof.sort((p, q) => p[1] - q[1]); }
  prof.push([r, yb - bh / 2, sc.band], [r, yb + bh / 2, sc.body], ...rib(r, b - e, d * 2.4, d, sc.dark, sc.body), [r - 0.004, b]);
  pb.rev(prof, 'hull');
  // intertank stringers on the big ones
  if (big && L > 1.5) stringers(pb, r, a + e + d * 3, a + e + Math.min(0.5, L * 0.12), Math.round(r * 40), 0.03, 0.016, xl ? P.foam : P.shade, 'paint', 0.05);
  // systems tunnel, fill port, vent line
  raceway(pb, r, a + e * 0.4, b - e * 0.4, 2.3, { w: clamp(r * 0.12, 0.04, 0.12), d: clamp(r * 0.06, 0.02, 0.05), color: xl ? 0xb5642a : P.shade });
  if (pb.med) {
    const pr = clamp(r * 0.09, 0.03, 0.08);
    pb.add(new THREE.CylinderGeometry(pr, pr * 1.15, 0.03, 12), P.steel, mul(Mrad(-0.75, r + 0.008, yb - bh * 1.3), M(0, 0, 0, 0, 0, -Math.PI / 2)), 'metal');
    pb.add(new THREE.CylinderGeometry(pr * 0.55, pr * 0.55, 0.05, 6), P.amber, mul(Mrad(-0.75, r + 0.03, yb - bh * 1.3), M(0, 0, 0, 0, 0, -Math.PI / 2)), 'paint');
  }
  if (pb.hi && L > 0.7) {
    const pa = 3.6, rr = r + 0.03, pts = [];
    for (let i = 0; i <= 6; i++) { const y = lerp(a + e * 1.6, b - e * 1.6, i / 6); pts.push([Math.cos(pa) * rr, y, Math.sin(pa) * rr]); }
    pb.tube(pts, 0.012, P.brass, 'metal', { seg: 6 });
    for (let i = 0; i <= 3; i++) { const y = lerp(a + e * 1.8, b - e * 1.8, i / 3); pb.box(0.04, 0.02, 0.035, P.gun, Mrad(pa, r + 0.014, y), 'metal'); }
  }
  // markings
  if (big) pb.decalBand('checker', r, b - e * 0.5 + (xl ? 0 : 0), clamp(e * 0.55, 0.05, 0.1), { lift: d + 0.004 });
  const dw = clamp(r * 0.85, 0.2, 1.1);
  if (L > 0.42) pb.decal('fuel', r, yb - bh / 2 - dw * 0.32, 0.55, dw, { lift: 0.005 });
  if (L > 1.2) pb.decal(SIZE_DECAL(r), r, yb - bh / 2 - dw * 0.8, 0.55, dw * 0.8);
  if (L > 2.4) { pb.decal('wordmark', r, a + L * 0.36, 0.55, clamp(r * 1.35, 0.5, 2.2)); pb.decal('arrowUp', r, a + L * 0.36, -0.6, clamp(r * 0.3, 0.12, 0.4)); }
  if (L > 1.5) pb.decal('roundel', r, a + L * (L > 2.4 ? 0.62 : 0.4), 0.55 + Math.PI, clamp(r * 0.6, 0.25, 0.9));
  if (L > 0.8) pb.decal('placard', r, a + e + 0.18, -0.4, clamp(r * 0.3, 0.12, 0.3));
}

export function monotank(def, g, pb) {
  const { r } = def, [a, b] = ends(pb, def, { color: P.iron }), L = b - a, n = Math.max(6, Math.round(r * 13));
  // an open frame of spherical bottles around a core
  pb.rev([[r * 0.62, a, P.gun], [r * 0.62, b]], 'metal');
  const br = Math.min(L * 0.5, TAU * r * 0.8 / n * 0.5);
  pb.around(n, an => {
    pb.sphere(br, P.yellow, mul(Mrad(an, r - br * 0.92, (a + b) / 2), M(0, 0, 0, 0, 0, 0, 1, Math.min(1.25, L * 0.5 / br), 1)), 'paint', pb.hi ? 16 : 10, pb.hi ? 12 : 8);
    if (pb.med) pb.torus(br * 0.995, br * 0.07, P.steel, mul(Mrad(an, r - br * 0.92, (a + b) / 2), M(0, 0, 0, Math.PI / 2)), 'metal', 16, 5);
  });
  pb.around(n, an => pb.box(0.03, L, 0.03, P.iron, Mrad(an, r - 0.016, (a + b) / 2), 'metal'), Math.PI / n);
  pb.decal('mono', r - br * 0.92 + br, (a + b) / 2, 0, Math.min(br * 1.3, 0.4), { lift: 0.006 });
}

export function xenontank(def, g, pb) {
  const { r } = def, [a, b] = ends(pb, def, { color: P.iron }), L = b - a, d = Math.min(L * 0.18, 0.05);
  // gold-foiled pressure vessel with banding straps
  pb.rev([[r - 0.01, a, P.gold], [r - d * 0.2, a + d], [r - d * 0.2, b - d], [r - 0.01, b]], 'foil');
  for (const t of [0.25, 0.75]) pb.ring(r - d * 0.25, r + 0.004, a + L * t - 0.012, a + L * t + 0.012, P.silver, 'chrome');
  if (pb.med) pb.around(4, an => { pb.add(new THREE.CylinderGeometry(0.022, 0.03, 0.05, 8), P.steel, mul(Mrad(an, r + 0.012, (a + b) / 2), M(0, 0, 0, 0, 0, -Math.PI / 2)), 'metal'); }, 0.4);
  pb.decal('xenon', r, (a + b) / 2, 1.2, Math.min(r * 0.9, L * 2.2), { lift: 0.006 });
}

// Aircraft fuselage: smooth skin, frames, cheat line along both flanks.
export function fuselage(def, g, pb) {
  const { h, r, variant } = def, rT = def.rTop, rB = def.rBottom, y0 = -h / 2, y1 = h / 2, c = 0.035;
  const col = P.hull, taper = rT !== rB;
  const rAt = y => lerp(rB, rT, (y - y0) / h);
  const prof = [[rB - 0.012, y0, P.gun], [rB, y0 + c, col]];
  if (taper) { const n = 8; for (let i = 1; i < n; i++) { const t = i / n, k = t * t * (3 - 2 * t); prof.push([lerp(rB, rT, k), lerp(y0 + c, y1 - c, t)]); } }
  prof.push([rT, y1 - c, P.gun], [rT - 0.012, y1]);
  pb.rev(prof, 'hull');
  endCap(pb, rT - 0.012, y1 - 0.002, 1); endCap(pb, rB - 0.012, y0 + 0.002, -1);
  // cheat lines
  const rs = y => (taper ? (() => { const t = clamp((y - y0 - c) / (h - 2 * c), 0, 1), k = t * t * (3 - 2 * t); return lerp(rB, rT, k); })() : r);
  const strip = (ang, w, colr, lift) => { const n = taper ? 8 : 1; for (let i = 0; i < n; i++) { const ya = lerp(y0 + c, y1 - c, i / n), yb = lerp(y0 + c, y1 - c, (i + 1) / n); pb.patch(rs(ya), rs(yb), ya, yb, ang, w * Math.min(rs(ya), rs(yb)) / r, lift, colr, 'paint'); } };
  for (const s of [0, Math.PI]) { strip(DORSAL + Math.PI / 2 + s, r * 0.16, P.teal, 0.003); strip(DORSAL + Math.PI / 2 + s - 0.13 * (s ? -1 : 1), r * 0.05, P.gun, 0.003); }
  if (variant === 'hollow') {
    // cabin windows down both flanks
    const n = Math.max(2, Math.round(h / 0.45));
    for (const s of [0, Math.PI]) for (let i = 0; i < n; i++) { const y = y0 + h * (i + 0.5) / n; windowPane(pb, r, r, y - 0.11, y + 0.11, DORSAL + Math.PI / 2 + s + 0.42 * (s ? -1 : 1), 0.16, { th: 0.008 }); }
    pb.decal('rescue', r, 0, DORSAL - 0.5, r * 0.6);
  } else if (!taper) {
    pb.decal('fuel', r, y1 - 0.3, DORSAL - 0.7, clamp(r * 0.5, 0.2, 0.5));
    if (h > 3) pb.decal('wordmark', r, 0, DORSAL + Math.PI / 2 + 0.75, r * 1.2);
    if (pb.med) { pb.add(new THREE.CylinderGeometry(r * 0.09, r * 0.1, 0.02, 12), P.steel, mul(Mrad(DORSAL, r + 0.006, y1 - 0.35), M(0, 0, 0, 0, 0, -Math.PI / 2)), 'metal'); }
  }
  if (pb.med && !taper) pb.decalBand('ticks', r, y0 + c + 0.03, 0.03);
  pb.decal('noStep', rs(0), 0, DORSAL + 0.9, clamp(r * 0.4, 0.15, 0.4), { slope: (rT - rB) / h });
}

// ---------------------------------------------------------------------------------------------
// Command pods
// ---------------------------------------------------------------------------------------------
function rcsQuad(pb, r, y, ang, s, slope = 0) {
  if (!pb.med) return;
  const m = Mrad(ang, r, y, -Math.atan(slope));
  pb.rbox(s * 0.5, s * 1.5, s * 1.5, s * 0.12, P.graphite, mul(m, M(s * 0.1, 0, 0)), 'metal');
  for (const [dy, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) pb.add(new THREE.CylinderGeometry(s * 0.3, s * 0.14, s * 0.5, 8, 1, true), P.steel, mul(m, M(s * 0.35, dy * s * 0.5, dz * s * 0.5, dz * 0.9, 0, -Math.PI / 2 + dy * 0.9)), 'metal');
}
function hatchDoor(pb, rAt, slope, y0, y1, ang, w) {
  const r0 = rAt(y0), r1 = rAt(y1), ym = (y0 + y1) / 2;
  pb.patch(r0, r1, y0, y1, ang, w, 0.016, P.shade, 'hull');
  pb.patch(r0 + 0.016, r1 + 0.016, y0 + 0.02, y1 - 0.02, ang, w - 0.04, 0.004, P.hull, 'hull');
  porthole(pb, rAt(ym + (y1 - y0) * 0.16) + 0.02, ym + (y1 - y0) * 0.16, ang, Math.min(w, y1 - y0) * 0.17, { slope });
  if (pb.med) {
    const a = ang - w / rAt(ym) * 0.3, rr = rAt(ym - (y1 - y0) * 0.2) + 0.02;
    pb.tube([[Math.cos(a) * rr, ym - (y1 - y0) * 0.28, Math.sin(a) * rr], [Math.cos(a) * (rr + 0.045), ym - (y1 - y0) * 0.24, Math.sin(a) * (rr + 0.045)], [Math.cos(a) * (rr + 0.045 + slope * 0.12), ym - (y1 - y0) * 0.12, Math.sin(a) * (rr + 0.045 + slope * 0.12)], [Math.cos(a) * (rr + slope * 0.16), ym - (y1 - y0) * 0.08, Math.sin(a) * (rr + slope * 0.16)]], 0.012, P.amber, 'paint', { seg: 6 });
  }
}

export function capsule(def, g, pb) {
  const { h, variant } = def, rT = def.rTop, rB = def.rBottom, y0 = -h / 2, y1 = h / 2;
  if (variant === 'can') return landerCan(def, g, pb);
  const skirt = clamp(h * 0.09, 0.05, 0.2), neck = clamp(h * 0.1, 0.06, 0.24);
  const ya = y0 + skirt, yb = y1 - neck, slope = (rT - rB) / (yb - ya);
  const rAt = y => rB + slope * (clamp(y, ya, yb) - ya);
  const sm = rB < 0.4, crew = def.crew || 1, xl = variant === 'deck';
  // body: charcoal skirt, white cone with a teal waist stripe, machined neck
  const s1 = ya + (yb - ya) * 0.1, s2 = ya + (yb - ya) * 0.17;
  pb.rev([[rB - 0.03, y0, P.graphite], [rB, y0 + 0.012], [rB, ya, P.hull], [rAt(s1), s1, P.teal], [rAt(s2), s2, P.hull], [rT, yb]], 'hull', { crease: 0.3 });
  pb.rev([[rT, yb, P.gun], [rT + 0.01, yb + 0.012], [rT + 0.01, y1 - 0.012], [rT - 0.012, y1]], 'metal');
  endCap(pb, rB - 0.03, y0 + 0.002, -1); endCap(pb, rT - 0.012, y1 - 0.002, 1);
  pb.studs(rT + 0.01, (yb + y1) / 2, Math.max(8, Math.round(rT * 30)), 0.014, P.steel);
  pb.studs(rB, y0 + skirt * 0.5, Math.max(10, Math.round(rB * 26)), 0.016, P.steel, 0.1);
  if (pb.med) pb.hoop(rT * 0.72, 0.014, y1 + 0.004, P.amber, 'paint');
  // windows facing +Z (and around for the big pods), hatch on the far side
  const wy = ya + (yb - ya) * (xl ? 0.66 : 0.56), wh = (yb - ya) * (xl ? 0.2 : 0.24), ww = clamp(rAt(wy) * (sm ? 0.75 : 0.5), 0.12, 0.62);
  const nWin = sm ? 1 : crew >= 5 ? 5 : crew >= 3 ? 3 : 2, spread = sm ? 0 : crew >= 3 ? 0.62 : 0.5;
  for (let i = 0; i < nWin; i++) {
    const an = DORSAL + (i - (nWin - 1) / 2) * spread * (nWin > 3 ? 0.9 : 1.15);
    windowPane(pb, rAt(wy - wh / 2), rAt(wy + wh / 2), wy - wh / 2, wy + wh / 2, an, ww * (i === (nWin - 1) / 2 ? 1 : 0.82), { th: 0.018 });
  }
  if (xl) for (let i = 0; i < 9; i++) { const an = DORSAL + (i - 4) * 0.42, y = ya + (yb - ya) * 0.34; porthole(pb, rAt(y) + 0.004, y, an, 0.12, { slope }); }
  const hy0 = ya + (yb - ya) * (xl ? 0.25 : 0.24), hy1 = ya + (yb - ya) * (xl ? 0.6 : 0.78), ha = DORSAL + Math.PI;
  if (!sm) {
    hatchDoor(pb, rAt, slope, hy0, hy1, ha, clamp(rAt((hy0 + hy1) / 2) * 0.7, 0.3, 0.8));
    handrail(pb, y => rAt(y), ha + 0.75, hy0, ha + 0.6, hy1, { posts: 2 }); handrail(pb, y => rAt(y), ha - 0.75, hy0, ha - 0.6, hy1, { posts: 2 });
    handrail(pb, y => rAt(y), DORSAL - 1.25, wy + wh * 0.8, DORSAL - 0.6, wy + wh * 0.8, { posts: 2 });
  } else porthole(pb, rAt(wy) + 0.004, wy, ha, 0.07, { slope });
  for (let i = 0; i < 4; i++) rcsQuad(pb, rAt(ya + (yb - ya) * 0.3), ya + (yb - ya) * 0.3, DORSAL + Math.PI / 4 + i * Math.PI / 2 + 0.25, clamp(rB * 0.085, 0.03, 0.09), slope);
  // markings
  const dy = ya + (yb - ya) * 0.34, dr = rAt(dy);
  pb.decal('roundel', dr, dy, DORSAL + 1.3, clamp(dr * 0.42, 0.14, 0.6), { slope });
  pb.decal('flag', dr, dy, DORSAL - 1.3, clamp(dr * 0.5, 0.16, 0.7), { slope });
  if (!sm) { pb.decal('rescue', rAt(hy1 + 0.06), hy1 + (yb - hy1) * 0.45, ha, clamp(rAt(hy1) * 0.6, 0.2, 0.6), { slope }); pb.decal('arrowUp', rAt(hy0), (hy0 + hy1) / 2, ha + 1.05, 0.1, { slope }); }
  pb.decalBand('ticks', rAt(ya + 0.03), ya + 0.035, 0.04, { r2: rAt(ya + 0.055) });
}

function landerCan(def, g, pb) {
  const { r } = def, [a, b] = ends(pb, def, { color: P.iron }), L = b - a, mid = a + L * 0.42;
  // gold foil lower half, white upper half, boxy equipment bays
  pb.rev([[r - 0.006, a, P.gold], [r - 0.006, mid]], 'foil');
  pb.rev([[r - 0.006, mid, P.gun], [r + 0.006, mid + 0.012], [r + 0.006, mid + 0.04, P.hull], [r, mid + 0.05], [r, b - 0.03], [r - 0.006, b]], 'hull');
  for (const s of [-1, 1]) windowPane(pb, r, r, mid + L * 0.14, b - L * 0.1, DORSAL + s * 0.42, r * 0.56, { th: 0.02 });
  const ha = DORSAL + Math.PI;
  hatchDoor(pb, () => r, 0, a + 0.08, b - 0.1, ha, r * 0.8);
  handrail(pb, () => r, ha + 0.85, a + 0.1, ha + 0.85, b - 0.1); handrail(pb, () => r, ha - 0.85, a + 0.1, ha - 0.85, b - 0.1);
  for (const an of [DORSAL + 1.5, DORSAL - 1.5]) { pb.rbox(0.09, L * 0.5, r * 0.6, 0.02, P.shade, Mrad(an, r + 0.03, a + L * 0.45), 'hull'); if (pb.hi) pb.rbox(0.03, L * 0.2, r * 0.3, 0.008, P.gun, Mrad(an, r + 0.085, a + L * 0.5), 'metal'); }
  for (let i = 0; i < 4; i++) rcsQuad(pb, r, b - L * 0.18, DORSAL + Math.PI / 4 + i * Math.PI / 2, 0.055);
  pb.decal('flag', r, mid + L * 0.3, DORSAL + 1.05, 0.26); pb.decal('n07', r, mid + L * 0.3, DORSAL - 1.05, 0.2);
  if (pb.med) { pb.rod([Math.cos(DORSAL - 0.9) * r * 0.8, b, Math.sin(DORSAL - 0.9) * r * 0.8], [Math.cos(DORSAL - 0.9) * r * 0.86, b + 0.3, Math.sin(DORSAL - 0.9) * r * 0.86], 0.008, P.steel, 'chrome', 5); }
}

// Aircraft cockpits: nose toward +Y, canopy on the dorsal (+Z) side.
export function cockpit(def, g, pb) {
  const { h, variant } = def, rT = def.rTop, rB = def.rBottom, y0 = -h / 2, y1 = h / 2;
  const inline = variant === 'inline', deck = variant === 'deck', c = 0.035;
  const rAt = y => { if (inline) return rB; const t = clamp((y - y0 - c) / (h - 2 * c), 0, 1); return lerp(rB, rT, Math.pow(t, 1.9)); };
  const n = inline ? 1 : 14, prof = [[rB - 0.012, y0, P.gun], [rB, y0 + c, P.hull]];
  for (let i = 1; i <= n; i++) { const y = lerp(y0 + c, y1 - c, i / n); prof.push([rAt(y), y]); }
  prof[prof.length - 1][2] = P.gun; prof.push([rT - 0.012, y1]);
  pb.rev(prof, 'hull', { crease: 0.5 });
  endCap(pb, rT - 0.012, y1 - 0.002, 1); endCap(pb, rB - 0.012, y0 + 0.002, -1);
  // canopy: a glazed blister with frames
  const cy0 = y0 + h * (inline ? 0.14 : deck ? 0.3 : 0.2), cy1 = y0 + h * (inline ? 0.86 : deck ? 0.72 : 0.74), cl = cy1 - cy0, ym = (cy0 + cy1) / 2;
  const cw = deck ? 1.5 : 1.05, lift = rB * (deck ? 0.1 : 0.16);
  const blister = (sc, color, bucket, a0, a1) => {
    const N = pb.hi ? 12 : 7, Mseg = pb.hi ? 10 : 6, pos = [], nor = [], uv = [];
    const pt = (i, j) => {
      const u = i / N, v = j / Mseg, y = lerp(cy0, cy1, u), an = DORSAL + lerp(a0, a1, v);
      const bump = Math.pow(Math.sin(Math.PI * u), 0.7) * Math.pow(Math.cos((lerp(a0, a1, v)) / (cw / 2) * Math.PI / 2), 0.8);
      const rr = rAt(y) + 0.006 + lift * Math.max(bump, 0) * sc;
      return [Math.cos(an) * rr, y, Math.sin(an) * rr, u, v];
    };
    for (let i = 0; i < N; i++) for (let j = 0; j < Mseg; j++) { const A = pt(i, j), B = pt(i + 1, j), C = pt(i, j + 1), D = pt(i + 1, j + 1); for (const q of [A, B, C, B, D, C]) { pos.push(q[0], q[1], q[2]); uv.push(q[3], q[4]); } }
    const ge = new THREE.BufferGeometry(); ge.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); ge.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    const gi = new THREE.BufferGeometry().copy(ge); // smooth normals: weld by building an indexed copy
    const merged = mergeVerts(gi); merged.computeVertexNormals();
    pb.add(merged, color, null, bucket);
  };
  blister(1, 0x12303c, 'glass', -cw / 2, cw / 2);
  // frame bars over the glass
  if (pb.med) {
    const bar = (u0, v0, u1, v1) => { const pts = []; for (let k = 0; k <= 6; k++) { const u = lerp(u0, u1, k / 6), v = lerp(v0, v1, k / 6), y = lerp(cy0, cy1, u), a = DORSAL + v * cw / 2; const bump = Math.pow(Math.sin(Math.PI * u), 0.7) * Math.pow(Math.max(Math.cos(v * Math.PI / 2), 0), 0.8); const rr = rAt(y) + 0.012 + lift * bump; pts.push([Math.cos(a) * rr, y, Math.sin(a) * rr]); } pb.tube(pts, rB * 0.022, P.gun, 'paint', { seg: 6 }); };
    bar(0.02, -1, 0.02, 1); bar(0.98, -1, 0.98, 1); bar(0.02, -1, 0.98, -1); bar(0.02, 1, 0.98, 1);
    const ribs = deck ? [0.3, 0.55, 0.78] : inline ? [0.5] : [0.36, 0.7]; for (const u of ribs) bar(u, -1, u, 1);
    if (deck || inline) bar(0.02, 0, 0.98, 0);
  }
  // cheat lines, intakes for avionics, markings
  const side = DORSAL + Math.PI / 2;
  for (const s of [0, Math.PI]) { const N2 = inline ? 1 : 8; for (let i = 0; i < N2; i++) { const ya = lerp(y0 + c, y1 - h * (inline ? 0 : 0.12), i / N2), yb = lerp(y0 + c, y1 - h * (inline ? 0 : 0.12), (i + 1) / N2); pb.patch(rAt(ya), rAt(yb), ya, yb, side + s, rB * 0.16 * Math.min(rAt(yb) / rB, 1), 0.003, P.teal, 'paint'); } }
  pb.decal('rescue', rAt(cy0 - 0.05), cy0 + cl * 0.15, DORSAL + cw / 2 + 0.38, rB * 0.5, { slope: 0 });
  pb.decal('roundel', rAt(y0 + h * 0.14), y0 + h * 0.12, side + 0.55, rB * 0.36);
  pb.decal('n12', rAt(y0 + h * 0.14), y0 + h * 0.12, side + Math.PI - 0.55, rB * 0.34);
  if (!inline && pb.med) { // pitot probe on the nose
    pb.rod([0, y1 - 0.02, 0], [0, y1 + rT * 0.9, 0], rT * 0.08, P.steel, 'chrome', 6);
  }
  if (deck) for (let i = 0; i < 4; i++) rcsQuad(pb, rAt(y0 + h * 0.5), y0 + h * 0.5, DORSAL + Math.PI + (i - 1.5) * 0.5, 0.06);
}
function mergeVerts(geo) {
  // weld identical positions so computeVertexNormals smooths across the grid
  const p = geo.attributes.position, u = geo.attributes.uv, map = new Map(), idx = [], np = [], nu = [];
  for (let i = 0; i < p.count; i++) {
    const k = `${p.getX(i).toFixed(4)},${p.getY(i).toFixed(4)},${p.getZ(i).toFixed(4)}`;
    let j = map.get(k); if (j === undefined) { j = np.length / 3; map.set(k, j); np.push(p.getX(i), p.getY(i), p.getZ(i)); nu.push(u.getX(i), u.getY(i)); }
    idx.push(j);
  }
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(np, 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute(nu, 2)); g.setIndex(idx);
  return g;
}

// Probe cores: an avionics ring wrapped in foil, or a faceted bus.
export function probe(def, g, pb) {
  const { h, r, variant } = def, y0 = -h / 2, y1 = h / 2;
  if (variant === 'octo') {
    const rr = r * 0.98, f = h * 0.14;
    pb.rev([[rr * 0.72, y0, P.gun], [rr, y0 + f, P.gold], [rr, y1 - f, P.gun], [rr * 0.72, y1]], 'foil', { seg: 8, crease: 0.1, a0: Math.PI / 8, a1: TAU + Math.PI / 8 });
    pb.disc(rr * 0.72, y1, true, P.gun, 'metal'); pb.disc(rr * 0.72, y0, false, P.gun, 'metal');
    const ap = rr * Math.cos(Math.PI / 8);
    for (let i = 0; i < 8; i++) {
      const an = i * TAU / 8 + TAU / 16 * 2;
      if (i % 2 === 0) { pb.rbox(0.012, h * 0.44, r * 0.5, 0.004, P.graphite, Mrad(an, ap + 0.004, 0), 'metal'); if (pb.hi) for (const [dy, dz] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) pb.sphere(0.008, P.steel, Mrad(an, ap + 0.012, dy * h * 0.18).multiply(M(0, 0, dz * r * 0.2)), 'metal', 6, 4); }
      else if (i === 1) { pb.add(new THREE.CylinderGeometry(r * 0.16, r * 0.16, 0.03, 16), P.gun, mul(Mrad(an, ap + 0.012, 0), M(0, 0, 0, 0, 0, -Math.PI / 2)), 'metal'); pb.add(new THREE.SphereGeometry(r * 0.13, 12, 8), 0x14303a, Mrad(an, ap + 0.016, 0), 'glass'); }
      else if (i === 5) pb.decalFlat('starmark', mul(Mrad(an, ap + 0.006, 0), M(0, 0, 0, 0, Math.PI / 2, 0)), h * 0.4);
      else pb.sphere(0.014, i === 3 ? P.green : P.amber, Mrad(an, ap + 0.004, h * 0.12), 'lamp', 6, 4);
    }
    return;
  }
  const [a, b] = ends(pb, def, { color: P.iron, h: Math.min(h * 0.18, 0.06) }), L = b - a;
  pb.rev([[r - 0.012, a, P.gold], [r - 0.012, b]], 'foil');
  // avionics boxes set into the ring, a lens, status lamps, a stub antenna
  const n = Math.max(6, Math.round(r * 10));
  pb.around(n, (an, i) => {
    if (i % 3 === 2) { pb.add(new THREE.CylinderGeometry(L * 0.3, L * 0.34, 0.03, 16), P.gun, mul(Mrad(an, r, (a + b) / 2), M(0, 0, 0, 0, 0, -Math.PI / 2)), 'metal'); pb.add(new THREE.SphereGeometry(L * 0.24, 12, 8), 0x14303a, Mrad(an, r + 0.004, (a + b) / 2), 'glass'); }
    else { pb.rbox(0.03, L * 0.72, Math.min(TAU * r / n * 0.6, 0.5), 0.008, i % 3 ? P.graphite : P.shade, Mrad(an, r, (a + b) / 2), i % 3 ? 'metal' : 'paint'); pb.sphere(0.012, i % 2 ? P.green : P.amber, Mrad(an, r + 0.018, (a + b) / 2 + L * 0.2), 'lamp', 6, 4); }
  }, 0.3);
  pb.decal('probe', r - 0.012, (a + b) / 2, 0.3 + TAU / n * 0.5, Math.min(TAU * r / n * 0.7, 0.4), { lift: 0.008, h: Math.min(L * 0.36, 0.1) });
}

// Rover chassis: a pressed tub with a sloped prow, an equipment deck and suspension rails for the wheels.
// Length (travel direction) along +Y, deck (dorsal) faces +Z, belly −Z. Wheels mount on the lower flanks, on the
// stack radius, so the rails sit out there: about (±0.84 r, ·, −0.54 r).
export function rover_body(def, g, pb) {
  const { h, r } = def, y0 = -h / 2, y1 = h / 2, w = r * 1.78, zt = r * 0.3, zb = -r * 0.46, L = h - 0.1, bv = 0.03;   // bv: the tub's bevel stands this far proud of its outline
  const X = M(0, 0, 0, Math.PI / 2, 0, 0);                     // shapes drawn in (x, z) and extruded along Y
  const sec = k => [[-w * 0.43 * k, zt], [w * 0.43 * k, zt], [w * 0.5 * k, zt - r * 0.14], [w * 0.47 * k, zb + r * 0.2], [w * 0.3 * k, zb], [-w * 0.3 * k, zb], [-w * 0.47 * k, zb + r * 0.2], [-w * 0.5 * k, zt - r * 0.14]];
  // tub (white, panelled), darker belly pan, stepped prow and stern
  pb.poly(sec(1), L * 0.74, 0.03, P.hull, mul(M(0, -L * 0.03, 0), X), 'hull');
  pb.poly(sec(0.9).map(p => [p[0], p[1] * 0.86 - r * 0.02]), L * 0.14, 0.03, P.shade, mul(M(0, y1 - 0.05 - L * 0.1, 0), X), 'hull');     // prow
  pb.poly(sec(0.86).map(p => [p[0], p[1] * 0.8]), L * 0.1, 0.025, P.shade, mul(M(0, y0 + 0.05 + L * 0.06, 0), X), 'hull');             // stern
  pb.rbox(w * 0.62, L * 0.8, 0.03, 0.01, P.graphite, M(0, 0, zb - bv - 0.008), 'metal');                                                      // skid plate
  // stack faces: machined pads where things bolt on fore and aft
  for (const y of [y1 - 0.025, y0 + 0.025]) { pb.rbox(w * 0.5, 0.05, r * 0.5, 0.012, P.gun, M(0, y, -r * 0.06), 'metal'); if (pb.hi) for (const sx of [-1, 1]) for (const sz of [-1, 1]) pb.add(new THREE.CylinderGeometry(0.016, 0.016, 0.02, 6), P.steel, M(sx * w * 0.2, y + Math.sign(y) * 0.026, -r * 0.06 + sz * r * 0.18), 'metal'); }
  // suspension rails with three hub brackets a side, tied to the tub by struts
  const rx = r * 0.84, rz = -r * 0.54;
  for (const s of [-1, 1]) {
    pb.rod([s * rx, -L * 0.42, rz], [s * rx, L * 0.42, rz], r * 0.05, P.iron, 'metal', 10);
    for (const yy of [-0.62, 0, 0.62]) {
      const y = clamp(yy, -L * 0.4, L * 0.4);
      pb.cyl(r * 0.085, r * 0.085, r * 0.09, 0, P.steel, 'metal', 12, false, mul(M(s * rx, y, rz), M(0, 0, 0, 0, 0, Math.PI / 2)));
      pb.rod([s * w * 0.4, y, zb + r * 0.12], [s * rx, y, rz], r * 0.035, P.steel, 'metal', 6);
      if (pb.med) pb.rod([s * w * 0.46, y + 0.12, zt - r * 0.2], [s * rx, y, rz], r * 0.022, P.silver, 'chrome', 5);
    }
  }
  // flanks: foil-wrapped equipment bays behind a rub rail
  for (const s of [-1, 1]) {
    pb.rbox(0.02, L * 0.5, r * 0.3, 0.008, P.gold, mul(M(s * (w * 0.488 + bv), -L * 0.04, zt - r * 0.36), M(0, 0, 0, 0, s * 0.11, 0)), 'foil');
    pb.rod([s * (w * 0.5 + bv + 0.008), -L * 0.36, zt - r * 0.14], [s * (w * 0.5 + bv + 0.008), L * 0.3, zt - r * 0.14], 0.016, P.gun, 'metal', 6);
  }
  // deck: a framed solar array aft, an avionics box and a radiator forward
  const dz = zt + bv + 0.002;
  pb.rbox(w * 0.76, L * 0.42, 0.024, 0.006, P.gun, M(0, -L * 0.17, dz + 0.008), 'metal');
  pb.add(new THREE.PlaneGeometry(w * 0.7, L * 0.38), 0xffffff, M(0, -L * 0.17, dz + 0.022), 'solar', w * 0.7 / 0.5, L * 0.38 / 0.5);
  pb.rbox(w * 0.36, L * 0.17, r * 0.16, 0.02, P.hull, M(-w * 0.17, L * 0.2, dz + r * 0.08), 'hull');
  pb.rbox(w * 0.3, L * 0.012, r * 0.02, 0.003, P.teal, M(-w * 0.17, L * 0.2 - L * 0.07, dz + r * 0.165), 'paint');
  if (pb.med) for (let i = 0; i < 6; i++) pb.rbox(w * 0.24, 0.012, r * 0.09, 0.003, P.silver, mul(M(w * 0.2, L * 0.13 + i * L * 0.024, dz + r * 0.04), M(0, 0, 0, 0.5, 0, 0)), 'metal');   // radiator louvres
  pb.rbox(w * 0.28, L * 0.17, 0.016, 0.004, P.gun, M(w * 0.2, L * 0.19, dz + 0.006), 'metal');
  // camera mast with a two-eyed head and a small dish
  const mx = w * 0.3, my = L * 0.33, mh = r * 0.78;
  pb.cyl(r * 0.07, r * 0.09, r * 0.08, 0, P.gun, 'metal', 12, false, M(mx, my, dz + r * 0.04, Math.PI / 2));
  pb.rod([mx, my, dz], [mx, my, dz + mh], r * 0.032, P.silver, 'chrome', 8);
  pb.rbox(r * 0.34, r * 0.13, r * 0.14, 0.02, P.hull, M(mx, my, dz + mh + r * 0.05), 'paint');
  for (const s of [-1, 1]) { pb.cyl(r * 0.05, r * 0.05, r * 0.06, 0, P.gun, 'metal', 12, false, M(mx + s * r * 0.09, my + r * 0.09, dz + mh + r * 0.05)); pb.sphere(r * 0.04, 0x14303a, M(mx + s * r * 0.09, my + r * 0.115, dz + mh + r * 0.05), 'glass', 10, 6); }
  if (pb.med) {
    const ax = -w * 0.32, ay = -L * 0.02;
    pb.rod([ax, ay, dz], [ax, ay, dz + r * 0.36], r * 0.022, P.steel, 'chrome', 6);
    pb.rev([[0.002, 0, P.hull], [r * 0.1, r * 0.015], [r * 0.19, r * 0.06], [r * 0.2, r * 0.07, P.gun], [r * 0.19, r * 0.075], [0.002, r * 0.02, P.hull]], 'paint', { m: mul(M(ax, ay, dz + r * 0.36), M(0, 0, 0, Math.PI / 2 - 0.5, 0, 0)), seg: 16, crease: 1.0 });
    // prow: bull bar and headlamps; stern: tow eye
    pb.tube([[-w * 0.36, y1 - 0.05, zb + r * 0.18], [-w * 0.3, y1 + 0.0, zb + r * 0.3], [0, y1 + 0.02, zb + r * 0.34], [w * 0.3, y1 + 0.0, zb + r * 0.3], [w * 0.36, y1 - 0.05, zb + r * 0.18]], r * 0.03, P.gun, 'metal', { seg: 6 });
    pb.torus(r * 0.05, r * 0.016, P.steel, M(0, y0 + 0.01, zb + r * 0.2, Math.PI / 2), 'metal', 10, 5);
  }
  for (const s of [-1, 1]) { pb.cyl(r * 0.07, r * 0.07, 0.03, 0, P.gun, 'metal', 12, false, M(s * w * 0.3, y1 - 0.075, zt - r * 0.2)); pb.sphere(r * 0.055, 0xfff4d0, M(s * w * 0.3, y1 - 0.058, zt - r * 0.2), 'lamp', 10, 6); }
  pb.decalFlat('wordmark', M(-w * 0.17, L * 0.2, dz + r * 0.163), w * 0.3);
  pb.decalStrip('hazard', M(0, y0 + 0.11 + L * 0.02, dz + 0.002), w * 0.7, 0.045);
  pb.sphere(0.02, P.red, M(-w * 0.34, y0 + 0.06, zt - r * 0.1), 'lamp', 6, 4); pb.sphere(0.02, P.green, M(w * 0.34, y0 + 0.06, zt - r * 0.1), 'lamp', 6, 4);
}

// Crewed laboratory: a habitat can with a window band, racks and a rooftop experiment pallet.
export function lab(def, g, pb) {
  const { r } = def, [a, b] = ends(pb, def), L = b - a, d = 0.016;
  const w0 = a + L * 0.56, w1 = a + L * 0.72;
  pb.rev([[r - 0.004, a, P.hull], ...rib(r, a + 0.12, 0.04, d, P.gun, P.hull), [r, a + L * 0.22, P.teal], [r, a + L * 0.26, P.hull],
    [r, w0 - 0.06, P.graphite], [r, w1 + 0.06, P.hull], ...rib(r, b - 0.12, 0.04, d, P.gun, P.hull), [r - 0.004, b]], 'hull');
  const n = 10; pb.around(n, an => windowPane(pb, r, r, w0, w1, an, TAU * r / n * 0.62, { th: 0.016 }));
  // equipment racks wrapped in foil on two sides, a hatch, handrails
  for (const an of [0.8, 0.8 + Math.PI]) { pb.patch(r, r, a + L * 0.3, a + L * 0.5, an, r * 1.1, 0.05, P.gold, 'foil'); if (pb.med) for (let i = 0; i < 3; i++) pb.rbox(0.03, L * 0.12, r * 0.22, 0.008, P.graphite, Mrad(an + (i - 1) * 0.3, r + 0.06, a + L * 0.4), 'metal'); }
  hatchDoor(pb, () => r, 0, a + L * 0.06, a + L * 0.5, DORSAL + Math.PI, 0.7);
  for (const s of [-1, 1]) handrail(pb, () => r, DORSAL + Math.PI + s * 0.42, a + L * 0.06, DORSAL + Math.PI + s * 0.42, a + L * 0.5, { posts: 3 });
  handrail(pb, () => r, 0.2, b - 0.3, 1.4, b - 0.3, { posts: 3 }); handrail(pb, () => r, 0.2 + Math.PI, b - 0.3, 1.4 + Math.PI, b - 0.3, { posts: 3 });
  raceway(pb, r, a + 0.2, b - 0.2, DORSAL + 2.2, { w: 0.14, d: 0.05 });
  pb.decal('wordmark', r, b - L * 0.14, DORSAL, 1.5); pb.decal('roundel', r, a + L * 0.4, DORSAL - 0.1, 0.55); pb.decal('n03', r, a + L * 0.4, DORSAL + 1.9, 0.3);
}

// ---------------------------------------------------------------------------------------------
// Structure
// ---------------------------------------------------------------------------------------------
export function decoupler(def, g, pb) {
  const { h, r, variant } = def, y0 = -h / 2, y1 = h / 2, ring = variant === 'ring';
  // two machined rings with a split line and pyro bolts between them
  const c = ring ? P.redPaint : P.yellow, m = h * 0.08;
  pb.rev([[r - 0.04, y0, P.gun], [r + 0.01, y0], [r + 0.01, y0 + h * 0.16, c], [r + 0.004, y0 + h * 0.2], [r + 0.004, -m, P.dark], [r - 0.012, -m], [r - 0.012, m, c], [r + 0.004, m], [r + 0.004, y1 - h * 0.2, P.gun], [r + 0.01, y1 - h * 0.16], [r + 0.01, y1], [r - 0.04, y1], [r - 0.04, y0]], ring ? 'paint' : 'paint', { crease: 0.3 });
  pb.disc(r - 0.03, y1 - 0.003, true, P.graphite, 'metal', r * 0.72); pb.disc(r - 0.03, y0 + 0.003, false, P.graphite, 'metal', r * 0.72);
  pb.rev([[r * 0.72, y0 + 0.003, P.soot], [r * 0.72, y1 - 0.003]], 'metal', { crease: 0.2 });
  pb.rev([[r * 0.72, y1 - 0.003, P.soot], [r * 0.72, y0 + 0.003]], 'metal', { crease: 0.2 });
  const n = Math.max(6, Math.round(r * (ring ? 20 : 12)));
  pb.around(n, an => {
    pb.rbox(0.03, h * 0.62, Math.min(0.08, r * 0.14), 0.006, P.gun, Mrad(an, r + 0.014, 0), 'metal');
    if (pb.hi) for (const s of [-1, 1]) pb.add(new THREE.CylinderGeometry(0.012, 0.012, 0.016, 6), P.steel, mul(Mrad(an, r + 0.034, s * h * 0.2), M(0, 0, 0, 0, 0, -Math.PI / 2)), 'metal');
  });
  if (!ring) pb.decalBand('hazard', r + 0.004, 0, Math.min(h * 0.34, 0.09), { lift: 0.003 });
  else pb.decalBand('dash', r + 0.004, h * 0.28, Math.min(h * 0.2, 0.03), { lift: 0.008 });
}

export function adapter(def, g, pb) {
  const { h, variant } = def, rT = def.rTop, rB = def.rBottom, y0 = -h / 2, y1 = h / 2;
  if (variant === 'flat') {
    pb.rev([[rB - 0.04, y0, P.gun], [rB + 0.008, y0], [rB + 0.008, y0 + h * 0.4], [rT + 0.03, y1 - h * 0.25, P.shade], [rT + 0.008, y1 - h * 0.25, P.gun], [rT + 0.008, y1], [rT - 0.04, y1]], 'metal', { crease: 0.3 });
    endCap(pb, rB - 0.03, y0 + 0.003, -1); endCap(pb, rT - 0.03, y1 - 0.003, 1);
    const n = Math.round(rB * 14); pb.around(n, an => pb.poly([[rT, y1 - h * 0.25], [rB - 0.02, y0 + h * 0.4], [rB - 0.02, y0 + h * 0.4 + 0.012], [rT, y1 - h * 0.02]], 0.03, 0.004, P.iron, new THREE.Matrix4().makeRotationY(-an), 'metal'));
    pb.studs(rB + 0.008, y0 + h * 0.2, Math.round(rB * 26), 0.016); return;
  }
  const ft = flange(pb, rT, y1, 1), fb = flange(pb, rB, y0, -1), a = y0 + fb, b = y1 - ft, slope = (rT - rB) / (b - a);
  const rAt = y => rB + slope * (y - a), sc = scheme(def);
  pb.rev([[rB, a, sc.body], [rAt(a + (b - a) * 0.72), a + (b - a) * 0.72, sc.band], [rAt(a + (b - a) * 0.84), a + (b - a) * 0.84, sc.body], [rT, b]], 'hull');
  if (pb.med) { const n = Math.round(rB * 12); pb.around(n, an => pb.poly([[rB + 0.0, a], [rB + 0.022, a], [rT + 0.022, b], [rT, b]], 0.03, 0.003, sc.body === P.foam ? 0xb5642a : P.shade, new THREE.Matrix4().makeRotationY(-an), 'paint')); }
  pb.decal(SIZE_DECAL(rB), rAt(a + (b - a) * 0.3), a + (b - a) * 0.3, 0.55, clamp(rB * 0.5, 0.18, 0.7), { slope });
  pb.decal('starmark', rAt(a + (b - a) * 0.36), a + (b - a) * 0.36, 0.55 + Math.PI, clamp(rB * 0.34, 0.12, 0.5), { slope });
}

// One stack splitting into several engine mounts.
export function multicoupler(def, g, pb) {
  const { h, multi } = def, rT = def.rTop, y0 = -h / 2, y1 = h / 2, n = multi.count, R = multi.radius, rm = Math.min(0.625, R * 0.98);
  flange(pb, rT, y1, 1);
  const top = y1 - 0.06, plate = y0 + h * 0.32;
  // central manifold body, then a leg down to each mount
  pb.rev([[rT, top, P.hull], [rT, top - h * 0.12], [rT * 0.7, plate + 0.05, P.shade], [rT * 0.45, plate]], 'hull');
  pb.around(n, an => {
    const cx = Math.cos(an) * R, cz = Math.sin(an) * R, mm = M(cx, 0, cz);
    pb.rev([[rm - 0.03, y0, P.gun], [rm + 0.012, y0], [rm + 0.012, y0 + 0.06, P.hull], [rm, y0 + 0.07], [rm, plate - 0.02], [rm * 0.5, plate + h * 0.2, P.shade], [rT * 0.3, top - h * 0.2]], 'hull', { m: mm, seg: pb.seg(rm) });
    pb.add(new THREE.CircleGeometry(rm - 0.02, pb.seg(rm)), P.graphite, M(cx, y0 + 0.003, cz, Math.PI / 2), 'metal');
    if (pb.hi) for (let i = 0; i < 12; i++) { const b2 = i * TAU / 12; pb.add(new THREE.CylinderGeometry(0.014, 0.014, 0.016, 6), P.steel, mul(mm, Mrad(b2, rm + 0.012, y0 + 0.03), M(0, 0, 0, 0, 0, -Math.PI / 2)), 'metal'); }
    // feed line from the manifold to the mount
    pb.tube([[Math.cos(an) * rT * 0.8, top - 0.05, Math.sin(an) * rT * 0.8], [Math.cos(an) * (R + rm * 0.2), plate + h * 0.3, Math.sin(an) * (R + rm * 0.2)], [Math.cos(an) * (R + rm * 0.75), plate - 0.02, Math.sin(an) * (R + rm * 0.75)], [Math.cos(an) * (R + rm * 0.8), y0 + 0.1, Math.sin(an) * (R + rm * 0.8)]], 0.03, P.copper, 'metal');
  }, n === 2 ? 0 : Math.PI / n);
  // tie plate
  pb.around(n, an => { const a2 = an + TAU / n, x0 = Math.cos(an) * R, z0 = Math.sin(an) * R, x1 = Math.cos(a2) * R, z1 = Math.sin(a2) * R; pb.rod([x0, y0 + 0.18, z0], [x1, y0 + 0.18, z1], 0.03, P.iron, 'metal'); if (n > 2) pb.rod([x0, plate - 0.05, z0], [x1, plate - 0.05, z1], 0.022, P.iron, 'metal'); }, n === 2 ? 0 : Math.PI / n);
  pb.decalBand('hazard', rT, top - h * 0.06, Math.min(0.07, h * 0.08));
}

// Lattice beams and trusses.
function latticeBox(pb, w, d, y0, y1, bays, rr, color) {
  const xs = [-w / 2, w / 2], zs = [-d / 2, d / 2];
  for (const x of xs) for (const z of zs) pb.rod([x, y0, z], [x, y1, z], rr, color, 'metal', 6);
  for (let i = 0; i <= bays; i++) { const y = y0 + (y1 - y0) * i / bays; for (const x of xs) pb.rod([x, y, -d / 2], [x, y, d / 2], rr * 0.7, color, 'metal', 5); for (const z of zs) pb.rod([-w / 2, y, z], [w / 2, y, z], rr * 0.7, color, 'metal', 5); }
  for (let i = 0; i < bays; i++) { const ya = y0 + (y1 - y0) * i / bays, yb = y0 + (y1 - y0) * (i + 1) / bays, f = i % 2 ? 1 : -1; for (const x of xs) pb.rod([x, ya, -f * d / 2], [x, yb, f * d / 2], rr * 0.6, color, 'metal', 5); for (const z of zs) pb.rod([-f * w / 2, ya, z], [f * w / 2, yb, z], rr * 0.6, color, 'metal', 5); }
}
export function girder(def, g, pb) {
  const { h, variant } = def;
  if (variant === 'radial') { // outrigger beam along +X
    const { rw, t } = def, sp = new PB(pb.q);
    latticeBox(sp, t * 0.8, t * 0.8, -rw / 2 + 0.03, rw / 2 - 0.03, Math.max(2, Math.round(rw / t / 1.2)), t * 0.07, P.steel);
    for (const k of Object.keys(sp.b)) for (const it of sp.b[k]) pb.add(it.geo, it.color, mul(M(0, 0, 0, 0, 0, -Math.PI / 2), it.m || new THREE.Matrix4()), k);
    pb.rbox(0.03, t, t, 0.006, P.gun, M(-rw / 2 + 0.015, 0, 0), 'metal'); pb.rbox(0.03, t, t, 0.006, P.gun, M(rw / 2 - 0.015, 0, 0), 'metal');
    return;
  }
  const r = def.r, y0 = -h / 2, y1 = h / 2;
  if (variant === 'truss') { // round open truss with ring frames
    const n = 6, rr = r - 0.03;
    for (const y of [y0, y1]) { pb.ring(r - 0.07, r, y === y0 ? y0 : y1 - 0.05, y === y0 ? y0 + 0.05 : y1, P.gun, 'metal'); }
    pb.ring(r - 0.05, r - 0.01, -0.02, 0.02, P.iron, 'metal');
    pb.studs(r, y0 + 0.025, 16, 0.016); pb.studs(r, y1 - 0.025, 16, 0.016);
    pb.around(n, (an, i) => {
      const a2 = an + TAU / n, p = (a, y) => [Math.cos(a) * rr, y, Math.sin(a) * rr];
      pb.rod(p(an, y0 + 0.04), p(an, y1 - 0.04), 0.03, P.steel, 'metal', 8);
      pb.rod(p(an, y0 + 0.05), p(a2, -0.0), 0.018, P.steel, 'metal', 6); pb.rod(p(a2, 0), p(an, y1 - 0.05), 0.018, P.steel, 'metal', 6);
      if (i % 2 === 0) { pb.tube([p(an + 0.25, y0 + 0.05), p(an + 0.3, 0), p(an + 0.25, y1 - 0.05)].map(q => q.map((v, k) => (k === 1 ? v : v * 0.82))), 0.02, P.copper, 'metal'); }
    });
    // a foil-wrapped equipment drum in the middle
    pb.rev([[0.001, -h * 0.26, P.gold], [r * 0.4, -h * 0.26], [r * 0.4, h * 0.26], [0.001, h * 0.26]], 'foil', { crease: 0.4 });
    return;
  }
  const w = r * 1.5;
  for (const y of [y0 + 0.02, y1 - 0.02]) pb.rbox(w + 0.06, 0.04, w + 0.06, 0.008, P.gun, M(0, y, 0), 'metal');
  latticeBox(pb, w, w, y0 + 0.04, y1 - 0.04, Math.max(2, Math.round(h / w)), 0.022, P.steel);
  if (pb.hi) for (const x of [-1, 1]) for (const z of [-1, 1]) for (const y of [y0 + 0.045, y1 - 0.045]) pb.add(new THREE.CylinderGeometry(0.016, 0.016, 0.012, 6), P.steel, M(x * w / 2, y, z * w / 2), 'metal');
}

// Tall clamshell shroud.
export function fairing(def, g, pb) {
  const { h, r } = def, y0 = -h / 2, y1 = h / 2, sc = scheme(def), base = Math.min(0.12, h * 0.05), cyl = h * 0.34;
  const n = 18, prof = [[r - 0.03, y0, P.gun], [r + 0.008, y0], [r + 0.008, y0 + base, P.hull], [r, y0 + base + 0.01], [r, y0 + cyl * 0.5, P.teal], [r, y0 + cyl * 0.62, P.hull], [r, y0 + cyl]];
  for (let i = 1; i <= n; i++) { const t = i / n, a = t * Math.PI / 2; prof.push([Math.max(r * Math.pow(Math.cos(a), 0.62), 0.001), y0 + cyl + (h - cyl - 0.02) * Math.sin(a) ** 1.0, t > 0.86 ? P.graphite : undefined]); }
  pb.rev(prof, 'hull', { crease: 0.6 });
  endCap(pb, r - 0.03, y0 + 0.003, -1);
  pb.studs(r + 0.008, y0 + base / 2, Math.round(r * 28), 0.016);
  // split seams with latches
  for (const an of [0, Math.PI]) {
    pb.patch(r, r, y0 + base, y0 + cyl, an + Math.PI / 2, 0.035, 0.008, P.gun, 'paint');
    if (pb.med) for (let i = 0; i < 4; i++) pb.rbox(0.02, 0.08, 0.1, 0.006, P.amber, Mrad(an + Math.PI / 2, r + 0.012, y0 + base + (cyl - base) * (i + 0.5) / 4), 'paint');
  }
  pb.decal('wordmark', r, y0 + cyl * 0.8, 0.5, clamp(r * 1.3, 0.5, 2.6)); pb.decal('roundel', r, y0 + cyl * 0.28, 0.5, clamp(r * 0.5, 0.25, 1));
  pb.decal('flag', r, y0 + cyl * 0.8, 0.5 + Math.PI, clamp(r * 0.6, 0.3, 1.1));
  void sc;
}

// ---------------------------------------------------------------------------------------------
// Aero noses, intakes, heat shields
// ---------------------------------------------------------------------------------------------
export function nose(def, g, pb) {
  const { h, r, variant } = def, y0 = -h / 2, y1 = h / 2, sc = scheme(def), base = Math.min(0.06, h * 0.1);
  const prof = [[r - 0.03, y0, P.gun], [r + 0.006, y0], [r + 0.006, y0 + base, sc.body === P.foam ? P.hull : sc.body]];
  const n = pb.hi ? 16 : 9;
  if (variant === 'dome') { for (let i = 0; i <= n; i++) { const a = i / n * Math.PI / 2; prof.push([Math.max(r * Math.cos(a), 0.001), y0 + base + (h - base) * Math.sin(a), i > n * 0.55 ? P.graphite : undefined]); } }
  else for (let i = 0; i <= n; i++) { const t = i / n; prof.push([Math.max(r * (1 - Math.pow(t, 1.7)), 0.001) * (1 - 0.0 * t), y0 + base + (h - base) * t, t > 0.8 ? sc.band : t > 0.74 ? P.gun : undefined]); }
  if (variant === 'slant') {
    // lean the cone toward +X so a spent booster peels away
    const geo = new THREE.BufferGeometry().copy(revolveFor(pb, prof)), p = geo.attributes.position;
    for (let i = 0; i < p.count; i++) { const t = clamp((p.getY(i) - y0 - base) / (h - base), 0, 1); p.setX(i, p.getX(i) - r * 0.82 * t * t); }
    pb.add(geo, null, null, 'hull');
  } else pb.rev(prof, 'hull', { crease: 0.7 });
  endCap(pb, r - 0.03, y0 + 0.003, -1);
  pb.studs(r + 0.006, y0 + base / 2, Math.max(8, Math.round(r * 26)), Math.min(0.016, base * 0.3));
  if (variant !== 'dome' && variant !== 'slant') { pb.decal('starmark', r * (1 - Math.pow(0.28, 1.7)), y0 + base + (h - base) * 0.28, 0.5, clamp(r * 0.42, 0.1, 0.6), { slope: -r * 1.7 * Math.pow(0.28, 0.7) / (h - base) }); if (pb.med) pb.rod([0, y1 - 0.01, 0], [0, y1 + Math.min(0.2, r * 0.3), 0], Math.max(0.006, r * 0.012), P.steel, 'chrome', 5); }
}
function revolveFor(pb, prof) { const tmp = new PB(pb.q); tmp.rev(prof, 'hull', { crease: 0.7 }); return mergeLocal(tmp.b.hull); }
function mergeLocal(items) { // single-item bucket → its geometry (keeps colour attribute)
  return items[0].geo;
}

export function intake(def, g, pb) {
  const { h, variant } = def;
  if (variant === 'scoop') return intakeScoop(def, g, pb);
  const r = def.r, rT = def.rTop, y0 = -h / 2, y1 = h / 2;
  if (variant === 'cone') {
    const lipY = y0 + h * 0.34;
    pb.rev([[r - 0.03, y0, P.gun], [r + 0.004, y0], [r + 0.004, y0 + 0.04, P.hull], [r, y0 + 0.05], [r * 0.97, lipY - 0.02, P.silver], [r * 0.93, lipY], [r * 0.86, lipY - 0.03, P.soot], [r * 0.7, y0 + 0.06], [r * 0.4, y0 + 0.02]], 'hull', { crease: 0.6 });
    const n = 12, sp = [[r * 0.5, y0 + 0.04, P.graphite]]; for (let i = 0; i <= n; i++) { const t = i / n; sp.push([Math.max(r * 0.62 * (1 - Math.pow(t, 1.25)), 0.001), y0 + h * 0.12 + (h * 0.88) * t, t > 0.7 ? P.redPaint : P.shade]); }
    pb.rev(sp, 'hull', { crease: 0.6 });
    pb.around(4, an => pb.box(r * 0.3, h * 0.2, 0.02, P.gun, Mrad(an, r * 0.75, y0 + h * 0.16), 'metal'), 0.4);
    endCap(pb, r - 0.03, y0 + 0.003, -1); return;
  }
  // ring intake: rounded lip, dark duct, spinner and fan blades
  pb.rev([[r - 0.03, y0, P.gun], [r + 0.004, y0], [r + 0.004, y0 + 0.03, P.hull], [r, y0 + 0.04], [rT * 1.06, y1 - h * 0.2, P.silver], [rT * 1.0, y1 - h * 0.04], [rT * 0.93, y1], [rT * 0.86, y1 - h * 0.05, P.soot], [rT * 0.84, y0 + h * 0.2], [rT * 0.84, y0 + 0.01]], 'hull', { crease: 0.7 });
  pb.disc(rT * 0.84, y0 + h * 0.18, true, P.soot, 'metal'); endCap(pb, r - 0.03, y0 + 0.003, -1);
  const nb = pb.hi ? 18 : 10, fy = y0 + h * 0.32;
  pb.around(nb, an => pb.box(rT * 0.56, 0.012, rT * 0.2, P.iron, mul(Mrad(an, rT * 0.52, fy), M(0, 0, 0, 0.6, 0, 0)), 'metal'));
  const sp = []; for (let i = 0; i <= 8; i++) { const t = i / 8; sp.push([Math.max(rT * 0.27 * Math.cos(t * Math.PI / 2), 0.001), fy - 0.02 + h * 0.5 * Math.sin(t * Math.PI / 2), i === 0 ? P.silver : undefined]); }
  pb.rev(sp, 'chrome', { crease: 0.8 });
  if (pb.med) pb.decalBand('dash', r, y0 + 0.07, 0.022);
}
function intakeScoop(def, g, pb) {
  const { h, rw, t } = def, x0 = -rw / 2;
  // side-view outline (x outward, y up): mouth at the top
  const out = [[x0, -h / 2], [x0 + rw * 0.35, -h / 2 + h * 0.12], [x0 + rw, h * 0.1], [x0 + rw, h / 2], [x0, h / 2]];
  pb.poly(out, t, 0.02, P.hull, null, 'hull');
  pb.rbox(rw * 0.82, 0.03, t * 0.82, 0.006, P.soot, M(x0 + rw * 0.5, h / 2 - 0.012, 0), 'metal');
  if (pb.med) for (let i = 0; i < 3; i++) pb.box(rw * 0.8, 0.02, 0.012, P.silver, M(x0 + rw * 0.5, h / 2 + 0.002, (i - 1) * t * 0.24), 'metal');
  pb.rbox(rw * 0.1, 0.03, t * 1.02, 0.004, P.silver, M(x0 + rw - 0.01, h / 2 - 0.016, 0), 'chrome');
}

export function heatshield(def, g, pb) {
  const { h, r } = def, y0 = -h / 2, y1 = h / 2, n = pb.hi ? 12 : 7;
  // blunt ablative dish underneath, structural ring and honeycomb deck on top
  const dish = []; for (let i = 0; i <= n; i++) { const t = i / n; dish.push([Math.max(r * t, 0.001), y0 + h * 0.5 * t * t]); }
  pb.rev(dish, 'tile', { uRep: Math.max(2, Math.round(TAU * r * 0.7)), vTile: 1, color: 0xffffff, crease: 0.9 });
  // re-entry glow: a skin just under the ablator that wraps the shoulder (see the 'heat' material; hidden when cold)
  if (pb.med) {
    const hot = dish.map(p => [p[0], p[1] - 0.006]); hot.push([r + 0.008, y0 + h * 0.5 + 0.004], [r + 0.008, y0 + h * 0.62]);
    pb.rev(hot, 'heat', { vFit: true, uRep: 1, crease: 2, seg: pb.seg(r) });
  }
  pb.rev([[r, y0 + h * 0.5, P.char], [r, y1 - h * 0.18, P.gun], [r * 0.97, y1], [r * 0.9, y1]], 'metal', { crease: 0.4 });
  pb.disc(r * 0.9, y1 - 0.002, true, P.graphite, 'metal');
  if (pb.med) { pb.hoop(r * 0.55, Math.min(0.02, h * 0.1), y1, P.iron); pb.around(8, an => pb.box(r * 0.5, 0.012, 0.03, P.iron, Mrad(an, r * 0.7, y1 + 0.004), 'metal')); }
}

// ---------------------------------------------------------------------------------------------
// Utility rings
// ---------------------------------------------------------------------------------------------
export function battery(def, g, pb) {
  const { r } = def, [a, b] = ends(pb, def, { color: P.iron, h: Math.min(def.h * 0.2, 0.05) }), L = b - a, n = Math.max(8, Math.round(r * 16));
  pb.rev([[r - 0.02, a, P.graphite], [r - 0.02, b]], 'metal');
  // cell modules with terminals and a charge lamp each
  pb.around(n, (an, i) => {
    const w = TAU * r / n * 0.82;
    pb.rbox(0.035, L * 0.86, w, 0.008, i % 4 === 0 ? P.yellow : P.slate, Mrad(an, r - 0.006, (a + b) / 2), 'paint');
    if (pb.med) { pb.box(0.012, L * 0.12, w * 0.5, P.copper, Mrad(an, r + 0.014, (a + b) / 2 + L * 0.28), 'metal'); pb.sphere(Math.min(0.012, L * 0.1), P.green, Mrad(an, r + 0.014, (a + b) / 2 - L * 0.22), 'lamp', 6, 4); }
  });
  pb.decal('bolt', r + 0.012, (a + b) / 2, 0, Math.min(L * 0.6, 0.14), { lift: 0.003 });
}

export function gyro(def, g, pb) {
  const { r } = def, [a, b] = ends(pb, def, { color: P.iron, h: Math.min(def.h * 0.18, 0.06) }), L = b - a;
  pb.rev([[r - 0.006, a, P.shade], [r, a + L * 0.12], [r, a + L * 0.3, P.bluePaint], [r, a + L * 0.7, P.shade], [r, b - L * 0.12], [r - 0.006, b]], 'hull');
  // three flywheel housings behind round covers
  pb.around(3, an => {
    const rr = Math.min(L * 0.36, r * 0.5);
    pb.add(new THREE.CylinderGeometry(rr, rr * 1.06, 0.04, pb.seg(rr)), P.gun, mul(Mrad(an, r + 0.012, (a + b) / 2), M(0, 0, 0, 0, 0, -Math.PI / 2)), 'metal');
    pb.add(new THREE.CylinderGeometry(rr * 0.6, rr * 0.6, 0.05, pb.seg(rr)), P.brass, mul(Mrad(an, r + 0.018, (a + b) / 2), M(0, 0, 0, 0, 0, -Math.PI / 2)), 'metal');
    if (pb.hi) for (let i = 0; i < 6; i++) { const q = i * TAU / 6; pb.add(new THREE.CylinderGeometry(rr * 0.07, rr * 0.07, 0.012, 6), P.steel, mul(Mrad(an, r + 0.034, (a + b) / 2), M(0, Math.cos(q) * rr * 0.8, Math.sin(q) * rr * 0.8, 0, 0, -Math.PI / 2)), 'metal'); }
  }, 0.5);
  pb.decal('arrowUp', r, (a + b) / 2, 0.5 + Math.PI / 3 * 1, Math.min(L * 0.36, 0.14));
}

export function dock(def, g, pb) {
  const { h, r } = def, y0 = -h / 2, y1 = h / 2;
  // base collar, guide petals, capture ring with latches, a hatch with a target
  pb.rev([[r - 0.04, y0, P.gun], [r + 0.008, y0], [r + 0.008, y0 + h * 0.2, P.hull], [r, y0 + h * 0.24], [r * 0.96, y0 + h * 0.62, P.gun], [r * 0.9, y0 + h * 0.66], [r * 0.9, y1 - h * 0.06, P.amber], [r * 0.86, y1], [r * 0.7, y1], [r * 0.7, y0 + h * 0.5, P.soot]], 'paint', { crease: 0.3 });
  pb.disc(r * 0.7, y0 + h * 0.52, true, P.shade, 'paint'); endCap(pb, r - 0.04, y0 + 0.003, -1);
  pb.studs(r + 0.008, y0 + h * 0.1, Math.round(r * 28), Math.min(0.016, h * 0.06));
  pb.around(3, an => {
    pb.poly([[r * 0.7, y1 - 0.004], [r * 0.86, y1 - 0.004], [r * 0.8, y1 + h * 0.3], [r * 0.72, y1 + h * 0.3]], r * 0.34, 0.006, P.silver, new THREE.Matrix4().makeRotationY(-an), 'metal');
  }, 0.3);
  pb.around(6, an => { pb.rbox(r * 0.07, h * 0.12, r * 0.16, 0.004, P.gun, Mrad(an, r * 0.78, y1 - h * 0.02), 'metal'); if (pb.med) pb.sphere(Math.min(0.016, r * 0.03), P.amber, Mrad(an, r * 0.78, y1 + h * 0.05), 'lamp', 6, 4); }, 0.3 + Math.PI / 3);
  // hatch
  pb.rev([[r * 0.5, y0 + h * 0.52, P.gun], [r * 0.5, y0 + h * 0.6], [r * 0.44, y0 + h * 0.6]], 'metal', { crease: 0.3 });
  pb.disc(r * 0.44, y0 + h * 0.6, true, P.hull, 'paint');
  pb.decalFlat('target', M(0, y0 + h * 0.6 + 0.004, 0, -Math.PI / 2), r * 0.6);
  if (pb.med) pb.hoop(r * 0.6, Math.min(0.012, r * 0.02), y0 + h * 0.53, P.teal, 'paint');
}

// Stack parachute pack (the canopy itself is added by partmesh).
export function chute(def, g, pb) {
  const { h, r, variant } = def, y0 = -h / 2, y1 = h / 2, drogue = variant === 'drogue', big = r > 0.5, col = drogue ? P.redPaint : P.hull;
  pb.rev([[r - 0.02, y0, P.gun], [r + 0.004, y0], [r + 0.004, y0 + h * 0.2, col], [r * 0.98, y0 + h * 0.24], [r * 0.8, y0 + h * 0.78, drogue ? P.hull : P.amber], [r * 0.72, y0 + h * 0.86, col], [r * 0.45, y1], [0.001, y1]], 'hull', { crease: 0.55 });
  endCap(pb, r - 0.02, y0 + 0.003, -1);
  const n = big ? 3 : 1;
  // cover straps and pull ring
  pb.around(big ? 6 : 4, an => pb.poly([[r * 0.995, y0 + h * 0.22], [r * 0.8, y0 + h * 0.8], [r * 0.46, y1 + 0.004], [r * 0.3, y1 + 0.004], [r * 0.3, y1 + 0.014], [r * 0.47, y1 + 0.014], [r * 0.81, y0 + h * 0.81 + 0.01], [r * 1.005, y0 + h * 0.23]], r * 0.12, 0, P.gun, new THREE.Matrix4().makeRotationY(-an), 'paint'), 0.4);
  if (big) pb.around(n, an => pb.cyl(r * 0.2, r * 0.22, 0.03, y1 + 0.012, P.shade, 'paint', 14, false, M(Math.cos(an) * r * 0.2, 0, Math.sin(an) * r * 0.2)));
  else pb.cyl(r * 0.2, r * 0.24, 0.03, y1 + 0.012, P.shade, 'paint', 14);
  if (pb.med) pb.torus(r * 0.1, 0.008, P.red, M(0, y1 + 0.04, 0), 'paint', 12, 5);
  pb.studs(r + 0.004, y0 + h * 0.1, Math.max(8, Math.round(r * 26)), 0.012);
}
