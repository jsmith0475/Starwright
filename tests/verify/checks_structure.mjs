// 7. Structural dynamics: the load in every joint (docs/STRUCTURE.md, js/core/structure.js).
//
// The game cuts the vessel at a joint and sums m a - F over the far side. The reference (ref_structure.mjs) never
// does that: it treats every part as its own rigid body, every joint as a weld with an unknown wrench, and solves
// Newton-Euler for all bodies at once. Closed forms come from textbook rigid-body dynamics, and the live checks
// compare the snapshot of the flying game with what the vessel is OBSERVED to do (velocity and spin changes).
import { World, SYSTEM, A, simpleShip, spawn } from './harness.mjs';
import * as R from './ref.mjs';
import * as RS from './ref_structure.mjs';
import { solveJointLoads, jointUtilisation, STRUCT } from '../../js/core/structure.js';
import { TUNING } from '../../js/core/vessel.js';
import { analyzeCraft } from '../../js/core/loadcases.js';
import { Craft, stockCrafts } from '../../js/core/craft.js';
import { PARTS } from '../../js/core/parts.js';
import { ascentProgram, fly } from '../../js/core/autopilot.js';

const sys = R.readSystem();
const DT = TUNING.DT_MAX;
const { add, sub, scale, dot, cross, norm } = RS;
const EPS = 2.220446049250313e-16;
// thousands of joints are judged in the live flights: a coarser walk round the ring (the peaks are polished anyway)
const RING_LIVE = { K: 48, scan: 180 };

const maxLoad = loads => loads.reduce((s, l) => Math.max(s, norm(l.F), norm(l.M)), 0);
/** Largest difference between two load lists, as a fraction of `sc`. */
const loadDiff = (a, b, sc) => a.reduce((s, l, i) => Math.max(s, norm(sub(l.F, b[i].F)), norm(sub(l.M, b[i].M))), 0) / sc;

// ------------------------------------------------------------------------------------------ 7a closed forms
function closedForms(S) {
  // --- (1) uniform rod pushed by an end thrust: axial force at a station = thrust x mass ahead / total mass
  for (const rootAt of ['nose', 'tail']) {
    const N = 8, m = 750, L = 1.5, T = 2.4e5;
    const rod = RS.rod(N, m, L, { rootAt });
    RS.push(rod.bodies, 0, [0, T, 0], [0, -rod.half, 0]);
    const motion = { w: [0, 0, 0], alpha: [0, 0, 0], f: [0, T / rod.M, 0] };
    const g = solveJointLoads(rod.bodies, rod.joints, motion);
    let worst = 0, worstOther = 0;
    rod.joints.forEach((j, i) => {
      const k = i + 1;                                   // station between segments k-1 and k: N-k segments ahead
      const u = jointUtilisation(g[i].F, g[i].M, j.n, 0.6, 1, 1, 1);
      worst = Math.max(worst, Math.abs(u.axial - (-T * (N - k) / N)));
      worstOther = Math.max(worstOther, u.shear, u.bending, u.torsion);
    });
    S.check(`rod of 8 segments, end thrust 240 kN, root at the ${rootAt}: axial = -thrust x mass ahead / total (worst station)`, 0, worst, 1e-9 * T, { unit: 'N' });
    S.check(`  the same rod: shear, bending and torsion`, 0, worstOther, 1e-9 * T, { unit: 'N, N m' });
    if (rootAt === 'nose') {
      const u4 = jointUtilisation(g[3].F, g[3].M, rod.joints[3].n, 0.6, 1, 1, 1);
      S.check('  mid station (4 of 8 segments ahead): compression', -T / 2, u4.axial, 1e-9 * T, { unit: 'N' });
    }
  }
  // --- (2) the same rod spinning end over end: tension = w^2 x first mass moment beyond the station
  for (const rootAt of ['nose', 'tail']) {
    const N = 10, m = 400, L = 1.2, wz = 0.9;
    const rod = RS.rod(N, m, L, { rootAt, Iy: 30 });
    const g = solveJointLoads(rod.bodies, rod.joints, { w: [0, 0, wz], alpha: [0, 0, 0], f: [0, 0, 0] });
    let worst = 0, other = 0, peak = 0;
    rod.joints.forEach((j, i) => {
      const s = rod.stationY(i + 1), H = rod.half, mu = m / L;
      // continuous rod: tension at s = integral_s^H mu w^2 y dy (the same from either side, the rod is balanced)
      const want = mu * wz * wz * (H * H - s * s) / 2;
      const u = jointUtilisation(g[i].F, g[i].M, j.n, 0.6, 1, 1, 1);
      worst = Math.max(worst, Math.abs(u.axial - want)); other = Math.max(other, u.shear, u.bending, u.torsion); peak = Math.max(peak, want);
    });
    S.check(`rod of 10 segments spinning end over end at 0.9 rad/s, root at the ${rootAt}: tension = mu w^2 (H^2 - s^2) / 2 (worst station)`, 0, worst, 1e-10 * peak, { unit: 'N', note: `centre tension ${peak.toFixed(1)} N` });
    S.check('  the same rod: shear, bending and torsion', 0, other, 1e-10 * peak, { unit: 'N, N m' });
  }
  // --- (3) free rod, lateral force at the tail end: shear and bending with inertia relief
  for (const rootAt of ['nose', 'tail']) {
    const N = 12, m = 500, L = 1.0, P = 3.0e4;
    const rod = RS.rod(N, m, L, { rootAt, Iy: 40 });       // some inertia about its own axis, so the free rod is a regular rigid body
    RS.push(rod.bodies, 0, [P, 0, 0], [0, -rod.half, 0]);
    const cf0 = RS.lateralRod(rod.M, rod.half, P, 0);
    const motion = { w: [0, 0, 0], alpha: [0, 0, cf0.alpha], f: [P / rod.M, 0, 0] };
    const g = solveJointLoads(rod.bodies, rod.joints, motion);
    let wV = 0, wM = 0, pkV = 0, pkM = 0, pkAt = 0, wAx = 0;
    rod.joints.forEach((j, i) => {
      const s = rod.stationY(i + 1);
      const cf = RS.lateralRod(rod.M, rod.half, P, s);
      // closed form = what the lower piece does to the upper one; with the root at the nose the joint wrench is
      // what the upper (root) side does to the lower: the opposite
      const sg = rootAt === 'tail' ? 1 : -1;
      wV = Math.max(wV, norm(sub(g[i].F, [sg * cf.Vx, 0, 0])));
      wM = Math.max(wM, norm(sub(g[i].M, [0, 0, sg * cf.Mz])));
      wAx = Math.max(wAx, Math.abs(g[i].F[1]));
      pkV = Math.max(pkV, Math.abs(cf.Vx));
      if (Math.abs(cf.Mz) > pkM) { pkM = Math.abs(cf.Mz); pkAt = s; }
    });
    S.check(`free rod of 12 segments, 30 kN sideways at the tail, root at the ${rootAt}: shear vs closed form with inertia relief (worst station)`, 0, wV, 1e-10 * P, { unit: 'N', note: `peak ${pkV.toFixed(0)} N` });
    S.check('  bending moment vs closed form (segments carry their own inertia m L^2 / 12)', 0, wM, 1e-10 * P * rod.half, { unit: 'N m', note: `peak ${pkM.toFixed(0)} N m at y = ${pkAt}` });
    S.check('  axial force', 0, wAx, 1e-10 * P, { unit: 'N' });
    // the reference on the same rod: it has to FIND the motion (alpha = 3 P / M H, a = P / M) and the same loads
    const d = RS.multibodyDynamic(rod.bodies, rod.joints, [0, 0, 0]);
    S.check('  multibody reference: derived angular acceleration = 3 P / (M H)', cf0.alpha, d.alpha[2], 1e-11, { rel: true, unit: 'rad/s2' });
    S.check('  multibody reference: derived acceleration of the mass centre = P / M', P / rod.M, d.f[0], 1e-11, { rel: true, unit: 'm/s2' });
    S.check('  multibody reference vs game solver, all stations', 0, loadDiff(g, d.loads, maxLoad(g)), 1e-11, { unit: 'of the largest load' });
    if (rootAt === 'tail') {
      // hand numbers a student can check: shear is zero where a_x = 0 integrates out, V(s) = P (H-s)(H+3s)... at s = -H/3
      const third = RS.lateralRod(rod.M, rod.half, P, -rod.half / 3);
      S.check('  textbook point: the peak bending moment is at s = -H/3 and equals 8 P H / 27', 8 * P * rod.half / 27, Math.abs(third.Mz), 1e-9, { rel: true, unit: 'N m' });
      const k = N / 3;                       // station index at y = -H/3  (k - N/2) L = -N L / 6
      S.check('  game solver at that station: bending', 8 * P * rod.half / 27, norm(g[k - 1].M), 1e-10, { rel: true, unit: 'N m' });
      S.check('  game solver at that station: shear (zero there)', 0, norm(g[k - 1].F), 1e-10 * P, { unit: 'N' });
    }
  }
  // --- (4) pure torque about the rod axis on the tail segment: torsion = torque x inertia ahead / total
  {
    const N = 6, m = 300, L = 2, Iy = 55, Tq = 900;
    const rod = RS.rod(N, m, L, { rootAt: 'nose', Iy });
    rod.bodies[0].T = [0, Tq, 0];
    const g = solveJointLoads(rod.bodies, rod.joints, { w: [0, 0, 0], alpha: [0, Tq / (N * Iy), 0], f: [0, 0, 0] });
    let worst = 0, other = 0;
    rod.joints.forEach((j, i) => {
      const u = jointUtilisation(g[i].F, g[i].M, j.n, 0.6, 1, 1, 1);
      worst = Math.max(worst, Math.abs(u.torsion - Tq * (N - (i + 1)) / N));
      other = Math.max(other, Math.abs(u.axial), u.shear, u.bending);
    });
    S.check('rod of 6 segments, 900 N m twist on the tail: torsion = torque x inertia ahead / total (worst station)', 0, worst, 1e-10 * Tq, { unit: 'N m' });
    S.check('  the same rod: axial, shear and bending', 0, other, 1e-10 * Tq, { unit: 'N, N m' });
  }
  // --- (5) free fall: no forces, no spin → no load at all
  {
    const rnd = RS.rng(11);
    const T = RS.randomTree(rnd, 9);
    for (const b of T.bodies) { b.F = [0, 0, 0]; b.T = [0, 0, 0]; }
    const g = solveJointLoads(T.bodies, T.joints, { w: [0, 0, 0], alpha: [0, 0, 0], f: [0, 0, 0] });
    S.check('random tree of 9 bodies in pure free fall (no force, no spin): largest joint load', 0, maxLoad(g), 0, { unit: 'N, N m' });
  }
  // --- (6) side boosters: a core stack (tank + payload) with two boosters that carry all the thrust
  {
    const Mt = 9000, Mp = 3000, mb = 6000, Tb = 2.5e5, d = 1.6, rb = 0.65;
    // origin first at the core tank's centre, then moved to the mass centre by centred()
    const raw = [
      { m: Mt, r: [0, 0, 0], I: [9000, 3000, 9000], F: [0, 0, 0], T: [0, 0, 0] },                 // 0 core tank (root)
      { m: Mp, r: [0, 3.5, 0], I: [900, 600, 900], F: [0, 0, 0], T: [0, 0, 0] },                  // 1 payload
      { m: mb, r: [d, -0.4, 0], I: [7000, 1200, 7000], F: [0, Tb, 0], T: cross([d, -3.4, 0], [0, Tb, 0]) },      // 2 booster +x, thrust at its nozzle
      { m: mb, r: [-d, -0.4, 0], I: [7000, 1200, 7000], F: [0, Tb, 0], T: cross([-d, -3.4, 0], [0, Tb, 0]) },    // 3 booster -x
    ];
    const rawJ = [
      { parent: 0, child: 1, p: [0, 2.5, 0], n: [0, 1, 0] },
      { parent: 0, child: 2, p: [d - rb, -0.4, 0], n: [1, 0, 0] },
      { parent: 0, child: 3, p: [-(d - rb), -0.4, 0], n: [-1, 0, 0] },
    ];
    const { bodies, joints } = RS.centred(raw, rawJ);
    const M = Mt + Mp + 2 * mb, a = 2 * Tb / M;
    const g = solveJointLoads(bodies, joints, { w: [0, 0, 0], alpha: [0, 0, 0], f: [0, a, 0] });
    const u0 = jointUtilisation(g[0].F, g[0].M, joints[0].n, 0.6, 1, 1, 1);
    S.check('two boosters lifting a core: payload joint compression = total thrust x payload mass / total mass', -2 * Tb * Mp / M, u0.axial, 1e-10, { rel: true, unit: 'N' });
    S.check('  payload joint: shear and bending', 0, Math.max(u0.shear, u0.bending, u0.torsion), 1e-10 * Tb, { unit: 'N, N m' });
    const lift = Tb * (Mt + Mp) / M;                  // what each booster hands to the core: its thrust less its own m a
    for (const i of [1, 2]) {
      const u = jointUtilisation(g[i].F, g[i].M, joints[i].n, 0.4, 1, 1, 1);
      S.check(`  booster ${i} mount: shear = thrust x core mass / total mass`, lift, u.shear, 1e-10, { rel: true, unit: 'N' });
      S.check(`  booster ${i} mount: bending = that shear x the mount's offset from the booster axis (${rb} m)`, lift * rb, u.bending, 1e-10, { rel: true, unit: 'N m' });
      S.check(`  booster ${i} mount: axial and torsion`, 0, Math.max(Math.abs(u.axial), u.torsion), 1e-10 * Tb, { unit: 'N, N m' });
      // direction: the core holds the booster DOWN (the booster pushes the core up)
      S.ok(`  booster ${i} mount: the core pulls the booster back (F_J.y < 0)`, g[i].F[1] < 0);
    }
    // one booster out: the stack is pushed off-centre and turns; the answer comes from the multibody reference
    bodies[3].F = [0, 0, 0]; bodies[3].T = [0, 0, 0];
    const d1 = RS.multibodyDynamic(bodies, joints, [0, 0, 0]);
    const asm = RS.assembly(bodies);
    const Tz = bodies[2].T[2];
    S.check('  one booster out: angular acceleration derived by the multibody reference = Tz / Izz by hand', Tz / asm.I[2][2], d1.alpha[2], 1e-10, { rel: true, unit: 'rad/s2', note: `everything lies in the plane z = 0, so the z axis is a principal axis although Ixy = ${asm.I[0][1].toFixed(1)} kg m2 is not zero` });
    S.check('  one booster out: no angular acceleration about x or y', 0, Math.hypot(d1.alpha[0], d1.alpha[1]), 1e-12, { unit: 'rad/s2' });
    const g1 = solveJointLoads(bodies, joints, { w: [0, 0, 0], alpha: d1.alpha, f: d1.f });
    S.check('  one booster out: game solver vs multibody reference, all joints', 0, loadDiff(g1, d1.loads, maxLoad(d1.loads)), 1e-11, { unit: 'of the largest load' });
  }
}

// ------------------------------------------------------------------------------------------ 7b random trees
function randomTrees(S, full) {
  const rnd = RS.rng(20261121);
  const nTrees = full ? 600 : 300;
  let worstDyn = 0, worstPre = 0, worstRes = 0, worstSpread = 0, bodiesTotal = 0, worstCons = 0;
  for (let t = 0; t < nTrees; t++) {
    const n = 2 + Math.floor(rnd() * 13);
    bodiesTotal += n;
    const T = RS.randomTree(rnd, n);
    const w = rnd() < 0.15 ? [0, 0, 0] : [rnd() * 4 - 2, rnd() * 4 - 2, rnd() * 4 - 2];
    // (i) the reference derives the motion; the game solver is given that motion
    const d = RS.multibodyDynamic(T.bodies, T.joints, w);
    const g = solveJointLoads(T.bodies, T.joints, { w, alpha: d.alpha, f: d.f });
    const sc = Math.max(maxLoad(d.loads), 1e-30);
    worstDyn = Math.max(worstDyn, loadDiff(g, d.loads, sc));
    worstSpread = Math.max(worstSpread, d.spread);
    // the derived f must be total force / total mass (Newton for the whole assembly, not used by the reference)
    let Ft = [0, 0, 0], mt = 0;
    for (const b of T.bodies) { Ft = add(Ft, b.F); mt += b.m; }
    const aScale = d.acc.reduce((s2, a) => Math.max(s2, norm(a)), 1e-30);        // some trees carry no net force: scale by the part accelerations
    worstCons = Math.max(worstCons, norm(sub(scale(Ft, 1 / mt), d.f)) / aScale);
    // (ii) a motion that is NOT the dynamically right one (as the game's is with a diagonal inertia)
    const mo = { w, alpha: [rnd() * 6 - 3, rnd() * 6 - 3, rnd() * 6 - 3], f: [rnd() * 60 - 30, rnd() * 60 - 30, rnd() * 60 - 30] };
    const p = RS.multibodyPrescribed(T.bodies, T.joints, mo);
    const g2 = solveJointLoads(T.bodies, T.joints, mo);
    worstPre = Math.max(worstPre, loadDiff(g2, p.loads, Math.max(maxLoad(p.loads), 1e-30)));
    // (iii) given the right motion, the prescribed-motion mode needs no residual wrench on the root
    const p0 = RS.multibodyPrescribed(T.bodies, T.joints, { w, alpha: d.alpha, f: d.f });
    worstRes = Math.max(worstRes, Math.max(norm(p0.residual.F), norm(p0.residual.M)) / sc);
  }
  S.info('random welded trees', `${nTrees} trees, ${bodiesTotal} bodies`, '', '2 to 14 bodies, masses 20 kg to 40 t, random offsets, inertias, forces, couples and spin; joints in random order');
  S.check('game solveJointLoads vs multibody reference, motion derived by the reference (worst joint of all trees)', 0, worstDyn, 1e-11, { unit: 'of the largest load' });
  S.check('game solveJointLoads vs multibody reference, arbitrary prescribed motion (worst joint)', 0, worstPre, 1e-11, { unit: 'of the largest load' });
  S.check('reference self-check: welded bodies share one angular acceleration', 0, worstSpread, 1e-10, { unit: 'rad/s2' });
  S.check('reference self-check: derived acceleration of the mass centre = total force / total mass', 0, worstCons, 1e-11, { unit: 'of the largest part acceleration' });
  S.check('reference self-check: the right motion leaves no residual wrench on the root', 0, worstRes, 1e-10, { unit: 'of the largest load' });
}

// ------------------------------------------------------------------------------------------ 7c thin ring
function ring(S) {
  // the quadrature itself against the textbook peaks, on one case worked by hand
  {
    const r = 0.625, Nax = 500, V = Math.hypot(100, 30), Mb = Math.hypot(40, 70), Mt = 10;
    const L = RS.ringLineLoads([100, -500, 30], [40, 10, -70], [0, 1, 0], r);
    S.check('reference ring, hand case: peak tension N/(2 pi r) + Mb/(pi r^2)', Nax / (2 * Math.PI * r) + Mb / (Math.PI * r * r), L.nT, 1e-7, { rel: true, unit: 'N/m' });
    S.check('reference ring, hand case: peak shear flow V/(pi r) + Mt/(2 pi r^2)', V / (Math.PI * r) + Mt / (2 * Math.PI * r * r), L.q, 1e-7, { rel: true, unit: 'N/m' });
    S.check('reference ring: the line loads integrate back to the force', 0, norm(sub(L.back.F, [100, -500, 30])), 1e-9, { unit: 'N' });
    S.check('reference ring: the line loads integrate back to the moment', 0, norm(sub(L.back.M, [40, 10, -70])), 1e-9, { unit: 'N m' });
  }
  const rnd = RS.rng(77);
  const u = (lo, hi) => lo + (hi - lo) * rnd();
  let wRes = 0, wPeak = 0, wUtil = 0, modes = 0, modeBad = 0, cases = 0;
  const seen = { tension: 0, compression: 0, shear: 0 };
  for (let k = 0; k < 400; k++) {
    let n = [u(-1, 1), u(-1, 1), u(-1, 1)];
    if (k % 4 === 0) n = [0, k % 8 ? 1 : -1, 0];
    n = scale(n, 1 / norm(n));
    const r = Math.exp(u(Math.log(0.08), Math.log(2)));
    const fs = Math.exp(u(Math.log(1e2), Math.log(5e6)));
    let F = [u(-1, 1) * fs, u(-1, 1) * fs, u(-1, 1) * fs];
    let M = [u(-1, 1) * fs * r * 2, u(-1, 1) * fs * r * 2, u(-1, 1) * fs * r * 2];
    if (k % 5 === 1) F = scale(n, u(-1, 1) * fs);                          // pure axial
    if (k % 5 === 2) M = scale(n, u(-1, 1) * fs * r);                      // pure torsion
    if (k % 7 === 3) F = add(scale(n, -fs * 20), scale(F, 0.05));          // mostly pulling: tension governs
    if (k % 7 === 4) F = add(scale(n, fs * 20), scale(F, 0.05));           // mostly pushing
    const capT = u(0.3, 2) * 1e6, capC = u(0.3, 2) * 1e6, capS = u(0.2, 1.5) * 1e6;
    const g = jointUtilisation(F, M, n, r, capT, capC, capS);
    const q = RS.ringUtilisation(F, M, n, r, capT, capC, capS);
    const sc = Math.max(q.nT, q.nC, q.q, 1e-30);
    wRes = Math.max(wRes, Math.abs(g.axial - q.N) / fs, Math.abs(g.shear - q.V) / fs, Math.abs(g.bending - q.Mb) / (fs * r), Math.abs(g.torsion - q.Mt) / (fs * r));
    wPeak = Math.max(wPeak, Math.abs(g.nT - q.nT) / sc, Math.abs(g.nC - q.nC) / sc, Math.abs(g.q - q.q) / sc);
    wUtil = Math.max(wUtil, Math.abs(g.util - q.util) / Math.max(q.util, 1e-30));
    if (q.margin > 1e-6 * q.util) { modes++; if (g.mode !== q.mode) modeBad++; seen[q.mode]++; }
    cases++;
  }
  S.info('random joints for the ring check', `${cases} cases`, '', `governing mode: ${seen.tension} tension, ${seen.compression} compression, ${seen.shear} shear; radii 0.08 to 2 m, any axis`);
  S.check('jointUtilisation resultants (axial, shear, bending, torsion) vs integrals of the ring line loads', 0, wRes, 1e-9, { unit: 'rel' });
  S.check('jointUtilisation peak line loads nT, nC, q vs the peaks found round the ring', 0, wPeak, 1e-7, { unit: 'rel', note: 'the reference walks 20 000 points round the ring and polishes the peaks' });
  S.check('jointUtilisation utilisation vs max(nT/capT, nC/capC, q/capS) of the ring', 0, wUtil, 1e-7, { unit: 'rel' });
  S.check(`jointUtilisation governing mode (${modes} cases with a clear winner)`, 0, modeBad, 0, { unit: 'wrong' });
  // signs, on cases nobody can argue with
  const pull = jointUtilisation([0, -1000, 0], [0, 0, 0], [0, 1, 0], 0.5, 1e6, 1e6, 1e6);
  S.ok('sign: the root side pulling the far side back (F_J against n) is tension', pull.axial === 1000 && pull.mode === 'tension' && pull.nC === 0, `axial ${pull.axial}, mode ${pull.mode}`);
  const pushIt = jointUtilisation([0, 1000, 0], [0, 0, 0], [0, 1, 0], 0.5, 1e6, 1e6, 1e6);
  S.ok('sign: the root side pushing the far side away is compression', pushIt.axial === -1000 && pushIt.mode === 'compression' && pushIt.nT === 0, `axial ${pushIt.axial}, mode ${pushIt.mode}`);
  S.check('1 MN of pull on a 0.625 m ring: 1e6 / (2 pi 0.625) N/m', 1e6 / (2 * Math.PI * 0.625), jointUtilisation([0, -1e6, 0], [0, 0, 0], [0, 1, 0], 0.625, 1e6, 1e6, 1e6).nT, 1e-12, { rel: true, unit: 'N/m' });
}

// ------------------------------------------------------------------------------------------ live game helpers
/** Rotate a world vector into body axes: q* v q, written out (no game maths). q = [x, y, z, w]. */
function toBody(q, v) {
  const u = [-q[0], -q[1], -q[2]];
  const t = scale(cross(u, v), 2);
  return add(v, add(scale(t, q[3]), cross(u, t)));
}
/** Rotate a body vector into world axes: q v q*. */
function toWorld(q, v) {
  const u = [q[0], q[1], q[2]];
  const t = scale(cross(u, v), 2);
  return add(v, add(scale(t, q[3]), cross(u, t)));
}
const grav = (gm, p) => scale(p, -gm / Math.pow(norm(p), 3));

/**
 * One 20 ms physics step of the real game, with everything needed to judge it from outside:
 *   pre / post state, the snapshot of the structure (`snap`, also `solved`: the data the step was solved with), and
 *   the specific force and angular acceleration the vessel was OBSERVED to have.
 */
function stepOnce(w, v, step = DT) {
  const gm = sys.byId[v.body.id].gm;
  const pre = { pos: A(v.pos), vel: A(v.vel), q: [v.q.x, v.q.y, v.q.z, v.q.w], w: A(v.w), m: v.mass, I: A(v.inertia), com: A(v.com), thrust: 0, pm: new Map() };
  const ablator = () => { let s2 = 0; for (const p of v.parts.values()) s2 += (p.res && p.res.ablator) || 0; return s2; };
  pre.abl = ablator();
  pre.geo = new Map();        // geometric centre of every part from the centre of mass (public fields)
  for (const [id, p] of v.parts) { pre.pm.set(id, p.mass); pre.geo.set(id, [p.pos.x - v.com.x, p.pos.y - v.com.y, p.pos.z - v.com.z]); }
  const nParts = v.parts.size, t0 = w.ut;
  w.step(step);
  const dt = w.ut - t0;
  const st = v.structure;
  const rec = { pre, dt, ok: !v.dead && !v.landed && w.substeps === 1 && v.parts.size === nParts && !!st && st.valid, thrust: v.thrust };
  if (!rec.ok) return rec;
  const post = { pos: A(v.pos), vel: A(v.vel), q: [v.q.x, v.q.y, v.q.z, v.q.w], w: A(v.w), m: v.mass, com: A(v.com) };
  rec.post = post;
  // When propellant leaves, the mass centre moves inside the vessel and the game re-bases `vel` and `pos` to the new
  // mass centre after the step (Vessel._updateMass: vel += w x shift). That is bookkeeping of the reference point,
  // not acceleration: take it out, so that the velocities compared are those of one material point.
  const shift = sub(post.com, pre.com);
  const vEnd = sub(post.vel, toWorld(post.q, cross(post.w, shift)));
  const pEnd = sub(post.pos, toWorld(post.q, shift));          // where the second gravity kick was evaluated
  const aWorld = sub(scale(sub(vEnd, pre.vel), 1 / dt), scale(add(grav(gm, pre.pos), grav(gm, pEnd)), 0.5));
  rec.fObs = toBody(pre.q, aWorld);
  rec.alphaObs = scale(sub(post.w, pre.w), 1 / dt);
  // the integrator divides by the mass with HALF of the step's propellant gone (vessel.js _stepFlight); ablator that
  // burnt off a heat shield in the step is not propellant and is not in that half
  rec.mMid = pre.m - 0.5 * ((pre.m - post.m) - (pre.abl - ablator()));
  // roundoff of a velocity difference over one step, as a force
  rec.fNoise = 16 * EPS * (norm(pre.vel) + 1) / dt * pre.m;
  const snap = st.snapshot();
  rec.snap = snap;
  // snapshot() is the plain data of the solved step: it goes to the reference exactly as returned
  rec.solved = snap;
  return rec;
}

const sumF = bodies => bodies.reduce((s, b) => add(s, b.F), [0, 0, 0]);
const sumT = bodies => bodies.reduce((s, b) => add(s, b.T), [0, 0, 0]);

/** pod (or probe) + tank + engine ... a stack from a list of part types, top first. */
function stack(types, name = 'Stack') {
  const c = new Craft(name);
  let [p] = c.setRoot(types[0]);
  const out = [p];
  for (let i = 1; i < types.length; i++) { p = c.attachStack(types[i], p.id, 'bottom')[0]; out.push(p); }
  c.autoStage();
  return { craft: c, parts: out };
}
function emberTwin() { return stockCrafts().find(c => c.name === 'Ember Twin'); }
/** Ember Twin with a Brace Strut on each clamp's host tank, at the clamp's angle, 1.2 m above the clamp. */
function struttedEmber() {
  const craft = emberTwin();
  const clamps = craft.parts.filter(p => p.type === 'dec_radial');
  const struts = clamps.map(k => craft.attachRadial('strut', k.parent, k.pos.y + 1.2, k.rot, 1)[0]);
  return { craft, clamps: clamps.map(k => k.id), struts: struts.map(p => p.id) };
}
/** A lopsided ship: one strap-on booster, a radial tank on one side only. */
function lopsided() {
  const { craft: c, parts } = stack(['probe_keystone', 'tank_m400', 'tank_m400', 'eng_goshawk'], 'Lopsided');
  const clamp = c.attachRadial('dec_radial', parts[2].id, parts[2].pos.y, 0, 1);
  c.attachOuter('srb_ember', clamp[0].id);
  c.attachRadial('fin', parts[2].id, parts[2].pos.y - 1, Math.PI / 2, 1);
  c.autoStage();
  return c;
}

/** The recorded flights that 7d and 7e both judge (flown once). */
let FLIGHTS = null;
function flights(full = true) {
  if (FLIGHTS) return FLIGHTS;
  const long = full ? 1 : 0.4;          // the quick subset flies the two 18-part craft for a shorter time
  FLIGHTS = [];
  const fl = (name, opts, make) => {
    const w = new World();
    const f = { name, recs: [], skipped: 0, events: [], ...opts };
    w.on('structure', d => f.events.push(d));
    const v = make(w, f);
    f.vessel = v; f.world = w;
    // parts whose mass does not sit at their geometric centre: capsules with ballast (comY), parts carrying a truss
    f.offsetParts = [...v.parts.values()].filter(p => p.def.comY || (p.truss && p.truss.length)).map(p => p.def.id);
    f.offset = f.offsetParts.length > 0;
    FLIGHTS.push(f);
    return f;
  };
  const record = (f, n, between = null, step = DT) => {
    const w = f.world, v = f.vessel;
    for (let i = 0; i < n && !v.dead; i++) {
      if (between) between(i);
      const r = stepOnce(w, v, step);
      if (r.ok) f.recs.push(r); else f.skipped++;
    }
  };
  // 1. vacuum burn, tumbling, SAS fighting it with reaction wheel and gimbal (crewed pod: its mass centre is offset)
  record(fl('pod ship, vacuum burn while tumbling', { symmetric: true, comOffset: true }, w => {
    const v = spawn(w, simpleShip(), 'helion', [2e11, 0, 0], [0, 0, 0]);
    v.ctrl.sas = true; v.ctrl.throttle = 1; w.stage();
    v.w.set(0.3, 0.1, -0.2);
    return v;
  }), 250);
  // 2. the same with a probe core on top (no offset mass centre, no interstage): the craft is symmetric and its
  //    diagonal inertia is its whole inertia, so the game's motion must be the reference's derived motion
  record(fl('probe ship, vacuum burn while tumbling', { symmetric: true, exactInertia: true }, w => {
    const v = spawn(w, stack(['probe_keystone', 'tank_m400', 'eng_sparrow']).craft, 'helion', [2e11, 0, 0], [0, 0, 0]);
    v.ctrl.sas = true; v.ctrl.throttle = 1; w.stage();
    v.w.set(-0.25, 0.15, 0.2);
    return v;
  }), 250);
  // 3. Ember Twin off the pad: boosters on radial clamps, fins, drag, gravity turn by hand
  {
    const f = fl('Ember Twin from the pad', { symmetric: true, comOffset: true }, w => {
      const v = w.launch(emberTwin(), { crew: ['Ada'] });
      v.ctrl.throttle = 1; v.ctrl.sas = true; w.stage();
      return v;
    });
    // near the ground the game halves its step (TUNING.CONTACT_DT): step the world at that size there, so that
    // one world step is one physics step and the ground-contact forces of lift-off are judged too
    record(f, 400 * long, null, TUNING.CONTACT_DT);
    record(f, 1000 * long, i => { if (i === 300) f.vessel.ctrl.pitch = 0.3; if (i === 360) f.vessel.ctrl.pitch = 0; });
  }
  // 4. broadside to the air at 10 km and tumbling: big lateral drag on every part, no thrust
  record(fl('pod ship broadside at 300 m/s, 10 km over the pole, tumbling', { symmetric: true, comOffset: true }, w => {
    const b = sys.byId.verda;
    const v = spawn(w, simpleShip(), 'verda', [0, b.radius + 10000, 0], [300, 0, 40]);
    v.ctrl.sas = false; v.ctrl.throttle = 0;
    v.w.set(0.4, 0.3, 0.6);
    return v;
  }), 300);
  // 5. a lopsided craft under thrust in thin air: products of inertia the game's diagonal inertia does not have
  record(fl('lopsided craft (one booster, one fin) burning at 20 km', { symmetric: false }, w => {
    const b = sys.byId.verda;
    const v = spawn(w, lopsided(), 'verda', [0, b.radius + 20000, 0], [0, 250, 0]);
    v.ctrl.sas = true; v.ctrl.throttle = 1; w.stage();
    return v;
  }), 300);
  // 6. Ember Twin with a brace strut over each booster clamp, off the pad
  {
    const f = fl('strutted Ember Twin from the pad', { symmetric: true, comOffset: true, braced: 4 }, w => {
      const v = w.launch(struttedEmber().craft, { crew: ['Ada'] });
      v.ctrl.throttle = 1; v.ctrl.sas = true; w.stage();
      return v;
    });
    record(f, 400 * long, null, TUNING.CONTACT_DT);
    record(f, 500 * long, i => { if (i === 200) f.vessel.ctrl.yaw = 0.4; if (i === 260) f.vessel.ctrl.yaw = 0; });
  }
  return FLIGHTS;
}

// ------------------------------------------------------------------------------------------ 7d closure
function closure(S, full) {
  for (const f of flights(full)) {
    const n = f.recs.length;
    S.ok(`${f.name}: steps recorded with a valid structure (${n}, ${f.skipped} skipped while pinned to the pad; ${(f.world.ut).toFixed(1)} s of flight)`, n >= 200 && f.events.length === 0, `${f.vessel.parts.size} parts, ${f.recs[0] ? f.recs[0].snap.joints.length : 0} joints`);
    if (!n) continue;
    let wF = 0, wT = 0, wM = 0, wFself = 0, wfMid = 0, wfStart = 0, wAl = 0, wW = 0, pkF = 0, pkT = 0, wC = 0, wSnapM = 0, wI = 0;
    for (const r of f.recs) {
      const s = r.snap, b = s.bodies;
      const F = sumF(b), T = sumT(b);
      const Fs = Math.max(norm(F), r.pre.m * 1e-3);
      pkF = Math.max(pkF, norm(F)); pkT = Math.max(pkT, norm(T));
      // forces: what the parts were given must be what moved the vessel (mass at mid-step, as the integrator has it)
      wF = Math.max(wF, (norm(sub(F, scale(r.fObs, r.mMid))) - r.fNoise) / Fs);
      // torques: Euler's equations with the vessel's inertia, on the observed change of spin
      const I = r.pre.I, w0 = r.pre.w;
      const want = add([I[0] * r.alphaObs[0], I[1] * r.alphaObs[1], I[2] * r.alphaObs[2]], cross(w0, [I[0] * w0[0], I[1] * w0[1], I[2] * w0[2]]));
      const Ts = Math.max(norm(T), norm(want), 1);
      wT = Math.max(wT, (norm(sub(T, want)) - 64 * EPS * (norm(w0) + 1e-3) / r.dt * Math.max(...I)) / Ts);
      // the motion the solve was given
      wW = Math.max(wW, norm(sub(s.motion.w, r.pre.w)));
      wAl = Math.max(wAl, (norm(sub(s.motion.alpha, r.alphaObs)) - 64 * EPS * (norm(w0) + 1e-3) / r.dt) / Math.max(norm(r.alphaObs), 1e-6));
      const fS = Math.max(norm(r.fObs), 1e-3);
      wfMid = Math.max(wfMid, norm(sub(s.motion.f, r.fObs)) / fS);
      wfStart = Math.max(wfStart, (norm(sub(scale(s.motion.f, r.pre.m), F)) - 0) / Fs);
      wFself = Math.max(wFself, Math.abs(r.pre.m - r.mMid) / r.pre.m);
      // bodies: masses and mass centre as solved
      const asm = RS.assembly(r.solved.bodies);
      wM = Math.max(wM, Math.abs(asm.m - r.pre.m) / r.pre.m);
      wC = Math.max(wC, norm(asm.c));
      for (const bd of b) wSnapM = Math.max(wSnapM, Math.abs(bd.m - r.pre.pm.get(bd.id)) / r.pre.m);
      for (let k = 0; k < 3; k++) wI = Math.max(wI, Math.abs(asm.I[k][k] - I[k]) / I[k]);
    }
    S.info(`  ${f.name}: peak total force / torque on the vessel`, `${pkF.toFixed(0)} N / ${pkT.toFixed(0)} N m`);
    S.check(`  ${f.name}: sum of part forces = mass x (dv/dt - gravity), body axes (worst step)`, 0, Math.max(wF, 0), 1e-9, { unit: 'of the force', note: 'beyond the roundoff of the velocity difference' });
    S.check(`  ${f.name}: sum of part torques = I dw/dt + w x (I w) with the vessel's inertia (worst step)`, 0, Math.max(wT, 0), 1e-9, { unit: 'of the torque' });
    S.check(`  ${f.name}: motion.w = the spin at the start of the step`, 0, wW, 1e-14, { unit: 'rad/s' });
    S.check(`  ${f.name}: motion.alpha = observed dw/dt`, 0, Math.max(wAl, 0), 1e-9, { unit: 'rel' });
    S.check(`  ${f.name}: motion.f x mass = sum of part forces (the contract's f)`, 0, wfStart, 1e-12, { unit: 'of the force' });
    S.check(`  ${f.name}: motion.f = observed specific force, within the propellant burnt in half a step`, 0, wfMid, wFself * 1.001 + 1e-9, { unit: 'rel', note: `the solve divides by the start-of-step mass, the integrator by the mid-step mass: ${wFself.toExponential(2)}` });
    S.check(`  ${f.name}: snapshot().bodies masses add up to the vessel's mass before the step`, 0, wM, 1e-13, { unit: 'rel' });
    S.check(`  ${f.name}: every snapshot body mass = that part's mass before the step (public field)`, 0, wSnapM, 1e-13, { unit: 'rel' });
    S.check(`  ${f.name}: snapshot mass points have their centre at the origin`, 0, wC, 1e-9, { unit: 'm' });
    if (!f.offset) S.check(`  ${f.name}: vessel.inertia = diagonal of the inertia of the snapshot's bodies (mass points + own inertia)`, 0, wI, 1e-9, { unit: 'rel', note: 'no part with an offset mass centre on this craft' });
    else S.info(`  ${f.name}: vessel.inertia vs the inertia of its mass points`, 'see 7k', '', `known defect: ${f.offsetParts.join(', ')} carry their mass off-centre`);
  }
}

// ------------------------------------------------------------------------------------------ 7e live loads vs reference
function liveLoads(S, full) { for (const f of flights(full)) liveLoadsOf(S, f); }
function liveLoadsOf(S, f) {
  {
    if (!f.recs.length) { S.ok(`${f.name}: steps to compare`, false); f.stats = { wAlpha: NaN, wRes: NaN, pkRes: NaN, pk: NaN, wResGame: NaN }; return; }
    let nBraced = 0, wPre = 0, wPure = 0, wUtil = 0, wRes = 0, wResGame = 0, wAlpha = 0, wf = 0, pk = 0, pkU = 0, pkRes = 0, modeBad = 0, wComp = 0;
    for (const r of f.recs) {
      const s = r.snap, live = s.loads;
      const sc = Math.max(maxLoad(live), 1e-3 * r.pre.m);
      pk = Math.max(pk, maxLoad(live));
      // (b) reference, prescribed motion
      const p = RS.multibodyPrescribed(r.solved.bodies, r.solved.joints, r.solved.motion);
      wPre = Math.max(wPre, loadDiff(live, p.loads, sc));
      // the game's own pure solver on its own snapshot
      wPure = Math.max(wPure, loadDiff(live, solveJointLoads(r.solved.bodies, r.solved.joints, r.solved.motion), sc));
      // residual: what Newton does not close by at the root. Reference: wrench at the root's mass centre; the game
      // reports the moment about the vessel's mass centre
      const rootR = r.solved.bodies[p.root].r;
      const resM = norm(add(p.residual.M, cross(rootR, p.residual.F)));
      wRes = Math.max(wRes, norm(p.residual.F) / sc, resM / sc);
      pkRes = Math.max(pkRes, resM);
      wResGame = Math.max(wResGame, Math.abs(s.residual.F - norm(p.residual.F)) / sc, Math.abs(s.residual.M - resM) / sc);
      // components and utilisation from the ring quadrature, with the joint's own radius and allowables
      s.joints.forEach((j, i) => {
        const q = RS.ringUtilisation(p.loads[i].F, p.loads[i].M, j.n, j.r, j.capT, j.capC, j.capS, RING_LIVE);
        const l = live[i];
        wComp = Math.max(wComp, Math.abs(l.axial - q.N) / sc, Math.abs(l.shear - q.V) / sc, Math.abs(l.bending - q.Mb) / sc, Math.abs(l.torsion - q.Mt) / sc);
        // brace struts (docs/STRUCTURE.md): forces are shared by relF, moments by relB, and only the utilisation sees it
        const braced = j.relB !== 1 || j.relF !== 1;
        const qb = braced ? RS.ringUtilisation(scale(p.loads[i].F, j.relF), scale(p.loads[i].M, j.relB), j.n, j.r, j.capT, j.capC, j.capS, RING_LIVE) : q;
        if (braced) nBraced++;
        wUtil = Math.max(wUtil, Math.abs(l.util - qb.util));
        if (qb.margin > 1e-6 && l.mode !== qb.mode) modeBad++;
        pkU = Math.max(pkU, l.util);
      });
      // the motion itself, derived by the reference from the forces (full inertia tensor)
      const d = RS.multibodyDynamic(r.solved.bodies, r.solved.joints, r.solved.motion.w);
      wAlpha = Math.max(wAlpha, norm(sub(d.alpha, s.motion.alpha)) / Math.max(norm(d.alpha), 1e-6));
      wf = Math.max(wf, norm(sub(d.f, s.motion.f)) / Math.max(norm(d.f), 1e-6));
    }
    S.info(`  ${f.name}: peak joint load / peak utilisation`, `${pk.toFixed(0)} N or N m / ${pkU.toFixed(4)}`);
    S.check(`${f.name}: live joint loads vs multibody reference fed with snapshot() as returned (worst joint, worst step of ${f.recs.length})`, 0, wPre, 1e-10, { unit: 'of the largest load' });
    S.check(`  ${f.name}: live solver = the pure solveJointLoads on the same data`, 0, wPure, 1e-11, { unit: 'of the largest load' });
    S.check(`  ${f.name}: axial, shear, bending, torsion of every joint vs ring integrals of the reference load`, 0, wComp, 1e-9, { unit: 'of the largest load' });
    S.check(`  ${f.name}: utilisation of every joint vs ring quadrature of the reference load`, 0, wUtil, 1e-8, { unit: '' });
    S.check(`  ${f.name}: governing mode of every joint`, 0, modeBad, 0, { unit: 'wrong' });
    if (f.braced) S.ok(`  ${f.name}: braced joints were judged (forces x relF, moments x relB before the ring)`, nBraced === f.braced * f.recs.length, `${nBraced / f.recs.length} braced joints per step`);
    else S.ok(`  ${f.name}: no joint is braced`, nBraced === 0);
    S.check(`  ${f.name}: the residual the game reports = the reference's residual wrench on the root`, 0, wResGame, 1e-9, { unit: 'of the largest load' });
    S.check(`  ${f.name}: specific force derived by the reference vs motion.f`, 0, wf, 1e-10, { unit: 'rel' });
    f.stats = { wAlpha, wRes, pkRes, pk, wResGame };
    if (f.symmetric && f.offset) {
      // Known defect (7k): vessel.inertia is taken about the parts' geometric centres. Sized and pinned there.
      S.info(`  ${f.name}: derived angular acceleration and root residual`, 'see 7k', '', 'known defect: vessel.inertia is not the inertia of the mass points on this craft');
    } else if (f.symmetric) {
      // Symmetric craft, every mass at its part's centre: the diagonal inertia is the whole inertia, so the motion the
      // game flies must be the motion Newton-Euler gives for these bodies, and the root needs no residual.
      S.check(`  ${f.name}: angular acceleration derived by the reference (full tensor) vs the game's`, 0, wAlpha, 1e-9, { unit: 'rel', note: f.comOffset ? 'craft with an offset mass centre in its capsule' : '' });
      S.check(`  ${f.name}: residual wrench on the root (Newton closes)`, 0, wRes, 1e-9, { unit: 'of the largest load', note: `peak residual moment ${pkRes.toFixed(1)} N m` });
    } else {
      // Asymmetric craft: the game flies with a diagonal inertia (a stated model limit), so its alpha is not the
      // full-tensor alpha and the difference appears as a residual on the root. Reported, never failed.
      S.info(`  ${f.name}: angular acceleration, game (diagonal inertia) vs reference (full tensor)`, wAlpha, 'rel', 'model limit: products of inertia are dropped by the flight model');
      S.info(`  ${f.name}: residual wrench on the root`, wRes, 'of the largest load', `peak residual moment ${pkRes.toFixed(1)} N m`);
    }
  }
}

// ------------------------------------------------------------------------------------------ 7f hand numbers
const jointOf = (v, idA, idB) => v.structure.joints.find(j => (j.a.id === idA && j.b.id === idB) || (j.a.id === idB && j.b.id === idA));
const dryKg = type => PARTS[type].mass * 1000;
const wetKg = type => { const d = PARTS[type]; let m = d.mass * 1000; for (const k in d.res || {}) if (k !== 'elec') m += d.res[k]; return m; };

function handNumbers(S) {
  // --- (1) a stack burning in vacuum: compression = thrust x mass above the joint / total mass
  {
    const w = new World();
    const v = spawn(w, simpleShip(), 'helion', [2e11, 0, 0], [0, 0, 0]);      // pod 1, tank 2, engine 3 (top to bottom)
    v.ctrl.sas = true; v.ctrl.throttle = 1; w.stage();
    const T = PARTS.eng_sparrow.engine.thrust * 1000;
    const mPod = wetKg('pod_acorn'), mEng = dryKg('eng_sparrow');
    S.info('pod + M-400 tank + Sparrow in vacuum, from the catalog: thrust', T, 'N', `pod ${mPod} kg, tank ${wetKg('tank_m400')} kg full, engine ${mEng} kg`);
    let w1 = 0, w2 = 0, wOther = 0, last = null, n = 0;
    for (let i = 0; i < 150; i++) {
      const m = v.mass;                               // public field, before the step
      w.step(DT);
      if (!v.structure.valid) continue;
      const j1 = jointOf(v, 1, 2), j2 = jointOf(v, 2, 3);
      w1 = Math.max(w1, Math.abs(j1.axial - (-T * mPod / m)) / (T * mPod / m));
      w2 = Math.max(w2, Math.abs(j2.axial - (-T * (m - mEng) / m)) / T);
      wOther = Math.max(wOther, j1.shear, j1.bending, j1.torsion, j2.shear, j2.bending, j2.torsion);
      last = { m, a1: j1.axial, a2: j2.axial, u2: j2.util, r: j2.r, capC: j2.capC }; n++;
    }
    S.ok('vacuum burn: 150 steps solved', n === 150);
    S.check('vacuum burn: compression under the pod = thrust x pod mass / total mass (worst of 150 steps)', 0, w1, 1e-9, { unit: 'rel', note: last ? `${last.a1.toFixed(2)} N at ${last.m.toFixed(1)} kg` : '' });
    S.check('vacuum burn: compression above the engine = thrust x (total - engine) / total', 0, w2, 1e-9, { unit: 'rel', note: last ? `${last.a2.toFixed(2)} N` : '' });
    S.check('vacuum burn, pointing steady: shear, bending, torsion', 0, wOther, 1e-6 * T, { unit: 'N, N m' });
    if (last) S.check('vacuum burn: utilisation of the engine joint = compression / (2 pi r) / allowable, r = 0.625 m, plain joint', -last.a2 / (2 * Math.PI * 0.625) / STRUCT.LINE_C, last.u2, 1e-9, { rel: true, note: `ring radius ${last.r} m, allowable ${last.capC} N/m` });
  }
  // --- (2) spinning in free fall: tension = w^2 x mass moment beyond the joint
  {
    const w = new World();
    const { craft, parts } = stack(['probe_keystone', 'tank_m400', 'tank_m200', 'eng_sparrow']);
    const v = spawn(w, craft, 'helion', [2e11, 0, 0], [0, 0, 0]);
    v.ctrl.sas = false; v.ctrl.throttle = 0;
    const spin = 0.8;
    v.w.set(spin, 0, 0);
    const types = ['probe_keystone', 'tank_m400', 'tank_m200', 'eng_sparrow'];
    const mass = types.map(wetKg), y = parts.map(p => p.pos.y);
    const M = mass.reduce((a, b) => a + b, 0), yc = mass.reduce((s, m, i) => s + m * y[i], 0) / M;
    S.check('spinning stack: total mass from the catalog = vessel.mass', M, v.mass, 1e-9, { rel: true, unit: 'kg' });
    let worst = 0, other = 0, wSpin = 0;
    const want = [1, 2, 3].map(k => { let s = 0; for (let i = k; i < 4; i++) s += mass[i] * (yc - y[i]); return spin * spin * s; });
    for (let i = 0; i < 100; i++) {
      w.step(DT);
      wSpin = Math.max(wSpin, Math.abs(v.w.x - spin) + Math.abs(v.w.y) + Math.abs(v.w.z));
      for (let k = 1; k <= 3; k++) {
        const j = jointOf(v, parts[k - 1].id, parts[k].id);
        worst = Math.max(worst, Math.abs(j.axial - want[k - 1]) / Math.max(...want));
        other = Math.max(other, j.shear, j.bending, j.torsion);
      }
    }
    S.check('spinning stack (0.8 rad/s end over end, free fall): spin stays', 0, wSpin, 1e-12, { unit: 'rad/s' });
    S.check('spinning stack: tension at each of the 3 joints = w^2 x sum of m (y_cm - y) below the joint (worst, 100 steps)', 0, worst, 1e-10, { unit: 'rel', note: `hand: ${want.map(x => x.toFixed(1)).join(', ')} N` });
    S.ok('spinning stack: every joint is in tension', want.every(x => x > 0) && [1, 2, 3].every(k => jointOf(v, parts[k - 1].id, parts[k].id).mode === 'tension'));
    S.check('spinning stack: shear, bending, torsion', 0, other, 1e-9 * Math.max(...want), { unit: 'N, N m' });
  }
  // --- (3) coasting in vacuum, engine off, no spin: nothing is loaded
  {
    const w = new World();
    const b = sys.byId.verda, r0 = b.radius + 200000;
    const v = spawn(w, emberTwin(), 'verda', [r0, 0, 0], [0, 0, Math.sqrt(b.gm / r0) * -1]);
    v.ctrl.sas = false; v.ctrl.throttle = 0;
    let worst = 0, util = 0, valid = 0;
    for (let i = 0; i < 100; i++) {
      w.step(DT);
      if (v.structure.valid) valid++;
      for (const j of v.structure.joints) { worst = Math.max(worst, Math.abs(j.axial), j.shear, j.bending, j.torsion); util = Math.max(util, j.util); }
    }
    S.ok('Ember Twin coasting in a 200 km orbit: structure solved every step', valid === 100, `${v.structure.joints.length} joints`);
    S.check('coasting in orbit, no thrust, no spin: largest load in any joint', 0, worst, 1e-9 * v.mass, { unit: 'N, N m', note: 'gravity loads no joint (its gradient across the vessel is ignored)' });
    S.check('coasting in orbit: largest utilisation', 0, util, 1e-12, {});
  }
  // --- (4) drag: the axial load at a joint is (drag on what is ahead of it) - (mass ahead) x (specific force)
  for (const dir of [1, -1]) {
    const w = new World();
    const b = sys.byId.verda, alt0 = 4000;
    const v = spawn(w, simpleShip(), 'verda', [0, b.radius + alt0, 0], [0, 200 * dir, 0]);     // over the pole: the air stands still
    v.ctrl.sas = true; v.ctrl.throttle = dir > 0 ? 1 : 0;
    if (dir > 0) w.stage();
    const cap = PARTS.pod_acorn, area = Math.PI * cap.rBottom * cap.rBottom * cap.drag.top;
    const mPod = wetKg('pod_acorn');
    const label = dir > 0 ? 'climbing nose first at 200 m/s, 4 km, engine on' : 'falling tail first at 200 m/s, 4 km, engine off';
    let w1 = 0, w2 = 0, wDrag = 0, n = 0, seen = null, burn = 0, dragTol = 0;
    for (let i = 0; i < 100; i++) {
      const pos = A(v.pos), vel = A(v.vel), m0 = v.mass, q0 = [v.q.x, v.q.y, v.q.z, v.q.w];
      const mTank = v.parts.get(2).mass;
      w.step(DT);
      if (!v.structure.valid || w.substeps !== 1) continue;
      const alt = norm(pos) - b.radius, speed = norm(vel);
      const rho = b.atmo.rho0 * Math.exp(-alt / b.atmo.scale);
      // drag on the capsule, from the part data: its whole frontal area x the coefficient of its top face;
      // falling tail first it sits in the wake and feels the base-drag fraction of that (TUNING.BASE_DRAG, data)
      const dPod = -dir * 0.5 * rho * speed * speed * area * (dir > 0 ? 1 : TUNING.BASE_DRAG);
      // the game's own deceleration: velocity change over the step less gravity, along the nose
      const g = scale(add(grav(b.gm, pos), grav(b.gm, A(v.pos))), 0.5);
      const fy = toBody(q0, sub(scale(sub(A(v.vel), vel), 1 / DT), g))[1];
      const j1 = jointOf(v, 1, 2), j2 = jointOf(v, 2, 3);
      const want1 = dPod - mPod * fy, want2 = dPod - (mPod + mTank) * fy;
      const sc = Math.max(Math.abs(want1), Math.abs(want2), 1);
      w1 = Math.max(w1, Math.abs(j1.axial - want1) / sc);
      w2 = Math.max(w2, Math.abs(j2.axial - want2) / sc);
      // and the load really changed by the drag: without the drag term it is off by exactly that
      wDrag = Math.max(wDrag, Math.abs((j1.axial + mPod * fy) - dPod) / Math.abs(dPod));
      if (!seen) seen = { dPod, fy, a1: j1.axial, a2: j2.axial, thrust: v.thrust, m0 };
      burn = Math.max(burn, (m0 - v.mass) / (2 * m0));
      dragTol = Math.max(dragTol, (m0 - v.mass) / (2 * m0) * Math.abs(mPod * fy / dPod));
      n++;
    }
    S.ok(`${label}: steps solved`, n >= 90, seen ? `capsule drag ${seen.dPod.toFixed(1)} N, specific force ${seen.fy.toFixed(3)} m/s2, thrust ${seen.thrust.toFixed(0)} N, joints ${seen.a1.toFixed(1)} / ${seen.a2.toFixed(1)} N` : '');
    S.check(`${label}: axial load under the pod = pod drag - pod mass x specific force`, 0, w1, burn * 1.02 + 1e-9, { unit: 'rel', note: `tolerance = propellant burnt in half a step / mass (${burn.toExponential(2)}): the loads are solved with the start-of-step mass, the vessel accelerates with the mid-step mass` });
    S.check(`${label}: axial load above the engine = pod drag - (pod + tank) mass x specific force`, 0, w2, burn * 1.02 + 1e-9, { unit: 'rel', note: 'the tank is covered at both ends: no axial drag of its own' });
    S.check(`${label}: (axial load + pod mass x specific force) = 1/2 rho v^2 Cd A of the capsule`, 0, wDrag, dragTol * 1.02 + 1e-9, { unit: 'rel', note: 'tolerance = the same half-step propellant fraction of (pod mass x specific force), as a fraction of the drag' });
  }
}

// ------------------------------------------------------------------------------------------ joint geometry
/** Rings, axes, strengths and the tree of a stock craft, against the part catalog and the rules of the contract. */
function geometry(S) {
  for (const name of ['Ember Twin', 'Pell Runner']) {
    const w = new World();
    const b = sys.byId.verda;
    const v = spawn(w, stockCrafts().find(c => c.name === name), 'verda', [b.radius + 200000, 0, 0], [0, 0, 2000]);
    w.step(DT);
    const st = v.structure;
    // depth of every part from the control part, by its links (public data)
    const depth = new Map([[v.controlId, 0]]);
    for (const queue = [v.controlId]; queue.length;) { const id = queue.shift(); for (const k of v.parts.get(id).links) if (!depth.has(k)) { depth.set(k, depth.get(id) + 1); queue.push(k); } }
    S.check(`${name}: one joint per link (a tree over all ${v.parts.size} parts)`, v.parts.size - 1, st.joints.length, 0, { unit: 'joints' });
    S.ok(`${name}: the tree is rooted at the control part (side a of every joint is the nearer one)`, st.joints.every(j => depth.get(j.a.id) + 1 === depth.get(j.b.id)));
    const face = (p, top) => (top ? p.def.rTop : p.def.rBottom) ?? p.def.r;
    let wR = 0, wP = 0, wN = 0, wCap = 0, nStack = 0, nTruss = 0, nSide = 0, wRs = 0, wUnit = 0, sideCaps = new Set();
    for (const j of st.joints) {
      wUnit = Math.max(wUnit, Math.abs(Math.hypot(j.nx, j.ny, j.nz) - 1));
      if (j.kind === 'stack' || j.kind === 'dock') {
        const up = j.b.pos.y > j.a.pos.y;               // b above a
        const lo = up ? j.a : j.b, hi = up ? j.b : j.a;
        const flipped = j.a.flip || j.b.flip;
        if (flipped) continue;
        // axis from the root side to the far side; point midway between the two faces that meet
        wN = Math.max(wN, Math.abs(j.nx) + Math.abs(j.nz) + Math.abs(j.ny - (up ? 1 : -1)));
        wP = Math.max(wP, Math.abs(j.py - (lo.pos.y + lo.def.h / 2 + hi.pos.y - hi.def.h / 2) / 2) + Math.abs(j.px - j.b.pos.x) + Math.abs(j.pz - j.b.pos.z));
        if (j.a.truss || j.b.truss) { nTruss++; continue; }
        nStack++;
        wR = Math.max(wR, Math.abs(j.r - Math.max(STRUCT.MIN_R, Math.min(face(lo, true), face(hi, false)))));
        const fac = Math.min(...[j.a, j.b].map(p => STRUCT.FACTOR[p.def.shape] ?? 1));
        if (j.kind === 'stack') wCap = Math.max(wCap, Math.abs(j.capT - STRUCT.LINE_T * fac) / STRUCT.LINE_T, Math.abs(j.capC - STRUCT.LINE_C * fac) / STRUCT.LINE_C, Math.abs(j.capS - STRUCT.LINE_S * fac) / STRUCT.LINE_S);
      } else {
        nSide++;
        // the mounted part is the one that is not a stack part (for a booster on a clamp: the clamp)
        const m = j.a.def.attach.stack ? j.b : j.a;
        wRs = Math.max(wRs, Math.abs(j.r - Math.max(STRUCT.MIN_R, (m.def.h + m.def.t) / Math.PI)));
        wN = Math.max(wN, Math.abs(j.ny));
        sideCaps.add(`${m.def.shape} x${(j.capT / STRUCT.LINE_T).toFixed(2)}`);
      }
    }
    S.check(`${name}: joint axes are unit vectors`, 0, wUnit, 1e-12, {});
    S.check(`${name}: ${nStack} plain stack joints: ring radius = the smaller of the two faces that meet (catalog)`, 0, wR, 1e-12, { unit: 'm' });
    S.check(`${name}: stack joints: point midway between the faces, axis from the root side to the far side`, 0, Math.max(wP, wN), 1e-9, { unit: 'm' });
    S.check(`${name}: stack joints: allowables = STRUCT.LINE_T/C/S x the weaker part's STRUCT.FACTOR`, 0, wCap, 1e-12, { unit: 'rel' });
    S.check(`${name}: ${nSide} side mounts: ring radius = (h + t) / pi of the mounted part`, 0, wRs, 1e-12, { unit: 'm' });
    S.info(`${name}: joints on an interstage truss (ring widened to the truss; not in the contract)`, nTruss);
    S.info(`${name}: strength of side mounts relative to a plain joint`, `${sideCaps.size} kinds`, '', `${[...sideCaps].join(', ')}; the contract text calls radial mounts weaker than a tank-to-tank joint`);
  }
}

// ------------------------------------------------------------------------------------------ 7h failure
const jointKey = (a, b) => [a, b].map(x => (x && typeof x === 'object' ? x.id : x)).sort((p, q) => p - q).join('-');

/**
 * Fly the same craft in two identical worlds. In the SHADOW world joints are not allowed to break
 * (TUNING.STRUCT_FAIL = false: "loads are still worked out"), so the loads of every step can be read, the step of
 * the break included; in the REAL world they are. From the shadow's bodies and motion the reference works out the
 * loads, the ring utilisation and, with the damage rule of docs/STRUCTURE.md integrated here, which joint gives way
 * at which step. The real world then has to break there.
 */
function flyToFailure(make, maxSteps) {
  const was = TUNING.STRUCT_FAIL;
  try {
    TUNING.STRUCT_FAIL = false; const sh = make();
    TUNING.STRUCT_FAIL = true; const re = make();
    const events = [], decouples = [];
    re.w.on('structure', d => events.push(d));
    re.w.on('decouple', d => decouples.push(d));
    const partsBefore = re.v.parts.size;
    const damage = new Map();
    let predicted = null, peak = 0, peakKey = null, steps = 0, wDamage = 0, wSync = 0, breakStep = 0, firstOver = 0;
    for (let i = 1; i <= maxSteps && !events.length && !predicted && !re.v.dead; i++) {
      steps = i;
      TUNING.STRUCT_FAIL = false;
      const r = stepOnce(sh.w, sh.v);
      TUNING.STRUCT_FAIL = true;
      re.w.step(DT);
      if (events.length) breakStep = i;
      if (!r.ok) continue;
      if (!events.length) wSync = Math.max(wSync, norm(sub(A(re.v.vel), A(sh.v.vel))) + norm(sub(A(re.v.w), A(sh.v.w))));
      const p = RS.multibodyPrescribed(r.solved.bodies, r.solved.joints, r.solved.motion);
      let top = 0, topKey = null;
      r.solved.joints.forEach((j, k) => {
        const u = RS.ringUtilisation(p.loads[k].F, p.loads[k].M, j.n, j.r, j.capT, j.capC, j.capS, RING_LIVE);
        const key = jointKey(j.a, j.b);
        if (u.util > top) { top = u.util; topKey = key; }
        let d = damage.get(key) || 0;
        if (u.util > 1) d += (u.util - 1) * r.dt / STRUCT.FAIL_TIME; else if (d > 0) d = Math.max(0, d - r.dt / STRUCT.HEAL_TIME);
        damage.set(key, d);
        // the game's own damage counter in the shadow world follows the same rule (it just never acts on it)
        wDamage = Math.max(wDamage, Math.abs(r.snap.loads[k].damage - d));
        if (d >= 1 && !predicted) predicted = { key, step: i, util: u.util, mode: u.mode, kind: j.kind, top: null };
      });
      if (top > 1 && !firstOver) firstOver = i;
      if (top > peak) { peak = top; peakKey = topKey; }
      if (predicted) predicted.top = topKey;
    }
    return { events, decouples, predicted, peak, peakKey, steps, breakStep, wDamage, wSync, firstOver, partsBefore, partsAfter: re.v.parts.size, v: re.v, shadow: sh.v };
  } finally { TUNING.STRUCT_FAIL = was; }
}

const NECK = ['pod_homestead', 'sci_lab', 'sci_lab', 'sci_lab', 'sep_s', 'tank_l800', 'eng_roc'];
const NOODLE = ['probe_wisp', 'tank_s200', 'tank_s200', 'girder_long', 'tank_s200', 'tank_s200', 'girder_long', 'tank_s200', 'tank_s200', 'eng_wren'];

function judgeFailure(S, name, r, { modes, joints = null, limit }) {
  const e = r.events[0];
  S.ok(`${name}: the reference predicts a break`, !!r.predicted, r.predicted ? `joint ${r.predicted.key} (${r.predicted.kind}) at step ${r.predicted.step}, ${r.predicted.mode}, utilisation ${r.predicted.util.toFixed(3)}; first over the limit at step ${r.firstOver}` : `peak utilisation ${r.peak.toFixed(3)} at joint ${r.peakKey} in ${limit}`);
  S.ok(`${name}: the game raises a \`structure\` event`, !!e, e ? `joint ${jointKey(e.joint.a, e.joint.b)} (${e.joint.kind}: ${e.joint.aName} / ${e.joint.bName}), mode ${e.mode}, utilisation ${Number(e.util).toFixed(3)}, step ${r.breakStep}` : `none in ${limit}`);
  S.info(`${name}: peak utilisation seen by the reference`, r.peak, '', `joint ${r.peakKey}`);
  if (!e || !r.predicted) return;
  const got = jointKey(e.joint.a, e.joint.b);
  S.ok(`${name}: it breaks at the joint the reference says, which is the most loaded one`, got === r.predicted.key && r.predicted.key === r.predicted.top, `game ${got}, reference ${r.predicted.key}, most loaded at that step ${r.predicted.top}`);
  if (joints) S.ok(`${name}: that joint is ${joints.what}`, joints.keys.includes(got), got);
  S.check(`${name}: step of the break vs the damage rule integrated on reference loads`, r.predicted.step, r.breakStep, 0, { unit: 'steps', note: `${(r.breakStep * DT).toFixed(2)} s; over the limit since step ${r.firstOver}` });
  S.check(`${name}: utilisation reported with the event vs reference`, r.predicted.util, Number(e.util), 1e-8, { rel: true });
  S.ok(`${name}: mode reported with the event`, e.mode === r.predicted.mode && modes.includes(e.mode), `game ${e.mode}, reference ${r.predicted.mode}`);
  S.check(`${name}: the game's damage counter vs (u - 1) / FAIL_TIME, healing at 1 / HEAL_TIME, on reference utilisation (worst joint, worst step)`, 0, r.wDamage, 1e-9, {});
  S.check(`${name}: the two worlds flew identically until the break`, 0, r.wSync, 0, { unit: 'm/s + rad/s' });
  S.ok(`${name}: the vessel came apart there (a \`decouple\` with part: null)`, r.decouples.some(d => d.part === null) && r.partsAfter < r.partsBefore, `${r.partsAfter} of ${r.partsBefore} parts stay with the vessel`);
  S.ok(`${name}: the event names the piece that left`, !!e.debris && e.vessel === r.v && (e.debris.parts.has(e.joint.a) !== e.debris.parts.has(e.joint.b)), '');
}

function failure(S) {
  // --- (1) 19 t of cabin and labs on a 0.3 m blast ring, on an engine far too strong for it, in vacuum
  {
    const T = PARTS.eng_roc.engine.thrust * 1000;
    const mAbove = wetKg('pod_homestead') + 3 * wetKg('sci_lab'), mAll = NECK.reduce((s2, t) => s2 + wetKg(t), 0);
    const rRing = PARTS.sep_s.r;
    const hand = T * (mAbove + wetKg('sep_s')) / mAll / (2 * Math.PI * rRing) / (STRUCT.LINE_C * STRUCT.FACTOR.decoupler);
    S.info('weak neck, by hand at ignition: thrust x mass above the ring / total / (2 pi r) / allowable', hand, '', `thrust ${T / 1000} kN, ${(mAbove / 1000).toFixed(2)} t above, ${(mAll / 1000).toFixed(2)} t in all, ring ${rRing} m, allowable ${STRUCT.LINE_C} x ${STRUCT.FACTOR.decoupler} N/m; it grows as the tank drains`);
    let ids = null;
    const r = flyToFailure(() => {
      const { craft, parts } = stack(NECK, 'Weak neck');
      ids = parts.map(p => p.id);
      const w = new World();
      const v = spawn(w, craft, 'helion', [2e11, 0, 0], [0, 0, 0]);
      v.ctrl.sas = true; v.ctrl.throttle = 1;
      w.stage();                    // lights the engine; no step is taken here, so every loaded step is judged
      return { w, v };
    }, 600);
    S.ok('weak neck: the engine burns at full thrust in the shadow world, stack whole', r.shadow.thrust === T && r.shadow.parts.size === NECK.length, `thrust ${r.shadow.thrust} N`);
    judgeFailure(S, 'weak neck', r, { modes: ['compression'], limit: '12 s', joints: { what: 'one of the two faces of the small ring', keys: [jointKey(ids[3], ids[4]), jointKey(ids[4], ids[5])] } });
    if (r.predicted) S.ok('weak neck: a modest overload took its time (more than 10 steps over the limit before breaking)', r.predicted.step - r.firstOver > 10, `${r.predicted.step - r.firstOver} steps`);
  }
  // --- (2) a long thin stack flying broadside in thick air
  {
    const b = sys.byId.verda, speed = 360, alt = 3000;
    const rho = b.atmo.rho0 * Math.exp(-alt / b.atmo.scale);
    S.info(`noodle (10 parts, 0.3 m wide, ${NOODLE.reduce((s2, t) => s2 + PARTS[t].h, 0).toFixed(1)} m long): dynamic pressure broadside at ${speed} m/s, ${alt / 1000} km`, (0.5 * rho * speed * speed).toFixed(0), 'Pa');
    const r = flyToFailure(() => {
      const w = new World();
      const v = spawn(w, stack(NOODLE, 'Noodle').craft, 'verda', [0, b.radius + alt, 0], [speed, 0, 0]);    // nose up, flying sideways
      v.ctrl.sas = false; v.ctrl.throttle = 0;
      return { w, v };
    }, 500);
    judgeFailure(S, 'noodle', r, { modes: ['tension', 'compression'], limit: '10 s' });
  }
  // --- (3) the same noodle slow enough to stay whole: an overload is needed, not just a load
  {
    const b = sys.byId.verda;
    const r = flyToFailure(() => {
      const w = new World();
      const v = spawn(w, stack(NOODLE, 'Noodle').craft, 'verda', [0, b.radius + 3000, 0], [220, 0, 0]);
      v.ctrl.sas = false; v.ctrl.throttle = 0;
      return { w, v };
    }, 300);
    S.ok('noodle at 220 m/s: neither the reference nor the game breaks it in 6 s', !r.predicted && !r.events.length && r.partsAfter === r.partsBefore, `peak utilisation ${r.peak.toFixed(3)} at joint ${r.peakKey}`);
    S.check('noodle at 220 m/s: the two worlds stayed identical', 0, r.wSync, 0, { unit: 'm/s + rad/s' });
  }
}

// ------------------------------------------------------------------------------------------ 7i stock craft
function flyStock(craft, { maxSim = 1500 } = {}) {
  const w = new World();
  const v = w.launch(craft, { crew: ['Ada', 'Bo', 'Cy'] });
  const events = [], stress = [];
  w.on('structure', d => events.push({ ut: w.ut, joint: jointKey(d.joint.a, d.joint.b), mode: d.mode, util: d.util }));
  w.on('stress', d => { if (d.vessel === w.active) stress.push({ ut: w.ut, util: d.util }); });
  const top = sys.byId.verda.atmo.height;
  const ctl = ascentProgram(w, {});
  let peak = 0, peakAt = 0, peakJoint = '', peakMode = '', maxAlt = 0, maxQ = 0;
  fly(w, ctl, {
    dt: 0.05, physWarp: 0, maxSim,
    until: () => w.active.altitude > top || events.length > 0,
    onStep: () => {
      const a = w.active;
      if (!a) return;
      maxAlt = Math.max(maxAlt, a.altitude); maxQ = Math.max(maxQ, a.dynamicPressure);
      const st = a.structure;
      // `peak` of a joint is the highest utilisation it has seen in any physics step (a world step here is 2.5 of them)
      if (st) for (const j of st.joints) if (j.peak > peak) { peak = j.peak; peakAt = a.altitude; peakJoint = `${j.a.def.id} / ${j.b.def.id}`; peakMode = j.mode; }
    },
  });
  return { events, stress, peak, peakAt, peakJoint, peakMode, maxAlt, maxQ, top, failed: ctl.failed, log: ctl.log, t: w.ut };
}

function stock(S, full) {
  const list = stockCrafts().filter(c => c.site !== 'runway');
  const names = full ? list.map(c => c.name) : ['Ember Twin', 'Colossus'];
  for (const c of list) {
    if (!names.includes(c.name)) continue;
    const dv = c.deltaV();
    const r = flyStock(c);
    const where = `peak at ${(r.peakAt / 1000).toFixed(1)} km in ${r.peakJoint} (${r.peakMode}); max q ${(r.maxQ / 1000).toFixed(1)} kPa`;
    S.info(`${c.name}: peak joint utilisation on the way up`, r.peak, '', where);
    S.ok(`${c.name}: no joint breaks under the ascent autopilot`, r.events.length === 0, r.events.length ? `broke joint ${r.events[0].joint} (${r.events[0].mode}, utilisation ${Number(r.events[0].util).toFixed(2)}) at t = ${r.events[0].ut.toFixed(1)} s` : `${r.t.toFixed(0)} s of flight`);
    S.ok(`${c.name}: peak utilisation stays under 1`, r.peak < 1, `${r.peak.toFixed(3)}`);
    // a craft that cannot reach space at all is no structural matter: only the ones with the delta-v are asked to
    const canReach = (typeof dv === 'number' ? dv : dv && (dv.total ?? dv.vac ?? 0)) > 2500;
    if (canReach) S.ok(`${c.name}: reaches space (${(r.top / 1000).toFixed(0)} km)`, r.maxAlt > r.top, `top of flight ${(r.maxAlt / 1000).toFixed(1)} km`);
    else S.info(`${c.name}: top of the recorded flight`, (r.maxAlt / 1000).toFixed(1), 'km', 'not built to reach space on the ascent program');
    if (r.stress.length) S.info(`${c.name}: stress warnings`, r.stress.length, '', `first at t = ${r.stress[0].ut.toFixed(1)} s, utilisation ${Number(r.stress[0].util).toFixed(2)}`);
  }
}

// ------------------------------------------------------------------------------------------ 7j struts, rest, assembly building
function extras(S) {
  // --- (1) brace struts: which joints are relieved, and by how much (docs/STRUCTURE.md "Brace struts")
  {
    const { craft, clamps, struts } = struttedEmber();
    const w = new World();
    const b = sys.byId.verda;
    const v = spawn(w, craft, 'verda', [b.radius + 200000, 0, 0], [0, 0, 2000]);
    w.step(DT);
    const st = v.structure;
    const braced = st.joints.filter(j => j.relB !== 1 || j.relF !== 1);
    // each strut braces its host tank to the booster: the joints between them are tank-clamp and clamp-booster
    const expect = new Set();
    for (const j of st.joints) if (clamps.includes(j.a.id) || clamps.includes(j.b.id)) expect.add(jointKey(j.a, j.b));
    S.check('strutted Ember Twin: braced joints', expect.size, braced.length, 0, { unit: 'joints', note: 'tank-clamp and clamp-booster on each side' });
    S.ok('strutted Ember Twin: the braced joints are exactly the two faces of each clamp', braced.length === 4 && braced.every(j => expect.has(jointKey(j.a, j.b))), braced.map(j => `${j.a.def.id}/${j.b.def.id}`).join(', '));
    let wB = 0, wF = 0, minB = 1, minF = 1;
    for (const j of braced) {
      // the strut on this joint's side: the one mounted at the same angle as the clamp
      const clamp = clamps.includes(j.a.id) ? j.a : j.b;
      const s = struts.map(id => v.parts.get(id)).find(p => Math.abs(Math.cos(p.rot) - Math.cos(clamp.rot)) + Math.abs(Math.sin(p.rot) - Math.sin(clamp.rot)) < 1e-9);
      const half = PARTS.strut.rw / 2;
      const tip = [s.pos.x + Math.cos(s.rot) * half, s.pos.y, s.pos.z - Math.sin(s.rot) * half];       // outward(a) = (cos a, 0, -sin a)
      const arm = Math.max(0.3, norm(sub(tip, [j.px, j.py, j.pz])));
      const capM = j.capT * Math.PI * j.r * j.r, capF = j.capS * Math.PI * j.r;
      wB = Math.max(wB, Math.abs(j.relB - capM / (capM + STRUCT.STRUT_FORCE * arm)));
      wF = Math.max(wF, Math.abs(j.relF - capF / (capF + STRUCT.STRUT_FORCE)));
      minB = Math.min(minB, j.relB); minF = Math.min(minF, j.relF);
    }
    S.check('strutted Ember Twin: bending share relB = capM / (capM + STRUT_FORCE x arm), capM = capT pi r^2, arm = strut tip to joint', 0, wB, 1e-12, { note: `smallest ${minB.toFixed(4)}` });
    S.check('strutted Ember Twin: force share relF = capF / (capF + STRUT_FORCE), capF = capS pi r', 0, wF, 1e-12, { note: `smallest ${minF.toFixed(4)}` });
    // the formula written out on live joints under load, against the game (the flights of 7e do it by quadrature)
    v.ctrl.throttle = 1; v.ctrl.sas = true; v.ctrl.yaw = 0.5; w.stage();
    let wU = 0, raw = 0, n = 0;
    for (let i = 0; i < 100; i++) {
      w.step(DT);
      for (const j of v.structure.joints) {
        if (j.relB === 1 && j.relF === 1) continue;
        const na = j.axial * j.relF / (2 * Math.PI * j.r), nb = j.bending * j.relB / (Math.PI * j.r * j.r);
        const q = j.shear * j.relF / (Math.PI * j.r) + j.torsion * j.relB / (2 * Math.PI * j.r * j.r);
        const want = Math.max(Math.max(0, na + nb) / j.capT, Math.max(0, nb - na) / j.capC, q / j.capS);
        const plain = jointUtilisation([j.fx, j.fy, j.fz], [j.mx, j.my, j.mz], [j.nx, j.ny, j.nz], j.r, j.capT, j.capC, j.capS).util;
        wU = Math.max(wU, Math.abs(j.util - want)); raw = Math.max(raw, plain - j.util); n++;
      }
    }
    S.check(`strutted Ember Twin burning and yawing: utilisation of braced joints = thin ring with axial, shear x relF and bending, torsion x relB (${n} joint-steps)`, 0, wU, 1e-14, {});
    S.ok('strutted Ember Twin: the struts do relieve the clamps (unbraced utilisation is higher)', raw > 0, `by up to ${raw.toExponential(2)}`);
  }
  // --- (2) pinned on the pad: no loads, nothing valid, nothing breaks (even a design that breaks in flight)
  {
    const w = new World();
    const events = [];
    w.on('structure', d => events.push(d));
    const v = w.launch(stack(NECK, 'Weak neck').craft, { crew: ['Ada'] });
    let valid = 0, util = 0, dmg = 0;
    for (let i = 0; i < 150; i++) { w.step(DT); const st = v.structure; if (st.valid) valid++; for (const j of st.joints) { util = Math.max(util, j.util); dmg = Math.max(dmg, j.damage); } }
    S.ok('weak neck standing on the pad for 3 s: still landed, all parts there', v.landed && v.parts.size === NECK.length);
    S.check('on the pad: steps with structure.valid', 0, valid, 0, { unit: 'steps' });
    S.check('on the pad: utilisation and damage of every joint', 0, Math.max(util, dmg), 0, {});
    S.check('on the pad: `structure` events', 0, events.length, 0, {});
  }
  // --- (3) on rails: the same after a loaded burn
  {
    const w = new World();
    const events = [];
    w.on('structure', d => events.push(d));
    const b = sys.byId.verda, r0 = b.radius + 300000;
    const v = spawn(w, simpleShip(), 'verda', [r0, 0, 0], [0, 0, -Math.sqrt(b.gm / r0)]);
    v.ctrl.sas = true; v.ctrl.throttle = 1; w.stage();
    for (let i = 0; i < 25; i++) w.step(DT);
    const loaded = v.structure.valid && v.structure.maxUtil > 0;
    v.ctrl.throttle = 0;
    for (let i = 0; i < 25; i++) w.step(DT);
    w.setWarp(7);
    let rails = 0, valid = 0, util = 0;
    for (let i = 0; i < 40; i++) { w.step(0.05); if (v.onRails) { rails++; if (v.structure.valid) valid++; for (const j of v.structure.joints) util = Math.max(util, j.util, j.damage); } }
    S.ok('orbit: the structure was loaded and valid during the burn before warping', loaded);
    S.ok('orbit at 100x warp: the vessel is on rails', rails >= 35, `${rails} of 40 steps, warp rate ${w.rate}`);
    S.check('on rails: steps with structure.valid', 0, valid, 0, { unit: 'steps' });
    S.check('on rails: utilisation and damage of every joint', 0, util, 0, {});
    S.check('on rails: `structure` events', 0, events.length, 0, {});
    w.setWarp(0);
    for (let i = 0; i < 5; i++) w.step(DT);
    S.ok('back at 1x: the structure is solved again', v.structure.valid && !v.onRails);
  }
  // --- (4) the assembly building: the ignition case of a vacuum stack on an airless world
  {
    const moon = SYSTEM.byId.pell;
    const craft = simpleShip();
    const res = analyzeCraft(craft, { body: moon });
    const T = PARTS.eng_sparrow.engine.thrust * 1000;
    const mPod = wetKg('pod_acorn'), mEng = dryKg('eng_sparrow'), M = mPod + wetKg('tank_m400') + mEng;
    const name = res.cases.find(c => /ignition/.test(c));
    S.ok(`analyzeCraft on ${moon.name} (${moon.atmo ? 'HAS AIR' : 'airless'}): an ignition case is reported`, !!name && !moon.atmo, res.cases.join(', '));
    const find = (a, b2) => res.joints.find(j => jointKey(j.a, j.b) === jointKey(a, b2));
    const ids = craft.parts.map(p => p.id);            // pod, tank, engine
    const j1 = find(ids[0], ids[1]), j2 = find(ids[1], ids[2]);
    const ring = 2 * Math.PI * 0.625 * STRUCT.LINE_C;
    if (name && j1 && j2) {
      S.check('analyzeCraft ignition, joint under the pod: thrust x pod mass / total / (2 pi r) / allowable', T * mPod / M / ring, j1.cases[name], 1e-9, { rel: true, note: `${(T * mPod / M).toFixed(1)} N of compression` });
      S.check('analyzeCraft ignition, joint above the engine: thrust x (total - engine) / total / (2 pi r) / allowable', T * (M - mEng) / M / ring, j2.cases[name], 1e-9, { rel: true });
      S.ok('analyzeCraft: each joint reports its worst case, at least the ignition one', j1.util >= j1.cases[name] && j2.util >= j2.cases[name] && res.worst && res.worst.util === Math.max(j1.util, j2.util), `worst ${res.worst ? res.worst.util.toFixed(4) : '-'} in "${res.worst ? res.worst.case : ''}"`);
    } else S.ok('analyzeCraft: both joints of the stack are reported', false, `${res.joints.length} joints`);
  }
}

// ------------------------------------------------------------------------------------------ 7k known defect
/**
 * KNOWN DEFECT, left in the game on purpose for now (its fix changes how landers settle and needs the landing suites):
 * Vessel._updateMass takes the vessel's inertia about the parts' GEOMETRIC centres, while the centre of mass - and
 * the structure - use the true mass points (a capsule's ballast, `comY`; the interstage truss a part carries).
 * So on such craft the angular acceleration the game flies is not the one Newton-Euler gives for its own masses, and
 * the joint loads leave a residual moment at the root. This group sizes it and pins what must hold regardless.
 */
function knownInertia(S, full) {
  const fs = flights(full);
  for (const f of fs) if (!f.stats) liveLoadsQuiet(f);
  for (const f of fs) {
    if (!f.offset) continue;
    // closed form: the parallel-axis terms with the geometric offsets d_i instead of the mass points r_i
    let wCF = 0, errPct = 0, zero = true;
    for (const r of f.recs) {
      const asm = RS.assembly(r.snap.bodies);
      const diff = [0, 0, 0];
      for (const b of r.snap.bodies) {
        const d = r.pre.geo.get(b.id), rr = b.r;
        const dd = dot(d, d), r2 = dot(rr, rr);
        for (let k = 0; k < 3; k++) diff[k] += b.m * ((dd - d[k] * d[k]) - (r2 - rr[k] * rr[k]));
      }
      for (let k = 0; k < 3; k++) {
        const got = r.pre.I[k] - asm.I[k][k];
        wCF = Math.max(wCF, Math.abs(got - diff[k]) / r.pre.I[k]);
        errPct = Math.max(errPct, 100 * Math.abs(got) / asm.I[k][k]);
        if (Math.abs(got) > 1e-9 * r.pre.I[k]) zero = false;
      }
    }
    S.info(`${f.name}: vessel.inertia is off from the inertia of its mass points by up to`, errPct, '%', `parts with off-centre mass: ${[...new Set(f.offsetParts)].join(', ')}`);
    S.info(`${f.name}: residual at the root, as a share of the largest joint load`, f.stats.wRes, '', `peak residual moment ${f.stats.pkRes.toFixed(1)} N m; largest joint load ${f.stats.pk.toFixed(0)} N or N m`);
    if (f.symmetric) S.info(`${f.name}: angular acceleration, game vs Newton-Euler on the mass points`, f.stats.wAlpha, 'rel');
    S.check(`${f.name}: that inertia error = sum of m (|d|^2 - |r|^2) terms, d geometric centre, r mass point (parallel axis, by hand)`, 0, wCF, 1e-10, { unit: 'of the inertia', note: 'PINS THE KNOWN DEFECT: when _updateMass is fixed this row fails; then delete it and judge these craft like the others (alpha and residual at 1e-9)' });
    S.ok(`${f.name}: the defect is still there (remove this group when this turns false)`, !zero);
  }
  // what must hold regardless
  for (const f of fs) {
    if (f.offset || !f.symmetric) continue;
    S.check(`${f.name} (every mass at its part's centre): residual at the root`, 0, f.stats.wRes, 1e-9, { unit: 'of the largest load', note: 'Newton closes where the defect cannot act' });
    S.check(`${f.name}: angular acceleration, game vs Newton-Euler`, 0, f.stats.wAlpha, 1e-9, { unit: 'rel' });
  }
  for (const f of fs) S.check(`${f.name}: the residual the game reports = the reference's residual (the game does not hide it)`, 0, f.stats.wResGame, 1e-9, { unit: 'of the largest load' });
}
/** The 7e statistics of a flight when 7e itself was not run (e.g. --only 7k). */
function liveLoadsQuiet(f) { const quiet = { check() {}, ok() {}, info() {} }; liveLoadsOf(quiet, f); }

// ------------------------------------------------------------------------------------------ groups
export const groups = [
  { name: '7a. Joint loads, pure solver: rod under thrust, spin, lateral load, torsion; free fall; side boosters', fast: true, run: S => closedForms(S) },
  { name: '7b. Joint loads, pure solver vs independent multibody reference on random trees', fast: true, run: (S, full) => randomTrees(S, full) },
  { name: '7c. Thin-ring utilisation vs line loads integrated round the ring', fast: true, run: S => ring(S) },
  { name: '7d. Live game, closure: part forces and torques add up to what the vessel did', fast: true, run: (S, full) => closure(S, full) },
  { name: '7e. Live game: joint loads of every step vs the multibody reference', fast: true, run: (S, full) => liveLoads(S, full) },
  { name: '7f. Live game, hand numbers: vacuum burn, spin, coast, drag', fast: true, run: S => handNumbers(S) },
  { name: '7g. Joint rings, axes and strengths of stock craft vs the part catalog', fast: true, run: S => geometry(S) },
  { name: '7h. Failure: a weak joint breaks where and when the reference says', fast: true, run: S => failure(S) },
  { name: '7i. Stock craft fly to space with every joint whole', fast: true, run: (S, full) => stock(S, full) },
  { name: '7j. Brace struts, no loads while pinned or on rails, the assembly building\'s ignition case', fast: true, run: S => extras(S) },
  { name: '7k. KNOWN DEFECT (not fixed yet): vessel.inertia about geometric centres, not mass points; its size, and what holds regardless', fast: true, run: (S, full) => knownInertia(S, full) },
];
