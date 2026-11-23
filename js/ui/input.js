// Starwright — keyboard + mouse input.
//
//   const input = createInput(canvas)
//   input.down('KeyW')            is the key (KeyboardEvent.code) held?
//   input.pressed('Space')        went down this frame? (edge; cleared by input.endFrame())
//   input.mods                    { shift, ctrl, alt, meta }
//   input.capsLock                is Caps Lock on? (read from the last key or pointer event; used for fine controls)
//   input.mouse                   { x, y, dx, dy, buttons, over, zoom }   dx/dy/zoom accumulate per frame
//   input.on(type, fn) → off()    'wheel' | 'mousedown' | 'mouseup' | 'mousemove' | 'click' | 'dblclick' | 'keydown' | 'keyup'
//   input.captureKeys = bool      true on game screens: Space/arrows/Tab/F5/F9/… no longer reach the browser
//   input.guardUnload(bool)       "leave page?" guard + history trap so the mouse back button cannot navigate away
//   input.endFrame()              main loop calls this after update/render
//   input.releaseAll()            forget every held key / button (also done on window blur)
//
// Mouse events are only delivered when they start on the canvas (UI panels handle their own), and a drag keeps
// reporting through pointer capture even when the pointer leaves the window.
//
// Wheel events are normalised: e.dx / e.dy are CSS pixels whatever the deltaMode, and e.zoom is a multiplicative
// factor per event, clamped to [0.8, 1.25]; > 1 means "zoom in" (wheel away from you / pinch out). Divide a camera
// distance by e.zoom. High-resolution and free-spinning wheels (Logitech MX) send floods of small or huge deltas:
// each event is clamped and the total zoom per ~100 ms is budgeted, so a flick never teleports the camera.

const GAME_KEYS = new Set(['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Tab', 'F1', 'F2', 'F3', 'F5', 'F9',
  'Slash', 'Quote', 'Backspace', 'Comma', 'Period', 'BracketLeft', 'BracketRight', 'Backslash']);

const LINE_PX = 16;
const ZOOM_MIN = 0.8, ZOOM_MAX = 1.25;
const WHEEL_GAIN = 0.0022;        // ln(zoom) per pixel of wheel travel (one classic 100 px notch ≈ ×1.25)
const PINCH_GAIN = 0.012;         // ln(zoom) per pixel of trackpad pinch delta
const BUDGET_WINDOW = 100;        // ms
const BUDGET_MAX = Math.log(1.6); // at most ×1.6 per window

/** Pure helper (exported for tests): wheel event → { dx, dy, zoom, pinch } before the rate budget is applied. */
export function normalizeWheel(e, pageSize = 800) {
  let k = 1;
  if (e.deltaMode === 1) k = LINE_PX; else if (e.deltaMode === 2) k = pageSize;
  let dx = (e.deltaX || 0) * k, dy = (e.deltaY || 0) * k;
  // Shift+wheel arrives as horizontal scroll on macOS: treat a pure horizontal delta from a wheel as vertical.
  if (e.shiftKey && dy === 0 && dx !== 0) { dy = dx; dx = 0; }
  const pinch = !!e.ctrlKey;
  let lz = -dy * (pinch ? PINCH_GAIN : WHEEL_GAIN);
  const lim = Math.log(ZOOM_MAX);
  lz = Math.max(-lim, Math.min(lim, lz));
  let zoom = Math.exp(lz);
  zoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, zoom));
  return { dx, dy, zoom, pinch };
}

function isTyping(target) {
  if (!target || !target.tagName) return false;
  const tag = target.tagName;
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag === 'INPUT') {
    const type = (target.type || 'text').toLowerCase();
    return !['checkbox', 'radio', 'range', 'button', 'submit', 'color', 'file'].includes(type);
  }
  return !!target.isContentEditable;
}

export function createInput(canvas, { win = window } = {}) {
  const doc = win.document;
  const keys = new Set();
  const edge = new Set();
  const listeners = {};
  const mods = { shift: false, ctrl: false, alt: false, meta: false };
  const mouse = { x: 0, y: 0, dx: 0, dy: 0, buttons: 0, over: false, zoom: 1 };
  const captured = new Set();     // pointer ids captured on the canvas
  let unloadGuard = false;
  let trapArmed = false;
  let budget = [];                // [time, |ln zoom|]

  const input = {
    mods, mouse,
    captureKeys: false,
    capsLock: false,
    down: code => keys.has(code),
    pressed: code => edge.has(code),
    on(type, fn) {
      (listeners[type] || (listeners[type] = new Set())).add(fn);
      return () => { const s = listeners[type]; if (s) s.delete(fn); };
    },
    off(type, fn) { const s = listeners[type]; if (s) s.delete(fn); },
    endFrame() { edge.clear(); mouse.dx = 0; mouse.dy = 0; mouse.zoom = 1; },
    releaseAll,
    guardUnload(on) {
      // Automated browsers (Playwright/WebDriver) must stay free to reload and navigate.
      unloadGuard = !!on && !(win.navigator && win.navigator.webdriver);
      if (unloadGuard) armTrap();
    },
    /** Programmatic key tap (used by on-screen buttons and tests). */
    tap(code) { edge.add(code); emit('keydown', { type: 'keydown', code, key: code, repeat: false, synthetic: true, ...mods }); },
    dispose,
  };

  function emit(type, ev) {
    const s = listeners[type];
    if (!s || !s.size) return;
    for (const fn of [...s]) {
      try { fn(ev); } catch (err) { console.error('[input] listener for ' + type + ' failed:', err); }
    }
  }

  function syncMods(e) {
    mods.shift = !!e.shiftKey; mods.ctrl = !!e.ctrlKey; mods.alt = !!e.altKey; mods.meta = !!e.metaKey;
    if (typeof e.getModifierState === 'function') { try { input.capsLock = !!e.getModifierState('CapsLock'); } catch { /* synthetic event */ } }
  }

  function releaseAll() {
    if (keys.size) {
      for (const code of [...keys]) { keys.delete(code); emit('keyup', { type: 'keyup', code, key: '', released: true, ...mods }); }
    }
    edge.clear();
    mods.shift = mods.ctrl = mods.alt = mods.meta = false;
    if (mouse.buttons) {
      const b = mouse.buttons; mouse.buttons = 0;
      for (let i = 0; i < 5; i++) if (b & (1 << BUTTON_BIT[i])) emit('mouseup', mouseEvent('mouseup', null, i, true));
    }
    for (const id of captured) { try { canvas.releasePointerCapture(id); } catch { /* already gone */ } }
    captured.clear();
  }

  // ------------------------------------------------------------ keyboard

  function onKeyDown(e) {
    syncMods(e);
    if (isTyping(e.target)) return;
    const code = e.code || e.key;
    if (input.captureKeys && !e.metaKey) {
      // Keep the page still: no scrolling, focus-walking, reloading, quick-find or history-back,
      // and no Ctrl+letter browser shortcuts while Ctrl is the throttle-down key.
      if (GAME_KEYS.has(code) || (e.ctrlKey && code.startsWith('Key')) || (e.altKey && (code.startsWith('Key') || code.startsWith('Digit')))) e.preventDefault();
    }
    if (e.key === 'Meta' || e.key === 'OS') return;
    if (!e.repeat) {
      if (!keys.has(code)) edge.add(code);
      keys.add(code);
    }
    emit('keydown', { type: 'keydown', code, key: e.key, repeat: !!e.repeat, shift: mods.shift, ctrl: mods.ctrl, alt: mods.alt, meta: mods.meta, original: e });
  }

  function onKeyUp(e) {
    syncMods(e);
    const code = e.code || e.key;
    // macOS never sends keyup for keys released while Cmd is down — drop everything when Cmd lifts.
    if (e.key === 'Meta' || e.key === 'OS') { const m = { ...mods }; releaseAll(); Object.assign(mods, m, { meta: false }); return; }
    if (!keys.has(code)) return;
    keys.delete(code);
    if (input.captureKeys && GAME_KEYS.has(code) && !isTyping(e.target)) e.preventDefault();
    emit('keyup', { type: 'keyup', code, key: e.key, shift: mods.shift, ctrl: mods.ctrl, alt: mods.alt, meta: mods.meta, original: e });
  }

  // ------------------------------------------------------------ mouse (pointer events on the canvas)

  const BUTTON_BIT = [0, 2, 1, 3, 4];   // MouseEvent.button → bit index in MouseEvent.buttons

  function localXY(e) {
    const r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  function mouseEvent(type, e, button, released = false) {
    return {
      type, x: mouse.x, y: mouse.y, dx: 0, dy: 0, button, buttons: mouse.buttons, released,
      shift: mods.shift, ctrl: mods.ctrl, alt: mods.alt, meta: mods.meta, original: e,
    };
  }

  function track(e) {
    const p = localXY(e);
    const dx = p.x - mouse.x, dy = p.y - mouse.y;
    mouse.x = p.x; mouse.y = p.y;
    return { dx, dy };
  }

  function onPointerDown(e) {
    if (e.pointerType === 'touch' && !e.isPrimary) return;
    syncMods(e);
    track(e);
    mouse.buttons = e.buttons;
    if (e.button !== 0) e.preventDefault();          // no autoscroll puck, no back/forward
    try { canvas.setPointerCapture(e.pointerId); captured.add(e.pointerId); } catch { /* synthetic event */ }
    if (doc.activeElement && doc.activeElement !== doc.body && doc.activeElement.blur && isTyping(doc.activeElement)) doc.activeElement.blur();
    emit('mousedown', mouseEvent('mousedown', e, e.button));
  }

  function onPointerMove(e) {
    syncMods(e);
    const had = mouse.buttons;
    const d = track(e);
    // A button released outside the window without an "up": notice it here.
    if (had && e.buttons !== had) {
      mouse.buttons = e.buttons;
      for (let i = 0; i < 5; i++) {
        const bit = 1 << BUTTON_BIT[i];
        if ((had & bit) && !(e.buttons & bit)) emit('mouseup', mouseEvent('mouseup', e, i, true));
      }
    }
    mouse.buttons = e.buttons;
    mouse.dx += d.dx; mouse.dy += d.dy;
    const ev = mouseEvent('mousemove', e, -1);
    // Prefer raw movement (pointer-lock friendly); fall back to position deltas.
    ev.dx = d.dx; ev.dy = d.dy;
    emit('mousemove', ev);
  }

  function onPointerUp(e) {
    syncMods(e);
    track(e);
    mouse.buttons = e.buttons;
    if (e.button === 3 || e.button === 4) e.preventDefault();
    if (!e.buttons) { try { canvas.releasePointerCapture(e.pointerId); } catch { /* ignore */ } captured.delete(e.pointerId); }
    emit('mouseup', mouseEvent('mouseup', e, e.button));
  }

  function onPointerCancel(e) {
    captured.delete(e.pointerId);
    if (!mouse.buttons) return;
    const b = mouse.buttons; mouse.buttons = 0;
    for (let i = 0; i < 5; i++) if (b & (1 << BUTTON_BIT[i])) emit('mouseup', mouseEvent('mouseup', e, i, true));
  }

  function onLostCapture(e) {
    captured.delete(e.pointerId);
    // Capture ended while buttons were still down (window lost the pointer): end the drag cleanly.
    if (mouse.buttons && !captured.size) {
      queueMicrotask(() => {
        if (!mouse.buttons || captured.size) return;
        const b = mouse.buttons; mouse.buttons = 0;
        for (let i = 0; i < 5; i++) if (b & (1 << BUTTON_BIT[i])) emit('mouseup', mouseEvent('mouseup', e, i, true));
      });
    }
  }

  function onClick(e) { syncMods(e); track(e); emit('click', mouseEvent('click', e, e.button)); }
  function onDblClick(e) { syncMods(e); track(e); emit('dblclick', mouseEvent('dblclick', e, e.button)); }
  function onAuxClick(e) { if (e.button !== 0) e.preventDefault(); }
  function onContextMenu(e) { e.preventDefault(); }
  function onEnter() { mouse.over = true; }
  function onLeave() { mouse.over = false; }

  function onWheel(e) {
    e.preventDefault();               // never scroll / browser-zoom the page from the canvas
    syncMods(e);
    track(e);
    const n = normalizeWheel(e, win.innerHeight || 800);
    // Budget the total zoom over a short window (free-spinning wheels).
    const now = (win.performance && win.performance.now()) || Date.now();
    budget = budget.filter(b => now - b[0] < BUDGET_WINDOW);
    const used = budget.reduce((s, b) => s + b[1], 0);
    let lz = Math.log(n.zoom);
    const room = Math.max(0, BUDGET_MAX - used);
    if (Math.abs(lz) > room) lz = Math.sign(lz) * room;
    budget.push([now, Math.abs(lz)]);
    const zoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, Math.exp(lz)));
    mouse.zoom *= zoom;
    emit('wheel', {
      type: 'wheel', x: mouse.x, y: mouse.y, dx: n.dx, dy: n.dy, zoom, pinch: n.pinch,
      shift: mods.shift, ctrl: mods.ctrl, alt: mods.alt, meta: mods.meta, original: e,
    });
  }

  // ------------------------------------------------------------ navigation guards

  // Mouse back/forward buttons (3/4) must never navigate, wherever the pointer is.
  function blockNavButtons(e) { if (e.button === 3 || e.button === 4) e.preventDefault(); }

  function onBeforeUnload(e) {
    if (!unloadGuard) return undefined;
    e.preventDefault();
    e.returnValue = '';
    return '';
  }

  // History trap: with the guard on, a "back" (mouse button, swipe, Cmd+[) lands on our own entry and is re-armed.
  function armTrap() {
    if (trapArmed) return;
    try { win.history.pushState({ swTrap: true }, ''); trapArmed = true; } catch { /* sandboxed */ }
  }
  function onPopState() {
    if (!trapArmed) return;
    trapArmed = false;
    if (unloadGuard) armTrap();
  }

  function onBlur() { releaseAll(); }
  function onVisibility() { if (doc.hidden) releaseAll(); }

  // On game screens the right button belongs to the game: no browser menu over HUD panels either (text fields keep theirs).
  function onWindowContextMenu(e) { if (input.captureKeys && !isTyping(e.target)) e.preventDefault(); }

  // Ctrl/Cmd + wheel anywhere would zoom the whole page: stop that outside text fields too.
  function onWindowWheel(e) { if (e.ctrlKey && input.captureKeys) e.preventDefault(); }

  const subs = [
    [win, 'keydown', onKeyDown], [win, 'keyup', onKeyUp],
    [win, 'blur', onBlur], [doc, 'visibilitychange', onVisibility],
    [win, 'mousedown', blockNavButtons, true], [win, 'mouseup', blockNavButtons, true],
    [win, 'auxclick', blockNavButtons, true], [win, 'pointerup', blockNavButtons, true],
    [win, 'beforeunload', onBeforeUnload], [win, 'popstate', onPopState],
    [win, 'wheel', onWindowWheel, { passive: false }],
    [win, 'contextmenu', onWindowContextMenu, true],
    [canvas, 'pointerdown', onPointerDown], [canvas, 'pointermove', onPointerMove],
    [canvas, 'pointerup', onPointerUp], [canvas, 'pointercancel', onPointerCancel],
    [canvas, 'lostpointercapture', onLostCapture],
    [canvas, 'click', onClick], [canvas, 'dblclick', onDblClick], [canvas, 'auxclick', onAuxClick],
    [canvas, 'contextmenu', onContextMenu], [canvas, 'wheel', onWheel, { passive: false }],
    [canvas, 'pointerenter', onEnter], [canvas, 'pointerleave', onLeave],
    [canvas, 'dragstart', e => e.preventDefault()], [canvas, 'selectstart', e => e.preventDefault()],
  ];
  for (const [t, type, fn, opt] of subs) t.addEventListener(type, fn, opt);

  function dispose() {
    for (const [t, type, fn, opt] of subs) t.removeEventListener(type, fn, opt);
    releaseAll();
  }

  return input;
}
