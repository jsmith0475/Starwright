// Starwright — Crew Quarters: the Pip roster.
//   createCrewScreen(app)
//   pipPortrait(name, {size})      → <svg> portrait, deterministic from the name
//   pipPortraitMarkup(name)        → inner SVG markup for a 120×120 viewBox
//   pipFigureMarkup({x,y,scale,seed,wave,flip}) → <g> markup of a whole standing Pip (about 44×62 units, feet at y)
//   pipFigure({seed, wave})        → <svg> element of a standing Pip
import { el, clear, fmt, icon, showModal, isModalOpen } from './dom.js';
import { interiorFrame } from './interior.js';
import { pipStars, XP_STARS, MAX_STARS, PIP_NAME_MAX } from '../core/career.js';
import { starRow } from './careerui.js';

// ------------------------------------------------------------------ deterministic variety

function hashName(name) {
  let h = 2166136261;
  for (let i = 0; i < name.length; i++) { h ^= name.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const pick = (r, arr) => arr[Math.floor(r() * arr.length)];

const FACES = ['#ffe0c2', '#f7cba4', '#eab88f', '#d39a72', '#b07a56', '#8d5d40', '#ffd6c9'];
const ACCENTS = ['#39d0c0', '#ffb347', '#6cb6ff', '#b79cff', '#ff7fa0', '#74dd92', '#ffe066', '#f4f1e6'];
const BACKDROPS = [['#1d3a4a', '#12222e'], ['#2b2f55', '#171a33'], ['#3a2a4a', '#1f162b'], ['#1f4039', '#11241f'], ['#44321f', '#261b10'], ['#3d2531', '#22131a']];
const SUIT = '#ff8a3d', SUIT_DARK = '#d96a22', HELMET = '#f6f1e7', HELMET_SHADE = '#d9d2c4', VISOR = '#16202b';

export function pipTraits(name) {
  const r = rng(hashName(String(name || 'Pip')));
  return {
    face: pick(r, FACES), accent: pick(r, ACCENTS), bobble: pick(r, ACCENTS), backdrop: pick(r, BACKDROPS),
    eyes: Math.floor(r() * 5), mouth: Math.floor(r() * 5), brows: Math.floor(r() * 4), extra: Math.floor(r() * 6),
    tilt: (r() - 0.5) * 26, sticker: Math.floor(r() * 5), eyeGap: 8.5 + r() * 3, look: (r() - 0.5) * 3, hair: Math.floor(r() * 5),
    hairColor: pick(r, ['#3b2a20', '#1f1a17', '#7a4a2a', '#c98a3d', '#d8d2c8', '#a33b2a']),
  };
}

function eyesMarkup(t, cx, cy) {
  const g = t.eyeGap, lx = cx - g + t.look, rx = cx + g + t.look, ink = '#1b1410';
  switch (t.eyes) {
    case 0: return `<circle cx="${lx}" cy="${cy}" r="2.6" fill="${ink}"/><circle cx="${rx}" cy="${cy}" r="2.6" fill="${ink}"/>`;
    case 1: return `<ellipse cx="${lx}" cy="${cy}" rx="2.3" ry="3.6" fill="${ink}"/><ellipse cx="${rx}" cy="${cy}" rx="2.3" ry="3.6" fill="${ink}"/><circle cx="${lx + 0.8}" cy="${cy - 1.3}" r="0.9" fill="#fff"/><circle cx="${rx + 0.8}" cy="${cy - 1.3}" r="0.9" fill="#fff"/>`;
    case 2: return `<path d="M${lx - 3.2} ${cy + 1} q3.2 -4.6 6.4 0" fill="none" stroke="${ink}" stroke-width="2.1" stroke-linecap="round"/><path d="M${rx - 3.2} ${cy + 1} q3.2 -4.6 6.4 0" fill="none" stroke="${ink}" stroke-width="2.1" stroke-linecap="round"/>`;
    case 3: return `<circle cx="${lx}" cy="${cy}" r="4" fill="#fff"/><circle cx="${rx}" cy="${cy}" r="4" fill="#fff"/><circle cx="${lx + 0.9}" cy="${cy + 0.4}" r="2.1" fill="${ink}"/><circle cx="${rx + 0.9}" cy="${cy + 0.4}" r="2.1" fill="${ink}"/>`;
    default: return `<circle cx="${lx}" cy="${cy}" r="2.4" fill="${ink}"/><path d="M${rx - 3} ${cy} h6" stroke="${ink}" stroke-width="2.2" stroke-linecap="round"/>`;
  }
}
function mouthMarkup(t, cx, cy) {
  const ink = '#1b1410';
  switch (t.mouth) {
    case 0: return `<path d="M${cx - 5} ${cy} q5 5 10 0" fill="none" stroke="${ink}" stroke-width="2" stroke-linecap="round"/>`;
    case 1: return `<path d="M${cx - 5.5} ${cy - 0.5} q5.5 8 11 0z" fill="#7a2f2a" stroke="${ink}" stroke-width="1.6" stroke-linejoin="round"/>`;
    case 2: return `<ellipse cx="${cx}" cy="${cy + 1}" rx="2.4" ry="2.9" fill="#7a2f2a" stroke="${ink}" stroke-width="1.4"/>`;
    case 3: return `<path d="M${cx - 4} ${cy + 1.5} q5 1.5 8 -2" fill="none" stroke="${ink}" stroke-width="2" stroke-linecap="round"/>`;
    default: return `<path d="M${cx - 3.5} ${cy + 1} h7" stroke="${ink}" stroke-width="2" stroke-linecap="round"/>`;
  }
}
function extraMarkup(t, cx, cy) {
  switch (t.extra) {
    case 0: return `<circle cx="${cx - 13}" cy="${cy + 6}" r="3.2" fill="#ff7b6b" opacity=".38"/><circle cx="${cx + 13}" cy="${cy + 6}" r="3.2" fill="#ff7b6b" opacity=".38"/>`;
    case 1: return [-12, -9.5, -11, 11, 9.5, 12].map((dx, i) => `<circle cx="${cx + dx}" cy="${cy + 4.5 + (i % 3) * 1.6}" r=".8" fill="#7a4a2a" opacity=".65"/>`).join('');
    case 2: return `<g fill="none" stroke="#e8eef4" stroke-width="1.5"><circle cx="${cx - t.eyeGap + t.look}" cy="${cy}" r="5.6"/><circle cx="${cx + t.eyeGap + t.look}" cy="${cy}" r="5.6"/><path d="M${cx - t.eyeGap + t.look + 5.6} ${cy} h${2 * t.eyeGap - 11.2}"/></g>`;
    case 3: return `<path d="M${cx - 4} ${cy + 15.5} q4 3 8 0" fill="none" stroke="#1b1410" stroke-width="1.2" opacity=".35" stroke-linecap="round"/>`;
    default: return '';
  }
}
function browsMarkup(t, cx, cy) {
  const g = t.eyeGap, ink = t.hairColor, y = cy - 6.5;
  switch (t.brows) {
    case 0: return `<path d="M${cx - g - 3.5} ${y} h7M${cx + g - 3.5} ${y} h7" stroke="${ink}" stroke-width="1.8" stroke-linecap="round"/>`;
    case 1: return `<path d="M${cx - g - 3.5} ${y + 1} l7 -2M${cx + g - 3.5} ${y - 1} l7 2" stroke="${ink}" stroke-width="1.8" stroke-linecap="round"/>`;
    case 2: return `<path d="M${cx - g - 3.5} ${y - 1} l7 2M${cx + g - 3.5} ${y + 1} l7 -2" stroke="${ink}" stroke-width="1.8" stroke-linecap="round"/>`;
    default: return '';
  }
}
function hairMarkup(t, cx, cy) {
  const c = t.hairColor;
  switch (t.hair) {
    case 0: return `<path d="M${cx - 21} ${cy - 9} q21 -17 42 0 q-8 -6 -21 -5 q-13 -1 -21 5z" fill="${c}"/>`;
    case 1: return `<path d="M${cx - 6} ${cy - 15} q3 -8 9 -6 q-4 1 -3 6z" fill="${c}"/>`;
    case 2: return `<path d="M${cx - 22} ${cy - 6} q4 -16 22 -15 q18 -1 22 15 q-6 -9 -14 -9 q-3 4 -8 4 q-12 0 -22 5z" fill="${c}"/>`;
    case 3: return `<path d="M${cx - 20} ${cy - 10} q10 -10 20 -8 l-2 4 l6 -3 q10 2 16 9 q-10 -7 -40 -2z" fill="${c}"/>`;
    default: return '';
  }
}
function stickerMarkup(t) {
  const a = t.accent;
  switch (t.sticker) {
    case 0: return `<path d="M91 44 c.5 3 1.800 4.300 5 5 -3.200 .7 -4.500 2 -5 5 -.5 -3 -1.800 -4.300 -5 -5 3.200 -.7 4.500 -2 5 -5z" fill="${a}"/>`;
    case 1: return `<rect x="86" y="45" width="10" height="3" rx="1.500" fill="${a}"/><rect x="87" y="50" width="8" height="3" rx="1.500" fill="${a}" opacity=".7"/>`;
    case 2: return `<circle cx="91" cy="49" r="3.600" fill="none" stroke="${a}" stroke-width="2"/>`;
    default: return '';
  }
}

/** Inner markup for a 120×120 portrait. `uid` keeps gradient/clip ids unique in the document. */
export function pipPortraitMarkup(name, uid = 'p' + hashName(String(name)).toString(36)) {
  const t = pipTraits(name);
  const cx = 60, cy = 58;         // helmet centre
  const antX = cx + Math.sin(t.tilt * Math.PI / 180) * 26, antY = cy - 36 - Math.cos(t.tilt * Math.PI / 180) * 20;
  return `
  <defs>
    <radialGradient id="${uid}b" cx="50%" cy="38%" r="75%"><stop offset="0" stop-color="${t.backdrop[0]}"/><stop offset="1" stop-color="${t.backdrop[1]}"/></radialGradient>
    <clipPath id="${uid}c"><circle cx="60" cy="60" r="60"/></clipPath>
    <clipPath id="${uid}v"><rect x="${cx - 26}" y="${cy - 19}" width="52" height="41" rx="19"/></clipPath>
  </defs>
  <g clip-path="url(#${uid}c)">
    <rect width="120" height="120" fill="url(#${uid}b)"/>
    <circle cx="22" cy="24" r="1.200" fill="#fff" opacity=".7"/><circle cx="101" cy="30" r="1" fill="#fff" opacity=".55"/><circle cx="92" cy="14" r=".8" fill="#fff" opacity=".5"/><circle cx="14" cy="62" r=".9" fill="#fff" opacity=".4"/>
    <path d="M12 124 q2 -32 30 -34 h36 q28 2 30 34z" fill="${SUIT}"/>
    <path d="M12 124 q2 -32 30 -34 h8 q-22 6 -24 34z" fill="${SUIT_DARK}" opacity=".55"/>
    <rect x="50" y="98" width="20" height="13" rx="3" fill="#f6f1e7"/><rect x="53" y="101" width="6" height="3" rx="1.500" fill="${t.accent}"/><rect x="61" y="101" width="6" height="3" rx="1.500" fill="#7d8a97"/><rect x="53" y="106" width="14" height="2" rx="1" fill="#b9c2cc"/>
    <path d="M18 112 q10 -6 18 -2" stroke="${t.accent}" stroke-width="4" fill="none" stroke-linecap="round"/><path d="M102 112 q-10 -6 -18 -2" stroke="${t.accent}" stroke-width="4" fill="none" stroke-linecap="round"/>
    <rect x="38" y="84" width="44" height="10" rx="5" fill="#8794a2"/><rect x="38" y="84" width="44" height="4" rx="2" fill="#aab5c0"/>
    <path d="M${cx} ${cy - 34} L${antX} ${antY}" stroke="#aab5c0" stroke-width="2.400" stroke-linecap="round"/>
    <circle cx="${antX}" cy="${antY}" r="5.200" fill="${t.bobble}"/><circle cx="${antX - 1.6}" cy="${antY - 1.8}" r="1.600" fill="#fff" opacity=".7"/>
    <circle cx="${cx}" cy="${cy}" r="36" fill="${HELMET}"/>
    <path d="M${cx - 36} ${cy} a36 36 0 0 0 72 0 a40 44 0 0 1 -72 0z" fill="${HELMET_SHADE}" opacity=".7"/>
    <rect x="${cx - 40}" y="${cy - 8}" width="8" height="18" rx="4" fill="${t.accent}"/><rect x="${cx + 32}" y="${cy - 8}" width="8" height="18" rx="4" fill="${t.accent}"/>
    <rect x="${cx - 29}" y="${cy - 22}" width="58" height="47" rx="22" fill="#3a4654"/>
    <rect x="${cx - 26}" y="${cy - 19}" width="52" height="41" rx="19" fill="${VISOR}"/>
    <g clip-path="url(#${uid}v)">
      <ellipse cx="${cx}" cy="${cy + 6}" rx="23" ry="22" fill="${t.face}"/>
      ${hairMarkup(t, cx, cy)}
      ${extraMarkup(t, cx, cy + 2)}
      ${browsMarkup(t, cx, cy + 2)}
      ${eyesMarkup(t, cx, cy + 2)}
      ${mouthMarkup(t, cx, cy + 11)}
      <path d="M${cx - 30} ${cy - 2} l22 -22 h10 l-32 32z" fill="#fff" opacity=".13"/>
      <path d="M${cx + 4} ${cy + 24} l22 -22 v8 l-14 14z" fill="#fff" opacity=".08"/>
    </g>
    ${stickerMarkup(t)}
  </g>`;
}

export function pipPortrait(name, { size, cls = 'portrait' } = {}) {
  const node = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  node.setAttribute('viewBox', '0 0 120 120');
  node.setAttribute('class', cls);
  node.setAttribute('role', 'img');
  node.setAttribute('aria-label', 'Portrait of ' + name);
  if (size) { node.setAttribute('width', size); node.setAttribute('height', size); }
  node.innerHTML = pipPortraitMarkup(name, 'p' + hashName(String(name)).toString(36) + Math.floor(Math.random() * 1e6).toString(36));
  return node;
}

/** A whole standing Pip as <g> markup. Feet rest on (x, y); about 44 wide and 62 tall at scale 1. */
export function pipFigureMarkup({ x = 0, y = 0, scale = 1, seed = 'Pip', wave = false, flip = false, cls = '' } = {}) {
  const t = pipTraits(seed);
  const s = flip ? -scale : scale;
  const armR = wave
    ? `<g class="wave"><path d="M12 -30 q9 -6 11 -17" stroke="${SUIT}" stroke-width="7" fill="none" stroke-linecap="round"/><circle cx="23.500" cy="-48" r="4.300" fill="${HELMET}"/></g>`
    : `<path d="M12 -29 q7 4 7 13" stroke="${SUIT}" stroke-width="7" fill="none" stroke-linecap="round"/><circle cx="19" cy="-15" r="4.200" fill="${HELMET}"/>`;
  return `<g transform="translate(${x} ${y}) scale(${s} ${scale})"><g class="${cls}">
    <ellipse cx="0" cy="1" rx="17" ry="3.500" fill="#000" opacity=".28"/>
    <rect x="-10.500" y="-13" width="8.500" height="13" rx="3.500" fill="${SUIT_DARK}"/><rect x="2" y="-13" width="8.500" height="13" rx="3.500" fill="${SUIT_DARK}"/>
    <rect x="-12" y="-4" width="11" height="5" rx="2.500" fill="#f6f1e7"/><rect x="1" y="-4" width="11" height="5" rx="2.500" fill="#f6f1e7"/>
    <path d="M-12 -29 q-7 4 -7 13" stroke="${SUIT}" stroke-width="7" fill="none" stroke-linecap="round"/><circle cx="-19" cy="-15" r="4.200" fill="${HELMET}"/>
    ${armR}
    <rect x="-13" y="-34" width="26" height="24" rx="9" fill="${SUIT}"/>
    <rect x="-6" y="-26" width="12" height="8" rx="2" fill="#f6f1e7"/><rect x="-4" y="-24" width="4" height="2" rx="1" fill="${t.accent}"/><rect x="1" y="-24" width="3" height="2" rx="1" fill="#7d8a97"/>
    <rect x="-13" y="-15" width="26" height="3" fill="${t.accent}" opacity=".9"/>
    <path d="M0 -62 L${(t.tilt / 4).toFixed(1)} -71" stroke="#aab5c0" stroke-width="1.600" stroke-linecap="round"/>
    <circle cx="${(t.tilt / 4).toFixed(1)}" cy="-72.500" r="3" fill="${t.bobble}"/>
    <circle cx="0" cy="-45" r="18" fill="${HELMET}"/>
    <path d="M-18 -45 a18 18 0 0 0 36 0 a20 22 0 0 1 -36 0z" fill="${HELMET_SHADE}" opacity=".7"/>
    <rect x="-13" y="-55" width="27" height="20" rx="9.500" fill="${VISOR}"/>
    <ellipse cx="1" cy="-42" rx="10.500" ry="9" fill="${t.face}" opacity=".95"/>
    <circle cx="-3" cy="-44" r="1.500" fill="#1b1410"/><circle cx="5.500" cy="-44" r="1.500" fill="#1b1410"/>
    <path d="M-1.500 -39.500 q2.800 2.600 5.600 0" fill="none" stroke="#1b1410" stroke-width="1.200" stroke-linecap="round"/>
    <path d="M-12 -47 l8 -8 h5 l-13 13z" fill="#fff" opacity=".16"/>
    <rect x="-20" y="-49" width="4" height="9" rx="2" fill="${t.accent}"/><rect x="16" y="-49" width="4" height="9" rx="2" fill="${t.accent}"/>
  </g></g>`;
}

export function pipFigure({ seed = 'Juno', wave = false } = {}) {
  const node = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  node.setAttribute('viewBox', '-30 -80 60 86');
  node.setAttribute('class', 'sw-scene-pip sw-scene');
  node.style.position = 'static';
  node.innerHTML = pipFigureMarkup({ seed, wave });
  return node;
}

// ------------------------------------------------------------------ screen

const TRAIT = {
  pilot: ['Pilot', 'pilot', 'Steady hands on the stick.'],
  engineer: ['Engineer', 'engineer', 'Can fix it. Probably.'],
  scientist: ['Scientist', 'scientist', 'Writes everything down.'],
};
const STATUS = {
  available: ['Ready', 'green'], assigned: ['On a mission', 'amber'], away: ['Away', 'amber'], lost: ['Lost', 'red'],
};

const PERK = {
  pilot: 'tidier landings: recovery counts 10% closer to the pad',
  engineer: '+2% recovered parts value',
  scientist: '+10% science from results brought home',
};
const BODY_NAMES = { verda: 'Verda', pell: 'Pell', ost: 'Ost', rusk: 'Rusk', cindra: 'Cindra', thal: 'Thal', tiv: 'Tiv', helion: 'Helion' };
const RENAME_WHY = { empty: 'A Pip needs a name.', long: `Names can be up to ${PIP_NAME_MAX} characters.`, taken: 'Another Pip already has that name.', busy: 'Only Pips on the ground can be renamed.', unknown: 'That Pip is not on the roster.' };

/** 'orbit:verda' → 'Orbited Verda' */
export function deedLabel(d) {
  if (d === 'space') return 'Space';
  const [kind, body] = String(d).split(':');
  const name = BODY_NAMES[body] || body || '';
  return kind === 'orbit' ? 'Orbited ' + name : kind === 'visit' ? 'Flew by ' + name : kind === 'land' ? 'Stood on ' + name : String(d);
}

export function createCrewScreen(app) {
  let frame = null, page = null, strip = null, lastKey = '';

  function rosterKey() {
    const c = app.career;
    return c.roster.map(p => p.name + p.status + p.flights + '/' + (p.xp || 0)).join(',') + '|' + Math.floor(c.funds);
  }

  function hireCost() {
    const c = app.career;
    return typeof c.hireCost === 'function' ? c.hireCost() : null;
  }

  function doHire() {
    const c = app.career;
    const res = c.hire();
    if (res && res.ok) {
      const name = res.pip ? res.pip.name : 'A new Pip';
      app.toast(name + ' joined the crew' + (c.mode === 'career' && res.cost ? ' for ' + fmt.funds(res.cost) : '') + '.', 'good');
      app.audio.play('success');
      app.save(true);
    } else {
      const why = res && (res.reason === 'full' || res.reason === 'quarters') ? 'Every bed in the Crew Quarters is taken. Upgrade the building in Administration.' : 'Not enough funds to hire' + (res && res.cost ? ' (' + fmt.funds(res.cost) + ' needed).' : '.');
      app.toast(why, 'warn');
    }
    draw();
  }

  async function doRename(p) {
    const c = app.career;
    const input = el('input', { class: 'sw-input', value: p.name, attrs: { type: 'text', maxlength: PIP_NAME_MAX, autofocus: true, 'data-role': 'pip-name', 'aria-label': 'New name' }, style: { width: '100%' } });
    const msg = el('div', { class: 'sw-msg bad sw-hidden' });
    let result = null;
    const tryIt = () => {
      const r = c.renamePip(p.name, input.value);
      if (r.ok) { result = r; return true; }
      msg.textContent = RENAME_WHY[r.reason] || 'That name cannot be used.';
      msg.classList.remove('sw-hidden');
      return false;
    };
    const body = el('div', { class: 'sw-col', style: { gap: '10px' } },
      el('div', { class: 'sw-row', style: { gap: '14px' } }, pipPortrait(p.name, { size: 56 }),
        el('div', { class: 'sw-grow' }, el('div', { class: 'sw-label', text: 'Name', style: { marginBottom: '4px' } }), input)), msg);
    const dlg = showModal({ title: 'Rename ' + p.name, body, cancelValue: null,
      buttons: [{ label: 'Cancel', value: null }, { label: 'Rename', value: 'ok', kind: 'primary', onClick: () => tryIt() }] });
    setTimeout(() => { try { input.focus(); input.select(); } catch { /* closed already */ } }, 30);
    const res = await dlg;
    if (res === 'ok' && result) { app.toast('Now answering to ' + result.name + '.', 'good'); app.save(true); }
    if (frame) draw();
  }

  async function doDismiss(p) {
    const c = app.career;
    const sure = await app.confirm('Let ' + p.name + ' go?',
      p.name + ' will hand in the orange suit and leave the program for good' + (pipStars(p) ? ', taking ' + pipStars(p) + (pipStars(p) === 1 ? ' star' : ' stars') + ' of experience along' : '') + '.',
      { okLabel: 'Dismiss', cancelLabel: 'Keep', danger: true });
    if (!sure || !frame) return;
    const r = c.dismissPip(p.name);
    if (r.ok) { app.toast(p.name + ' has left the program.', 'warn'); app.save(true); }
    else app.toast(r.reason === 'last' ? 'Somebody has to stay: this is your last Pip.' : 'Only Pips on the ground can be dismissed.', 'warn');
    draw();
  }

  function stars(p) {
    const n = pipStars(p), xp = p.xp || 0;
    const next = n < MAX_STARS ? `${xp} XP · next star at ${XP_STARS[n]}` : `${xp} XP · as experienced as a Pip gets`;
    return starRow(n, MAX_STARS, { tip: next });
  }

  function card(p) {
    const [tName, tIcon, tBlurb] = TRAIT[p.trait] || [p.trait || 'Crew', 'crew', ''];
    const [sName, sColor] = STATUS[p.status] || [p.status, ''];
    const n = pipStars(p);
    const ground = p.status === 'available';
    const last = app.career.roster.filter(x => x.status !== 'lost').length <= 1;
    return el('div', { class: 'sw-pip-card', data: { pip: p.name } },
      pipPortrait(p.name),
      el('b', { text: p.name }),
      stars(p),
      el('div', { class: 'trait', text: tBlurb }),
      el('div', { class: 'meta' },
        el('span', { class: 'sw-chip teal' }, icon(tIcon), tName),
        el('span', { class: 'sw-chip ' + sColor, text: sName, data: { status: p.status } }),
        el('span', { class: 'sw-chip', text: p.flights + (p.flights === 1 ? ' flight' : ' flights') })),
      el('div', { class: 'deeds' }, (p.deeds || []).slice(-6).map(d => el('span', { class: 'sw-chip violet', text: deedLabel(d) }))),
      el('div', { class: 'perk', tip: 'Stars come from experience: recover a flight that reached space, orbit or another world' },
        n ? el('b', { text: `${n}★ ` }) : null, n ? PERK[p.trait].replace(/(\d+)%/, (m, v) => (v * n) + '%') : 'Each star: ' + PERK[p.trait]),
      el('div', { class: 'actions' },
        el('button', { class: 'sw-btn ghost small', disabled: !ground, attrs: { type: 'button', 'data-action': 'rename' },
          tip: ground ? 'Change this Pip\'s name' : 'Only Pips on the ground can be renamed', on: { click: () => doRename(p) } }, icon('pencil'), 'Rename'),
        el('button', { class: 'sw-btn ghost small', disabled: !ground || last, attrs: { type: 'button', 'data-action': 'dismiss' },
          tip: last ? 'Your last Pip cannot be dismissed' : ground ? 'Remove this Pip from the roster' : 'Only Pips on the ground can be dismissed', on: { click: () => doDismiss(p) } }, icon('exit'), 'Dismiss')));
  }

  function plaque(p) {
    const where = p.lostWhere ? (p.lostWhere === 'verda' ? 'over Verda' : 'at ' + (BODY_NAMES[p.lostWhere] || p.lostWhere)) : 'in the line of duty';
    const when = p.lostAt != null ? fmt.date(p.lostAt).replace(/, \d\d:\d\d:\d\d$/, '') : 'Date unrecorded';
    const [tName] = TRAIT[p.trait] || ['Crew'];
    return el('div', { class: 'sw-plaque sw-pip-card-lost', data: { pip: p.name, memorial: '1' } },
      pipPortrait(p.name),
      el('div', { class: 'sw-grow' },
        el('div', { class: 'sw-row', style: { justifyContent: 'space-between' } }, el('b', { text: p.name }), pipStars(p) ? starRow(pipStars(p), MAX_STARS) : null),
        el('div', { class: 'line', text: `${tName} · ${p.flights} ${p.flights === 1 ? 'flight' : 'flights'} completed` }),
        el('div', { class: 'line', text: `Lost ${where}${p.lostVessel ? ' aboard ' + p.lostVessel : ''}` }),
        el('div', { class: 'line sw-dim', text: when })));
  }

  function draw() {
    const c = app.career;
    lastKey = rosterKey();
    clear(page);
    const grid = el('div', { class: 'sw-crew-grid' });
    const order = { available: 0, assigned: 1, away: 1 };
    const list = c.roster.filter(p => p.status !== 'lost').sort((a, b) => (order[a.status] ?? 1) - (order[b.status] ?? 1));
    for (const p of list) grid.appendChild(card(p));

    const cost = hireCost();
    const free = c.mode !== 'career';
    const beds = c.limitOf ? c.limitOf('crew') : Infinity, full = list.length >= beds;
    const can = !full && (free || cost == null || c.canAfford(cost));
    grid.appendChild(el('div', { class: 'sw-pip-card hire' },
      el('div', { class: 'sw-title', text: 'Recruit a Pip' }),
      el('div', { class: 'trait', text: full ? `All ${beds} beds are taken.` : 'A fresh face, eager and slightly nervous.' }),
      el('button', { class: 'sw-btn primary', disabled: !can, attrs: { type: 'button', 'data-action': 'hire' },
        tip: can ? 'Add a new Pip to the roster' : full ? 'The Crew Quarters are full' : 'Not enough funds', on: { click: doHire } },
        icon('plus'), free || cost == null ? 'Hire' : 'Hire for ' + fmt.funds(cost)),
      full ? el('div', { class: 'sw-msg warn', data: { reason: 'quarters' }, text: 'Upgrade the Crew Quarters in Administration to house more.' })
        : !can ? el('div', { class: 'sw-msg warn', text: 'You need ' + fmt.funds(cost) + '.' }) : null));
    page.appendChild(grid);

    const lost = typeof c.memorial === 'function' ? c.memorial() : c.roster.filter(p => p.status === 'lost');
    if (lost.length) {
      page.appendChild(el('div', { class: 'sw-memorial-head', data: { role: 'memorial' } },
        el('span', { class: 'sw-title', text: 'Memorial Wall' }),
        el('span', { class: 'sw-dim', text: 'They went up so the rest of us could follow.' })));
      page.appendChild(el('div', { class: 'sw-memorial' }, lost.map(plaque)));
    }

    const ready = c.roster.filter(p => p.status === 'available').length;
    const alive = c.roster.filter(p => p.status !== 'lost').length;
    frame.setSubtitle(`${alive} ${alive === 1 ? 'Pip' : 'Pips'} on the roster · ${ready} ready to fly`);
    const cap = c.limitOf ? c.limitOf('crew') : Infinity;
    clear(strip);
    strip.append(el('span', null, el('b', { text: String(ready) }), 'ready'), el('span', null, el('b', { text: String(alive - ready) }), 'away'),
      Number.isFinite(cap) ? el('span', { tip: 'Beds in the Crew Quarters. Upgrade the building in Administration for more.', data: { role: 'crew-cap' } }, el('b', { text: `${alive}/${cap}` }), 'beds') : null,
      Number.isFinite(cap) ? el('div', { class: 'sw-bar thin' + (alive >= cap ? ' amber' : '') }, el('i', { style: { width: Math.min(100, alive / cap * 100).toFixed(0) + '%' } })) : null);
    frame.setStatus(ready ? `${ready} ready to fly` : 'Nobody free to fly', ready ? 'good' : 'amber');
    frame.stats.refresh();
  }

  return {
    is3D: true, capturesKeys: false,
    enter() {
      frame = interiorFrame(app, { name: 'crew', building: 'crew', title: 'Crew Quarters', code: 'CQ' });
      page = el('div', { class: 'sw-crew-page sw-scroll' });
      strip = el('div', { class: 'sw-roster-strip' });
      frame.page.appendChild(el('div', { class: 'sw-ipanel fit sw-grow', style: { display: 'flex', flexDirection: 'column', minHeight: '0' } },
        el('div', { class: 'sw-ihead' }, el('span', { text: 'Roster' }), el('span', { class: 'sw-grow' }), strip), page));
      app.uiRoot.appendChild(frame.root);
      draw();
    },
    exit() { if (frame) frame.dispose(); frame = page = strip = null; },
    render() { if (frame) frame.render(); },
    resize(w, h) { if (frame) frame.resize(w, h); },
    update(dt) {
      if (!frame) return;
      if (app.input.pressed('Escape') && !isModalOpen()) { app.goto('hub'); return; }
      frame.update(dt);
      if (rosterKey() !== lastKey) draw();
    },
  };
}
