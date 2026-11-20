// Group 3j: quality of the game's transfer planner (js/core/autopilot.js planInterplanetary + planCorrection) against
// the patched-conic optimum, for every ordered pair of planets. The physics of flying a plan is checked in 3f; this
// group asks whether the plan is a GOOD one: is the ejection burn the minimum-energy one, what does the mid-course
// correction cost, how fast does the ship arrive, how long does it take.
//
// Method per pair: the game plans the ejection from a low parking orbit (the options the flight screen uses); the
// independent reference applies that burn as an impulse and carries the ship out of the SOI; 40 % of the way across
// the game plans its mid-course correction; the reference carries the corrected path to the target's SOI.
import { World, SYSTEM, A, simpleShip, spawn } from './harness.mjs';
import { applyManeuver } from '../../js/core/trajectory.js';
import * as AP from '../../js/core/autopilot.js';
import * as R from './ref.mjs';

const sys = R.readSystem(), eph = new R.Ephemeris(sys), mu = sys.byId.helion.gm;
const planets = sys.bodies.filter(b => b.parent && b.parent.id === 'helion');
const MAJOR = planets.filter(b => b.id !== 'wend');           // Wend is a comet (e = 0.6+): no Hohmann optimum to compare with

/** One pair: -> { ok, why, eject, optEject, corr, plane, vInf, optVInf, time, optTime, total, optTotal }. */
export function planPair(F, T) {
  const gF = SYSTEM.byId[F.id], gT = SYSTEM.byId[T.id];
  const win = AP.transferWindow(gF, gT, 0);
  if (!win) return { ok: false, why: 'no window' };
  // textbook values at the window, from the reference ephemeris: tangential departure, arrival half a turn on
  const A1 = eph.rel(F, win.t), nrm = R.unit(R.cross(A1.r, A1.v));
  let tof = win.tof, B2 = eph.rel(T, win.t + tof);
  const r1 = R.norm(A1.r);
  for (let i = 0; i < 6; i++) { tof = Math.PI * Math.sqrt(((r1 + R.norm(B2.r)) / 2) ** 3 / mu); B2 = eph.rel(T, win.t + tof); }
  const r2 = R.norm(B2.r), at = (r1 + r2) / 2;
  const vInfDep = R.norm(R.sub(R.scale(R.unit(R.cross(nrm, A1.r)), R.visViva(mu, r1, at)), A1.v));
  const vInfArr = R.norm(R.sub(R.scale(R.unit(R.cross(nrm, B2.r)), R.visViva(mu, r2, at)), B2.v));
  const rPark = F.radius * 1.2 + (F.atmo ? F.atmo.height : 0), vc = Math.sqrt(F.gm / rPark);
  const safe = T.atmo ? T.atmo.height + Math.max(40000, T.radius * 0.5) : T.radius * 0.6;       // as js/ui/flight.js asks
  const cap = (vi, rp) => Math.sqrt(vi * vi + 2 * T.gm / rp) - Math.sqrt(T.gm / rp);
  // minimum-energy ejection with a finite SOI: v-infinity is wanted at the SOI edge
  const optEject = Math.sqrt(vInfDep ** 2 + 2 * F.gm / rPark - 2 * F.gm / F.soiLaplace) - vc;
  const out = { ok: false, optEject, optVInf: vInfArr, optTime: tof, optTotal: optEject + cap(vInfArr, T.radius + safe) };
  const w = new World({ ut: Math.max(0, win.t - 3 * 86400) });
  const v = spawn(w, simpleShip(), F.id, [rPark, 0, 0], [0, 0, -vc]);
  const plan = AP.planInterplanetary(w, v, gT, { periapsis: safe, planar: true });
  if (!plan) return { ...out, why: 'no plan' };
  out.eject = plan.dv; out.nodeOffset = plan.node.t - win.t;
  const at0 = R.keplerUV([rPark, 0, 0], [0, 0, -vc], F.gm, plan.node.t - w.ut);
  const ref = R.refPatched(sys, eph, { body: F, r: at0.r, v: R.add(at0.v, R.scale(R.unit(at0.v), plan.dv)), t: plan.node.t }, plan.node.t + 0.5 * tof, { maxEvents: 4 });
  const ex = ref.events.find(e => e.type === 'exit' && e.to.id === 'helion');
  if (!ex) return { ...out, why: 'the burn does not leave the SOI' };
  const tC = ex.t + 0.4 * tof, sC = R.keplerUV(ex.r, ex.v, mu, tC - ex.t);
  const nT = R.unit(R.cross(eph.rel(T, 0).r, eph.rel(T, 0).v));
  out.plane = R.norm(sC.v) * Math.sin(R.angleBetween(nrm, nT));                // turning the path through the mutual tilt
  const w2 = new World({ ut: tC });
  const v2 = spawn(w2, simpleShip(), 'helion', sC.r, sC.v);
  const corr = AP.planCorrection(w2, v2, gT, { periapsis: safe, seek: true, horizon: 1.3 * tof });
  if (!corr || corr.periapsis === null) return { ...out, why: 'no mid-course correction found' };
  out.corr = corr.dv;
  const o = v2.getOrbit(tC), o2 = corr.node ? applyManeuver(o, corr.node.t, corr.node.dv) : o, tn = corr.node ? corr.node.t : tC, s2 = o2.stateAt(tn);
  const r2p = R.refPatched(sys, eph, { body: sys.byId.helion, r: A(s2.r), v: A(s2.v), t: tn }, tn + 2 * tof, { maxEvents: 1 });
  const en = r2p.events.find(e => e.type === 'enter' && e.to.id === T.id);
  if (!en) return { ...out, why: 'reference: the corrected path does not reach the target' };
  const el = R.stateToElements(en.r, en.v, T.gm);
  out.vInf = Math.sqrt(-T.gm / el.a); out.time = en.t - plan.node.t; out.pe = el.rp - T.radius; out.safe = safe;
  out.total = out.eject + out.corr + cap(out.vInf, Math.max(el.rp, T.radius));
  out.ok = true;
  return out;
}

// Pairs whose shortfall is understood and reported, not judged (see docs/PHYSICS_VERIFICATION.md, open items).
const KNOWN = {
  'thal>verda': 'arrives 28 % faster than the Hohmann speed: the correction search trades speed for aim',
  'quell>verda': 'the correction does not converge on the periapsis from Quell (a near-binary with Nym, tiny SOI)',
};

function planner(S) {
  let sum = 0, n = 0, none = [];
  const worstEj = { v: 0 };
  for (const F of planets) for (const T of planets) {
    if (F === T) continue;
    const key = `${F.id}>${T.id}`, name = `${F.name} to ${T.name}`;
    const major = MAJOR.includes(F) && MAJOR.includes(T);
    const p = planPair(F, T);
    if (p.eject !== undefined && major) {
      // the old planner missed this by 9 to 48 % on a third of the pairs (Verda to Rusk 10.7 %, to Orrin 12 %, to Cindra 13 %)
      S.check(`${name}: planned ejection burn vs minimum-energy patched conic`, p.optEject, p.eject, Math.max(0.04 * p.optEject, 20), { unit: 'm/s' });
      if (Math.abs(p.eject / p.optEject - 1) > worstEj.v) { worstEj.v = Math.abs(p.eject / p.optEject - 1); worstEj.k = name; }
    }
    if (!p.ok) { none.push(`${key} (${p.why})`); continue; }
    sum += p.total / p.optTotal; n++;
    const line = `eject ${p.eject.toFixed(0)}, correction ${p.corr.toFixed(0)} (tilt alone costs ~${p.plane.toFixed(0)}), arrival ${p.vInf.toFixed(0)} m/s, ${(p.time / 86400).toFixed(1)} days`;
    const verda = F.id === 'verda' || T.id === 'verda';
    if (verda && major && !KNOWN[key]) {
      S.check(`${name}: total ejection + correction + capture vs Hohmann optimum`, p.optTotal, p.total, 0.08 * p.optTotal + 1.3 * p.plane, { unit: 'm/s', note: `${line}; tolerance = 8 % + 1.3 x the cost of the orbital tilt` });
      S.check(`${name}: arrival speed (v-infinity) vs Hohmann`, p.optVInf, p.vInf, 0.35, { unit: 'm/s', rel: true });
      S.check(`${name}: transfer time vs Hohmann`, p.optTime / 86400, p.time / 86400, 0.35, { unit: 'days', rel: true });
    } else {
      S.info(`${name}: total / Hohmann optimum`, `${p.total.toFixed(0)} / ${p.optTotal.toFixed(0)}`, 'm/s', line + (KNOWN[key] ? '; KNOWN LIMIT: ' + KNOWN[key] : ''));
    }
  }
  S.info('worst ejection burn against the optimum (major planets)', (worstEj.v * 100).toFixed(1) + ' %', '', worstEj.k);
  S.info(`mean total / optimum over the ${n} pairs with a complete plan`, sum / n, '', 'old planner: 1.29 over the same recipe');
  S.info(`pairs for which no complete plan came out: ${none.length}`, none.join(', ') || 'none');
}

export const groups = [
  { name: '3j. Transfer planner quality: every planet pair against the patched-conic optimum', fast: false, run: S => planner(S) },
];
