// Starwright part models: engines (liquid, vacuum, spike, twin, cluster, thermal, nuclear, ion, jet), solid
// boosters and radial engines. Every bell sits in a group named 'gimbal' so partmesh can swivel it; nozzle
// interiors go in the 'glow' bucket whose emissive ramp follows throttle.
import * as THREE from '../../lib/three.module.min.js';
import { PB, P, TAU, M, Mrad, mul, sub, flange, rib, raceway, revolve } from './geo.js';
import { STEEL, STEEL_DK, WELD } from './shapes_shearwater.js';

const clamp = (x, a, b) => Math.min(Math.max(x, a), b);
const lerp = (a, b, t) => a + (b - a) * t;

/** Where the exhaust leaves: [{ x, y, z, r }] in part coordinates (y = exit plane). A ring cluster (engine.rings)
 *  lists every bell ring by ring (ring 0's first), each with `ring` (its index) and `fixed` (true: it does not swivel). */
export function nozzleExits(def) {
  const e = def.engine, y = -def.h / 2;
  if (!e) return [{ x: 0, y, z: 0, r: (def.r || 0.3) * 0.7 }];
  if (def.shape === 'radialengine') { const r = Math.min(def.rw, def.t) * (def.variant === 'pod' ? 0.36 : 0.34); return [{ x: def.variant === 'pod' ? def.rw * 0.08 : 0, y, z: 0, r }]; }
  const r = def.r, v = def.variant;
  if (e.rings) {
    const out = [];
    e.rings.forEach((rg, k) => {
      // sea-level bells are a tenth of the stage's radius, vacuum bells nearly three times that; each ring is turned
      // so its bells sit in the gaps of the ring inside it
      const rr = r * (rg.vacuum ? 0.285 : 0.103), a0 = Math.PI / 2 + (k ? Math.PI / rg.n : 0), fixed = !(rg.gimbal > 0);
      for (let i = 0; i < rg.n; i++) { const a = a0 + i * TAU / rg.n; out.push({ x: Math.cos(a) * rg.radius, y, z: Math.sin(a) * rg.radius, r: rr, ring: k, fixed }); }
    });
    return out;
  }
  if (def.shape === 'srb') return [{ x: 0, y, z: 0, r: r * 0.62 }];
  if (v === 'twin') return [-1, 1].map(s => ({ x: 0, y, z: s * r * 0.5, r: r * 0.44 }));
  if (v === 'cluster') return [{ x: 0, y, z: 0, r: r * 0.3 }, ...[0, 1, 2, 3].map(i => ({ x: Math.cos(i * Math.PI / 2 + Math.PI / 4) * r * 0.62, y, z: Math.sin(i * Math.PI / 2 + Math.PI / 4) * r * 0.62, r: r * 0.3 }))];
  if (v === 'spike') return [{ x: 0, y, z: 0, r: r * 0.55 }];
  if (v === 'ion') return [{ x: 0, y, z: 0, r: r * 0.5 }];
  if (v === 'jet' || v === 'ramjet') return [{ x: 0, y, z: 0, r: r * 0.6 }];
  if (v === 'nuclear') return [{ x: 0, y, z: 0, r: r * 0.5 }];
  if (e.ispVac > 500) return [{ x: 0, y, z: 0, r: r * 0.62 }];
  return [{ x: 0, y, z: 0, r: r * (e.ispAtm < 150 ? 0.9 : 0.74) }];
}
/** Radius of one plume that stands in for all the nozzles (fx.js sizes its plume with this). */
export function nozzleExitRadius(def) {
  const ex = nozzleExits(def); if (ex.length === 1) return ex[0].r;
  let a = 0; for (const e of ex) a += e.r * e.r; return Math.sqrt(a) * 1.05;
}

// Heat-stained bell colours from throat (0) to exit (1).
const BELL_STOPS = [[0, 0x7a5a48], [0.18, 0x6a6f8a], [0.4, 0x8a8f96], [0.75, 0x6c7178], [1, 0x4e535a]];
function bellColor(t, tint) {
  const c = new THREE.Color(), d = new THREE.Color();
  for (let i = 0; i < BELL_STOPS.length - 1; i++) if (t <= BELL_STOPS[i + 1][0]) { const k = (t - BELL_STOPS[i][0]) / (BELL_STOPS[i + 1][0] - BELL_STOPS[i][0]); c.set(BELL_STOPS[i][1]).lerp(d.set(BELL_STOPS[i + 1][1]), k); break; }
  if (tint !== undefined) c.lerp(d.set(tint), 0.55);
  return c.getHex();
}
const bellR = (rT, rE, s, pow = 1.9) => rT + (rE - rT) * (1 - Math.pow(1 - s, pow)); // s: 0 throat → 1 exit

/** A regeneratively cooled bell with wall thickness, hoops, manifold and a glowing interior. Throat at yT, exit at yE (< yT). */
function addBell(pb, rT, rE, yT, yE, { hoops = 2, tint, pow = 1.9, manifold = true, m = null, seg, rings, tube = 6 } = {}) {
  const n = rings || (pb.hi ? 16 : pb.med ? 10 : 6), th = clamp(rE * 0.03, 0.006, 0.03), sg = seg || pb.seg(rE);
  const outer = [], inner = [];
  for (let i = 0; i <= n; i++) { const s = 1 - i / n; outer.push([bellR(rT, rE, s, pow), lerp(yT, yE, s), bellColor(s, tint)]); }           // exit → throat (upward: faces out)
  outer.unshift([rE - th * 0.2, yE - th * 0.4, P.steel]);
  pb.rev(outer, 'bell', { m, seg: sg, crease: 0.8 });
  for (let i = 0; i <= n; i++) { const s = i / n; inner.push([Math.max(bellR(rT, rE, s, pow) - th, 0.002), lerp(yT, yE, s), 0x8a8078]); }  // throat → exit (downward: faces in)
  inner.push([rE - th * 0.2, yE - th * 0.4]);
  inner.unshift([0.002, yT + rT * 0.6]);
  pb.rev(inner, 'glow', { m, seg: sg, vFit: true, crease: 1.2 });
  if (pb.med) {
    for (let i = 1; i <= hoops; i++) { const s = i / (hoops + 1) * 0.9 + 0.05; pb.torus(bellR(rT, rE, s, pow) + th * 0.3, th * 0.9, P.iron, mul(m || new THREE.Matrix4(), M(0, lerp(yT, yE, s), 0, Math.PI / 2)), 'metal', sg, tube); }
    pb.torus(rE, th * 1.1, P.steel, mul(m || new THREE.Matrix4(), M(0, yE + th * 0.5, 0, Math.PI / 2)), 'metal', sg, tube);
    if (manifold) pb.torus(bellR(rT, rE, 0.12, pow) + th * 2.2, th * 2.0, P.copper, mul(m || new THREE.Matrix4(), M(0, lerp(yT, yE, 0.12), 0, Math.PI / 2)), 'metal', sg, tube + 2);
  }
}
/** Combustion chamber + injector head above a throat at yT; returns the top y. */
function addChamber(pb, rT, yT, len, { m = null, color = 0x8a8f96 } = {}) {
  const rc = rT * 1.9;
  pb.rev([[rT, yT, 0x7a5a48], [rc, yT + len * 0.3, color], [rc, yT + len * 0.78, P.iron], [rc * 1.12, yT + len * 0.8], [rc * 1.12, yT + len * 0.9], [rc * 0.7, yT + len], [0.002, yT + len]], 'metal', { m, crease: 0.5, seg: pb.seg(rc) });
  if (pb.hi) for (let i = 0; i < 10; i++) { const a = i * TAU / 10; pb.add(new THREE.CylinderGeometry(rc * 0.07, rc * 0.07, len * 0.06, 6), P.steel, mul(m || new THREE.Matrix4(), M(Math.cos(a) * rc * 1.02, yT + len * 0.92, Math.sin(a) * rc * 1.02)), 'metal'); }
  return yT + len;
}
/** Turbopump: housing, volute, drive turbine and an exhaust duct, standing at (x, z) between y0 and y1. */
function addPump(pb, x, z, y0, y1, rp, { exhaustTo = null, color = P.iron } = {}) {
  const hgt = y1 - y0, m = M(x, 0, z);
  pb.rev([[0.002, y0, color], [rp * 0.7, y0], [rp, y0 + hgt * 0.12], [rp, y0 + hgt * 0.45, P.steel], [rp * 1.25, y0 + hgt * 0.5], [rp * 1.25, y0 + hgt * 0.62, color], [rp * 0.8, y0 + hgt * 0.68], [rp * 0.8, y0 + hgt * 0.9], [rp * 0.5, y1], [0.002, y1]], 'metal', { m, crease: 0.5, seg: pb.seg(rp) });
  if (pb.med) pb.torus(rp * 1.3, rp * 0.34, P.brass, M(x, y0 + hgt * 0.3, z, Math.PI / 2), 'metal', pb.seg(rp), 7);
  if (pb.hi) for (let i = 0; i < 8; i++) { const a = i * TAU / 8; pb.add(new THREE.CylinderGeometry(rp * 0.07, rp * 0.07, hgt * 0.05, 6), P.steel, M(x + Math.cos(a) * rp * 1.12, y0 + hgt * 0.64, z + Math.sin(a) * rp * 1.12), 'metal'); }
  if (exhaustTo && pb.med) {
    const d = Math.hypot(x, z) || 1, ux = x / d, uz = z / d;
    pb.tube([[x + ux * rp * 0.9, y0 + hgt * 0.2, z + uz * rp * 0.9], [x + ux * rp * 1.9, y0 - hgt * 0.1, z + uz * rp * 1.9], [ux * exhaustTo[0], exhaustTo[1] + (y0 - exhaustTo[1]) * 0.4, uz * exhaustTo[0]], [ux * exhaustTo[0] * 1.02, exhaustTo[1], uz * exhaustTo[0] * 1.02]], rp * 0.36, P.soot, 'metal', { seg: 8 });
  }
}
/** Mount plate with flange at the top of an engine; returns y of its underside. */
function mountPlate(pb, def, { th } = {}) {
  const { h, r } = def, y1 = h / 2, t = th ?? clamp(h * 0.05, 0.03, 0.12);
  flange(pb, r, y1, 1, { h: t, color: P.gun });
  pb.disc(r - 0.02, y1 - t, false, P.iron, 'metal');
  return y1 - t;
}
function thrustFrame(pb, rTop, yTop, rBot, yBot, n, rr, color = P.steel) {
  pb.around(n, (a, i) => {
    const a2 = a + TAU / n;
    pb.rod([Math.cos(a) * rTop, yTop, Math.sin(a) * rTop], [Math.cos(a) * rBot, yBot, Math.sin(a) * rBot], rr, color, 'metal', 6);
    if (pb.med) pb.rod([Math.cos(a) * rTop, yTop, Math.sin(a) * rTop], [Math.cos(a2) * rBot, yBot, Math.sin(a2) * rBot], rr * 0.6, color, 'metal', 5);
  });
  pb.ring(rBot * 0.7, rBot * 1.25, yBot - rr, yBot + rr, P.gun, 'metal');
}
function wiring(pb, pts, r = 0.008, color = P.orange) { if (pb.hi) pb.tube(pts, r, color, 'paint', { seg: 5 }); }

// ---------------------------------------------------------------------------------------------
export function engine(def, g, pb) {
  const v = def.variant, e = def.engine;
  if (e.rings) return ringCluster(def, g, pb);
  if (v === 'ion') return ion(def, g, pb);
  if (v === 'jet' || v === 'ramjet') return jet(def, g, pb);
  if (v === 'spike') return spike(def, g, pb);
  if (v === 'nuclear') return nuclear(def, g, pb, false);
  if (e.ispVac > 500 && e.type === 'liquid') return nuclear(def, g, pb, true);
  if (v === 'twin' || v === 'cluster') return multiBell(def, g, pb);
  return singleBell(def, g, pb);
}

function singleBell(def, g, pb) {
  const { h, r, variant } = def, e = def.engine, y0 = -h / 2, vac = e.ispAtm < 150 || variant === 'vacuum', sustainer = variant === 'sustainer';
  const rE = nozzleExits(def)[0].r, rT = rE * (vac ? 0.17 : 0.26), bellLen = h * (vac ? 0.66 : 0.52);
  const yT = y0 + bellLen, chLen = clamp(h * 0.13, rT * 2.2, h * 0.2), yUnder = mountPlate(pb, def), yPivot = yT + chLen + (yUnder - yT - chLen) * 0.45;
  // --- static powerhead: thrust frame, pumps, propellant lines
  const rF = r * 0.8;
  thrustFrame(pb, rF, yUnder, rT * 2.6, yPivot + 0.01, vac ? 6 : 8, clamp(r * 0.035, 0.012, 0.05));
  const rp = clamp(r * (vac ? 0.13 : 0.17), 0.03, 0.4), px = r * 0.56;
  addPump(pb, px, 0, yT + chLen * 0.2, yUnder - 0.01, rp, { exhaustTo: vac ? null : [bellR(rT, rE, 0.42) + rp * 0.5, lerp(yT, y0, 0.42)] });
  addPump(pb, -px * 0.9, r * 0.2, yT + chLen * 0.55, yUnder - 0.01, rp * 0.75, { color: P.steel });
  if (pb.med) {
    pb.tube([[px, yUnder - (yUnder - yT) * 0.3, rp * 1.1], [px * 0.5, yPivot + rp, r * 0.34], [rT * 2.3, yPivot, rT * 1.4], [rT * 1.6, yT + chLen * 0.92, rT * 0.7]], rp * 0.3, P.copper, 'metal');
    pb.tube([[-px * 0.9, yUnder - (yUnder - yT) * 0.25, r * 0.2 - rp], [-px * 0.5, yPivot + rp * 0.6, -r * 0.3], [-rT * 2.3, yPivot, -rT * 1.2], [-rT * 1.5, yT + chLen * 0.92, -rT * 0.7]], rp * 0.26, P.silver, 'metal');
    pb.sphere(rp * 0.8, P.yellow, M(0, yUnder - rp * 0.9, -r * 0.55), 'paint', 14, 10);
    pb.torus(rp * 0.8, rp * 0.08, P.steel, M(0, yUnder - rp * 0.9, -r * 0.55, Math.PI / 2), 'metal', 16, 5);
    wiring(pb, [[r * 0.2, yUnder - 0.01, -r * 0.6], [r * 0.5, yUnder - rp, -r * 0.5], [px + rp * 0.8, yUnder - (yUnder - yT) * 0.4, -rp * 1.2], [px, yT + chLen * 0.5, -rp * 1.3]]);
    wiring(pb, [[-r * 0.3, yUnder - 0.01, r * 0.62], [-r * 0.45, yPivot + rp * 2, r * 0.55], [-r * 0.2, yPivot, r * 0.3]], 0.006, P.teal);
  }
  // gimbal actuators (static end on the frame)
  if (pb.med && e.gimbal > 0) for (const a of [0.9, 0.9 + Math.PI / 2]) { const c = Math.cos(a), s = Math.sin(a); pb.rod([c * rF * 0.92, yUnder - 0.02, s * rF * 0.92], [c * rT * 3.4, yT + chLen * 0.55, s * rT * 3.4], clamp(r * 0.028, 0.01, 0.04), P.silver, 'chrome', 8); pb.rod([c * rF * 0.92, yUnder - 0.02, s * rF * 0.92], [c * (rF * 0.92 + rT * 3.4) / 2, (yUnder + yT + chLen * 0.55) / 2, s * (rF * 0.92 + rT * 3.4) / 2], clamp(r * 0.045, 0.014, 0.06), P.gun, 'metal', 8); }
  // --- gimballed chamber and bell
  const gim = sub(g, 'gimbal', 0, yPivot, 0), gp = new PB(pb.q), off = M(0, -yPivot, 0);
  addChamber(gp, rT, yT, chLen, { m: off });
  gp.sphere(rT * 1.5, P.gun, M(0, 0, 0), 'metal', 12, 8);
  addBell(gp, rT, rE, yT, y0, { hoops: vac ? 4 : sustainer ? 3 : 2, tint: vac ? 0x3c4048 : undefined, m: off });
  gp.build(gim);
}

function multiBell(def, g, pb) {
  const { h, r, variant } = def, y0 = -h / 2, exits = nozzleExits(def), rE = exits[0].r, rT = rE * 0.27, bellLen = h * 0.5, yT = y0 + bellLen, chLen = h * 0.12;
  const yUnder = mountPlate(pb, def), yPivot = yT + chLen + (yUnder - yT - chLen) * 0.4;
  // thrust plate with a boat-tail skirt and a shared pump deck
  pb.rev([[r, yUnder + 0.0, P.hull], [r, yUnder - h * 0.06, P.graphite], [r * 0.96, yUnder - h * 0.1], [r * 0.9, yUnder - h * 0.1]], 'hull', { crease: 0.4 });
  pb.disc(r * 0.9, yUnder - h * 0.1, false, P.gun, 'metal');
  if (variant === 'cluster') pb.decalBand('hazard', r, yUnder - h * 0.03, h * 0.04);
  const gim = sub(g, 'gimbal', 0, yPivot, 0), gp = new PB(pb.q);
  for (const [i, ex] of exits.entries()) {
    const off = M(ex.x, -yPivot, ex.z), st = M(ex.x, 0, ex.z);
    addChamber(gp, rT, yT, chLen, { m: off });
    // the more bells, the coarser each one: a cluster is seen as a whole, and its bells are a third of the diameter
    const many = exits.length >= 4;
    addBell(gp, rT, rE, yT, y0, { hoops: many ? 1 : 2, m: off, seg: many ? Math.max(12, Math.round(pb.seg(rE) * 0.6 / 2) * 2) : undefined, rings: many && pb.hi ? 9 : undefined, tube: many ? 4 : 6 });
    // per-engine frame and pump
    pb.around(4, a => pb.rod([ex.x + Math.cos(a) * rE * 0.8, yUnder - h * 0.1, ex.z + Math.sin(a) * rE * 0.8], [ex.x + Math.cos(a) * rT * 2.4, yPivot, ex.z + Math.sin(a) * rT * 2.4], clamp(r * 0.022, 0.012, 0.04), P.steel, 'metal', 6), 0.4);
    const d = Math.hypot(ex.x, ex.z), ux = d ? ex.x / d : 1, uz = d ? ex.z / d : 0, rp = rE * 0.2;
    if (d > 0.01 || variant !== 'cluster') addPump(pb, ex.x + (d ? -uz : 0) * rE * 0.75 + (d ? 0 : rE * 0.8), ex.z + (d ? ux : 0) * rE * 0.75, yT + chLen * 0.3, yUnder - h * 0.1, rp, { color: i % 2 ? P.steel : P.iron });
    if (pb.med) gp.tube([[ex.x + rT * 3, yUnder - h * 0.12 - yPivot, ex.z - rT * 2], [ex.x + rT * 2.6, 0.05, ex.z - rT * 1.5], [ex.x + rT * 1.5, yT + chLen * 0.9 - yPivot, ex.z - rT * 0.8]], rT * 0.4, P.copper, 'metal');
    void st;
  }
  gp.build(gim);
}

// ---------------------------------------------------------------------------------------------
// Ring clusters (engine.rings): many small bells on one thrust plate inside a steel skirt. One bell of each ring is
// modelled once and stamped round its ring, so 33 bells are still three or four merged meshes. The rings that swivel
// go in the 'gimbal' group, the fixed ones stay with the skirt, and each ring's nozzle interiors are their own
// 'glow' mesh tagged userData.ring, so a ring that is shut down in the current mode can go dark (partmesh
// setEngineRings).
// ---------------------------------------------------------------------------------------------
function bellKit(q, rT, rE, len, vac) {
  const seg = vac ? (q >= 2 ? 28 : q === 1 ? 18 : 8) : (q >= 2 ? 14 : q === 1 ? 8 : 6), n = q >= 2 ? (vac ? 12 : 5) : q === 1 ? (vac ? 7 : 3) : 1;
  const th = clamp(rE * 0.035, 0.006, 0.02), pow = vac ? 1.75 : 1.9, tint = vac ? 0x3c4048 : undefined, uRep = Math.max(1, Math.round(TAU * rE / 0.9));
  if (q === 0) return { outer: revolve([[rE, 0, 0x8a8f96], [rT * 1.6, len]], { seg, uRep }), inner: null, head: null, seg };
  const outer = [[rE - th * 0.3, -th * 0.2, P.steel], [rE + th * 0.5, 0], [rE + th * 0.5, th * 1.5]], inner = [[0.002, len + rT * 0.5, 0x8a8078]];
  for (let i = 0; i <= n; i++) { const s = 1 - i / n; outer.push([bellR(rT, rE, s, pow), len * (1 - s) + (i ? 0 : th * 1.5), bellColor(s, tint)]); }
  for (let i = 0; i <= n; i++) { const s = i / n; inner.push([Math.max(bellR(rT, rE, s, pow) - th, 0.002), len * (1 - s), 0x8a8078]); }
  inner.push([rE - th * 0.3, -th * 0.2]);
  // chamber, injector and a stub of powerhead up toward the thrust plate
  const rc = rT * 1.9, cl = Math.max(rT * 3.4, 0.2);
  const hp = q >= 2 ? [[rT, len, 0x7a5a48], [rc, len + cl * 0.3, 0x8a8f96], [rc, len + cl * 0.8, P.iron], [rc * 1.25, len + cl * 0.86], [rc * 1.25, len + cl], [rc * 0.6, len + cl * 1.05], [rc * 0.6, len + cl * 1.9]]
    : [[rT, len, 0x7a5a48], [rc, len + cl * 0.3, 0x8a8f96], [rc * 1.1, len + cl, P.iron], [rc * 0.6, len + cl * 1.9]];
  const head = revolve(hp, { seg: vac ? Math.max(6, seg - 8) : 6, crease: 0.5, uRep: 1, vTile: 1 });
  return { outer: revolve(outer, { seg, uRep, vTile: 1, crease: 0.8 }), inner: revolve(inner, { seg, vFit: true, crease: 1.2 }), head, seg, top: len + cl * 1.9, th };
}
function ringCluster(def, g, pb) {
  const { h, r } = def, e = def.engine, y0 = -h / 2, y1 = h / 2, exits = nozzleExits(def), many = exits.length > 12;
  // --- skirt: all the way down round a vacuum cluster, short on a booster so the bells stand out below it
  const ft = flange(pb, r, y1, 1, { h: 0.11, color: STEEL_DK, lip: 0.014, cap: false });
  const lens = e.rings.map((rg, k) => { const rE = exits.find(x => x.ring === k).r; return rg.vacuum ? Math.min(h * 0.64, rE * 2.9) : rE * 3.6; });
  const yPlate = Math.min(y1 - ft - 0.25, y0 + Math.max(...lens) + (many ? 0.5 : 0.42)), ySk = many ? y0 + lens[0] * 0.72 : y0 + 0.03, mid = (y1 - ft + ySk) / 2;
  const wall = [[r - 0.05, ySk, STEEL_DK], [r + 0.01, ySk], [r + 0.01, ySk + 0.09], [r, ySk + 0.1, STEEL]];
  if (pb.med) wall.push([r, mid - 0.03, WELD], [r + 0.005, mid - 0.012], [r + 0.005, mid + 0.012], [r, mid + 0.03, STEEL]);
  wall.push([r, y1 - ft]);
  pb.rev(wall, 'steel', { crease: 0.5 });
  // --- thrust plate: a shallow dished floor the powerheads hang from, ribbed, with a feed manifold per ring
  const m = pb.hi ? 8 : pb.med ? 5 : 2, plate = [];
  for (let i = 0; i <= m; i++) { const t = i / m; plate.push([Math.max((r - 0.03) * t, 0.002), yPlate + 0.22 * (1 - t * t), i === 0 ? P.gun : undefined]); }
  pb.rev(plate, 'metal', { crease: 1.2 });
  if (pb.med) {
    pb.around(many ? 20 : 12, a => pb.box(r * 0.56, 0.1, 0.05, P.iron, Mrad(a, r * 0.7, yPlate + 0.06), 'metal'), 0.1);
    for (const rg of e.rings) if (rg.radius > r * 0.3) pb.torus(rg.radius, many ? 0.05 : 0.07, rg.vacuum ? P.copper : P.steel, M(0, yPlate - 0.08, 0, Math.PI / 2), 'metal', pb.seg(rg.radius), 6);
  }
  pb.decal('sizeXXL', r, y1 - ft - 0.5, 0.5, 1.2); pb.decal('danger', r, y1 - ft - 0.5, 0.5 + Math.PI, 1.2);
  // --- bells
  const gimY = y0 + lens[0] + 0.35, gim = sub(g, 'gimbal', 0, gimY, 0), gp = new PB(pb.q);
  e.rings.forEach((rg, k) => {
    const mine = exits.filter(x => x.ring === k), rE = mine[0].r, len = lens[k], B = bellKit(pb.q, rE * (rg.vacuum ? 0.14 : 0.3), rE, len, !!rg.vacuum);
    const fixed = mine[0].fixed, body = fixed ? pb : gp, parent = fixed ? g : gim, oy = y0 - (fixed ? 0 : gimY), glow = new PB(pb.q);
    for (const ex of mine) {
      const mm = M(ex.x, oy, ex.z);
      body.add(B.outer, null, mm, 'bell');
      if (!pb.med) continue;
      glow.add(B.inner, null, mm, 'glow'); body.add(B.head, null, mm, 'metal');
      // hangers from the plate to the powerhead (they stay with the plate, so only on rings that do not swivel)
      if (fixed && B.top < yPlate - y0) pb.cyl(rE * 0.2, rE * 0.2, yPlate + 0.1 - y0 - B.top, (y0 + B.top + yPlate + 0.1) / 2, P.iron, 'metal', 6, true, M(ex.x, 0, ex.z));
      if (rg.vacuum) for (const sK of [0.3, 0.55, 0.8]) body.torus(bellR(rE * 0.14, rE, sK, 1.75) + B.th * 0.4, B.th * 0.9, P.iron, mul(mm, M(0, len * (1 - sK), 0, Math.PI / 2)), 'metal', B.seg, 4);
    }
    if (pb.med) { const n0 = parent.children.length; glow.build(parent); for (let i = n0; i < parent.children.length; i++) parent.children[i].userData.ring = k; }
  });
  // the swivelling rings hang from one carrier under the plate
  if (pb.med) { const sw = e.rings.filter(rg => rg.gimbal > 0), ro = sw.length ? Math.max(...sw.map(rg => rg.radius)) + exits[0].r * 1.1 : 0; if (ro > 0) pb.rev([[ro, yPlate + 0.05, P.gun], [ro * 0.92, gimY + 0.25], [0.002, gimY + 0.25]], 'metal', { crease: 0.6 }); }
  gp.build(gim);
}

// Aerospike: a ring of small chambers firing down a truncated spike.
function spike(def, g, pb) {
  const { h, r } = def, y0 = -h / 2, yUnder = mountPlate(pb, def), rO = r * 0.92, yRing = y0 + h * 0.55;
  pb.rev([[r * 0.98, yUnder, P.hull], [r * 0.98, yRing + h * 0.1, P.graphite], [rO, yRing], [rO * 0.86, yRing - h * 0.04], [rO * 0.8, yRing]], 'hull', { crease: 0.4 });
  // spike body: outside faces the exhaust, so it lives in the glow bucket (v: 0 at the ring → 1 at the tip)
  const n = 10, sp = []; for (let i = 0; i <= n; i++) { const t = i / n; sp.push([Math.max(rO * 0.78 * Math.pow(1 - t, 1.5) + r * 0.16 * (1 - t) + r * 0.06, 0.002), lerp(yRing, y0, t), 0x8a8078]); }
  const gim = sub(g, 'gimbal', 0, yRing, 0), gp = new PB(pb.q), off = M(0, -yRing, 0);
  gp.rev([...sp].reverse().map((p, i) => [p[0], p[1], i === 0 ? 0x8a8078 : undefined]), 'glow', { m: off, vFit: true, crease: 1.2 });
  // v must run ring → tip: flip by rebuilding with the tip first is upward-facing, so fix UVs
  const geo = gp.b.glow[0].geo, uv = geo.attributes.uv; for (let i = 0; i < uv.count; i++) uv.setY(i, 1 - uv.getY(i));
  gp.add(new THREE.CircleGeometry(r * 0.22, 20), 0x6a6058, M(0, y0 - yRing, 0, Math.PI / 2), 'glow');
  gp.build(gim);
  const nc = pb.hi ? 24 : 12;
  pb.around(nc, a => pb.add(new THREE.CylinderGeometry(r * 0.035, r * 0.055, h * 0.1, 8), P.copper, mul(Mrad(a, rO * 0.83, yRing - h * 0.01), M(0, 0, 0, 0, 0, 0.35)), 'metal'));
  if (pb.med) { pb.hoop(rO * 0.9, r * 0.03, yRing + h * 0.03, P.copper); for (const a of [0.6, 2.7, 4.6]) addPump(pb, Math.cos(a) * r * 0.5, Math.sin(a) * r * 0.5, yRing + h * 0.02, yUnder - 0.01, r * 0.12); }
  pb.decalBand('hazard', r * 0.98, yUnder - h * 0.07, h * 0.06);
}

// Thermal engines: a reactor (or heat exchanger) drum with radiator fins and a slender bell.
function nuclear(def, g, pb, legacy) {
  const { h, r } = def, y0 = -h / 2, yUnder = mountPlate(pb, def), rE = nozzleExits(def)[0].r, rT = rE * 0.2;
  const yCore0 = y0 + h * 0.46, yCore1 = yUnder - h * 0.1, rc = r * 0.56, bellTop = y0 + h * 0.34;
  // shadow shield + tie tubes
  pb.rev([[r * 0.9, yUnder, P.gun], [r * 0.9, yUnder - h * 0.03], [rc * 1.1, yCore1 + 0.01]], 'metal', { crease: 0.4 });
  // reactor pressure vessel
  const body = legacy ? P.hull : P.shade;
  pb.rev([[rc * 0.5, yCore0 - h * 0.05, P.gun], [rc, yCore0, body], ...rib(rc, yCore0 + (yCore1 - yCore0) * 0.12, 0.03, 0.012, P.gun, body), [rc, yCore0 + (yCore1 - yCore0) * 0.4, legacy ? P.amber : P.yellow], [rc, yCore0 + (yCore1 - yCore0) * 0.52, body], ...rib(rc, yCore0 + (yCore1 - yCore0) * 0.88, 0.03, 0.012, P.gun, body), [rc, yCore1], [rc * 0.6, yCore1 + h * 0.03]], 'hull', { crease: 0.4 });
  // radiator fins
  const nf = legacy ? 8 : 12;
  pb.around(nf, a => { pb.rbox(r * 0.36, (yCore1 - yCore0) * 0.72, 0.016, 0.004, P.graphite, Mrad(a, rc + r * 0.17, (yCore0 + yCore1) / 2), 'metal'); if (pb.med) pb.rod([Math.cos(a) * (rc + r * 0.35), yCore0 + (yCore1 - yCore0) * 0.14, Math.sin(a) * (rc + r * 0.35)], [Math.cos(a) * (rc + r * 0.35), yCore0 + (yCore1 - yCore0) * 0.86, Math.sin(a) * (rc + r * 0.35)], 0.016, P.copper, 'metal', 6); });
  // control drum actuators and propellant line
  if (pb.med) {
    pb.around(6, a => pb.cyl(r * 0.05, r * 0.05, h * 0.08, yCore1 + h * 0.02, P.steel, 'metal', 8, false, M(Math.cos(a) * rc * 0.7, 0, Math.sin(a) * rc * 0.7)), 0.3);
    pb.tube([[r * 0.7, yUnder - 0.01, r * 0.3], [rc + r * 0.42, yCore1, r * 0.2], [rc + r * 0.42, yCore0, r * 0.1], [rT * 3, bellTop + h * 0.03, rT]], r * 0.045, P.silver, 'metal');
    pb.decal(legacy ? 'hot' : 'atom', rc, yCore0 + (yCore1 - yCore0) * 0.46, 0.26, legacy ? rc * 1.0 : rc * 0.5, { lift: 0.006 });
    pb.decal('danger', rc, yCore0 + (yCore1 - yCore0) * 0.7, 0.26, rc * 0.9, { lift: 0.006 });
  }
  // a warm band that glows with the bell
  const gim = sub(g, 'gimbal', 0, bellTop, 0), gp = new PB(pb.q), off = M(0, -bellTop, 0);
  gp.rev([[rT, bellTop, 0x7a5a48], [rc * 0.5, yCore0 - h * 0.05, P.gun]], 'metal', { m: off });
  addBell(gp, rT, rE, bellTop, y0, { hoops: 3, pow: 1.6, tint: 0x40444c, m: off });
  gp.build(gim);
}

// Gridded ion thruster: foil drum, magnet ring, glowing grid, neutraliser.
function ion(def, g, pb) {
  const { h, r } = def, y0 = -h / 2, yUnder = mountPlate(pb, def, { th: Math.min(0.05, h * 0.14) });
  const many = r > 0.5, heads = many ? [0, 1, 2, 3].map(i => [Math.cos(i * Math.PI / 2 + Math.PI / 4) * r * 0.45, Math.sin(i * Math.PI / 2 + Math.PI / 4) * r * 0.45]) : [[0, 0]], rh = many ? r * 0.36 : r * 0.72;
  pb.rev([[r * 0.96, yUnder, P.gold], [r * 0.96, y0 + h * 0.4], [r * 0.9, y0 + h * 0.32]], 'foil', { crease: 0.5 });
  pb.disc(r * 0.9, y0 + h * 0.32, false, P.graphite, 'metal');
  const gim = sub(g, 'gimbal', 0, 0, 0), gp = new PB(pb.q);
  for (const [x, z] of heads) {
    const m = M(x, 0, z);
    pb.rev([[rh * 0.7, y0 + h * 0.32, P.iron], [rh, y0 + h * 0.26], [rh, y0 + h * 0.05, P.steel], [rh * 0.94, y0], [rh * 0.86, y0], [rh * 0.86, y0 + h * 0.06]], 'metal', { m, crease: 0.4, seg: pb.seg(rh) });
    pb.torus(rh * 1.02, rh * 0.07, P.copper, M(x, y0 + h * 0.18, z, Math.PI / 2), 'metal', pb.seg(rh), 6);
    // domed grid: the glowing part
    const n = 6, dome = []; for (let i = 0; i <= n; i++) { const t = i / n; dome.push([Math.max(rh * 0.86 * t, 0.002), y0 + h * 0.06 + h * 0.07 * (1 - t * t), 0x9aa4b0]); }
    gp.rev(dome, 'glow', { m, vFit: true, crease: 1.2, seg: pb.seg(rh) });
    if (pb.med) for (let k = 1; k <= 3; k++) gp.torus(rh * 0.86 * k / 4, rh * 0.012, P.gun, M(x, y0 + h * 0.06 + h * 0.07 * (1 - (k / 4) ** 2) - 0.004, z, Math.PI / 2), 'metal', pb.seg(rh), 4);
    if (pb.med) { pb.rod([x + rh * 1.02, y0 + h * 0.3, z], [x + rh * 1.12, y0 + h * 0.02, z], rh * 0.05, P.steel, 'chrome', 6); pb.sphere(rh * 0.07, P.teal, M(x + rh * 1.12, y0 + h * 0.015, z), 'lamp', 6, 4); }
  }
  gp.build(gim);
  wiring(pb, [[r * 0.5, yUnder - 0.005, r * 0.8], [r * 0.99, y0 + h * 0.6, r * 0.2], [r * 0.99, y0 + h * 0.42, -r * 0.1]], 0.008, P.orange);
  pb.decal('bolt', r * 0.96, y0 + h * 0.68, 2.2, Math.min(h * 0.3, 0.12), { lift: 0.008 });
}

// Air-breathing engines: compressor casing, accessory gearbox, plumbing, and a petal nozzle.
function jet(def, g, pb) {
  const { h, r, variant } = def, y0 = -h / 2, y1 = h / 2, ram = variant === 'ramjet', rE = nozzleExits(def)[0].r;
  const fl = flange(pb, r, y1, 1, { color: P.gun }), yA = y1 - fl, yN = y0 + h * (ram ? 0.3 : 0.24);
  const body = ram ? P.graphite : P.hull;
  // cowl
  pb.rev([[r, yA, body], [r, yA - h * 0.28, ram ? P.redPaint : P.teal], [r, yA - h * 0.31, body], [r * 0.99, yN + h * 0.16, P.iron], [r * 0.92, yN + h * 0.1], [r * 0.86, yN + h * 0.02]], 'hull', { crease: 0.5 });
  // hot section casing with flanges
  // (it runs up inside the cowl lip, so the glowing liner is never seen from outside through the gap)
  pb.rev([[r * 0.84, yN + h * 0.13, P.iron], [r * 0.8, yN + h * 0.1, 0x7a6a5a], ...rib(r * 0.8, yN + h * 0.055, 0.02, 0.014, P.iron, 0x7a6a5a), ...rib(r * 0.8, yN + h * 0.0, 0.02, 0.014, P.iron, 0x7a6a5a), [r * 0.78, yN - h * 0.02]], 'metal', { crease: 0.5 });
  if (pb.med) {
    pb.rbox(r * 0.22, h * 0.2, r * 0.6, 0.02, P.iron, Mrad(Math.PI * 1.5, r * 0.98, yA - h * 0.16), 'metal');
    for (const a of [0.4, 1.2, 2.6, 3.4, 5.4]) pb.tube([[Math.cos(a) * r * 1.01, yA - h * 0.05, Math.sin(a) * r * 1.01], [Math.cos(a + 0.1) * r * 1.03, yA - h * 0.3, Math.sin(a + 0.1) * r * 1.03], [Math.cos(a + 0.25) * r * 0.97, yN + h * 0.14, Math.sin(a + 0.25) * r * 0.97]], r * 0.022, a > 3 ? P.copper : P.silver, 'metal', { seg: 6 });
    pb.decalBand('dash', r, yA - h * 0.04, 0.02);
    pb.decal('danger', r, yA - h * 0.16, 0.9, r * 0.6); pb.decal('n05', r, yA - h * 0.18, 2.6, r * 0.3);
  }
  // nozzle petals (variable-area) with a glowing interior
  const gim = sub(g, 'gimbal', 0, yN, 0), gp = new PB(pb.q), off = M(0, -yN, 0), np = pb.hi ? 16 : 10, rN = r * 0.8;
  const pet = [[rE, y0, 0x565a62], [rE * 1.02, y0 + 0.004], [rN, yN, 0x6c6058]];
  gp.rev(pet, 'metal', { m: off, seg: np, crease: 0.05, uRep: np });
  // liner: corrugated screech liner in the pipe, then the petals' inner faces (hottest deep inside, dim at the lip)
  const liner = [[rN * 0.96, yN + h * 0.1, 0x8a8078]];
  for (let i = 1; i <= 4; i++) { const yy = yN + h * 0.1 * (1 - i / 4); liner.push([rN * 0.93, yy + h * 0.0125, 0x6a625c], [rN * 0.96, yy, 0x8a8078]); }
  liner.push([(rN * 0.96 + rE * 0.96) / 2, (yN + y0) / 2, 0x9a8a7c], [rE * 0.96, y0, 0x5a5650]);
  gp.rev(liner, 'glow', { m: off, vFit: true, seg: np * 2, crease: 0.5 });
  // turbine face deep inside, and the flame holder in front of it: two V-gutter rings on radial struts
  gp.add(new THREE.CircleGeometry(rN * 0.96, 24), 0x8a8078, M(0, h * 0.1, 0, Math.PI / 2), 'glow', 1, 0.0);
  if (pb.med) {
    const yF = h * 0.045;
    for (const [rr, rt] of [[rN * 0.62, rN * 0.05], [rN * 0.33, rN * 0.04]]) gp.rev([[rr - rt, yF - rt * 1.6, 0x3a3632], [rr, yF, 0x6a5a50], [rr + rt, yF - rt * 1.6, 0x3a3632]], 'metal', { crease: 0.2, seg: np * 2 });
    gp.around(ram ? 8 : 6, a => gp.box(rN * 0.9, rN * 0.03, rN * 0.035, 0x4a4440, mul(M(0, yF - rN * 0.02, 0, 0, -a, 0), M(rN * 0.5, 0, 0)), 'metal'), 0.26);
    // fuel spray bars just upstream (they glow with the liner)
    gp.around(ram ? 16 : 12, a => gp.box(rN * 0.2, 0.012, 0.012, 0x8a8078, mul(M(0, h * 0.085, 0, 0, -a, 0), M(rN * 0.85, 0, 0)), 'glow'));
  }
  const cone = []; for (let i = 0; i <= 6; i++) { const t = i / 6; cone.push([Math.max(rN * 0.34 * (1 - t), 0.002), h * 0.1 - (yN - y0) * 0.5 * t, 0x4a4640]); }
  gp.rev(cone.reverse().map((p, i) => [p[0], p[1], i ? undefined : 0x4a4640]), 'metal', { crease: 0.9 });
  if (pb.med) gp.around(np, a => gp.box(0.008, (yN - y0) * 0.9, rE * 0.05, P.iron, mul(Mrad(a, (rE + rN) / 2 + 0.01, (y0 - yN) / 2, -Math.atan2(rN - rE, yN - y0)), M(0, 0, 0)), 'metal'), Math.PI / np);
  gp.build(gim);
}

// ---------------------------------------------------------------------------------------------
// Solid boosters: segmented casing, forward dome, aft skirt, fixed nozzle.
// ---------------------------------------------------------------------------------------------
export function srb(def, g, pb) {
  const { h, r } = def, y0 = -h / 2, y1 = h / 2, small = r < 0.4, rE = nozzleExits(def)[0].r;
  const ft = flange(pb, r, y1, 1), skirt = clamp(h * 0.09, 0.1, 0.9), nozz = clamp(h * 0.1, 0.12, 1.0);
  const a = y0 + nozz * 0.55, b = y1 - ft, L = b - a, nseg = Math.max(1, Math.round(L / (r * 3.2))), d = clamp(r * 0.02, 0.006, 0.022);
  const prof = [[r * 0.8, y0 + nozz * 0.5, P.gun], [r * 1.04, a, P.graphite], [r * 1.04, a + skirt * 0.5], [r, a + skirt, P.hull]];
  for (let i = 1; i < nseg; i++) prof.push(...rib(r, a + skirt + (L - skirt) * i / nseg, d * 3, d, P.gun, P.hull));
  const hb = clamp(L * 0.05, 0.06, 0.3);
  prof.push([r, b - hb * 2.4, P.dark], [r, b - hb * 1.4, P.hull], [r, b - 0.02], [r - 0.004, b]);
  pb.rev(prof, 'hull', { crease: 0.4 });
  pb.decalBand('hazard', r * 1.04, a + skirt * 0.25, Math.min(skirt * 0.36, 0.14), { lift: 0.004 });
  raceway(pb, r, a + skirt, b - 0.05, 2.3, { w: clamp(r * 0.14, 0.04, 0.16), d: clamp(r * 0.06, 0.02, 0.06) });
  if (pb.med) { pb.studs(r * 1.04, a + skirt * 0.62, Math.round(r * 24), 0.016); pb.around(4, an => pb.rbox(r * 0.12, skirt * 0.5, r * 0.2, 0.01, P.iron, Mrad(an, r * 1.07, a + skirt * 0.2), 'metal'), 0.5); }
  const dw = clamp(r * 0.9, 0.2, 1.1);
  pb.decal('solid', r, b - hb * 3.4 - dw * 0.1, 0.55, dw); if (L > 2) pb.decal('warnTri', r, b - hb * 3.4 - dw * 0.7, 0.55, dw * 0.4);
  if (L > 3.5) { pb.decal('wordmark', r, a + skirt + (L - skirt) * 0.3, 0.55, clamp(r * 1.3, 0.5, 2)); pb.decal('n0' + (1 + Math.round(r * 2) % 4), r, a + skirt + (L - skirt) * 0.3, 0.55 + Math.PI, r * 0.5); }
  // nozzle
  const gim = sub(g, 'gimbal', 0, y0 + nozz, 0), gp = new PB(pb.q), yT = y0 + nozz, rT = rE * 0.36;
  addBell(gp, rT, rE, yT, y0, { hoops: small ? 0 : 1, manifold: false, pow: 1.5, tint: 0x3a3d43, m: M(0, -yT, 0) });
  gp.build(gim);
  pb.rev([[rT * 1.0, yT, P.gun], [r * 0.8, y0 + nozz * 0.5]], 'metal', { crease: 0.5 });
}

// ---------------------------------------------------------------------------------------------
// Radial engines: mount face at x = -rw/2, nozzle axis through the part centre, exit at y = -h/2.
// ---------------------------------------------------------------------------------------------
export function radialengine(def, g, pb) {
  const { h, rw, t, variant } = def, y0 = -h / 2, y1 = h / 2, x0 = -rw / 2, ex = nozzleExits(def)[0], rE = ex.r;
  // mounting pad
  pb.rbox(0.025, h * 0.7, t * 0.8, 0.006, P.gun, M(x0 + 0.0125, h * 0.1, 0), 'metal');
  if (variant === 'solid') {
    // a little kick motor canted outward
    const m = M(ex.x, 0, 0);
    pb.rev([[0.002, y1, P.redPaint], [rE * 0.7, y1 - h * 0.08], [rE * 1.25, y1 - h * 0.2], [rE * 1.25, y0 + h * 0.3, P.gun], [rE * 0.5, y0 + h * 0.24]], 'paint', { m, crease: 0.5 });
    const gim = sub(g, 'gimbal', ex.x, y0 + h * 0.24, 0), gp = new PB(pb.q);
    addBell(gp, rE * 0.4, rE, 0, -h * 0.24, { hoops: 0, manifold: false, pow: 1.5 }); gp.build(gim);
    pb.rbox(rw * 0.5, h * 0.12, t * 0.5, 0.01, P.gun, M(x0 + rw * 0.25, h * 0.1, 0), 'metal'); pb.rbox(rw * 0.5, h * 0.12, t * 0.5, 0.01, P.gun, M(x0 + rw * 0.25, -h * 0.12, 0), 'metal');
    return;
  }
  const pod = variant === 'pod', rT = rE * 0.3, yT = y0 + h * (pod ? 0.42 : 0.5), chLen = h * 0.16, yP = yT + chLen;
  if (pod) {
    // faired pod with an intake-like brow, pylon to the hull
    const rp = Math.min(rw, t) * 0.44, n = 8, prof = [[rp * 0.7, yT + chLen * 0.3, P.gun], [rp, yT + chLen * 1.2, P.hull]];
    for (let i = 1; i <= n; i++) { const tt = i / n; prof.push([Math.max(rp * Math.cos(tt * Math.PI / 2) ** 0.7, 0.002), lerp(yT + chLen * 1.2 + (y1 - yT - chLen * 1.2) * 0.3, y1, tt), i === 3 ? P.teal : i === 4 ? P.hull : undefined]); }
    pb.rev(prof, 'hull', { m: M(ex.x, 0, 0), crease: 0.6 });
    pb.poly([[x0, y1 - h * 0.1], [ex.x, y1 - h * 0.2], [ex.x, yT + chLen * 1.6], [x0, yT + chLen * 2.2]], t * 0.28, 0.02, P.shade, null, 'hull');
    pb.decal('n02', rp, yT + chLen * 2.6, 0, rp * 0.7, { lift: 0.004 }); // centred on the pod axis only when ex.x = 0; close enough
  } else {
    pb.rbox(rw * 0.9, h * 0.34, t * 0.7, 0.02, P.shade, M(x0 + rw * 0.47, y1 - h * 0.2, 0), 'hull');
    pb.sphere(t * 0.2, P.yellow, M(ex.x - t * 0.1, yP + h * 0.04, t * 0.26), 'paint', 12, 8); pb.sphere(t * 0.2, P.silver, M(ex.x - t * 0.1, yP + h * 0.04, -t * 0.26), 'chrome', 12, 8);
    if (pb.med) pb.tube([[ex.x - t * 0.1, yP + h * 0.04, t * 0.26], [ex.x + rT * 2, yP + h * 0.02, t * 0.1], [ex.x + rT, yP - chLen * 0.1, 0]], 0.012, P.copper, 'metal');
  }
  const gim = sub(g, 'gimbal', ex.x, yP, 0), gp = new PB(pb.q), off = M(0, -yP, 0);
  addChamber(gp, rT, yT, chLen, { m: off });
  addBell(gp, rT, rE, yT, y0, { hoops: pod ? 2 : 1, m: off });
  gp.build(gim);
}
