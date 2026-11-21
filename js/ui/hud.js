// Starwright — flight HUD (DOM overlay), arranged the way pilots of this genre expect, drawn as flight instruments:
//   top-left      mission clock + time-warp arrows, vessel name / situation, target read-out
//   top-centre    altimeter (digit drums) with the vertical-speed dial on its left and the atmosphere-depth gauge on its
//                 right; apoapsis / periapsis strip under it
//   top-right     resources (collapsible; per stage and total) and, at the very edge, the toolbar
//   bottom-left   staging stack (next stage at the bottom, per-stage Δv) and the big stage button; spacewalk card
//   bottom-centre the attitude ball: speed read-out and heading tape above it, SAS modes on its left, throttle gauge on
//                 its left edge, g-meter on its right edge, maneuver burn panel (Δv gauge + burn-time bar) on the right,
//                 status lights (SAS RCS panels · gear lights brakes) above
//   bottom-right  crew portraits (animated Pip faces) with EVA / transfer buttons
// The attitude ball itself is WebGL (see navball.js); the console has a transparent hole over it and a 2D canvas
// for the markers.
//
//   const hud = createHud(app, actions)
//   hud.mount() / hud.unmount()
//   hud.update(world, vessel, state, dt)      state = { speedMode, paused, assist, mapOpen, cameraMode, heading, pitch, roll, danger }
//   hud.ballRect() → {x, y, size} CSS px       hud.overlay (canvas)
//   hud.setMapOpen(bool), hud.setHidden(bool), hud.setHint(spec), hud.flashCamera(text)
//   hud.showCenter({title, text, calm, buttons:[{label, kind, onClick}]}) / hud.hideCenter()
//   hud.togglePanel('crew'|'science'|'target'|'dock'|'fuel'|'groups'|'guide'), hud.closePanels(), hud.refreshPanels()
//   hud.values  → last displayed numbers (for tests)       hud.insets() → space the HUD takes at each edge (for the map)
import { el, clear, fmt, uiScale, tooltip } from './dom.js';
import { stressLevel, stressPercent, describeJoint } from './stress.js';
import { SYSTEM } from '../core/bodies.js';
import { EXPERIMENTS, SITUATION_NAMES, situationOf, programProgress } from '../core/career.js';
import { objectiveProgress, VERDA_DAY } from '../core/contracts.js';
import { renderPartThumbnail } from '../render/partmesh.js';
import { drawGlyph } from './navball.js';

const SIT_TEXT = {
  prelaunch: 'On the pad at', landed: 'Landed on', splashed: 'Splashed down on', flying: 'Flying over', suborbital: 'Sub-orbital above',
  orbit: 'Orbiting', escape: 'Escaping',
};
const RES = [
  ['fuel', 'Propellant', 'kg', ''], ['solid', 'Solid fuel', 'kg', 'amber'], ['mono', 'Monoprop', 'kg', ''], ['xenon', 'Xenon', 'kg', 'violet'],
  ['elec', 'Charge', 'EC', 'green'], ['ablator', 'Ablator', 'kg', 'amber'], ['evafuel', 'Jetpack', 'kg', ''],
];
export const SAS_BUTTONS = [
  ['hold', 'Hold attitude', null], ['maneuver', 'Maneuver', 'maneuver'], ['prograde', 'Prograde', 'prograde'], ['retrograde', 'Retrograde', 'retrograde'],
  ['normal', 'Normal', 'normal'], ['antinormal', 'Anti-normal', 'antinormal'],
  ['radialIn', 'Radial in', 'radialIn'], ['radialOut', 'Radial out', 'radialOut'],
];
/** SAS modes that need a target. */
export const TARGET_SAS_BUTTONS = [
  ['target', 'Point at the target', 'target'], ['antiTarget', 'Point away from the target', 'antiTarget'],
  ['relPrograde', 'Along your drift relative to the target', 'relPrograde'], ['relRetrograde', 'Against your drift relative to the target (burn to stop beside it)', 'relRetrograde'],
];
const XFER = { fuel: ['Propellant', 'kg'], mono: ['Monoprop', 'kg'], elec: ['Charge', 'EC'], xenon: ['Xenon', 'kg'] };
const PANEL_TITLE = { crew: 'Crew', science: 'Science', target: 'Target', dock: 'Docking', fuel: 'Fuel transfer', groups: 'Action groups', guide: 'Autopilot', missions: 'Missions' };
const ORDINAL = n => 'Stage ' + n;
const FONT = 'ui-rounded, "SF Pro Rounded", system-ui, sans-serif';

// Toolbar glyphs (original line icons, 20 × 20 view box).
const TOOL_ICON = {
  map: '<circle cx="10" cy="10" r="6.5"/><ellipse cx="10" cy="10" rx="9" ry="3.4" transform="rotate(-24 10 10)"/><circle cx="16.6" cy="6.6" r="1.3" fill="currentColor" stroke="none"/>',
  crew: '<circle cx="10" cy="8" r="4.6"/><path d="M6.6 8.2h6.8M4 17.5c.6-3 2.8-4.6 6-4.6s5.4 1.6 6 4.6"/><path d="M10 3.4V1.6"/><circle cx="10" cy="1.4" r=".9" fill="currentColor" stroke="none"/>',
  science: '<path d="M8 2.5h4M8.8 2.5v5L4.4 15a1.6 1.6 0 0 0 1.4 2.5h8.4a1.6 1.6 0 0 0 1.4-2.5l-4.4-7.5v-5"/><path d="M6.5 12.5h7"/>',
  target: '<circle cx="10" cy="10" r="6"/><circle cx="10" cy="10" r="1.6" fill="currentColor" stroke="none"/><path d="M10 1.5v4M10 14.5v4M1.5 10h4M14.5 10h4"/>',
  dock: '<rect x="2" y="6.5" width="5.5" height="7" rx="1.2"/><rect x="12.5" y="6.5" width="5.5" height="7" rx="1.2"/><path d="M7.5 8.5h2M7.5 11.5h2M10.5 8.5h2M10.5 11.5h2"/>',
  fuel: '<rect x="3.5" y="3" width="8" height="14" rx="1.6"/><path d="M5.5 7h4M11.5 8.5l3 1.8v5.2a1.4 1.4 0 0 0 2.8 0V8l-2.3-2.4"/>',
  groups: '<rect x="2.5" y="2.5" width="6" height="6" rx="1.3"/><rect x="11.5" y="2.5" width="6" height="6" rx="1.3"/><rect x="2.5" y="11.5" width="6" height="6" rx="1.3"/><path d="M14.5 11.5v6M11.5 14.5h6"/>',
  missions: '<path d="M5 3.500h10v13.500H5z"/><path d="M7.500 7.200l1 1 1.800-1.900M7.500 11.700l1 1 1.800-1.900M12 7.800h1.200M12 12.300h1.200"/>',
  guide: '<circle cx="10" cy="10" r="7.2"/><path d="M10 5.2l2.2 6.6L10 10.600 7.800 11.800z" fill="currentColor" stroke="none"/><path d="M10 2.800v1.400M10 15.800v1.400M2.800 10h1.400M15.800 10h1.400"/>',
  assist: '<path d="M4 17c0-7 3-11 12-13M12.5 3.2l3.6.6-1 3.5"/><circle cx="4" cy="17" r="1.3" fill="currentColor" stroke="none"/>',
  recover: '<path d="M3 9a7 7 0 0 1 14 0c0 0-3.2 4.4-5 7h-4c-1.800-2.600-5-7-5-7z"/><path d="M3 9h14M8 16h4v2H8z"/>',
  menu: '<path d="M3.5 5.5h13M3.5 10h13M3.5 14.500h13"/>',
};
const toolSvg = key => `<svg viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${TOOL_ICON[key] || ''}</svg>`;

let cssInjected = false;
export function injectFlightCss() {
  if (cssInjected || typeof document === 'undefined') return;
  cssInjected = true;
  if (document.querySelector('link[data-sw-flight-css]')) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = new URL('../../css/flight.css', import.meta.url).href;
  link.setAttribute('data-sw-flight-css', '1');
  document.head.appendChild(link);
}

const thumbCache = new Map();
function thumb(app, def) {
  let url = thumbCache.get(def.id);
  if (url === undefined) {
    try { url = app.renderer ? renderPartThumbnail(app.renderer, def, 44) : ''; } catch { url = ''; }
    thumbCache.set(def.id, url);
  }
  return url;
}

function setText(node, text) { if (node._t !== text) { node._t = text; node.textContent = text; } }
function setCls(node, cls, on) { if (!!node['_c' + cls] !== !!on) { node['_c' + cls] = !!on; node.classList.toggle(cls, !!on); } }
function setW(node, frac) { const w = Math.round(Math.max(0, Math.min(1, frac)) * 1000) / 10; if (node._w !== w) { node._w = w; node.style.width = w + '%'; } }
function setH(node, frac) { const h = Math.round(Math.max(0, Math.min(1, frac)) * 1000) / 10; if (node._h !== h) { node._h = h; node.style.height = h + '%'; } }
const clamp01 = x => Math.max(0, Math.min(1, x));
const dpr = () => Math.min(window.devicePixelRatio || 1, 2);
function fitCanvas(c, w, h) { const k = Math.min(dpr() * uiScale(), 3);      // w, h are interface pixels: the zoom needs its share of real pixels
  if (c.width !== Math.round(w * k) || c.height !== Math.round(h * k)) { c.width = Math.round(w * k); c.height = Math.round(h * k); c._dirty = true; } return k; }

/** "12,402" + "m"  /  "102.4" + "km"  /  "1.250" + "Mm" */
function splitDist(m) {
  if (!Number.isFinite(m)) return ['—', ''];
  const a = Math.abs(m);
  if (a < 100000) return [fmt.num(m, a < 1000 ? 1 : 0), 'm'];
  const s = fmt.dist(m), i = s.lastIndexOf(' ');
  return [s.slice(0, i), s.slice(i + 1)];
}
function splitSpeed(v) { return [fmt.num(v, Math.abs(v) < 1000 ? 1 : 0), 'm/s']; }

// ---------------------------------------------------------------------------------------------------------------
// Instruments drawn on small canvases
// ---------------------------------------------------------------------------------------------------------------

/** Altimeter digit drums: six rolling digits and a unit lamp (m → km → Mm). */
function drawDrums(c, alt) {
  const W = 190, H = 40, k = fitCanvas(c, W, H);
  let unit = 'm', val = Math.max(0, alt);
  if (val >= 999999.5) { val /= 1000; unit = 'km'; }
  if (val >= 999999.5) { val /= 1000; unit = 'Mm'; }
  const key = unit + Math.round(val * 40);
  if (c._key === key && !c._dirty) return;
  c._key = key; c._dirty = false;
  const g = c.getContext('2d');
  g.setTransform(k, 0, 0, k, 0, 0);
  g.clearRect(0, 0, W, H);
  const N = 6, cw = 24, gap = 2, x0 = 3, top = 3, ch = H - 6;
  g.font = `750 23px ${FONT}`; g.textAlign = 'center'; g.textBaseline = 'middle';
  // odometer: a drum only turns while every drum to its right is rolling over from 9 to 0
  let carry = val % 1;                         // fraction the lowest drum has turned toward its next digit
  carry = carry < 0.6 ? 0 : (carry - 0.6) / 0.4; carry = carry * carry * (3 - 2 * carry);
  let rem = Math.floor(val), lead = true;
  const digits = [];
  for (let i = 0; i < N; i++) { const d = rem % 10; rem = Math.floor(rem / 10); digits.push({ d, roll: carry }); carry = d === 9 ? carry : 0; }
  for (let i = N - 1; i >= 0; i--) {
    const { d, roll } = digits[i];
    const x = x0 + (N - 1 - i) * (cw + gap) + (N - 1 - i >= 3 ? 5 : 0);
    const gr = g.createLinearGradient(0, top, 0, top + ch);
    gr.addColorStop(0, '#05080b'); gr.addColorStop(0.18, '#18202a'); gr.addColorStop(0.5, '#222c38'); gr.addColorStop(0.82, '#18202a'); gr.addColorStop(1, '#05080b');
    g.fillStyle = gr; g.beginPath(); g.roundRect(x, top, cw, ch, 4); g.fill();
    g.save(); g.beginPath(); g.rect(x, top, cw, ch); g.clip();
    if (d !== 0 || roll > 0) lead = false;
    const dim = lead && i > 0;
    g.fillStyle = dim ? '#4d5a69' : '#f2f6fa';
    const cy = top + ch / 2 + 1, off = roll * ch * 0.86;
    g.fillText(String(d), x + cw / 2, cy + off);
    if (roll > 0) { g.fillStyle = '#f2f6fa'; g.fillText(String((d + 1) % 10), x + cw / 2, cy + off - ch * 0.86); }
    g.restore();
    // glass shading
    const sh = g.createLinearGradient(0, top, 0, top + ch);
    sh.addColorStop(0, 'rgba(0,0,0,0.75)'); sh.addColorStop(0.3, 'rgba(0,0,0,0)'); sh.addColorStop(0.7, 'rgba(0,0,0,0)'); sh.addColorStop(1, 'rgba(0,0,0,0.75)');
    g.fillStyle = sh; g.fillRect(x, top, cw, ch);
  }
  // thousands mark
  g.fillStyle = '#39d0c0'; g.fillRect(x0 + 3 * (cw + gap) + 0.5, top + ch - 7, 2, 5);
  g.font = `800 13px ${FONT}`; g.textAlign = 'left'; g.fillStyle = unit === 'm' ? '#39d0c0' : '#ffb347';
  g.fillText(unit, x0 + N * (cw + gap) + 8, top + ch / 2 + 5);
}

/** Vertical-speed dial: a signed, compressed scale (±1, ±10, ±100, ±1000 m/s) with a needle. */
function drawVsDial(c, vs) {
  const S = 62, k = fitCanvas(c, S, S);
  const f = Math.sign(vs) * Math.min(1, Math.log10(1 + Math.abs(vs)) / 3.3);       // −1 … 1
  const key = Math.round(f * 150);
  if (c._key === key && !c._dirty) return;
  c._key = key; c._dirty = false;
  const g = c.getContext('2d');
  g.setTransform(k, 0, 0, k, 0, 0); g.clearRect(0, 0, S, S);
  const cx = S / 2, cy = S / 2, R = S / 2 - 2;
  const face = g.createRadialGradient(cx, cy - 6, 4, cx, cy, R);
  face.addColorStop(0, '#1f2935'); face.addColorStop(1, '#0c1117');
  g.fillStyle = face; g.beginPath(); g.arc(cx, cy, R, 0, Math.PI * 2); g.fill();
  g.strokeStyle = '#33404f'; g.lineWidth = 1.5; g.stroke();
  // zero at 9 o'clock, climb sweeps over the top, descent under the bottom (±150°)
  const ang = t => Math.PI - t * (Math.PI * 150 / 180);
  g.lineCap = 'round';
  for (const [v, big] of [[0, 1], [1, 0], [10, 1], [100, 1], [1000, 1], [3, 0], [30, 0], [300, 0]]) {
    for (const s of v ? [1, -1] : [1]) {
      const t = s * Math.min(1, Math.log10(1 + v) / 3.3), a = ang(t);
      g.strokeStyle = s > 0 ? '#74dd92' : '#ffb347'; if (!v) g.strokeStyle = '#e8eef4';
      g.lineWidth = big ? 1.8 : 1;
      g.beginPath(); g.moveTo(cx + Math.cos(a) * (R - (big ? 7 : 5)), cy - Math.sin(a) * (R - (big ? 7 : 5))); g.lineTo(cx + Math.cos(a) * (R - 2), cy - Math.sin(a) * (R - 2)); g.stroke();
    }
  }
  g.font = `700 7.5px ${FONT}`; g.fillStyle = '#93a3b3'; g.textAlign = 'center'; g.textBaseline = 'middle';
  for (const [v, s] of [[10, 1], [100, 1], [10, -1], [100, -1]]) { const a = ang(s * Math.log10(1 + v) / 3.3); g.fillText(String(v), cx + Math.cos(a) * (R - 13), cy - Math.sin(a) * (R - 13)); }
  g.fillStyle = '#5d6b7a'; g.font = `800 6.5px ${FONT}`; g.fillText('M/S', cx + 9, cy);
  const a = ang(f);
  g.strokeStyle = f >= 0 ? '#74dd92' : '#ffb347'; g.lineWidth = 2.2;
  g.beginPath(); g.moveTo(cx - Math.cos(a) * 5, cy + Math.sin(a) * 5); g.lineTo(cx + Math.cos(a) * (R - 8), cy - Math.sin(a) * (R - 8)); g.stroke();
  g.fillStyle = '#e8eef4'; g.beginPath(); g.arc(cx, cy, 2.6, 0, Math.PI * 2); g.fill();
}

/** Heading tape: a compass strip that slides under a fixed lubber line. */
function drawTape(c, hdg, w) {
  const W = w, H = 18, k = fitCanvas(c, W, H);
  const key = Math.round(hdg * 4) + ':' + W;
  if (c._key === key && !c._dirty) return;
  c._key = key; c._dirty = false;
  const g = c.getContext('2d');
  g.setTransform(k, 0, 0, k, 0, 0); g.clearRect(0, 0, W, H);
  const pxPerDeg = W / 100;
  g.textAlign = 'center'; g.textBaseline = 'middle'; g.lineCap = 'butt';
  const CARD = { 0: 'N', 90: 'E', 180: 'S', 270: 'W' };
  const start = Math.floor((hdg - 55) / 5) * 5;
  for (let d = start; d <= hdg + 55; d += 5) {
    const x = W / 2 + (d - hdg) * pxPerDeg, n = ((d % 360) + 360) % 360;
    const edge = Math.min(1, Math.min(x, W - x) / 22);
    if (edge <= 0) continue;
    g.globalAlpha = edge;
    const major = n % 30 === 0, mid = n % 10 === 0;
    g.strokeStyle = major ? '#e8eef4' : '#7c8b9a'; g.lineWidth = major ? 1.5 : 1;
    g.beginPath(); g.moveTo(x, H); g.lineTo(x, H - (major ? 6 : mid ? 4 : 2.5)); g.stroke();
    if (major) {
      const name = CARD[n];
      g.font = `${name ? 850 : 700} ${name ? 10.5 : 9}px ${FONT}`; g.fillStyle = name ? '#ffb347' : '#cbd6e0';
      g.fillText(name || String(n / 10).padStart(2, '0'), x, 6);
    }
  }
  g.globalAlpha = 1;
  g.fillStyle = '#39d0c0'; g.beginPath(); g.moveTo(W / 2 - 4, 0); g.lineTo(W / 2 + 4, 0); g.lineTo(W / 2, 5); g.closePath(); g.fill();
}

// ---------------------------------------------------------------------------------------------------------------
// Pip portraits: drawn faces that react to g-force, danger and good news
// ---------------------------------------------------------------------------------------------------------------
function hashName(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0) / 4294967296; }
/**
 * mood: { g (felt g), fear 0..1, joy 0..1, shake 0..1, away: bool }   t: seconds
 */
function drawPip(c, name, mood, t) {
  const W = 56, H = 56, k = fitCanvas(c, W, H);
  const g = c.getContext('2d');
  g.setTransform(k, 0, 0, k, 0, 0); g.clearRect(0, 0, W, H);
  const h = hashName(name), h2 = hashName(name + '~');
  const G = Math.max(0, mood.g || 0), fear = clamp01(mood.fear || 0), joy = clamp01(mood.joy || 0) * (1 - fear);
  const press = clamp01((G - 1.6) / 4.5);                // pressed into the seat
  const jit = (mood.shake || 0) * 1.6;
  const bob = Math.sin(t * 1.7 + h * 6) * 0.8 * (1 - press) + press * 2.6 + (Math.sin(t * 61 + h * 9) * jit);
  const sway = Math.sin(t * 0.9 + h2 * 6) * 0.9 * (1 - press) + Math.sin(t * 47 + h) * jit;
  // cabin backdrop
  const bg = g.createLinearGradient(0, 0, 0, H);
  bg.addColorStop(0, '#1b2531'); bg.addColorStop(1, '#0c1117');
  g.fillStyle = bg; g.fillRect(0, 0, W, H);
  g.strokeStyle = 'rgba(255,255,255,0.05)'; g.lineWidth = 1;
  for (let i = 0; i < 3; i++) { g.beginPath(); g.moveTo(0, 12 + i * 15); g.lineTo(W, 9 + i * 15); g.stroke(); }
  if (fear > 0.5) { g.fillStyle = `rgba(255,70,60,${0.12 + 0.1 * Math.sin(t * 9)})`; g.fillRect(0, 0, W, H); }
  g.save(); g.translate(W / 2 + sway, H / 2 + 3 + bob);
  // suit shoulders + collar ring
  g.fillStyle = '#ff8a3d'; g.beginPath(); g.ellipse(0, 27, 24, 12, 0, 0, Math.PI * 2); g.fill();
  g.fillStyle = '#d96a25'; g.beginPath(); g.ellipse(0, 19.5, 13, 4, 0, 0, Math.PI * 2); g.fill();
  // bobble antenna
  g.strokeStyle = '#c9d3dc'; g.lineWidth = 1.4; g.beginPath(); g.moveTo(9, -17); g.quadraticCurveTo(13 + sway * 0.6, -24, 12 + sway * 1.4, -27); g.stroke();
  g.fillStyle = '#39d0c0'; g.beginPath(); g.arc(12 + sway * 1.4, -27.5, 2.3, 0, Math.PI * 2); g.fill();
  // helmet shell and visor opening
  g.fillStyle = '#eef2f5'; g.beginPath(); g.arc(0, 0, 20, 0, Math.PI * 2); g.fill();
  g.fillStyle = '#c9d1d9'; g.beginPath(); g.arc(0, 0, 20, 0.35, 2.8); g.fill();
  g.fillStyle = '#10161d'; g.beginPath(); g.ellipse(0, 1, 15.5, 14.5, 0, 0, Math.PI * 2); g.fill();
  if (!mood.away) {
    // face: a soft round head in one of a few warm tones
    const tones = ['#f3cfa6', '#e2b58c', '#c9966b', '#a9764f', '#f0d9c0'];
    g.fillStyle = tones[Math.floor(h * tones.length)];
    g.beginPath(); g.ellipse(0, 2.5 + press * 1.5, 12.2, 11.6 - press * 1.2, 0, 0, Math.PI * 2); g.fill();
    // cheeks
    g.fillStyle = `rgba(255,120,110,${0.22 + 0.3 * press + 0.2 * joy})`;
    g.beginPath(); g.ellipse(-7.5, 6.5, 2.6, 1.8, 0, 0, Math.PI * 2); g.ellipse(7.5, 6.5, 2.6, 1.8, 0, 0, Math.PI * 2); g.fill();
    // eyes: look around, blink, squint under g, go wide with fear
    const blinkT = (t * 0.37 + h * 10) % 1, blink = blinkT > 0.965 ? 0.12 : 1;
    const lookX = fear > 0.4 ? Math.sin(t * 13 + h) * 1.2 : Math.sin(t * 0.6 + h * 20) * 1.5, lookY = fear > 0.4 ? 0 : Math.sin(t * 0.43 + h2 * 9) * 0.8;
    const eyeH = (3.1 + fear * 1.4) * blink * (1 - 0.72 * press * (1 - fear)) * (joy > 0.5 ? 0.55 : 1);
    for (const sx of [-1, 1]) {
      g.fillStyle = '#fff'; g.beginPath(); g.ellipse(sx * 4.6, 0.5 + press, 3.1 + fear * 0.5, Math.max(0.5, eyeH), 0, 0, Math.PI * 2); g.fill();
      if (eyeH > 1) { g.fillStyle = '#1c232b'; g.beginPath(); g.arc(sx * 4.6 + lookX, 0.7 + press + lookY, Math.min(1.7 - fear * 0.5, eyeH), 0, Math.PI * 2); g.fill(); }
      // brows
      g.strokeStyle = '#4a3423'; g.lineWidth = 1.3; g.lineCap = 'round';
      const by = -4.4 - fear * 1.6 + press * 1.6, tilt = (fear * 1.6 - press * 1.4) * sx;
      g.beginPath(); g.moveTo(sx * 2.2, by + tilt * -0.6); g.lineTo(sx * 7.2, by + tilt * 0.6); g.stroke();
    }
    // mouth
    g.strokeStyle = '#5a2a22'; g.fillStyle = '#5a2a22'; g.lineWidth = 1.5;
    const my = 8.2 + press;
    if (fear > 0.45) { g.beginPath(); g.ellipse(0, my + 0.5, 2.6, 2.2 + fear * 1.4 + Math.sin(t * 17) * 0.4, 0, 0, Math.PI * 2); g.fill(); }
    else if (press > 0.55) { g.fillStyle = '#fff'; g.beginPath(); g.roundRect(-4, my - 1.3, 8, 2.8, 1.2); g.fill(); g.stroke(); g.beginPath(); g.moveTo(-1.4, my - 1.3); g.lineTo(-1.4, my + 1.5); g.moveTo(1.4, my - 1.3); g.lineTo(1.4, my + 1.5); g.lineWidth = 0.8; g.stroke(); }
    else if (press > 0.2) { g.beginPath(); g.moveTo(-3.2, my); g.lineTo(3.2, my); g.stroke(); }
    else if (joy > 0.5) { g.beginPath(); g.moveTo(-4.4, my - 1.4); g.quadraticCurveTo(0, my + 4.6, 4.4, my - 1.4); g.closePath(); g.fill(); }
    else { g.beginPath(); g.moveTo(-3.4, my - 0.6); g.quadraticCurveTo(0, my + 2.2 + joy * 2, 3.4, my - 0.6); g.stroke(); }
  }
  // visor glass
  const gl = g.createLinearGradient(-12, -12, 10, 12);
  gl.addColorStop(0, 'rgba(190,235,255,0.34)'); gl.addColorStop(0.4, 'rgba(190,235,255,0.05)'); gl.addColorStop(1, 'rgba(120,200,255,0.12)');
  g.fillStyle = gl; g.beginPath(); g.ellipse(0, 1, 15.5, 14.5, 0, 0, Math.PI * 2); g.fill();
  g.strokeStyle = 'rgba(255,255,255,0.5)'; g.lineWidth = 1.2; g.beginPath(); g.arc(0, 1, 12.5, Math.PI * 1.1, Math.PI * 1.42); g.stroke();
  g.restore();
}

export function createHud(app, act) {
  injectFlightCss();
  const root = el('div', { class: 'fl-root', data: { screen: 'flight-hud' } });
  const values = {};
  let panel = null, panelKind = null, panelKey = '';
  let hiddenNow = false;       // (the render loop asks every frame: a flag, not a classList lookup)
  let slow = 0, stageKey = '', ballRectCache = null, rectAge = 0, camTagTimer = 0, clock = 0, faceAcc = 0, crewKey = '';
  let lastWorld = null, lastVessel = null, lastState = null;
  let panelLive = null;                    // refreshes the open panel's numbers in place (no rebuild, so clicks land)
  const xfer = { res: '', from: null, to: null };
  const store = (k, v) => { try { if (v === undefined) return localStorage.getItem('starwright.hud.' + k); localStorage.setItem('starwright.hud.' + k, v); } catch { /* private mode */ } return null; };
  const blurClick = fn => e => { e.currentTarget.blur(); fn(e); };

  // ---------------------------------------------------------------- top-left: clock + warp, vessel, target
  const nMet = el('span', { class: 'fl-num', text: 'T− ready' });
  const nDate = el('span', { class: 'fl-date' });
  const nRate = el('span', { class: 'fl-warp-rate', text: '1×' });
  const warpSteps = [];
  const warpBox = el('div', { class: 'fl-warp', data: { hud: 'warp' } });
  const RATES = [1, 2, 3, 4, 5, 10, 50, 100, 1000, 10000, 100000];
  const rateLabel = r => (r >= 1000 ? (r / 1000) + 'k' : String(r)) + '×';
  warpBox.appendChild(el('button', { class: 'fl-warp-step arrow', text: '◂', tip: 'Slower (,)', attrs: { type: 'button', 'data-warp': 'down' }, on: { click: blurClick(() => act.warpDelta(-1)) } }));
  RATES.forEach((r, i) => {
    if (i === 4) warpBox.appendChild(el('span', { class: 'fl-warp-sep' }));
    const b = el('button', { class: 'fl-warp-step pip' + (i >= 4 ? ' rails' : ''), tip: rateLabel(r) + (i >= 4 ? ' (on rails)' : i ? ' (physics · Alt+.)' : ' real time'), attrs: { type: 'button', 'data-warp': String(i) }, on: { click: blurClick(() => act.setWarp(i)) } });
    warpSteps.push(b); warpBox.appendChild(b);
  });
  warpBox.appendChild(el('button', { class: 'fl-warp-step arrow', text: '▸', tip: 'Faster (.)', attrs: { type: 'button', 'data-warp': 'up' }, on: { click: blurClick(() => act.warpDelta(1)) } }));
  const timeBar = el('div', { class: 'fl-inst fl-time', data: { hud: 'time' } },
    el('div', { class: 'fl-met' }, el('span', { class: 'sw-label', text: 'MET' }), nMet, nDate),
    el('div', { class: 'fl-warp-row' }, warpBox, nRate));

  const nName = el('div', { class: 'fl-vessel-name', text: '—' });
  const nSit = el('div', { class: 'fl-vessel-sit' });
  const vesselCard = el('div', { class: 'fl-inst fl-vessel', data: { hud: 'vessel' } }, nName, nSit);

  const nTgtName = el('b', { class: 'nm' });
  const nTgtDist = el('span', { class: 'v' }), nTgtRel = el('span', { class: 'v' }), nTgtCa = el('span', { class: 'v' });
  const tgtCaRow = el('div', { class: 'row ca' }, el('span', { class: 'k', text: 'Closest' }), nTgtCa);
  const targetCard = el('div', { class: 'fl-inst fl-target sw-hidden', data: { hud: 'target' } },
    el('div', { class: 'head' }, el('span', { class: 'sw-label', text: 'Target' }), nTgtName,
      el('button', { text: '×', tip: 'Clear the target (Shift+Y)', attrs: { type: 'button', 'aria-label': 'Clear target', 'data-action': 'clear-target' }, on: { click: blurClick(() => act.clearTarget()) } })),
    el('div', { class: 'row' }, el('span', { class: 'k', text: 'Dist', tip: 'Distance to the target' }), nTgtDist, el('span', { class: 'gap' }), el('span', { class: 'k', text: 'Rel', tip: 'Speed relative to the target (▸◂ closing, ◂▸ opening)' }), nTgtRel),
    tgtCaRow);
  const topLeft = el('div', { class: 'fl-tl' }, timeBar, vesselCard, targetCard);

  // ---------------------------------------------------------------- top-centre: altimeter cluster
  const kvRow = (box, k, cls = '') => { const v = el('span', { class: 'v ' + cls }); box.append(el('span', { class: 'k', text: k }), v); return v; };
  const drums = el('canvas', { class: 'fl-drums' });
  const vsDial = el('canvas', { class: 'fl-vsdial' });
  const altText = el('span', { class: 'v' }), altUnit = el('small');
  const altBig = el('div', { class: 'fl-big fl-sr' }, el('span', { class: 'sw-label', text: 'Altitude' }), el('span', { class: 'v' }, altText, altUnit));
  const kvAlt = el('div', { class: 'fl-kv alt' });
  const nRadar = kvRow(kvAlt, 'Above ground'), nVs = kvRow(kvAlt, 'Vertical');
  const kvOrb = el('div', { class: 'fl-kv orb' });
  const nAp = kvRow(kvOrb, 'Apoapsis', 'teal'), nPe = kvRow(kvOrb, 'Periapsis', 'blue');
  const atmoFill = el('i'), atmoMark = el('b');
  const kvAir = el('div', { class: 'fl-kv air' });
  const nQ = kvRow(kvAir, 'Air pressure'), nHeat = kvRow(kvAir, 'Hull heat');
  const atmoBox = el('div', { class: 'fl-atmo', tip: 'Atmosphere depth: how much air is still around the vessel' },
    el('div', { class: 'fl-atmo-cap' }, el('span', { text: 'SPACE' }), el('span', { class: 'mid', text: 'ATMOSPHERE' }), el('span', { text: 'SURFACE' })),
    el('div', { class: 'fl-atmo-bar' }, atmoFill, atmoMark), kvAir);
  const altCluster = el('div', { class: 'fl-inst fl-alt', data: { hud: 'altitude' } },
    el('div', { class: 'fl-vs', tip: 'Vertical speed' }, vsDial),
    el('div', { class: 'fl-alt-mid' }, el('div', { class: 'fl-drum-frame' }, drums), altBig, kvAlt),
    atmoBox, kvOrb);

  // ---------------------------------------------------------------- top-right: resources + toolbar
  const resRows = {};
  const resBody = el('div', { class: 'fl-res-body' });
  const nStageFuelRow = el('div', { class: 'fl-res-row stage' }, el('span', { class: 'nm', text: 'This stage' }), el('div', { class: 'sw-bar' }, el('i')), el('span', { class: 'amt' }));
  resBody.appendChild(nStageFuelRow);
  for (const [key, name, , tone] of RES) {
    const row = el('div', { class: 'fl-res-row', data: { res: key } }, el('span', { class: 'nm', text: name }), el('div', { class: 'sw-bar' + (tone ? ' ' + tone : '') }, el('i')), el('span', { class: 'amt' }));
    resRows[key] = row; resBody.appendChild(row);
  }
  const nDv = el('b', { text: '—' }), nDvStage = el('span', { class: 'st' });
  const resHead = el('button', { class: 'fl-res-head', tip: 'Fold / unfold the resources', attrs: { type: 'button', 'data-action': 'res-fold' }, on: { click: blurClick(() => { const f = !resBox.classList.contains('folded'); resBox.classList.toggle('folded', f); store('resFolded', f ? '1' : '0'); hud.invalidate(); }) } },
    el('span', { class: 'sw-label', text: 'Resources' }), el('span', { class: 'caret', text: '▾' }));
  const resBox = el('div', { class: 'fl-inst fl-res' + (store('resFolded') === '1' ? ' folded' : ''), data: { hud: 'resources' } }, resHead, resBody,
    el('div', { class: 'fl-dv', tip: 'Δv the engines can still deliver in vacuum (rocket equation, all stages). The push of separators (about 1 m/s per staging) is not counted.' }, el('span', { class: 'sw-label', text: 'Δv' }), nDvStage, nDv));
  // structure: the load on the most strained joint as a share of what it can take (vessel.structure, docs/STRUCTURE.md).
  // Teal below 50 %, amber from 50 %, red from 90 %; "--" while there is nothing to read (on the ground, on rails).
  // The line under it names the joint and the cause; it opens on hover, with the stress overlay, and from amber up.
  const stFill = el('i'), nStPct = el('span', { class: 'amt', text: '--' }), nStWhy = el('div', { class: 'fl-struct-why' });
  const structBox = el('button', { class: 'fl-struct', attrs: { type: 'button', 'data-hud': 'structure', 'data-action': 'stress-overlay', 'aria-label': 'Structure: load on the most strained joint' }, on: { click: blurClick(() => act.toggleStress()) } },
    el('div', { class: 'fl-res-row' }, el('span', { class: 'nm', text: 'Structure' }), el('div', { class: 'sw-bar' }, stFill), nStPct), nStWhy);
  tooltip(structBox, () => 'Structure: the load on the most strained joint, as a share of what it can take. ' + (stWhy ? stWhy + '. ' : '') + 'Click (or press ' + (act.keyLabel ? act.keyLabel('stress') : ';') + ') to mark every joint on the vessel.');
  let stShown = 0, stPct = -1, stWhy = '', stFlash = 0, stStamp = -1, stWhyPct = -1;
  setCls(structBox, 'sw-hidden', true); setCls(structBox, 'idle', true);
  resBox.appendChild(structBox);

  const tool = (key, label, kbd, tip, fn, cls = '') => {
    const b = el('button', { class: 'fl-tool ' + cls, tip: label + (kbd ? '  [' + kbd + ']' : '') + (tip ? ' — ' + tip : ''), attrs: { type: 'button', 'data-tool': key, 'aria-label': label }, on: { click: blurClick(fn) } });
    b.innerHTML = toolSvg(key);
    b.appendChild(el('span', { class: 'fl-tool-label', text: label }));
    return b;
  };
  const bMap = tool('map', 'Map', 'M', 'orbital map', () => act.toggleMap());
  const bSci = tool('science', 'Science', '', 'experiments aboard', () => hud.togglePanel('science'));
  const bTarget = tool('target', 'Target', 'Y', 'pick a vessel or a world to navigate to (Shift+Y clears)', () => hud.togglePanel('target'));
  const bDock = tool('dock', 'Dock', '', 'Latch Rings: docking assist and undocking', () => hud.togglePanel('dock'));
  const bFuel = tool('fuel', 'Fuel', '', 'pump propellant, monoprop or charge between tanks', () => hud.togglePanel('fuel'));
  const bGroups = tool('groups', 'Action groups', '1–9', 'fire a group of parts with one key', () => hud.togglePanel('groups'));
  const bCrew = tool('crew', 'Crew', '', 'Pips aboard, spacewalks', () => hud.togglePanel('crew'));
  const bGuide = tool('guide', 'Autopilot', '', 'guidance programs: take-off and landing, transfers to other worlds, flying a planned burn', () => hud.togglePanel('guide'));
  const bMissions = tool('missions', 'Missions', 'O', 'the next program mission and your active contracts, with live progress', () => hud.togglePanel('missions'));
  const panelBtn = { crew: bCrew, science: bSci, target: bTarget, dock: bDock, fuel: bFuel, groups: bGroups, guide: bGuide, missions: bMissions };
  const bAssist = tool('assist', 'Ascent assist', '', 'let the guidance computer fly a gravity turn to orbit', () => act.toggleAssist());
  const bRecover = tool('recover', 'Recover', '', 'recover the vessel and its crew', () => act.recover(), 'amber');
  const bMenu = tool('menu', 'Menu', 'Esc', 'pause menu', () => act.openMenu());
  const tools = el('div', { class: 'fl-tools', data: { hud: 'tools' } }, bMap, bMissions, bSci, bTarget, bDock, bFuel, bGroups, bCrew, bGuide, bAssist, bRecover, bMenu);

  // ---------------------------------------------------------------- bottom-left: staging stack
  const stageList = el('div', { class: 'fl-stage-list' });
  const nStageNum = el('b', { text: '0' }), nStageWord = el('span', { class: 'w', text: 'Stage' });
  const stageBig = el('button', { class: 'fl-stage-big', tip: 'Fire the next stage (Space)', attrs: { type: 'button', 'data-action': 'stage' }, on: { click: blurClick(() => act.stage()) } },
    nStageNum, el('span', { class: 'col' }, nStageWord, el('span', { class: 'sw-kbd', text: 'Space' })));
  const stageBox = el('div', { class: 'fl-stages', data: { hud: 'stages' } }, stageList, stageBig);
  let stageBars = [];

  // ---------------------------------------------------------------- bottom-centre: the attitude ball console
  const overlay = el('canvas', { attrs: { width: 344, height: 344 } });
  const ballNode = el('div', { class: 'fl-ball', data: { hud: 'ball' } }, overlay);
  const tape = el('canvas', { class: 'fl-tape' });
  const nHdg = el('div', { class: 'fl-hdg', data: { hud: 'heading' } });
  // speed read-out above the ball (click or C cycles the reference)
  const nModeChip = el('span', { class: 'fl-mode-chip', text: 'Surface', attrs: { 'data-hud': 'speedmode' } });
  const spdText = el('span', { class: 'v' }), spdUnit = el('small');
  const spdBig = el('button', { class: 'fl-big fl-speed', tip: 'Speed reference: surface / orbit / target (C)', attrs: { type: 'button', 'data-hud': 'speed' }, on: { click: blurClick(() => act.toggleSpeedMode()) } }, nModeChip, el('span', { class: 'v' }, spdText, spdUnit));
  const light = (key, label, tip, fn, cls = '') => el('button', { class: 'fl-light ' + cls, text: label, tip, attrs: { type: 'button', 'data-light': key }, on: { click: blurClick(fn) } });
  const lSas = light('sas', 'SAS', 'Stability assist (T)', () => act.toggleSas());
  const lRcs = light('rcs', 'RCS', 'Reaction thrusters (R)', () => act.toggleRcs(), 'amber');
  const lSolar = light('solar', 'PNL', 'Solar panels (U)', () => act.toggleSolar(), 'amber');
  const lLegs = light('legs', 'GEAR', 'Landing legs and gear (G)', () => act.toggleLegs());
  const lLamp = light('lights', 'LGT', 'Lights (U)', () => act.toggleLights(), 'amber');
  const lBrake = light('brakes', 'BRK', 'Brakes (B: hold, or click to lock)', () => act.toggleBrakes(), 'red');
  const lightsL = el('div', { class: 'fl-lights' }, lSas, lRcs, lSolar);
  const lightsR = el('div', { class: 'fl-lights r' }, lLegs, lLamp, lBrake);
  const modeBtns = {};
  const mkMode = (mode, tip, glyph, cls = '') => {
    let inner;
    if (glyph) { inner = el('canvas', { attrs: { width: 36, height: 36 } }); drawGlyph(inner.getContext('2d'), glyph, 18, 18, 11.5); }
    else inner = el('span', { text: 'HOLD' });
    const b = el('button', { class: 'fl-sasmode ' + cls, tip: 'SAS: ' + tip, attrs: { type: 'button', 'data-sas': mode }, on: { click: blurClick(() => act.setSasMode(mode)) } }, inner);
    modeBtns[mode] = b; return b;
  };
  const modes = el('div', { class: 'fl-modes', data: { hud: 'sasmodes' } }, SAS_BUTTONS.map(([m, tip, glyph]) => mkMode(m, tip, glyph)));
  const tmodes = el('div', { class: 'fl-tmodes', data: { hud: 'targetmodes' } }, TARGET_SAS_BUTTONS.map(([m, tip, glyph]) => mkMode(m, tip, glyph, 'tgt')));
  const sasPanel = el('div', { class: 'fl-sas' }, el('span', { class: 'sw-label', text: 'SAS' }), modes, tmodes);
  // throttle gauge (left edge of the ball)
  const thrFill = el('i'), thrKnob = el('b');
  const setThr = e => { const r = thrBar.getBoundingClientRect(); act.setThrottle(1 - (e.clientY - r.top) / r.height); };
  const thrBar = el('div', { class: 'fl-thr-bar', tip: 'Throttle (Shift / Ctrl · Z full · X cut)', on: { pointerdown: e => { setThr(e); try { thrBar.setPointerCapture(e.pointerId); } catch { /* synthetic */ } }, pointermove: e => { if (e.buttons & 1) setThr(e); } } }, thrFill, thrKnob);
  const nThr = el('span', { class: 'fl-thr-pct', text: '0%' });
  const nTwr = el('span', { class: 'fl-twr', text: '' });
  const throttle = el('div', { class: 'fl-throttle', data: { hud: 'throttle' } }, el('span', { class: 'cap', text: 'THR' }), thrBar, nThr, nTwr);
  // g-meter (right edge of the ball)
  const gFill = el('i'), gMark = el('b');
  const nG = el('span', { class: 'fl-g-num', text: '1.0' });
  const kvG = el('div', { class: 'fl-kv fl-sr' }); const nGText = kvRow(kvG, 'G-force');
  const gMeter = el('div', { class: 'fl-gmeter', data: { hud: 'gmeter' }, tip: 'G-force felt by the crew' }, el('span', { class: 'cap', text: 'G' }), el('div', { class: 'fl-g-bar' }, gFill, gMark), nG, kvG);
  // maneuver panel (right of the ball): Δv gauge + burn-time bar; attitude numbers when nothing is planned
  const nNodeDv = el('b'), nNodeT = el('b'), nNodeBurn = el('b');
  const dvFill = el('i'), burnFill = el('i');
  const nodeCard = el('div', { class: 'fl-node sw-hidden', data: { hud: 'node' } },
    el('div', { class: 'fl-dv-gauge', tip: 'Δv still to burn for the maneuver' }, dvFill),
    el('div', { class: 'fl-node-txt' },
      el('span', { class: 'k', text: 'Burn' }), nNodeDv,
      el('span', { class: 'k', text: 'node in' }), nNodeT,
      el('span', { class: 'k', text: 'burn time' }), nNodeBurn,
      el('div', { class: 'fl-burn-bar', tip: 'Burn-time bar: empties as the burn runs; amber while waiting for ignition' }, burnFill)));
  const nAttH = el('b'), nAttP = el('b'), nAttR = el('b');
  const attCard = el('div', { class: 'fl-att', data: { hud: 'attitude' } }, el('span', { class: 'k', text: 'HDG' }), nAttH, el('span', { class: 'k', text: 'PIT' }), nAttP, el('span', { class: 'k', text: 'ROL' }), nAttR);
  const rightPanel = el('div', { class: 'fl-rp' }, nodeCard, attCard);
  const ballWrap = el('div', { class: 'fl-ballwrap' }, el('div', { class: 'fl-hub-bg' }), throttle, ballNode, gMeter);
  const hubTop = el('div', { class: 'fl-hub-top' }, lightsL, el('div', { class: 'fl-hub-mid' }, spdBig, tape, nHdg), lightsR);
  const consoleBox = el('div', { class: 'fl-console', data: { hud: 'console' } }, hubTop, el('div', { class: 'fl-hub-row' }, sasPanel, ballWrap, rightPanel));

  // ---------------------------------------------------------------- above the console: tips and alerts
  const alerts = el('div', { class: 'fl-alerts' });
  const above = el('div', { class: 'fl-above' }, alerts);
  let alertKey = '';

  // ---------------------------------------------------------------- bottom-right: crew portraits
  const crewBox = el('div', { class: 'fl-crew', data: { hud: 'crew' } });
  let faces = [];      // { name, canvas, joyUntil }
  let joyUntil = 0;

  // ---------------------------------------------------------------- EVA bar
  const nEvaFuel = el('i');
  const evaBtn = (key, label, fn) => el('button', { class: 'sw-btn small', attrs: { type: 'button', 'data-eva': key }, on: { click: blurClick(fn) } }, label);
  const evaBar = el('div', { class: 'fl-inst fl-eva sw-hidden', data: { hud: 'eva' } },
    el('div', { class: 'sw-label', text: 'Spacewalk' }),
    el('div', { class: 'row' }, evaBtn('board', 'Board (F)', () => act.board()), evaBtn('flag', 'Plant flag (P)', () => act.plantFlag())),
    el('div', { class: 'row' }, evaBtn('report', 'Spacewalk report', () => act.evaExperiment('eva_report')), evaBtn('sample', 'Surface sample', () => act.evaExperiment('surface_sample'))),
    el('div', { class: 'fl-res-row' }, el('span', { class: 'nm', text: 'Jetpack' }), el('div', { class: 'sw-bar' }, nEvaFuel), el('span', { class: 'amt' })),
    el('div', { class: 'keys', html: '<b>W A S D</b> walk / fly · <b>Space</b> jump · <b>R</b> jetpack · <b>Shift / Ctrl</b> up / down · <b>F</b> board · <b>[ ]</b> switch' }));

  // ---------------------------------------------------------------- hint, centre message, camera tag
  // The hint card is contextual: flight.js decides what to say (see setHint), the HUD only draws it.
  const hintBody = el('span', { class: 'fl-hint-body' });
  const hint = el('div', { class: 'fl-inst fl-hint sw-hidden', data: { hud: 'hint' } }, hintBody,
    el('button', { text: '×', tip: 'Dismiss this tip (all tips: Settings → Show hints)', attrs: { type: 'button', 'aria-label': 'Dismiss' }, on: { click: () => act.dismissHint() } }));
  let hintKey = '';
  const center = el('div', { class: 'fl-card fl-center sw-hidden', data: { hud: 'center' } });
  const camTag = el('div', { class: 'fl-cam-tag' });

  above.prepend(hint);
  root.append(topLeft, altCluster, resBox, tools, stageBox, above, consoleBox, crewBox, evaBar, camTag, center);

  /** One word for what firing a stage does. */
  function stageWhat(v, ids) {
    let eng = false, dec = false, chute = false;
    for (const id of ids) { const p = v.parts.get(id); if (!p) continue; if (p.def.engine) eng = true; else if (p.def.decoupler || p.def.dec || /^dec|sep/.test(p.def.id)) dec = true; else if (p.def.chute || /chute/.test(p.def.id)) chute = true; }
    return eng && dec ? 'Stage' : eng ? 'Ignite' : dec ? 'Separate' : chute ? 'Parachute' : 'Activate';
  }
  // ---------------------------------------------------------------- stage stack builder
  function buildStages(v) {
    clear(stageList); stageBars = [];
    const none = v.type === 'eva' || !v.stages.length;
    setCls(stageBox, 'sw-hidden', none);
    if (none) return;
    const first = Math.max(0, v.stageIndex - 1);
    const engines = v.engines || [];
    // top of the stack = fired last
    for (let i = v.stages.length - 1; i >= first; i--) {
      const ids = v.stages[i];
      const live = i === v.stageIndex - 1, next = i === v.stageIndex;
      const counts = new Map();
      for (const id of ids) { const p = v.parts.get(id); if (p) counts.set(p.def, (counts.get(p.def) || 0) + 1); }
      if (!counts.size && !next) continue;
      const icons = el('div', { class: 'fl-stage-icons' });
      for (const [def, n] of counts) {
        const url = thumb(app, def);
        icons.appendChild(el('div', { class: 'fl-stage-ico', tip: def.name + (n > 1 ? ' ×' + n : '') }, url ? el('img', { src: url, alt: '' }) : null, n > 1 ? el('i', { text: '×' + n }) : null));
      }
      const fill = el('i');
      const hasEng = ids.some(id => { const p = v.parts.get(id); return p && p.def.engine; });
      const nDvS = el('span', { class: 'dv' });
      const card = el('div', { class: 'fl-stage ' + (live ? 'live' : next ? 'next' : 'later'), data: { stage: String(i) } },
        el('div', { class: 'fl-stage-num', text: String(v.stages.length - 1 - i) }),
        el('div', { class: 'fl-stage-main' },
          el('div', { class: 'fl-stage-head' }, el('span', { class: 'tag', text: live ? 'Active' : stageWhat(v, ids) }), nDvS),
          icons,
          hasEng ? el('div', { class: 'sw-bar thin' }, fill) : null));
      stageList.appendChild(card);
      if (hasEng) stageBars.push({ i, ids, fill, nDvS, engines: engines.filter(e => ids.includes(e.part.id)) });
    }
    const left = Math.max(0, v.stages.length - v.stageIndex);
    setText(nStageNum, String(left));
    setText(nStageWord, v.situation === 'prelaunch' && v.stageIndex === 0 ? 'Launch' : left ? 'Stage' : 'Done');
    setCls(stageBig, 'done', !left);
    setCls(stageBig, 'launch', v.situation === 'prelaunch' && v.stageIndex === 0);
  }
  function updateStageBars(v) {
    for (const s of stageBars) {
      let amt = 0, max = 0; const seen = new Set();
      for (const e of s.engines) {
        const p = e.part;
        if (!v.parts.has(p.id)) continue;
        if (p.def.engine.type === 'solid') { amt += p.res.solid || 0; max += p.def.res.solid || 0; }
        else for (const t of e.tanks) { if (seen.has(t.id) || !v.parts.has(t.id)) continue; seen.add(t.id); const key = p.def.engine.type === 'ion' && 'xenon' in t.res ? 'xenon' : 'fuel'; amt += t.res[key] || 0; max += t.def.res[key] || 0; }
      }
      setW(s.fill, max > 0 ? amt / max : 0);
      const info = (v.stageInfo || []).find(x => x.stage === s.i);
      setText(s.nDvS, info && info.dv > 0.5 ? fmt.num(info.dv) + ' m/s' : '');
    }
  }

  // ---------------------------------------------------------------- crew portraits
  function buildCrew(v) {
    clear(crewBox); faces = [];
    if (!v) return;
    const seats = [];
    for (const p of v.parts.values()) if ((p.def.crew || 0) > 0 || p.crew.length) seats.push(p);
    const canMove = v.type === 'ship' && seats.length > 1;
    for (const p of v.parts.values()) {
      for (const name of p.crew) {
        const canvas = el('canvas', { class: 'fl-face' });
        const card = el('div', { class: 'fl-pip', data: { pip: name } }, canvas, el('div', { class: 'nm', text: name }),
          el('div', { class: 'btns' },
            v.type !== 'eva' ? el('button', { text: 'EVA', tip: 'Send ' + name + ' outside', attrs: { type: 'button', 'data-portrait': 'eva' }, on: { click: blurClick(() => act.evaStart(p.id, name)) } }) : el('button', { text: 'Board', tip: 'Climb back in (F)', attrs: { type: 'button', 'data-portrait': 'board' }, on: { click: blurClick(() => act.board()) } }),
            canMove ? el('button', { text: '⇄', tip: 'Move ' + name + ' to another seat', attrs: { type: 'button', 'data-portrait': 'transfer' }, on: { click: blurClick(() => act.transferCrew(name)) } }) : null));
        crewBox.appendChild(card);
        faces.push({ name, canvas, part: p });
      }
    }
  }
  function drawFaces(v, state) {
    if (!faces.length || hiddenNow) return;
    const g = v.gForce || 0;
    const danger = clamp01(state.danger || 0);
    const joy = clock < joyUntil ? 1 : (v.situation === 'orbit' || (v.landed && v.situation !== 'prelaunch') ? 0.45 : 0.2);
    const shake = clamp01((state.rumble || 0) * 0.8 + (state.buffet || 0) * 0.8);
    for (const f of faces) drawPip(f.canvas, f.name, { g: v.type === 'eva' ? 0.3 : g, fear: danger, joy, shake }, clock);
  }

  // ---------------------------------------------------------------- pop-over panels
  function closePanel() { if (panel) panel.remove(); panel = null; panelKind = null; panelKey = ''; panelLive = null; for (const k in panelBtn) setCls(panelBtn[k], 'active', false); }
  function crewRows(v) {
    const rows = [];
    for (const p of v.parts.values()) {
      for (const name of p.crew) {
        rows.push(el('div', { class: 'fl-pop-row', data: { crew: name } }, el('div', { class: 'fl-pip-dot' }),
          el('div', { class: 'grow' }, el('b', { text: name }), el('span', { text: v.type === 'eva' ? 'On a spacewalk' : 'In the ' + p.def.name })),
          v.type !== 'eva' ? el('button', { class: 'sw-btn small', text: 'EVA', tip: 'Send ' + name + ' outside', attrs: { type: 'button', 'data-action': 'eva' }, on: { click: () => act.evaStart(p.id, name) } }) : null));
      }
    }
    if (!rows.length) rows.push(el('div', { class: 'sw-empty', text: 'No Pips aboard. This craft flies itself.' }));
    return rows;
  }
  function scienceRows(v) {
    const career = app.career, rows = [];
    const sit = situationOf(v), body = v.body;
    const uses = !career || career.usesScience !== false;
    rows.push(el('div', { class: 'sw-label', text: 'Experiments · ' + (SITUATION_NAMES[sit] || sit) + ' ' + body.name }));
    let any = false;
    const list = [];
    for (const p of v.parts.values()) if (p.def.experiment) list.push([p, p.def.experiment]);
    if (v.type === 'eva') { const p = v.controlPart; if (p) list.push([p, 'eva_report'], [p, 'surface_sample']); }
    for (const [p, exp] of list) {
      const def = EXPERIMENTS[exp]; if (!def) continue;
      any = true;
      const okSit = def.situations.includes(sit), crewOk = !def.needsCrew || p.crew.length > 0;
      const stored = v.science.some(r => r.experiment === exp && r.situation === sit && r.bodyId === body.id);
      const val = career && uses ? career.scienceValue(exp, body, sit) : null;
      const why = !okSit ? 'Not possible here' : !crewOk ? 'Needs a Pip aboard' : stored ? 'Result stored' : (v.type === 'eva' ? 'Carried by the Pip' : p.def.name);
      rows.push(el('div', { class: 'fl-pop-row', data: { exp } },
        el('div', { class: 'grow' }, el('b', { text: def.name }), el('span', { text: why })),
        val && okSit ? el('span', { class: 'pts', text: val.next > 0 ? '+' + val.next.toFixed(1) : 'done' }) : null,
        el('button', { class: 'sw-btn small', text: 'Run', disabled: !okSit || !crewOk || stored, attrs: { type: 'button', 'data-action': 'run' }, on: { click: () => act.runExperiment(p.id, exp) } })));
    }
    if (!any) rows.push(el('div', { class: 'sw-empty', text: 'No experiments aboard.' }));
    rows.push(el('div', { class: 'sw-label', text: 'Stored results (' + v.science.length + ')' }));
    const canSend = act.canTransmit(v);
    for (const r of v.science) {
      const def = EXPERIMENTS[r.experiment] || { name: r.experiment };
      const b = SYSTEM.byId[r.bodyId] || { name: r.bodyId };
      const val = career && uses ? career.scienceValue(r.experiment, r.bodyId, r.situation) : null;
      rows.push(el('div', { class: 'fl-pop-row', data: { stored: r.experiment } },
        el('div', { class: 'grow' }, el('b', { text: def.name }), el('span', { text: (SITUATION_NAMES[r.situation] || r.situation) + ' ' + b.name })),
        val ? el('span', { class: 'pts', text: '+' + val.next.toFixed(1) }) : null,
        el('button', { class: 'sw-btn small', text: 'Transmit', disabled: !canSend.ok, tip: canSend.ok ? 'Send it home now for half its value' : canSend.why, attrs: { type: 'button', 'data-action': 'transmit' }, on: { click: () => act.transmit(r) } })));
    }
    if (!v.science.length) rows.push(el('div', { class: 'sw-empty', text: 'Nothing stored yet. Recover the vessel to bank results in full.' }));
    return rows;
  }
  // ---- target list: vessels (nearest first) and worlds; distances refresh in place
  function targetRows(v) {
    const rows = [], live = [];
    const list = act.targetList();
    const add = t => {
      const nDist = el('span');
      const what = t.kind === 'body' ? (t.type === 'moon' ? 'Moon' : 'Planet') : t.type === 'debris' ? 'Debris' : t.type === 'eva' ? 'Pip on a spacewalk' : 'Vessel';
      live.push(() => setText(nDist, what + ' · ' + fmt.dist(act.rangeTo(t.ref))));
      rows.push(el('div', { class: 'fl-pop-row' + (t.current ? ' cur' : ''), data: { target: String(t.id), kind: t.kind } },
        el('div', { class: 'fl-tgt-dot ' + t.kind }),
        el('div', { class: 'grow' }, el('b', { text: t.name }), nDist),
        t.current
          ? el('button', { class: 'sw-btn small', text: 'Clear', attrs: { type: 'button', 'data-action': 'clear-target' }, on: { click: () => act.clearTarget() } })
          : el('button', { class: 'sw-btn small', text: 'Set', tip: 'Make ' + t.name + ' the target', attrs: { type: 'button', 'data-action': 'target' }, on: { click: () => act.setTarget(t.ref) } })));
    };
    const ships = list.filter(t => t.kind === 'vessel'), worlds = list.filter(t => t.kind === 'body');
    rows.push(el('div', { class: 'sw-label', text: 'Vessels (' + ships.length + ')' }));
    ships.forEach(add);
    if (!ships.length) rows.push(el('div', { class: 'sw-empty', text: 'No other vessel in flight.' }));
    rows.push(el('div', { class: 'sw-label', text: 'Worlds' }));
    worlds.forEach(add);
    rows.push(el('div', { class: 'fl-pop-note', html: '<b>Y</b> next vessel · <b>Shift+Y</b> clear · <b>C</b> speed relative to the target. The map (M) shows the closest approach.' }));
    void v;
    return { rows, live: () => { for (const f of live) f(); } };
  }

  // ---- docking: mated pairs (undock), free rings, docking assist
  function dockInfo(v) {
    const pairs = act.dockedList(), free = v.dockPorts || [];
    const on = !!lastState && lastState.assistKind === 'dock';
    const can = act.canDockAssist();
    return { pairs, free, on, can, key: pairs.map(d => d.portId).join(',') + '|' + free.length + '|' + on + '|' + can.ok + '|' + can.why };
  }
  function dockRows(v, info) {
    const rows = [];
    const { pairs, free, on, can } = info;
    rows.push(el('div', { class: 'sw-label', text: 'Docked (' + pairs.length + ')' }));
    for (const d of pairs) {
      rows.push(el('div', { class: 'fl-pop-row', data: { docked: String(d.portId) } },
        el('div', { class: 'grow' }, el('b', { text: d.name }), el('span', { text: 'Held by a ' + d.partName })),
        el('button', { class: 'sw-btn small', text: 'Undock', tip: 'Release ' + d.name, attrs: { type: 'button', 'data-action': 'undock' }, on: { click: () => act.undock(d.portId) } })));
    }
    if (!pairs.length) rows.push(el('div', { class: 'sw-empty', text: 'Nothing is docked to this vessel.' }));
    rows.push(el('div', { class: 'sw-label', text: 'Free Latch Rings (' + free.length + ')' }));
    for (const p of free) rows.push(el('div', { class: 'fl-pop-row', data: { port: String(p.id) } }, el('div', { class: 'grow' }, el('b', { text: p.def.name }), el('span', { text: 'Size ' + p.def.dock.size + ' · mates with another size ' + p.def.dock.size + ' ring' }))));
    if (!free.length) rows.push(el('div', { class: 'sw-empty', text: pairs.length ? 'Every ring is in use.' : 'This vessel has no Latch Ring.' }));
    rows.push(el('div', { class: 'sw-label', text: 'Guidance' }));
    rows.push(el('div', { class: 'fl-pop-row', data: { assist: 'dock' } },
      el('div', { class: 'grow' }, el('b', { text: 'Docking assist' }), el('span', { text: on ? 'Flying the approach on RCS' : can.ok ? 'Ready: flies the last stretch on RCS' : can.why })),
      el('button', { class: 'sw-btn small' + (on ? ' primary' : ''), text: on ? 'Stop' : 'Engage', disabled: !on && !can.ok, attrs: { type: 'button', 'data-action': 'dock-assist' }, on: { click: () => { act.toggleDockAssist(); hud.refreshPanels(); } } })));
    rows.push(el('div', { class: 'fl-pop-note', html: 'By hand: target the other vessel, turn on <b>RCS</b> (R), point at it and close in with <b>H N I K J L</b>. Rings of the same size latch by themselves when they touch nose to nose under 1.5 m/s.' }));
    return { rows, live: null };
  }

  // ---- fuel transfer between two parts of this vessel
  function fuelRows(v) {
    const kinds = act.transferResources();
    if (!kinds.length) return { rows: [el('div', { class: 'sw-empty', text: 'Pumping needs two tanks that hold the same thing. Dock with another vessel to refuel it.' })], live: null };
    if (!kinds.includes(xfer.res)) { xfer.res = kinds[0]; xfer.from = xfer.to = null; }
    const res = xfer.res, unit = XFER[res][1];
    const parts = act.transferParts(res);
    const has = id => parts.some(p => p.id === id);
    if (!has(xfer.from)) xfer.from = parts.slice().sort((a, b) => b.amount - a.amount)[0].id;
    if (!has(xfer.to) || xfer.to === xfer.from) xfer.to = parts.filter(p => p.id !== xfer.from).sort((a, b) => (b.max - b.amount) - (a.max - a.amount))[0].id;
    const seg = el('div', { class: 'fl-seg', data: { xfer: 'resource' } }, kinds.map(k => el('button', { class: 'sw-btn small' + (k === res ? ' primary' : ''), text: XFER[k][0], attrs: { type: 'button', 'data-res': k }, on: { click: () => { xfer.res = k; xfer.from = xfer.to = null; hud.refreshPanels(); } } })));
    const amountOf = id => { const p = v.parts.get(id); return p ? [p.res[res] || 0, p.def.res[res] || 0] : [0, 0]; };
    const label = p => { const [a, m] = amountOf(p.id); return p.name + (p.side ? ' · ' + p.side : '') + ' — ' + fmt.num(a, a < 100 ? 1 : 0) + ' / ' + fmt.num(m) + ' ' + unit; };
    const mkSelect = which => {
      const sel = el('select', { class: 'sw-input', attrs: { 'data-xfer': which, 'aria-label': which === 'from' ? 'Take from' : 'Pump into' } });
      for (const p of parts) { const o = el('option', { text: label(p), attrs: { value: String(p.id) } }); sel.appendChild(o); }
      sel.value = String(xfer[which]);
      sel.addEventListener('change', () => {
        const id = Number(sel.value), other = which === 'from' ? 'to' : 'from';
        if (xfer[other] === id) xfer[other] = xfer[which];           // picking the same tank swaps the two
        xfer[which] = id;
        sel.blur(); hud.refreshPanels();
      });
      return sel;
    };
    const selFrom = mkSelect('from'), selTo = mkSelect('to');
    const amount = el('input', { class: 'sw-input', attrs: { type: 'number', min: '0', step: 'any', placeholder: 'all', inputmode: 'decimal', 'data-xfer': 'amount', 'aria-label': 'Amount in ' + unit } });
    const go = what => { const moved = act.transfer(xfer.from, xfer.to, res, what); live(); return moved; };
    const typed = () => { const t = amount.value.trim(); return t === '' ? 'all' : Number(t); };
    amount.addEventListener('keydown', e => { if (e.key === 'Enter') { go(typed()); amount.blur(); } else if (e.key === 'Escape') amount.blur(); e.stopPropagation(); });
    const btn = (key, text, tip, fn, cls = '') => el('button', { class: 'sw-btn small ' + cls, text, tip, attrs: { type: 'button', 'data-action': key }, on: { click: e => { e.currentTarget.blur(); fn(); } } });
    const gauge = which => { const fill = el('i'), amt = el('span', { class: 'amt' }); return { fill, amt, node: el('div', { class: 'fl-res-row', data: { xferGauge: which } }, el('span', { class: 'nm', text: which === 'from' ? 'From' : 'Into' }), el('div', { class: 'sw-bar' + (res === 'elec' ? ' green' : '') }, fill), amt) }; };
    const gFrom = gauge('from'), gTo = gauge('to');
    function live() {
      for (const [g, id] of [[gFrom, xfer.from], [gTo, xfer.to]]) {
        const [a, m] = amountOf(id);
        setW(g.fill, m > 0 ? a / m : 0); setText(g.amt, fmt.num(a, a < 100 ? 1 : 0) + ' ' + unit);
      }
      for (const sel of [selFrom, selTo]) for (const o of sel.options) { const p = parts.find(q => String(q.id) === o.value); if (p) setText(o, label(p)); }
    }
    const rows = [
      seg,
      el('div', { class: 'fl-xfer-row' }, el('span', { class: 'sw-label', text: 'From' }), selFrom),
      el('div', { class: 'fl-xfer-row' }, el('span', { class: 'sw-label', text: 'Into' }), selTo),
      el('div', { class: 'fl-xfer-gauges' }, gFrom.node, gTo.node),
      el('div', { class: 'fl-xfer-row' }, el('span', { class: 'sw-label', text: 'Amount' }), amount, el('span', { class: 'unit', text: unit })),
      el('div', { class: 'fl-xfer-btns' },
        btn('transfer', 'Transfer', 'Pump the typed amount (empty: all that fits)', () => go(typed()), 'primary'),
        btn('transfer-all', 'All', 'Pump as much as the other tank can take', () => { amount.value = ''; go('all'); }),
        btn('balance', 'Balance', 'Bring both tanks to the same fill level', () => go('balance')),
        btn('swap', '⇅', 'Swap source and destination', () => { const t = xfer.from; xfer.from = xfer.to; xfer.to = t; hud.refreshPanels(); })),
      el('div', { class: 'fl-pop-note', text: 'Tanks on both sides of a Latch Ring count as one vessel, so this is how a tanker refuels a station. Solid fuel and ablator cannot be pumped.' }),
    ];
    return { rows, live, key: res + '|' + xfer.from + '|' + xfer.to + '|' + parts.map(p => p.id).join(',') };
  }


  // ---- action groups (number keys); works with whatever the core offers, and says so when it offers nothing yet
  function groupRows(v) {
    const rows = [];
    const list = act.groupList();
    rows.push(el('div', { class: 'sw-label', text: 'Custom groups' }));
    for (const g of list) {
      rows.push(el('div', { class: 'fl-pop-row' + (g.count ? '' : ' dim'), data: { group: String(g.key) } },
        el('span', { class: 'sw-kbd', text: g.label }),
        el('div', { class: 'grow' }, el('b', { text: g.name }), el('span', { text: g.count ? g.count + (g.count === 1 ? ' part' : ' parts') : 'nothing assigned' })),
        el('button', { class: 'sw-btn small', text: 'Fire', disabled: !g.count, attrs: { type: 'button', 'data-action': 'fire-group' }, on: { click: () => act.fireGroup(g.key) } })));
    }
    rows.push(el('div', { class: 'fl-pop-note', html: 'Groups are set up in the Assembly Hangar. <b>G</b> gear, <b>U</b> lights and panels, <b>B</b> brakes, <b>R</b> RCS and <b>T</b> SAS are always there; <b>Backspace</b> fires the abort group.' }));
    void v;
    return { rows, live: null };
  }

  // ---- autopilot: the guidance programs the flight screen offers for this moment (act.programs / act.runProgram)
  function guideRows(v, list) {
    const rows = [];
    const fly = list.filter(p => !p.plan), plans = list.filter(p => p.plan);
    const row = p => el('div', { class: 'fl-pop-row' + (p.ok || p.on ? '' : ' dim'), data: { program: p.id } },
      el('div', { class: 'grow' }, el('b', { text: p.name }), el('span', { text: p.on ? 'Running. Any steering key takes over.' : p.ok ? p.note : (p.why || p.note) })),
      el('button', { class: 'sw-btn small' + (p.on ? ' primary' : ''), text: p.on ? 'Stop' : p.plan ? 'Plan' : 'Engage', disabled: !p.on && !p.ok, attrs: { type: 'button', 'data-action': 'program' }, on: { click: () => { act.runProgram(p.id); hud.refreshPanels(); } } }));
    rows.push(el('div', { class: 'sw-label', text: 'Fly' }));
    fly.forEach(p => rows.push(row(p)));
    if (!fly.length) rows.push(el('div', { class: 'sw-empty', text: 'Nothing to fly from here right now.' }));
    if (plans.length) { rows.push(el('div', { class: 'sw-label', text: 'Plan a burn' })); plans.forEach(p => rows.push(row(p))); }
    const tgt = v.targetInfo;
    rows.push(el('div', { class: 'fl-pop-note', html: tgt ? 'Target: <b>' + tgt.name.replace(/[<&]/g, '') + '</b>. Plans add a maneuver to the map (M); <b>Fly the next maneuver</b> warps to it and burns.' : 'Pick a world with the <b>Target</b> button to plan a transfer to it. Plans add a maneuver to the map (M); <b>Fly the next maneuver</b> warps to it and burns.' }));
    return { rows, live: null };
  }

  // ---- missions: the next step of the flight program and the active contracts, each objective with a live read-out
  function missionKey() {
    const c = app.career;
    if (!c) return '';
    const b = c.contracts, next = c.nextProgramStep ? c.nextProgramStep() : null;
    if (c.scenario) return 'scenario:' + c.scenario.id + ':' + (c.scenario.done || []).join(',') + (c.scenario.complete ? '!' : '');
    return [c.mode, next ? next.id : '-', c.milestones ? c.milestones.size : 0,
      b && c.mode === 'career' ? b.active.map(k => k.id + ':' + k.objectives.map(o => (o.done ? 1 : 0)).join('')).join(',') : ''].join('|');
  }
  function missionRows() {
    const c = app.career, rows = [], live = [];
    if (!c) return { rows: [el('div', { class: 'sw-empty', text: 'No program loaded.' })], live: null };
    const gauge = (get) => {
      const fill = el('i'), txt = el('span', { class: 'fl-ms-live' });
      const bar = el('div', { class: 'sw-bar thin' }, fill);
      const node = el('div', { class: 'fl-ms-gauge' }, bar, txt);
      live.push(() => {
        let p = null;
        try { p = get(); } catch { p = null; }
        const show = !!p && (p.text || p.frac != null);
        setCls(node, 'sw-hidden', !show);
        if (!show) return;
        setCls(bar, 'sw-hidden', p.frac == null);
        if (p.frac != null) setW(fill, p.frac);
        setText(txt, p.text || '');
      });
      return node;
    };
    // -- a scenario game: its goal and objectives take the place of the flight program and contracts
    const scn = c.scenario && app.scenarios && app.scenarios.status ? app.scenarios.status() : null;
    if (scn) {
      rows.push(el('div', { class: 'sw-label', text: `Scenario · ${scn.done} of ${scn.total}` }));
      let next = true;
      rows.push(el('div', { class: 'fl-ms', data: { scenario: scn.id } },
        el('div', { class: 'fl-ms-head' }, el('b', { text: scn.name }), el('span', { class: 'fl-ms-tag', text: scn.complete ? 'complete' : scn.difficulty || '' })),
        el('div', { class: 'fl-pop-note', data: { role: 'scenario-goal' }, text: scn.goal }),
        scn.objectives.map(o => { const cur = !o.done && next; if (cur) next = false; return el('div', { class: 'fl-ms-obj' + (o.done ? ' done' : ''), data: { done: o.done ? '1' : '0', objective: o.id } }, el('span', { class: 'tick', text: o.done ? '✓' : cur ? '▸' : '○' }), el('span', { text: o.text })); })));
      rows.push(el('div', { class: 'fl-pop-note', text: scn.complete ? 'Scenario complete. Keep flying, or pick another from the title menu.' : 'Objectives are ticked in order as you fly. The flight program and contracts belong to your own program.' }));
      return { rows, live: null };
    }
    const pay = r => [r.funds ? '✦ ' + fmt.num(r.funds) : '', r.science ? fmt.num(r.science, r.science % 1 ? 1 : 0) + ' science' : '', r.rep ? '+' + r.rep + ' reputation' : ''].filter(Boolean).join(' · ');
    // -- flight program
    const st = c.programStatus ? c.programStatus() : null;
    rows.push(el('div', { class: 'sw-label', text: st ? `Flight program · ${st.done} of ${st.total}` : 'Flight program' }));
    if (st && st.next) {
      const n = st.next, r = c.programRewards(n);
      rows.push(el('div', { class: 'fl-ms', data: { programStep: n.id } },
        el('div', { class: 'fl-ms-head' }, el('b', { text: n.title }), el('span', { class: 'fl-ms-tag', text: n.chapter })),
        el('div', { class: 'fl-ms-obj' }, el('span', { class: 'tick', text: '○' }), el('span', { text: n.desc })),
        gauge(() => programProgress(n.id, lastVessel, lastWorld ? lastWorld.ut : 0)),
        pay(r) ? el('div', { class: 'fl-ms-pay', text: pay(r) }) : null));
    } else rows.push(el('div', { class: 'sw-empty', text: 'Every mission of the flight program is flown. The system is yours.' }));
    // -- contracts
    const b = c.contracts;
    rows.push(el('div', { class: 'sw-label', text: 'Contracts' }));
    if (c.mode !== 'career' || !b) rows.push(el('div', { class: 'fl-pop-note', data: { role: 'no-contracts' }, text: 'Paid contracts belong to Career mode. This program follows the flight program above.' }));
    else if (!b.active.length) rows.push(el('div', { class: 'fl-pop-note', data: { role: 'no-contracts' }, text: 'No active contracts. Mission Control at the Flight Center has paid work on offer.' }));
    else for (const k of b.active) {
      const left = el('span', { class: 'fl-ms-tag' });
      live.push(() => {
        if (k.deadlineAt == null) { setText(left, 'no deadline'); return; }
        const s = k.deadlineAt - (lastWorld ? lastWorld.ut : c.ut || 0), d = s / VERDA_DAY;
        setText(left, s <= 0 ? 'overdue' : d >= 2 ? Math.floor(d) + ' days left' : fmt.time(s).replace(/ \d+s$/, '') + ' left');
        setCls(left, 'warn', d < 2);
      });
      rows.push(el('div', { class: 'fl-ms', data: { contract: k.id } },
        el('div', { class: 'fl-ms-head' }, el('b', { text: k.title }), left),
        k.objectives.map(o => [
          el('div', { class: 'fl-ms-obj' + (o.done ? ' done' : ''), data: { done: o.done ? '1' : '0' } }, el('span', { class: 'tick', text: o.done ? '✓' : '○' }), el('span', { text: o.label })),
          o.done ? null : gauge(() => objectiveProgress(o, lastVessel, lastWorld))]),
        el('div', { class: 'fl-ms-pay', text: pay(k.reward) })));
    }
    return { rows, live: () => { for (const f of live) f(); } };
  }

  /** The pop-over hangs beside the toolbar, under the resources. It never reaches into the crew portraits or the
   *  tips above the console (it gets shorter and scrolls). */
  function placePanel() {
    if (!panel) return;
    panel.style.maxHeight = ''; panel.style.top = '';
    // everything below is in the interface's own (zoomed) pixels, measured from the top of the HUD
    const k = uiScale(), o = root.getBoundingClientRect();
    const box = n => { const r = n.getBoundingClientRect(); return { left: (r.left - o.left) / k, right: (r.right - o.left) / k, top: (r.top - o.top) / k, bottom: (r.bottom - o.top) / k, width: r.width / k, height: r.height / k }; };
    const rb = box(resBox), rootH = root.clientHeight || window.innerHeight / k;
    const top = Math.round((rb.height > 1 ? rb.bottom : 8) + 6);
    panel.style.top = top + 'px';
    let limit = rootH - 10;
    const cb = box(crewBox); if (cb.height > 1) limit = Math.min(limit, cb.top - 8);
    const p = box(panel);
    for (const node of [above, consoleBox]) { const a = box(node); if (a.width > 1 && a.height > 1 && p.left < a.right + 6 && a.left < p.right + 6) limit = Math.min(limit, a.top - 8); }
    panel.style.maxHeight = Math.max(140, Math.round(limit - top)) + 'px';
  }

  function renderPanel(v) {
    if (!panelKind || !v) return;
    if ((panelKind === 'dock' || panelKind === 'fuel' || panelKind === 'groups' || panelKind === 'guide') && v.type !== 'ship') { closePanel(); return; }
    let key, built = null, info = null, progs = null;
    if (panelKind === 'target') {
      const cur = v.targetInfo ? v.targetInfo.id : '';
      key = 'target:' + v.id + ':' + cur + ':' + lastWorld.vessels.filter(o => !o.dead).map(o => o.id).join(',') + ':' + v.body.id;
    } else if (panelKind === 'dock') {
      info = dockInfo(v);
      key = 'dock:' + v.id + ':' + v.structureStamp + ':' + (v.targetInfo ? v.targetInfo.id : '') + ':' + info.key;
    } else if (panelKind === 'fuel') {
      key = 'fuel:' + v.id + ':' + v.structureStamp + ':' + xfer.res + ':' + xfer.from + ':' + xfer.to;
    } else if (panelKind === 'guide') {
      progs = act.programs ? act.programs() : [];
      key = 'guide:' + v.id + ':' + (v.targetInfo ? v.targetInfo.id : '') + ':' + progs.map(p => p.id + (p.ok ? 1 : 0) + (p.on ? 1 : 0) + (p.id === 'node' ? Math.round((v.nodeDv || 0) / 5) : '')).join(',');
    } else if (panelKind === 'missions') {
      key = 'missions:' + missionKey();
    } else if (panelKind === 'groups') {
      key = 'groups:' + v.id + ':' + v.structureStamp + ':' + act.groupList().map(g => g.count).join(',');
    } else key = panelKind + ':' + v.id + ':' + v.crew.join(',') + ':' + v.science.length + ':' + situationOf(v) + ':' + v.body.id + ':' + (app.career ? app.career.science : 0) + ':' + act.canTransmit(v).ok;
    if (key === panelKey && panel) { if (panelLive) panelLive(); placePanel(); return; }
    panelKey = key;
    if (panelKind === 'target') built = targetRows(v);
    else if (panelKind === 'fuel') built = fuelRows(v);
    else if (panelKind === 'dock') built = dockRows(v, info);
    else if (panelKind === 'groups') built = groupRows(v);
    else if (panelKind === 'guide') built = guideRows(v, progs);
    else if (panelKind === 'missions') built = missionRows();
    else built = { rows: panelKind === 'crew' ? crewRows(v) : scienceRows(v), live: null };
    panelLive = built.live || null;
    if (panelLive) panelLive();
    const body = el('div', { class: 'fl-pop-body sw-scroll' }, built.rows);
    const node = el('div', { class: 'fl-inst fl-pop', data: { hud: 'panel', panel: panelKind } },
      el('div', { class: 'fl-pop-head' }, el('div', { class: 'sw-label', text: PANEL_TITLE[panelKind] || panelKind }),
        el('button', { class: 'sw-btn small ghost icon', text: '×', attrs: { type: 'button', 'aria-label': 'Close' }, on: { click: closePanel } })), body);
    if (panel) panel.replaceWith(node); else root.appendChild(node);
    panel = node;
    placePanel();
  }

  // ---------------------------------------------------------------- per-frame update
  let dvStart = 0, dvNodeKey = '';
  function update(world, v, state, dt) {
    lastWorld = world; lastVessel = v; lastState = state;
    clock += dt;
    slow -= dt;
    const tick = slow <= 0;
    if (tick) slow = 0.2;
    // clock + warp (always)
    if (tick) {
      const p = fmt.dateParts(world.ut), pad = n => String(n).padStart(2, '0');
      setText(nDate, `Y${p.year} D${p.day} ${pad(p.h)}:${pad(p.m)}:${pad(p.s)}`);
    }
    const wi = world.warpIndex, maxW = world.maxWarpIndex();
    for (let i = 0; i < warpSteps.length; i++) { setCls(warpSteps[i], 'on', i <= wi); setCls(warpSteps[i], 'cur', i === wi); setCls(warpSteps[i], 'nope', i > maxW); }
    setText(nRate, state.paused ? 'Paused' : rateLabel(RATES[wi] || 1));
    setCls(nRate, 'rails', wi >= 4 && !state.paused); setCls(nRate, 'paused', !!state.paused);
    values.warpIndex = wi;
    setCls(bMap, 'active', !!state.mapOpen);
    setCls(bAssist, 'active', !!state.assist && state.assistKind === 'ascent');
    setCls(bGuide, 'active', panelKind === 'guide' || (!!state.assist && state.assistKind !== 'dock' && state.assistKind !== 'ascent'));
    setCls(bGuide, 'sw-hidden', !state.guideAvailable);
    const ship = !!v && v.type === 'ship';
    setCls(bTarget, 'sw-hidden', !v);
    setCls(bSci, 'sw-hidden', !v); setCls(bCrew, 'sw-hidden', !v);
    setCls(bDock, 'sw-hidden', !(ship && ((v.dockPorts || []).length > 0 || v.dockedPairs.length > 0)));
    setCls(bDock, 'active', panelKind === 'dock' || state.assistKind === 'dock');
    if (tick || !v) setCls(bFuel, 'sw-hidden', !(ship && v.situation !== 'prelaunch' && act.transferResources().length > 0));
    setCls(bGroups, 'sw-hidden', !ship);
    setCls(bAssist, 'sw-hidden', !state.assistAvailable);
    setCls(root, 'no-vessel', !v);
    if (!v) { setCls(bRecover, 'sw-hidden', true); setCls(targetCard, 'sw-hidden', true); if (crewKey !== '') { crewKey = ''; buildCrew(null); } return; }

    const body = v.body;
    setCls(bRecover, 'sw-hidden', !(v.landed && body === SYSTEM.home && v.situation !== 'prelaunch'));
    // ---- vessel card + mission clock
    if (tick) {
      setText(nName, v.name);
      let where = '';
      if (v.landed || v.altitude < (body.atmo ? body.atmo.height : 60000)) {
        try { const d = body.inertialToSurfaceDir(v.pos.clone().normalize(), world.ut); where = body.biomeAt(d).name; } catch { where = ''; }
      }
      // on an open path the closest approach may still be ahead: that is an arrival, not an escape
      const inbound = v.situation === 'escape' && v.pos && v.vel && v.pos.dot(v.vel) < 0;
      const sitHtml = `${v.situation === 'prelaunch' && v.launchSite === 'runway' ? 'On the runway at' : inbound ? 'Arriving at' : SIT_TEXT[v.situation] || v.situation} <b>${body.name}</b>${where ? ' · ' + where : ''}`;
      if (nSit._t !== sitHtml) { nSit._t = sitHtml; nSit.innerHTML = sitHtml; }
      values.situation = v.situation; values.biome = where;
      setText(nMet, v.launched ? 'T+ ' + fmt.time(Math.max(0, world.ut - (v.launchUt || 0))) : 'T− ready');
    }
    // ---- altimeter cluster
    const [a1, a2] = splitDist(v.altitude);
    setText(altText, a1); setText(altUnit, a2);
    values.altitude = v.altitude;
    drawDrums(drums, v.altitude);
    drawVsDial(vsDial, v.verticalSpeed || 0);
    if (tick) {
      setText(nRadar, v.landed ? 'on the ground' : fmt.dist(Math.max(0, v.radarAlt)));
      const orb = !v.landed;
      const hasAp = orb && Number.isFinite(v.apoapsis) && v.apoapsis > 0;
      let tAp = '', tPe = '';
      if (orb && v.situation !== 'flying' || (orb && v.apoapsis > v.altitude)) {
        try {
          const o = v.getOrbit(world.ut);
          if (hasAp && !o.hyper) tAp = fmt.time(o.timeToApoapsis(world.ut));
          if (v.periapsis > -body.radius * 0.999) { const t = o.timeToPeriapsis(world.ut); if (Number.isFinite(t) && t >= 0) tPe = fmt.time(t); }
        } catch { /* degenerate orbit */ }
      }
      nAp.innerHTML = !orb ? '—' : (hasAp ? fmt.dist(v.apoapsis) : (v.situation === 'escape' ? 'escape' : '—')) + (tAp ? `<small>${tAp}</small>` : '');
      nPe.innerHTML = !orb ? '—' : (v.periapsis > 0 ? fmt.dist(v.periapsis) : 'below ground') + (tPe && v.periapsis > 0 ? `<small>${tPe}</small>` : '');
      values.apoapsis = v.apoapsis; values.periapsis = v.periapsis;
    }
    setText(nVs, (v.verticalSpeed >= 0 ? '+' : '−') + fmt.num(Math.abs(v.verticalSpeed), Math.abs(v.verticalSpeed) < 100 ? 1 : 0) + ' m/s');
    // ---- speed read-out
    const ti = v.targetInfo;
    const targetMode = state.speedMode === 'target' && !!ti;
    const orbitMode = state.speedMode === 'orbit';
    const spd = targetMode ? ti.relSpeed : orbitMode ? v.orbitalSpeed : v.airspeed;
    const [s1, s2] = targetMode && spd < 100 ? [fmt.num(spd, 2), 'm/s'] : splitSpeed(spd);
    setText(spdText, s1); setText(spdUnit, s2);
    setText(nModeChip, targetMode ? 'Target' : orbitMode ? 'Orbit' : 'Surface'); setCls(nModeChip, 'orbit', orbitMode); setCls(nModeChip, 'target', targetMode);
    // ---- target read-out
    setCls(targetCard, 'sw-hidden', !ti);
    if (ti) {
      setText(nTgtName, ti.name);
      setText(nTgtDist, fmt.dist(ti.distance));
      const closing = ti.closing || 0;
      setText(nTgtRel, fmt.num(ti.relSpeed, ti.relSpeed < 100 ? 2 : 0) + ' m/s' + (ti.relSpeed < 0.02 ? '' : closing > 0.01 ? ' ▸◂' : closing < -0.01 ? ' ◂▸' : ''));
      nTgtRel.title = closing > 0.01 ? 'closing' : closing < -0.01 ? 'opening' : '';
      const ca = state.approach;
      setCls(tgtCaRow, 'sw-hidden', !ca);
      if (ca && tick) {
        const inT = ca.t - world.ut;
        setText(nTgtCa, fmt.dist(ca.distance) + ' · ' + fmt.num(ca.relSpeed, ca.relSpeed < 100 ? 1 : 0) + ' m/s' + (inT > 1 ? ' in ' + fmt.time(inT) : ' now'));
      }
      values.target = { name: ti.name, kind: ti.kind, id: ti.id, distance: ti.distance, relSpeed: ti.relSpeed, closing, approach: ca ? { t: ca.t, distance: ca.distance, relSpeed: ca.relSpeed } : null };
    } else values.target = null;
    values.speed = spd; values.speedMode = state.speedMode;
    // ---- g-meter
    const g = v.gForce || 0;
    setText(nG, g < 10 ? g.toFixed(1) : String(Math.round(g)));
    setText(nGText, g.toFixed(2) + ' g');
    setCls(gMeter, 'warn', g > 4.5 && g <= 7); setCls(gMeter, 'bad', g > 7);
    setH(gFill, g / 9);
    if (gMark._b !== Math.round(clamp01(g / 9) * 200)) { gMark._b = Math.round(clamp01(g / 9) * 200); gMark.style.bottom = (gMark._b / 2) + '%'; }
    values.g = g;
    // ---- structure read-out
    {
      const st = v.structure || null, live = !!st && st.valid;
      setCls(structBox, 'sw-hidden', !st); setCls(structBox, 'idle', !live);
      if (live) {
        // rises at once, falls back over a moment: a one-frame spike stays readable
        if (stStamp !== v.structureStamp) { stStamp = v.structureStamp; stShown = 0; }      // other joints now (staging, a break): start again
        const u = st.maxUtil; stShown = u > stShown ? u : Math.max(u, stShown - dt * 2.5);
        const pct = stressPercent(stShown);
        if (pct !== stPct) { stPct = pct; setText(nStPct, pct + '%'); }
        setW(stFill, stShown);
        const lvl = stressLevel(stShown);
        setCls(structBox, 'warn', lvl === 'warn'); setCls(structBox, 'bad', lvl === 'bad');
        if (tick || pct !== stWhyPct) { stWhyPct = pct; stWhy = describeJoint(st.worst, stShown); setText(nStWhy, stWhy); }
        values.structure = stShown;
      } else if (stPct !== -1 || tick) {
        stShown = 0; stPct = -1; setText(nStPct, '--'); setW(stFill, 0); setCls(structBox, 'warn', false); setCls(structBox, 'bad', false);
        stWhy = ''; if (st) setText(nStWhy, v.landed ? 'No load to read on the ground' : 'No reading at this time warp');
        values.structure = null;
      }
      values.structureText = stWhy;
      if (stFlash > 0) { stFlash -= dt; if (stFlash <= 0) setCls(structBox, 'flash', false); }
    }
    if (tick) {
      const q = v.dynamicPressure || 0;
      // static pressure in atmospheres, plus the dynamic pressure ("Q") while it matters
      const pAtm = body.atmo && v.altitude < body.atmo.height ? body.pressureAtm(Math.max(0, v.altitude)) : 0;
      const pText = pAtm >= 0.095 ? pAtm.toFixed(2) + ' atm' : pAtm >= 0.0005 ? pAtm.toFixed(3) + ' atm' : pAtm > 0 ? 'trace' : 'vacuum';
      const airHtml = pText + (q > 500 ? `<small>Q ${fmt.num(q / 1000, 1)} kPa</small>` : '');
      if (nQ._t !== airHtml) { nQ._t = airHtml; nQ.innerHTML = airHtml; }
      values.pressureAtm = pAtm;
      setCls(nQ, 'warn', q > 30000);
      // depth gauge: logarithmic, full at one atmosphere, empty in space
      const depth = pAtm > 0 ? clamp01(1 + Math.log10(Math.max(pAtm, 1e-4)) / 4) : 0;
      setW(atmoFill, depth); setCls(atmoBox, 'none', !body.atmo);
      if (atmoMark._l !== Math.round(depth * 200)) { atmoMark._l = Math.round(depth * 200); atmoMark.style.left = (atmoMark._l / 2) + '%'; }
      const hr = v.isHot ? (v.maxTempRatio || 0) : 0;
      setText(nHeat, hr > 0.02 ? Math.round(hr * 100) + '%' : 'cool'); setCls(nHeat, 'warn', hr > 0.6 && hr <= 0.85); setCls(nHeat, 'bad', hr > 0.85);
      values.heat = hr; values.q = q;
    }
    // ---- throttle + lights + SAS
    const c = v.ctrl;
    setH(thrFill, c.throttle); setText(nThr, Math.round(c.throttle * 100) + '%');
    if (thrKnob._b !== Math.round(c.throttle * 200)) { thrKnob._b = Math.round(c.throttle * 200); thrKnob.style.bottom = (thrKnob._b / 2) + '%'; }
    values.throttle = c.throttle;
    if (tick) {
      const gLocal = body.gm / Math.max(1, v.pos.lengthSq());
      const twr = v.mass > 0 ? (v.thrust > 0 ? v.thrust : v.maxThrust * c.throttle) / (v.mass * gLocal) : 0;
      // far from any world the local gravity is tiny and the ratio runs away: stop at "99+"
      const twrText = x => (x > 99 ? '99+' : x.toFixed(2));
      setText(nTwr, v.maxThrust > 0 ? 'TWR ' + (twr > 0 ? twrText(twr) : twrText(v.maxThrust / (v.mass * gLocal)) + ' max') : '');
      values.twr = twr;
    }
    setCls(lSas, 'on', !!c.sas); setCls(lRcs, 'on', !!c.rcs);
    const hasLegs = (v.legParts || []).length > 0 || act.hasGear(v), hasSolar = (v.solarParts || []).length > 0, hasRcs = (v.rcsParts || []).length > 0 || v.type === 'eva';
    setCls(lLegs, 'on', hasLegs && act.gearDown(v)); setCls(lLegs, 'na', !hasLegs);
    setCls(lSolar, 'on', hasSolar && v.solarOut); setCls(lSolar, 'na', !hasSolar);
    setCls(lRcs, 'na', !hasRcs);
    const lamp = act.lightState(v), brake = act.brakeState(v);
    setCls(lLamp, 'on', lamp === true); setCls(lLamp, 'na', lamp === null);
    setCls(lBrake, 'on', brake === true); setCls(lBrake, 'na', brake === null);
    setCls(root, 'fine', !!state.fine);
    values.sas = !!c.sas; values.rcs = !!c.rcs; values.sasMode = c.sasMode;
    const shown = c.sasMode === 'srfPrograde' ? 'prograde' : c.sasMode === 'srfRetrograde' ? 'retrograde' : c.sasMode;
    for (const m in modeBtns) { setCls(modeBtns[m], 'on', c.sas && shown === m); setCls(modeBtns[m], 'off', !c.sas || (m === 'maneuver' && !v.nodes.length) || (!ti && (m === 'target' || m === 'antiTarget' || m === 'relPrograde' || m === 'relRetrograde'))); }
    setCls(tmodes, 'sw-hidden', v.type === 'eva');
    const pr = Math.round(state.pitch || 0), hd = state.heading !== undefined ? Math.round(state.heading) % 360 : 0;
    setText(nHdg, state.heading !== undefined ? String(hd).padStart(3, '0') + '°  ' + (pr > 0 ? '+' : pr < 0 ? '−' : '') + Math.abs(pr) + '°' : '');
    setText(nAttH, String(hd).padStart(3, '0') + '°'); setText(nAttP, (pr > 0 ? '+' : pr < 0 ? '−' : '') + Math.abs(pr) + '°');
    const rl = Math.round(state.roll || 0); setText(nAttR, (rl > 0 ? '+' : rl < 0 ? '−' : '') + Math.abs(rl) + '°');
    if (state.heading !== undefined) drawTape(tape, state.heading, tape.clientWidth || 170);
    values.heading = state.heading; values.pitch = state.pitch;

    // ---- alerts + maneuver panel
    if (tick) {
      const list = [];
      if (state.assist) list.push(['info', (state.assistName || (state.assistKind === 'dock' ? 'Docking assist' : 'Ascent assist')) + ' · ' + state.assist]);
      if (state.fine) list.push(['info', 'Fine controls']);
      if (v.dynamicPressure > 30000) list.push(['', 'High air pressure']);
      if (v.isHot && v.maxTempRatio > 0.85) list.push(['bad', 'Overheating']); else if (v.isHot && v.maxTempRatio > 0.6) list.push(['', 'Heating']);
      if (v.structure && v.structure.valid && stShown >= 0.75) list.push(stShown >= 0.9 ? ['bad', 'Structure at its limit'] : ['', 'Structure straining']);
      if (v.type !== 'eva' && !v.controllable) list.push(['bad', 'No control']);
      const el2 = v.resources && v.resources.elec;
      if (v.type !== 'eva' && el2 && el2.max > 0 && el2.amount / el2.max < 0.08) list.push([el2.amount <= 0.01 ? 'bad' : '', el2.amount <= 0.01 ? 'Out of charge' : 'Low charge']);
      if (!v.landed && v.verticalSpeed < -12 && v.radarAlt < 1500 && v.radarAlt > 0 && body.atmo === null) list.push(['', 'Terrain']);
      const key = list.map(x => x.join('|')).join(';');
      if (key !== alertKey) { alertKey = key; clear(alerts); for (const [cls, text] of list) alerts.appendChild(el('div', { class: 'fl-alert ' + cls, text })); }
      values.alerts = list.map(x => x[1]);
      const node = v.nodes[0];
      setCls(nodeCard, 'sw-hidden', !node); setCls(attCard, 'sw-hidden', !!node);
      if (node) {
        const total = Math.hypot(node.dv.prograde, node.dv.normal, node.dv.radial);
        const dv = v.nodeDv || total;
        const bt = state.burnTime !== undefined ? state.burnTime : v.burnTime(dv);
        setText(nNodeDv, fmt.num(dv, 1) + ' m/s');
        const dtN = node.t - world.ut;
        setText(nNodeT, (dtN >= 0 ? 'T− ' : 'T+ ') + fmt.time(Math.abs(dtN)));
        setText(nNodeBurn, Number.isFinite(bt) ? fmt.time(bt) : 'no engine');
        const nk = v.id + ':' + node.t.toFixed(1) + ':' + total.toFixed(2);
        if (nk !== dvNodeKey) { dvNodeKey = nk; dvStart = Math.max(dv, total, 0.1); }
        setH(dvFill, dv / dvStart);
        // burn-time bar: full until ignition time (half the burn before the node), then drains with the Δv left
        const lead = Number.isFinite(bt) ? dtN - bt / 2 : dtN;
        setCls(nodeCard, 'go', lead <= 0); setCls(nodeCard, 'soon', lead > 0 && lead < 10);
        setW(burnFill, lead > 0 ? 1 : dv / dvStart);
        values.nodeDv = dv; values.nodeBurn = bt;
      } else { values.nodeDv = 0; dvNodeKey = ''; }
    }
    // ---- resources
    if (tick) {
      const res = v.resources || {};
      for (const [key, , unit] of RES) {
        const r = res[key], row = resRows[key];
        const has = !!r && r.max > 0;
        setCls(row, 'sw-hidden', !has);
        if (!has) continue;
        const f = r.amount / r.max;
        setW(row.children[1].firstChild, f);
        setText(row.children[2], fmt.num(r.amount, r.amount < 100 ? 1 : 0) + ' ' + unit);
        setCls(row, 'low', f < 0.15 && f > 0); setCls(row, 'out', r.amount <= 1e-6);
      }
      // propellant feeding the engines that are lit now
      let amt = 0, max = 0; const seen = new Set();
      for (const e of v.engines || []) {
        const p = e.part; if (!p.ignited) continue;
        if (p.def.engine.type === 'solid') { amt += p.res.solid || 0; max += p.def.res.solid || 0; }
        else for (const t of e.tanks) { if (seen.has(t.id)) continue; seen.add(t.id); amt += t.res.fuel || 0; max += t.def.res.fuel || 0; }
      }
      // after burnout there is nothing left to show: "This stage 0%" only repeats the flame-out message
      const burning = max > 0 && amt > max * 1e-4;
      setCls(nStageFuelRow, 'sw-hidden', !burning);
      if (burning) { setW(nStageFuelRow.children[1].firstChild, amt / max); setText(nStageFuelRow.children[2], Math.round(amt / max * 100) + '%'); setCls(nStageFuelRow, 'low', amt / max < 0.12); }
      values.stageFuel = max > 0 ? amt / max : null;
      setText(nDv, v.type === 'eva' ? '—' : fmt.num(v.deltaV || 0) + ' m/s');
      const sdv = v.stageDeltaV || 0;
      setText(nDvStage, v.type !== 'eva' && sdv > 0.5 && Math.abs(sdv - (v.deltaV || 0)) > 1 ? 'stage ' + fmt.num(sdv) : '');
      values.deltaV = v.deltaV;
      setCls(resBox, 'sw-hidden', v.type === 'eva');
      // ---- stage stack
      const key = v.id + ':' + v.stageIndex + ':' + v.parts.size + ':' + v.stages.map(s => s.length).join(',') + ':' + v.situation.startsWith('pre');
      if (key !== stageKey) { stageKey = key; buildStages(v); }
      updateStageBars(v);
      values.stageIndex = v.stageIndex; values.stageCount = v.stages.length;
      // ---- crew portraits
      const ck = v.id + ':' + v.type + ':' + [...v.parts.values()].map(p => p.crew.length ? p.id + '=' + p.crew.join(',') : '').join('|');
      if (ck !== crewKey) { crewKey = ck; buildCrew(v); }
      // ---- EVA bar
      const eva = v.type === 'eva';
      setCls(evaBar, 'sw-hidden', !eva);
      if (eva) {
        const r = (v.resources || {}).evafuel;
        const row = evaBar.children[3];
        if (r && r.max > 0) { setW(nEvaFuel, r.amount / r.max); setText(row.children[2], Math.round(r.amount / r.max * 100) + '%'); }
      }
      renderPanel(v);
    }
    faceAcc += dt;
    if (faceAcc >= 1 / 20) { faceAcc = 0; drawFaces(v, state); }
    if (camTagTimer > 0) { camTagTimer -= dt; if (camTagTimer <= 0) camTag.classList.remove('show'); }
    rectAge++;
  }

  const hud = {
    root, overlay, values, update,
    mount() { if (!root.isConnected) app.uiRoot.appendChild(root); ballRectCache = null; },
    unmount() { closePanel(); root.remove(); },
    ballRect() {
      if (!ballRectCache || rectAge > 20) {
        rectAge = 0;
        const r = ballNode.getBoundingClientRect();
        ballRectCache = r.width > 4 ? { x: Math.round(r.left), y: Math.round(r.top), size: Math.round(r.width) } : null;
        if (ballRectCache) { const px = Math.round(ballRectCache.size * dpr()); if (overlay.width !== px) { overlay.width = px; overlay.height = px; } }
      }
      return ballRectCache;
    },
    invalidate() { ballRectCache = null; stageKey = ''; panelKey = ''; crewKey = ''; drums._dirty = vsDial._dirty = tape._dirty = true; },
    consoleHeight() { return consoleBox.getBoundingClientRect().height / uiScale() || 240; },      // in interface pixels
    /** Room the HUD takes at each edge (CSS px), so the map can keep its own panels clear of it. */
    insets() {
      const t = timeBar.getBoundingClientRect(), o = tools.getBoundingClientRect();
      const k = uiScale(); return { top: Math.round(t.bottom / k + 10), left: 10, right: Math.round(o.width / k + 14), bottom: Math.round(hud.consoleHeight()) + 20 };
    },
    setMapOpen(on) { root.classList.toggle('map-open', !!on); ballRectCache = null; },
    setHidden(on) { hiddenNow = !!on; root.classList.toggle('hud-off', hiddenNow); ballRectCache = null; },
    get hidden() { return hiddenNow; },
    /** The structure read-out flashes amber (the `stress` world event: a joint has passed its warning level). */
    flashStress(seconds = 1.6) { stFlash = seconds; structBox.classList.remove('flash'); void structBox.offsetWidth; structBox._cflash = true; structBox.classList.add('flash'); },
    /** The read-out shows whether the stress overlay is on (and keeps its detail line open while it is). */
    setStressOverlay(on) { setCls(structBox, 'on', !!on); },
    get structNode() { return structBox; },
    /** A moment of joy on the portraits (liftoff, orbit, touchdown). */
    cheer(seconds = 4) { joyUntil = clock + seconds; },
    /** spec = null | { id, items: [[keyLabel|null, text], …] }  — one chip per item, key caps first. */
    setHint(spec) {
      const key = spec ? spec.id + '|' + spec.items.map(i => i.join(':')).join('|') : '';
      if (key === hintKey) return;
      hintKey = key;
      hint.classList.toggle('sw-hidden', !spec);
      clear(hintBody);
      if (!spec) return;
      hint.dataset.hint = spec.id;
      for (const [k, text] of spec.items) {
        const keys = k ? String(k).split(' ').map(t => el('span', { class: 'sw-kbd', text: t })) : [];
        hintBody.appendChild(el('span', null, ...keys, text));
      }
    },
    showHint(on) { if (!on) hud.setHint(null); },
    get hintVisible() { return !hint.classList.contains('sw-hidden'); },
    get hintId() { return hint.classList.contains('sw-hidden') ? '' : hint.dataset.hint || ''; },
    get hintText() { return hint.classList.contains('sw-hidden') ? '' : hintBody.textContent; },
    flashCamera(text) { camTag.textContent = text; camTag.classList.add('show'); camTagTimer = 1.6; },
    showCenter({ title, text = '', lines = [], calm = false, buttons = [] }) {
      clear(center);
      center.classList.toggle('calm', !!calm);
      center.append(el('h2', { text: title }), text ? el('p', { text }) : null);
      for (const l of lines) center.appendChild(el('p', { text: l }));
      center.appendChild(el('div', { class: 'btns' }, buttons.map(b => el('button', { class: 'sw-btn ' + (b.kind || ''), text: b.label, attrs: { type: 'button', 'data-center': b.key || '' }, on: { click: b.onClick } }))));
      center.classList.remove('sw-hidden');
    },
    hideCenter() { center.classList.add('sw-hidden'); },
    get centerVisible() { return !center.classList.contains('sw-hidden'); },
    togglePanel(kind) {
      if (panelKind === kind) { closePanel(); return; }
      closePanel();
      if (!PANEL_TITLE[kind]) return;
      panelKind = kind; if (kind === 'fuel') { xfer.from = xfer.to = null; }
      setCls(panelBtn[kind], 'active', true);
      renderPanel(lastVessel || (lastWorld && lastWorld.active));
    },
    closePanels: closePanel,
    refreshPanels() { panelKey = ''; if (lastVessel && !lastVessel.dead) renderPanel(lastVessel); },
    get xfer() { return xfer; },
    get panelKind() { return panelKind; },
  };
  return hud;
}
