// Starwright part models: the XXL stainless stack (the Shearwater ship and its booster). Bare brushed steel with a
// weld seam every ring of sheet, no paint; the ship's parts carry black hexagonal tiles over the belly half.
//
// Which side is the belly: plane parts keep their roof on +Z (shapes_stack DORSAL), so the tiles face −Z. In the
// builder's angles (geo.js: direction(a) = (cos a, 0, sin a)) the steel half runs a = 0 → π and the tiled half
// π → 2π, which puts the two edges of the tiles on ±X: where the stock design hangs its flaps.
import * as THREE from '../../lib/three.module.min.js';
import { PB, P, TAU, M, Mrad, mul, sub, flange, endCap, porthole, windowPane } from './geo.js';

const clamp = (x, a, b) => Math.min(Math.max(x, a), b);
const lerp = (a, b, t) => a + (b - a) * t;
export const STEEL = 0xd4d7da, STEEL_DK = 0xa3a8ae, WELD = 0x9c9890;
const TILE = 0xffffff;              // the tile texture carries its own black
const LEE = Math.PI / 2;            // leeward (roof) side, +Z
const RING_H = 1.875;               // height of one ring of sheet
const TILE_LIFT = 0.016, END_LIFT = 0.03;   // tiles stand proud of the sheet, and clear the bolt heads on the end rings
const RX = M(0, 0, 0, 0, 0, -Math.PI / 2);          // turn a +Y-axis primitive to point along +X

/** Heights of the weld seams between y0 and y1 (rings of equal height, close to RING_H). */
function seams(y0, y1) { const n = Math.max(1, Math.round((y1 - y0) / RING_H)), out = []; for (let i = 1; i < n; i++) out.push(y0 + (y1 - y0) * i / n); return out; }

/** A stainless wall of revolution with weld seams; rAt(y) gives the radius. With `tiled`, steel covers only the
 *  leeward half and tiles the belly half, standing a little proud of the steel. `ys` are extra profile stations. */
function steelWall(pb, rAt, y0, y1, { tiled = false, ys = [], weld = true } = {}) {
  const stations = [y0, ...ys, y1].sort((a, b) => a - b), prof = [], plain = [];
  const sm = weld && pb.med ? seams(y0, y1) : [];
  for (let i = 0; i < stations.length; i++) {
    const y = stations[i];
    plain.push([rAt(y) + TILE_LIFT, y, TILE]);
    prof.push([rAt(y), y, STEEL]);
    // seams that fall before the next station: a low bead with a heat-tinted band
    if (i < stations.length - 1) for (const s of sm) if (s > y + 0.03 && s < stations[i + 1] - 0.03) { const r = rAt(s), k = (rAt(s + 0.05) - rAt(s - 0.05)) / 0.1; prof.push([r - k * 0.03, s - 0.03, WELD], [r + 0.005 - k * 0.012, s - 0.012], [r + 0.005 + k * 0.012, s + 0.012], [r + k * 0.03, s + 0.03, STEEL]); }
  }
  let rMax = 0; for (const y of stations) rMax = Math.max(rMax, rAt(y));
  const seg = pb.seg(rMax);
  if (!tiled) { pb.rev(prof, 'steel', { crease: 0.6, seg }); return; }
  pb.rev(prof, 'steel', { crease: 0.6, seg: seg / 2, a0: 0, a1: Math.PI });
  pb.rev(plain, 'hextile', { crease: 0.6, seg: seg / 2, a0: Math.PI, a1: TAU, uRep: Math.max(2, Math.round(TAU * rMax)), vTile: 1 });
}
/** Vertical welds, one per ring of sheet, staggered from ring to ring (high detail only). */
function sheetWelds(pb, r, y0, y1, { a0 = 0.3, span = TAU } = {}) {
  if (!pb.hi) return;
  const ys = [y0, ...seams(y0, y1), y1];
  for (let i = 0; i < ys.length - 1; i++) { const a = a0 + ((i * 0.38) % 1) * span * 0.8; pb.box(0.008, ys[i + 1] - ys[i] - 0.03, 0.035, WELD, Mrad(a, r + 0.001, (ys[i] + ys[i + 1]) / 2), 'steel'); }
}
/** End rings of a steel barrel: thicker bands of plate with a bolt circle, closed by the usual bulkhead. */
function steelEnds(pb, def, { top = true, bottom = true, cap = true } = {}) {
  const { h } = def, o = { h: 0.11, color: STEEL_DK, lip: 0.014, cap };
  const ft = top ? flange(pb, def.rTop ?? def.r, h / 2, 1, o) : 0, fb = bottom ? flange(pb, def.rBottom ?? def.r, -h / 2, -1, o) : 0;
  return [-h / 2 + fb, h / 2 - ft];
}
/** A flat cover standing off the wall (door, hatch, cable tray): UVs follow the sheet. */
function plate(pb, r, y0, y1, ang, w, th, color = STEEL) { pb.patch(r, r, y0, y1, ang, w, th, color, 'steel'); }

// ---------------------------------------------------------------------------------------------
// Tanks: `tiled` for the ship's (def.tiles)
// ---------------------------------------------------------------------------------------------
export function steelTank(def, g, pb) {
  const { r, h } = def, tiled = !!def.tiles, [a, b] = steelEnds(pb, def), y0 = -h / 2, y1 = h / 2;
  steelWall(pb, () => r, a, b, { tiled });
  if (tiled) {
    // the tiles run over the end rings too, so the belly is unbroken from part to part
    for (const [ya, yb] of [[y0, a], [b, y1]]) pb.rev([[r + END_LIFT, ya, TILE], [r + END_LIFT, yb]], 'hextile', { seg: pb.seg(r) / 2, a0: Math.PI, a1: TAU, uRep: Math.round(TAU * r), vTile: 1 });
    sheetWelds(pb, r, a, b, { a0: 0.5, span: Math.PI - 1 });
    // one cable tray up the roof, a vent and the markings beside it
    if (pb.med) { plate(pb, r, a + 0.1, b - 0.1, LEE, 0.34, 0.07, STEEL_DK); pb.add(new THREE.CylinderGeometry(0.11, 0.13, 0.06, 14), P.gun, mul(Mrad(LEE - 0.5, r + 0.02, b - 1.0), RX), 'metal'); }
    pb.decal('wordmark', r, a + (b - a) * 0.62, LEE + 0.62, 2.4); pb.decal('sizeXXL', r, a + (b - a) * 0.62 - 0.75, LEE + 0.62, 1.3);
    pb.decal('oxidiser', r, b - 2.2, LEE - 0.5, 1.0); pb.decal('arrowUp', r, a + 1.2, LEE + 0.9, 0.4);
    return;
  }
  sheetWelds(pb, r, a, b);
  // booster: two long chines on the roof-side quarters (they clear the vanes and the catch pins) and a cable tray
  for (const an of [LEE - Math.PI / 4, LEE + Math.PI / 4]) {
    const d = 0.26, w = 0.56;
    pb.poly([[-0.04, y0 + 0.02], [d, y0 + 0.02], [d, y1 - 0.02], [-0.04, y1 - 0.02]], w, 0.07, STEEL, Mrad(an, r, 0), 'steel');
    if (pb.med) for (const s of seams(a, b)) pb.box(d + 0.012, 0.05, w + 0.012, STEEL_DK, Mrad(an, r + d / 2, s), 'steel');
  }
  if (pb.med) {
    plate(pb, r, a + 0.1, b - 0.1, LEE, 0.3, 0.06, STEEL_DK);
    pb.add(new THREE.CylinderGeometry(0.12, 0.14, 0.06, 14), P.gun, mul(Mrad(0.5, r + 0.02, b - 1.2), RX), 'metal');
  }
  pb.decal('wordmark', r, a + (b - a) * 0.5, 0.0, 2.6); pb.decal('sizeXXL', r, a + (b - a) * 0.5 - 0.8, 0.0, 1.4);
  pb.decal('oxidiser', r, b - 4.6, 0.0, 1.0); pb.decal('arrowUp', r, a + 1.4, 0.0, 0.45);
}

// ---------------------------------------------------------------------------------------------
// Forward section: an ogive nose with the crew deck's windows high on the roof side
// ---------------------------------------------------------------------------------------------
export function ogivePod(def, g, pb) {
  const { h } = def, rT = def.rTop, rB = def.rBottom, y0 = -h / 2, y1 = h / 2, tip = Math.min(0.14, h * 0.03);
  const [a] = steelEnds(pb, def, { top: false }), b = y1 - tip, L = b - y0;
  // tangent ogive from the base, scaled so it ends at the nose ring instead of a point
  const rho = (rB * rB + L * L * 1.21) / (2 * rB), og = t => Math.sqrt(Math.max(rho * rho - (L * 1.1 * t) ** 2, 0)) - (rho - rB), e1 = og(1);
  const rAt = y => { const t = clamp((y - y0) / L, 0, 1); return rT + (rB - rT) * (og(t) - e1) / (rB - e1); };
  const slope = y => (rAt(y + 0.05) - rAt(y - 0.05)) / 0.1;
  const n = pb.hi ? 22 : pb.med ? 12 : 6, ys = []; for (let i = 1; i < n; i++) ys.push(a + (b - a) * (1 - Math.pow(1 - i / n, 1.25)));
  // a crewless nose (the depot's) never comes home: bare steel all round, and no windows or hatch
  const crewed = (def.crew || 0) > 0;
  steelWall(pb, rAt, a, b, { tiled: crewed, ys });
  if (crewed) pb.rev([[rB + END_LIFT, y0, TILE], [rB + END_LIFT, a]], 'hextile', { seg: pb.seg(rB) / 2, a0: Math.PI, a1: TAU, uRep: Math.round(TAU * rB), vTile: 1 });
  // nose ring and cap
  pb.rev([[rT + 0.004, b - 0.02, STEEL_DK], [rT + 0.004, b], [rT * 0.8, y1 - tip * 0.25], [0.002, y1]], 'steel', { crease: 0.9, seg: pb.seg(rT) });
  const dy = y0 + h * 0.3;
  if (!crewed) { pb.decal('flag', rAt(dy), dy, LEE - 0.72, 0.9, { slope: slope(dy) }); endCap(pb, rB - 0.02, y0 + 0.004, -1); return; }
  // flight deck windows in a row, a porthole deck below them and the side hatch
  const wy = y0 + h * 0.66, wh = h * 0.05;
  for (let i = 0; i < 4; i++) windowPane(pb, rAt(wy - wh / 2), rAt(wy + wh / 2), wy - wh / 2, wy + wh / 2, LEE + (i - 1.5) * 0.4, clamp(rAt(wy) * 0.3, 0.2, 0.6), { th: 0.02 });
  const py = y0 + h * 0.5; for (let i = 0; i < 3; i++) porthole(pb, rAt(py) + 0.004, py, LEE + (i - 1) * 0.5, 0.13, { slope: slope(py) });
  const hy0 = y0 + h * 0.22, hy1 = hy0 + 1.25, hm = (hy0 + hy1) / 2;
  pb.patch(rAt(hy0), rAt(hy1), hy0, hy1, LEE, 0.92, 0.012, P.gun, 'metal');
  pb.patch(rAt(hy0 + 0.04) + 0.012, rAt(hy1 - 0.04) + 0.012, hy0 + 0.04, hy1 - 0.04, LEE, 0.84, 0.012, STEEL, 'steel');
  porthole(pb, rAt(hm + 0.2) + 0.028, hm + 0.2, LEE, 0.1, { slope: slope(hm) });
  if (pb.med) for (const s of [-1, 1]) pb.box(0.05, 0.16, 0.08, STEEL_DK, Mrad(LEE + 0.19, rAt(hm + s * 0.4) + 0.03, hm + s * 0.4, -Math.atan(slope(hm))), 'steel');
  pb.decal('flag', rAt(dy), dy, LEE - 0.72, 0.9, { slope: slope(dy) }); pb.decal('rescue', rAt(hy1 + 0.25), hy1 + 0.25, LEE, 0.7, { slope: slope(hy1) });
  endCap(pb, rB - 0.02, y0 + 0.004, -1);
}

// ---------------------------------------------------------------------------------------------
// Cargo bay: a barrel with a two-leaf door in the roof
// ---------------------------------------------------------------------------------------------
export function cargobay(def, g, pb) {
  const { r, h } = def, y0 = -h / 2, y1 = h / 2, [a, b] = steelEnds(pb, def);
  steelWall(pb, () => r, a, b, { tiled: true });
  for (const [ya, yb] of [[y0, a], [b, y1]]) pb.rev([[r + END_LIFT, ya, TILE], [r + END_LIFT, yb]], 'hextile', { seg: pb.seg(r) / 2, a0: Math.PI, a1: TAU, uRep: Math.round(TAU * r), vTile: 1 });
  // door: a dark rebate with the two leaves standing in it, hinges down both sides, latches on the split
  const dw = r * 1.5, d0 = a + (b - a) * 0.1, d1 = b - (b - a) * 0.1, leaf = (dw - 0.14) / 2, off = (leaf / 2 + 0.03) / r;
  pb.patch(r, r, d0, d1, LEE, dw, 0.012, P.gun, 'metal');
  for (const s of [-1, 1]) plate(pb, r + 0.012, d0 + 0.05, d1 - 0.05, LEE + s * off, leaf, 0.02);
  if (pb.med) {
    const ha = dw / 2 / r + 0.012;
    for (const s of [-1, 1]) for (let i = 0; i < 4; i++) pb.rbox(0.07, 0.3, 0.16, 0.015, STEEL_DK, Mrad(LEE + s * ha, r + 0.03, lerp(d0 + 0.35, d1 - 0.35, i / 3)), 'steel');
    for (let i = 0; i < 3; i++) pb.rbox(0.05, 0.12, 0.22, 0.01, P.gun, Mrad(LEE, r + 0.045, lerp(d0 + 0.5, d1 - 0.5, i / 2)), 'metal');
  }
  pb.decal('lift', r, d1 + (b - d1) * 0.5, LEE, 0.9, { lift: 0.006 });
}

// ---------------------------------------------------------------------------------------------
// Hot-stage ring: a solid band, a ring of posts with open vents between them, and a blast dome inside that turns
// the upper stage's exhaust out through the vents
// ---------------------------------------------------------------------------------------------
export function hotring(def, g, pb) {
  const { r, h } = def, y0 = -h / 2, y1 = h / 2, band = h * 0.22, rim = h * 0.1, va = y0 + band, vb = y1 - rim;
  const fb = flange(pb, r, y0, -1, { h: 0.1, color: STEEL_DK, lip: 0.014, cap: false });
  pb.rev([[r, y0 + fb, STEEL], [r, va], [r - 0.16, va], [r - 0.16, va - 0.05]], 'steel', { crease: 0.4 });
  // top rim: the ring the stage above stands on
  pb.rev([[r - 0.18, vb, STEEL_DK], [r + 0.012, vb], [r + 0.012, y1], [r - 0.18, y1], [r - 0.18, vb]], 'steel', { crease: 0.3 });
  pb.studs(r + 0.012, (vb + y1) / 2, 72, 0.02, P.steel, 0.04);
  // posts, and a zigzag of braces between them
  const n = pb.med ? 24 : 12, pd = 0.16, pw = 0.2;
  pb.around(n, an => pb.box(pd, vb - va, pw, STEEL_DK, Mrad(an, r - pd / 2, (va + vb) / 2), 'steel'));
  if (pb.med) {
    const rr = r - pd * 0.5, q = (i, y) => { const an = i * TAU / n; return [Math.cos(an) * rr, y, Math.sin(an) * rr]; };
    for (let i = 0; i < n; i++) pb.rod(q(i, i % 2 ? vb : va), q(i + 1, i % 2 ? va : vb), 0.04, STEEL, 'steel', 6);
  }
  // blast dome: scorched plate, darkest where the centre engines play on it
  const m = pb.hi ? 10 : pb.med ? 6 : 3, rd = r - 0.16, top = va + (vb - va) * 0.62, dome = [];
  for (let i = 0; i <= m; i++) { const t = i / m, c = new THREE.Color(0x8d8f92).lerp(new THREE.Color(0x35302c), Math.pow(1 - t, 1.4)); dome.push([Math.max(rd * t, 0.002), va + (top - va) * (1 - t * t), c.getHex()]); }
  pb.rev(dome.reverse(), 'metal', { crease: 1.2 });
  if (pb.med) for (const k of [0.34, 0.68]) pb.hoop(rd * k, 0.03, va + (top - va) * (1 - k * k) + 0.012, P.iron);
  // guidance: an avionics box and a stub aerial on the band
  if (pb.med) { pb.rbox(0.1, band * 0.5, 0.5, 0.02, STEEL_DK, Mrad(LEE, r + 0.04, y0 + band * 0.55), 'steel'); pb.rod([Math.cos(LEE + 0.2) * (r + 0.02), y0 + band * 0.5, Math.sin(LEE + 0.2) * (r + 0.02)], [Math.cos(LEE + 0.2) * (r + 0.22), y0 + band * 0.62, Math.sin(LEE + 0.2) * (r + 0.22)], 0.012, P.gun, 'metal', 5); }
  pb.decal('probe', r, y0 + band * 0.55, LEE - 0.35, 0.9, { lift: 0.006 });
}

// ---------------------------------------------------------------------------------------------
// Catch pin: a stub of solid steel on a doubler plate, webbed above and below
// ---------------------------------------------------------------------------------------------
export function catchpin(def, g, pb) {
  const { h, rw, t } = def, x0 = -rw / 2, x1 = rw / 2, pr = Math.min(h, t) * 0.22, bt = Math.min(0.07, rw * 0.14);
  pb.rbox(bt, h, t, 0.012, STEEL_DK, M(x0 + bt / 2, 0, 0), 'metal');
  const along = (x, len, ra, rb, color, bucket = 'metal') => pb.add(new THREE.CylinderGeometry(rb, ra, len, pb.seg(ra * 2)), color, mul(M(x + len / 2, 0, 0), RX), bucket);
  along(x0 + bt, rw * 0.16, pr * 1.5, pr * 1.15, P.steel);            // boss
  along(x0 + bt, rw - bt - 0.05, pr, pr, P.silver);                   // the pin itself
  along(x1 - 0.07, 0.07, pr * 1.22, pr * 1.22, P.steel);              // head that keeps it on the rail
  pb.add(new THREE.CircleGeometry(pr * 1.22, pb.seg(pr * 2)), P.steel, M(x1, 0, 0, 0, Math.PI / 2, 0), 'metal');
  // webs: the load comes up from below when the stage hangs on its pins
  for (const [s, k] of [[-1, 1], [1, 0.8]]) pb.poly([[x0 + bt, s * pr * 0.6], [x0 + bt + rw * 0.42 * k, s * pr * 0.6], [x0 + bt, s * h * 0.47]], 0.035, 0.006, STEEL_DK, null, 'metal');
  if (pb.hi) for (const [sy, sz] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) pb.cyl(0.018, 0.018, 0.016, 0, P.steel, 'metal', 6, false, mul(M(x0 + bt + 0.008, sy * h * 0.38, sz * t * 0.38), RX));
}

// ---------------------------------------------------------------------------------------------
// Flank Port: a short collar that looks straight out of the hull (+X here), a latch ring on its rim, a dark
// recessed face, and the two propellant couplings (oxygen blue, methane amber) inside it
// ---------------------------------------------------------------------------------------------
export function sideport(def, g, pb) {
  const { h, rw, t } = def, x0 = -rw / 2 - 0.25, x1 = rw / 2, R = Math.min(h, t) * 0.42;
  const along = (x, len, ra, rb, color, bucket = 'metal', open = false) => pb.add(new THREE.CylinderGeometry(rb, ra, len, pb.seg(ra * 2), 1, open), color, mul(M(x + len / 2, 0, 0), RX), bucket);
  pb.rbox(0.3, h * 1.1, t * 1.1, 0.04, STEEL_DK, M(x0 + 0.15, 0, 0), 'steel');     // doubler, let into the hull
  along(x0 + 0.25, x1 - x0 - 0.37, R * 1.08, R, STEEL, 'steel');                    // collar
  along(x1 - 0.12, 0.12, R * 1.16, R * 1.16, P.steel);                              // latch ring
  pb.add(new THREE.RingGeometry(R * 0.86, R * 1.16, pb.seg(R * 2)), P.silver, M(x1 + 0.002, 0, 0, 0, Math.PI / 2, 0), 'metal');
  pb.add(new THREE.CircleGeometry(R * 0.86, pb.seg(R * 2)), 0x23262b, M(x1 - 0.05, 0, 0, 0, Math.PI / 2, 0), 'metal');
  for (const [dy, c] of [[R * 0.36, 0x4f8fd0], [-R * 0.36, 0xd08a3a]]) pb.cyl(R * 0.2, R * 0.2, 0.08, 0, c, 'metal', pb.seg(R * 0.4), false, mul(M(x1 - 0.03, dy, 0), RX));
  if (pb.med) for (let i = 0; i < 8; i++) { const a = i * TAU / 8 + 0.39; pb.cyl(0.035, 0.035, 0.05, 0, P.gun, 'metal', 6, false, mul(M(x1 + 0.01, Math.cos(a) * R * 1.01, Math.sin(a) * R * 1.01), RX)); }
}

/**
 * What joins two docked Flank Ports (drawn by the flight scene, not part of either port's mesh): a ribbed bellows
 * collar over both latch rings, a clamp band at each end and six latch bars closed across the joint.
 * → { object, set(a, b), flow(on, pumping, dt) }. `object` goes in the craft's frame. set(a, b): the two ports'
 * centres there (Vector3); the collar is laid between them and made as long as the gap between their faces, which is
 * measured from those two points (`gap`, metres). flow(on, pumping, dt): `on` while a transfer is set up across the
 * line, `pumping` while propellant is moving: the bellows frosts over, and pulses slowly while it flows.
 */
export function flankLink(def) {
  const R = Math.min(def.h, def.t) * 0.42, lap = 0.2, ribs = 7, pts = [];
  for (let i = 0; i <= ribs * 4; i++) { const u = i / (ribs * 4); pts.push(new THREE.Vector2(R * (1.245 + 0.055 * Math.cos(u * ribs * TAU)), u - 0.5)); }
  const turn = g => g.rotateZ(-Math.PI / 2);                    // +Y of a primitive along +X, the line from port to port
  const rubber = new THREE.MeshStandardMaterial({ color: 0x3b4047, roughness: 0.8, metalness: 0.05, emissive: 0x9fc4ff, emissiveIntensity: 0, side: THREE.DoubleSide });
  const metal = new THREE.MeshStandardMaterial({ color: 0x8b949e, roughness: 0.45, metalness: 0.7 });
  const amber = new THREE.MeshStandardMaterial({ color: 0xe59a2f, roughness: 0.6, metalness: 0.2 });
  const object = new THREE.Group(); object.name = 'flankLink';
  const bellows = new THREE.Mesh(turn(new THREE.LatheGeometry(pts, 28)), rubber);
  const bandGeo = turn(new THREE.CylinderGeometry(R * 1.335, R * 1.335, 0.04, 28, 1, true)), bands = [-1, 1].map(() => new THREE.Mesh(bandGeo, metal));
  bands.forEach(b => { b.material.side = THREE.DoubleSide; });
  const barGeo = new THREE.BoxGeometry(1, 0.05, 0.07), hookGeo = new THREE.BoxGeometry(0.06, 0.09, 0.13), bars = [], hooks = [];
  for (let i = 0; i < 6; i++) {
    const an = (i + 0.5) * TAU / 6, grp = new THREE.Group(); grp.rotation.x = an;
    const bar = new THREE.Mesh(barGeo, metal); bar.position.y = R * 1.36; grp.add(bar); bars.push(bar);
    for (const sgn of [-1, 1]) { const h = new THREE.Mesh(hookGeo, amber); h.position.y = R * 1.36; h.userData.sgn = sgn; grp.add(h); hooks.push(h); }
    object.add(grp);
  }
  object.add(bellows, ...bands);
  const cold = new THREE.Color(0x3b4047), frost = new THREE.Color(0xe8f2fb), X = new THREE.Vector3(1, 0, 0), d = new THREE.Vector3();
  let chill = 0, t = 0;
  const api = {
    object, gap: 0,
    set(a, b) {
      d.copy(b).sub(a);
      const dist = d.length(), gap = api.gap = Math.max(0, dist - def.rw), len = gap + lap * 2;
      object.position.copy(a).addScaledVector(d, 0.5);
      if (dist > 1e-6) object.quaternion.setFromUnitVectors(X, d.multiplyScalar(1 / dist));
      bellows.scale.x = len;
      bands[0].position.x = -len / 2 + 0.03; bands[1].position.x = len / 2 - 0.03;
      for (const bar of bars) bar.scale.x = len - 0.02;
      for (const h of hooks) h.position.x = h.userData.sgn * (len / 2 - 0.05);
    },
    flow(on, pumping, dt) {
      t += dt; chill += ((on ? 1 : 0) - chill) * Math.min(1, dt * 0.8);
      rubber.color.copy(cold).lerp(frost, chill);
      rubber.emissiveIntensity = chill * (pumping ? 0.1 + 0.1 * (0.5 + 0.5 * Math.sin(t * 2.6)) : 0.03);
    },
    dispose() { bellows.geometry.dispose(); bandGeo.dispose(); barGeo.dispose(); hookGeo.dispose(); rubber.dispose(); metal.dispose(); amber.dispose(); },
  };
  return api;
}

// ---------------------------------------------------------------------------------------------
// Flaps: a flat tapered slab hinged along its root. One face is steel, the other tiled, and which is which
// depends on the side of the ship it hangs from, so both hands are built ('sideA': tiles on −Z, 'sideB': on +Z)
// and partmesh shows the one whose tiles face the craft's belly.
// The plate outboard of the hinge line is its own group in each hand ('bladeA' / 'bladeB', origin on the hinge
// line), which partmesh turns about Y by the fold angle. The strip inboard of the hinge (it reaches into the hull),
// the hinge fairing and the lugs stay with the hull.
// ---------------------------------------------------------------------------------------------
function flapOutline(def) {
  const { h, rw, variant } = def, x0 = -rw / 2 - 0.3, x1 = rw / 2, yb = -h / 2, yt = h / 2, fore = variant === 'fore';
  // root runs the full height (and a little into the hull); the leading edge rakes back to a rounded tip
  const tipTop = yt - h * (fore ? 0.46 : 0.3), tipBot = yb + h * (fore ? 0.1 : 0.03), c = Math.min(rw * 0.22, (tipTop - tipBot) * 0.4);
  const lead = [x0 + 0.3 + rw * (fore ? 0.1 : 0.16), yt];
  const pts = [[x0, yb], [x1 - c * 0.5, tipBot], [x1, tipBot + c * 0.5]];
  for (let i = 0; i <= 4; i++) { const an = i / 4 * Math.PI / 2; pts.push([x1 - c + Math.cos(an) * c, tipTop - c + Math.sin(an) * c]); }
  pts.push(lead, [x0, yt]);
  return pts;
}
/** Where a flap's hinge line runs in the part's frame: parallel to Y at this x (z = 0). */
export function flapHingeX(def) { return -def.rw / 2 + def.t * 0.5 * 0.55; }
export function flap(def, g, pb) {
  const { h, rw, t } = def, x0 = -rw / 2, th = Math.min(t * 0.5, 0.16), pts = flapOutline(def), hr = t * 0.5, xh = flapHingeX(def);
  // the outline cut along the hinge line: the root strip (first and last point are its hull-side corners) and the blade,
  // which is given from the hinge line
  const n = pts.length, k = (xh - pts[0][0]) / (pts[1][0] - pts[0][0]), yh = pts[0][1] + (pts[1][1] - pts[0][1]) * k;
  const root = [pts[0], [xh, yh], [xh, pts[n - 1][1]], pts[n - 1]];
  const blade = [[0, yh], ...pts.slice(1, n - 1).map(p => [p[0] - xh, p[1]]), [0, pts[n - 1][1]]];
  for (const [name, s] of [['sideA', 1], ['sideB', -1]]) {
    const grp = sub(g, name), sp = new PB(pb.q), bp = new PB(pb.q), steelT = th * 0.4, tileT = th - steelT;
    // tiles take the belly face and wrap the edges; the steel skin lies on the lee face
    for (const [b, o] of [[sp, root], [bp, blade]]) {
      b.poly(o, tileT, 0.02, TILE, M(0, 0, -s * (th / 2 - tileT / 2)), 'hextile');
      b.poly(o, steelT, 0.015, STEEL, M(0, 0, s * (th / 2 - steelT / 2 + 0.004)), 'steel');
    }
    // hinge fairing along the root, steel above and tiled below
    const hp = [[0.002, -h / 2 + 0.02], [hr * 0.8, -h / 2 + hr * 1.2], [hr, -h / 2 + hr * 2.6], [hr, h / 2 - hr * 3], [hr * 0.7, h / 2 - hr * 1.1], [0.002, h / 2 - 0.02]];
    const mh = M(xh, 0, 0), sg = Math.max(4, sp.seg(hr) / 2);
    sp.rev(hp.map((p, i) => [p[0], p[1], i ? undefined : STEEL]), 'steel', { m: mh, seg: sg, a0: s > 0 ? 0 : Math.PI, a1: s > 0 ? Math.PI : TAU, crease: 0.7 });
    sp.rev(hp.map((p, i) => [p[0], p[1], i ? undefined : TILE]), 'hextile', { m: mh, seg: sg, a0: s > 0 ? Math.PI : 0, a1: s > 0 ? TAU : Math.PI, crease: 0.7, uRep: 1, vTile: 1 });
    if (sp.med) {
      // stiffeners on the steel face (they turn with the blade) and the hinge lugs
      const xr = x0 + hr * 1.5 - xh;
      for (const u of [0.22, 0.5, 0.74]) { const y = lerp(-h / 2, h / 2, u) * 0.8; bp.box(rw * 0.52, 0.05, 0.03, STEEL_DK, M(xr + rw * 0.27, y, s * (th / 2 + 0.012), 0, 0, -0.12), 'steel'); }
      for (const u of [0.14, 0.5, 0.86]) sp.rbox(hr * 1.5, 0.3, hr * 2.25, 0.02, STEEL_DK, M(x0 + hr * 0.7, lerp(-h / 2, h / 2, u) * 0.86, 0), 'steel');
    }
    sp.build(grp);
    bp.build(sub(grp, s > 0 ? 'bladeA' : 'bladeB', xh, 0, 0));
    if (s < 0) grp.visible = false;
  }
}
