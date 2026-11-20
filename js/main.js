// Starwright — application shell: renderer, career, input, audio, screen manager and main loop.
//
// app = {
//   renderer            the one THREE.WebGLRenderer (on <canvas id="gl">); null only if WebGL is unavailable
//   canvas, uiRoot      the canvas and the click-through DOM overlay root (<div id="ui">)
//   career              Career | null (null on the title screen before a game is loaded)
//   settings            { musicVolume, sfxVolume, invertPitch, showHints } — same object as career.settings
//   input, audio        see js/ui/input.js, js/ui/audio.js
//   world               set by the flight screen (window.__sw.world reads it)
//   screens             { name: screen } registry; registerScreen(name, screen)
//   current, currentName
//   goto(name, params)  → Promise; exits the current screen, enters the next
//   toast(text, kind)   kind: 'info' | 'good' | 'warn' | 'bad'
//   save()              → bool; writes the career to localStorage
//   confirm(title, text, {okLabel, cancelLabel, danger}) → Promise<bool>
//   newGame(mode), continueGame(), deleteSave(), exitToTitle(), applySettings()
//   launch(craft, {crew, site})   pay for + crew a craft and go to the flight screen; site: 'pad' | 'runway'
//   size                { w, h } CSS pixels
// }
//
// Screen contract (every createXScreen(app) returns this):
//   { enter(params), exit(), update(dt), render(), resize(w, h) }      all optional except enter/exit
//   Optional flags:  is3D: true  → the screen draws the canvas itself in render();
//                    otherwise main clears the canvas to the background colour every frame.
//                    (A screen that defines render() and does not set is3D:false is treated as 3D.)
//                    capturesKeys: true/false → override whether browser keys (Space, Tab, F5…) are swallowed.

import * as THREE from './lib/three.module.min.js';
import { createInput } from './ui/input.js';
import { createAudio } from './ui/audio.js';
import { el, clear, showModal, isModalOpen, resolveUiScale, setUiScale } from './ui/dom.js';
import { createHubScreen, createTitleScreen, pipFigure } from './ui/hub.js';
import { createResearchScreen } from './ui/research.js';
import { createMissionsScreen } from './ui/missions.js';
import { createCrewScreen } from './ui/crew.js';
import { createGuideScreen } from './ui/guide.js';
import { perf } from './perf.js';

const BG_COLOR = 0x0b0f14;
// 0.856 of a Verda day (19,800 s): the sun is about 38° up in the east over the space centre and climbing.
export const NEW_GAME_UT = 16950;
const SETTINGS_KEY = 'starwright.settings.v1';
const DEFAULT_SETTINGS = { musicVolume: 0.5, sfxVolume: 0.8, invertPitch: false, showHints: true,
  gfxQuality: 'high', gfxBloom: 0.7, gfxShadows: true, gfxLens: true, gfxShake: 1,
  gfxAuto: true, gfxVegetation: 'auto',     // vegetation detail: 'auto' (from Detail) | 'low' | 'medium' | 'high' | 'ultra' (js/render/flora.js)
  uiScale: 'auto' };   // uiScale: interface size, 'auto' (from the window) or 0.8 to 1.75 (js/ui/dom.js resolveUiScale)     // gfxAuto: lower render scale / shadows / post automatically when frames come slowly (js/ui/governor.js)     // graphics: read by the flight screen
const GAME_SCREENS = new Set(['flight', 'builder', 'tracking']);      // 3D screens written by other modules
const NEEDS_CAREER = new Set(['hub', 'builder', 'flight', 'tracking', 'research', 'missions', 'crew']);

const canvas = document.getElementById('gl');
const uiRoot = document.getElementById('ui');

function loadSettings() {
  try { return { ...DEFAULT_SETTINGS, ...(JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') || {}) }; }
  catch { return { ...DEFAULT_SETTINGS }; }
}

// Device pixels per CSS pixel the canvas is drawn with: the display's own ratio, at most 2, and never more than a
// 4K frame's worth of pixels in total (a maximised window on a 5K or 6K display would otherwise ask for 15 to 20
// million pixels per frame, with multisampling on top).
const MAX_PIXELS = 3840 * 2160;
function pixelRatio(w = window.innerWidth, h = window.innerHeight) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  return Math.max(Math.min(dpr, 1), Math.min(dpr, Math.sqrt(MAX_PIXELS / Math.max(1, w * h))));
}

function createRenderer() {
  try {
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, logarithmicDepthBuffer: true });
    renderer.setPixelRatio(pixelRatio());
    renderer.setSize(window.innerWidth, window.innerHeight, false);
    renderer.setClearColor(BG_COLOR, 1);
    // Renderer contract (docs/SECOND_PASS.md): every screen and every material is authored for these settings.
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.0;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    return renderer;
  } catch (err) {
    console.warn('[starwright] WebGL is unavailable:', err && err.message);
    return null;
  }
}

const toastBox = el('div', { class: 'sw-toasts' });
// Toasts queue up: at most TOAST_MAX are on screen, the rest wait their turn (hidden but already in the DOM, in
// order). While something is waiting, the oldest visible toast leaves early (after TOAST_MIN_SHOW at least).
const TOAST_MAX = 2, TOAST_WAIT_MAX = 6, TOAST_MIN_SHOW = 1100;
function toastSchedule(node, ms) {
  clearTimeout(node._timer);
  node._until = performance.now() + ms;
  node._timer = setTimeout(() => {
    node._gone = true;
    node.classList.add('out');
    setTimeout(() => node.remove(), 320);          // the observer below then lets the next one in
  }, ms);
}
function toastPump() {
  const kids = [...toastBox.children];
  const waiting = kids.filter(n => n._queued);
  let showing = kids.length - waiting.length;
  while (waiting.length && showing < TOAST_MAX) {
    const n = waiting.shift();
    n._queued = false; n.style.display = ''; n._shownAt = performance.now();
    toastSchedule(n, n._life);
    showing++;
  }
  if (!waiting.length) return;
  const oldest = kids.find(n => !n._queued && !n._gone);
  if (oldest) {
    const now = performance.now(), left = Math.max(0, oldest._shownAt + TOAST_MIN_SHOW - now);
    if (oldest._until - now > left) toastSchedule(oldest, left);
  }
}
if (typeof MutationObserver !== 'undefined') new MutationObserver(toastPump).observe(toastBox, { childList: true });

const app = {
  renderer: (perf.renderer = createRenderer()),
  canvas, uiRoot,
  career: null,
  settings: loadSettings(),
  input: createInput(canvas),
  audio: createAudio(),
  world: null,
  screens: {},
  current: null,
  currentName: '',
  size: { w: window.innerWidth, h: window.innerHeight },
  ui: { scale: 1 },      // interface size in effect (Settings → Interface size); #ui is zoomed by it, the canvas is not
  Career: null,          // the Career class, once js/core/career.js has loaded
  frame: 0,
  frameCpuMs: 0,         // main-thread time the last frame's update + render took (the quality governor reads it)
  pixelRatio,            // (w, h) → device pixels per CSS pixel at full quality (capped; see MAX_PIXELS)

  registerScreen(name, screen) { app.screens[name] = screen; return screen; },

  async goto(name, params = {}) {
    if (NEEDS_CAREER.has(name) && !app.career) name = 'title';
    let next = app.screens[name];
    if (!next) { console.warn('[starwright] unknown screen "' + name + '"'); next = app.screens.hub && app.career ? app.screens.hub : app.screens.title; name = app.career ? 'hub' : 'title'; }
    const prev = app.current;
    if (prev) {
      app.current = null;                       // nothing updates mid-transition
      try { if (prev.exit) await prev.exit(); } catch (err) { console.error('[starwright] ' + app.currentName + '.exit failed:', err); }
      if (app.career && app.currentName !== 'title') app.save(true);
    }
    app.input.releaseAll();
    const is3D = next.is3D === true || (next.is3D !== false && typeof next.render === 'function');
    const captures = next.capturesKeys != null ? !!next.capturesKeys : (GAME_SCREENS.has(name) || is3D);
    app.input.captureKeys = captures;
    app.input.guardUnload(captures);
    app.audio.setAmbient(!GAME_SCREENS.has(name));
    if (!GAME_SCREENS.has(name)) app.audio.stopAll();
    app.currentName = name;
    document.body.dataset.screen = name;
    syncUiScale();
    try {
      await next.enter(params || {});
      if (next.resize) next.resize(app.size.w, app.size.h);
      app.current = next;
    } catch (err) {
      console.error('[starwright] ' + name + '.enter failed:', err);
      try { if (next.exit) next.exit(); } catch { /* best effort */ }
      if (name !== 'hub' && name !== 'title') {
        const damaged = !!(err && err.damagedFlight && app.career && app.career.flightState);
        app.toast((err && err.userMessage) || 'Could not open ' + name + ' (see console).', 'bad', damaged ? 15000 : undefined,
          damaged ? { action: { label: 'Discard it', onClick: () => app.discardFlight() } } : undefined);
        return app.goto(app.career ? 'hub' : 'title');
      }
      fatal('Could not start the ' + name + ' screen.', err);
    }
    return next;
  },

  /** toast(text, kind, ms, { action: { label, onClick } })  — `action` adds a button inside the toast. */
  toast(text, kind = 'info', ms, opts) {
    if (!toastBox.isConnected) uiRoot.appendChild(toastBox);
    const str = String(text);
    // the same message already waiting its turn is not queued twice
    const same = [...toastBox.children].find(n => n._queued && n._text === str);
    if (same) return same;
    const node = el('div', { class: 'sw-toast' + (kind && kind !== 'info' ? ' ' + kind : ''), text: str, attrs: { role: 'status' } });
    const action = opts && opts.action;
    if (action && action.label) {
      node.appendChild(el('button', { class: 'sw-btn small', text: action.label, attrs: { type: 'button', 'data-toast-action': '1' }, style: { marginLeft: '6px', flex: 'none' },
        on: { click: () => { node.remove(); try { action.onClick && action.onClick(); } catch (err) { console.error('[starwright] toast action failed:', err); } } } }));
    }
    node._text = str; node._queued = true; node._life = ms || Math.min(7000, 2600 + str.length * 40);
    node.style.display = 'none';
    const waiting = [...toastBox.children].filter(n => n._queued);
    if (waiting.length >= TOAST_WAIT_MAX) waiting[0].remove();         // stale by the time it would show
    toastBox.appendChild(node);
    toastPump();
    return node;
  },

  /** Throw away a saved flight that can no longer be loaded (asks first). Its crew go back on the roster. */
  async discardFlight() {
    const c = app.career;
    if (!c || !c.flightState) return false;
    const ok = await app.confirm('Discard the flight in progress?', 'Its save data is damaged and cannot be flown again. The vessels in it are written off; their crews return to the roster.', { okLabel: 'Discard flight', danger: true });
    if (!ok || app.career !== c) return false;
    const names = new Set();
    const walk = o => {
      if (!o || typeof o !== 'object') return;
      if (Array.isArray(o.crew)) for (const n of o.crew) if (typeof n === 'string') names.add(n);
      for (const k of Object.keys(o)) walk(o[k]);
    };
    try { walk(c.flightState); if (names.size && c.releaseCrew) c.releaseCrew([...names]); } catch { /* the data is damaged: best effort */ }
    c.flightState = null;
    app.save(true);
    app.toast('The damaged flight was discarded.', 'info');
    return true;
  },

  save(quiet = true) {
    if (!app.career) return false;
    let ok = false;
    try { app.career.settings = app.settings; ok = app.career.save() !== false; } catch (err) { console.warn('[starwright] save failed:', err); }
    if (!ok) app.toast('Could not save the game (browser storage is full or blocked).', 'bad');
    else if (!quiet) app.toast('Game saved.', 'good');
    return ok;
  },

  confirm(title, text, { okLabel = 'OK', cancelLabel = 'Cancel', danger = false } = {}) {
    return showModal({
      title, body: text, cancelValue: false,
      buttons: [{ label: cancelLabel, value: false }, { label: okLabel, value: true, kind: danger ? 'danger' : 'primary' }],
    }).then(v => v === true);
  },

  /** Push settings to audio and persist them (call after changing app.settings). */
  applySettings() {
    const s = app.settings;
    app.audio.setVolume({ sfx: s.sfxVolume, music: s.musicVolume });
    if (syncUiScale() && app.current && app.current.resize) { try { app.current.resize(app.size.w, app.size.h); } catch (err) { console.error('[starwright] resize failed:', err); } }
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)); } catch { /* private mode */ }
    if (app.career) app.career.settings = s;
  },

  hasSave() { try { return !!(app.Career && app.Career.hasSave()); } catch { return false; } },

  /** `to` (optional): the screen to open instead of the Flight Center, with `params` (the title menu's Missions entry). */
  newGame(mode, { to = null, params = null } = {}) {
    try { localStorage.removeItem('starwright.quicksave.v1'); } catch { /* private mode */ }   // quicksaves belong to the game they were made in
    app.career = app.Career.newGame(mode);
    // A new program opens in mid-morning: at ut 0 the sun stands exactly over the pad and nothing casts a shadow.
    // (Saved games keep their own clock; only the first day of a new one is shifted.)
    app.career.ut = NEW_GAME_UT;
    app.career.settings = app.settings;
    app.world = null;
    app.save(true);
    return to && app.screens[to] ? app.goto(to, params || {}) : app.goto('hub', { fresh: true });
  },

  continueGame({ to = null, params = null } = {}) {
    const c = app.Career.load();
    if (!c) { app.toast('No saved game could be loaded.', 'bad'); return app.goto('title'); }
    app.career = c;
    app.career.settings = app.settings;
    app.world = null;
    return to && app.screens[to] ? app.goto(to, params || {}) : app.goto('hub');
  },

  deleteSave() {
    try {
      if (app.Career.deleteSave) app.Career.deleteSave();
      else localStorage.removeItem('starwright.save.v1');
      localStorage.removeItem('starwright.quicksave.v1');
    } catch (err) { console.warn('[starwright] delete save failed:', err); }
    app.career = null; app.world = null;
  },

  async exitToTitle() {
    if (app.career) app.save(true);
    await app.goto('title');
    app.career = null; app.world = null;
  },

  /**
   * Launch a craft: charges the launch cost (career mode), marks the crew as assigned, saves, and opens the
   * flight screen with { craft: craftJSON, crew: [names], paid: true, site } (the same hand-over the builder uses).
   * `site` is 'pad' or 'runway' (default: the site the design was saved for, else the pad).
   * `craft` is a Craft instance. Returns false (with a toast) if it cannot be afforded.
   */
  launch(craft, { crew = [], site } = {}) {
    const career = app.career;
    if (!career || !craft) return false;
    const cost = typeof craft.cost === 'function' ? craft.cost() : 0;
    {   // facility limits (hangar part count, pad / runway mass): Career.checkLaunch
      const at = site === 'runway' || site === 'pad' ? site : (craft.site === 'runway' ? 'runway' : 'pad');
      const lim = typeof career.checkLaunch === 'function' ? career.checkLaunch(craft, at) : { ok: true };
      if (lim && !lim.ok) {
        const what = lim.reason === 'parts' ? `Too many parts for the hangar: ${lim.value}, the limit is ${lim.limit}.`
          : lim.reason === 'mass' ? `Too heavy for the ${at === 'runway' ? 'runway' : 'launch pad'}: ${lim.value.toFixed(1)} t, the limit is ${Number.isFinite(lim.limit) ? lim.limit + ' t' : 'none'}.`
          : 'This craft cannot be launched.';
        app.toast(what + ' Upgrade the facility or lighten the design.', 'bad'); app.audio.play('alarm'); return false;
      }
    }
    if (!career.canAfford(cost)) { app.toast('Not enough funds to launch ' + craft.name + '.', 'bad'); app.audio.play('alarm'); return false; }
    if (typeof career.payLaunch === 'function') career.payLaunch(craft); else career.spend(cost);
    const names = typeof career.assignCrew === 'function' ? career.assignCrew(crew) : crew;
    app.save(true);
    const json = typeof craft.toJSON === 'function' ? craft.toJSON() : craft;
    const where = site === 'runway' || site === 'pad' ? site : (json && json.site === 'runway' ? 'runway' : 'pad');
    app.goto('flight', { craft: json, crew: names, paid: true, site: where });
    return true;
  },
};

window.__sw = {
  app,
  get world() { return app.world; },
  get career() { return app.career; },
};

// ------------------------------------------------------------------ fatal error card

function fatal(message, err) {
  console.error('[starwright] fatal:', message, err || '');
  if (document.querySelector('.sw-fatal')) return;
  document.body.appendChild(el('div', { class: 'sw-fatal' },
    el('div', { class: 'sw-panel', style: { maxWidth: '560px' } },
      el('div', { class: 'sw-title big', text: 'Starwright could not start' }),
      el('p', { style: { margin: '10px 0' }, text: message }),
      err ? el('pre', { text: String(err && err.stack || err) }) : null,
      el('p', { class: 'sw-dim', text: 'Serve the project folder from a static web server (for example: python3 -m http.server) and open it in Chrome or Safari.' }))));
}

// ------------------------------------------------------------------ placeholder for screens that are not built yet

const SOON = {
  builder: ['Assembly Hangar', 'The hangar doors are still being hung. Rocket assembly opens here soon.'],
  flight: ['Launch Pad', 'The pad crew is still painting the lines. Flight opens here soon.'],
  tracking: ['Tracking Dish', 'The big dish is still being bolted down. Tracking opens here soon.'],
};

function createPlaceholderScreen(name) {
  let root = null;
  const [title, text] = SOON[name] || [name, 'This screen is coming soon.'];
  return {
    is3D: false, capturesKeys: false, placeholder: true,
    enter() {
      root = el('div', { class: 'sw-screen opaque', data: { screen: name } },
        el('div', { class: 'sw-soon' },
          pipFigure({ wave: true }),
          el('div', { class: 'sw-chip amber', text: 'Coming soon' }),
          el('div', { class: 'sw-title big', text: title }),
          el('p', { class: 'sw-dim', text }),
          el('button', { class: 'sw-btn primary', text: 'Back to the Flight Center', attrs: { 'data-action': 'back' }, on: { click: () => app.goto('hub') } })));
      uiRoot.appendChild(root);
    },
    exit() { if (root) root.remove(); root = null; },
    update() { if (app.input.pressed('Escape')) app.goto('hub'); },
  };
}

async function loadOptionalScreen(name, file, factory) {
  const url = new URL('./ui/' + file, import.meta.url).href;
  let exists = false;
  try { exists = (await fetch(url, { method: 'HEAD', cache: 'no-store' })).ok; } catch { exists = false; }
  if (exists) {
    try {
      const mod = await import(url);
      if (typeof mod[factory] !== 'function') throw new Error(file + ' does not export ' + factory + '(app)');
      const screen = mod[factory](app);
      if (!screen || typeof screen.enter !== 'function') throw new Error(factory + ' did not return a screen');
      return app.registerScreen(name, screen);
    } catch (err) {
      console.error('[starwright] failed to load js/ui/' + file + ':', err);
    }
  }
  return app.registerScreen(name, createPlaceholderScreen(name));
}

// ------------------------------------------------------------------ resize + main loop

// The recorded demo and the benchmark are laid out for the plain 1:1 interface.
const FIXED_UI = new Set(['demo', 'perfbench']);
/** Applies the Interface size setting for the current window and screen; true when the scale changed. */
function syncUiScale() {
  const k = FIXED_UI.has(app.currentName) ? 1 : resolveUiScale(app.settings.uiScale, Math.max(1, window.innerWidth), Math.max(1, window.innerHeight));
  app.ui.scale = k;
  return setUiScale(k);
}

function onResize() {
  const w = Math.max(1, window.innerWidth), h = Math.max(1, window.innerHeight);
  app.size.w = w; app.size.h = h;
  syncUiScale();
  if (app.renderer) {
    app.renderer.setPixelRatio(pixelRatio(w, h));
    app.renderer.setSize(w, h, false);
  }
  const s = app.current;
  if (s && s.resize) { try { s.resize(w, h); } catch (err) { console.error('[starwright] resize failed:', err); } }
}

let last = 0, errorBurst = 0, lastErrorText = '';
function reportLoopError(where, err) {
  const text = where + ': ' + (err && err.message);
  if (text === lastErrorText && ++errorBurst > 3) return;     // do not flood the console at 60 Hz
  if (text !== lastErrorText) { lastErrorText = text; errorBurst = 0; }
  console.error('[starwright] ' + where + ' failed:', err);
}

function frame(now) {
  requestAnimationFrame(frame);
  // app.fixedStep (s): every drawn frame advances the game by exactly this much (the demo tour's &step=, for filming on a slow renderer)
  const dt = app.fixedStep > 0 ? Math.min(app.fixedStep, 0.1) : Math.min(Math.max((now - last) / 1000, 0), 0.1);
  last = now;
  app.frame++;
  perf.frameBegin(now);                         // js/perf.js: one branch each while nothing is recording
  const cpu0 = performance.now();
  const s = app.current;
  if (s) {
    // the flight screen marks its own sections (sim, scene, hud); any other screen's update is scene work
    perf.begin(app.currentName === 'flight' ? 'other' : 'scene');
    if (s.update) { try { s.update(dt); } catch (err) { reportLoopError(app.currentName + '.update', err); } }
    perf.end();
    const cur = app.current;                    // update() may have switched screens
    // app.drawEvery (n > 1): only every nth frame is drawn (filming the demo tour on a software renderer: the game
    // still advances frame by frame, only the pictures nobody captures are left out)
    if (cur === s && !(app.drawEvery > 1 && app.frame % app.drawEvery)) {
      perf.begin('render');
      const is3D = s.is3D === true || (s.is3D !== false && typeof s.render === 'function');
      if (is3D && s.render) { try { s.render(); } catch (err) { reportLoopError(app.currentName + '.render', err); } }
      else {
        if (app.renderer) { app.renderer.setRenderTarget(null); app.renderer.setClearColor(BG_COLOR, 1); app.renderer.clear(); }
        if (s.render) { try { s.render(); } catch (err) { reportLoopError(app.currentName + '.render', err); } }
      }
      perf.end();
    }
  } else if (app.renderer) app.renderer.clear();
  app.input.endFrame();
  app.frameCpuMs = performance.now() - cpu0;
  perf.frameEnd();
}

// ------------------------------------------------------------------ global behaviours

function installGlobals() {
  window.addEventListener('resize', onResize);
  // WebAudio needs a user gesture.
  const unlock = () => { app.audio.unlock(); app.audio.setVolume({ sfx: app.settings.sfxVolume, music: app.settings.musicVolume }); };
  window.addEventListener('pointerdown', unlock, true);
  window.addEventListener('keydown', unlock, true);
  // A soft tick for every button-like control.
  document.addEventListener('click', e => {
    const t = e.target instanceof Element ? e.target.closest('.sw-btn, .sw-tab, .sw-item, .sw-card, .sw-node, .sw-mode, .hot') : null;
    if (t && !t.disabled && !t.classList.contains('disabled') && !t.classList.contains('static')) app.audio.play('click');
  }, true);
  // Save when the tab is hidden or closed (never on the title screen, which has no career).
  document.addEventListener('visibilitychange', () => { if (document.hidden && app.career && !GAME_SCREENS.has(app.currentName)) app.save(true); });
  window.addEventListener('pagehide', () => { if (app.career && !GAME_SCREENS.has(app.currentName)) app.save(true); });
  // Losing the GL context should not kill the page.
  canvas.addEventListener('webglcontextlost', e => { e.preventDefault(); console.warn('[starwright] WebGL context lost'); });
  canvas.addEventListener('webglcontextrestored', () => { console.warn('[starwright] WebGL context restored'); onResize(); });
}

async function boot() {
  installGlobals();
  app.applySettings();

  try {
    const mod = await import('./core/career.js');
    app.Career = mod.Career;
    app.careerModule = mod;
  } catch (err) {
    fatal('The career module (js/core/career.js) could not be loaded.', err);
    return;
  }

  app.registerScreen('title', createTitleScreen(app));
  app.registerScreen('hub', createHubScreen(app));
  app.registerScreen('research', createResearchScreen(app));
  app.registerScreen('missions', createMissionsScreen(app));
  app.registerScreen('crew', createCrewScreen(app));
  app.registerScreen('guide', createGuideScreen(app));      // Flight School: works with or without a game loaded
  await Promise.all([
    loadOptionalScreen('builder', 'builder.js', 'createBuilderScreen'),
    loadOptionalScreen('flight', 'flight.js', 'createFlightScreen'),
    loadOptionalScreen('tracking', 'tracking.js', 'createTrackingScreen'),
  ]);

  if (!app.renderer) app.toast('WebGL is not available in this browser: 3D views will not work.', 'bad', 8000);

  last = performance.now();
  requestAnimationFrame(frame);
  // Frame-time overlay (F3) and the ?perf=1 benchmark (js/ui/perf.js): optional.
  try { (await import('./ui/perf.js')).installPerf(app); } catch (err) { console.warn('Performance overlay not available:', err && err.message); }
  // Scenarios (js/ui/scenarios.js): optional, adds app.scenarios (the title menu's Scenarios entry and the objectives panel).
  try { (await import('./ui/scenarios.js')).installScenarios(app); } catch (err) { console.warn('Scenarios not available:', err && err.message); }
  // Science reference (js/ui/science.js): optional, adds app.science (the title menu's Science entry).
  try { (await import('./ui/science.js')).installScience(app); } catch (err) { console.warn('Science reference not available:', err && err.message); }
  // Demo tour (js/ui/demo.js): optional, adds app.demo; ?demo=1 in the address starts it once the title is up.
  try { (await import('./ui/demo.js')).installDemo(app); } catch (err) { console.warn('Demo tour not available:', err && err.message); }
  await app.goto('title');
  document.body.dataset.ready = '1';
  if (app.perf && app.perf.auto) app.perf.runBenchmark(app.perf.auto);
  else if (app.demo && app.demo.auto) app.demo.start(app.demo.auto);
}

boot().catch(err => fatal('Unexpected error while starting.', err));

export { app, isModalOpen, clear };
