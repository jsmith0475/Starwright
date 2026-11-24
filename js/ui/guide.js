// Starwright — Flight School: short illustrated lessons, a controls reference, a delta-v card and a glossary.
//   createGuideScreen(app)      enter({ lesson: id })
// Works with or without a game loaded (it is on the title menu too). "Try it" launches a stock craft via app.launch.
// Every number on the delta-v card and in the transfer lesson is computed here from js/core/bodies.js.
import { el, clear, fmt, icon } from './dom.js';
import { interiorFrame } from './interior.js';
import { pipFigure } from './crew.js';
import { SYSTEM } from '../core/bodies.js';
import { PARTS } from '../core/parts.js';
import { TECH_TREE } from '../core/career.js';
import { ensureCareerCss, controlsGrid } from './careerui.js';

ensureCareerCss();

// ------------------------------------------------------------------ orbital sums (vis-viva / Hohmann)

const B = SYSTEM.byId;
const circ = (gm, r) => Math.sqrt(gm / r);
const visViva = (gm, r, a) => Math.sqrt(gm * (2 / r - 1 / a));
const PARK_ALT = 80e3;                                   // the parking orbit every lesson uses
const LOW_ALT = { pell: 20e3, ost: 10e3, cindra: 20e3, tiv: 20e3 };
const ASCENT_VERDA = 3400;                               // flown, not derived: orbital speed plus gravity and drag losses
const r10 = x => Math.round(x / 10) * 10;
const lowOrbitRadius = b => b.radius + (b.atmo ? b.atmo.height * 1.15 : (LOW_ALT[b.id] || 20e3));

/** Hohmann transfer between circular orbits r1 → r2 around a body of gravitational parameter gm. */
function hohmann(gm, r1, r2) {
  const a = (r1 + r2) / 2;
  const time = Math.PI * Math.sqrt(a * a * a / gm);
  const period2 = 2 * Math.PI * Math.sqrt(r2 * r2 * r2 / gm);
  return {
    a, time, period2,
    dvDepart: Math.abs(visViva(gm, r1, a) - circ(gm, r1)),
    vInfArrive: Math.abs(circ(gm, r2) - visViva(gm, r2, a)),
    vInfDepart: Math.abs(visViva(gm, r1, a) - circ(gm, r1)),
    phase: 180 - 360 * time / period2,                   // degrees the target must lead (negative: trail) at departure
  };
}
/** Burn at radius r around a body to go between a circular orbit there and a hyperbolic excess speed vInf. */
const oberth = (gm, r, vInf) => Math.sqrt(vInf * vInf + 2 * gm / r) - circ(gm, r);

export function computeReference() {
  const verda = B.verda, star = SYSTEM.star;
  const park = verda.radius + PARK_ALT;
  const ref = { parkSpeed: circ(verda.gm, park), parkPeriod: 2 * Math.PI * Math.sqrt(park ** 3 / verda.gm), ascent: ASCENT_VERDA,
    escape: (Math.SQRT2 - 1) * circ(verda.gm, park), moons: {}, planets: {} };
  for (const id of ['pell', 'ost']) {
    const m = B[id];
    if (!m) continue;
    const h = hohmann(verda.gm, park, m.orbit.a), lo = lowOrbitRadius(m);
    const vLow = circ(m.gm, lo);
    ref.moons[id] = { name: m.name, transfer: h.dvDepart, time: h.time, phase: h.phase, capture: oberth(m.gm, lo, h.vInfArrive), lowAlt: lo - m.radius,
      lowSpeed: vLow, landing: vLow * 1.15, ascent: vLow * 1.1, back: oberth(m.gm, lo, h.vInfArrive) };
  }
  for (const id of ['cindra', 'rusk', 'thal']) {
    const p = B[id];
    if (!p) continue;
    const h = hohmann(star.gm, verda.orbit.a, p.orbit.a), lo = lowOrbitRadius(p);
    const out = { name: p.name, eject: oberth(verda.gm, park, h.vInfDepart), time: h.time, phase: h.phase, capture: oberth(p.gm, lo, h.vInfArrive),
      lowAlt: lo - p.radius, lowSpeed: circ(p.gm, lo), atmo: !!p.atmo, gas: !!p.gas };
    if (!p.gas) { out.landing = p.atmo ? null : out.lowSpeed * 1.15; out.ascent = out.lowSpeed * (p.atmo ? 1.3 : 1.1); }
    ref.planets[id] = out;
  }
  const thal = B.thal, tiv = B.tiv;
  if (thal && tiv) {
    const h = hohmann(thal.gm, lowOrbitRadius(thal), tiv.orbit.a), lo = lowOrbitRadius(tiv);
    ref.tiv = { name: tiv.name, transfer: h.dvDepart, capture: oberth(tiv.gm, lo, h.vInfArrive), lowAlt: lo - tiv.radius, lowSpeed: circ(tiv.gm, lo),
      landing: circ(tiv.gm, lo) * 1.15, ascent: circ(tiv.gm, lo) * 1.1 };
  }
  return ref;
}
const REF = computeReference();
const PELL = REF.moons.pell;
const PHASE_PELL = Math.round(PELL.phase);
const dv = x => '~' + fmt.num(r10(x)) + ' m/s';

// ------------------------------------------------------------------ tiny content helpers

/** Inline markup for lesson text: **bold**, _accent_, [[Key]] keycaps. Only ever fed the literals in this file. */
function rich(text) {
  return String(text)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/\[\[(.+?)\]\]/g, '<span class="sw-kbd">$1</span>')
    .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
    .replace(/__(.+?)__/g, '<em>$1</em>');
}
const P = text => el('p', { html: rich(text) });
const H = text => el('h2', { text });
const STEPS = (...items) => el('ol', { class: 'sw-steps' }, items.map(t => el('li', { html: rich(t) })));
const TIP = (text, { warn = false, seed = 'Tilly' } = {}) => el('div', { class: 'sw-tip' + (warn ? ' warn' : '') }, pipFigure({ seed, wave: !warn }), el('div', { html: rich(text) }));
function FIG(viewBox, markup, caption) {
  const fig = el('figure', { class: 'sw-fig' });
  const node = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  node.setAttribute('viewBox', viewBox);
  node.setAttribute('role', 'img');
  node.setAttribute('aria-label', caption || 'diagram');
  node.innerHTML = markup;
  fig.appendChild(node);
  if (caption) fig.appendChild(el('figcaption', { html: rich(caption) }));
  return fig;
}

// ------------------------------------------------------------------ diagrams (all drawn here, 1 unit = 1 px at full width)

const TEAL = '#39d0c0', AMBER = '#ffb347', LINE = '#5d6b7a', INK = '#c3cfdb', RED = '#ff6b6b', BLUE = '#3f8fd0';
const DEFS = `<defs>
  <marker id="gArrA" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10z" fill="${AMBER}"/></marker>
  <marker id="gArrT" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10z" fill="${TEAL}"/></marker>
  <marker id="gArrR" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10z" fill="${RED}"/></marker>
  <marker id="gArrI" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10z" fill="${INK}"/></marker>
  <radialGradient id="gVerda" cx="35%" cy="32%" r="80%"><stop offset="0" stop-color="#7cc4f0"/><stop offset=".6" stop-color="${BLUE}"/><stop offset="1" stop-color="#1d4f80"/></radialGradient>
  <radialGradient id="gPell" cx="35%" cy="32%" r="80%"><stop offset="0" stop-color="#eceef2"/><stop offset=".7" stop-color="#a9adb8"/><stop offset="1" stop-color="#6f7384"/></radialGradient>
</defs>`;
const planet = (cx, cy, r, grad = 'gVerda') => `<circle cx="${cx}" cy="${cy}" r="${r + 4}" fill="${grad === 'gVerda' ? '#7cc4f0' : '#fff'}" opacity=".12"/><circle cx="${cx}" cy="${cy}" r="${r}" fill="url(#${grad})"/>`;
const ship = (x, y, deg = 0, s = 1) => `<g transform="translate(${x} ${y}) rotate(${deg}) scale(${s})"><path d="M0 -11 Q5 -4 5 4 L5 8 L-5 8 L-5 4 Q-5 -4 0 -11z" fill="#f1f4f7"/><rect x="-5" y="1" width="10" height="2.5" fill="${TEAL}"/><path d="M-5 5 L-9 10 L-5 9z M5 5 L9 10 L5 9z" fill="${TEAL}"/></g>`;
const flame = (x, y, deg = 0, s = 1) => `<g transform="translate(${x} ${y}) rotate(${deg}) scale(${s})"><path d="M-4 9 Q0 26 4 9z" fill="${AMBER}"/><path d="M-2 9 Q0 18 2 9z" fill="#fff2c8"/></g>`;
const dot = (x, y, color = AMBER, r = 4) => `<circle cx="${x}" cy="${y}" r="${r + 3}" fill="${color}" opacity=".22"/><circle cx="${x}" cy="${y}" r="${r}" fill="${color}"/>`;
const label = (x, y, text, cls = '', anchor = 'start') => `<text x="${x}" y="${y}" class="${cls}" text-anchor="${anchor}">${text}</text>`;

function figHop() {
  return FIG('0 0 720 250', `${DEFS}
    <path d="M0 214 H720" stroke="${LINE}" stroke-width="2"/>
    <path d="M430 214 H720" stroke="${BLUE}" stroke-width="6" opacity=".55"/>
    <rect x="76" y="206" width="52" height="8" rx="2" fill="#6d7a89"/>
    <path d="M102 198 C150 -60 430 -40 560 196" fill="none" stroke="${INK}" stroke-width="2" stroke-dasharray="5 6"/>
    <path d="M102 198 C112 150 124 118 140 92" fill="none" stroke="${AMBER}" stroke-width="4" stroke-linecap="round"/>
    ${flame(104, 190, 6, 0.9)}${ship(104, 188, 6)}
    ${dot(140, 92)}${label(152, 88, 'booster burns out', 'amber')}${label(152, 104, 'you keep coasting upward', 'dim')}
    ${dot(318, 34, TEAL)}${label(318, 62, 'apex: stage the parachute', 'teal', 'middle')}
    ${dot(505, 110, INK, 3)}${label(492, 116, 'chute waits until you are slow', '', 'end')}
    <g transform="translate(548 150)"><path d="M-22 0 Q0 -30 22 0z" fill="#ff8a3d"/><path d="M-22 0 L0 30 L22 0 M-8 -1 L0 30 L8 -1" stroke="${INK}" stroke-width="1" fill="none"/><path d="M-6 30 L-4 22 L4 22 L6 30z" fill="#f3e7c9"/></g>
    ${label(516, 160, 'full canopy below 900 m', 'dim', 'end')}
    ${label(102, 236, 'pad', 'dim', 'middle')}${label(575, 236, 'splashdown', 'dim', 'middle')}`,
  'A hop is a tall, narrow arc. The booster only works for the first few seconds; the rest is coasting, falling and a parachute.');
}

function figCannon() {
  const cx = 180, cy = 190, r = 96;
  return FIG('0 0 360 300', `${DEFS}${planet(cx, cy, r)}
    <path d="M${cx} ${cy - r} v-22" stroke="${INK}" stroke-width="3"/>
    <path d="M${cx} ${cy - r - 22} q46 4 62 46" fill="none" stroke="${RED}" stroke-width="2.5" marker-end="url(#gArrR)"/>
    <path d="M${cx} ${cy - r - 22} q112 6 122 132" fill="none" stroke="${AMBER}" stroke-width="2.5" marker-end="url(#gArrA)"/>
    <circle cx="${cx}" cy="${cy}" r="${r + 22}" fill="none" stroke="${TEAL}" stroke-width="2.5" stroke-dasharray="6 5"/>
    <path d="M${cx + 2} ${cy - r - 22} h28" stroke="${TEAL}" stroke-width="2.5" marker-end="url(#gArrT)"/>
    ${label(250, 76, 'slow: lands', 'dim')}${label(314, 150, 'faster', 'amber')}${label(cx, 38, 'fast enough: never lands', 'teal', 'middle')}`,
  'Throw something sideways hard enough and the ground curves away as fast as it falls. That is an orbit.');
}

function figApsides() {
  const cx = 150, cy = 150;
  return FIG('0 0 360 300', `${DEFS}
    <ellipse cx="${cx + 40}" cy="${cy}" rx="130" ry="92" fill="none" stroke="${TEAL}" stroke-width="2.5"/>
    ${planet(cx - 30, cy, 34)}
    ${dot(cx - 90, cy, AMBER)}${dot(cx + 170, cy, TEAL)}
    <path d="M${cx - 30} ${cy} H${cx - 86}" stroke="${AMBER}" stroke-width="1.5" stroke-dasharray="3 4"/>
    <path d="M${cx + 4} ${cy} H${cx + 166}" stroke="${TEAL}" stroke-width="1.5" stroke-dasharray="3 4"/>
    ${label(cx - 100, cy + 5, 'Pe', 'amber', 'end')}${label(cx + 180, cy + 5, 'Ap', 'teal')}
    ${label(cx - 88, cy + 126, 'periapsis: lowest, fastest', 'amber')}${label(cx + 20, cy - 108, 'apoapsis: highest, slowest', 'teal')}`,
  'Every orbit is an ellipse with the planet off-centre. The map shows the two ends as **Pe** and **Ap**.');
}

function figBurns() {
  const one = (ox, title, color, big, marker, arrowDir) => {
    const cx = ox + 150, cy = 150, r = 62;
    const rx = big ? 96 : 46, ecx = big ? cx + (rx - r) : cx - (r - rx);
    const ex = big ? cx + 2 * rx - r : cx - 2 * rx + r;       // the far side that moves
    return `${planet(cx, cy, 30)}
      <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${LINE}" stroke-width="2" stroke-dasharray="5 5"/>
      <ellipse cx="${ecx}" cy="${cy}" rx="${rx}" ry="${Math.sqrt(r * (2 * rx - r)).toFixed(1)}" fill="none" stroke="${color}" stroke-width="2.5"/>
      ${ship(cx - r, cy, 0, 0.9)}
      <path d="M${cx - r - 14} ${cy + (arrowDir > 0 ? 12 : -12)} v${arrowDir * -34}" stroke="${color}" stroke-width="3" marker-end="url(#${marker})" transform="rotate(180 ${cx - r - 14} ${cy})"/>
      ${dot(ex, cy, color, 3.5)}
      ${label(cx, 34, title, color === TEAL ? 'teal' : 'amber', 'middle')}
      ${label(cx, 278, big ? 'the far side rises' : 'the far side drops', 'dim', 'middle')}`;
  };
  return FIG('0 0 720 290', `${DEFS}${one(0, 'Burn prograde (speed up)', TEAL, true, 'gArrT', 1)}${one(380, 'Burn retrograde (slow down)', AMBER, false, 'gArrA', -1)}
    <path d="M360 30 V270" stroke="${LINE}" stroke-width="1" stroke-dasharray="2 6"/>`,
  'A burn changes the **opposite** side of the orbit. To raise your periapsis, burn prograde at apoapsis, and the other way round.');
}

function figTurn() {
  // ground curve, atmosphere top, ascent path leaning east
  return FIG('0 0 720 300', `${DEFS}
    <path d="M0 262 Q360 236 720 262 V300 H0z" fill="#183039"/>
    <path d="M0 262 Q360 236 720 262" fill="none" stroke="${LINE}" stroke-width="2"/>
    <path d="M0 150 Q360 124 720 150" fill="none" stroke="${BLUE}" stroke-width="1.5" stroke-dasharray="6 6" opacity=".8"/>
    ${label(708, 140, 'top of the air: 72 km', 'dim', 'end')}
    <path d="M0 120 Q360 94 720 120" fill="none" stroke="${TEAL}" stroke-width="1.5" stroke-dasharray="2 5"/>
    ${label(12, 98, 'target orbit: 80 km', 'teal')}
    <path d="M96 254 C100 200 128 150 250 122 S520 100 660 112" fill="none" stroke="${AMBER}" stroke-width="3" stroke-linecap="round"/>
    <rect x="80" y="252" width="34" height="6" rx="2" fill="#6d7a89"/>
    ${ship(96, 240, 0, 0.9)}${ship(108, 196, 22, 0.9)}${ship(160, 150, 52, 0.9)}${ship(300, 114, 78, 0.9)}${ship(560, 104, 90, 0.9)}${flame(560, 104, 90, 0.9)}
    ${label(118, 244, 'straight up to 1 km')}
    ${label(128, 204, 'start tipping east', 'dim')}
    ${label(196, 180, '10 km: about 45°', 'amber')}
    ${label(316, 158, '40 km: nearly flat', 'amber')}
    ${label(560, 86, 'at apoapsis: burn sideways until Pe is above 72 km', 'teal', 'middle')}
    <path d="M610 284 h70" stroke="${INK}" stroke-width="2" marker-end="url(#gArrI)"/>${label(600, 288, 'east', 'dim', 'end')}`,
  'The gravity turn. Height gets you out of the air; **sideways speed** is what keeps you up. Lean over early and gently.');
}

function figNode() {
  const cx = 250, cy = 150;
  return FIG('0 0 720 300', `${DEFS}${planet(cx - 40, cy, 36)}
    <ellipse cx="${cx}" cy="${cy}" rx="150" ry="100" fill="none" stroke="${TEAL}" stroke-width="2.5"/>
    <ellipse cx="${cx + 60}" cy="${cy}" rx="210" ry="126" fill="none" stroke="${AMBER}" stroke-width="2" stroke-dasharray="7 6"/>
    <g transform="translate(${cx - 150} ${cy})">
      <circle r="9" fill="#141a22" stroke="#fff" stroke-width="2.5"/>
      <path d="M0 -12 V-46" stroke="${TEAL}" stroke-width="3" marker-end="url(#gArrT)"/>
      <path d="M0 12 V46" stroke="${AMBER}" stroke-width="3" marker-end="url(#gArrA)"/>
      <path d="M-12 0 H-40" stroke="${BLUE}" stroke-width="3" marker-end="url(#gArrI)"/>
      <path d="M12 0 H34" stroke="${BLUE}" stroke-width="3" marker-end="url(#gArrI)"/>
    </g>
    ${label(cx - 142, cy - 52, 'prograde', 'teal')}${label(cx - 142, cy + 62, 'retrograde', 'amber')}
    ${label(cx - 196, cy - 10, 'radial out', 'dim', 'end')}
    ${label(520, 60, 'solid line: where you are going now')}
    ${label(520, 82, 'dashed line: where the burn would take you', 'amber')}
    ${label(520, 126, 'The readout shows the burn size (m/s)', 'dim')}
    ${label(520, 144, 'and the time until you reach the node.', 'dim')}
    ${label(520, 188, 'Start burning half the burn time early,', 'dim')}
    ${label(520, 206, 'so the burn is centred on the node.', 'dim')}`,
  'A maneuver node is a planned burn pinned to a point on your orbit. Drag a handle and watch the dashed orbit change before you spend any fuel.');
}

function figTransfer() {
  const cx = 260, cy = 172, rPark = 20, rMoon = 150;
  const moonAngle = -(180 - PELL.phase) * Math.PI / 180;        // Pell at the burn, measured counter-clockwise from the arrival point
  const mx = cx + rMoon * Math.cos(moonAngle), my = cy - rMoon * Math.sin(moonAngle);
  const a = (rPark + rMoon) / 2, b = Math.sqrt(rPark * rMoon);
  const pr = 62, px = cx + pr * Math.cos(moonAngle), py = cy - pr * Math.sin(moonAngle);
  return FIG('0 0 720 350', `${DEFS}
    <circle cx="${cx}" cy="${cy}" r="${rMoon}" fill="none" stroke="${LINE}" stroke-width="2" stroke-dasharray="5 6"/>
    <circle cx="${cx}" cy="${cy}" r="${rPark}" fill="none" stroke="${TEAL}" stroke-width="2"/>
    ${planet(cx, cy, 12)}
    <path d="M${cx - rPark} ${cy} A${a} ${b.toFixed(1)} 0 0 0 ${cx + rMoon} ${cy}" fill="none" stroke="${AMBER}" stroke-width="3" stroke-linecap="round"/>
    <path d="M${cx} ${cy} L${cx - pr - 22} ${cy} M${cx} ${cy} L${(cx + (pr + 22) * Math.cos(moonAngle)).toFixed(1)} ${(cy - (pr + 22) * Math.sin(moonAngle)).toFixed(1)}" stroke="${INK}" stroke-width="1.2" stroke-dasharray="3 4"/>
    <path d="M${cx - pr} ${cy} A${pr} ${pr} 0 0 0 ${px.toFixed(1)} ${py.toFixed(1)}" fill="none" stroke="#fff" stroke-width="2" marker-end="url(#gArrI)"/>
    ${label(cx - 50, cy + 76, PHASE_PELL + '°', 'amber', 'end')}
    <circle cx="${mx.toFixed(1)}" cy="${my.toFixed(1)}" r="10" fill="url(#gPell)"/>
    <circle cx="${cx + rMoon}" cy="${cy}" r="10" fill="url(#gPell)" opacity=".4"/>
    <path d="M${(mx + 12).toFixed(1)} ${(my - 8).toFixed(1)} Q${cx + rMoon + 6} ${cy + 70} ${cx + rMoon + 4} ${cy + 18}" fill="none" stroke="${LINE}" stroke-width="1.5" marker-end="url(#gArrI)"/>
    ${ship(cx - rPark, cy, 180, 0.8)}${flame(cx - rPark, cy, 180, 0.8)}
    ${label(cx - rPark - 14, cy - 12, 'burn here', 'amber', 'end')}
    ${label(mx + 18, my + 16, 'Pell when you burn')}
    ${label(cx + rMoon + 16, cy + 5, 'Pell when you arrive', 'dim')}
    ${label(470, 30, 'Wait in your 80 km parking orbit until', 'dim')}
    ${label(470, 48, 'Pell is ' + PHASE_PELL + '° ahead of you (measured at', 'dim')}
    ${label(470, 66, 'Verda\'s centre, in the direction you fly).', 'dim')}
    ${label(470, 94, 'Then burn prograde ' + dv(PELL.transfer) + '.', 'amber')}
    ${label(470, 122, 'The coast takes ' + (PELL.time / 3600).toFixed(1) + ' hours. Pell covers', 'dim')}
    ${label(470, 140, 'the other ' + (180 - PHASE_PELL) + '° while you climb.', 'dim')}`,
  `The transfer window. Both you and Pell circle Verda the same way (counter-clockwise seen from the north). Leave when Pell is **${PHASE_PELL}° ahead** and you meet at the top of your new orbit.`);
}

function figLanding() {
  return FIG('0 0 720 280', `${DEFS}
    <path d="M0 236 Q360 214 720 236 V280 H0z" fill="#3a3d48"/>
    <path d="M0 236 Q360 214 720 236" fill="none" stroke="#a9adb8" stroke-width="2"/>
    <circle cx="130" cy="246" r="14" fill="#2f323c"/><circle cx="470" cy="240" r="20" fill="#2f323c"/><circle cx="640" cy="252" r="9" fill="#2f323c"/>
    <path d="M10 48 Q300 30 700 62" fill="none" stroke="${TEAL}" stroke-width="2" stroke-dasharray="6 5"/>
    <path d="M90 44 C280 40 470 70 560 196" fill="none" stroke="${AMBER}" stroke-width="2.5" stroke-dasharray="2 6"/>
    <path d="M560 196 V218" stroke="${AMBER}" stroke-width="3"/>
    ${ship(90, 44, -88, 0.9)}${flame(90, 44, -88, 0.8)}${label(90, 24, '1  deorbit burn (retrograde)', 'amber', 'middle')}
    ${ship(330, 62, -110, 0.9)}${label(350, 104, '2  fall, pointing retrograde', '', 'end')}
    ${ship(540, 150, -160, 0.9)}${flame(540, 150, -160, 1.1)}${label(506, 156, '3  braking burn, as late as you dare', 'amber', 'end')}
    ${ship(560, 214, 0, 0.9)}<path d="M553 222 l-7 8 M567 222 l7 8" stroke="${INK}" stroke-width="2"/>
    ${label(540, 206, '4  legs down, under 5 m/s', '', 'end')}
    ${label(24, 68, 'low orbit', 'teal')}`,
  'No air means no parachutes: every metre per second you arrive with has to be cancelled by the engine.');
}

function figReentry() {
  const cx = 250, cy = 330, r = 210, atmo = 34;
  return FIG('0 0 720 290', `${DEFS}
    <circle cx="${cx}" cy="${cy}" r="${r + atmo}" fill="#3f8fd0" opacity=".16"/>
    <circle cx="${cx}" cy="${cy}" r="${r + atmo}" fill="none" stroke="${BLUE}" stroke-width="1.5" stroke-dasharray="5 5"/>
    <circle cx="${cx}" cy="${cy}" r="${r}" fill="url(#gVerda)"/>
    <path d="M20 40 C150 60 250 70 330 96" fill="none" stroke="${INK}" stroke-width="2" stroke-dasharray="4 5"/>
    <path d="M330 96 C380 112 430 150 450 236" fill="none" stroke="${TEAL}" stroke-width="3"/>
    <path d="M20 22 C200 40 380 46 520 60" fill="none" stroke="${LINE}" stroke-width="2" stroke-dasharray="3 6" marker-end="url(#gArrI)"/>
    <path d="M20 70 C120 96 170 120 196 160" fill="none" stroke="${RED}" stroke-width="2.5" marker-end="url(#gArrR)"/>
    ${label(530, 54, 'too shallow: you skip back out', 'dim')}
    ${label(204, 176, 'too steep: heat and g-force', 'dim')}
    <g transform="translate(346 102) rotate(118)"><path d="M-9 4 Q0 -14 9 4z" fill="#f3e7c9"/><rect x="-10" y="4" width="20" height="4" rx="1.5" fill="#5b3b22"/><path d="M-12 10 Q0 22 12 10" fill="none" stroke="${AMBER}" stroke-width="3" opacity=".9"/></g>
    ${label(366, 96, 'periapsis 25–35 km: just right, shield first', 'teal')}
    <g transform="translate(450 214)"><path d="M-16 -14 Q0 -36 16 -14z" fill="#ff8a3d"/><path d="M-16 -14 L0 6 L16 -14" stroke="${INK}" stroke-width="1" fill="none"/><path d="M-5 12 L-3 5 L3 5 L5 12z" fill="#f3e7c9"/></g>
    ${label(476, 206, 'drogue first, main below Mach 0.4')}
    ${label(476, 224, 'and blooms fully under 900 m', 'dim')}
    ${label(cx + r + atmo - 4, 284, 'air: 72 km', 'dim', 'end')}`,
  'Coming home is free: the air does the braking. Your only job is to choose how deep the first pass dips.');
}

function figRendezvous() {
  const cx = 190, cy = 150;
  return FIG('0 0 720 300', `${DEFS}${planet(cx, cy, 34)}
    <circle cx="${cx}" cy="${cy}" r="112" fill="none" stroke="${TEAL}" stroke-width="2.5"/>
    <circle cx="${cx}" cy="${cy}" r="78" fill="none" stroke="${AMBER}" stroke-width="2.5"/>
    ${dot(cx + 112 * Math.cos(-0.5), cy + 112 * Math.sin(-0.5), TEAL, 5)}
    ${ship(cx + 78 * Math.cos(0.5), cy + 78 * Math.sin(0.5), 30, 0.85)}
    <path d="M${cx + 92} ${cy + 20} A94 94 0 0 0 ${cx + 86} ${cy - 40}" fill="none" stroke="${AMBER}" stroke-width="2" marker-end="url(#gArrA)"/>
    ${label(cx + 126, cy - 58, 'target', 'teal')}${label(cx, cy + 140, 'you: lower, so faster', 'amber', 'middle')}
    ${label(410, 62, '1   Same plane, slightly lower orbit: you catch up.')}
    ${label(410, 94, '2   Plan a node that lifts your orbit to touch')}
    ${label(432, 112, 'the target\'s. Nudge it until the closest-')}
    ${label(432, 130, 'approach markers sit side by side.')}
    ${label(410, 162, '3   At closest approach, point retrograde')}
    ${label(432, 180, 'relative to the target and burn until the')}
    ${label(432, 198, 'relative speed reads zero.')}
    ${label(410, 230, '4   Point at the target, push gently, coast,')}
    ${label(432, 248, 'and stop again when you get there.')}`,
  'Catching another vessel is a chase where the lower lane is the fast lane.');
}

// ------------------------------------------------------------------ lessons

const KEY = k => `[[${k}]]`;
const LESSONS = [
  { id: 'hop', title: 'Your first hop', craft: ['Hopper I'], goal: 'Go up, come down, keep the Pip.',
    body: () => [
      el('p', { class: 'lead', html: rich('Every program starts with a firework and a parachute. The goal of flight one is not altitude. It is getting your Pip back in a condition to complain about it.') }),
      figHop(),
      H('What to do'),
      STEPS(
        `Take **Hopper I** from the Launch Pad (or build your own: capsule, parachute on top, Ember booster underneath, three fins).`,
        `Press ${KEY('T')} to switch on SAS. It holds the nose steady so you do not have to.`,
        `Press ${KEY('Space')}. Solid boosters have no throttle and no off switch: once lit, it is a ride.`,
        `Burnout comes at about 20 km and you coast to roughly 55 km. Nothing to do but look out of the window. Right-click the capsule and take a **crew report** while you are up there.`,
        `When the vertical speed turns negative, press ${KEY('Space')} again to arm the parachute. A small drogue comes out first and slows you, then the main opens by itself and blooms fully near the ground.`,
        `After touchdown press ${KEY('Esc')} and choose **Recover**. You get most of the hardware cost back, plus the science.`),
      TIP('Science is counted per place __and__ per situation. A crew report on the pad, one flying low, one flying high and one after splashdown are four different results. A thermometer stuck to the side doubles all of that.'),
      H('What it pays'),
      P('A first hop with a couple of reports earns about 9 science, which is enough for **Bigger Bells** (5) in the Research Lab. That gives you liquid engines, and liquid engines can be throttled, steered and switched off, which is where flying really begins.'),
      P('Check the **Mission Board** before you launch. There is usually somebody willing to pay for exactly the flight you were going to do anyway.'),
    ] },

  { id: 'orbits', title: 'How orbits work', goal: 'Three pictures and you have got it.',
    body: () => [
      el('p', { class: 'lead', html: rich('An orbit is not a place where gravity stops. It is falling, done so fast sideways that you keep missing the ground.') }),
      el('div', { class: 'sw-figs' }, figCannon(), figApsides()),
      H('Height is not the hard part'),
      P(`Reaching space over Verda means climbing past 72 km. A booster can throw you that high and you will still fall straight back, because you arrive with almost no sideways speed. Staying up at 80 km needs about **${fmt.num(r10(REF.parkSpeed))} m/s sideways**. Nearly all of a rocket's fuel goes into that number.`),
      H('The two ends of an ellipse'),
      P('The low end of an orbit is the **periapsis** (Pe), the high end the **apoapsis** (Ap). You move fastest at the bottom and slowest at the top, like a swing. If the periapsis is inside the air (below 72 km) you are not in orbit yet; you are just taking the long way down.'),
      H('Burns move the other side'),
      figBurns(),
      P('This is the one rule that surprises everybody. Speeding up where you are does nothing to your height here and now. It lifts the point __half an orbit ahead__. Slowing down lowers it. So:'),
      STEPS(
        `To raise your **periapsis**, burn **prograde** (the way you are going) when you are at **apoapsis**.`,
        `To lower your **periapsis**, for instance to come home, burn **retrograde** at **apoapsis**.`,
        `Burns at periapsis do the same to the apoapsis, and they do it more cheaply, because you are moving fastest there.`),
      TIP(`The navball has markers for these directions, and SAS can hold them for you: click the prograde or retrograde button next to the navball once SAS is on (${KEY('T')}).`),
      P('The other two directions matter later. **Normal** and **anti-normal** tilt the orbit without changing its size. **Radial in** and **radial out** rotate the ellipse in place. You will need them for other moons; you will not need them to get to orbit.'),
    ] },

  { id: 'ascent', title: 'Reaching orbit, step by step', craft: ['Skylark II', 'Ember Twin'], goal: 'From the pad to an 80 km circle.',
    body: () => [
      el('p', { class: 'lead', html: rich(`Orbit costs about **${fmt.num(ASCENT_VERDA)} m/s** of delta-v from the pad. Skylark II carries a little over 4,000, so there is room for a wobbly first attempt.`) }),
      figTurn(),
      H('The ascent'),
      STEPS(
        `On the pad: ${KEY('T')} for SAS, ${KEY('Z')} for full throttle, ${KEY('Space')} to light the first stage.`,
        `Climb straight up until about **1 km** and 60–80 m/s. Then tap ${KEY('D')} to lean a few degrees east. East is free speed: Verda's spin already carries the pad that way at 200 m/s.`,
        `Keep easing over. Aim for **45° at 10 km** and close to flat by **40 km**. If the rocket fights you, you are turning too fast for the air you are in: ease off and let it climb.`,
        `When the first stage runs dry, ${KEY('Space')} drops it and lights the next one.`,
        `Open the map with ${KEY('M')}. Keep burning until the **apoapsis reads about 80 km**, then cut the engine with ${KEY('X')}. Coast. You are now on a tall arc that leaves the air and comes back.`,
        `Just before apoapsis, point at the horizon to the east (prograde) and burn until the **periapsis climbs above 72 km**. A maneuver node makes this exact; the next lesson shows how.`),
      TIP('Not sure your rocket is up to it? The hangar shows delta-v and thrust-to-weight per stage. You want a liftoff thrust-to-weight between 1.3 and 1.9, and about 3,600 m/s in total to have a margin.'),
      TIP('Flames around the nose on the way __up__ mean you are going too fast too low. Throttle back with [[Ctrl]] below 15 km. Air resistance is fuel you are burning to heat the sky.', { warn: true, seed: 'Bram' }),
      H('You are in orbit. Now what?'),
      P(`One lap at 80 km takes about ${Math.round(REF.parkPeriod / 60)} minutes. Use ${KEY('.')} to speed time up and ${KEY('/')} to stop the warp. Run your experiments again: "in space" is a new situation, and above 250 km counts as high space, which is another one. When you are done, the re-entry lesson gets you home.`),
    ] },

  { id: 'nodes', title: 'Maneuver nodes', craft: ['Skylark II'], goal: 'Plan the burn before you make it.',
    body: () => [
      el('p', { class: 'lead', html: rich('Guessing a burn works for the first orbit. After that, let the map do the arithmetic: a maneuver node shows you the result of a burn before you spend the fuel.') }),
      figNode(),
      H('Placing and shaping a node'),
      STEPS(
        `Open the map (${KEY('M')}) and click on your orbit where you want to burn. A node appears with six handles.`,
        `Drag a handle outward to add delta-v in that direction; drag it back to take it away. The dashed line is the orbit you would get.`,
        `Read the two numbers next to the node: the **size of the burn** in m/s and the **time until the node**.`,
        `Back in flight, switch SAS to **maneuver** hold. The nose swings onto the burn direction, marked on the navball.`,
        `Warp towards the node with ${KEY('.')}. The warp stops by itself a little before the burn.`,
        `Start the burn when the countdown reaches **half the burn time**. Throttle down for the last few m/s and cut with ${KEY('X')} when the remaining delta-v reaches zero.`),
      H('Which handle does what'),
      el('table', { class: 'sw-ref' },
        el('thead', null, el('tr', null, el('th', { text: 'Handle' }), el('th', { text: 'Effect' }), el('th', { text: 'Typical use' }))),
        el('tbody', null, [
          ['Prograde', 'Raises the opposite side of the orbit', 'Circularising, leaving for a moon'],
          ['Retrograde', 'Lowers the opposite side', 'Coming home, capturing at a moon'],
          ['Normal / anti-normal', 'Tilts the orbit', 'Matching the plane of a tilted moon such as Ost'],
          ['Radial out / in', 'Rotates the ellipse in its plane', 'Fine-tuning where an encounter happens'],
        ].map(r => el('tr', null, el('td', null, el('b', { text: r[0] })), el('td', { text: r[1] }), el('td', { text: r[2] }))))),
      TIP('Circularising with a node: click the orbit at the apoapsis marker and pull prograde until the Pe marker pops out of the planet and matches the Ap height. That one node is the whole second half of the ascent.'),
    ] },

  { id: 'pell', title: 'Getting to Pell', craft: ['Pell Runner'], goal: `Leave when Pell is ${PHASE_PELL}° ahead.`,
    body: () => [
      el('p', { class: 'lead', html: rich(`Pell circles Verda ${fmt.num(Math.round(B.pell.orbit.a / 1e6 * 10) / 10, 1)} thousand km out. You cannot fly straight at it: by the time you get there, it has moved. You aim for where it __will be__.`) }),
      figTransfer(),
      H('The sums, done for you'),
      el('table', { class: 'sw-ref' },
        el('tbody', null, [
          ['Parking orbit', '80 km circular, ' + fmt.num(r10(REF.parkSpeed)) + ' m/s'],
          ['Leave when Pell is', PHASE_PELL + '° ahead of you'],
          ['Transfer burn', dv(PELL.transfer) + ' prograde'],
          ['Coast time', (PELL.time / 3600).toFixed(1) + ' hours (' + (PELL.time / 19800).toFixed(1) + ' Verda days)'],
          ['Capture into a ' + Math.round(PELL.lowAlt / 1000) + ' km orbit of Pell', dv(PELL.capture) + ' retrograde at closest approach'],
        ].map(r => el('tr', null, el('td', { text: r[0] }), el('td', { class: 'num' }, el('b', { text: r[1] })))))),
      H('Flying it'),
      STEPS(
        `Reach an 80 km parking orbit and open the map. Click Pell and set it as your target.`,
        `Place a node on your orbit and pull **prograde** to about ${fmt.num(r10(PELL.transfer))} m/s. The dashed orbit grows until it touches Pell's.`,
        `Slide the node around your orbit. When it sits where Pell is ${PHASE_PELL}° ahead, the map shows an **encounter**: a new line curving around Pell.`,
        `Burn the node. Check the map afterwards: a few m/s of correction now is worth a hundred later.`,
        `Coast with time warp. The warp drops by itself when you cross into Pell's sphere of influence.`,
        `At Pell, plan a node at the periapsis and pull **retrograde** until the path closes into an orbit. Burn it, and you are circling the grey moon.`),
      TIP(`If the encounter will not appear, your orbit and Pell's are probably not lined up in time. Move the node a little earlier or later along the orbit and watch the closest-approach markers.`),
      P(`**Ost** works the same way from the same parking orbit: leave when it is ${Math.round(REF.moons.ost.phase)}° ahead, burn ${dv(REF.moons.ost.transfer)}, and expect a coast of ${(REF.moons.ost.time / 19800).toFixed(1)} Verda days. Ost's orbit is tilted 5.5°, so you will also need a small normal burn on the way.`),
    ] },

  { id: 'landing', title: 'Landing on an airless moon', craft: ['Pell Runner'], goal: 'Arrive at walking pace.',
    body: () => [
      el('p', { class: 'lead', html: rich(`Pell has a sixth of Verda's gravity and no air at all. Parachutes are decoration there. From a ${Math.round(PELL.lowAlt / 1000)} km orbit you need about **${fmt.num(r10(PELL.landing))} m/s** to get down, and nearly as much to get back up.`) }),
      figLanding(),
      H('Down'),
      STEPS(
        `From low orbit, burn **retrograde** until the periapsis drops below the surface, over the spot you fancy. Pick the sunlit side: it is easier to land on ground you can see.`,
        `Press ${KEY('G')} to lower the legs now, while there is nothing else to do.`,
        `Press ${KEY('C')} so the navball shows **surface** speed, and set SAS to hold **retrograde**. Your engine now points exactly against your motion, whatever it is.`,
        `Watch the radar altitude. With a few kilometres to go, burn at full throttle until you are slow, then let yourself fall again. Repeat lower down. It wastes a little fuel and saves a lot of capsules.`,
        `For the last 200 m keep the descent under **5 m/s** and kill any sideways drift. Cut the engine with ${KEY('X')} the moment the legs touch.`),
      TIP('The lander must still have fuel for the trip home: about ' + fmt.num(r10(PELL.ascent + PELL.back)) + ' m/s to climb back to orbit and leave for Verda. Check the delta-v readout __before__ the deorbit burn, not after.', { warn: true, seed: 'Bram' }),
      H('On the ground'),
      P('Take every reading you have: landed on Pell is worth far more than anything near Verda. Send a Pip outside for a spacewalk report and a surface sample, and plant a flag. Then climb back in.'),
      H('Up and home'),
      P(`Lift off, lean over almost at once (there is no air to climb out of) and burn until the apoapsis is ${Math.round(PELL.lowAlt / 1000)} km. Circularise, then burn prograde when you are on the side of Pell facing __away__ from its direction of travel, so that you leave backwards along Pell's orbit and drop towards Verda. Aim for a Verda periapsis of 25–35 km and let the air do the rest.`),
    ] },

  { id: 'reentry', title: 'Re-entry and parachutes', craft: ['Skylark II'], goal: 'Blunt end first.',
    body: () => [
      el('p', { class: 'lead', html: rich('Getting home takes one small burn. Everything after that is the atmosphere turning your speed into heat, and your heat shield turning that into somebody else\'s problem.') }),
      figReentry(),
      H('The routine'),
      STEPS(
        `At apoapsis, burn **retrograde** until the periapsis reads **25–35 km**. From an 80 km orbit that is under 100 m/s.`,
        `Before you reach the air, stage away everything except the capsule and its shield. Empty tanks do not help.`,
        `Set SAS to **retrograde**: shield forward, parachute behind. Keep it there.`,
        `The glow starts around 55 km and peaks near 35 km. The shield's ablator burns away slowly; that is what it is for.`,
        `Arm the parachute with ${KEY('Space')} any time. The pack carries a small drogue that comes out first, under Mach 3, and slows you. Below Mach 0.4 the drogue pulls the main out reefed, a narrow sock that fills over six seconds, and it opens fully 900 m above the ground.`,
        `Touchdown should be 5–7 m/s. The sea is kinder than the land. Then ${KEY('Esc')} and **Recover**.`),
      TIP('A bare Acorn capsule survives a gentle return from low orbit. Coming back from Pell you arrive about 900 m/s faster, and that is no longer gentle: take the Ablative Shield from **Coming Home**.', { warn: true, seed: 'Bram' }),
      H('Why recover near the pad?'),
      P('Recovery pays back up to 98% of the hardware when you come down next to the Flight Center, falling towards 10% on the far side of the planet. An orbit lasts about half an hour, so timing the deorbit burn to land near home is worth real money.'),
    ] },

  { id: 'rendezvous', title: 'Rendezvous basics', craft: ['Latch Chaser', 'Skylark II'], goal: 'Meet another vessel in orbit.',
    body: () => [
      el('p', { class: 'lead', html: rich('Two vessels in the same orbit never meet: they just chase each other round. To close the gap you have to change lanes.') }),
      figRendezvous(),
      H('The idea'),
      P('A lower orbit is shorter and faster, so a vessel below its target gains on it every lap; one above falls behind. You pick the lane that closes the gap, then hop across at the moment the two of you would arrive at the same point together.'),
      H('Doing it'),
      STEPS(
        `Put the target in a tidy circular orbit first (say 120 km) and launch the chaser into a lower one (80–90 km), in the same direction. Launch when the target passes overhead so you start close behind it.`,
        `In the map, click the target vessel and set it as your target. Closest-approach markers appear on your orbit.`,
        `Add a prograde node that lifts your apoapsis to the target's height. Slide the node along the orbit until the closest approach is under a couple of kilometres.`,
        `Burn it and coast. Near the meeting point, switch the navball to **target** mode with ${KEY('C')}: the speed shown is now your speed relative to the target.`,
        `Hold retrograde (relative to the target) and burn until that speed reads zero.`,
        `Point at the target, give a small push, coast, and stop again when you arrive. For the last few metres use RCS: ${KEY('R')} to switch it on, then ${KEY('H')} ${KEY('N')} forward and back, ${KEY('I')} ${KEY('K')} ${KEY('J')} ${KEY('L')} sideways.`),
      PARTS.dock_m || PARTS.dock_s
        ? TIP(`Two vessels with matching Latch Rings (${[PARTS.dock_s, PARTS.dock_m].filter(Boolean).map(p => p.name).join(' or ')}) join when the rings touch gently and squarely. Under half a metre per second is gentle.`)
        : TIP('Once you are parked next to the other vessel you can send a Pip across on a spacewalk. Switch between nearby vessels with [[[]] and [[]]].'),
      TIP('The commonest mistake is thrusting straight at the target from far away. In orbit that changes your lane, and you sail past above or below. Always cancel the relative speed first, then push.', { warn: true, seed: 'Bram' }),
    ] },
];

// ------------------------------------------------------------------ reference pages

function controlsPage() {
  return [
    el('p', { class: 'lead', text: 'Every key in the game, on one page. Set up for a Mac keyboard and a mouse with a wheel.' }),
    controlsGrid('sw-keys'),
    TIP('Flight keys can be changed in flight: open the pause menu with [[Esc]], choose Flight controls and click a key cap. If F1, F2, F5 and F9 are media keys on your Mac, hold [[fn]], or use [[Shift]] [[K]] to quicksave and [[Shift]] [[L]] to quickload. The mouse\'s thumb buttons are ignored on purpose, so they cannot take you off the page mid-flight.'),
  ];
}

function dvCard(name, color, rows, note) {
  const dl = el('dl');
  for (const [k, v] of rows) if (v != null) dl.append(el('dt', { text: k }), el('dd', { text: typeof v === 'number' ? dv(v) : v }));
  return el('div', { class: 'sw-dvcard', data: { body: name.toLowerCase() } }, el('h4', null, el('i', { style: { background: color } }), name), dl, note ? el('div', { class: 'note', text: note }) : null);
}
const hex = b => '#' + (b && Number.isFinite(b.color) ? b.color : 0x93a3b3).toString(16).padStart(6, '0');
const days = s => (s / 19800 >= 10 ? fmt.num(Math.round(s / 19800)) : (s / 19800).toFixed(1)) + ' days';
const phaseText = ph => { const x = ((ph + 180) % 360 + 360) % 360 - 180; return x >= 0 ? Math.round(x) + '° ahead' : Math.round(-x) + '° behind'; };

function deltaVPage() {
  const m = REF.moons, p = REF.planets;
  const cards = [
    dvCard('Verda', hex(B.verda), [
      ['Pad to 80 km orbit', ASCENT_VERDA], ['Orbital speed at 80 km', fmt.num(r10(REF.parkSpeed)) + ' m/s'],
      ['Deorbit from 80 km', '~90 m/s'], ['Escape from 80 km', REF.escape], ['Landing', 'parachutes'],
    ], 'The ascent figure is flown, not calculated: orbital speed plus what gravity and air take on the way.'),
  ];
  for (const id of ['pell', 'ost']) {
    const x = m[id];
    if (!x) continue;
    cards.push(dvCard(x.name, hex(B[id]), [
      ['Transfer from 80 km Verda orbit', x.transfer], ['Leave when it is', phaseText(x.phase)], ['Coast', days(x.time)],
      [`Capture to ${Math.round(x.lowAlt / 1000)} km orbit`, x.capture], ['Land from low orbit', x.landing], ['Back to low orbit', x.ascent], ['Leave for Verda', x.back],
    ], id === 'ost' ? 'Ost\'s orbit is tilted 5.5° and slightly oval: allow ~100 m/s for a plane change.' : 'Round trip with landing from Verda orbit: about ' + fmt.num(r10(x.transfer + x.capture + x.landing + x.ascent + x.back)) + ' m/s.'));
  }
  for (const id of ['rusk', 'cindra', 'thal']) {
    const x = p[id];
    if (!x) continue;
    cards.push(dvCard(x.name, hex(B[id]), [
      ['Departure from 80 km Verda orbit', x.eject], ['Leave when it is', phaseText(x.phase)], ['Coast', days(x.time)],
      [`Capture to ${fmt.num(Math.round(x.lowAlt / 1000))} km orbit`, x.capture],
      x.gas ? ['Landing', 'none: no surface'] : ['Land from low orbit', x.landing == null ? 'air + ~300 m/s' : x.landing],
      x.gas ? null : ['Back to low orbit', x.ascent],
    ].filter(Boolean), id === 'rusk' ? 'Thin air: parachutes help, but finish the landing on the engine. A pass through the upper air can pay for most of the capture.'
      : id === 'cindra' ? 'An inner world: you leave Verda backwards (retrograde to its motion round Helion) and arrive fast.'
        : 'Capture is costly unless you skim the upper atmosphere (above 400 km) to brake.'));
  }
  if (REF.tiv) {
    const x = REF.tiv;
    cards.push(dvCard(x.name, hex(B.tiv), [
      ['From low Thal orbit', x.transfer], [`Capture to ${Math.round(x.lowAlt / 1000)} km orbit`, x.capture], ['Land from low orbit', x.landing], ['Back to low orbit', x.ascent],
    ], 'Cheaper: arrive from Verda aimed straight at Tiv and capture there instead of at Thal.'));
  }
  return [
    el('p', { class: 'lead', html: rich('**Delta-v** is the currency of spaceflight: how much a vessel can change its speed with the fuel aboard. Add up the legs of a trip, compare with the number the hangar shows, and you know whether you are coming home.') }),
    el('div', { class: 'sw-dvmap' }, cards),
    TIP('All figures are approximate: ideal two-burn (Hohmann) transfers between circular orbits, worked out from the real masses and distances of the Helion system, with a 10–15% allowance on landings and ascents. Carry a tenth more than the sum.'),
    H('Reading the card'),
    P('Legs add up. A Pell landing and return from the pad is: ascent, transfer, capture, landing, back to orbit, leave for Verda. The return to Verda\'s surface is free if you have a shield. "Leave when it is 111° ahead" is the phase angle: where the target must be, seen from the centre of the body you both circle, when you light the engine.'),
  ];
}

const GLOSSARY = [
  ['Apoapsis (Ap)', 'The highest point of an orbit. You move slowest here.'],
  ['Periapsis (Pe)', 'The lowest point of an orbit. You move fastest here. Below 72 km over Verda it is inside the air.'],
  ['Prograde', 'The direction you are travelling. Burning this way makes the orbit bigger.'],
  ['Retrograde', 'Directly backwards along your path. Burning this way makes the orbit smaller, and it is the way to point for braking and landing.'],
  ['Normal / anti-normal', 'At right angles to the orbit, "up" and "down" out of its plane. Burns here tilt the orbit.'],
  ['Radial in / out', 'Towards or away from the body you orbit, in the plane of the orbit. Burns here rotate the ellipse.'],
  ['Delta-v (Δv)', 'How much speed change a vessel has in its tanks, in m/s. The budget every trip is planned in.'],
  ['Thrust-to-weight (TWR)', 'Engine push divided by the vessel\'s weight. Under 1 on the pad, the rocket stays on the pad.'],
  ['Specific impulse (Isp)', 'An engine\'s fuel economy, in seconds. Higher goes further on the same fuel. Vacuum engines score well only in vacuum.'],
  ['Suborbital', 'A path that leaves the ground, or even the air, but comes back down before completing a lap.'],
  ['Gravity turn', 'The gradual lean from vertical to horizontal during ascent, trading climb for sideways speed.'],
  ['Staging', 'Dropping empty parts and lighting the next ones. Each press of Space fires the next stage.'],
  ['Maneuver node', 'A planned burn placed on the orbit in the map. Shows the result before you burn.'],
  ['Transfer window', 'The moment when leaving now arrives where the target will be. Select a moon or planet in the map: the Window panel shows the wait, and Plan burn puts the departure burn on your orbit as a maneuver node.'],
  ['Facility level', 'Each building of the Flight Center has three levels. Administration upgrades them for funds: heavier rockets on the pad, more parts per design, a longer reach for the Tracking Station, a research bonus, more beds.'],
  ['Sphere of influence', 'The region where one body\'s gravity is the one that counts. Crossing its edge hands you to the next body.'],
  ['Phase angle', 'The angle between you and your target as seen from the centre of the body you both orbit. Transfers start at a particular one.'],
  ['Hohmann transfer', 'The thrifty way between two circular orbits: one burn to stretch your orbit until it touches the other, one to stay there.'],
  ['Inclination', 'How far an orbit is tilted from the equator. Zero is equatorial, 90° passes over the poles.'],
  ['SAS', 'Stability assist. Holds the nose still, or on a chosen marker, using reaction wheels, engine gimbal, fins and thrusters.'],
  ['RCS', 'Small thrusters fed by monopropellant, for turning and for nudging sideways during rendezvous.'],
  ['Aerobraking', 'Dipping into an atmosphere to lose speed for free. Needs a shield if you dip deep or arrive fast.'],
  ['Ablator', 'The material of a heat shield that chars and carries heat away. When it is gone, the shield is just a lid.'],
  ['Recovery', 'Collecting a landed vessel on Verda. Returns its science, its crew and most of what the parts cost.'],
];

function glossaryPage() {
  return [
    el('p', { class: 'lead', text: 'The words the ground crew use, in plain language.' }),
    el('dl', { class: 'sw-glossary' }, GLOSSARY.map(([t, d]) => el('div', null, el('dt', { text: t }), el('dd', { text: d })))),
  ];
}

const REFERENCE = [
  { id: 'controls', title: 'Controls', icon: 'keyboard', body: controlsPage },
  { id: 'deltav', title: 'Delta-v card', icon: 'compass', body: deltaVPage },
  { id: 'glossary', title: 'Glossary', icon: 'book', body: glossaryPage },
];
export const GUIDE_PAGES = [...LESSONS.map(l => l.id), ...REFERENCE.map(r => r.id)];

// ------------------------------------------------------------------ screen

export function createGuideScreen(app) {
  let frame = null, nav = null, body = null, current = LESSONS[0].id, crafts = null, token = 0;

  const techName = id => (TECH_TREE.find(n => n.id === id) || {}).name || id;

  async function stock() {
    if (crafts) return crafts;
    try { const mod = await import('../core/craft.js'); crafts = mod.stockCrafts(); }
    catch (err) { console.warn('[guide] stock crafts unavailable:', err && err.message); crafts = []; }
    return crafts;
  }

  /** The "Try it" strip for a lesson: launches the lesson's stock craft, or says what stands in the way. */
  async function tryIt(lesson, my) {
    const list = await stock();
    if (my !== token || !body) return;
    const career = app.career;
    const candidates = (lesson.craft || []).map(n => list.find(c => c.name === n)).filter(Boolean);
    const box = el('div', { class: 'sw-try', data: { role: 'try' } }, icon('rocket'));
    const text = el('div', { class: 'sw-grow' });
    box.appendChild(text);
    if (!candidates.length) return;
    const lockedTech = c => [...new Set(c.parts.filter(p => PARTS[p.type] && !career.isPartUnlocked(p.type)).map(p => PARTS[p.type].tech))];
    if (!career) {
      box.classList.add('locked');
      text.append(el('b', { text: 'Try it: ' + candidates[0].name }), el('span', { text: 'Start a game first. Sandbox has every part unlocked and nothing to pay.' }));
      box.appendChild(el('button', { class: 'sw-btn', attrs: { type: 'button', 'data-action': 'back' }, on: { click: () => app.goto('title') } }, 'Main menu'));
    } else {
      const craft = candidates.find(c => !lockedTech(c).length) || candidates[0];
      const missing = lockedTech(craft);
      const cost = craft.cost();
      if (missing.length) {
        box.classList.add('locked');
        box.firstChild.replaceWith(icon('lock'));
        text.append(el('b', { text: 'Try it: ' + craft.name }),
          el('span', { text: 'Needs research first: ' + missing.map(techName).join(', ') + '.' }));
        box.appendChild(el('button', { class: 'sw-btn', attrs: { type: 'button', 'data-action': 'research' }, on: { click: () => app.goto('research') } }, icon('lab'), 'Research Lab'));
      } else {
        const seats = craft.parts.reduce((s, p) => s + ((PARTS[p.type] || {}).crew || 0), 0);
        const crew = career.availableCrew().slice(0, seats).map(p => p.name);
        const afford = career.canAfford(cost);
        const flying = career.flightsInProgress && career.flightsInProgress() > 0;
        text.append(el('b', { text: 'Try it: ' + craft.name }),
          el('span', { text: (career.mode === 'career' ? 'Launch cost ' + fmt.funds(cost) + '. ' : '') + (seats ? (crew.length ? crew.join(', ') + ' will fly.' : 'No Pip is free: it will fly empty.') : 'Uncrewed.')
            + (afford ? '' : ' You cannot afford it right now.') + (flying ? ' Your other vessels stay where they are.' : '') }));
        box.appendChild(el('button', { class: 'sw-btn primary', disabled: !afford, attrs: { type: 'button', 'data-action': 'try' },
          tip: afford ? 'Roll it out to the pad' : 'Not enough funds', on: { click: () => app.launch(craft, { crew }) } }, icon('play'), 'Launch'));
      }
    }
    body.firstChild.appendChild(box);
  }

  function show(id) {
    const lesson = LESSONS.find(l => l.id === id), page = REFERENCE.find(r => r.id === id);
    if (!lesson && !page) return show(LESSONS[0].id);
    current = id;
    const my = ++token;
    for (const b of nav.querySelectorAll('.sw-guide-link')) b.classList.toggle('active', b.dataset.lesson === id);
    clear(body);
    const n = lesson ? LESSONS.indexOf(lesson) + 1 : 0;
    const article = el('article', { class: 'sw-lesson', data: { lesson: id } },
      el('div', { class: 'kicker', text: lesson ? `Lesson ${n} of ${LESSONS.length}` : 'Reference' }),
      el('h1', { text: (lesson || page).title }),
      ...(lesson || page).body());
    body.appendChild(article);
    body.scrollTop = 0;
    if (lesson) {
      if (lesson.craft) tryIt(lesson, my);
      const next = LESSONS[n] || null;
      if (next) article.appendChild(el('p', { style: { marginTop: '22px' } },
        el('button', { class: 'sw-btn ghost', attrs: { type: 'button', 'data-action': 'next-lesson' }, on: { click: () => show(next.id) } }, 'Next: ' + next.title + ' →')));
    }
    frame.setSubtitle(lesson ? lesson.goal : 'Keep this page handy');
    try { sessionStorage.setItem('starwright.guide.page', id); } catch { /* private mode */ }
  }

  return {
    is3D: true, capturesKeys: false,
    enter(params = {}) {
      const home = () => app.goto(app.career ? 'hub' : 'title');
      frame = interiorFrame(app, { name: 'guide', building: 'school', title: 'Flight School', code: 'FS', onBack: home, backLabel: app.career ? 'Flight Center' : 'Main menu' });
      nav = el('div', { class: 'sw-guide-nav sw-scroll' });
      nav.appendChild(el('div', { class: 'sw-label', text: 'Lessons' }));
      LESSONS.forEach((l, i) => nav.appendChild(el('button', { class: 'sw-guide-link', attrs: { type: 'button' }, data: { lesson: l.id }, on: { click: () => show(l.id) } },
        el('span', { class: 'n', text: String(i + 1) }), l.title)));
      nav.appendChild(el('div', { class: 'sw-label', text: 'Reference' }));
      for (const r of REFERENCE) nav.appendChild(el('button', { class: 'sw-guide-link', attrs: { type: 'button' }, data: { lesson: r.id }, on: { click: () => show(r.id) } }, icon(r.icon), r.title));
      body = el('div', { class: 'sw-guide-body sw-scroll' });
      frame.page.appendChild(el('div', { class: 'sw-guide' }, nav, body));
      app.uiRoot.appendChild(frame.root);
      let start = params.lesson;
      if (!start) { try { start = sessionStorage.getItem('starwright.guide.page'); } catch { start = null; } }
      show(GUIDE_PAGES.includes(start) ? start : LESSONS[0].id);
    },
    exit() { token++; if (frame) frame.dispose(); frame = nav = body = null; },
    render() { if (frame) frame.render(); },
    resize(w, h) { if (frame) frame.resize(w, h); },
    update(dt) {
      if (!frame) return;
      if (app.input.pressed('Escape')) { app.goto(app.career ? 'hub' : 'title'); return; }
      frame.update(dt);
    },
    get page() { return current; },
  };
}
