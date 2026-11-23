// Starwright — small shared pieces for the career screens (Mission Board, Crew Quarters, Flight School, hub).
//   ensureCareerCss()            loads css/career.css once (no edit to index.html needed)
//   rewardChip(kind, icon, text) coloured pill with an icon
//   starRow(n, max)              experience stars
//   downloadText(name, text)     hand the player a file
//   pickTextFile()               → Promise<{name, text} | null>  (opens the browser's file chooser)
import { el, icon, ICONS } from './dom.js';

const S = 'fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"';
Object.assign(ICONS, {
  school: `<path ${S} d="M2.500 9.500 12 5l9.500 4.500L12 14zM6.500 11.700V16c1.500 1.500 3.300 2.200 5.500 2.200s4-.7 5.500-2.200v-4.300M21.500 9.500v5.500"/>`,
  contract: `<path ${S} d="M6 3.500h9l3.500 3.500v13.500H6zM14.500 3.500v4h4M9 12h6.500M9 15.500h4"/><path ${S} d="M9 8.500h2.500"/>`,
  flag: `<path ${S} d="M6 21V4M6 5h11l-2.500 3.500L17 12H6"/>`,
  orbit: `<circle ${S} cx="12" cy="12" r="3.200"/><ellipse ${S} cx="12" cy="12" rx="10" ry="4.500" transform="rotate(-28 12 12)"/>`,
  target: `<circle ${S} cx="12" cy="12" r="8.500"/><circle ${S} cx="12" cy="12" r="4"/><circle cx="12" cy="12" r="1.300" fill="currentColor"/>`,
  download: `<path ${S} d="M12 4v11M7.500 11l4.500 4.500 4.500-4.500M5 19.500h14"/>`,
  upload: `<path ${S} d="M12 16V5M7.500 9 12 4.500 16.500 9M5 19.500h14"/>`,
  pencil: `<path ${S} d="M4 20l1-4.500L16 4.500l3.500 3.500L8.500 19zM14 6.500l3.500 3.500"/>`,
  book: `<path ${S} d="M4 5.500c2.500-1 5.500-1 8 .5 2.500-1.500 5.500-1.500 8-.5v13c-2.500-1-5.500-1-8 .5-2.500-1.500-5.500-1.500-8-.5zM12 6v13"/>`,
  compass: `<circle ${S} cx="12" cy="12" r="9"/><path ${S} d="M15.500 8.500 13.500 13.500 8.500 15.500 10.500 10.500z"/>`,
});

let cssRequested = false;
export function ensureCareerCss() {
  if (cssRequested || typeof document === 'undefined') return;
  cssRequested = true;
  if (document.querySelector('link[data-sw-career]')) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = new URL('../../css/career.css', import.meta.url).href;
  link.setAttribute('data-sw-career', '1');
  document.head.appendChild(link);
}
ensureCareerCss();

export function rewardChip(kind, ico, text, tip) {
  return el('span', { class: 'sw-chip ' + kind, tip }, icon(ico), text);
}

export function starRow(n, max = 5, { tip } = {}) {
  const row = el('span', { class: 'sw-stars', tip, data: { stars: String(n) }, attrs: { role: 'img', 'aria-label': `${n} of ${max} stars` } });
  for (let i = 0; i < max; i++) row.appendChild(icon('star', i < n ? 'on' : ''));
  return row;
}

export function downloadText(filename, text, type = 'application/json') {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const a = el('a', { href: url, download: filename, style: { display: 'none' } });
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { a.remove(); URL.revokeObjectURL(url); }, 1500);
}

/** Opens the file chooser. Resolves with {name, text}, or null if nothing readable was picked. */
export function pickTextFile(accept = '.json,application/json') {
  return new Promise(resolve => {
    const input = el('input', { attrs: { type: 'file', accept, 'data-role': 'import-file' }, style: { display: 'none' } });
    document.body.appendChild(input);
    let settled = false;
    const done = v => { if (settled) return; settled = true; setTimeout(() => input.remove(), 0); resolve(v); };
    input.addEventListener('change', () => {
      const file = input.files && input.files[0];
      if (!file) return done(null);
      const reader = new FileReader();
      reader.onload = () => done({ name: file.name, text: String(reader.result || '') });
      reader.onerror = () => done(null);
      reader.readAsText(file);
    });
    input.addEventListener('cancel', () => done(null));
    input.click();
  });
}

// ------------------------------------------------------------------ the key list (Controls dialog and Flight School)
// One list for both places. Flight keys marked in the pause menu's "Flight controls" can be remapped there; these are
// the defaults (js/ui/flight.js DEFAULT_KEYS, js/ui/builder.js, js/ui/mapview.js, js/ui/hub.js).
const K = (...keys) => keys;
export const CONTROL_GROUPS = [
  ['Flying', [
    ['Pitch down / up (wheels: drive)', K('W', 'S')], ['Yaw left / right (wheels: steer)', K('A', 'D')], ['Roll left / right', K('Q', 'E')],
    ['Throttle up / down', K('Shift', 'Ctrl')], ['Full throttle / cut throttle', K('Z', 'X')],
    ['Launch / fire the next stage', K('Space')], ['Fine controls (gentle inputs)', K('Caps Lock')],
    ['SAS (stability assist)', K('T')], ['RCS thrusters', K('R')],
    ['RCS translate forward / back', K('H', 'N')], ['RCS translate up / down', K('I', 'K')], ['RCS translate left / right', K('J', 'L')],
  ]],
  ['Systems', [
    ['Landing legs and gear', K('G')], ['Lights and solar panels', K('U')], ['Brakes (hold)', K('B')],
    ['Abort group', K('Backspace')], ['Action groups', K('1', '…', '9')],
  ]],
  ['Navigation and view', [
    ['Orbital map', K('M')], ['Missions: program and contracts', K('O')], ['Camera: orbital / chase / free / locked', K('V')], ['Speed read-out: surface / orbit / target', K('C')],
    ['Next target / clear target', K('Y', 'or', 'Shift', 'Y')], ['Switch to a nearby vessel', K('[', ']')], ['Hop between booster and upper stage', K('\\')],
    ['Hide the instruments', K('F2')], ['Save a screenshot', K('F1')], ['Pause menu (revert, recover, Flight Center)', K('Esc')],
  ]],
  ['Time', [
    ['Time warp slower / faster', K(',', '.')], ['Stop time warp', K('/')],
    ['Physics warp slower / faster (engines may run)', K('Alt', ',', 'or', 'Alt', '.')],
    ['Quicksave', K('F5', 'or', 'Shift', 'K')], ['Quickload', K('F9', 'or', 'Shift', 'L')],
  ]],
  ['On a spacewalk', [
    ['Walk / fly', K('W', 'A', 'S', 'D')], ['Jump, or jetpack up', K('Space')], ['Jetpack up / down', K('Shift', 'Ctrl')],
    ['Jetpack on / off', K('R')], ['Grab a hatch and board', K('F')], ['Plant a flag', K('P')],
  ]],
  ['Orbital map', [
    ['Plan a maneuver', K('Click', 'your orbit')], ['Next / previous focus', K('Tab', 'or', 'Shift', 'Tab')], ['Focus your vessel', K('`')],
    ['Delete the selected maneuver', K('Delete')], ['Orbit / zoom the map', K('Right-drag', 'Scroll wheel')],
  ]],
  ['Assembly buildings', [
    ['Tools: place / move / rotate / re-root', K('1', '2', '3', '4')], ['Action group editor', K('5')],
    ['Symmetry up / down', K('X', 'or', 'Shift', 'X')], ['Radial ↔ mirror symmetry', K('R')], ['Angle snap', K('C')],
    ['Turn the held part (Shift: fine)', K('Q', 'E')], ['Flip the held part', K('W', 'S')], ['Frame the craft', K('F')],
    ['Remove the part under the mouse', K('Delete')], ['Drop the held part', K('Esc')],
    ['Undo / redo', K('Cmd', 'Z', 'or', 'Shift', 'Cmd', 'Z')],
    ['Scroll along the craft / zoom', K('Scroll wheel', 'or', 'Shift', 'Scroll wheel')],
  ]],
  ['Mouse', [
    ['Zoom', K('Scroll wheel')], ['Orbit the camera', K('Right-drag')], ['Pan the camera', K('Middle-drag')], ['Select / place', K('Click')], ['Focus', K('Double-click')],
  ]],
  ['Flight Center', [
    ['Look around', K('Drag')], ['Move the view', K('W', 'A', 'S', 'D')], ['Turn / zoom the view', K('Q', 'E', 'R', 'F')],
    ['Step through buildings', K('←', '→')], ['Enter a building', K('Click', 'or', 'Enter')], ['Enter by number', K('1', '…', '0')],
    ['Fly the camera to a building', K('Double-click')], ['Reset the view / labels', K('H', 'L')],
  ]],
];
const KEY_WORDS = new Set(['or', 'your orbit']);
/** The key list as a two-column grid (class `sw-controls` in the dialog, `sw-keys` in Flight School). */
export function controlsGrid(cls = 'sw-controls') {
  const grid = el('div', { class: cls });
  for (const [group, rows] of CONTROL_GROUPS) {
    grid.appendChild(el('h4', { text: group }));
    for (const [label, keys] of rows) {
      grid.appendChild(el('div', { class: 'sw-control' }, el('span', { text: label }),
        el('span', { class: 'keys' }, keys.map(k => (KEY_WORDS.has(k) ? k : el('span', { class: 'sw-kbd', text: k }))))));
    }
  }
  return grid;
}
