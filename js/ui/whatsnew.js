// Starwright — "What's New": the list of what each release added, and the pop-up that shows it.
//
// A returning player sees, once, the entries added since their last visit; they dismiss it (Got it, Enter, Esc or a
// click outside) and are on the title menu. The title menu's "What's New" entry opens the whole list at any time.
// Somebody opening the game for the first time is not interrupted: the list is marked as seen and nothing is shown.
//
// ADDING AN ENTRY (every pull request that changes what a player sees or does should add one):
//   put a new object at the TOP of RELEASES. That is the whole job; nothing else needs touching.
//     id     a short name nobody has used before ('reusable-boosters'). Never change or reuse one: the browser
//            remembers the newest id it has shown, and that is how it knows what a player has not seen yet.
//     date   the day it reaches `main`, as 'YYYY-MM-DD'. Entries are shown grouped by day, so a "release" is one
//            day's entries. Newest first: a date may not be later than the one above it.
//     title  a few words, no full stop.
//     text   one or two plain sentences saying what the player will notice. [label](https://…) is a link.
//            No other markup and no long dashes (tests/unit/whatsnew.test.js checks all of this).
//
//   RELEASES                     the entries, newest first
//   unseen(seenId, list)         the entries newer than the one with that id (all of them when the id is unknown)
//   groupByDay(list)             [{ date, label, entries }] in the order given
//   openWhatsNew(app, opts)      opens the list; opts.entries = which (default all); resolves when it is closed
//   installWhatsNew(app)         adds app.whatsNew = { open, auto, note, entries, latest }
//   app.whatsNew.auto()          the once-per-release pop-up: called after the title menu is up (js/main.js)
// Address switches: ?whatsnew=1 shows the pop-up with everything, ?whatsnew=0 keeps it away.
// Test hooks: .sw-whatsnew (the list), [data-day="YYYY-MM-DD"] (a day), [data-entry="<id>"] (an entry).
import { el, showModal } from './dom.js';

export const SEEN_KEY = 'starwright.whatsnew.v1';
const REPO_URL = 'https://github.com/jsmith0475/Starwright';

export const RELEASES = [
  { id: 'whats-new', date: '2026-11-22', title: "What's New",
    text: 'This list. It appears once when there is something you have not seen, and it is always on the main menu.' },
  { id: 'science-aero', date: '2026-11-22', title: 'Science: aerodynamics, structure and breakup',
    text: 'The Science reference on the main menu has three new chapters: how the game works out the air on every part and why a rocket weathervanes, the loads in the structure, and aerodynamic breakup. A new calculator gives the air load in a turn.' },
  { id: 'new-trailer', date: '2026-11-22', title: 'A new trailer',
    text: `The trailer and screenshots on the project page were recorded again from the current game: [github.com/jsmith0475/Starwright](${REPO_URL}#readme).` },
  { id: 'breakup-clips', date: '2026-11-22', title: 'See it break',
    text: `The project page has a new Aerodynamics section and a 27-second clip of a stack snapping and a rocket being stripped by the airflow: [github.com/jsmith0475/Starwright](${REPO_URL}#readme).` },
  { id: 'fallen-lander', date: '2026-11-21', title: 'A lander that falls over stays where it fell',
    text: 'A lander on its side used to sink a little into the ground and creep downhill for ever. It now lies on the surface and comes to rest.' },
  { id: 'aero-breakup', date: '2026-11-21', title: 'Aerodynamic breakup',
    text: 'A rocket that flips or tumbles in thick air now sheds parts: fins and wings fold at the root, and antennas, open solar panels, nose cones and fairings are torn off above the air pressure they are rated for. A clean climb loses nothing. Part cards in the assembly building show each air limit.' },
  { id: 'structure', date: '2026-11-21', title: 'Structural dynamics',
    text: 'Every joint between two parts now carries a real load, bends under it and breaks if it stays over its limit. The assembly building reports the weakest joints before you launch, and the flight screen has a Structure read-out. Brace struts share the load.' },
  { id: 'landing-legs', date: '2026-11-21', title: 'Landing legs with real suspension',
    text: 'Each leg is its own spring and damper with a stroke you can see close on touchdown, and a landing that is too hard breaks it. Landers no longer freeze the moment they touch the ground.' },
  { id: 'trees', date: '2026-11-21', title: 'Trees and grass from real scans',
    text: 'Tree crowns are built from scans of real leaves, conifer boughs and bark, and the grass is finer and denser.' },
  { id: 'realism-3', date: '2026-11-21', title: 'A more real-looking world',
    text: 'Soft contact shadows, rockets that reflect the sky and ground around them, terrain that no longer repeats in rows, part-buried boulders, and a sea that deepens away from the shore.' },
];

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
/** '2026-11-22' → '22 November 2026' (no Date object: a date string must not shift with the time zone). */
export function dayLabel(date) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date || '');
  return m ? `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]} ${m[1]}` : String(date);
}

/** The entries newer than the one a player last saw. An id that is not in the list (or none) means all of them. */
export function unseen(seenId, list = RELEASES) {
  const i = list.findIndex(e => e.id === seenId);
  return i < 0 ? list.slice() : list.slice(0, i);
}

/** Entries → [{ date, label, entries }], keeping their order. */
export function groupByDay(list = RELEASES) {
  const days = [];
  for (const e of list) {
    let d = days[days.length - 1];
    if (!d || d.date !== e.date) days.push(d = { date: e.date, label: dayLabel(e.date), entries: [] });
    d.entries.push(e);
  }
  return days;
}

function readSeen() { try { return localStorage.getItem(SEEN_KEY); } catch { return null; } }
function writeSeen(id) { try { localStorage.setItem(SEEN_KEY, id); } catch { /* private mode: it will show again next time */ } }

const CSS = `
.sw-modal.sw-whatsnew-modal { width: min(640px, 100%); max-height: min(720px, 100%); display: flex; flex-direction: column; }
.sw-modal.sw-whatsnew-modal .sw-modal-body { flex: 1; min-height: 0; overflow-y: auto; padding: 16px 28px 8px; }
.sw-whatsnew > section { margin: 0 0 16px; }
.sw-whatsnew h3 { margin: 0 0 8px; font-size: 12px; font-weight: 600; letter-spacing: 0.08em; text-transform: uppercase; color: var(--sw-teal); }
.sw-whatsnew .wn-entry { margin: 0 0 11px; }
.sw-whatsnew .wn-entry b { display: block; margin-bottom: 2px; font-size: 15px; color: var(--sw-text); }
.sw-whatsnew .wn-entry p { margin: 0; font-size: 13.5px; line-height: 1.5; color: var(--sw-dim); }
.sw-whatsnew a { color: var(--sw-teal); }
`;
let cssDone = false;
function addCss() {
  if (cssDone || typeof document === 'undefined') return;
  cssDone = true;
  document.head.appendChild(el('style', { text: CSS }));
}

/** Text → child nodes, with [label](https://…) turned into links. */
function inline(text) {
  const out = [];
  const re = /\[([^\]]+)\]\((https:\/\/[^)\s]+)\)/g;
  let last = 0, m;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    out.push(el('a', { text: m[1], attrs: { href: m[2], target: '_blank', rel: 'noopener noreferrer' } }));
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/** Opens the list. opts.entries: which entries (default: all of them). Resolves when it is closed. */
export function openWhatsNew(app, { entries = RELEASES } = {}) {
  addCss();
  const body = el('div', { class: 'sw-whatsnew' }, ...groupByDay(entries).map(d =>
    el('section', { attrs: { 'data-day': d.date } }, el('h3', { text: d.label }),
      ...d.entries.map(e => el('div', { class: 'wn-entry', attrs: { 'data-entry': e.id } }, el('b', { text: e.title }), el('p', {}, ...inline(e.text)))))));
  return showModal({ title: "What's new in Starwright", body, class: 'sw-whatsnew-modal', cancelValue: false, buttons: [{ label: 'Got it', value: true, kind: 'primary' }] });
}

/** Adds app.whatsNew (the title menu looks for it; js/main.js calls auto() once the menu is up). */
export function installWhatsNew(app) {
  const latest = RELEASES.length ? RELEASES[0] : null;
  const flag = typeof location !== 'undefined' ? new URLSearchParams(location.search).get('whatsnew') : null;
  app.whatsNew = {
    entries: RELEASES, latest,
    /** The small print on the menu entry: the day of the newest entry ('22 November'). */
    note: () => (latest ? dayLabel(latest.date).replace(/ \d{4}$/, '') : ''),
    open: () => { if (latest) writeSeen(latest.id); return openWhatsNew(app); },
    /** The once-per-release pop-up. Resolves true when it was shown (after it is closed), false when there was nothing to show. */
    auto() {
      if (!latest || flag === '0') return Promise.resolve(false);
      const seen = readSeen();
      const returning = !app.firstVisit;      // js/main.js: was anything of Starwright stored when the page opened?
      const fresh = flag === '1' ? RELEASES : unseen(seen);
      // Marked as seen the moment it is shown: it never comes up twice for the same release.
      writeSeen(latest.id);
      if (flag !== '1' && (!returning || !fresh.length)) return Promise.resolve(false);
      return openWhatsNew(app, { entries: fresh }).then(() => true);
    },
  };
  return app.whatsNew;
}
