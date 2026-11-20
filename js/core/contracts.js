// Starwright contracts: a board of offered jobs, objective tracking from World events, rewards and penalties.
// PURE LOGIC - no DOM. Runs under Node. Owned by Career (career.contracts); serialised inside the career save.
//
//   board.offered / active / completed / failed       arrays of contract records (plain JSON)
//   board.refresh()                                    expire stale offers and deadlines, top the board up to 3-5 offers
//   board.accept(id) / decline(id) / cancel(id)        → {ok, reason?, contract?}
//   board.onEvent(type, payload, world, vessel)        → notices [{kind:'contract', outcome, title, funds, science, rep, …}]
//   board.noteScience(experiment, bodyId, situation)   called by Career.creditScience (transmissions and recoveries)
//
// Contract record:
//   { id, type, key, title, text, agency, bodyId, difficulty, objectives: [{kind, label, done, …params}],
//     advance, reward: {funds, science, rep}, penalty: {funds, rep}, days (deadline length in Verda days | null),
//     offeredAt, expiresAt, acceptedAt, deadlineAt, state: 'offered'|'active'|'completed'|'failed', closedAt, reason }
import { PARTS } from './parts.js';
import { SYSTEM } from './bodies.js';

export const CONTRACT_VERSION = 1;
export const VERDA_DAY = 19800;                 // seconds
export const HISTORY_LIMIT = 40;
export const ADVANCE_SHARE = 0.25;              // part of the total fee paid on signing
const HOME = 'verda';

// ---------------------------------------------------------------------------------------------
// Reputation
// ---------------------------------------------------------------------------------------------
/** Funds multiplier applied to contract fees: +0.4 % per reputation point, capped at +30 %, never below −10 %. */
export function repFundsFactor(rep = 0) {
  const r = Number(rep) || 0;
  return Math.round((1 + Math.min(Math.max(r, -25), 75) * 0.004) * 1000) / 1000;
}
/** How many contracts may be active at once (3, growing to 5 with reputation). */
export function maxActiveFor(rep = 0) { return 3 + (rep >= 30 ? 1 : 0) + (rep >= 70 ? 1 : 0); }
/** How many offers the board keeps posted (3, growing to 5 with reputation). */
export function offerCountFor(rep = 0) { return 3 + (rep >= 15 ? 1 : 0) + (rep >= 45 ? 1 : 0); }

// ---------------------------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------------------------
const idOf = b => (b == null ? null : (typeof b === 'string' ? b : (b.id ?? null)));
const bodyName = id => (SYSTEM.byId[id] ? SYSTEM.byId[id].name : String(id));
const km = m => (Math.round(m / 100) / 10).toLocaleString('en-US') + ' km';
const round = (x, step) => Math.round(x / step) * step;
const SITUATION_TEXT = {
  landed: 'landed on', splashed: 'floating in the seas of', flyingLow: 'flying low over', flyingHigh: 'flying high over',
  spaceLow: 'in low space near', spaceHigh: 'in high space above',
};

function mulberry(state) {
  let a = state >>> 0;
  a = (a + 0x6D2B79F5) >>> 0;
  let t = a;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return { state: a, value: ((t ^ (t >>> 14)) >>> 0) / 4294967296 };
}

function crewNames(vessel) {
  if (!vessel) return [];
  if (Array.isArray(vessel.crew)) return vessel.crew;
  const out = [];
  const parts = vessel.parts instanceof Map ? vessel.parts.values() : (Array.isArray(vessel.parts) ? vessel.parts : []);
  for (const p of parts) if (p && !p.destroyed && Array.isArray(p.crew)) out.push(...p.crew);
  return out;
}
function partDefs(vessel) {
  const out = [];
  if (!vessel) return out;
  const parts = vessel.parts instanceof Map ? vessel.parts.values() : (Array.isArray(vessel.parts) ? vessel.parts : []);
  for (const p of parts) {
    if (!p || p.destroyed) continue;
    const def = p.def || PARTS[p.type];
    if (def) out.push(def);
  }
  return out;
}
function altitudeOf(v) {
  if (Number.isFinite(v.altitude)) return v.altitude;
  if (v.pos && typeof v.pos.length === 'function' && v.body) return v.pos.length() - (v.body.radius || 0);
  return 0;
}
function speedOf(v) {
  if (Number.isFinite(v.airspeed)) return v.airspeed;
  if (v.surfaceVel && typeof v.surfaceVel.length === 'function') return v.surfaceVel.length();
  if (v.vel && typeof v.vel.length === 'function') return v.vel.length();
  return 0;
}
const grounded = v => !!(v.landed || v.splashed) || ['prelaunch', 'landed', 'splashed'].includes(v.situation);

/** Apoapsis / periapsis altitudes (m) and inclination (deg) of a vessel's current orbit, or null. */
export function orbitInfo(vessel, world) {
  if (!vessel || !vessel.body) return null;
  let o = null;
  try {
    if (typeof vessel.getOrbit === 'function') o = vessel.getOrbit(world && Number.isFinite(world.ut) ? world.ut : 0);
  } catch { o = null; }
  if (!o) o = vessel.orbit;
  if (!o || !Number.isFinite(o.periapsis)) return null;
  const R = vessel.body.radius || 0;
  const inc = Number.isFinite(o.inclination) ? o.inclination * 180 / Math.PI : 0;
  return { ap: o.apoapsis - R, pe: o.periapsis - R, inc };
}

// ---------------------------------------------------------------------------------------------
// Destinations and what the program can currently reach
// ---------------------------------------------------------------------------------------------
// fee: funds multiplier, sci: science multiplier, days: default deadline, low/high: sensible orbit band (m)
const DEST = {
  verda: { fee: 1, sci: 1, days: 30, low: [85e3, 140e3], high: [260e3, 600e3] },
  pell: { fee: 2.2, sci: 3, days: 90, low: [12e3, 50e3], high: [70e3, 200e3] },
  ost: { fee: 2.8, sci: 4, days: 140, low: [8e3, 25e3], high: [35e3, 90e3] },
  rusk: { fee: 6, sci: 7, days: 1400, low: [55e3, 120e3], high: [160e3, 500e3] },
  cindra: { fee: 7, sci: 8, days: 1400, low: [20e3, 55e3], high: [70e3, 250e3] },
  thal: { fee: 9, sci: 10, days: 3200, low: [450e3, 900e3], high: [2.2e6, 5e6] },
  tiv: { fee: 10, sci: 11, days: 3200, low: [15e3, 70e3], high: [90e3, 300e3] },
};

// Every other body of the system gets a row derived from its own numbers.
for (const b of SYSTEM.bodies) {
  if (b.type === 'star' || DEST[b.id]) continue;
  const m = Number.isFinite(b.sciMult) ? b.sciMult : 6;
  const border = b.spaceBorder || b.radius * 0.4;
  const floor = Math.max(b.atmo ? b.atmo.height * 1.15 : 0, (b.maxElevation || 0) + 3000, border * 0.2);
  const lowTop = Math.max(border, floor * 1.6), soi = Number.isFinite(b.soi) ? b.soi : border * 20;
  const hi0 = Math.min(lowTop * 1.4, soi * 0.3), hi1 = Math.max(Math.min(lowTop * 5, soi * 0.6), hi0 * 1.5);
  const sma = b.parent && b.parent.type !== 'star' ? b.parent.orbit.a : b.orbit.a;
  DEST[b.id] = { fee: Math.max(2, m), sci: m + 1, days: sma < 3e10 ? 1400 : sma < 1e11 ? 3200 : 6000, low: [floor, lowTop], high: [hi0, hi1] };
}

/** What a career can plausibly do right now. Everything the generator offers is derived from this. */
export function capability(career) {
  const ms = id => career.milestones.has(id);
  const tech = id => career.mode === 'sandbox' || career.tech.has(id);
  const liquid = tech('basic_rocketry');
  const orbitCapable = liquid && (ms('reach_space') || tech('propulsion'));
  const cap = {
    ms, tech, unlocked: id => career.isPartUnlocked(id),
    space: ms('reach_space'), orbit: ms('orbit_verda'), orbitCapable,
    probes: tech('electrics'),                            // probe core + antenna + solar panel
    legs: tech('landing'),
    reach: new Set([HOME]),                               // bodies whose space the program can get to
    land: new Set(),                                      // bodies it can set down on
  };
  if (ms('orbit_verda') && tech('propulsion')) { cap.reach.add('pell'); cap.reach.add('ost'); }
  if (ms('pell_flyby')) cap.reach.add('pell');
  if (ms('ost_flyby')) cap.reach.add('ost');
  if ((ms('pell_flyby') || ms('ost_flyby')) && tech('heavy')) { cap.reach.add('rusk'); cap.reach.add('cindra'); }
  if (ms('escape_verda')) { cap.reach.add('rusk'); cap.reach.add('cindra'); }
  if ((ms('rusk_flyby') || ms('cindra_flyby')) && tech('heavy')) { cap.reach.add('thal'); cap.reach.add('tiv'); }
  if (ms('thal_flyby')) { cap.reach.add('thal'); cap.reach.add('tiv'); }
  // the wider system: near planets open up like Rusk and Cindra, far ones like Thal; a moon once its planet has been visited
  const nearOk = cap.reach.has('rusk'), farOk = cap.reach.has('thal');
  for (const b of SYSTEM.bodies) {
    if (b.type === 'star' || cap.reach.has(b.id)) continue;
    const moon = b.parent && b.parent.type !== 'star';
    if (ms(b.id + '_flyby')) cap.reach.add(b.id);
    else if (moon) { if (b.parent.id !== HOME && (ms(b.parent.id + '_flyby') || (cap.reach.has(b.parent.id) && farOk))) cap.reach.add(b.id); }
    else if ((b.sciMult || 0) <= 8 ? nearOk : farOk) cap.reach.add(b.id);
  }
  for (const body of SYSTEM.bodies) {
    const b = body.id;
    if (body.type === 'star' || body.gas || b === HOME) continue;
    const par = body.parent && body.parent.type !== 'star' && body.parent.id !== HOME ? body.parent.id : null;
    const flown = ms(b + '_flyby') || ms(b + '_orbit') || ms(b + '_landing') || (par && ms(par + '_flyby'));
    if (cap.reach.has(b) && flown && (cap.legs || ms(b + '_landing'))) cap.land.add(b);
  }
  cap.seats = 0;
  for (const id in PARTS) { const d = PARTS[id]; if (d.command === 'crew' && d.crew > cap.seats && cap.unlocked(id)) cap.seats = d.crew; }
  cap.wheels = Object.values(PARTS).some(d => d.wheel && d.wheel.drive > 0 && cap.unlocked(d.id));
  cap.docking = Object.values(PARTS).some(d => d.dock && cap.unlocked(d.id));
  return cap;
}

// ---------------------------------------------------------------------------------------------
// Templates. make(cap, R) → {key, bodyId, title, text, agency, objectives, funds, science, rep, days} | null
// R = { pick(arr), range(lo, hi), chance(p) } drawing from the board's seeded generator.
// ---------------------------------------------------------------------------------------------
const TEST_PARTS = {
  // part: [altLo, altHi (km band the window is placed in), window height km, spdLo, spdHi, fee]
  srb_ember: [5, 16, 5, 120, 480, 1500],
  chute: [1, 6, 3, 40, 260, 1300],
  dec_m: [14, 36, 8, 200, 800, 1600],
  eng_goshawk: [4, 14, 5, 100, 450, 2200],
  srb_maul: [4, 12, 5, 100, 400, 2400],
  eng_sparrow: [32, 62, 12, 500, 1500, 3000],
  dec_radial: [6, 20, 6, 200, 600, 2400],
  chute_radial: [1, 6, 3, 40, 260, 2000],
  eng_moth: [45, 70, 12, 600, 1800, 3200],
  eng_condor: [3, 10, 5, 80, 380, 5200],
};
const TEST_WHO = ['Halloway Fireworks & Sons', 'The Bench Test Guild', 'Tumble & Pike Hardware', 'Verda Standards Office'];
const TEST_TEXT = [
  (part, who) => `${who} built the ${part} and would like to see it work somewhere more exciting than a test bench. Fire it by staging inside the window below.`,
  (part, who) => `The paperwork for the ${part} has one empty box left: "tested in flight". ${who} will pay to have it ticked. Stage it inside the window below.`,
  (part, who) => `${who} have a wager riding on whether the ${part} behaves itself at altitude. Settle it: stage the part inside the window below.`,
];

function fee(base, bodyId) { return base * (DEST[bodyId] ? DEST[bodyId].fee : 1); }
function sci(base, bodyId) { return base * (DEST[bodyId] ? DEST[bodyId].sci : 1); }
function awayBodies(cap, set = cap.reach) { return [...set].filter(b => b !== HOME); }

const TEMPLATES = [
  { type: 'reach', weight: cap => (cap.orbit ? 0.3 : cap.space ? 1 : 3),
    make(cap, R) {
      const steps = cap.orbit ? [400e3, 700e3, 1.2e6] : cap.space ? [110e3, 180e3, 300e3] : [12e3, 22e3, 35e3, 50e3];
      const alt = R.pick(steps);
      const hard = steps.indexOf(alt) / steps.length;
      const title = R.pick(alt >= 72e3 ? ['Where the Blue Runs Out', 'A Long Way Up', 'Thin Air Survey'] : ['Higher Than the Kites', 'A Better View', 'Ceiling Check']);
      return { key: 'reach:' + alt, bodyId: HOME, title, agency: 'Verda Weather Office',
        text: `The Weather Office has balloons that reach a respectable height and would like to be embarrassed. Carry a Pip above ${km(alt)} over Verda. What happens afterwards is your business.`,
        objectives: [{ kind: 'reach', bodyId: HOME, altMin: alt, crew: 1, label: `Carry a Pip above ${km(alt)} over Verda` }],
        funds: (cap.space ? 2200 : 1200) * (1 + hard), science: cap.space ? 3 : 1.5, rep: 1, days: 20 };
    } },

  { type: 'test', weight: cap => (cap.orbit ? 1.2 : 2.5),
    make(cap, R) {
      const parts = Object.keys(TEST_PARTS).filter(id => PARTS[id] && cap.unlocked(id));
      if (!parts.length) return null;
      const part = R.pick(parts);
      const [lo, hi, win, s0, s1, base] = TEST_PARTS[part];
      const altMin = Math.round(R.range(lo, hi - win)) * 1000, altMax = altMin + win * 1000;
      const mid = R.range(s0 + (s1 - s0) * 0.3, s0 + (s1 - s0) * 0.7), half = Math.max(90, (s1 - s0) * 0.3);
      const spdMin = Math.max(0, round(mid - half, 10)), spdMax = round(mid + half, 10);
      const who = R.pick(TEST_WHO), name = PARTS[part].name;
      return { key: 'test:' + part, bodyId: HOME, title: 'Field Test: ' + name, agency: who,
        text: R.pick(TEST_TEXT)(name, who),
        objectives: [{ kind: 'stageTest', part, bodyId: HOME, altMin, altMax, spdMin, spdMax,
          label: `Stage the ${name} between ${km(altMin)} and ${km(altMax)} over Verda at ${spdMin}–${spdMax} m/s` }],
        funds: base, science: 2, rep: 1, days: 25 };
    } },

  { type: 'science', weight: () => 2,
    make(cap, R) {
      const options = [[HOME, 'flyingLow'], [HOME, 'flyingHigh'], [HOME, 'splashed']];
      if (cap.space) options.push([HOME, 'spaceLow'], [HOME, 'spaceLow']);
      if (cap.orbit) options.push([HOME, 'spaceHigh'], [HOME, 'spaceHigh']);
      for (const b of awayBodies(cap)) { options.push([b, 'spaceHigh'], [b, 'spaceLow']); if (b === 'rusk') options.push([b, 'flyingHigh']); }
      for (const b of cap.land) options.push([b, 'landed'], [b, 'landed']);
      const [bodyId, situation] = R.pick(options.slice(-Math.max(4, Math.ceil(options.length * 0.6))));
      const where = `${SITUATION_TEXT[situation]} ${bodyName(bodyId)}`;
      const base = { flyingLow: 1300, flyingHigh: 1600, splashed: 1500, spaceLow: 2600, spaceHigh: 3600, landed: 5200 }[situation];
      const title = R.pick(bodyId === HOME ? ['Notes From Up There', 'Fill In the Blank', 'The Almanac Needs a Page'] : [`Dispatches From ${bodyName(bodyId)}`, `What Is ${bodyName(bodyId)} Like?`, 'Far-Flung Footnotes']);
      return { key: `science:${bodyId}:${situation}`, bodyId, title, agency: 'The Skyward Almanac',
        text: `The Almanac's next edition has a blank page headed "${where}". Run any experiment while ${where}, then bring the result home or transmit it.`,
        objectives: [{ kind: 'science', bodyId, situation, label: `Deliver an experiment result taken while ${where}` }],
        funds: fee(base, bodyId), science: sci(situation === 'landed' ? 4 : 2, bodyId), rep: bodyId === HOME ? 1 : 3, days: DEST[bodyId].days };
    } },

  { type: 'flag', weight: cap => (cap.land.size ? 1.2 : cap.ms('flag_verda') ? 0.25 : 0.8),
    make(cap, R) {
      const bodyId = cap.land.size && R.chance(0.85) ? R.pick([...cap.land]) : HOME;
      const home = bodyId === HOME;
      return { key: 'flag:' + bodyId, bodyId, title: home ? R.pick(['A Flag for the Brochure', 'Somewhere Scenic']) : R.pick([`Colours on ${bodyName(bodyId)}`, 'Proof We Were Here']),
        agency: home ? 'Verda Tourist Board' : 'The Founders\' Circle',
        text: home
          ? 'The Tourist Board wants a photograph of a Pip planting a flag somewhere on Verda. Anywhere will do. They have not been specific and you should not ask.'
          : `The Founders' Circle paid for half the hangar roof and would like something to point at. Land on ${bodyName(bodyId)}, send a Pip outside and plant a flag.`,
        objectives: [{ kind: 'flag', bodyId, label: `Plant a flag on ${bodyName(bodyId)}` }],
        funds: home ? 900 : fee(6500, bodyId), science: home ? 0 : sci(2, bodyId), rep: home ? 1 : 5, days: home ? 20 : DEST[bodyId].days };
    } },

  { type: 'recover', weight: cap => (cap.space ? 1.4 : 0),
    make(cap, R) {
      const options = [{ been: { space: true }, what: 'has flown in space', base: 2600, rep: 2 }];
      if (cap.orbit) options.push({ been: { orbit: HOME }, what: 'has orbited Verda', base: 4200, rep: 3 });
      for (const b of awayBodies(cap)) options.push({ been: { visit: b }, bodyId: b, what: `has flown past ${bodyName(b)}`, base: fee(5200, b), rep: 5 });
      for (const b of cap.land) options.push({ been: { land: b }, bodyId: b, what: `has stood on ${bodyName(b)}`, base: fee(8200, b), rep: 8 });
      const o = R.pick(options.slice(-3));
      const bodyId = o.bodyId || HOME;
      return { key: 'recover:' + JSON.stringify(o.been), bodyId, title: R.pick(['Museum Piece', 'Slightly Used, Much Travelled', 'An Exhibit With Scorch Marks']),
        agency: 'Verda Museum of Going Up',
        text: `The Museum wants a real vessel for its main hall: one that ${o.what}. Fly it there, bring it back to Verda in one piece and recover it. Scorch marks add value.`,
        objectives: [{ kind: 'recover', been: o.been, label: `Recover on Verda a vessel that ${o.what}` }],
        funds: o.base, science: bodyId === HOME ? 2 : sci(2, bodyId), rep: o.rep, days: DEST[bodyId].days };
    } },

  { type: 'orbit', weight: cap => (cap.orbitCapable ? 1.6 : 0),
    make(cap, R) {
      const bodies = [...cap.reach].filter(b => b === HOME ? cap.orbitCapable : true);
      if (!bodies.length) return null;
      const bodyId = cap.orbit ? R.pick(bodies) : HOME;
      const d = DEST[bodyId], name = bodyName(bodyId);
      const ecc = cap.orbit && R.chance(0.4);
      let apMin, apMax, peMin, peMax;
      if (ecc) {
        peMin = round(R.range(d.low[0], (d.low[0] + d.low[1]) / 2), 1000); peMax = round(peMin + (d.low[1] - d.low[0]) * 0.6, 1000);
        apMin = round(R.range(d.high[0], (d.high[0] + d.high[1]) / 2), 5000); apMax = round(apMin + (d.high[1] - d.high[0]) * 0.4, 5000);
      } else {
        peMin = round(R.range(d.low[0], (d.low[0] + d.low[1]) / 2), 1000); peMax = Infinity;
        apMin = peMin; apMax = round(peMin + Math.max((d.low[1] - d.low[0]) * 0.7, 20e3), 1000);
      }
      const label = ecc
        ? `Orbit ${name} with apoapsis ${km(apMin)}–${km(apMax)} and periapsis ${km(peMin)}–${km(peMax)}`
        : `Orbit ${name} entirely between ${km(peMin)} and ${km(apMax)}`;
      return { key: `orbit:${bodyId}:${ecc ? 'e' : 'c'}`, bodyId,
        title: ecc ? R.pick(['The Long Way Round', 'Egg-Shaped, Please']) : R.pick(['A Tidy Circle', 'Keep It Level', 'Round and Round']),
        agency: 'Institute of Things Overhead',
        text: ecc
          ? `The Institute is studying how orbits stretch. Put any vessel into a lopsided orbit of ${name}: high at one end, low at the other, within the limits below.`
          : `The Institute wants a clean reference orbit of ${name} to check its sums against. Any vessel will do, as long as the whole orbit stays inside the band below.`,
        objectives: [{ kind: 'orbit', bodyId, apMin, apMax, peMin, peMax: Number.isFinite(peMax) ? peMax : null, hold: 2, label }],
        funds: fee(ecc ? 5200 : 4200, bodyId), science: sci(3, bodyId), rep: bodyId === HOME ? 3 : 6, days: d.days };
    } },

  { type: 'tour', weight: cap => (cap.space ? 1.2 : 0),
    make(cap, R) {
      const options = [{ been: { space: true }, what: 'to space', base: 3000, rep: 3 }];
      if (cap.orbit) options.push({ been: { orbit: HOME }, what: 'into orbit of Verda', base: 5200, rep: 4 });
      for (const b of awayBodies(cap)) if (b === 'pell' || b === 'ost') options.push({ been: { visit: b }, bodyId: b, what: `past ${bodyName(b)}`, base: fee(5600, b), rep: 7 });
      const o = R.pick(options.slice(-2));
      const bodyId = o.bodyId || HOME;
      const guest = R.pick(['a retired schoolteacher', 'the mayor\'s nephew', 'a travel writer', 'a very calm accountant', 'a competition winner']);
      return { key: 'tour:' + JSON.stringify(o.been), bodyId, title: R.pick(['Window Seat', 'The Scenic Route', 'Round Trip, No Luggage']), agency: 'Quillfeather Tours',
        text: `Quillfeather Tours has sold a ticket to ${guest} and has no rocket. Fly a crewed vessel ${o.what} and bring everyone home to Verda. The refund policy is strict.`,
        objectives: [
          { kind: 'achieve', been: o.been, crew: 1, label: `Fly a crewed vessel ${o.what}` },
          { kind: 'recover', been: o.been, crew: 1, label: 'Recover that vessel on Verda with its crew aboard' }],
        funds: o.base, science: 0, rep: o.rep, days: DEST[bodyId].days };
    } },

  { type: 'satellite', weight: cap => (cap.probes && cap.orbitCapable ? 1.8 : 0),
    make(cap, R) {
      const bodies = [...cap.reach].filter(b => b !== 'thal' || cap.ms('thal_flyby'));
      const bodyId = cap.orbit && bodies.length > 1 && R.chance(0.5) ? R.pick(bodies.filter(b => b !== HOME)) : HOME;
      const d = DEST[bodyId], name = bodyName(bodyId);
      const high = R.chance(0.5);
      const band = high ? d.high : d.low;
      const alt = round(R.range(band[0] * 1.05, band[1] * 0.8), high ? 10000 : 5000);
      const tol = Math.max(round(alt * 0.12, 1000), 8000);
      const polar = cap.orbit && R.chance(0.2);
      const incMin = polar ? 75 : 0, incMax = polar ? 105 : 10;
      const who = R.pick(['Brightline Telegraph Co.', 'Verda Weather Office', 'Pellwatch Society']);
      return { key: `satellite:${bodyId}:${high ? 'h' : 'l'}${polar ? 'p' : ''}`, bodyId,
        title: R.pick(polar ? ['Over the Top', 'Pole to Pole'] : ['A Relay in the Sky', 'Hold That Spot', 'Dots and Dashes']), agency: who,
        text: `${who} needs a relay over ${name}. Deliver an uncrewed vessel with an antenna and solar power into the orbit below, then leave it there with its engines off.`,
        objectives: [{ kind: 'orbit', bodyId, apMin: alt - tol, apMax: alt + tol, peMin: alt - tol, peMax: alt + tol, incMin, incMax,
          uncrewed: true, needs: ['antenna', 'solar'], hold: 4,
          label: `Park an uncrewed vessel with an antenna and a solar panel around ${name} at ${km(alt)} ± ${km(tol)}, inclination ${polar ? '75–105°' : 'under 10°'}` }],
        funds: fee(polar ? 9000 : 7000, bodyId), science: sci(3, bodyId), rep: bodyId === HOME ? 4 : 8, days: d.days };
    } },

  { type: 'explore', weight: cap => (cap.orbit ? 1.6 : 0),
    make(cap, R) {
      const options = [];
      for (const b of awayBodies(cap)) options.push({ kind: 'flyby', b });
      for (const b of cap.land) options.push({ kind: 'land', b }, { kind: 'land', b });
      if (!options.length) return null;
      const o = R.pick(options);
      const name = bodyName(o.b), land = o.kind === 'land';
      return { key: `${o.kind}:${o.b}`, bodyId: o.b,
        title: land ? R.pick([`Feet on ${name}`, 'Down Gently', `${name}, Up Close`]) : R.pick([`A Look at ${name}`, 'Passing Acquaintance', `Wave at ${name}`]),
        agency: o.b === 'pell' ? 'Pellwatch Society' : o.b === 'ost' ? 'Ost Ice Club' : 'Outer Worlds Survey',
        text: land
          ? `Telescopes only go so far. The ${o.b === 'ost' ? 'Ice Club' : 'Society'} wants a vessel set down on ${name}, upright or otherwise, as long as it survives the arrival.`
          : `Nobody has had a proper look at ${name} from close by. Send any vessel into its sphere of influence. A wave is optional.`,
        objectives: [{ kind: o.kind, bodyId: o.b, label: land ? `Land a vessel on ${name}` : `Fly a vessel into the sphere of influence of ${name}` }],
        funds: fee(land ? 7500 : 3800, o.b), science: sci(land ? 4 : 2, o.b), rep: land ? 8 : 4, days: DEST[o.b].days };
    } },

  // ---- second pass ----
  { type: 'tourists', weight: cap => (cap.space && cap.seats >= 2 ? 1.1 : 0),
    make(cap, R) {
      const n = Math.min(cap.seats - 1, R.pick([1, 2, 2, 3]));
      const options = [{ been: { space: true }, what: 'to space', base: 2400, rep: 3 }];
      if (cap.orbit) options.push({ been: { orbit: HOME }, what: 'into orbit of Verda', base: 4200, rep: 5 });
      for (const b of awayBodies(cap)) if (DEST[b].fee < 6) options.push({ been: { visit: b }, bodyId: b, what: `past ${bodyName(b)}`, base: fee(4600, b), rep: 8 });
      const o = R.pick(options.slice(-2));
      const bodyId = o.bodyId || HOME;
      const party = n === 1 ? 'one paying passenger' : `a party of ${n} paying passengers`;
      return { key: `tourists:${n}:` + JSON.stringify(o.been), bodyId, title: R.pick(['Group Booking', 'Everyone Wants the Window', 'The Grand Excursion']), agency: 'Quillfeather Tours',
        text: `Quillfeather Tours has ${party} and a brochure that promises a trip ${o.what}. Fly a vessel with at least ${n + 1} Pips aboard (a pilot and the guests), and bring every one of them home to Verda.`,
        objectives: [
          { kind: 'achieve', been: o.been, crew: n + 1, label: `Fly a vessel carrying at least ${n + 1} Pips ${o.what}` },
          { kind: 'recover', been: o.been, crew: n + 1, label: `Recover that vessel on Verda with at least ${n + 1} Pips aboard` }],
        guests: n, funds: o.base * (1 + 0.55 * n), science: 0, rep: o.rep + n, days: DEST[bodyId].days };
    } },

  { type: 'rescue', weight: cap => (cap.orbit ? 0.9 : 0),
    make(cap, R) {
      const bodies = [HOME, ...awayBodies(cap).filter(b => DEST[b].fee < 6 && !SYSTEM.byId[b].gas)];
      const bodyId = R.chance(0.65) ? HOME : R.pick(bodies);
      const d = DEST[bodyId], name = bodyName(bodyId);
      const alt = round(R.range(d.low[0] * 1.1, d.low[1]), 1000);
      const pip = R.pick(RESCUE_NAMES);
      return { key: 'rescue:' + bodyId, bodyId, title: R.pick([`Fetch ${pip}`, 'Somebody Is Still Up There', 'One Seat Short']), agency: 'Verda Search and Recovery',
        text: `${pip} went up in a borrowed pod that had an engine on the way there and does not have one now. The pod is circling ${name} at about ${km(alt)}. Meet it, bring ${pip} across to your vessel (a spacewalk will do it) and land them on Verda.`,
        spawn: { kind: 'stranded', bodyId, alt, name: pip },
        objectives: [{ kind: 'rescue', name: pip, label: `Recover a vessel on Verda with ${pip} aboard` }],
        funds: fee(7800, bodyId), science: 0, rep: bodyId === HOME ? 6 : 10, days: Math.max(d.days, 60) };
    } },

  { type: 'rover', weight: cap => (cap.wheels ? 1.3 : 0),
    make(cap, R) {
      const bodyId = cap.land.size && R.chance(0.6) ? R.pick([...cap.land]) : HOME;
      const home = bodyId === HOME, name = bodyName(bodyId);
      const distance = R.pick(home ? [1000, 2000, 3000] : [500, 1000, 1500]);
      return { key: `rover:${bodyId}:${distance}`, bodyId, title: R.pick(['Tyre Marks', 'The Scenic Drive', `Wheels on ${name}`]), agency: 'Outer Worlds Survey',
        text: `The Survey wants ground truth: a wheeled vessel driven across ${name}, with the odometer to prove it. Cover ${km(distance)} on powered wheels. Jumps do not count, however impressive.`,
        objectives: [{ kind: 'drive', bodyId, distance, driven: 0, label: `Drive a wheeled vessel ${km(distance)} across the surface of ${name}` }],
        funds: home ? 2600 + distance : fee(6000 + 2 * distance, bodyId), science: home ? 2 : sci(3, bodyId), rep: home ? 2 : 7, days: home ? 30 : DEST[bodyId].days };
    } },

  { type: 'station', weight: cap => (cap.orbit && cap.docking && cap.probes ? 1 : 0),
    make(cap, R) {
      const bodies = [...cap.reach].filter(b => !SYSTEM.byId[b].gas || cap.ms(b + '_flyby'));
      const bodyId = bodies.length > 1 && R.chance(0.35) ? R.pick(bodies.filter(b => b !== HOME)) : HOME;
      const d = DEST[bodyId], name = bodyName(bodyId);
      const seats = Math.max(2, Math.min(cap.seats * 2, R.pick([3, 4, 6])));
      return { key: 'station:' + bodyId, bodyId, title: R.pick(['A Porch in the Sky', 'Some Assembly Required', `${name} Station`]), agency: 'Institute of Things Overhead',
        text: `The Institute wants somewhere to stay. Assemble a station in orbit of ${name}: at least two vessels docked together, seats for ${seats}, its own power and an antenna. It must hold its orbit with the engines off.`,
        objectives: [{ kind: 'station', bodyId, seats, ports: 2, peMin: d.low[0], hold: 3,
          label: `Dock together a station in orbit of ${name} above ${km(d.low[0])}: seats for ${seats}, power, an antenna` }],
        funds: fee(14000 + 1500 * seats, bodyId), science: sci(4, bodyId), rep: bodyId === HOME ? 8 : 14, days: Math.max(d.days, 80) };
    } },
];
const RESCUE_NAMES = ['Pim Castaway', 'Old Tobble', 'Greta Longwait', 'Sully Driftwood', 'Marnie Halfway', 'Cob Stranding'];
export const CONTRACT_TYPES = TEMPLATES.map(t => t.type);

// ---------------------------------------------------------------------------------------------
// Objective evaluation
// ---------------------------------------------------------------------------------------------
function beenOk(been, log) {
  if (!been) return true;
  if (!log) return false;
  if (been.space && !log.reachedSpace) return false;
  if (been.orbit && !(log.orbited || []).includes(been.orbit)) return false;
  if (been.visit && !(log.visited || []).includes(been.visit) && !(log.landedOn || []).includes(been.visit)) return false;
  if (been.land && !(log.landedOn || []).includes(been.land)) return false;
  return true;
}
const sciMatch = (o, r) => r && r.bodyId === o.bodyId && r.situation === o.situation && (!o.experiment || r.experiment === o.experiment);
const tracked = v => v && v.type !== 'debris' && v.type !== 'flag';

// → true when the objective is satisfied by this event.
function evaluate(o, ev) {
  const { type, p, vessel, world, log } = ev;
  switch (o.kind) {
    case 'reach':
      if (!tracked(vessel) || vessel.type === 'eva' || grounded(vessel) || idOf(vessel.body) !== o.bodyId) return false;
      if (o.crew && crewNames(vessel).length < o.crew) return false;
      return altitudeOf(vessel) >= o.altMin;
    case 'stageTest': {
      if (type !== 'stage' || !tracked(vessel) || idOf(vessel.body) !== o.bodyId) return false;
      const ids = (vessel.stages && vessel.stages[p.stage]) || [];
      const types = ev.partTypes || new Map();
      const hit = ids.some(id => {
        const part = vessel.parts instanceof Map ? vessel.parts.get(id) : null;
        return (part && part.def ? part.def.id : types.get(id)) === o.part;
      });
      if (!hit) return false;
      const alt = altitudeOf(vessel), spd = speedOf(vessel);
      return alt >= o.altMin && alt <= o.altMax && spd >= o.spdMin && spd <= o.spdMax;
    }
    case 'orbit': {
      if (type !== 'tick') return false;
      let ok = tracked(vessel) && vessel.type !== 'eva' && vessel.situation === 'orbit' && idOf(vessel.body) === o.bodyId;
      const info = ok ? orbitInfo(vessel, world) : null;
      ok = ok && !!info && info.ap >= o.apMin && info.ap <= o.apMax && info.pe >= o.peMin && (o.peMax == null || info.pe <= o.peMax);
      if (ok && o.incMax != null) ok = info.inc >= (o.incMin || 0) && info.inc <= o.incMax;
      if (ok && o.uncrewed) ok = crewNames(vessel).length === 0 && !(vessel.thrust > 0);
      if (ok && o.needs) { const defs = partDefs(vessel); ok = o.needs.every(n => defs.some(d => d[n])); }
      o.held = ok ? (o.held || 0) + 1 : 0;
      return o.held >= (o.hold || 1);
    }
    case 'flyby':
      if (type === 'soi' && idOf(p.to) === o.bodyId && (!vessel || tracked(vessel))) return true;
      return tracked(vessel) && idOf(vessel.body) === o.bodyId;
    case 'land':
      return tracked(vessel) && vessel.type !== 'eva' && idOf(vessel.body) === o.bodyId && vessel.situation !== 'prelaunch'
        && (type === 'landed' || type === 'splashed' || !!(vessel.landed || vessel.splashed));
    case 'science':
      if (type === 'credit') return sciMatch(o, p.record);
      if (type === 'recovered') return ((p.summary && p.summary.science) || []).some(r => sciMatch(o, r));
      return false;
    case 'flag':
      return (type === 'flag' || type === 'flagPlanted' || type === 'plantFlag')
        && idOf(p.body ?? (p.flag && (p.flag.body ?? p.flag.bodyId)) ?? (vessel && vessel.body)) === o.bodyId;
    case 'rescue': {
      if (type !== 'recovered' || !vessel) return false;
      const crew = (p.summary && p.summary.crew) || crewNames(vessel);
      return crew.includes(o.name);
    }
    case 'drive': {
      if (type !== 'tick' || !tracked(vessel) || vessel.type === 'eva' || idOf(vessel.body) !== o.bodyId) return false;
      const onGround = !!vessel.landed || (vessel.wheelsOnGround > 0);
      if (!onGround || !partDefs(vessel).some(d => d.wheel && d.wheel.drive > 0)) { o.at = null; return false; }
      // where it stands, as a body-fixed direction
      let dir = vessel.landed && vessel.surface && vessel.surface.dir ? vessel.surface.dir : null;
      if (!dir && vessel.pos && typeof vessel.body.inertialToSurfaceDir === 'function') {
        const r = vessel.pos.length();
        dir = vessel.body.inertialToSurfaceDir({ x: vessel.pos.x / r, y: vessel.pos.y / r, z: vessel.pos.z / r }, world && Number.isFinite(world.ut) ? world.ut : 0, { x: 0, y: 0, z: 0 });
      }
      if (!dir) return false;
      const at = o.at && o.at.v === vessel.id ? o.at : null;
      if (at) {
        const step = Math.hypot(dir.x - at.x, dir.y - at.y, dir.z - at.z) * (vessel.body.radius || 0);
        if (step < 400) o.driven = Math.round(((o.driven || 0) + step) * 10) / 10;       // a bigger step was a hop or a reload
      }
      o.at = { v: vessel.id, x: dir.x, y: dir.y, z: dir.z };
      return (o.driven || 0) >= o.distance;
    }
    case 'station': {
      if (type !== 'tick') return false;
      let ok = tracked(vessel) && vessel.type !== 'eva' && vessel.situation === 'orbit' && idOf(vessel.body) === o.bodyId && !(vessel.thrust > 0);
      const info = ok ? orbitInfo(vessel, world) : null;
      ok = ok && !!info && info.pe >= (o.peMin || 0);
      if (ok) {
        const defs = partDefs(vessel);
        let seats = 0, ports = 0, docked = 0;
        for (const d of defs) { seats += d.crew || 0; if (d.dock) ports++; }
        const parts = vessel.parts instanceof Map ? vessel.parts.values() : [];
        for (const part of parts) if (part && part.dockedTo !== null && part.dockedTo !== undefined) docked++;
        ok = seats >= o.seats && ports >= (o.ports || 2) && docked >= 2 && defs.some(d => d.solar || d.generator) && defs.some(d => d.antenna);
      }
      o.held = ok ? (o.held || 0) + 1 : 0;
      return o.held >= (o.hold || 1);
    }
    case 'achieve':
      if (!tracked(vessel) || vessel.type === 'eva') return false;
      if (o.crew && crewNames(vessel).length < o.crew) return false;
      return beenOk(o.been, log);
    case 'recover': {
      if (type !== 'recovered' || !vessel) return false;
      const crew = (p.summary && p.summary.crew) || crewNames(vessel);
      if (o.crew && crew.length < o.crew) return false;
      return beenOk(o.been, log);
    }
    default: return false;
  }
}

/**
 * Live read-out of one objective for the vessel being flown, for the in-flight mission tracker:
 * { frac: 0..1 | null, text } (text '' when there is nothing useful to show). Pure; never changes the objective.
 */
export function objectiveProgress(o, vessel, world = null) {
  if (!o) return { frac: null, text: '' };
  if (o.done) return { frac: 1, text: 'done' };
  const c01 = x => Math.max(0, Math.min(1, x));
  const v = tracked(vessel) ? vessel : null;
  const here = v && idOf(v.body) === o.bodyId;
  const away = o.bodyId && v && !here ? `not at ${bodyName(o.bodyId)}` : '';
  switch (o.kind) {
    case 'reach': {
      if (!v) return { frac: 0, text: '' };
      if (!here) return { frac: 0, text: away };
      if (o.crew && crewNames(v).length < o.crew) return { frac: 0, text: 'needs a Pip aboard' };
      const alt = Math.max(0, altitudeOf(v));
      return { frac: c01(alt / o.altMin), text: `${km(alt)} of ${km(o.altMin)}` };
    }
    case 'stageTest': {
      if (!v || !here) return { frac: 0, text: away };
      const alt = altitudeOf(v), spd = speedOf(v);
      const altOk = alt >= o.altMin && alt <= o.altMax, spdOk = spd >= o.spdMin && spd <= o.spdMax;
      return { frac: (altOk ? 0.5 : 0) + (spdOk ? 0.5 : 0), text: `altitude ${km(Math.max(0, alt))} ${altOk ? 'in' : 'outside'} the window, speed ${Math.round(spd)} m/s ${spdOk ? 'in' : 'outside'} the window` + (altOk && spdOk ? ': stage now' : '') };
    }
    case 'orbit':
    case 'station': {
      if (!v || !here) return { frac: 0, text: away };
      const info = v.situation === 'orbit' ? orbitInfo(v, world) : null;
      if (!info) return { frac: 0, text: 'not in orbit yet' };
      if (o.held > 0) return { frac: c01(o.held / (o.hold || 1)), text: `holding: ${o.held} of ${o.hold || 1} s` };
      const bits = [`high point ${km(info.ap)}`, `low point ${km(info.pe)}`];
      if (o.kind === 'orbit') {
        if (info.ap < o.apMin) bits[0] += ' (too low)'; else if (info.ap > o.apMax) bits[0] += ' (too high)';
        if (info.pe < o.peMin) bits[1] += ' (too low)'; else if (o.peMax != null && info.pe > o.peMax) bits[1] += ' (too high)';
        if (o.incMax != null && (info.inc < (o.incMin || 0) || info.inc > o.incMax)) bits.push(`tilt ${Math.round(info.inc)}° (wrong)`);
      } else if (info.pe < (o.peMin || 0)) bits[1] += ' (too low)';
      return { frac: 0.5, text: bits.join(', ') };
    }
    case 'drive':
      return { frac: c01((o.driven || 0) / o.distance), text: `${km(o.driven || 0)} of ${km(o.distance)}` };
    case 'flyby':
    case 'land':
    case 'flag':
      return { frac: 0, text: away };
    default:
      return { frac: null, text: '' };
  }
}

// ---------------------------------------------------------------------------------------------
// The board
// ---------------------------------------------------------------------------------------------
export class ContractBoard {
  constructor(career, seed = 0x5747c0de) {
    this.career = career;
    this.seed = seed >>> 0;
    this.nextId = 1;
    this.offered = [];
    this.active = [];
    this.completed = [];
    this.failed = [];
    this.pending = [];                 // notices produced outside onEvent (transmitted science); flushed on the next event
    this._partTypes = new Map();       // transient: vessel id → Map(part id → part type), so staged-away parts can be named
  }

  get enabled() { return this.career.mode === 'career'; }
  get maxActive() { return maxActiveFor(this.career.reputation); }
  get offerCount() { return offerCountFor(this.career.reputation); }
  get fundsFactor() { return repFundsFactor(this.career.reputation); }
  find(id) { return [...this.offered, ...this.active, ...this.completed, ...this.failed].find(c => c.id === id) || null; }

  // ---- seeded randomness (the state lives in the save) ----
  _rand() { const r = mulberry(this.seed); this.seed = r.state; return r.value; }
  _R() {
    return {
      pick: arr => arr[Math.min(Math.floor(this._rand() * arr.length), arr.length - 1)],
      range: (lo, hi) => lo + this._rand() * (hi - lo),
      chance: p => this._rand() < p,
    };
  }

  // ---- generation ----
  _generate(avoid = new Set()) {
    const career = this.career, cap = capability(career), R = this._R();
    const taken = new Set([...this.offered, ...this.active].map(c => c.key));
    // No two contracts on the board or in the book share a title: a second "A Better View" reads as a mistake.
    const titles = new Set([...this.offered, ...this.active].map(c => c.title));
    let spare = null;
    const typeCount = {};
    for (const c of this.offered) typeCount[c.type] = (typeCount[c.type] || 0) + 1;
    const finish = (tpl, d) => {
      const total = round(d.funds * (0.9 + this._rand() * 0.25) * this.fundsFactor, 50);
      const advance = round(total * ADVANCE_SHARE, 50);
      const now = career.ut || 0;
      return {
        id: 'c' + this.nextId++, type: tpl.type, key: d.key, title: d.title, text: d.text, agency: d.agency, bodyId: d.bodyId,
        difficulty: d.bodyId === HOME ? (['satellite', 'orbit', 'rescue', 'station'].includes(tpl.type) ? 2 : 1) : (DEST[d.bodyId].fee >= 6 ? 4 : 3),
        objectives: d.objectives.map(o => ({ ...o, done: false })), ...(d.spawn ? { spawn: { ...d.spawn } } : {}),
        ...(d.guests ? { guests: d.guests } : {}),
        advance, reward: { funds: total - advance, science: Math.round(d.science * 2) / 2, rep: d.rep },
        penalty: { funds: advance, rep: Math.max(1, Math.ceil(d.rep / 2)) },
        days: d.days ?? null, offeredAt: now, expiresAt: now + Math.round(8 + this._rand() * 10) * VERDA_DAY,
        acceptedAt: null, deadlineAt: null, state: 'offered',
      };
    };
    for (let attempt = 0; attempt < 24; attempt++) {
      const pool = TEMPLATES.map(t => ({ t, w: Math.max(0, t.weight(cap)) / (1 + 2 * (typeCount[t.type] || 0)) })).filter(x => x.w > 0);
      if (!pool.length) return null;
      let roll = this._rand() * pool.reduce((s, x) => s + x.w, 0), tpl = pool[pool.length - 1].t;
      for (const x of pool) { roll -= x.w; if (roll <= 0) { tpl = x.t; break; } }
      const d = tpl.make(cap, R);
      if (!d || taken.has(d.key) || avoid.has(d.key)) continue;
      if (titles.has(d.title)) { spare = spare || { tpl, d }; continue; }      // a different job under a used name: try for another
      return finish(tpl, d);
    }
    if (spare) {                                                               // nothing else came up: number it
      const NUM = ['II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X'];
      const base = spare.d.title, n = NUM.find(x => !titles.has(base + ' ' + x));
      return finish(spare.tpl, { ...spare.d, title: base + ' ' + (n || '#' + this.nextId) });
    }
    return null;
  }

  /** Expire stale offers and overdue contracts, then top the board up. → notices for anything that failed. */
  refresh() {
    if (!this.enabled) { this.offered = []; return []; }
    const now = this.career.ut || 0;
    const notices = this._checkDeadlines(now);
    this.offered = this.offered.filter(c => !(c.expiresAt != null && c.expiresAt <= now));
    for (let guard = 0; this.offered.length < this.offerCount && guard < 12; guard++) {
      const c = this._generate();
      if (!c) break;
      this.offered.push(c);
    }
    return notices;
  }

  // ---- player actions ----
  accept(id) {
    if (!this.enabled) return { ok: false, reason: 'mode' };
    const i = this.offered.findIndex(c => c.id === id);
    if (i < 0) return { ok: false, reason: 'unknown' };
    if (this.active.length >= this.maxActive) return { ok: false, reason: 'full' };
    const [c] = this.offered.splice(i, 1);
    const now = this.career.ut || 0;
    c.state = 'active'; c.acceptedAt = now; c.deadlineAt = c.days ? now + c.days * VERDA_DAY : null; c.expiresAt = null;
    this.active.push(c);
    this.career.earn(c.advance, 0, 0);
    this.refresh();
    return { ok: true, contract: c };
  }

  decline(id) {
    const i = this.offered.findIndex(c => c.id === id);
    if (i < 0) return { ok: false, reason: 'unknown' };
    const [c] = this.offered.splice(i, 1);
    const fresh = this._generate(new Set([c.key]));
    if (fresh) this.offered.splice(i, 0, fresh);
    this.refresh();
    return { ok: true, contract: c, replacement: fresh };
  }

  /** Walk away from an active contract: the advance is repaid and reputation suffers. */
  cancel(id) {
    const c = this.active.find(x => x.id === id);
    if (!c) return { ok: false, reason: 'unknown' };
    const notice = this._fail(c, 'cancelled');
    this.refresh();
    return { ok: true, contract: c, notice };
  }

  // ---- outcomes ----
  _notice(c, outcome, extra = {}) {
    return { milestoneId: 'contract:' + c.id, id: 'contract:' + c.id, kind: 'contract', outcome, contractId: c.id, desc: c.text,
      title: c.title, funds: 0, science: 0, rep: 0, ...extra };
  }

  _complete(c) {
    this.active = this.active.filter(x => x !== c);
    c.state = 'completed'; c.closedAt = this.career.ut || 0;
    this.completed.unshift(c);
    this.completed.length = Math.min(this.completed.length, HISTORY_LIMIT);
    this.career.earn(c.reward.funds, c.reward.science, c.reward.rep);
    // a rescued Pip signs on with the program
    if (c.spawn && c.spawn.kind === 'stranded' && Array.isArray(this.career.roster) && !this.career.roster.some(r => r.name === c.spawn.name)) {
      this.career.roster.push({ name: c.spawn.name, status: 'available', flights: 1, trait: 'pilot', xp: 2, deeds: ['space'] });
    }
    return this._notice(c, 'completed', { title: 'Contract complete — ' + c.title, funds: c.reward.funds, science: c.reward.science, rep: c.reward.rep });
  }

  _fail(c, reason) {
    this.active = this.active.filter(x => x !== c);
    c.state = 'failed'; c.reason = reason; c.closedAt = this.career.ut || 0;
    this.failed.unshift(c);
    this.failed.length = Math.min(this.failed.length, HISTORY_LIMIT);
    const career = this.career;
    const funds = career.usesFunds ? Math.min(c.penalty.funds, Math.max(career.funds, 0)) : 0;
    if (career.usesFunds) career.funds -= funds;
    career.reputation -= c.penalty.rep;
    c.paidBack = funds;
    return this._notice(c, 'failed', { title: (reason === 'cancelled' ? 'Contract cancelled — ' : 'Contract failed (deadline passed) — ') + c.title, funds: -funds, rep: -c.penalty.rep });
  }

  _checkDeadlines(now) {
    const out = [];
    for (const c of [...this.active]) if (c.deadlineAt != null && now > c.deadlineAt) out.push(this._fail(c, 'deadline'));
    return out;
  }

  _notePartTypes(vessel) {
    if (!vessel || !(vessel.parts instanceof Map) || vessel.id == null) return null;
    let m = this._partTypes.get(vessel.id);
    if (!m) { m = new Map(); this._partTypes.set(vessel.id, m); if (this._partTypes.size > 40) this._partTypes.delete(this._partTypes.keys().next().value); }
    for (const [id, part] of vessel.parts) if (part && part.def) m.set(id, part.def.id);
    return m;
  }

  _process(ev) {
    const notices = [];
    for (const c of [...this.active]) {
      let changed = false;
      for (const o of c.objectives) {
        if (o.done) continue;
        let hit = false;
        try { hit = evaluate(o, ev); } catch { hit = false; }
        if (hit) { o.done = true; o.doneAt = this.career.ut || 0; delete o.held; changed = true; }
      }
      if (!changed) continue;
      if (c.objectives.every(o => o.done)) notices.push(this._complete(c));
      else notices.push(this._notice(c, 'objective', { title: 'Objective complete — ' + c.title }));
    }
    return notices;
  }

  /**
   * Feed a World event (or the 1 Hz `tick`). `vessel` is the vessel the event concerns (Career resolves it).
   * Must run while the vessel's flight log still exists (Career calls it before deleting the log on recovery).
   * → notices in the milestone-award shape plus kind:'contract' and outcome: 'completed' | 'failed' | 'objective'.
   */
  onEvent(type, payload, world, vessel = null) {
    if (!this.enabled) return [];
    const p = payload || {};
    const v = vessel || p.vessel || null;
    const notices = this.pending.splice(0);
    const partTypes = v && type !== 'stage' ? this._notePartTypes(v) : (v ? this._partTypes.get(v.id) || null : null);
    // contracts that put something into the world (a stranded pod) do so on the first event that carries a World
    if (world && typeof world.spawnStranded === 'function') {
      for (const c of this.active) {
        if (!c.spawn || c.spawned) continue;
        let made = null;
        try { made = world.spawnStranded(c.spawn); } catch { made = null; }
        if (made) { c.spawned = true; c.spawn.vesselId = made.id; }
      }
    }
    if (this.active.length) {
      const log = v ? this.career.flightLog[String(v.id ?? v.name ?? '?')] || null : null;
      notices.push(...this._process({ type, p, vessel: v, world, log, partTypes }));
    }
    if (type === 'stage' && v) this._notePartTypes(v);
    if (type === 'destroyed' || type === 'recovered') { if (v && v.id != null) this._partTypes.delete(v.id); }
    notices.push(...this._checkDeadlines(this.career.ut || 0));
    if (notices.some(n => n.outcome !== 'objective') || this.offered.length < this.offerCount) notices.push(...this.refresh());
    return notices;
  }

  /** Science banked through Career.creditScience (a recovery or a transmission). Notices wait for the next event. */
  noteScience(experiment, bodyId, situation) {
    if (!this.enabled || !this.active.length) return [];
    const notices = this._process({ type: 'credit', p: { record: { experiment, bodyId: idOf(bodyId), situation } }, vessel: null, world: null, log: null });
    this.pending.push(...notices);
    return notices;
  }

  // ---- persistence ----
  toJSON() {
    const copy = list => list.map(c => JSON.parse(JSON.stringify(c)));
    return { version: CONTRACT_VERSION, seed: this.seed, nextId: this.nextId, offered: copy(this.offered), active: copy(this.active),
      completed: copy(this.completed), failed: copy(this.failed) };
  }

  static fromJSON(o, career) {
    const b = new ContractBoard(career);
    if (!o || typeof o !== 'object') return b;
    if (Number.isFinite(o.seed)) b.seed = o.seed >>> 0;
    if (Number.isFinite(o.nextId) && o.nextId >= 1) b.nextId = Math.floor(o.nextId);
    const valid = c => c && typeof c === 'object' && typeof c.id === 'string' && Array.isArray(c.objectives) && c.reward && c.penalty
      && c.objectives.every(x => x && typeof x.kind === 'string');
    const read = (list, state) => (Array.isArray(list) ? list.filter(valid).map(c => {
      const x = JSON.parse(JSON.stringify(c));
      x.state = state;
      return x;
    }) : []);
    b.offered = read(o.offered, 'offered');
    b.active = read(o.active, 'active');
    b.completed = read(o.completed, 'completed').slice(0, HISTORY_LIMIT);
    b.failed = read(o.failed, 'failed').slice(0, HISTORY_LIMIT);
    return b;
  }
}
