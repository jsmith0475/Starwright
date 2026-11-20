// Starwright — Scenarios: the picker on the title menu, starting / resuming a scenario game, the brief shown on
// arrival and the small objectives panel that stays up while a scenario is played.
//   openScenarios(app)                 the picker dialog (a card per scenario); resolves when it closes
//   startScenario(app, id, opts)       build the scenario (js/core/scenarios.js), make it the game, go there
//   resumeScenario(app)                continue the scenario in the scenario save slot
//   installScenarios(app)              adds app.scenarios = { open, start, resume, status(), slot(), panel }
//   scenarioMenuNote()                 the small text for the title menu button ('' or 'in progress')
//
// A scenario game is an ordinary sandbox Career with `career.scenario` set; it saves to its own slot, so the
// player's program is never touched. Test hooks: [data-scenario="<id>"] cards with [data-action="start"] /
// [data-action="resume"] buttons, .sw-scn-brief (the brief), .sw-scn-panel (objectives), app.scenarios.
import { el, clear, showModal, isModalOpen } from './dom.js';
import { SCENARIOS, scenarioDef, buildScenario, scenarioStatus, checkScenario, loadScenarioGame, deleteScenarioGame, scenarioSlotInfo, SCENARIO_QUICK_KEY } from '../core/scenarios.js';

const CSS = `
.sw-modal.sw-scn-modal { width: min(1040px, 100%); }
.sw-scn-intro { margin: 0 0 12px; font-size: 13px; color: var(--sw-dim); line-height: 1.5; }
.sw-scn-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 10px; }
.sw-scn-card { position: relative; display: flex; flex-direction: column; gap: 6px; padding: 12px 12px 10px; border: 1px solid var(--sw-line);
  border-radius: var(--sw-radius); background: linear-gradient(180deg, rgba(29, 38, 49, 0.96), rgba(20, 26, 34, 0.96)); text-align: left; }
.sw-scn-card::before { content: ''; position: absolute; left: 0; top: 10px; bottom: 10px; width: 3px; border-radius: 2px; background: var(--scn-tone, var(--sw-teal)); }
.sw-scn-card:hover, .sw-scn-card:focus-within { border-color: var(--scn-tone, var(--sw-teal)); background: linear-gradient(180deg, rgba(36, 47, 60, 0.98), rgba(24, 31, 40, 0.98)); }
.sw-scn-card.current { border-color: var(--sw-amber); }
.sw-scn-top { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
.sw-scn-top b { font-size: 16px; color: var(--sw-text); letter-spacing: 0.01em; }
.sw-scn-meta { display: flex; flex-wrap: wrap; gap: 5px; align-items: center; font-size: 10px; letter-spacing: 0.1em; text-transform: uppercase; color: var(--sw-dim); }
.sw-scn-meta .world { color: var(--scn-tone, var(--sw-teal)); font-weight: 700; }
.sw-scn-meta i { font-style: normal; opacity: 0.5; }
.sw-scn-diff { flex: none; font-size: 9px; letter-spacing: 0.12em; text-transform: uppercase; font-weight: 700; padding: 2px 7px; border-radius: 999px; border: 1px solid currentColor; }
.sw-scn-diff.easy { color: var(--sw-green); } .sw-scn-diff.medium { color: var(--sw-amber); } .sw-scn-diff.hard { color: var(--sw-red); }
.sw-scn-goal { margin: 0; font-size: 13px; line-height: 1.4; color: #cbd6e0; flex: 1; }
.sw-scn-foot { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-top: 2px; }
.sw-scn-foot small { font-size: 11px; color: var(--sw-amber); }
.sw-scn-foot .sw-btn { height: 30px; padding: 0 16px; font-size: 13px; }
.sw-scn-foot .btns { display: flex; gap: 6px; margin-left: auto; }

.sw-scn-panel { position: fixed; left: 50%; top: 54px; transform: translateX(-50%); z-index: 40; width: min(380px, calc(100vw - 24px)); pointer-events: auto;
  background: rgba(20, 26, 34, 0.9); border: 1px solid var(--sw-line); border-radius: var(--sw-radius); box-shadow: var(--sw-shadow-sm);
  font-family: var(--sw-font); color: var(--sw-text); backdrop-filter: blur(6px); }
.sw-scn-panel[hidden] { display: none; }
/* while the brief is up, the assembly building's own first-visit help waits its turn underneath */
body.sw-scn-briefing .bld-hint { visibility: hidden; }
body[data-screen="flight"] .sw-scn-panel { left: 8px; right: auto; top: 130px; transform: none; width: min(280px, calc(100vw - 24px)); }
body[data-screen="builder"] .sw-scn-panel { left: auto; right: 12px; top: auto; bottom: 64px; transform: none; width: min(300px, calc(100vw - 24px)); }
.sw-scn-panel.brief { left: 50%; right: auto; top: 50%; bottom: auto; transform: translate(-50%, -50%); width: min(480px, calc(100vw - 24px)); box-shadow: var(--sw-shadow); border-color: var(--sw-teal); background: rgba(20, 26, 34, 0.96); }
body[data-screen="flight"] .sw-scn-panel.brief, body[data-screen="builder"] .sw-scn-panel.brief { left: 50%; right: auto; top: 50%; bottom: auto; transform: translate(-50%, -50%); width: min(480px, calc(100vw - 24px)); }
.sw-scn-head { display: flex; align-items: center; gap: 8px; padding: 7px 10px; cursor: pointer; user-select: none; }
.sw-scn-head .tag { font-size: 9px; letter-spacing: 0.16em; text-transform: uppercase; color: var(--sw-teal); font-weight: 700; }
.sw-scn-head b { font-size: 13px; flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.sw-scn-head .count { font-size: 11px; color: var(--sw-dim); font-family: var(--sw-mono); }
.sw-scn-head .fold { width: 22px; height: 22px; border: 0; border-radius: 4px; background: transparent; color: var(--sw-dim); font-size: 14px; cursor: pointer; }
.sw-scn-head .fold:hover { background: var(--sw-line-soft); color: var(--sw-text); }
.sw-scn-body { padding: 0 10px 9px; }
.sw-scn-panel.folded .sw-scn-body { display: none; }
.sw-scn-panel.brief .sw-scn-head { padding: 12px 14px 4px; cursor: default; }
.sw-scn-panel.brief .sw-scn-head b { font-size: 19px; white-space: normal; }
.sw-scn-panel.brief .sw-scn-head .fold, .sw-scn-panel.brief .sw-scn-head .count { display: none; }
.sw-scn-panel.brief .sw-scn-body { padding: 0 14px 12px; }
.sw-scn-where { font-size: 10px; letter-spacing: 0.1em; text-transform: uppercase; color: var(--sw-dim); margin: 0 0 8px; }
.sw-scn-text { margin: 0 0 8px; font-size: 13px; line-height: 1.5; color: #cbd6e0; }
.sw-scn-goalline { margin: 0 0 8px; font-size: 13px; line-height: 1.45; color: var(--sw-text); font-weight: 600; }
.sw-scn-panel:not(.brief) .sw-scn-where, .sw-scn-panel:not(.brief) .sw-scn-text, .sw-scn-panel:not(.brief) .sw-scn-tips, .sw-scn-panel:not(.brief) .sw-scn-go { display: none; }
.sw-scn-panel:not(.brief) .sw-scn-goalline { font-size: 12px; font-weight: 500; color: #cbd6e0; margin-bottom: 6px; }
.sw-scn-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 3px; }
.sw-scn-list li { display: flex; gap: 7px; align-items: baseline; font-size: 12px; line-height: 1.35; color: var(--sw-dim); }
.sw-scn-list li::before { content: ''; flex: none; width: 9px; height: 9px; border-radius: 50%; border: 1.5px solid var(--sw-faint); transform: translateY(1px); }
.sw-scn-list li.next { color: var(--sw-text); }
.sw-scn-list li.next::before { border-color: var(--sw-amber); box-shadow: 0 0 0 2px rgba(255, 179, 71, 0.18); }
.sw-scn-list li.done { color: var(--sw-green); }
.sw-scn-list li.done::before { border-color: var(--sw-green); background: var(--sw-green); }
.sw-scn-tips { margin: 10px 0 0; padding: 8px 10px 8px 24px; font-size: 12px; line-height: 1.5; color: #b3c0cd; background: rgba(255, 255, 255, 0.03); border-radius: 4px; }
.sw-scn-go { display: flex; justify-content: flex-end; align-items: center; gap: 10px; margin-top: 12px; }
.sw-scn-go small { font-size: 11px; color: var(--sw-faint); margin-right: auto; }
.sw-scn-done { margin: 8px 0 0; font-size: 12px; color: var(--sw-green); font-weight: 600; }

`;
const TONE = { verda: '#39d0c0', pell: '#aab6c4', ost: '#c9b79a', rusk: '#e39a5b', tiv: '#b79cff', thal: '#e8c27a' };
const SHOW_ON = new Set(['flight', 'builder', 'hub', 'tracking']);

function ensureCss() {
  if (document.getElementById('sw-scn-css')) return;
  const st = document.createElement('style');
  st.id = 'sw-scn-css'; st.textContent = CSS;
  document.head.appendChild(st);
}

/** The small text on the title menu's Scenarios button. */
export function scenarioMenuNote() {
  const s = scenarioSlotInfo();
  return s ? (s.complete ? 'completed: ' : 'in progress: ') + s.name : SCENARIOS.length + ' ready-made flights';
}

// ------------------------------------------------------------------ starting and resuming

function adopt(app, career) {
  app.career = career;
  career.settings = app.settings;
  app.world = null;
  app.save(true);
}

/**
 * Start a scenario from scratch. The game being played (if any) is saved first; the player's own program lives in
 * a different save slot and is not touched. If another scenario game is in the scenario slot it is replaced, after
 * asking (unless `force`). → true when the scenario was started.
 */
export async function startScenario(app, id, { force = false } = {}) {
  const def = scenarioDef(id);
  if (!def) { app.toast('That scenario does not exist.', 'bad'); return false; }
  const slot = scenarioSlotInfo();
  if (slot && !force) {
    const same = slot.id === id;
    const ok = await app.confirm(same ? 'Restart this scenario?' : 'Replace the scenario in progress?',
      (same ? `Your progress in "${slot.name}" (${slot.done} of ${slot.total} objectives) will be lost.`
        : `You have "${slot.name}" in progress (${slot.done} of ${slot.total} objectives). Starting "${def.name}" replaces it.`)
      + '\nYour own saved game is kept separately and is not affected.',
      { okLabel: same ? 'Restart' : 'Start ' + def.name, danger: true });
    if (!ok) return false;
  }
  let game;
  try { game = buildScenario(id); }
  catch (err) { console.error('[scenarios] could not build "' + id + '":', err); app.toast('That scenario could not be set up (see console).', 'bad'); return false; }
  if (app.career && app.currentName !== 'title') app.save(true);
  deleteScenarioGame();
  adopt(app, game.career);
  briefPending = id;
  await app.goto(game.start.screen, game.start.params);
  return app.career === game.career;
}

/** Continue the scenario in the scenario slot where it was left. → true when there was one. */
export async function resumeScenario(app) {
  const career = loadScenarioGame();
  if (!career) { app.toast('There is no scenario in progress.', 'warn'); return false; }
  if (app.career && app.currentName !== 'title') app.save(true);
  adopt(app, career);
  const def = scenarioDef(career.scenario.id);
  if (career.flightState) await app.goto('flight', { resume: true });
  else {
    const design = def && def.start === 'builder' ? Object.values(career.crafts || {}).find(c => c && c.name && c.name !== '__autosave') : null;
    if (design) await app.goto('builder', { craft: design, site: 'pad' });
    else await app.goto('hub');
  }
  return true;
}

// ------------------------------------------------------------------ the picker

/** The Scenarios dialog. Resolves true when a scenario was started or resumed, false when it was closed. */
export function openScenarios(app) {
  ensureCss();
  const slot = scenarioSlotInfo();
  const grid = el('div', { class: 'sw-scn-grid', attrs: { role: 'list' } });
  let dlg = null, busy = false;
  const run = async fn => {
    if (busy) return;
    busy = true;
    // the dialog is hidden while a confirmation is up, and comes back if the answer is no
    dlg.node.parentElement.style.visibility = 'hidden';
    let ok = false;
    try { ok = await fn(); } catch (err) { console.error('[scenarios]', err); }
    busy = false;
    if (ok) dlg.close(true);
    else if (dlg.node.parentElement) { dlg.node.parentElement.style.visibility = ''; const b = grid.querySelector('button'); if (b) b.focus({ preventScroll: true }); }
  };
  for (const s of SCENARIOS) {
    const mine = slot && slot.id === s.id;
    const btn = (action, label, cls, fn) => el('button', { class: 'sw-btn ' + cls, text: label, attrs: { type: 'button', 'data-action': action, 'data-id': s.id }, on: { click: () => run(fn) } });
    const card = el('div', { class: 'sw-scn-card' + (mine ? ' current' : ''), attrs: { role: 'listitem', 'data-scenario': s.id }, style: { '--scn-tone': TONE[s.world] || 'var(--sw-teal)' } },
      el('div', { class: 'sw-scn-top' }, el('b', { text: s.name }), el('span', { class: 'sw-scn-diff ' + s.difficulty.toLowerCase(), text: s.difficulty })),
      el('div', { class: 'sw-scn-meta' }, el('span', { class: 'world', text: s.worldName }), el('i', { text: '·' }), el('span', { class: 'where', text: s.situation })),
      el('p', { class: 'sw-scn-goal', text: s.goal }),
      el('div', { class: 'sw-scn-foot' },
        mine ? el('small', { text: slot.complete ? 'Completed' : `In progress · ${slot.done}/${slot.total}` }) : null,
        el('div', { class: 'btns' },
          mine ? btn('restart', 'Restart', '', () => startScenario(app, s.id)) : null,
          mine ? btn('resume', 'Resume', 'primary', () => resumeScenario(app)) : btn('start', 'Start', 'primary', () => startScenario(app, s.id)))));
    card.style.setProperty('--scn-tone', TONE[s.world] || '#39d0c0');
    grid.appendChild(card);
  }
  const body = el('div', null,
    el('p', { class: 'sw-scn-intro', text: 'Ready-made flights: pick a place and start there. Every part is unlocked and nothing costs funds. A scenario is saved in its own slot, so your own program stays as it is.' }),
    grid);
  dlg = showModal({ title: 'Scenarios', body, wide: true, class: 'sw-scn-modal', cancelValue: false, buttons: [{ label: 'Close', value: false }] });

  // keyboard: the arrow keys walk the cards (Tab works too); Enter presses the focused button
  const primaries = () => [...grid.querySelectorAll('.sw-scn-card')].map(c => c.querySelector('.sw-btn.primary'));
  const onKey = e => {
    if (!grid.isConnected || busy) return;
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(e.key)) return;
    const list = primaries();
    const cur = document.activeElement && document.activeElement.closest ? document.activeElement.closest('.sw-scn-card') : null;
    let i = cur ? [...grid.children].indexOf(cur) : -1;
    const cols = Math.max(1, getComputedStyle(grid).gridTemplateColumns.split(' ').filter(Boolean).length);
    if (i < 0) i = 0;
    else if (e.key === 'ArrowRight') i = Math.min(list.length - 1, i + 1);
    else if (e.key === 'ArrowLeft') i = Math.max(0, i - 1);
    else if (e.key === 'ArrowDown') i = Math.min(list.length - 1, i + cols);
    else if (e.key === 'ArrowUp') i = Math.max(0, i - cols);
    else if (e.key === 'Home') i = 0;
    else if (e.key === 'End') i = list.length - 1;
    e.preventDefault();
    const b = list[i];
    if (b) { b.focus({ preventScroll: true }); b.closest('.sw-scn-card').scrollIntoView({ block: 'nearest' }); }
  };
  window.addEventListener('keydown', onKey, true);
  const first = (slot && grid.querySelector('.sw-scn-card.current .sw-btn.primary')) || grid.querySelector('.sw-btn.primary');
  if (first) first.focus({ preventScroll: true });
  return dlg.then(v => { window.removeEventListener('keydown', onKey, true); return v === true; });
}

// ------------------------------------------------------------------ the brief and the objectives panel

let briefPending = null;     // scenario id whose brief is shown as soon as its first screen is up
let panel = null;

function createPanel(app) {
  ensureCss();
  // on a short window the list starts folded (title and count only), so it stays clear of the staging stack
  let root = null, shownKey = '', folded = typeof window !== 'undefined' && window.innerHeight < 700, brief = false, lastDone = -1, onKey = null;
  const fold = () => { folded = !folded; shownKey = ''; };
  const closeBrief = () => {
    if (!brief) return;
    brief = false; shownKey = '';
    if (onKey) { window.removeEventListener('keydown', onKey, true); onKey = null; }
    tick();
  };
  function draw(st, screen) {
    if (!root) { root = el('div', { class: 'sw-scn-panel', attrs: { role: 'region', 'aria-label': 'Scenario' } }); }
    if (!root.isConnected) app.uiRoot.appendChild(root);
    clear(root);
    root.className = 'sw-scn-panel' + (brief ? ' brief sw-scn-brief' : '') + (folded && !brief ? ' folded' : '');
    root.dataset.scenario = st.id;
    root.dataset.done = String(st.done);
    const nextIdx = st.objectives.findIndex(o => !o.done);
    root.appendChild(el('div', { class: 'sw-scn-head', attrs: { 'data-action': 'fold', title: brief ? '' : 'Show or hide the objectives' }, on: { click: () => { if (!brief) { fold(); tick(); } } } },
      el('span', { class: 'tag', text: 'Scenario' }), el('b', { text: st.name }),
      el('span', { class: 'count', text: st.done + '/' + st.total }),
      el('button', { class: 'fold', text: folded ? '▸' : '▾', attrs: { type: 'button', 'aria-label': folded ? 'Show objectives' : 'Hide objectives' } })));
    const body = el('div', { class: 'sw-scn-body' },
      el('p', { class: 'sw-scn-where', text: st.worldName + ' · ' + st.situation + ' · ' + st.difficulty }),
      el('p', { class: 'sw-scn-text', text: st.brief }),
      el('p', { class: 'sw-scn-goalline', attrs: { 'data-role': 'goal' }, text: st.goal }),
      el('ul', { class: 'sw-scn-list' }, st.objectives.map((o, i) => el('li', { class: o.done ? 'done' : i === nextIdx ? 'next' : '', text: o.text, attrs: { 'data-objective': o.id, 'data-done': o.done ? '1' : '0' } }))),
      st.complete ? el('p', { class: 'sw-scn-done', text: 'Scenario complete. Carry on as long as you like.' }) : null,
      el('ol', { class: 'sw-scn-tips' }, st.tips.map(t => el('li', { text: t }))),
      el('div', { class: 'sw-scn-go' }, el('small', { text: screen === 'builder' ? 'Launch from the bar at the top when ready.' : 'The objectives stay on screen.' }),
        el('button', { class: 'sw-btn primary', text: screen === 'builder' ? 'To work' : 'Begin', attrs: { type: 'button', 'data-action': 'begin' }, on: { click: closeBrief } })));
    root.appendChild(body);
  }
  function hide() { if (root && root.isConnected) root.remove(); shownKey = ''; }
  function tick() {
    try { tickPanel(); } finally { document.body.classList.toggle('sw-scn-briefing', !!(brief && root && root.isConnected)); }
  }
  function tickPanel() {
    const career = app.career, screen = app.currentName;
    if (!career || !career.scenario || !SHOW_ON.has(screen) || !app.current) { if (brief && (!career || !career.scenario)) { brief = false; if (onKey) { window.removeEventListener('keydown', onKey, true); onKey = null; } } hide(); return; }
    // progress: only a live flight can meet objectives
    if (screen === 'flight' && app.world && !brief) {
      const fresh = checkScenario(career, app.world);
      for (const o of fresh) { app.toast('Objective complete: ' + o.text, 'good', 5000); try { app.audio.play('success'); } catch { /* optional sound */ } }
      if (fresh.length && career.scenario.complete) app.toast('Scenario complete: ' + career.scenario.name + '!', 'good', 8000);
      if (fresh.length) folded = false;
    }
    const st = scenarioStatus(career);
    if (!st) { hide(); return; }
    if (briefPending === st.id && !isModalOpen()) {
      briefPending = null; brief = true; shownKey = '';
      onKey = e => {
        if (!brief || isModalOpen()) return;
        if (e.key === 'Enter' || e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeBrief(); }
      };
      window.addEventListener('keydown', onKey, true);
    }
    // the panel steps aside for dialogs and for the map
    const covered = !brief && (isModalOpen() || (app.flight && app.flight.mapOpen && false));
    const key = [st.id, screen, st.done, brief ? 'b' : folded ? 'f' : 'o', covered ? 'c' : ''].join('|');
    place(screen);
    if (key === shownKey) return;
    shownKey = key;
    draw(st, screen);
    place(screen);
    root.hidden = !!covered;
    if (brief) { const b = root.querySelector('[data-action="begin"]'); if (b) { try { b.focus({ preventScroll: true }); } catch { /* ignore */ } } }
    lastDone = st.done;
  }
  /** In flight the panel sits under the top-left column (clock, vessel, and the target card when there is one). */
  function place(screen) {
    if (!root) return;
    let top = '';
    if (screen === 'flight' && !brief) {
      const tl = document.querySelector('.fl-tl');
      if (tl) { const r = tl.getBoundingClientRect(); if (r.height > 0) top = Math.round(r.bottom + 6) + 'px'; }
    }
    if (root.style.top !== top) root.style.top = top;
  }
  const timer = setInterval(() => { try { tick(); } catch (err) { console.error('[scenarios] panel:', err); } }, 400);
  void lastDone;
  return { tick, closeBrief, get brief() { return brief; }, get node() { return root; }, dispose() { clearInterval(timer); hide(); } };
}

// ------------------------------------------------------------------ install

/** Adds app.scenarios and starts the objectives panel. Safe to call more than once. */
export function installScenarios(app) {
  if (app.scenarios) return app.scenarios;
  if (!panel) panel = createPanel(app);
  app.scenarios = {
    list: SCENARIOS,
    open: () => openScenarios(app),
    start: (id, opts) => startScenario(app, id, opts),
    resume: () => resumeScenario(app),
    status: () => scenarioStatus(app.career),
    slot: () => scenarioSlotInfo(),
    note: () => scenarioMenuNote(),
    check: () => (app.career && app.world ? checkScenario(app.career, app.world) : []),
    panel,
    quickKey: SCENARIO_QUICK_KEY,
  };
  return app.scenarios;
}
