// Group 11: parachutes (docs/PARACHUTES.md). The game (js/core/parachute.js, the canopy step in js/core/vessel.js and
// the drawn cloth and lines in js/render/canopy.js) against tests/verify/ref_parachute.mjs, which shares no code with
// any of them, and against closed forms. What is asked of it:
//   11a  the canopy the part numbers imply: diameter, cloth length, line length, at every stage of filling
//   11b  the picture is the physics: the drawn canopy is as wide and as high as the flown one, and every suspension
//        line ends on the skirt at a seam (the fault this chapter was written after)
//   11c  steady descent under every parachute part on every world with air
//   11d  the reefed stage opening: speed and line load against the reference, and the sequencer's estimate
//   11e  opening fully: the same, with the air the canopy takes along
//   11f  a capsule that arrives with sideways speed swings under its canopy as the reference says
//   11g  limits: Mach and line strength hold an armed parachute shut, lines loaded past their strength tear
//   11h  two canopies side by side lean apart and still carry the craft down at the speed their areas give
//   11i  the step size: 20 ms against 5 ms
import { World, SYSTEM } from './harness.mjs';
import * as R from './ref.mjs';
import * as RP from './ref_parachute.mjs';
import { Vector3 } from '../../js/lib/three.module.min.js';
import { Craft } from '../../js/core/craft.js';
import { PARTS } from '../../js/core/parts.js';
import { TUNING } from '../../js/core/vessel.js';
import { chuteSpec, chuteShape, chuteDragArea, chuteOpeningLoad, chuteDisreefLoad, CHUTE } from '../../js/core/parachute.js';
import { canopyLayout, writeCanopy, canopyPlacement } from '../../js/render/canopy.js';

const sys = R.readSystem();
const refBody = id => sys.bodies.find(b => b.id === id);
const CHUTES = Object.values(PARTS).filter(d => d.chute);
const gEff = (b, alt) => { const r = b.radius + alt, w = 2 * Math.PI / b.rotPeriod; return b.gm / (r * r) - w * w * r; };

// ---------------------------------------------------------------------------------------------- game-side helpers
/** A capsule with parachutes, `alt` m above the sea on the equator of `bodyId`, moving at (vx east, vy up) through the air. */
function drop({ chutes = ['chute'], pod = 'pod_acorn', shield = 'heatshield_m', ballast = [], bodyId = 'verda', alt = 3000, vy = -60, vx = 0, arm = true, dt = null }) {
  const c = new Craft('Drop');
  const [p] = c.setRoot(pod);
  for (const id of chutes) { if (id.includes('radial')) c.attachRadial(id, p.id, p.pos.y + 0.1, 0, 2); else c.attachStack(id, p.id, 'top'); }
  let below = p;
  for (const id of [shield, ...ballast].filter(Boolean)) [below] = c.attachStack(id, below.id, 'bottom');
  c.autoStage();
  const w = new World(), body = SYSTEM.byId[bodyId], r = body.radius + alt, wy = 2 * Math.PI / body.rotPeriod;
  // on the +X axis of the body: up is +X, east is -Z (the ground there moves at -wy r along Z)
  const v = w.spawn(c, { crew: ['Ada'], body, pos: new Vector3(r, 0, 0), vel: new Vector3(vy, 0, -wy * r - vx) });
  v.q.setFromUnitVectors(new Vector3(0, 1, 0), new Vector3(1, 0, 0));
  v.ctrl.sas = false;
  if (arm) while (v.chuteParts.some(q => q.deployed === 'stowed')) v.activateNextStage();
  const old = TUNING.DT_MAX;
  const step = (n = 1) => { if (dt) TUNING.DT_MAX = dt; try { for (let i = 0; i < n; i++) w.step(dt || 0.02); } finally { TUNING.DT_MAX = old; } };
  return { w, v, body, step, h: dt || 0.02 };
}
/** Angle (rad) of a canopy's line from the local vertical. */
function lineAngle(v, p) {
  const c = p._c; if (!c) return 0;
  const up = v.pos.clone().normalize();
  return Math.acos(Math.max(-1, Math.min(1, c.ux * up.x + c.uy * up.y + c.uz * up.z)));
}
/** The capsule's own drag area (m²) at low speed, measured in the game from two decelerations (so gravity drops out). */
function ownDragArea(opts) {
  const acc = vy => { const d = drop({ ...opts, arm: false, vy, alt: 2000 }); const v0 = d.v.verticalSpeed; d.step(5); return { a: (d.v.verticalSpeed - v0) / (5 * d.h), rho: d.body.density(d.v.altitude), m: d.v.mass }; };
  const a1 = acc(-30), a2 = acc(-60);
  return 2 * a1.m * (a2.a - a1.a) / (a1.rho * (60 * 60 - 30 * 30));
}

/**
 * The craft's own drag area as a function of speed at one height (it rises through Mach 1), measured in the game from
 * its deceleration with the parachute packed; group 10 is what checks that drag itself. → f(speed)
 */
function ownDragCurve(opts, alt, vMax) {
  const b = refBody(opts.bodyId || 'verda'), pts = [];
  for (const f of [0.06, 0.12, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.76, 0.82, 0.88, 0.94, 1, 1.06]) {
    const d = drop({ ...opts, arm: false, vy: -f * vMax, alt }), v0 = d.v.verticalSpeed, m = d.v.mass; d.step(3);
    const a = (d.v.verticalSpeed - v0) / (3 * d.h), sp = 0.5 * (Math.abs(v0) + Math.abs(d.v.verticalSpeed));
    pts.push([sp, 2 * m * (a + gEff(b, alt)) / (R.airDensity(b, alt) * sp * sp)]);
  }
  return sp => { if (sp <= pts[0][0]) return pts[0][1]; for (let i = 1; i < pts.length; i++) if (sp <= pts[i][0]) { const [x0, y0] = pts[i - 1], [x1, y1] = pts[i]; return y0 + (y1 - y0) * (sp - x0) / (x1 - x0); } return pts[pts.length - 1][1]; };
}

// ---------------------------------------------------------------------------------------------- 11a the canopy
function geometry(S) {
  for (const d of CHUTES) {
    const g = chuteSpec(d, TUNING.CHUTE_CD), r = RP.spec(d.chute);
    S.check(`${d.name}: nominal diameter from its drag area, 2 sqrt(CdS / (0.8 pi n))`, r.d0, g.d0, 1e-12, { rel: true, unit: 'm' });
    S.check(`${d.name}: lines one nominal diameter long`, r.line, g.line, 1e-12, { rel: true, unit: 'm' });
    S.check(`${d.name}: line strength as the part states it`, d.chute.strength * 1000, g.rated, 0, { unit: 'N' });
    let wC = 0, wCloth = 0, wL = 0, wLine = 0, n = 0;
    for (const [stage, fill] of [['semi', 0.05], ['semi', 0.3], ['semi', 1], ['full', 0.25], ['full', 0.5], ['full', 0.8], ['full', 1]]) {
      const cds = chuteDragArea(g, stage, fill), sh = chuteShape(g, cds, {}), rs = RP.shape(r, cds);
      wC = Math.max(wC, Math.abs(sh.c / rs.c - 1)); wL = Math.max(wL, Math.abs(sh.L / rs.L - 1));
      // the cloth of the game's shape, measured by the reference's own rule
      const cloth = RP.shape({ ...r, gore: 1 }, cds);      // (only to borrow nothing: the length is re-measured below)
      void cloth;
      const N = 4000, end = Math.PI / 2 + sh.delta; let len = 0, px = 0, py = sh.c;
      for (let i = 1; i <= N; i++) { const ph = end * i / N, x = sh.rm * Math.sin(ph), y = sh.c * Math.cos(ph); len += Math.hypot(x - px, y - py); px = x; py = y; }
      wCloth = Math.max(wCloth, Math.abs(len / (g.d0 / 2) - 1));
      wLine = Math.max(wLine, Math.abs(Math.hypot(sh.h, sh.rs) / g.line - 1));
      n++;
    }
    S.check(`${d.name}: crown height vs the reference, ${n} stages of filling (worst)`, 0, wC, 2e-3);
    S.check(`${d.name}: the cloth from skirt to apex stays D0/2 long however far it has filled (worst)`, 0, wCloth, 2e-3);
    S.check(`${d.name}: the lines stay their length: confluence to skirt, sqrt(h^2 + rs^2) (worst)`, 0, wLine, 1e-9);
    S.check(`${d.name}: where the drag acts, above the pack, vs the reference (worst)`, 0, wL, 1e-3);
    const full = chuteShape(g, g.cdsFull, {});
    S.check(`${d.name}: fully open it is 0.67 nominal diameters across`, 0.67 * g.d0, 2 * full.rm, 1e-9, { rel: true, unit: 'm' });
    S.check(`${d.name}: drag area of the open mouth at 0.8 / 0.67^2 gives back the part's drag area`, d.chute.area * 1.6, (g.count) * Math.PI * full.rm * full.rm * 0.8 / (0.67 * 0.67), 1e-9, { rel: true, unit: 'm2' });
    S.info(`${d.name}: nominal / open diameter / lines / top above the pack`, `${g.d0.toFixed(1)} / ${(2 * full.rm).toFixed(1)} / ${g.line.toFixed(1)} / ${full.top.toFixed(1)}`, 'm', g.count > 1 ? `each of ${g.count}` : '');
  }
}

// ---------------------------------------------------------------------------------------------- 11b picture = physics
function picture(S) {
  for (const d of CHUTES) {
    const g = chuteSpec(d, TUNING.CHUTE_CD), kind = d.variant === 'drogue' ? 'drogue' : g.count > 1 ? 'cluster' : 'main';
    let gap = 0, seam = 0, wide = 0, hem = 0, len = 0, conf = 0, n = 0, lines = 0;
    for (const q of [2, 1, 0]) for (const [stage, fill] of [['semi', 0.02], ['semi', 0.4], ['semi', 1], ['full', 0.3], ['full', 0.7], ['full', 1]]) for (const breath of [1, 0.96, 1.012]) {
      const lay = canopyLayout(kind, q), sh = chuteShape(g, chuteDragArea(g, stage, fill), {});
      const pos = new Float32Array(lay.verts * 3), line = new Float32Array(lay.lines * 6);
      seam = Math.max(seam, writeCanopy(sh, lay, pos, null, null, line, breath, 0.3));
      lines = lay.lines;
      // every vertex of the hem (last row), and the widest the cloth gets on a seam
      const hemPts = [];
      let rmax = 0;
      for (let gi = 0; gi < lay.gores; gi++) for (let i = 0; i < lay.cols; i++) {
        const o = ((gi * lay.cols + i) * lay.rows + lay.rings) * 3; hemPts.push([pos[o], pos[o + 1], pos[o + 2]]);
        if (i === 0) for (let j = 0; j < lay.rows; j++) { const k = ((gi * lay.cols) * lay.rows + j) * 3; rmax = Math.max(rmax, Math.hypot(pos[k], pos[k + 2])); }
      }
      for (let l = 0; l < lay.lines; l++) {
        const top = [line[l * 6 + 3], line[l * 6 + 4], line[l * 6 + 5]];
        // distance from the line's upper end to the nearest hem vertex: this is the gap in the screenshot
        gap = Math.max(gap, Math.min(...hemPts.map(p => Math.hypot(p[0] - top[0], p[1] - top[1], p[2] - top[2]))));
        conf = Math.max(conf, Math.hypot(line[l * 6], line[l * 6 + 1], line[l * 6 + 2]));
        hem = Math.max(hem, Math.abs(top[1] - sh.h), Math.abs(Math.hypot(top[0], top[2]) - sh.rs * breath));
        if (breath === 1) len = Math.max(len, Math.abs(Math.hypot(...top) / g.line - 1));
      }
      // sampled rings do not land exactly on the widest circle: allow the spacing of the rings
      if (breath === 1) wide = Math.max(wide, Math.abs(rmax / sh.rm - 1));
      n++;
    }
    S.check(`${d.name}: every line ends ON the hem, ${n} shapes x ${lines} lines (largest gap)`, 0, gap, 1e-6, { unit: 'm' });
    S.check(`${d.name}: each seam is one point for the two gores that share it (largest mismatch)`, 0, seam, 1e-6, { unit: 'm' });
    S.check(`${d.name}: every line starts at the confluence (largest offset)`, 0, conf, 0, { unit: 'm' });
    S.check(`${d.name}: the hem sits where the flown shape has its skirt: height and radius (worst)`, 0, hem, 1e-4, { unit: 'm' });
    S.check(`${d.name}: drawn lines are as long as the flown ones (worst)`, 0, len, 1e-6);
    S.check(`${d.name}: the drawn canopy is as wide as the flown one (worst)`, 0, wide, 0.01);
    if (g.count > 1) {
      const sh = chuteShape(g, g.cdsFull, {}), pl = canopyPlacement(sh);
      // centres of two neighbours of the cluster, at the widest circle
      const cen = pl.map(p => { const d0 = sh.h + sh.drop; return [Math.sin(p.tilt) * p.dx * d0, Math.cos(p.tilt) * d0, Math.sin(p.tilt) * p.dz * d0]; });
      const sep = Math.hypot(cen[0][0] - cen[1][0], cen[0][1] - cen[1][1], cen[0][2] - cen[1][2]);
      S.ok(`${d.name}: the ${g.count} canopies of the cluster stand side by side, not inside one another`, sep >= 2 * sh.rm && sep < 2.2 * sh.rm, `centres ${sep.toFixed(2)} m apart, each ${(2 * sh.rm).toFixed(2)} m across`);
    }
  }
}

// ---------------------------------------------------------------------------------------------- 11c steady descent
function steady(S, full) {
  const cases = [['chute', 'pod_acorn', 'heatshield_m', 'verda'], ['chute_radial', 'pod_acorn', 'heatshield_m', 'verda'], ['chute_grand', 'pod_hearth', 'heatshield_l', 'verda'],
    ['chute_drogue', 'pod_acorn', 'heatshield_m', 'verda'], ['chute_drogue_radial', 'pod_acorn', 'heatshield_m', 'verda'], ['chute', 'pod_thimble', 'heatshield_s', 'verda']];
  if (full) for (const b of sys.bodies.filter(b => b.atmo && !b.gas && b.id !== 'verda')) cases.push(['chute', 'pod_acorn', 'heatshield_m', b.id]);
  for (const [chute, pod, shield, bodyId] of cases) {
    const b = refBody(bodyId), d = PARTS[chute], rs = RP.spec(d.chute), nCh = chute.includes('radial') ? 2 : 1;
    const opts = { chutes: [chute], pod, shield, bodyId };
    const capCdA = ownDragArea(opts);
    // start already near the answer, low enough to be told to open fully, and let it settle
    const guess = RP.sinkSpeed(1200, gEff(b, 1500), R.airDensity(b, 1500), nCh * rs.cdsFull, capCdA);
    // (heights here are above the ground under it: this spot on Marn is a kilometre and a half up)
    const probe = drop({ ...opts, alt: 6000, arm: false }); probe.step(1);
    const ground = Math.max(0, probe.v.altitude - probe.v.radarAlt);
    const D = drop({ ...opts, alt: ground + Math.min(0.9 * d.chute.fullAlt, 800) + (guess > 12 ? 1500 : 700), vy: -guess * 1.3 });
    let t = 0;
    for (; t < 400 && !(D.v.chuteParts.every(p => p.deployed === 'full' && p.deployT >= 1)); t += D.h) D.step();
    for (let i = 0; i < 1000 && D.v.radarAlt > 60; i++) D.step();
    const v = D.v, alt = v.altitude;
    if (!(v.radarAlt > 20) || v.dead) {
      // air too thin for this parachute to settle (or to open at all) in the height there is: reported, not judged
      S.info(`${d.name} on ${b.name}: reaches the ground before it settles; steady sinking speed would be`, guess, 'm/s', `parachute ${v.chuteParts[0].deployed}${v.chuteParts[0].chuteWait ? ', waiting: ' + v.chuteParts[0].chuteWait : ''}`); continue; }
    // (the air thickens as it sinks, so it is always slowing a little: the closed form includes that lag to first order)
    const want = RP.sinkSpeed(v.mass, gEff(b, alt), R.airDensity(b, alt), nCh * rs.cdsFull, capCdA);
    S.check(`${d.name}${nCh > 1 ? ' x2' : ''} under ${PARTS[pod].name} on ${b.name}: sinking speed, sqrt(2 m g / (rho (CdS + craft)))`, want, -v.verticalSpeed, 0.01, { rel: true, unit: 'm/s' });
    S.check(`${d.name} on ${b.name}: line load in steady descent = weight less the craft's own drag`, v.mass * gEff(b, alt) * (nCh * rs.cdsFull) / (nCh * rs.cdsFull + capCdA), v.chuteTension * (nCh > 1 ? Math.cos(lineAngle(v, v.chuteParts[0])) : 1), 0.01, { rel: true, unit: 'N' });
    if (nCh === 1) S.check(`${d.name} on ${b.name}: the canopy stands straight above the craft`, 0, lineAngle(v, v.chuteParts[0]) * 180 / Math.PI, 0.5, { unit: 'deg' });
  }
}

// ---------------------------------------------------------------------------------------------- 11d / 11e opening
/** Fly the game through one stage from the moment it starts; → { rows: [{ t, speed, T, h, theta }], start, capCdA } */
function gameStage(D, stage, tEnd) {
  const v = D.v, p = v.chuteParts[0];
  let guard = 0;
  while (p.deployed !== stage && guard++ < 60000 && !v.dead && !v.landed) D.step();
  // the stage switched during the last step: the state now is its start
  const up = v.pos.clone().normalize(), wy = 2 * Math.PI / D.body.rotPeriod;
  const air = new Vector3(v.vel.x - wy * v.pos.z, v.vel.y, v.vel.z + wy * v.pos.x);
  const vyUp = air.dot(up), east = new Vector3(0, 0, -1), vx = air.dot(east);
  const c = p._c;
  const th = c ? Math.atan2(c.ux * east.x + c.uy * east.y + c.uz * east.z, c.ux * up.x + c.uy * up.y + c.uz * up.z) : Math.atan2(-vx, -vyUp);
  const start = { h: v.altitude, vy: vyUp, vx, theta: th, from: c ? c.from : undefined, s: c ? c.s : 0, t0: c ? c.t : 0, mass: v.mass };
  const rows = [];
  for (let t = 0; t <= tEnd + 1e-9; t += D.h) {
    D.step();
    rows.push({ t: t + D.h, speed: v.airspeed, T: v.chuteTension, h: v.altitude, theta: lineAngle(v, p), stage: p.deployed, fill: p.deployT });
    if (p.deployed !== stage || v.dead || v.landed) break;
  }
  return { rows, start };
}
const at = (rows, t) => rows.reduce((a, r) => Math.abs(r.t - t) < Math.abs(a.t - t) ? r : a);
const peakOf = rows => rows.reduce((a, r) => r.T > a.T ? r : a);

function opening(S, stage) {
  const cases = stage === 'semi'
    ? [['chute', 'pod_acorn', 'heatshield_m', [], 5000, -160], ['chute', 'pod_acorn', 'heatshield_m', [], 9000, -330], ['chute_grand', 'pod_hearth', 'heatshield_l', [], 5000, -170],
      ['chute_drogue', 'pod_acorn', 'heatshield_m', [], 15000, -500], ['chute', 'pod_acorn', 'heatshield_m', ['tank_m400', 'tank_m400'], 4000, -150]]
    : [['chute', 'pod_acorn', 'heatshield_m', [], 2500, -120], ['chute_grand', 'pod_hearth', 'heatshield_l', [], 2500, -150], ['chute', 'pod_thimble', 'heatshield_s', [], 2500, -120],
      ['chute', 'pod_acorn', 'heatshield_m', ['tank_m400'], 2500, -120]];
  for (const [chute, pod, shield, ballast, alt, vy] of cases) {
    const d = PARTS[chute], rs = RP.spec(d.chute), b = refBody('verda');
    const opts = { chutes: [chute], pod, shield, ballast };
    const D = drop({ ...opts, alt, vy });
    const tEnd = stage === 'semi' ? 7.5 : 14;
    const G = gameStage(D, stage, tEnd), st = G.start;
    const capCdA = ownDragCurve(opts, st.h, Math.hypot(st.vx, st.vy));
    const name = `${d.name} under ${(st.mass / 1000).toFixed(2)} t from ${Math.hypot(st.vx, st.vy).toFixed(0)} m/s at ${(st.h / 1000).toFixed(1)} km`;
    if (G.rows.length < 20) { S.ok(`${name}: the stage was flown`, false, `${G.rows.length} steps`); continue; }
    const ref = RP.fly({ mass: st.mass, capCdA, sp: rs, stage: stage === 'semi' ? 'reefed' : 'full', from: st.from, rho: h => R.airDensity(b, h), g: gEff(b, st.h), h: st.h, vx: st.vx, vy: st.vy, theta: st.theta, s: st.s, t0: st.t0, tEnd: G.rows[G.rows.length - 1].t, every: 0.02 });
    const gp = peakOf(G.rows), rp = peakOf(ref);
    const label = stage === 'semi' ? 'reefed stage' : 'opening fully';
    S.check(`${label}, ${name}: peak line load vs the reference`, rp.T, gp.T, 0.03, { rel: true, unit: 'N', note: `${(gp.T / (st.mass * 9.80665)).toFixed(1)} g` });
    S.check(`${label}, ${name}: when the peak comes`, rp.t, gp.t, Math.max(0.12, 0.05 * rp.t), { unit: 's' });
    let wV = 0, wT = 0;
    for (const r of G.rows) { const q = at(ref, r.t); wV = Math.max(wV, Math.abs(r.speed - q.speed) / Math.max(q.speed, 1)); if (r.t > 0.3) wT = Math.max(wT, Math.abs(r.T - q.T) / rp.T); }
    S.check(`${label}, ${name}: speed all the way through vs the reference (worst)`, 0, wV, 0.03);
    S.check(`${label}, ${name}: line load all the way through, as a share of the peak (worst)`, 0, wT, 0.05);
    // the sequencer's own estimate (what holds an armed parachute shut) against what then happened
    const rho = R.airDensity(b, st.h), q = 0.5 * rho * (st.vx * st.vx + st.vy * st.vy), gs = chuteSpec(d, TUNING.CHUTE_CD);
    const est = stage === 'semi' ? chuteOpeningLoad(gs, q, rho, st.mass, gEff(b, st.h)) : chuteDisreefLoad(gs, q, rho, st.mass, st.from, gEff(b, st.h));
    S.ok(`${label}, ${name}: the sequencer's estimate of this load is on the safe side, and within 40 %`, est >= 0.97 * gp.T && est <= 1.4 * gp.T, `estimated ${(est / 1000).toFixed(1)} kN, flown ${(gp.T / 1000).toFixed(1)} kN`);
    S.ok(`${label}, ${name}: inside what the lines hold`, gp.T < gs.rated, `${(100 * gp.T / gs.rated).toFixed(0)} % of ${(gs.rated / 1000).toFixed(0)} kN`);
  }
}

// ---------------------------------------------------------------------------------------------- 11f swing
function swing(S) {
  // Opened while still moving sideways: the canopy trails back along the flight path, 45 degrees or more from the
  // vertical, and the capsule swings in under it as the sideways speed dies.
  const b = refBody('verda'), d = PARTS.chute, rs = RP.spec(d.chute);
  const opts = { chutes: ['chute'], pod: 'pod_acorn', shield: 'heatshield_m' };
  for (const [vx, vy] of [[80, -80], [150, -60]]) {
    const D = drop({ ...opts, alt: 5000, vy, vx });
    const G = gameStage(D, 'semi', 20), st = G.start;
    const capCdA = ownDragCurve(opts, st.h, Math.hypot(st.vx, st.vy));
    const ref = RP.fly({ mass: st.mass, capCdA, sp: rs, stage: 'reefed', rho: h => R.airDensity(b, h), g: gEff(b, st.h), h: st.h, vx: st.vx, vy: st.vy, theta: st.theta, s: st.s, t0: st.t0, tEnd: G.rows[G.rows.length - 1].t, every: 0.02 });
    const name = `opened at ${Math.hypot(st.vx, st.vy).toFixed(0)} m/s, ${(Math.atan2(Math.abs(st.vx), -st.vy) * 180 / Math.PI).toFixed(0)} deg from straight down`;
    S.check(`swing, ${name}: the canopy starts out trailing along the flight path`, Math.atan2(Math.abs(st.vx), -st.vy) * 180 / Math.PI, G.rows[0].theta * 180 / Math.PI, 1.5, { unit: 'deg' });
    let wA = 0, wV = 0;
    for (const r of G.rows) { const q = at(ref, r.t); wA = Math.max(wA, Math.abs(r.theta - Math.abs(q.theta))); wV = Math.max(wV, Math.abs(r.speed - q.speed) / q.speed); }
    S.check(`swing, ${name}: lean of the line over ${G.rows[G.rows.length - 1].t.toFixed(0)} s vs the reference (worst)`, 0, wA * 180 / Math.PI, 1.5, { unit: 'deg' });
    S.check(`swing, ${name}: speed over that time vs the reference (worst)`, 0, wV, 0.03);
    for (const t of [3, 8, 15]) { const g = at(G.rows, t), q = at(ref, t); S.check(`swing, ${name}: lean ${t} s after opening`, Math.abs(q.theta) * 180 / Math.PI, g.theta * 180 / Math.PI, 1.0, { unit: 'deg' }); }
    const gp = peakOf(G.rows), rp = peakOf(ref);
    // (the reference takes the craft's own drag end-on; flying partly side-on it has a little more, hence 6 %)
    S.check(`swing, ${name}: peak line load vs the reference`, rp.T, gp.T, 0.06, { rel: true, unit: 'N' });
  }
}

// ---------------------------------------------------------------------------------------------- 11g limits
function limits(S) {
  const b = refBody('verda');
  // Mach: armed above the limit, it waits; it opens on the first step under it
  for (const [chute, alt, vy] of [['chute', 16000, -520], ['chute_drogue', 20000, -1000]]) {
    const d = PARTS[chute], D = drop({ chutes: [chute], alt, vy }), p = D.v.chuteParts[0];
    let over = true, guard = 0, machOpen = 0, waited = '';
    while (p.deployed === 'armed' && guard++ < 20000) { const m = D.v.airspeed / R.soundSpeed(b, D.v.altitude); D.step(); if (p.deployed === 'armed') { if (m < d.chute.maxMach - 0.02) over = false; waited = p.chuteWait; } else machOpen = m; }
    S.ok(`${d.name}: armed at Mach ${(Math.abs(vy) / R.soundSpeed(b, alt)).toFixed(1)}, it stays packed while faster than Mach ${d.chute.maxMach}`, over && waited === 'mach', `was waiting for: ${waited}`);
    S.check(`${d.name}: it opens as the Mach number comes under its limit`, d.chute.maxMach, machOpen, 0.02);
  }
  // air: too thin to fill it above 0.02 atm
  { const D = drop({ alt: 40000, vy: -100 }), p = D.v.chuteParts[0]; D.step(50);
    S.ok('a parachute armed at 40 km stays packed: the air is too thin to fill it', p.deployed === 'armed' && p.chuteWait === 'thin'); }
  // strength: a heavy craft at speed is held shut by the sequencer, then opens when the load would be inside the margin
  { const D = drop({ ballast: Array(10).fill('tank_m400'), alt: 3000, vy: -400 }), v = D.v, p = v.chuteParts[0], gs = chuteSpec(p.def, TUNING.CHUTE_CD);
    D.step();
    const rho0 = R.airDensity(b, v.altitude), est0 = chuteOpeningLoad(gs, 0.5 * rho0 * v.airspeed ** 2, rho0, v.mass, gEff(b, v.altitude));
    S.ok(`${(v.mass / 1000).toFixed(1)} t on one Canopy Parachute at ${v.airspeed.toFixed(0)} m/s: held shut, opening would load the lines to ${(est0 / 1000).toFixed(0)} kN of ${(gs.rated / 1000).toFixed(0)}`, p.deployed === 'armed' && p.chuteWait === 'load' && est0 > CHUTE.OPEN_MARGIN * gs.rated);
    let guard = 0, peak = 0;
    while (p.deployed === 'armed' && guard++ < 20000 && !v.dead && !v.landed) D.step();
    const opened = p.deployed === 'semi';
    for (let i = 0; i < 500 && p.deployed === 'semi'; i++) { D.step(); peak = Math.max(peak, v.chuteTension); }
    if (opened) S.ok('... and once it does open, the reefed stage stays inside the margin it waited for', peak <= CHUTE.OPEN_MARGIN * gs.rated * 1.02, `peak ${(peak / 1000).toFixed(0)} kN, margin ${(CHUTE.OPEN_MARGIN * gs.rated / 1000).toFixed(0)} kN`);
    else S.info('... it reached the ground still waiting (a parachute this small cannot take this craft at this speed)', v.airspeed, 'm/s'); }
  // tearing: a canopy that is open and then loaded past its strength comes away (with joints that hold: on this
  // stack the joint under the capsule would let go before the lines do)
  const keepS = TUNING.STRUCT_FAIL; TUNING.STRUCT_FAIL = false;
  try {
  { const D = drop({ ballast: ['tank_m400', 'tank_m400', 'tank_m400', 'tank_m400', 'tank_m400', 'tank_m400', 'tank_m400', 'tank_m400', 'tank_m400', 'tank_m400'], alt: 2000, vy: -60 }), v = D.v, p = v.chuteParts[0], gs = chuteSpec(p.def, TUNING.CHUTE_CD);
    const ev = []; D.w.on('chute', e => ev.push(e));
    let peak = 0, guard = 0;
    while (p.deployed !== 'cut' && guard++ < 6000 && !v.dead && !v.landed) { D.step(); peak = Math.max(peak, v.chuteTension || 0); }
    const cut = ev.find(e => e.state === 'cut');
    S.ok(`${(v.mass / 1000).toFixed(1)} t on one Canopy Parachute: opening fully overloads the lines and the canopy tears away`, p.deployed === 'cut' && !!cut && cut.load > gs.rated, cut ? `line load ${(cut.load / 1000).toFixed(0)} kN, strength ${(gs.rated / 1000).toFixed(0)} kN` : `peak ${(peak / 1000).toFixed(0)} kN`);
    D.step(5);
    S.check('... and a torn canopy pulls no more', 0, v.chuteTension || 0, 0, { unit: 'N' }); }
  // the same craft with CHUTE_FAIL off keeps its canopy
  { const keep = TUNING.CHUTE_FAIL; TUNING.CHUTE_FAIL = false;
    try { const D = drop({ ballast: ['tank_m400', 'tank_m400', 'tank_m400', 'tank_m400', 'tank_m400', 'tank_m400', 'tank_m400', 'tank_m400', 'tank_m400', 'tank_m400'], alt: 2000, vy: -60 }), p = D.v.chuteParts[0];
      let guard = 0; while (guard++ < 1500 && !D.v.landed && !D.v.dead) D.step();
      S.ok('with TUNING.CHUTE_FAIL off the same canopy holds', p.deployed === 'full' || D.v.landed); } finally { TUNING.CHUTE_FAIL = keep; } }
  } finally { TUNING.STRUCT_FAIL = keepS; }
}

// ---------------------------------------------------------------------------------------------- 11h two canopies
function twin(S) {
  const D = drop({ chutes: ['chute_radial'], alt: 1500, vy: -40 }), v = D.v, [a, c] = v.chuteParts;
  let guard = 0, closest = Infinity;
  const centre = p => { const k = p._c, r = new Vector3(p.pos.x - v.com.x, p.pos.y - v.com.y + p.def.h / 2, p.pos.z - v.com.z).applyQuaternion(v.q); return r.add(new Vector3(k.ux, k.uy, k.uz).multiplyScalar(k.L)); };
  while (guard++ < 4000 && !v.landed && !v.dead) {
    D.step();
    if (a._c && c._c && a.deployed === 'full' && a.deployT > 0.5) closest = Math.min(closest, centre(a).distanceTo(centre(c)) / (a._c.shape.rm + c._c.shape.rm));
    if (a.deployed === 'full' && a.deployT >= 1 && guard > 2500) break;
  }
  const sep = centre(a).distanceTo(centre(c)), wide = a._c.shape.rm + c._c.shape.rm;
  S.check('two Side Parachutes fully open: their centres settle one canopy width apart', wide, sep, 0.03 * wide, { unit: 'm' });
  S.ok('... and never pass through one another on the way (closest approach at least 0.9 widths)', closest >= 0.9, `${closest.toFixed(3)} widths`);
  // the packs sit on opposite sides of the capsule, so the lines lean by less than radius / line
  const packs = Math.hypot(a.pos.x - c.pos.x, a.pos.z - c.pos.z) / 2;
  S.check('... leaning apart by asin((radius - half the distance between the packs) / line)', Math.asin((a._c.shape.rm - packs) / a._c.L) * 180 / Math.PI, lineAngle(v, a) * 180 / Math.PI, 0.3, { unit: 'deg' });
  const drag = 0.5 * D.body.density(v.altitude) * v.airspeed ** 2 * a._c.cds;
  S.check('... each line carrying its canopy\'s drag / cos(lean): what the other canopy pushes sideways goes into the line', drag / Math.cos(lineAngle(v, a)), a._c.T, 0.01, { rel: true, unit: 'N' });
}

// ---------------------------------------------------------------------------------------------- 11i step size
function stepSize(S) {
  const run = dt => { const D = drop({ alt: 2500, vy: -120, dt }); const a = gameStage(D, 'semi', 7.5); const b = gameStage(D, 'full', 14); return { p1: peakOf(a.rows).T, p2: peakOf(b.rows).T, v: at(b.rows, 10).speed }; };
  const a = run(0.02), f = run(0.005);
  S.check('reefed-stage peak line load: 20 ms steps vs 5 ms', f.p1, a.p1, 0.02, { rel: true, unit: 'N' });
  S.check('full-opening peak line load: 20 ms steps vs 5 ms', f.p2, a.p2, 0.02, { rel: true, unit: 'N' });
  S.check('speed 10 s into opening fully: 20 ms steps vs 5 ms', f.v, a.v, 0.01, { rel: true, unit: 'm/s' });
}

export const groups = [
  { name: '11a. Parachutes: the canopy its part numbers imply, at every stage of filling', fast: true, run: S => geometry(S) },
  { name: '11b. Parachutes: the picture is the physics, and every line ends on the skirt', fast: true, run: S => picture(S) },
  { name: '11c. Parachutes: steady descent under every parachute part', fast: true, run: (S, full) => steady(S, full) },
  { name: '11d. Parachutes: the reefed stage opening, against the reference', fast: false, run: S => opening(S, 'semi') },
  { name: '11e. Parachutes: opening fully, with the air the canopy takes along', fast: false, run: S => opening(S, 'full') },
  { name: '11f. Parachutes: the swing of a capsule that arrives with sideways speed', fast: false, run: S => swing(S) },
  { name: '11g. Parachutes: Mach and line-strength limits, and tearing', fast: true, run: S => limits(S) },
  { name: '11h. Parachutes: two canopies side by side', fast: true, run: S => twin(S) },
  { name: '11i. Parachutes: step size', fast: false, run: S => stepSize(S) },
];
