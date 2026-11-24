// Starwright — the Flight Center hub (a live 3D space centre) and the title screen / main menu.
//   createHubScreen(app), createTitleScreen(app)
//   openSettings(app), openControls(), openNewGame(app), openLaunchDialog(app, { site })   dialogs other screens may reuse
//
// The hub draws the base from js/render/basegfx.js through js/ui/baseview.js. Mouse: right-drag (or left-drag) orbits,
// wheel zooms, middle-drag pans, hover names a building, click enters it, double-click flies the camera to it.
// Keyboard: W A S D pan, Q E turn, R F zoom, arrow keys step through the buildings, Enter enters, 1–9 and 0 enter
// directly, H resets the view, L toggles labels, Tab walks the quick bar. Without WebGL the hub is a plain list.
//
// Test hooks: app.screens.hub.debug = { view, hovered(), screenPos(id), state() }.
import { el, clear, fmt, icon, showModal, isModalOpen, statsBar, uiScale } from './dom.js';
import { pipFigure, pipPortrait } from './crew.js';
import { PARTS } from '../core/parts.js';
import { TECH_TREE } from '../core/career.js';
import { ensureCareerCss, downloadText, pickTextFile, controlsGrid } from './careerui.js';
import { getBaseView } from './baseview.js';
import { BASE_BUILDINGS } from '../render/basegfx.js';
import { createAdminScreen } from './admin.js';

ensureCareerCss();

export { pipFigure };

// ------------------------------------------------------------------ wordmark

function wordmark() {
  const node = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  node.setAttribute('viewBox', '0 0 560 150');
  node.setAttribute('class', 'sw-wordmark');
  node.setAttribute('role', 'img');
  node.setAttribute('aria-label', 'Starwright');
  node.innerHTML = `
    <defs>
      <linearGradient id="swWm" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#39d0c0" stop-opacity="0"/><stop offset=".25" stop-color="#39d0c0"/><stop offset="1" stop-color="#ffb347"/></linearGradient>
      <linearGradient id="swWt" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffffff"/><stop offset="1" stop-color="#cfe6ea"/></linearGradient>
    </defs>
    <path d="M30 118 Q280 152 520 86" fill="none" stroke="url(#swWm)" stroke-width="3.500" stroke-linecap="round"/>
    <circle cx="522" cy="85" r="7" fill="#ffb347"/><circle cx="522" cy="85" r="12" fill="#ffb347" opacity=".25"/>
    <path class="star" d="M52 10 C55 38 66 49 94 52 C66 55 55 66 52 94 C49 66 38 55 10 52 C38 49 49 38 52 10Z" fill="#39d0c0"/>
    <path class="star" style="animation-delay:-2s" d="M96 8 c1 8 4 11 12 12 -8 1 -11 4 -12 12 -1 -8 -4 -11 -12 -12 8 -1 11 -4 12 -12z" fill="#ffb347"/>
    <text x="112" y="80" font-size="60" font-weight="800" letter-spacing="3" fill="url(#swWt)" textLength="436" lengthAdjust="spacingAndGlyphs"
      style="font-family: ui-rounded, 'SF Pro Rounded', system-ui, sans-serif">STARWRIGHT</text>`;
  return node;
}

function brand() {
  return el('div', { class: 'sw-brand' }, (() => { const i = icon('star'); i.style.color = 'var(--sw-teal)'; return i; })(), 'STARWRIGHT',
    el('small', { text: 'Flight Center · Verda' }));
}

// ------------------------------------------------------------------ dialogs

const MODES = [
  { id: 'career', name: 'Career', icon: 'rep', color: 'var(--sw-amber)', blurb: 'Run the whole program. Earn funds and science, grow your reputation.',
    points: ['Rockets and crew cost funds', 'Research parts with science', 'Milestones pay rewards'] },
  { id: 'science', name: 'Science', icon: 'science', color: 'var(--sw-violet)', blurb: 'No budget to balance. Explore to earn science and unlock the tech tree.',
    points: ['Everything is free to launch', 'Research parts with science', 'Great for learning'] },
  { id: 'sandbox', name: 'Sandbox', icon: 'star', color: 'var(--sw-teal)', blurb: 'Every part unlocked, nothing to pay. Build whatever you can imagine.',
    points: ['All parts available', 'No funds, no research', 'Pure tinkering'] },
];

export async function openNewGame(app) {
  let mode = 'career';
  const cards = el('div', { class: 'sw-modes' });
  const draw = () => {
    clear(cards);
    for (const m of MODES) {
      const ico = icon(m.icon); ico.style.color = m.color;
      cards.appendChild(el('button', { class: 'sw-mode' + (mode === m.id ? ' active' : ''), attrs: { type: 'button', 'data-mode': m.id },
        on: { click: () => { mode = m.id; draw(); }, dblclick: () => dlg.close(m.id) } },
        ico, el('b', { text: m.name }), el('span', { text: m.blurb }), el('ul', null, m.points.map(p => el('li', { text: p })))));
    }
  };
  draw();
  const has = app.hasSave();
  const body = el('div', { class: 'sw-col', style: { gap: '14px' } }, cards,
    has ? el('div', { class: 'sw-msg warn', text: 'Starting a new game replaces your current saved game.' }) : null);
  const dlg = showModal({ title: 'New Game', body, wide: true, cancelValue: null,
    buttons: [{ label: 'Cancel', value: null }, { label: 'Start', value: 'start', kind: 'primary' }] });
  let res = await dlg;
  if (res === 'start') res = mode;
  if (!res) return false;
  if (has && !(await app.confirm('Replace saved game?', 'Your current saved game will be overwritten. This cannot be undone.', { okLabel: 'Start new game', danger: true }))) return false;
  await app.newGame(res);
  return true;
}

export const UI_SIZES = [['auto', 'Auto'], [0.8, '80%'], [0.9, '90%'], [1, '100%'], [1.1, '110%'], [1.25, '125%'], [1.5, '150%'], [1.75, '175%']];

/** Sound, graphics and game options as rows (used by the Settings dialog and the Administration building). */
export function settingsRows(app, h = settingsControls(app)) {
  const s = app.settings;
  const seg = (key, options) => {
    const wrap = el('div', { class: 'sw-seg', attrs: { role: 'group' } });
    const paint = () => { for (const b of wrap.children) b.classList.toggle('on', String(s[key]) === b.dataset.v); };
    for (const [val, label] of options) wrap.appendChild(el('button', { text: label, attrs: { type: 'button', 'data-setting': key, 'data-v': String(val) }, on: { click: () => { s[key] = val; paint(); app.applySettings(); } } }));
    paint();
    return wrap;
  };
  const row = (label, sub, ctl) => el('div', { class: 'sw-setting' }, el('div', null, el('b', { text: label }), el('small', { text: sub })), ctl);
  return el('div', { class: 'sw-settings' },
    el('h4', { text: 'Sound' }),
    h.slider('sfxVolume', 'Sound effects', 'Engines, staging, alarms and clicks', 'stage'),
    h.slider('musicVolume', 'Ambient music', 'The gentle pad that plays in the Flight Center'),
    el('h4', { text: 'Graphics' }),
    row('Detail', 'Particles, shadow size, anti-aliasing in flight', seg('gfxQuality', [['low', 'Low'], ['medium', 'Medium'], ['high', 'High']])),
    row('Vegetation', 'Trees, grass and ground detail at the space centre', seg('gfxVegetation', [['auto', 'Auto'], ['low', 'Low'], ['medium', 'Medium'], ['high', 'High'], ['ultra', 'Ultra']])),
    row('Automatic quality', 'Lowers resolution, then shadows, then effects when frames come slowly', seg('gfxAuto', [[false, 'Off'], [true, 'On']])),
    row('Shadows', 'The sun casts shadows on the vessel and the ground', seg('gfxShadows', [[false, 'Off'], [true, 'On']])),
    row('Ambient occlusion', 'Soft shade in creases and where things touch the ground (high detail only)', seg('gfxAO', [[false, 'Off'], [true, 'On']])),
    h.slider('gfxBloom', 'Bloom', 'Glow around flames, the sun and hot metal', null, 1.5),
    row('Lens effects', 'Sun flare, soft vignette, film grain', seg('gfxLens', [[false, 'Off'], [true, 'On']])),
    h.slider('gfxShake', 'Camera shake', 'From thrust, air and impacts', null, 1.5),
    el('h4', { text: 'Interface' }),
    (() => {
      // Interface size: one zoom for every panel, menu and read-out (js/ui/dom.js). The note says what is in effect.
      const now = el('small', { data: { role: 'ui-scale-now' } });
      const say = () => { const k = uiScale(), want = s.uiScale; now.textContent = 'Size of text, panels and buttons. Auto follows the window. Now ' + Math.round(k * 100) + ' %' + (Number(want) > k + 0.001 ? ' (the most this window has room for)' : '') + '.'; };
      const ctl = seg('uiScale', UI_SIZES);
      ctl.addEventListener('click', () => { say(); setTimeout(say, 0); });   // the button's own handler has applied the size by now
      say();
      return el('div', { class: 'sw-setting', data: { role: 'ui-scale' } }, el('div', null, el('b', { text: 'Interface size' }), now), ctl);
    })(),
    el('h4', { text: 'Game' }),
    h.toggle('invertPitch', 'Invert pitch', 'Swap W and S, for those who fly "pull back to climb" the other way'),
    h.toggle('showHints', 'Show hints', 'Friendly tips from the ground crew'),
    h.toggle('structFail', 'Structural failures', 'Overloaded joints break and the rocket comes apart. Off: loads are still shown, nothing breaks'),
    h.toggle('realHeat', 'Heating at physical strength', 'Off: re-entry heating is 20 times what physics gives on worlds this small, so that coming home needs a heat shield. On: the physical figure, under which little ever burns'));
}
function settingsControls(app) {
  const s = app.settings;
  const slider = (key, label, sub, preview, max = 1) => {
    const top = Math.round(max * 100), cur = Math.round((Number.isFinite(s[key]) ? s[key] : 0) * 100);
    const val = el('span', { class: 'sw-value', text: cur + '%' });
    const input = el('input', { class: 'sw-range', attrs: { type: 'range', min: 0, max: top, step: max > 1 ? 5 : 1, 'data-setting': key, 'aria-label': label }, value: cur });
    const sync = () => { input.style.setProperty('--fill', (Number(input.value) / top * 100) + '%'); val.textContent = input.value + '%'; };
    input.addEventListener('input', () => { s[key] = Number(input.value) / 100; sync(); app.applySettings(); });
    input.addEventListener('change', () => { if (preview) app.audio.play(preview); });
    sync();
    return el('div', { class: 'sw-setting' }, el('div', null, el('b', { text: label }), el('small', { text: sub })), el('div', { class: 'sw-row' }, input, val));
  };
  const toggle = (key, label, sub) => {
    const input = el('input', { attrs: { type: 'checkbox', 'data-setting': key }, checked: !!s[key] });
    input.addEventListener('change', () => { s[key] = input.checked; app.applySettings(); });
    return el('div', { class: 'sw-setting' }, el('div', null, el('b', { text: label }), el('small', { text: sub })),
      el('label', { class: 'sw-check' }, input, el('i')));
  };
  return { slider, toggle };
}

export function openSettings(app) {
  const { slider, toggle } = settingsControls(app);
  // ---- saved game: export / import a save file, rescue an unreadable one
  const Career = app.Career;
  const stamp = () => { const d = new Date(); const p = n => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; };
  const currentCareer = () => app.career || (Career && typeof Career.load === 'function' ? Career.load() : null);
  const hasGame = !!app.career || app.hasSave();
  const corrupt = Career && typeof Career.corruptBackup === 'function' ? Career.corruptBackup() : null;
  const canImport = app.currentName === 'title' || app.currentName === 'hub';      // never swap the program out from under a flight
  const doExport = () => {
    const c = currentCareer();
    if (!c || typeof c.exportSave !== 'function') { app.toast('There is no saved game to export.', 'warn'); return; }
    if (app.career) app.save(true);
    downloadText(`starwright-${c.mode}-${stamp()}.json`, c.exportSave());
    app.toast('Save file written to your downloads.', 'good');
  };
  const doImport = async () => {
    const file = await pickTextFile();
    if (!file) return;
    const res = Career && typeof Career.importSave === 'function' ? Career.importSave(file.text) : { ok: false, error: 'Importing is not available.' };
    if (!res.ok) { app.toast('Import failed: ' + res.error, 'bad', 7000); app.audio.play('alarm'); return; }
    const c = res.career;
    const p = fmt.dateParts(c.ut);
    const what = `${{ career: 'Career', science: 'Science', sandbox: 'Sandbox' }[c.mode] || c.mode} program, Year ${p.year}, Day ${p.day}`;
    // Say exactly which saved game the file replaces: a scenario lives in its own slot, apart from the player's program,
    // so "the game you have now" is not always the one that goes.
    const playingScenario = !!(app.career && app.career.scenario);
    if (c.scenario) {
      const slot = app.scenarios && app.scenarios.slot ? app.scenarios.slot() : null;
      const held = slot || (playingScenario ? app.career.scenario : null);
      if (held && !(await app.confirm('Replace the scenario in progress?', `"${file.name}" holds the scenario "${c.scenario.name}" (${what}). Loading it replaces the scenario in progress, "${held.name}". Your own program is not affected.`, { okLabel: 'Load the file', danger: true }))) return;
    } else {
      const ownSave = playingScenario ? app.hasSave() : hasGame;
      const note = playingScenario ? ' The scenario you are playing is not touched: it stays in its own slot.' : '';
      if (ownSave && !(await app.confirm(playingScenario ? 'Replace your own program?' : 'Replace your saved game?', `"${file.name}" holds a ${what}. Loading it replaces ${playingScenario ? 'your own saved program' : 'the game you have now'}. Export that one first if you want to keep it.${note}`, { okLabel: 'Load the file', danger: true }))) return;
      if (playingScenario) app.save(true);           // the scenario keeps its progress in its slot before the program takes over
    }
    app.career = c;
    c.settings = app.settings;
    app.world = null;
    app.save(true);
    app.toast('Loaded ' + (c.scenario ? 'the scenario "' + c.scenario.name + '"' : what) + (playingScenario && !c.scenario ? ' as your own program.' : '.'), 'good');
    dlg.close(true);
    if (c.scenario && app.scenarios && app.scenarios.resume) { app.career = null; await app.scenarios.resume(); }
    else app.goto('hub');
  };
  const tools = el('div', { class: 'sw-save-tools' },
    el('button', { class: 'sw-btn', disabled: !hasGame, attrs: { type: 'button', 'data-action': 'export-save' }, tip: hasGame ? 'Download your program as a .json file' : 'No saved game yet', on: { click: doExport } }, icon('download'), 'Export save'),
    el('button', { class: 'sw-btn', disabled: !canImport, attrs: { type: 'button', 'data-action': 'import-save' },
      tip: canImport ? 'Load a program from a .json save file' : 'Return to the Flight Center to load a save file', on: { click: doImport } }, icon('upload'), 'Import save'),
    corrupt ? el('button', { class: 'sw-btn', attrs: { type: 'button', 'data-action': 'export-rescue' }, tip: 'An earlier save could not be read. Download the raw data to keep or repair it.',
      on: { click: () => { downloadText(`starwright-unreadable-${stamp()}.txt`, corrupt, 'text/plain'); app.toast('Rescue copy written to your downloads.', 'info'); } } }, icon('save'), 'Rescue copy') : null);
  const body = settingsRows(app, { slider, toggle });
  body.appendChild(el('h4', { text: 'Saved game' }));
  body.appendChild(
    el('div', { class: 'sw-setting stack', data: { role: 'save-tools' } },
      el('div', null,
        el('small', { text: corrupt ? 'The game saves by itself in this browser. A save that could not be read was set aside: use Rescue copy to keep it.'
          : 'The game saves by itself in this browser. A save file is a backup you can keep, or carry to another computer.' })),
      tools));
  const dlg = showModal({ title: 'Settings', body, class: 'sw-settings-modal', buttons: [{ label: 'Done', value: true, kind: 'primary' }] });
  return dlg.then(v => { app.applySettings(); if (app.career) app.save(true); return v; });
}

export function openControls() {
  const grid = controlsGrid('sw-controls');
  const note = el('div', { class: 'sw-note' }, (() => { const i = icon('mouse'); i.style.color = 'var(--sw-teal)'; return i; })(),
    el('div', null,
      el('b', { text: 'Set up for a Mac keyboard and a Logitech MX mouse. ' }),
      'Scroll to zoom (the free-spinning wheel is smoothed), right-drag to orbit the camera, middle-drag to pan. ',
      'The thumb back/forward buttons are ignored so they cannot leave the game. ',
      'Flight keys can be remapped from the pause menu in flight. If the F-keys are media keys on your Mac, hold fn, or use Shift+K and Shift+L to quicksave and quickload.'));
  return showModal({ title: 'Controls', body: el('div', null, note, grid), wide: true, buttons: [{ label: 'Got it', value: true, kind: 'primary' }] });
}

// --- quick launch -------------------------------------------------------------------------

async function loadCraftModule() {
  try { return await import('../core/craft.js'); }
  catch (err) { console.warn('[hub] craft module unavailable:', err && err.message); return null; }
}

export async function openLaunchDialog(app, { site = 'pad' } = {}) {
  const career = app.career, runway = site === 'runway';
  const mod = await loadCraftModule();
  const entries = [];
  if (mod && mod.Craft) {
    const saved = Object.entries(career.crafts || {}).filter(([k]) => k !== '__autosave').map(([, v]) => v);
    for (const json of saved) {
      try { entries.push({ craft: mod.Craft.fromJSON(json), group: 'saved' }); }
      catch (err) { console.warn('[hub] could not read saved craft', json && json.name, err && err.message); }
    }
  }
  if (mod && typeof mod.stockCrafts === 'function') {
    try { for (const c of mod.stockCrafts()) entries.push({ craft: c, group: 'stock' }); }
    catch (err) { console.warn('[hub] stockCrafts() failed:', err && err.message); }
  }

  const describe = e => {
    if (e.info) return e.info;
    const c = e.craft, info = { parts: c.parts.length, cost: 0, mass: 0, dv: null, twr: null, stages: (c.stages || []).length, seats: 0, locked: [], errors: [], warnings: [] };
    try { info.cost = c.cost(); info.mass = c.mass(); } catch { /* keep zeros */ }
    try {
      const stats = c.stats();
      info.dv = stats.reduce((s, st) => s + (st.dvVac || 0), 0);
      const first = stats.find(st => st.thrust > 0);
      info.twr = first ? first.twr : null;
    } catch { /* stats unavailable */ }
    try { const v = c.validate(); info.errors = v.errors || []; info.warnings = v.warnings || []; } catch { /* ignore */ }
    // facility limits (career): the pad / runway bears so much, the hangar assembles so many parts
    try {
      const lim = typeof career.checkLaunch === 'function' ? career.checkLaunch(c, runway ? 'runway' : 'pad') : { ok: true };
      if (!lim.ok && lim.reason === 'mass') info.errors.push(`Too heavy for the ${runway ? 'runway' : 'pad'}: ${fmt.num(lim.value, 1)} t, and it bears ${fmt.num(lim.limit)} t. Upgrade it in Administration.`);
      if (!lim.ok && lim.reason === 'parts') info.errors.push(`Too many parts for the hangar: ${lim.value}, and it assembles ${lim.limit}. Upgrade it in Administration.`);
    } catch { /* no limits */ }
    const lockedNames = new Set(), lockedTech = new Set();
    for (const p of c.parts) {
      const d = PARTS[p.type];
      if (!d) continue;
      info.seats += d.crew || 0;
      if (!career.isPartUnlocked(p.type)) { lockedNames.add(d.name); const node = TECH_TREE.find(n => n.id === d.tech); if (node) lockedTech.add(node.name); }
    }
    info.locked = [...lockedNames]; info.lockedTech = [...lockedTech];
    return (e.info = info);
  };

  // A design is made for the pad or for the runway. Both dialogs list everything, but the ones made for this site come
  // first and the others say where they belong (a spaceplane on the pad stands on its tail; a rocket lies on the runway).
  const here = runway ? 'runway' : 'pad';
  const siteOf = e => (e.craft.site === 'runway' ? 'runway' : 'pad');
  entries.sort((x, y) => (siteOf(x) === here ? 0 : 1) - (siteOf(y) === here ? 0 : 1));       // stable: keeps the order inside each kind
  const fits = e => siteOf(e) === here && !describe(e).locked.length;
  let sel = entries.find(e => e.group === 'saved' && fits(e)) || entries.find(fits) || entries.find(e => e.group === 'saved' && !describe(e).locked.length) || entries.find(e => !describe(e).locked.length) || entries[0] || null;
  const listBox = el('div', { class: 'sw-list sw-scroll' });
  const infoBox = el('div', { class: 'sw-craft-info' });
  let launchBtn = null;

  function crewFor(info) {
    const avail = career.availableCrew ? career.availableCrew() : [];
    return avail.slice(0, info.seats).map(p => p.name);
  }

  function drawList() {
    clear(listBox);
    for (const [group, label] of [['saved', 'Your designs'], ['stock', 'Stock designs']]) {
      const items = entries.filter(e => e.group === group);
      listBox.appendChild(el('div', { class: 'sw-label sw-launch-group', text: label }));
      if (!items.length) {
        listBox.appendChild(el('div', { class: 'sw-dim', style: { padding: '4px 2px 8px', fontSize: '13px' },
          text: group === 'saved' ? `Nothing saved yet. Build something in the ${runway ? 'Spaceplane Hangar' : 'Vehicle Assembly Building'}.` : 'No stock designs available.' }));
        continue;
      }
      for (const e of items) {
        const info = describe(e);
        const blocked = info.locked.length > 0;
        listBox.appendChild(el('button', { class: 'sw-item' + (sel === e ? ' active' : ''), attrs: { type: 'button', 'data-craft': e.craft.name, 'data-group': group, 'data-site': siteOf(e) },
          on: { click: () => { sel = e; drawList(); drawInfo(); }, dblclick: () => { if (launchBtn && !launchBtn.disabled) launchBtn.click(); } } },
          (() => { const i = icon(blocked ? 'lock' : 'rocket'); i.style.cssText = 'width:20px;height:20px;flex:none;color:' + (blocked ? 'var(--sw-faint)' : 'var(--sw-teal)'); return i; })(),
          el('span', { class: 'sw-item-main' }, e.craft.name,
            el('span', { class: 'sw-item-sub', text: (siteOf(e) !== here ? (runway ? 'Pad design · ' : 'Runway design · ') : '') + `${info.parts} parts · ${fmt.mass(info.mass)}` + (info.seats ? ` · ${info.seats} ${info.seats === 1 ? 'seat' : 'seats'}` : ' · uncrewed') })),
          career.mode === 'career' ? el('span', { class: 'sw-item-side', text: fmt.funds(info.cost) }) : null));
      }
    }
  }

  function drawInfo() {
    clear(infoBox);
    if (!sel) {
      infoBox.appendChild(el('div', { class: 'sw-empty', text: mod ? 'No craft to launch yet. Build one first.' : 'The craft catalogue is not available yet.' }));
      if (launchBtn) launchBtn.disabled = true;
      return;
    }
    const info = describe(sel);
    const crew = crewFor(info);
    const afford = career.canAfford(info.cost);
    const kv = el('dl', { class: 'sw-kv' });
    const row = (k, v) => { kv.append(el('dt', { text: k }), el('dd', { text: v })); };
    row('Parts', String(info.parts));
    row(runway ? 'Mass on the runway' : 'Mass on the pad', fmt.mass(info.mass));
    row('Stages', String(info.stages));
    if (info.dv != null) row('Delta-v (vacuum)', fmt.num(info.dv) + ' m/s');
    if (info.twr != null) row('Liftoff thrust-to-weight', info.twr.toFixed(2));
    if (career.mode === 'career') row('Launch cost', fmt.funds(info.cost));

    const crewLine = el('div', { class: 'sw-crewline' });
    if (!info.seats) crewLine.appendChild(el('span', { class: 'sw-dim', text: 'Uncrewed — flies itself.' }));
    else {
      for (const name of crew) crewLine.appendChild(el('span', { class: 'sw-chip', data: { crew: name } }, pipPortrait(name, { cls: '' }), name));
      for (let i = crew.length; i < info.seats; i++) crewLine.appendChild(el('span', { class: 'sw-chip', text: 'Empty seat', style: { padding: '3px 10px' } }));
    }
    const msgs = [];
    if (info.locked.length) msgs.push(el('div', { class: 'sw-msg bad', text: 'Needs parts you have not researched: ' + info.locked.slice(0, 4).join(', ') + (info.locked.length > 4 ? ` and ${info.locked.length - 4} more` : '') + '.'
      + ((info.lockedTech || []).length ? ' Research ' + info.lockedTech.join(', ').replace(/, ([^,]*)$/, ' and $1') + ' first.' : '') }));
    for (const e of info.errors) msgs.push(el('div', { class: 'sw-msg bad', text: e }));
    if (!afford) msgs.push(el('div', { class: 'sw-msg bad', text: `Not enough funds — you have ${fmt.funds(career.funds)}.` }));
    if (info.seats && !crew.length) msgs.push(el('div', { class: 'sw-msg warn', text: 'No Pips are free to fly. The craft will launch empty.' }));
    if (siteOf(sel) !== here) msgs.push(el('div', { class: 'sw-msg warn', data: { role: 'wrong-site' }, text: runway ? 'This design is built for the launch pad. On the runway it lies on its side; launch it from the Launch Pad instead.' : 'This design is built for the runway. On the pad it stands on its tail; fly it from the Runway instead.' }));
    for (const w of info.warnings.slice(0, 2)) msgs.push(el('div', { class: 'sw-msg warn', text: w }));

    infoBox.append(
      el('div', { class: 'sw-row', style: { justifyContent: 'space-between' } }, el('div', { class: 'sw-title', text: sel.craft.name }),
        el('span', { class: 'sw-chip ' + (sel.group === 'stock' ? 'teal' : 'amber'), text: sel.group === 'stock' ? 'Stock' : 'Saved' })),
      kv, el('div', { class: 'sw-label', text: 'Crew' }), crewLine, ...msgs);
    const ok = !info.locked.length && !info.errors.length && afford;
    if (launchBtn) launchBtn.disabled = !ok;
    sel.crew = crew; sel.ok = ok;
  }

  const body = el('div', { class: 'sw-launch', data: { site: runway ? 'runway' : 'pad' } }, listBox, infoBox);
  if (runway) body.dataset.site = 'runway';
  const dlg = showModal({ title: runway ? 'Runway' : 'Launch Pad', body: runway ? el('div', { class: 'sw-col', style: { gap: '10px' } }, el('div', { class: 'sw-msg', data: { role: 'site-note' }, text: 'Craft roll out to the west end of the runway, pointing east. Wings and wheels recommended.' }), body) : body,
    wide: true, cancelValue: null, class: 'sw-launch-modal',
    buttons: [{ label: 'Cancel', value: null }, { label: runway ? 'Open the Plane Hangar' : 'Open the Assembly Building', value: 'builder' }, { label: runway ? 'Take off' : 'Launch', value: 'launch', kind: 'primary' }] });
  launchBtn = dlg.node.querySelector('.sw-btn.primary');
  launchBtn.setAttribute('data-action', 'launch');
  drawList(); drawInfo();
  const res = await dlg;
  if (res === 'builder') { app.goto('builder', runway ? { site: 'runway' } : {}); return false; }
  if (res !== 'launch' || !sel || !sel.ok) return false;
  return app.launch(sel.craft, { crew: sel.crew || [], site: runway ? 'runway' : 'pad' });
}

function openHubMenu(app) {
  const item = (ico, label, sub, action) => el('button', { class: 'sw-item', attrs: { type: 'button', 'data-menu': action },
    on: { click: () => dlg.close(action) } },
    (() => { const i = icon(ico); i.style.cssText = 'width:20px;height:20px;flex:none;color:var(--sw-teal)'; return i; })(),
    el('span', { class: 'sw-item-main' }, label, el('span', { class: 'sw-item-sub', text: sub })));
  const body = el('div', { class: 'sw-list' },
    item('gear', 'Settings', 'Sound, graphics, hints, export and import of your save', 'settings'),
    item('keyboard', 'Controls', 'Keyboard and mouse reference', 'controls'),
    item('save', 'Save game', 'The game also saves by itself as you go', 'save'),
    app.demo ? item('play', 'Demo tour', 'A self-running tour of the whole game; your program is not touched', 'demo') : null,   // demo tour hook
    item('exit', 'Main menu', 'Save and return to the title screen', 'title'));
  const dlg = showModal({ title: 'Flight Center', body, cancelValue: null, buttons: [{ label: 'Back', value: null }] });
  return dlg.then(async action => {
    if (action === 'settings') { await openSettings(app); return app.currentName === 'hub' && app.current ? openHubMenu(app) : null; }
    if (action === 'controls') { await openControls(); return openHubMenu(app); }
    if (action === 'save') { app.save(false); return null; }
    if (action === 'demo') { app.demo.start(); return null; }
    if (action === 'title') return app.exitToTitle();
    return null;
  });
}
// ------------------------------------------------------------------ hub screen

const HINTS = {
  career: ['Welcome to the Flight Center!', 'This is your space centre: drag to look around, hover a building to see what it does, click to go in. Start in the Vehicle Assembly Building with a capsule, a booster and a parachute. Science from your flights unlocks parts in the Research Lab, Mission Control has paid work, and the Flight School will teach you the rest.'],
  science: ['Welcome to the Flight Center!', 'Drag to look around and click a building to go in. Launches are free here: build a small rocket in the Vehicle Assembly Building, fly experiments to new places, then spend the science in the Research Lab.'],
  sandbox: ['Welcome to the Flight Center!', 'Drag to look around and click a building to go in. Everything is unlocked: fly a stock design from the Launch Pad, or head to the Vehicle Assembly Building and build something ambitious.'],
};

// The same welcome when the hub is a plain list (no WebGL): nothing to drag or hover there.
const HINTS_LIST = {
  career: ['Welcome to the Flight Center!', 'Each row below is a building: click one, or press its number, to go in. Start in the Vehicle Assembly Building with a capsule, a booster and a parachute. Science from your flights unlocks parts in the Research Lab, Mission Control has paid work, and the Flight School will teach you the rest.'],
  science: ['Welcome to the Flight Center!', 'Each row below is a building: click one, or press its number, to go in. Launches are free here: build a small rocket in the Vehicle Assembly Building, fly experiments to new places, then spend the science in the Research Lab.'],
  sandbox: ['Welcome to the Flight Center!', 'Each row below is a building: click one, or press its number, to go in. Everything is unlocked: fly a stock design from the Launch Pad, or head to the Vehicle Assembly Building and build something ambitious.'],
};

// Quick bar order = number keys 1…9, 0. `key` is the legacy destination name the e2e suites click (data-goto).
const DESTS = [
  { b: 'hangar', key: 'builder', label: 'Assembly', icon: 'hangar' },
  { b: 'pad', key: 'launch', label: 'Launch Pad', icon: 'rocket' },
  { b: 'runway', key: 'runway', label: 'Runway', icon: 'runway' },
  { b: 'spaceplane', key: 'spaceplane', label: 'Plane Hangar', icon: 'pilot' },
  { b: 'tracking', key: 'tracking', label: 'Tracking', icon: 'dish' },
  { b: 'research', key: 'research', label: 'Research', icon: 'lab' },
  { b: 'missions', key: 'missions', label: 'Missions', icon: 'board' },
  { b: 'crew', key: 'crew', label: 'Crew', icon: 'crew' },
  { b: 'school', key: 'guide', label: 'School', icon: 'school' },
  { b: 'admin', key: 'admin', label: 'Admin', icon: 'admin' },
];
const DEST_BY_BUILDING = Object.fromEntries(DESTS.map(d => [d.b, d]));
const INFO = Object.fromEntries(BASE_BUILDINGS.map(b => [b.id, b]));
const EXTRA_ICONS = {
  runway: '<path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M7.5 21 10 3h4l2.500 18M12 6v2.500M12 11.500v3M12 17.500v2.500"/>',
  school: '<path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M2.500 9 12 4.500 21.500 9 12 13.500zM6.500 11.500v4.500c2 2 9 2 11 0v-4.500M21.500 9v6"/>',
  admin: '<path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M5 21V6l7-3 7 3v15M3 21h18M9 9.500h.01M12 9.500h.01M15 9.500h.01M9 13.500h.01M12 13.500h.01M15 13.500h.01M10.500 21v-3.500h3V21"/>',
};
function hubIcon(name) {
  const node = icon(EXTRA_ICONS[name] ? 'star' : name);
  if (EXTRA_ICONS[name]) node.innerHTML = EXTRA_ICONS[name];
  return node;
}
const plural = (n, one, many = one + 's') => `${n} ${n === 1 ? one : many}`;

/** One-line status of a building for its name plate and quick-bar badge: { text, tone } (tone: '' | 'good' | 'amber' | 'teal'). */
function buildingStatus(app, id) {
  const c = app.career;
  if (!c) return { text: '', tone: '' };
  const flights = c.flightsInProgress ? c.flightsInProgress() : (c.flightState ? 1 : 0);
  switch (id) {
    case 'hangar': { const n = Object.keys(c.crafts || {}).filter(k => k !== '__autosave').length; return { text: n ? plural(n, 'saved design') : 'No saved designs yet', tone: '' }; }
    case 'pad': return c.flightState ? { text: 'Flight in progress', tone: 'amber' } : { text: 'Pad clear for launch', tone: 'good' };
    case 'runway': return c.flightState ? { text: 'Flight in progress', tone: 'amber' } : { text: 'Runway clear', tone: 'good' };
    case 'spaceplane': return { text: 'Rolls out to the runway', tone: '' };
    case 'tracking': return flights ? { text: plural(flights, 'vessel') + ' in flight', tone: 'amber' } : { text: 'No vessels in flight', tone: '' };
    case 'research': {
      if (c.mode === 'sandbox') return { text: 'All technology unlocked', tone: '' };
      const ready = TECH_TREE.filter(n => c.canUnlockTech(n.id).ok).length;
      return ready ? { text: plural(ready, 'node') + ' ready to research', tone: 'teal' } : { text: fmt.num(c.science, c.science % 1 ? 1 : 0) + ' science banked', tone: '' };
    }
    case 'missions': {
      const b = c.contracts;
      if (c.mode !== 'career' || !b) return { text: plural(c.milestones ? c.milestones.size : 0, 'milestone') + ' reached', tone: '' };
      if (c.grantOffer()) return { text: 'Grant waiting', tone: 'amber', badge: 'grant' };
      if (b.active.length) return { text: plural(b.active.length, 'active contract') + (b.offered.length ? `, ${b.offered.length} on offer` : ''), tone: 'amber', badge: 'active', short: b.active.length + ' active' };
      if (b.offered.length) return { text: plural(b.offered.length, 'contract') + ' on offer', tone: 'teal', badge: 'offers', short: b.offered.length + ' offers' };
      return { text: 'No contracts on offer', tone: '' };
    }
    case 'crew': { const free = c.availableCrew().length, all = c.activeRoster ? c.activeRoster().length : c.roster.length; return { text: `${plural(free, 'Pip')} ready` + (all - free ? `, ${all - free} away` : ''), tone: free ? '' : 'amber' }; }
    case 'school': return { text: 'Lessons and reference cards', tone: '' };
    case 'admin': {
      const up = c.usesFunds && c.facilityInfo ? ['pad', 'hangar', 'runway', 'tracking', 'lab', 'crew'].filter(f => { const i = c.facilityInfo(f); return i && i.cost !== null && c.canAfford(i.cost); }).length : 0;
      return up ? { text: plural(up, 'facility upgrade') + ' affordable', tone: 'teal' } : { text: 'Facilities, settings, saves', tone: '' };
    }
    default: return { text: '', tone: '' };
  }
}

export function createHubScreen(app) {
  if (app.screens && !app.screens.admin) app.screens.admin = createAdminScreen(app);     // the Administration building's interior
  let root = null, stats = null, dock = null, extras = null, pins = null, plate = null, compass = null, todChip = null;
  let menuOpen = false, hintDismissed = false, lastFlightState = undefined, lastBadges = '';
  let view = null, offs = [], pinNodes = {}, labels = true;
  let hoverId = null, dockId = null, kbdId = null, entering = null, enterTimer = 0, returnPose = null, pickDirty = false;
  let drag = null;                 // { button, x, y, moved, building }
  const _pt = {};

  const lit = () => entering || hoverId || dockId || kbdId;

  function openMenu() {
    if (menuOpen) return;
    menuOpen = true;
    openHubMenu(app).finally(() => { menuOpen = false; if (root) drawExtras(); });
  }

  /** What a building does when entered. */
  function perform(id) {
    switch (id) {
      case 'hangar': return app.goto('builder');
      case 'spaceplane': return app.goto('builder', { site: 'runway' });
      case 'pad': return openLaunchDialog(app, { site: 'pad' });
      case 'runway': return openLaunchDialog(app, { site: 'runway' });
      case 'tracking': return app.goto('tracking');
      case 'research': return app.goto('research');
      case 'missions': return app.goto('missions');
      case 'crew': return app.goto('crew');
      case 'school': return app.goto('guide');
      case 'admin': return app.goto('admin');
      default: return null;
    }
  }

  /** Enter a building: a short camera fly-in, then the screen change. A second click meanwhile (double-click) only looks. */
  function activate(id) {
    if (!root || entering || !INFO[id]) return;
    if (!view) { perform(id); return; }
    entering = id; hoverId = null;
    const p = view.goal;
    returnPose = { target: p.target.clone(), az: p.az, el: p.el, dist: p.dist };
    const b = view.byId[id];
    view.flyTo(id, { dist: Math.max(150, Math.min(b.radius * 2.1, 700)), speed: 6.5 });
    root.classList.add('entering');
    enterTimer = setTimeout(() => {
      enterTimer = 0;
      if (!root || entering !== id) return;
      entering = null; root.classList.remove('entering');
      perform(id);
    }, 480);
  }
  function cancelEntering() {
    if (enterTimer) clearTimeout(enterTimer);
    enterTimer = 0; entering = null;
    if (root) root.classList.remove('entering');
  }

  // Small status pills on the quick bar: contracts in Mission Control (or the program grant when funds run dry).
  function badgeKey() {
    const c = app.career, b = c.contracts;
    return [c.mode, c.flightState ? 1 : 0, b ? b.active.length : 0, b ? b.offered.length : 0, c.mode === 'career' && c.grantOffer() ? 1 : 0].join('/');
  }
  function drawBadges() {
    if (!dock) return;
    lastBadges = badgeKey();
    for (const n of dock.querySelectorAll('.badge')) n.remove();
    const st = buildingStatus(app, 'missions');
    const card = dock.querySelector('[data-goto="missions"]');
    if (card && st.badge) card.appendChild(el('span', { class: 'sw-chip badge ' + (st.tone || 'teal'), text: st.short || st.text, data: { badge: st.badge } }));
    const padCard = dock.querySelector('[data-goto="launch"]');
    if (padCard && app.career.flightState) padCard.appendChild(el('span', { class: 'sw-chip badge amber', text: 'In flight', data: { badge: 'flight' } }));
  }

  function drawExtras() {
    clear(extras);
    const c = app.career;
    lastFlightState = c.flightState ? 1 : 0;
    if (c.flightState) {
      extras.appendChild(el('div', { class: 'sw-resume', data: { role: 'resume' } },
        el('span', { class: 'dot' }),
        el('div', null, el('b', { text: 'Flight in progress' }), el('div', { class: 'sw-dim', style: { fontSize: '12px' }, text: 'Your vessels are waiting where you left them.' })),
        el('button', { class: 'sw-btn primary', attrs: { type: 'button', 'data-action': 'resume' }, on: { click: () => app.goto('flight', { resume: true }) } }, icon('play'), 'Resume')));
    }
    if (app.settings.showHints && !hintDismissed) {
      const [head, text] = (view ? HINTS : HINTS_LIST)[c.mode] || (view ? HINTS : HINTS_LIST).career;
      const box = el('div', { class: 'sw-hint', data: { role: 'hint' } }, pipFigure({ seed: 'Juno', wave: true }),
        el('div', { class: 'sw-grow' }, el('b', { text: head }), text),
        el('button', { class: 'sw-modal-x', text: '×', attrs: { type: 'button', 'aria-label': 'Dismiss hint' }, on: { click: () => { hintDismissed = true; box.remove(); } } }));
      extras.appendChild(box);
    }
  }

  function buildPins() {
    pinNodes = {};
    pins = el('div', { class: 'sw-hub-pins', attrs: { 'aria-hidden': 'true' } });
    for (const b of BASE_BUILDINGS) {
      const n = el('div', { class: 'sw-pin', data: { building: b.id } }, el('i'), el('span', { text: b.name }));
      pinNodes[b.id] = n; pins.appendChild(n);
    }
    plate = el('div', { class: 'sw-plate sw-hidden', attrs: { role: 'status', 'aria-live': 'polite' }, data: { role: 'plate' } });
    pins.appendChild(plate);
    return pins;
  }
  let plateId = null, plateKey = '';
  function drawPlate(id) {
    const st = id ? buildingStatus(app, id) : null, key = id ? id + '|' + st.text + '|' + st.tone + '|' + (entering ? 1 : 0) : '';
    if (key === plateKey) return;
    plateKey = key; plateId = id;
    clear(plate);
    plate.classList.toggle('sw-hidden', !id);
    if (!id) { delete plate.dataset.building; return; }
    const info = INFO[id], d = DEST_BY_BUILDING[id], num = (DESTS.indexOf(d) + 1) % 10;
    plate.dataset.building = id;
    plate.append(
      el('div', { class: 'head' }, hubIcon(d.icon), el('b', { text: info.name }), el('span', { class: 'sw-kbd', text: String(num) })),
      el('div', { class: 'blurb', text: info.blurb }),
      el('div', { class: 'status ' + (st.tone || ''), data: { role: 'status' } }, el('i'), st.text),
      el('div', { class: 'act', text: entering ? 'Entering…' : 'Click to enter  ·  double-click to look closer' }));
  }
  // A label's real width (measured once: the text never changes) and the room one label takes when stacked.
  const pinW = {}, PIN_H = 24;
  function pinWidth(id, n) {
    if (!pinW[id]) { const s = n.lastElementChild, w = s ? s.offsetWidth : 0; if (w > 0) pinW[id] = w; else return INFO[id].name.length * 8.6 + 22; }
    return pinW[id];
  }
  function placeOverlays() {
    const current = lit();
    drawPlate(view ? current : null);
    if (!view) return;
    const placed = [];
    const ks = uiScale();           // projected positions are viewport pixels; the pins and the plate live in the zoomed interface
    for (const b of view.buildings) {
      const n = pinNodes[b.id];
      _pt.v = _pt.v || b.focus.clone();
      _pt.v.set(b.focus.x, b.focus.y * 2 + 6, b.focus.z);
      const p = view.project(_pt.v, _pt);
      const show = labels && p.visible && b.id !== current && !entering;
      n.classList.toggle('off', !show);
      if (show) placed.push({ n, x: p.x / ks, y: p.y / ks, w: pinWidth(b.id, n) });
      if (b.id === current && plate) {
        if (!p.visible) view.project(_pt.v, p, true);          // the picture can trail the camera on a slow machine
        plate.classList.toggle('sw-hidden', !p.visible);
        const x = Math.max(150, Math.min(app.size.w / ks - 150, p.x / ks)), y = Math.max(196, Math.min(app.size.h / ks - 120, p.y / ks));
        plate.style.transform = `translate3d(${Math.round(x)}px, ${Math.round(y)}px, 0)`;
      }
    }
    // labels that would sit on top of each other are stacked upward, nearest building first
    placed.sort((a, b) => b.y - a.y);
    for (let i = 0; i < placed.length; i++) {
      const a = placed[i]; let lift = 0;
      for (let pass = 0; pass < 10; pass++) {
        let hit = false;
        for (let j = 0; j < i; j++) { const o = placed[j]; if (Math.abs(a.x - o.x) < (a.w + o.w) / 2 + 6 && Math.abs((a.y - lift) - (o.y - o.lift)) < PIN_H) { lift = a.y - (o.y - o.lift) + PIN_H; hit = true; } }
        if (!hit) break;
      }
      a.lift = lift;
      a.n.style.transform = `translate3d(${Math.round(a.x)}px, ${Math.round(a.y - lift)}px, 0)`;
      const stem = a.n.firstElementChild; if (stem && stem.tagName === 'I') stem.style.translate = lift ? `0 ${Math.round(lift)}px` : '';
    }
    if (compass) compass.style.transform = `rotate(${(view.pose.az * 180) / Math.PI}deg)`;
    if (todChip) {
      const t = view.sky.timeOfDay, label = t < 0.2 || t > 0.8 ? 'Night' : t < 0.3 ? 'Dawn' : t < 0.45 ? 'Morning' : t < 0.55 ? 'Midday' : t < 0.7 ? 'Afternoon' : 'Dusk';
      if (todChip.textContent !== label) todChip.textContent = label;
    }
  }

  function setCursor() {
    if (!app.canvas) return;
    app.canvas.style.cursor = drag && drag.moved ? 'grabbing' : (hoverId && !entering ? 'pointer' : '');
  }

  function bindInput() {
    const input = app.input, blocked = () => !root || !view || entering || isModalOpen();
    offs = [
      input.on('mousedown', e => {
        if (blocked()) return;
        drag = { button: e.button, x: e.x, y: e.y, moved: false, building: e.button === 0 ? view.pick(e.x, e.y) : null };
      }),
      input.on('mousemove', e => {
        if (!root || !view) return;
        if (drag && !entering) {
          if (!drag.moved && Math.hypot(e.x - drag.x, e.y - drag.y) > 4) { drag.moved = true; hoverId = null; }
          if (drag.moved) { if (drag.button === 1) view.pan(e.dx, e.dy); else view.orbit(e.dx, e.dy); }
        } else pickDirty = true;
        setCursor();
      }),
      input.on('mouseup', e => {
        const d = drag;
        if (!d || e.button !== d.button) return;
        drag = null; pickDirty = true;
        if (blocked() || d.moved || d.button !== 0 || e.released) { setCursor(); return; }
        const id = view.pick(e.x, e.y);
        if (id && id === d.building) activate(id);
        setCursor();
      }),
      input.on('dblclick', e => {
        if (!root || !view || isModalOpen()) return;
        const id = entering || view.pick(e.x, e.y);
        if (!id) return;
        cancelEntering();                                     // the second click turns "enter" into "look closer"
        view.flyTo(id, { dist: Math.max(170, view.byId[id].radius * 2.4) });
        kbdId = null; pickDirty = true;
      }),
      input.on('wheel', e => { if (!blocked()) view.zoom(e.zoom); }),
    ];
  }

  function stepSelection(dir) {
    const i = DESTS.findIndex(d => d.b === (kbdId || hoverId || dockId));
    const next = DESTS[((i < 0 ? (dir > 0 ? -1 : 0) : i) + dir + DESTS.length) % DESTS.length];
    kbdId = next.b; hoverId = null;
    view.flyTo(next.b);
  }

  function handleKeys(dt) {
    const input = app.input;
    if (input.pressed('Escape') && !menuOpen && !isModalOpen()) { if (entering) cancelEntering(); else if (kbdId) kbdId = null; else openMenu(); return; }
    if (entering || isModalOpen()) return;
    const typing = document.activeElement && /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName);
    if (typing || input.mods.meta || input.mods.ctrl) return;
    for (let i = 0; i < DESTS.length; i++) if (input.pressed('Digit' + ((i + 1) % 10))) { kbdId = DESTS[i].b; activate(DESTS[i].b); return; }
    if (!view) return;                                      // the list hub has no camera to steer
    const right = (input.down('KeyD') ? 1 : 0) - (input.down('KeyA') ? 1 : 0), fwd = (input.down('KeyW') ? 1 : 0) - (input.down('KeyS') ? 1 : 0);
    if (right || fwd) { view.move(right, fwd, dt); kbdId = null; }
    const turn = (input.down('KeyE') ? 1 : 0) - (input.down('KeyQ') ? 1 : 0);
    if (turn) view.turn(turn * dt * 1.1);
    const zoom = (input.down('KeyR') ? 1 : 0) - (input.down('KeyF') ? 1 : 0);
    if (zoom) view.zoom(Math.exp(zoom * dt * 1.4));
    if (input.pressed('ArrowRight') || input.pressed('ArrowDown')) stepSelection(1);
    if (input.pressed('ArrowLeft') || input.pressed('ArrowUp')) stepSelection(-1);
    if (input.pressed('KeyH') || input.pressed('Home')) { kbdId = null; view.home(); }
    if (input.pressed('KeyL')) { labels = !labels; root.classList.toggle('no-labels', !labels); }
    const onButton = document.activeElement && document.activeElement.closest && document.activeElement.closest('button, a, [role="button"]');
    if (kbdId && !onButton && (input.pressed('Enter') || input.pressed('NumpadEnter'))) activate(kbdId);
  }

  const screen = {
    is3D: true, capturesKeys: false,
    enter(params = {}) {
      if (params.fresh) hintDismissed = false;
      if (app.career.contracts && typeof app.career.contracts.refresh === 'function') {
        // a contract whose deadline passed while away is announced here (it used to move to History without a word)
        for (const n of app.career.contracts.refresh() || []) if (n && n.outcome === 'failed') app.toast(n.title + (n.funds ? '  ·  −' + fmt.funds(Math.abs(n.funds)) : '') + (n.rep ? '  −' + Math.abs(n.rep) + ' reputation' : ''), 'bad', 8000);
      }
      try { view = getBaseView(app); } catch (err) { console.error('[hub] the 3D Flight Center could not be built:', err); view = null; }
      hoverId = dockId = kbdId = entering = null; drag = null; plateKey = ''; labels = true;
      stats = statsBar(app, { date: true });
      const gear = el('button', { class: 'sw-btn icon', attrs: { type: 'button', 'data-action': 'menu', 'aria-label': 'Menu' }, tip: 'Menu (Esc)', on: { click: openMenu } }, icon('gear'));
      todChip = el('span', { class: 'sw-tod', data: { role: 'tod' }, tip: 'Time of day at the Flight Center' });
      dock = el('div', { class: 'sw-dock', attrs: { role: 'toolbar', 'aria-label': 'Buildings' } }, DESTS.map((d, i) => {
        const info = INFO[d.b];
        return el('button', { class: 'sw-card' + (d.b === 'pad' ? ' accent' : ''), attrs: { type: 'button', 'data-goto': d.key, 'data-building': d.b, 'aria-label': info.name + '. ' + info.blurb, 'aria-keyshortcuts': String((i + 1) % 10) },
          on: {
            click: () => activate(d.b),
            mouseenter: () => { dockId = d.b; }, mouseleave: () => { if (dockId === d.b) dockId = null; },
            focus: () => { if (!entering && document.activeElement && document.activeElement.matches(':focus-visible')) { kbdId = d.b; if (view) view.flyTo(d.b); } }, blur: () => { if (kbdId === d.b) kbdId = null; },
          } },
          hubIcon(d.icon), el('b', { text: d.label }), el('kbd', { text: String((i + 1) % 10) }), view ? null : el('span', { text: info.blurb }));
      }));
      drawBadges();
      extras = el('div', { class: 'sw-hub-extras' });
      compass = view ? el('div', { class: 'rose' }, el('i', { text: 'N' })) : null;
      const help = view ? el('div', { class: 'sw-hub-help', data: { role: 'view-help' } },
        el('div', { class: 'sw-compass', tip: 'North. Press H to reset the view.' }, compass),
        el('div', { class: 'keys' },
          el('span', null, el('span', { class: 'sw-kbd', text: 'Drag' }), 'look around'), el('span', null, el('span', { class: 'sw-kbd', text: 'Scroll' }), 'zoom'),
          el('span', null, el('span', { class: 'sw-kbd', text: 'Middle-drag' }), 'or', el('span', { class: 'sw-kbd', text: 'W A S D' }), 'move'),
          el('span', null, el('span', { class: 'sw-kbd', text: '← →' }), 'pick'), el('span', null, el('span', { class: 'sw-kbd', text: 'H' }), 'reset'))) : null;
      root = el('div', { class: 'sw-screen sw-hub' + (view ? '' : ' no3d'), data: { screen: 'hub' } },
        el('div', { class: 'sw-topbar sw-hubbar' }, brand(), view ? todChip : null, stats.node, gear),
        view ? buildPins() : el('div', { class: 'sw-hub-fallback', data: { role: 'fallback' } },
          el('div', { class: 'sw-title big', text: 'Flight Center' }),
          el('div', { class: 'sw-dim', text: '3D graphics are not available in this browser, so the space centre is shown as a list. Everything still works.' })),
        extras, help, dock);
      app.uiRoot.appendChild(root);
      drawExtras();
      if (view) {
        bindInput(); view.begin();
        view.setTimeOfDay(null); view.setTime(app.career.ut || 0);
        // a craft is ready when a design is saved and nothing is flying: the show rocket rolls out to the pad
        const ready = !app.career.flightState && Object.keys(app.career.crafts || {}).some(k => k !== '__autosave');
        if (!ready) view.base.setDisplay('none'); else if (view.base.display === 'none') view.base.setDisplay('rollout');
        if (params.fresh || !returnPose) view.home(!returnPose && !params.fromTitle);
        else view.flyTo(returnPose, { speed: 3.2 });
        returnPose = null;
        view.update(0, { drift: false });
      }
    },
    exit() {
      cancelEntering();
      for (const off of offs) off();
      offs = [];
      if (view) view.release();
      if (app.canvas) app.canvas.style.cursor = '';
      if (root) root.remove();
      root = stats = dock = extras = pins = plate = compass = todChip = null; pinNodes = {}; drag = null;
    },
    update(dt) {
      if (!root) return;
      stats.refresh();
      if ((app.career.flightState ? 1 : 0) !== lastFlightState) drawExtras();
      if (badgeKey() !== lastBadges) drawBadges();
      handleKeys(dt);
      if (!root || !view) return;
      if (pickDirty && !drag && !entering) {
        pickDirty = false;
        const id = app.input.mouse.over && !isModalOpen() ? view.pick(app.input.mouse.x, app.input.mouse.y) : null;
        if (id !== hoverId) { hoverId = id; if (id) kbdId = null; setCursor(); }
      }
      if (!app.input.mouse.over && hoverId && !drag) { hoverId = null; setCursor(); }
      view.setTime(app.career.ut || 0);
      view.update(dt, { drift: !lit() && !drag && !isModalOpen() });
      placeOverlays();
      const cur = lit();
      view.base.setDoor('hangar', cur === 'hangar' ? 1 : 0); view.base.setDoor('spaceplane', cur === 'spaceplane' ? 1 : 0);
      for (const n of dock.children) n.classList.toggle('lit', n.dataset.building === cur);
    },
    render() {
      if (view) view.render(lit());
      else if (app.renderer) app.renderer.clear();
    },
    resize(w, h) { if (view) view.resize(w, h); },
    // test hooks
    debug: {
      get view() { return view; },
      hovered: () => hoverId,
      lit: () => lit(),
      entering: () => entering,
      screenPos(id) { if (!view || !view.byId[id]) return null; const b = view.byId[id], p = view.project(b.focus, {}, true); return { x: p.x, y: p.y, visible: p.visible }; },
      status: id => buildingStatus(app, id),
    },
  };
  return screen;
}

// ------------------------------------------------------------------ title screen

/**
 * The title menu's Missions entry. A career save is loaded and opens in Mission Control. Otherwise a short panel
 * says what missions are and offers a new career (which lands in Mission Control with the flight program's first
 * mission lit up); a science or sandbox save can also be opened there, since the flight program is tracked in every mode.
 */
export async function openTitleMissions(app) {
  let saved = null;
  try { saved = app.hasSave() ? app.Career.load() : null; } catch { saved = null; }
  if (saved && saved.mode === 'career') return app.continueGame({ to: 'missions', params: { tab: 'contracts', spotlight: 'program' } });
  const steps = app.careerModule && app.careerModule.PROGRAM ? app.careerModule.PROGRAM : [];
  const modeName = saved ? ({ science: 'Science', sandbox: 'Sandbox' }[saved.mode] || saved.mode) : '';
  const point = (ico, head, text) => el('div', { class: 'sw-row', style: { gap: '10px', alignItems: 'flex-start' } },
    (() => { const i = icon(ico); i.style.cssText = 'width:20px;height:20px;flex:none;margin-top:2px;color:var(--sw-teal)'; return i; })(),
    el('div', null, el('b', { text: head }), el('div', { class: 'sw-dim', style: { fontSize: '13px', lineHeight: '1.45' }, text })));
  const body = el('div', { class: 'sw-col', style: { gap: '12px', maxWidth: '520px' }, data: { role: 'missions-intro' } },
    point('rocket', 'The flight program', `${steps.length || 'A chain of'} missions in a fixed order, from the first launch to space, orbit, the moons Pell and Ost and on to every world of the Helion system. There is always a next one; nothing to sign and no deadline.`),
    point('contract', 'Contracts', 'Paid jobs posted in Mission Control: carry a Pip to an altitude, test a part, deliver a science result, hold an orbit, plant a flag. An advance on signing, the rest on completion, a deadline to keep. Career mode only.'),
    point('target', 'In flight', 'The Missions button on the flight screen (or the O key) lists the next mission and your contracts with live progress.'),
    saved ? el('div', { class: 'sw-msg warn', data: { role: 'missions-saved' }, text: `Your saved game is a ${modeName} program: it follows the flight program but has no contracts. Starting a career replaces it.` }) : null);
  const buttons = [{ label: 'Close', value: null }];
  if (saved) buttons.push({ label: "Open Mission Control", value: "open" });
  buttons.push({ label: 'Start a career', value: 'career', kind: 'primary' });
  const dlg = showModal({ title: 'Missions', body, cancelValue: null, class: 'sw-missions-intro', buttons });
  for (const b of dlg.node.querySelectorAll('.sw-btn')) { if (/Start a career/.test(b.textContent)) b.setAttribute('data-action', 'start-career'); else if (/Open Mission Control/.test(b.textContent)) b.setAttribute('data-action', 'open-missions'); }
  const res = await dlg;
  if (res === 'open') return app.continueGame({ to: 'missions', params: { tab: 'milestones', spotlight: 'program' } });
  if (res !== 'career') return false;
  if (saved && !(await app.confirm('Replace saved game?', 'Your current saved game will be overwritten. This cannot be undone.', { okLabel: 'Start a career', danger: true }))) return false;
  return app.newGame('career', { to: 'missions', params: { tab: 'contracts', spotlight: 'program' } });
}

export function createTitleScreen(app) {
  let root = null, menu = null, view = null, t = 0, buildTimer = 0;

  function saveSummary() {
    try {
      const c = app.Career.load();
      if (!c) return '';
      const mode = { career: 'Career', science: 'Science', sandbox: 'Sandbox' }[c.mode] || c.mode;
      const p = fmt.dateParts(c.ut);
      return `${mode} · Year ${p.year}, Day ${p.day}`;
    } catch { return ''; }
  }

  /** "Next: Light the Fuse" for the saved program (shown under the Missions entry). */
  function savedMissionLine() {
    try { const c = app.Career.load(); const n = c && c.nextProgramStep ? c.nextProgramStep() : null; return n ? 'next: ' + n.title : 'the flight program'; } catch { return ''; }
  }

  /**
   * The menu, in four groups under small headings: Play (the saved game, a new one, missions, scenarios), Learn and
   * tour (Flight School, the science reference, the demo tour), Options (settings, controls) and About (the story,
   * What's New). The last two groups are rows of two, which keeps the whole menu on a 720-pixel-high window.
   */
  function drawMenu() {
    const hadFocus = menu.contains(document.activeElement) ? document.activeElement.dataset.action : null;
    clear(menu);
    const has = app.hasSave();
    const btn = (action, ico, label, cls, handler, small, tip) => el('button', { class: 'sw-btn ' + (cls || ''), tip: tip || null, attrs: { type: 'button', 'data-action': action }, on: { click: handler } },
      icon(ico), el('span', { class: 'lbl', text: label }), small ? el('small', { text: small }) : null);
    const group = (id, title, ...rows) => {
      rows = rows.filter(Boolean);
      if (!rows.length) return;
      menu.appendChild(el('div', { class: 'sw-menu-group', attrs: { role: 'group', 'aria-label': title }, data: { group: id } }, el('div', { class: 'sw-menu-head', text: title }), ...rows));
    };
    const pair = (...btns) => { btns = btns.filter(Boolean); return btns.length ? el('div', { class: 'sw-menu-row' }, ...btns) : null; };
    const redraw = () => { if (root) drawMenu(); };

    const del = has ? el('button', { class: 'sw-btn ghost sw-menu-del', tip: 'Delete saved game', attrs: { type: 'button', 'data-action': 'delete', 'aria-label': 'Delete saved game' }, on: { click: async () => {
      if (await app.confirm('Delete saved game?', 'Your program, crew, designs and flights in progress will be erased. This cannot be undone.', { okLabel: 'Delete', danger: true })) {
        app.deleteSave();
        app.toast('Saved game deleted.', 'warn');
        redraw();
      }
    } } }, icon('trash')) : null;
    group('play', 'Play',
      has ? el('div', { class: 'sw-menu-row lead' }, btn('continue', 'play', 'Continue', 'primary', () => app.continueGame(), saveSummary()), del) : null,
      btn('new', 'plus', 'New Game', has ? '' : 'primary', () => openNewGame(app)),
      btn('missions', 'rocket', 'Missions', '', () => openTitleMissions(app), has ? savedMissionLine() : 'flight program, contracts'),
      app.scenarios ? btn('scenarios', 'board', 'Scenarios', '', () => app.scenarios.open().then(redraw), app.scenarios.note()) : null);   // ready-made flights (js/ui/scenarios.js)
    group('learn', 'Learn and tour',
      btn('guide', 'pilot', 'Flight School', '', () => app.goto('guide'), 'short lessons'),
      app.science ? btn('science', 'science', 'Science', '', () => app.science.open(), 'the mathematics of flight') : null,   // the reference (js/ui/science.js)
      app.demo ? btn('demo', 'tour', 'Demo tour', '', () => app.demo.start(), 'self-running') : null);   // demo tour hook (js/ui/demo.js)
    group('options', 'Options', pair(
      btn('settings', 'gear', 'Settings', '', () => openSettings(app).then(redraw)),
      btn('controls', 'keyboard', 'Controls', '', () => openControls())));
    group('about', 'About', pair(
      app.about ? btn('about', 'info', 'About', '', () => app.about.open(), null, 'The story behind the game') : null,   // js/ui/about.js
      app.whatsNew && app.whatsNew.latest ? btn('whatsnew', 'star', "What's New", '', () => app.whatsNew.open(), null, 'Latest: ' + app.whatsNew.note()) : null));   // js/ui/whatsnew.js
    if (hadFocus) { const again = menu.querySelector(`[data-action="${hadFocus}"]`); if (again) again.focus(); }
  }

  /** Arrow keys walk the menu (Up and Down by row, Left and Right inside a row of two); Home and End jump to the ends. */
  function onMenuKey(e) {
    if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key) || e.metaKey || e.ctrlKey || e.altKey) return;
    const all = [...menu.querySelectorAll('.sw-btn')];
    if (!all.length) return;
    const at = all.indexOf(document.activeElement);
    let next = null;
    if (e.key === 'Home') next = all[0];
    else if (e.key === 'End') next = all[all.length - 1];
    else if (at < 0) next = all[0];
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      const row = all[at].closest('.sw-menu-row');
      const mates = row ? [...row.querySelectorAll('.sw-btn')] : [];
      next = mates[mates.indexOf(all[at]) + (e.key === 'ArrowRight' ? 1 : -1)] || null;
    } else {
      // the nearest entry in the next row up or down, keeping to the same side of a row of two
      const rowOf = b => b.closest('.sw-menu-row') || b;
      const rows = [...new Set(all.map(rowOf))];
      const target = rows[rows.indexOf(rowOf(all[at])) + (e.key === 'ArrowDown' ? 1 : -1)];
      if (target) {
        const cands = target.matches('.sw-btn') ? [target] : [...target.querySelectorAll('.sw-btn')];
        const x = all[at].getBoundingClientRect().left;
        next = cands.reduce((best, c) => (Math.abs(c.getBoundingClientRect().left - x) < Math.abs(best.getBoundingClientRect().left - x) ? c : best), cands[0]);
      }
    }
    e.preventDefault(); e.stopPropagation();
    if (next) next.focus();
  }

  return {
    is3D: true, capturesKeys: false,
    enter() {
      view = null;
      menu = el('div', { class: 'sw-menu sw-interactive', attrs: { role: 'navigation', 'aria-label': 'Main menu' }, on: { keydown: onMenuKey } });
      root = el('div', { class: 'sw-screen sw-title-screen' + (app.renderer ? ' live' : ''), data: { screen: 'title' } },
        el('div', { class: 'sw-title-shade' }),
        el('div', { class: 'sw-title-wrap' }, wordmark(),
          el('div', { class: 'sw-tagline', text: 'Build it. Launch it. Bring the Pips home.' }), menu),
        el('div', { class: 'sw-title-foot', text: 'Starwright Flight Center · Verda' }));
      app.uiRoot.appendChild(root);
      drawMenu();
      // The menu is up at once; the Flight Center behind it is built a moment later (it takes a few hundred ms).
      const mine = root;
      buildTimer = setTimeout(() => {
        buildTimer = 0;
        if (root !== mine || !app.renderer) return;
        try { view = getBaseView(app); } catch (err) { console.error('[title] the 3D Flight Center could not be built:', err); view = null; root.classList.remove('live'); return; }
        // a slow orbit of the pad in the first light of morning
        t = 0; view.begin();
        view.base.setDisplay('pad'); view.base.setDoor('hangar', 0); view.base.setDoor('spaceplane', 0);
        view.setTimeOfDay(0.3);
        view.flyTo({ target: view.byId.pad.focus.clone().setY(28), az: 3.75, el: 0.105, dist: 520 }, { snap: true });
        view.update(0, { drift: false });
        root.classList.add('ready');
      }, 60);
    },
    exit() { if (buildTimer) clearTimeout(buildTimer); buildTimer = 0; if (root) root.remove(); root = menu = null; if (view) { view.setTimeOfDay(null); view.release(); view = null; } },
    update(dt) {
      if (!view) return;
      t += dt;
      view.turn(dt * 0.014);
      view.update(dt, { drift: false });
    },
    render() { if (view) view.render(null); else if (app.renderer) app.renderer.clear(); },
    resize(w, h) { if (view) view.resize(w, h); },
  };
}
