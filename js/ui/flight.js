// Starwright — the flight screen: owns the live World, feeds it keyboard input, draws the 3D scene and the HUD,
// and hosts the orbital map.
//
//   createFlightScreen(app) → { enter(params), exit(), update(dt), render(), resize(w, h) }
//   enter({ craft: craftJSON, crew: [names], paid: true })   launch a new craft from the pad
//   enter({ resume: true, vesselId? })                       continue career.flightState
//
// Targeting, docking and fuel transfer go through the public World / Vessel API (world.setTarget, world.undock,
// vessel.transferResource, autopilot.dockingApproach); see actions.setTarget / undock / transfer / dockAssist.
//
// Test hooks: app.flight = { world, scene, camera, cam, setCameraMode, hud, ball, map, state, actions }
// (world is also window.__sw.world).
import { perf } from '../perf.js';
import * as THREE from '../lib/three.module.min.js';
import { World } from '../core/world.js';
import { stallSpeed, roverCruiseSpeed } from '../core/vessel.js';
import { Craft } from '../core/craft.js';
import { SYSTEM, BARGE } from '../core/bodies.js';
import { EXPERIMENTS, programStep } from '../core/career.js';
import { closestApproach } from '../core/trajectory.js';
import { el, fmt, showModal, isModalOpen } from './dom.js';
import { openSettings } from './hub.js';
import { createBase } from '../render/basegfx.js';
import { createFlightScene } from './flightscene.js';
import { engineKind } from '../render/fx.js';
import { createFlightCamera, MODE_LABEL } from './flightcam.js';
import { createNavball } from './navball.js';
import { createHud, injectFlightCss } from './hud.js';
import { stressCause, breakMessage } from './stress.js';

const QUICK_KEY = 'starwright.quicksave.v1';
// a scenario game (js/core/scenarios.js) keeps its quicksave apart from the player's own program
const quickKey = app => (app.career && app.career.scenario ? 'starwright.scenario.quicksave.v1' : QUICK_KEY);
const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
const REASONS = {
  crash: 'It hit the ground too hard.', impact: 'It struck the surface.', atmosphere: 'It burned up in the atmosphere.',
  overheat: 'It overheated and broke apart.', heat: 'It overheated and broke apart.', explosion: 'It exploded.',
};
const TARGET_MODES = new Set(['target', 'antiTarget', 'relPrograde', 'relRetrograde']);
const RES_NAME = { fuel: 'propellant', mono: 'monopropellant', elec: 'charge', xenon: 'xenon' };
const RES_UNIT = { fuel: 'kg', mono: 'kg', elec: 'EC', xenon: 'kg' };
const DOCK_ASSIST_RANGE = 1500;   // m: the docking assist takes over from here
/** Guidance programs (the Autopilot panel): what the alert line and the toasts call them. */
const PROGRAM_NAME = { ascent: 'Ascent assist', dock: 'Docking assist', takeoff: 'Take-off', hold: 'Heading and altitude hold', land: 'Runway landing',
  drive: 'Cruise control', node: 'Maneuver autopilot', landhere: 'Landing autopilot', deorbit: 'Deorbit burn', recovery: 'Booster return' };
const WARP_REASON = {
  atmosphere: 'entering the atmosphere', impact: 'close to the surface', soi: 'entering a new sphere of influence', node: 'maneuver coming up',
  thrust: 'engines are running', altitude: 'too low for that rate', warpTo: 'arrived', stage: 'staging', eva: 'spacewalk', switch: 'switched vessel',
  undock: 'undocking',
};

/** Default key for every remappable action (KeyboardEvent.code). Shift / Ctrl (throttle) and Alt are fixed. */
export const DEFAULT_KEYS = {
  pitchDown: 'KeyW', pitchUp: 'KeyS', yawLeft: 'KeyA', yawRight: 'KeyD', rollLeft: 'KeyQ', rollRight: 'KeyE',
  fullThrottle: 'KeyZ', cutThrottle: 'KeyX', stage: 'Space', sas: 'KeyT', rcs: 'KeyR', gear: 'KeyG', lights: 'KeyU', brakes: 'KeyB',
  abort: 'Backspace', map: 'KeyM', missions: 'KeyO', camera: 'KeyV', speedMode: 'KeyC', target: 'KeyY',
  warpUp: 'Period', warpDown: 'Comma', warpStop: 'Slash', nextVessel: 'BracketRight', prevVessel: 'BracketLeft', hopVessel: 'Backslash',
  screenshot: 'F1', hideHud: 'F2', quicksave: 'F5', quickload: 'F9',
  rcsForward: 'KeyH', rcsBack: 'KeyN', rcsUp: 'KeyI', rcsDown: 'KeyK', rcsLeft: 'KeyJ', rcsRight: 'KeyL',
  board: 'KeyF', flag: 'KeyP',
  stress: 'Semicolon',
};
const KEY_HELP = [
  ['Flying', [['pitchDown', 'Pitch down (wheels: drive forward)'], ['pitchUp', 'Pitch up (wheels: reverse)'], ['yawLeft', 'Yaw left (wheels: steer)'], ['yawRight', 'Yaw right (wheels: steer)'], ['rollLeft', 'Roll left'], ['rollRight', 'Roll right'],
    [null, 'Throttle up / down', ['Shift', 'Ctrl']], ['fullThrottle', 'Full throttle'], ['cutThrottle', 'Cut throttle'], ['stage', 'Fire the next stage'], [null, 'Fine controls', ['Caps Lock']]]],
  ['Systems', [['sas', 'SAS (stability assist)'], ['rcs', 'RCS thrusters'], ['gear', 'Landing legs and gear'], ['lights', 'Lights and solar panels'], ['brakes', 'Brakes (hold)'], ['abort', 'Abort group'], [null, 'Action groups', ['1', '…', '9']]]],
  ['RCS translation', [['rcsForward', 'Forward'], ['rcsBack', 'Back'], ['rcsUp', 'Up'], ['rcsDown', 'Down'], ['rcsLeft', 'Left'], ['rcsRight', 'Right']]],
  ['Navigation', [['map', 'Orbital map'], ['missions', 'Missions: program and contracts'], ['speedMode', 'Speed read-out: surface / orbit / target'], ['target', 'Next target (with Shift: clear)'], ['nextVessel', 'Next vessel'], ['prevVessel', 'Previous vessel'], ['hopVessel', 'Hop between booster and upper stage']]],
  ['Time', [['warpUp', 'Warp faster'], ['warpDown', 'Warp slower'], ['warpStop', 'Stop warp'], [null, 'Physics warp (engines may run)', ['Alt', '.']], ['quicksave', 'Quicksave (or Shift+K)'], ['quickload', 'Load quicksave (or Shift+L)']]],
  ['View', [['camera', 'Camera: orbital / chase / free / locked'], ['stress', 'Stress overlay: mark the load on every joint'], ['hideHud', 'Hide the instruments'], ['screenshot', 'Save a screenshot'], [null, 'Orbit the camera', ['Right-drag']], [null, 'Zoom', ['Wheel']], [null, 'Pause menu', ['Esc']]]],
  ['On a spacewalk', [[null, 'Walk / fly', ['W', 'A', 'S', 'D']], [null, 'Jump, or jetpack up', ['Space']], [null, 'Jetpack up / down', ['Shift', 'Ctrl']], ['rcs', 'Jetpack on / off'], ['board', 'Grab a hatch and board'], ['flag', 'Plant a flag']]],
];
const KEY_LABEL = { Space: 'Space', Period: '.', Comma: ',', Slash: '/', BracketLeft: '[', BracketRight: ']', Backspace: '⌫', Backquote: '`', Minus: '−', Equal: '=', Semicolon: ';', Quote: "'", Backslash: '\\', Enter: 'Return', Tab: 'Tab', ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→' };
const keyLabel = code => KEY_LABEL[code] || (code || '').replace(/^Key|^Digit/, '');
/** Keys the browser or macOS keeps for itself, and the fixed modifiers. */
const RESERVED = new Set(['Escape', 'ShiftLeft', 'ShiftRight', 'ControlLeft', 'ControlRight', 'AltLeft', 'AltRight', 'MetaLeft', 'MetaRight', 'CapsLock', 'F3', 'F4', 'F6', 'F7', 'F8', 'F10', 'F11', 'F12', 'Tab']);

export function createFlightScreen(app) {
  injectFlightCss();
  // the 3D space centre stands at the launch site (the flight scene falls back to a plain pad without it)
  app.flightBaseFactory = opts => createBase({ vegetation: (app.settings && app.settings.gfxVegetation) || 'auto', ...opts, planetRadius: SYSTEM.home.radius });
  const K = name => (app.settings && app.settings.keys && app.settings.keys[name]) || DEFAULT_KEYS[name];
  let world = null, scene = null, cam = null, ball = null, hud = null, map = null, mapModule = null, autopilot = null;
  let career = null;
  let unsub = null, offs = [];
  let paused = false, mapOpen = false, entered = false, leaving = false;
  let speedMode = 'surface', aboveLine = null, lastVesselId = null;
  let launchSnap = null, resumeSnap = null, quick = null, assist = null, assistKind = '';
  let caAcc = 1, caKey = '', lastTarget = null, targetLostAt = -1;
  let legToastAt = -1e9, legToastType = '';
  let tickAcc = 0, lostInfo = null, lostCrew = [], shiftHeld = 0, shiftBlocked = false;
  let lastSimDt = 0, lastToast = { text: '', t: 0 };
  let hintAcc = 1, hintCur = null, hintHold = 0;
  let fine = false, brakeHeld = false, brakeLock = false, warnAcc = 0, lastSit = '', beepAcc = 0;
  const hintGone = new Set();   // hint ids the player closed during this flight
  let controlled = null;      // the vessel the player was flying most recently
  // structure: the overlay switch (kept from flight to flight), and what was loading each strained joint when it was
  // last looked at (part id pair → cause), so that the message for a break can say why
  let stressOn = false, sepUt = -1;
  const strain = new Map();
  const strainKey = (a, b) => a * 1048576 + b;
  const state = { speedMode: 'surface', paused: false, assist: null, assistKind: '', mapOpen: false, heading: 0, pitch: 90, approach: null, fine: false, danger: 0, rumble: 0, buffet: 0, roll: 0 };
  const v1 = new THREE.Vector3(), v2 = new THREE.Vector3(), v3 = new THREE.Vector3(), q1 = new THREE.Quaternion();
  const markerDirs = { prograde: new THREE.Vector3(), retrograde: new THREE.Vector3(), normal: new THREE.Vector3(), antinormal: new THREE.Vector3(), radialOut: new THREE.Vector3(), radialIn: new THREE.Vector3(), maneuver: new THREE.Vector3(), target: new THREE.Vector3(), antiTarget: new THREE.Vector3() };

  const active = () => (world && world.active && !world.active.dead ? world.active : null);
  const flyable = v => v && !v.dead && (v.type === 'ship' || v.type === 'eva');
  // Guidance programs that keep flying their vessel while the player watches another one (a booster and its upper
  // stage): vessel id → { ctl, kind }. Only programs that never touch time warp may be parked.
  const parked = new Map();
  const PARKABLE = new Set(['ascent', 'recovery']);
  // The vessels of this flight that the hop key steps between: the one launched and every flyable stage it drops.
  const family = new Set();

  function toast(text, kind = 'info') {
    const now = performance.now();
    if (text === lastToast.text && now - lastToast.t < 1800) return;
    lastToast = { text, t: now };
    app.toast(text, kind);
  }

  // ------------------------------------------------------------------ world wiring
  function bindWorld(w) {
    if (unsub) { try { unsub(); } catch { /* old world */ } }
    world = w;
    app.world = w; if (app.career && app.career.limitOf) w.commGroundRange = app.career.limitOf('tracking');   // Tracking Station level sets the ground station's reach
    unsub = w.on('*', (data, type) => onWorldEvent(type, data || {}));
    assist = null; assistKind = ''; lostInfo = null; lostCrew = []; aboveLine = null; lastVesselId = null;
    lastTarget = null; state.approach = null; caKey = ''; caAcc = 1;
    strain.clear(); sepUt = -1;
    parked.clear(); family.clear();
    for (const x of w.vessels) x.program = null;      // a program does not outlive the screen that was running it
    if (!active()) { const next = w.vessels.find(flyable); if (next) w.switchTo(next); }
    controlled = active();
    if (app.flight) app.flight.world = w;
    if (hud) { hud.invalidate(); hud.hideCenter(); hud.closePanels(); }
    if (cam && active()) cam.frame(active());
  }

  function reportMilestones(list) {
    if (!list || !list.length) return;
    if (career && career.scenario) return;        // a scenario has its own goal and notices: the flight program stays quiet
    let cheer = false;
    for (const m of list) {
      const bits = [];
      if (m.funds && career.usesFunds) bits.push((m.funds < 0 ? '−' : '') + fmt.funds(Math.abs(m.funds)));
      if (m.science) bits.push('+' + m.science + ' science');
      if (m.rep && m.kind === 'contract' && career.usesFunds) bits.push((m.rep > 0 ? '+' : '−') + Math.abs(m.rep) + ' reputation');
      const tail = bits.length ? '  ·  ' + bits.join('  ') : '';
      if (m.kind === 'contract') {
        // contract notices already carry their own headline ("Contract complete — …", "Objective complete — …")
        if (m.outcome === 'failed') app.toast(m.title + tail, 'bad', 7000);
        else if (m.outcome === 'objective') app.toast(m.title, 'info', 5000);
        else { app.toast(m.title + tail, 'good', 6000); cheer = true; }
      } else { app.toast('Milestone: ' + m.title + tail, 'good', 6000); cheer = true; }
    }
    if (cheer) app.audio.play('success');
    // the flight program always names the next goal when one of its missions is flown
    if (list.some(m => m.kind !== 'contract' && programStep(m.milestoneId || m.id)) && career.nextProgramStep) {
      const nx = career.nextProgramStep();
      if (nx) app.toast('Next mission: ' + nx.title + '. ' + nx.desc, 'info', 7000);
    }
  }

  function onWorldEvent(type, p) {
    let done = null;
    try { done = career.onEvent(type, p, world); } catch (err) { console.warn('[flight] career.onEvent failed for ' + type + ':', err && err.message); }
    reportMilestones(done);
    if (scene) scene.onWorldEvent(type, p, world);
    const mine = p.vessel && (p.vessel === controlled || p.vessel === world.active);
    switch (type) {
      case 'stage':
        app.audio.play('stage');
        if (mine && hud) hud.invalidate();
        break;
      case 'decouple':
        // (the piece a broken joint lets go arrives here too, with no part, in the same step as its `structure` event,
        // which has its own sound: a separation without a part waits until the step is over to find out which it was)
        if (mine && p.part == null) sepUt = world.ut;
        else if (mine) { app.audio.play('decouple'); if (cam) cam.kick(0.35); }
        // a dropped stage that can still be flown: it stays in the flight, and the hop key reaches it
        if (p.debris && p.debris.type === 'ship' && p.vessel && (mine || family.has(p.vessel.id))) {
          family.add(p.vessel.id); family.add(p.debris.id);
          const b = p.debris;
          // a stage built to come back (engine, propellant and legs) starts flying itself home at once
          if (autopilot && b.engines && b.engines.length && (b.legParts || []).length && b.body === SYSTEM.home && b.enginePower().thrust > 0 && !parked.has(b.id)) {
            try {
              parked.set(b.id, { ctl: autopilot.boosterRecovery(world, b, { target: landingTarget() }), kind: 'recovery' });
              b.program = 'recovery';
              toast(b.name + ' is flying itself back to land. Press ' + keyLabel(K('hopVessel')) + ' to watch it or take over.', 'good');
            } catch (err) { console.warn('[flight] booster return failed to start:', err && err.message); }
          } else if (b.engines && b.engines.length) toast(b.name + ' is flying on its own. Press ' + keyLabel(K('hopVessel')) + ' to fly it.', 'info');
        }
        break;
      case 'structure':
        // a joint broke: say where and why in plain words (the sparks are the scene's, flightscene.onWorldEvent)
        if (mine) {
          if (sepUt === world.ut) sepUt = -1;
          const j = p.joint || {};
          app.toast(breakMessage(p, strain.get(strainKey(j.a, j.b)) || (p.loads ? stressCause(p.loads) : undefined)), 'bad', 7000);
          app.audio.play('snap');
          if (cam) cam.kick(0.7);
          if (hud) { hud.invalidate(); hud.flashStress(); }
          refreshHint(true);
        }
        break;
      case 'stress':
        // the most loaded joint has passed its warning level: the hull groans and the read-out flashes
        if (mine) { app.audio.play('creak', { volume: 0.9 }); if (hud) hud.flashStress(); }
        break;
      case 'liftoff':
        if (mine) { toast(p.vessel.launchSite === 'runway' && (p.vessel.wheelParts || []).length >= 2 ? 'Airborne!' : 'Liftoff!', 'good'); refreshHint(true); if (hud) hud.cheer(5); }
        break;
      case 'rollout':
        // a vehicle that drives off has started its mission: the clock runs from here (vessel.launchUt)
        if (mine) { toast('Rolling: the mission clock is running', 'info'); refreshHint(true); if (hud) hud.invalidate(); }
        break;
      case 'actionGroup': if (mine && hud) hud.invalidate(); break;
      case 'explosion': app.audio.play('explosion'); break;
      case 'crewLost':
        if (p.name) { lostCrew.push(p.name); app.toast(p.name + ' was lost.', 'bad', 6000); }
        break;
      case 'destroyed':
        if (p.vessel === controlled) lostInfo = { name: p.vessel.name, reason: p.reason, type: p.vessel.type };
        break;
      case 'landed':
        if (mine) { app.audio.play('land'); toast('Touchdown at ' + fmt.num(p.speed || 0, 1) + ' m/s', 'good'); if (hud) hud.cheer(5); if (cam) cam.kick(Math.min(1, (p.speed || 0) / 8)); }
        break;
      case 'legBottom':
      case 'legBroke':
        // one message for the craft, not one a leg
        if (mine && !(performance.now() - legToastAt < 2500 && legToastType === type)) {
          legToastAt = performance.now(); legToastType = type;
          if (type === 'legBroke') toast('Too hard: the landing legs bottomed out and collapsed', 'bad');
          else { toast('Hard landing: the legs ran out of travel', 'warn'); if (cam) cam.kick(0.8); }
        }
        break;
      case 'splashed':
        if (mine) { app.audio.play('splash'); toast('Splashdown!', 'good'); if (hud) hud.cheer(5); }
        break;
      case 'soi':
        if (mine && p.to) toast('Now under the pull of ' + p.to.name, 'info');
        break;
      case 'flameout':
        if (mine && p.part) toast((p.part.def ? p.part.def.name : 'Engine') + ' has run dry', 'warn');
        break;
      case 'chute':
        if (mine) {
          if (p.state === 'semi' || p.state === 'full') app.audio.play('chute');
          toast(p.state === 'armed' ? 'Parachute armed' : p.state === 'semi' ? 'Parachute out (reefed)' : p.state === 'full' ? 'Parachute fully open' : p.state === 'cut' ? 'Parachute torn away!' : 'Parachute ' + p.state, p.state === 'cut' ? 'bad' : 'info');
        }
        break;
      case 'warp':
        if (p.reason && p.reason !== 'user' && p.reason !== 'launch' && p.reason !== 'warpTo' || (p.reason === 'warpTo' && p.index === 0)) {
          if (p.index === 0 && WARP_REASON[p.reason]) toast('Time warp stopped: ' + WARP_REASON[p.reason], p.reason === 'warpTo' ? 'info' : 'warn');
          else if (p.reason !== 'warpTo' && WARP_REASON[p.reason]) toast('Time warp slowed to ' + p.rate + '×: ' + WARP_REASON[p.reason], 'warn');
        }
        break;
      case 'target':
        if (p.vessel && p.vessel === (world.active || controlled)) {
          const prev = lastTarget;
          lastTarget = p.target || null;
          caKey = ''; caAcc = 1; state.approach = null;
          if (!p.target) {
            const v = p.vessel;
            if (TARGET_MODES.has(v.ctrl.sasMode)) { v.ctrl.sasMode = 'hold'; v.sasTarget = null; }
            if (speedMode === 'target') setSpeedMode(v.altitude > speedLine(v) ? 'orbit' : 'surface');
            if (assist && assistKind === 'dock' && !(prev && prev.absorbedInto === v)) dropAssist('Docking assist off: no target');
            // "Target lost" (it is gone) and docking (it is part of this vessel now) have their own messages
            if (prev && !prev.dead && world.ut !== targetLostAt) toast('Target cleared', 'info');
          } else if (p.target !== prev) toast('Target: ' + p.target.name, 'info');
          if (hud) hud.refreshPanels();
        }
        break;
      case 'dock': {
        const a = p.vessel, b = p.absorbed;
        const here = a && (a === controlled || a === world.active);
        if (here) { controlled = a; if (cam) cam.frame(a, { keepAngles: true }); }
        if (a && b) app.toast(here ? 'Docked with ' + b.name + '. Fuel can be moved between the two (Fuel button).' : a.name + ' docked with ' + b.name, 'good', 6000);
        app.audio.play('stage');
        if (map && map.selection === b) { try { map.select(null); } catch { /* map closed */ } }
        if (hud) { hud.invalidate(); hud.refreshPanels(); }
        break;
      }
      case 'undock': {
        const a = p.vessel, b = p.other;
        if (a && b) app.toast(a === world.active || a === controlled ? 'Undocked from ' + b.name : a.name + ' undocked from ' + b.name, 'info', 5000);
        app.audio.play('stage');
        if (a && a === world.active && cam) cam.frame(a, { keepAngles: true });
        if (hud) { hud.invalidate(); hud.refreshPanels(); }
        break;
      }
      case 'message': {
        if (!p.text) break;
        if (p.text === 'Target lost') targetLostAt = world.ut;
        if (p.kind === 'removed') {
          // a vessel on rails burned up or hit the ground: nothing on screen may keep pointing at it
          const gone = p.vessel;
          if (gone) {
            if (map && map.selection === gone) { try { map.select(null); } catch { /* map closed */ } }
            if (lastTarget === gone) lastTarget = null;
            if (controlled === gone) controlled = active();
          }
          if (hud) hud.refreshPanels();
          toast(p.text, gone && gone.type === 'debris' ? 'info' : 'warn');
          break;
        }
        // "Time warp limited to 4× (thrust)" → plain English
        const m = /^Time warp limited to (\S+) \((\w+)\)$/.exec(p.text);
        const a = world.active;
        const why = m && { thrust: 'while the engines are running', atmosphere: 'inside the atmosphere', altitude: 'this close to ' + (a ? a.body.name : 'the ground') + ' (climb higher for more)', impact: 'this close to the surface' }[m[2]];
        toast(m ? 'Time warp is limited to ' + m[1] + (why ? ' ' + why : ' here') : p.text, 'warn');
        break;
      }
      case 'board': toast(p.name + ' is back aboard', 'good'); break;
      default: break;
    }
  }

  // ------------------------------------------------------------------ helpers
  // ------------------------------------------------------------------ contextual hints
  // One short line that tells a new pilot what to do next. Teaching tips stop once Verda orbit has been reached;
  // the practical ones (out of fuel, parachute, legs, recover) stay. Everything respects settings.showHints and
  // a tip closed with × stays closed for the rest of the flight.
  const padT = new WeakMap();     // vessel → when it was first seen at full throttle on the pad
  function padSince(v) { if (!padT.has(v)) padT.set(v, world.ut); return padT.get(v); }
  function pickHint(v) {
    if (!v || v.type !== 'ship' || !hud || hud.centerVisible || assist) return null;
    const ms = career.milestones || new Set();
    const novice = !ms.has('orbit_verda');
    const body = v.body, atmoH = body.atmo ? body.atmo.height : 0;
    const engines = v.engines || [];
    const lit = engines.filter(e => e.part.ignited);
    const alive = lit.some(e => !e.part.flameout);
    const liquidLit = lit.some(e => !e.part.flameout && e.part.def.engine.type !== 'solid');
    const c = v.ctrl;
    if (v.situation === 'prelaunch' && v.surface && v.surface.vehicle) {
      // on its wheels at the runway threshold: an aeroplane or a rover
      const driven = (v.wheelParts || []).some(p => p.def.wheel.drive > 0);
      if (!engines.length) return driven ? { id: 'rover', items: [['B', 'release the brake'], ['W S', 'drive'], ['A D', 'steer'], ['U', 'lights']] } : null;
      if (v.stageIndex === 0) return { id: 'runway', items: [['Space', 'start the engine'], ['Z', 'full throttle'], ['B', 'release the brakes'], ['S', 'pull up at about ' + Math.round(runwaySpeed(v)) + ' m/s'], ['G', 'gear up']] };
      if (c.brake) return { id: 'runway-brake', items: [['B', c.throttle < 0.05 ? 'Brakes are on: Z for full throttle, then B to roll' : 'Brakes are on: press B to roll']] };
      if (c.throttle < 0.05) return { id: 'pad-throttle', items: [['Z', 'Engine is running but the throttle is at zero: press Z']] };
      return { id: 'rotate', items: [['S', 'Hold the centreline with A / D and pull up gently at about ' + Math.round(runwaySpeed(v)) + ' m/s']] };
    }
    if (v.situation === 'prelaunch') {
      if (v.stageIndex === 0) {
        const firstLiquid = (v.stages[0] || []).some(id => { const p = v.parts.get(id); return p && p.def.engine && p.def.engine.type !== 'solid'; });
        if (!ms.has('first_launch')) return { id: 'pad-first', items: [['Z', 'full throttle'], ['Space', 'launch / next stage'], ['D', 'tilt east'], ['M', 'map'], ['T', 'SAS on / off (it is ' + (c.sas ? 'on' : 'off') + ')']] };
        if (firstLiquid && c.throttle < 0.05) return { id: 'pad', items: [['Z', 'full throttle, then'], ['Space', 'to launch']] };
        return { id: 'pad', items: [['Space', 'Press Space to launch']] };
      }
      if (liquidLit && c.throttle < 0.05) return { id: 'pad-throttle', items: [['Z', 'Engine is lit but the throttle is at zero: press Z (or hold Shift)']] };
      if (alive && v.thrust > 0 && c.throttle > 0.95 && world.ut - padSince(v) > 2.5) {
        const w = v.mass * body.gm / Math.max(1, v.pos.lengthSq());
        if (v.thrust < w) return { id: 'twr', items: [[null, 'Not enough thrust to lift off (thrust is ' + Math.round(v.thrust / w * 100) + '% of the weight). Stage with Space, or revert from the Esc menu and add engines.']] };
      }
      return null;
    }
    if (v.landed) {
      if (body === SYSTEM.home) return { id: 'recover', items: [[null, 'Down safe. Press Recover (top right) to bank the science and get the parts back.']] };
      return null;
    }
    const falling = v.verticalSpeed < -8;
    const chuteWaiting = (v.chuteParts || []).some(p => p.deployed === 'stowed');
    // falling through air with a parachute still packed
    if (atmoH && falling && v.altitude < Math.min(atmoH * 0.45, 30000) && chuteWaiting && !(v.thrust > 0)) {
      return { id: 'chute', items: [['Space', v.hasEngineStagesLeft() ? 'Falling: press Space until the parachute is armed' : 'Falling: press Space to arm the parachute']] };
    }
    // dry tanks with more rocket below the next separator
    if (lit.length && !alive && v.hasEngineStagesLeft() && (c.throttle > 0 || v.situation === 'flying' || v.situation === 'suborbital')) {
      return { id: 'dry', items: [['Space', 'Out of fuel: press Space to stage']] };
    }
    if (alive && liquidLit && c.throttle < 0.02 && v.situation === 'flying' && falling && v.radarAlt < 4000 && !chuteWaiting) return { id: 'throttle', items: [['Z', 'Throttle is at zero']] };
    if (atmoH && body === SYSTEM.home && (v.situation === 'flying' || v.situation === 'suborbital')) {
      const apUp = v.apoapsis > atmoH + 1000, peUp = v.periapsis > atmoH;
      if (apUp && !peUp && v.thrust > 0 && c.throttle > 0 && v.altitude < atmoH && liquidLit && v.verticalSpeed > 0) {
        return { id: 'cut', items: [['X', 'Apoapsis above ' + Math.round(atmoH / 1000) + ' km: cut throttle (X) and plan a circularisation burn in the map (M)']] };
      }
      if (novice && apUp && !peUp && !(v.thrust > 0) && v.verticalSpeed > 0 && !v.nodes.length && (v.deltaV || 0) > 300) {
        return mapOpen ? { id: 'plan-map', items: [[null, 'Click your orbit near the apoapsis (Ap) to plan the circularisation burn, then drag the prograde handle']] } : { id: 'plan', items: [['M', 'Coasting up. Open the map and click your orbit near the apoapsis to plan the circularisation burn']] };
      }
      if (novice && v.thrust > 0 && v.verticalSpeed > 30 && v.altitude > 900 && v.altitude < 9000 && state.pitch > 84 && liquidLit && (v.deltaV || 0) > 2500) {
        return { id: 'turn', items: [['D', 'Start the gravity turn: hold D to tip the nose about 10° east, then let it fall over slowly']] };
      }
    }
    if (v.nodes.length && !(v.thrust > 0)) {
      const node = v.nodes[0], tTo = node.t - world.ut;
      const bt = Number.isFinite(state.burnTime) ? state.burnTime : 0;
      if (novice && tTo > 0 && c.sasMode !== 'maneuver') return { id: 'node-aim', items: [[null, 'Maneuver planned: click the star button beside the ball to aim at it; burn (Z) at T− ' + fmt.time(Math.max(1, bt / 2))]] };
      if (tTo > 0 && tTo < bt / 2 + 3 && alive) return { id: 'node-burn', items: [['Z', 'Burn now, cut with X when the burn read-out reaches zero']] };
    }
    if (!atmoH && falling && v.radarAlt < 6000 && (v.legParts || []).length && !v.legsDown) return { id: 'legs', items: [['G', 'Lower the landing legs']] };
    const elec = v.resources && v.resources.elec;
    if (elec && elec.max > 0 && elec.amount / elec.max < 0.25 && (v.solarParts || []).length && !v.solarOut && v.altitude > atmoH) return { id: 'solar', items: [['U', 'Charge is low: unfold the solar panels']] };
    // close to a vessel with a matching free port: say how docking works (once per flight unless dismissed)
    const ti = v.targetInfo;
    if (ti && ti.kind === 'vessel' && ti.distance < 300 && !v.landed && (v.dockPorts || []).length) {
      const t = world.getTarget(v);
      if (t && (t.dockPorts || []).some(q => v.dockPorts.some(m => m.def.dock.size === q.def.dock.size))) {
        return { id: 'dock', items: [['R', 'RCS on'], ['H N', 'forward / back'], ['I K J L', 'slide'], [null, 'touch the rings together under 1.5 m/s']] };
      }
    }
    return null;
  }
  /** Rotation speed for the take-off hint: a little above the stall speed (the core knows the wing). */
  function runwaySpeed(v) { let s = NaN; try { s = stallSpeed(v) * 1.15; } catch { s = NaN; } return Number.isFinite(s) && s > 5 ? s : 60; }
  function refreshHint(now = false) {
    if (!hud) return;
    hintAcc = 0;
    const on = !!(app.settings && app.settings.showHints !== false);
    let h = null;
    if (on && !paused) { try { h = pickHint(active()); } catch { h = null; } }
    if (h && hintGone.has(h.id)) h = null;
    // do not flicker: a hint that just appeared stays for a moment unless something else replaces it
    if (!h && hintCur && hintHold > 0 && !now && on && !hintGone.has(hintCur.id)) return;
    if ((h && h.id) !== (hintCur && hintCur.id)) hintHold = 1.2;
    hintCur = h;
    hud.setHint(h);
  }

  function setSpeedMode(mode, v = active()) {
    speedMode = mode; state.speedMode = mode;
    if (v) {
      const m = v.ctrl.sasMode;
      if (mode === 'surface') { if (m === 'prograde') v.ctrl.sasMode = 'srfPrograde'; else if (m === 'retrograde') v.ctrl.sasMode = 'srfRetrograde'; }
      else { if (m === 'srfPrograde') v.ctrl.sasMode = 'prograde'; else if (m === 'srfRetrograde') v.ctrl.sasMode = 'retrograde'; }
    }
  }
  function dropAssist(msg) {
    if (!assist) return;
    const v = assist.vessel || active();
    assist = null; assistKind = '';
    if (v && !v.dead) releaseControls(v);
    if (world && world.warpTarget !== null && world.cancelWarpTo) world.cancelWarpTo();
    if (msg) toast(msg, 'info');
    if (hud) hud.refreshPanels();
  }
  /** Hand the vessel back to the pilot in a calm state after a guidance program. */
  function releaseControls(v) {
    const c = v.ctrl;
    c.sas = true; c.sasMode = 'hold'; v.sasTarget = null; c.tx = c.ty = c.tz = 0; c.drive = 0; c.steer = 0; c.pitch = c.yaw = c.roll = 0;
  }
  const assistName = () => PROGRAM_NAME[assistKind] || 'Guidance';
  /** Distance between two vessels / a vessel and a body, in metres (works across spheres of influence). */
  function rangeTo(a, obj) {
    if (obj.pos && obj.body) {
      if (obj.body === a.body) return a.pos.distanceTo(obj.pos);
      return v1.copy(obj.pos).add(obj.body.globalPosAt(world.ut, v2)).sub(a.pos).sub(a.body.globalPosAt(world.ut, v2)).length();
    }
    if (obj === a.body) return a.pos.length();
    return obj.globalPosAt(world.ut, v1).sub(a.body.globalPosAt(world.ut, v2)).sub(a.pos).length();
  }
  /** Closest approach to the target on the present orbits (same central body, closed orbits), refreshed about once a second. */
  function refreshApproach(v) {
    const ti = v && v.targetInfo;
    let out = null;
    if (ti && !v.landed && v.type !== 'eva') {
      try {
        const t = world.getTarget(v);
        let other = null;
        if (t && ti.kind === 'vessel' && t.body === v.body && !t.landed) other = t.getOrbit(world.ut);
        else if (t && ti.kind === 'body' && t.parent === v.body && t.orbit) other = t.orbit;
        const mine = other ? v.getOrbit(world.ut) : null;
        if (mine && !mine.hyper && !other.hyper && mine.periapsis > v.body.radius) {
          const span = Math.max(mine.period, other.period);
          if (Number.isFinite(span) && span > 0) {
            const ca = closestApproach(mine, other, world.ut, world.ut + span);
            if (ca && Number.isFinite(ca.distance)) out = { t: ca.t, distance: ca.distance, relSpeed: ca.relSpeed };
          }
        }
      } catch { out = null; }
    }
    state.approach = out;
  }
  function speedLine(v) { return v.body.atmo ? v.body.atmo.height / 2 : 30000; }

  function nearbyVessels() {
    const a = active() || controlled;
    const list = world.vessels.filter(v => flyable(v));
    list.sort((x, y) => x.id - y.id);
    if (!a) return list;
    const far = world.tracked || [];                  // a booster or an upper stage flown at any distance counts as nearby
    const near = list.filter(v => v === a || far.includes(v) || family.has(v.id) || (v.body === a.body && v.pos.distanceTo(a.pos) < 2500));
    return near.length > 1 ? near : list;
  }
  function switchVessel(dir) {
    const list = nearbyVessels();
    if (list.length < 2) { toast('No other vessel nearby', 'info'); return; }
    const i = list.indexOf(active());
    const next = list[(i + dir + list.length) % list.length];
    takeControl(next);
  }
  /** The hop key: step between the vessels of this flight (the upper stage and the boosters it dropped). */
  function hopVessel() {
    const a = active();
    const list = world.vessels.filter(v => flyable(v) && v.type === 'ship' && (v === a || family.has(v.id) || (world.tracked || []).includes(v)));
    list.sort((x, y) => x.id - y.id);
    if (list.length < 2) { toast('No booster or upper stage to hop to', 'info'); return; }
    takeControl(list[(list.indexOf(a) + 1) % list.length]);
  }
  function takeControl(v) {
    const from = active(), fromAssist = assist, fromKind = assistKind;
    if (!v || !world.switchTo(v)) return false;
    // a program that can fly on by itself keeps flying the vessel that is being left
    if (from && from !== v && !from.dead && fromAssist && !fromAssist.done && PARKABLE.has(fromKind) && (fromAssist.vessel || from) === from) {
      parked.set(from.id, { ctl: fromAssist, kind: fromKind });
      from.program = fromKind;
    }
    controlled = v; assist = null; assistKind = ''; lostInfo = null;
    const back = parked.get(v.id);
    if (back) { parked.delete(v.id); v.program = null; if (!back.ctl.done) { assist = back.ctl; assistKind = back.kind; } }
    lastTarget = world.getTarget(v); caKey = ''; caAcc = 1; state.approach = null;
    cam.frame(v, { keepAngles: true });
    hud.invalidate(); hud.hideCenter();
    aboveLine = null;
    toast('Now flying ' + v.name, 'info');
    return true;
  }

  // ------------------------------------------------------------------ actions (keyboard + HUD buttons)
  const actions = {
    stage() {
      const v = active(); if (!v || v.type !== 'ship' || paused) return;
      if (v.stageIndex >= v.stages.length) { toast('No stages left', 'info'); return; }
      world.stage();
      refreshHint(true);
    },
    toggleSas() { const v = active(); if (!v) return; v.ctrl.sas = !v.ctrl.sas; if (v.ctrl.sas && (v.ctrl.sasMode === 'direction' || (TARGET_MODES.has(v.ctrl.sasMode) && !v.targetInfo))) v.ctrl.sasMode = 'hold'; },
    toggleRcs() { const v = active(); if (!v) return; v.ctrl.rcs = !v.ctrl.rcs; },
    /** Stress overlay: a band at every joint of the vessels in view, coloured by its load. → the new state. */
    toggleStress(force) {
      stressOn = force !== undefined ? !!force : !stressOn;
      if (scene && scene.setStressOverlay) scene.setStressOverlay(stressOn);
      if (hud) hud.setStressOverlay(stressOn);
      app.audio.play('switch');
      const v = active();
      toast(!stressOn ? 'Stress overlay off' : v && !v.structure ? 'Stress overlay on (this vessel is a single part: no joints)' : 'Stress overlay on: teal is easy, amber is working hard, red is close to breaking');
      return stressOn;
    },
    get stressOverlay() { return stressOn; },
    /** The key cap of a remappable action, as the controls dialog shows it. */
    keyLabel(name) { return keyLabel(K(name)); },
    /** G: landing legs and retractable wheels together. */
    toggleLegs() {
      const v = active(); if (!v) return;
      const legs = (v.legParts || []).length > 0, gear = actions.hasGear(v);
      if (!legs && !gear) return;
      const down = !actions.gearDown(v);
      if (legs && typeof v.setLegs === 'function') v.setLegs(down); else if (legs && v.legsDown !== down) v.toggleLegs();
      if (gear && typeof v.setGear === 'function') v.setGear(down);
      app.audio.play('gear');
      toast((legs && gear ? 'Legs and gear ' : legs ? 'Landing legs ' : 'Landing gear ') + (down ? 'down' : 'up'));
    },
    hasGear(v) { return !!v && v.hasGear === true; },
    gearDown(v) { if (!v) return false; const legs = (v.legParts || []).length > 0; return (legs ? !!v.legsDown : true) && (v.hasGear === true ? !!v.gearDown : true) && (legs || v.hasGear === true); },
    toggleSolar() { const v = active(); if (!v || !(v.solarParts || []).length) return; app.audio.play('switch'); toast(v.toggleSolar() ? 'Solar panels out' : 'Solar panels folded'); },
    /** true / false, or null when the vessel carries no lamps (or the core has none). */
    lightState(v) { return v && (v.lightParts || []).length && typeof v.toggleLights === 'function' ? !!v.lightsOn : null; },
    toggleLights() { const v = active(); if (!v || actions.lightState(v) === null) return; app.audio.play('switch'); toast(v.toggleLights() ? 'Lights on' : 'Lights off'); },
    /** U: lights and solar panels. */
    toggleLightsAndPanels() {
      const v = active(); if (!v) return;
      const lamps = actions.lightState(v) !== null, panels = (v.solarParts || []).length > 0;
      if (lamps) actions.toggleLights();
      if (panels) actions.toggleSolar();
      if (!lamps && !panels) toast('No lights or solar panels aboard', 'info');
    },
    /** true / false, or null when there is nothing to brake with. */
    brakeState(v) { return v && typeof v.setBrakes === 'function' && ((v.wheelParts || []).length || (v.airbrakeParts || []).length) ? !!v.ctrl.brake : null; },
    setBrakes(on) { const v = active(); if (!v || actions.brakeState(v) === null) return; if (!!v.ctrl.brake !== !!on) v.setBrakes(!!on); },
    /** Click on the BRK lamp: lock the brakes on / release them. */
    toggleBrakes() { const v = active(); if (!v || actions.brakeState(v) === null) return; brakeLock = !v.ctrl.brake; v.setBrakes(brakeLock); app.audio.play('switch'); toast(brakeLock ? 'Brakes locked' : 'Brakes released'); },

    // ---- action groups (number keys, Backspace = abort). The core stores them per vessel as { key: [{ part, action }] }.
    groupList() {
      const v = active(); if (!v || v.type !== 'ship') return [];
      const g = v.actionGroups || {};
      const out = [];
      for (let i = 1; i <= 9; i++) { const list = g[i] || g['custom' + i] || g['group' + i] || []; out.push({ key: String(i), label: String(i), name: 'Group ' + i, count: list.length }); }
      const ab = g.abort || [];
      out.push({ key: 'abort', label: '⌫', name: 'Abort', count: ab.length });
      return out;
    },
    fireGroup(key) {
      const v = active(); if (!v || v.type !== 'ship' || paused) return false;
      if (!v.controllable) { toast('No control', 'warn'); return false; }
      key = String(key);
      const name = key === 'abort' ? 'Abort group' : 'Group ' + key;
      let done = null;
      try {
        if (typeof world.fireGroup === 'function') done = world.fireGroup(key, v);
        else if (typeof v.fireGroup === 'function') done = v.fireGroup(key);
        else if (typeof world.fireActionGroup === 'function') done = world.fireActionGroup(v, key);
        else if (typeof v.fireActionGroup === 'function') done = v.fireActionGroup(key);
        else done = fireGroupFallback(v, key);
      } catch (err) { console.warn('[flight] action group failed:', err && err.message); done = false; }
      if (done === false || done === 0 || done === null || (Array.isArray(done) && !done.length)) { toast(name + ': nothing assigned (set groups up in the hangar)', 'info'); return false; }
      app.audio.play('switch'); toast(name + ' fired', 'good');
      hud.invalidate();
      return true;
    },
    /** Move a Pip to the next part with a free seat. */
    transferCrew(name) {
      const v = active(); if (!v || v.type !== 'ship') return false;
      const seats = v.partList.filter(p => (p.def.crew || 0) > 0);
      const from = seats.find(p => p.crew.includes(name));
      if (!from) return false;
      const i = seats.indexOf(from);
      for (let k = 1; k < seats.length; k++) {
        const to = seats[(i + k) % seats.length];
        if (to.crew.length >= to.def.crew) continue;
        let ok = false;
        try {
          if (typeof v.transferCrew === 'function') ok = !!v.transferCrew(name, to.id);
          else if (typeof v.moveCrew === 'function') ok = !!v.moveCrew(name, to.id);
          else { from.crew.splice(from.crew.indexOf(name), 1); to.crew.push(name); ok = true; }
        } catch { ok = false; }
        if (ok) { app.audio.play('switch'); toast(name + ' moved to the ' + to.def.name, 'good'); hud.invalidate(); hud.refreshPanels(); return true; }
      }
      toast('No free seat to move to', 'info');
      return false;
    },
    screenshot() { shot(); },
    setSasMode(mode) {
      const v = active(); if (!v) return;
      if (mode === 'maneuver' && !v.nodes.length) { toast('No maneuver planned. Open the map (M) and click your orbit.', 'info'); return; }
      if (TARGET_MODES.has(mode) && !v.targetInfo) { toast('No target set. Press Y for the nearest vessel, or pick one with the Target button or in the map.', 'info'); return; }
      if (assist) dropAssist(assistName() + ' off');
      v.ctrl.sas = true;
      if (speedMode === 'surface' && mode === 'prograde') mode = 'srfPrograde';
      if (speedMode === 'surface' && mode === 'retrograde') mode = 'srfRetrograde';
      v.ctrl.sasMode = mode;
      if (mode === 'hold') v.sasTarget = null;
    },
    setThrottle(f) { const v = active(); if (v && v.type === 'ship') v.ctrl.throttle = clamp(Math.round(f * 20) / 20, 0, 1); },
    setWarp(i) { if (!world || paused) return; world.setWarp(i); },
    warpDelta(d) { if (!world || paused) return; if (world.warpTarget !== null && world.cancelWarpTo) world.cancelWarpTo(); world.setWarp(world.warpIndex + d); },
    stopWarp() { if (!world) return; if (world.cancelWarpTo) world.cancelWarpTo(); world.setWarp(0); },
    /** C: surface → orbit → target (only with a target set) → surface. */
    toggleSpeedMode() {
      const v = active();
      const order = v && v.targetInfo ? ['surface', 'orbit', 'target'] : ['surface', 'orbit'];
      setSpeedMode(order[(order.indexOf(speedMode) + 1) % order.length]);
    },
    setSpeedMode(mode) { if (mode === 'target' && !(active() && active().targetInfo)) return false; setSpeedMode(mode); return true; },

    // ---- targeting
    /** What can be targeted from here: vessels (nearest first, at most 8) then the other worlds. */
    targetList() {
      const v = active(); if (!v) return [];
      const cur = world.getTarget(v);
      const ships = world.vessels.filter(o => o !== v && !o.dead && o.type !== 'flag').map(o => ({ ref: o, kind: 'vessel', id: o.id, name: o.name, type: o.type, distance: rangeTo(v, o), current: o === cur }));
      ships.sort((a, b) => (a.type === 'debris') - (b.type === 'debris') || a.distance - b.distance);
      const bodies = SYSTEM.bodies.filter(b => b !== v.body && b.type !== 'star').map(b => ({ ref: b, kind: 'body', id: b.id, name: b.name, type: b.type, distance: rangeTo(v, b), current: b === cur }));
      bodies.sort((a, b) => a.distance - b.distance);
      return ships.slice(0, 8).concat(bodies);
    },
    setTarget(obj) {
      const v = active(); if (!v) return false;
      if (obj === null || obj === undefined) { if (v.targetId === null || v.targetId === undefined) return false; return world.setTarget(v, null); }
      const ok = world.setTarget(v, obj);
      if (!ok) toast('That cannot be targeted', 'warn');
      return ok;
    },
    clearTarget() { return actions.setTarget(null); },
    /** Distance from the vessel being flown to a vessel or a world (m). */
    rangeTo(obj) { const v = active(); return v && obj ? rangeTo(v, obj) : NaN; },
    /** Y: step through the vessels, nearest first. */
    cycleTarget(dir = 1) {
      const v = active(); if (!v) return false;
      const list = actions.targetList().filter(t => t.kind === 'vessel');
      if (!list.length) { toast('No other vessel to target. Worlds can be targeted from the Target button or the map.', 'info'); return false; }
      const i = list.findIndex(t => t.current);
      return actions.setTarget(list[(i + dir + list.length) % list.length].ref);
    },

    // ---- docking
    /** [{ portId, otherPortId, name (of the far side), partName }] for every mated pair of this vessel. */
    dockedList() {
      const v = active(); if (!v || v.type !== 'ship') return [];
      return v.dockedPairs.map(([a, b]) => {
        const pa = v.parts.get(a), pb = v.parts.get(b);
        // the far side is the one that would leave: its port remembers the name of the vessel it came with
        const far = pa && pb && pa.dockName === v.name ? pb : pb && pb.dockName === v.name ? pa : pb;
        return { portId: a, otherPortId: b, name: (far && far.dockName) || 'docked module', partName: pa ? pa.def.name : 'Latch Ring' };
      });
    },
    undock(portId) {
      const v = active(); if (!v || v.type !== 'ship' || paused) return null;
      if (portId === undefined || portId === null) { const pairs = v.dockedPairs; if (pairs.length) portId = pairs[pairs.length - 1][0]; }
      if (assist) dropAssist();
      const other = world.undock(v, portId);
      if (!other) { toast('Nothing is docked there', 'info'); return null; }
      refreshHint(true);
      return other;
    },
    canDockAssist() {
      const v = active();
      if (!autopilot || !autopilot.dockingApproach || !v || v.type !== 'ship') return { ok: false, why: 'Not available' };
      const t = world.getTarget(v);
      if (!t || !t.parts) return { ok: false, why: 'Target a vessel first (Y)' };
      if (!v.dockPorts.length) return { ok: false, why: 'This vessel has no free Latch Ring' };
      if (!t.dockPorts.some(q => v.dockPorts.some(m => m.def.dock.size === q.def.dock.size))) return { ok: false, why: t.name + ' has no free Latch Ring of the same size' };
      if (!(v.rcsThrust > 0) || !(v.resources.mono && v.resources.mono.amount > 0.5)) return { ok: false, why: 'Needs RCS thrusters and monopropellant' };
      if (v.landed || t.landed) return { ok: false, why: 'Docking happens in flight' };
      if (!v.targetInfo || v.targetInfo.distance > DOCK_ASSIST_RANGE) return { ok: false, why: 'Get within ' + fmt.dist(DOCK_ASSIST_RANGE) + ' of ' + t.name + ' first' };
      if (v.targetInfo.relSpeed > 15) return { ok: false, why: 'Too fast: match speeds with the target first (SAS against the drift, then burn)' };
      return { ok: true, why: '' };
    },
    /** Let the guidance computer fly the last metres to the target's port on RCS. */
    toggleDockAssist() {
      if (assist && assistKind === 'dock') { dropAssist('Docking assist off. You have control.'); return false; }
      const can = actions.canDockAssist();
      if (!can.ok) { toast('Docking assist: ' + can.why, 'info'); return false; }
      const v = active(), t = world.getTarget(v);
      try {
        if (assist) dropAssist();
        if (world.warpIndex > 3) world.setWarp(0);
        assist = autopilot.dockingApproach(world, v, t);
        assistKind = 'dock';
        toast('Docking assist engaged. Press any steering key or the button to take over.', 'good');
        return true;
      } catch (err) { assist = null; assistKind = ''; console.warn('[flight] docking assist failed to start:', err && err.message); toast('Docking assist is not available', 'warn'); return false; }
    },

    // ---- resource transfer
    /** Parts that can give or take `resource` ('fuel' | 'mono' | 'elec'), with the vessel each one arrived with. */
    transferParts(resource) {
      const v = active(); if (!v || v.type !== 'ship') return [];
      // which side of a docking port a part sits on: flood from the control part without crossing mated ports
      const side = new Map();
      const flood = (startId, name) => {
        const todo = [startId];
        while (todo.length) {
          const id = todo.pop(); if (side.has(id)) continue;
          const p = v.parts.get(id); if (!p) continue;
          side.set(id, name);
          for (const l of p.links) if (!side.has(l) && l !== p.dockedTo) todo.push(l);
        }
      };
      if (v.dockedPairs.length) {
        flood(v.controlId, v.name);
        for (const [a, b] of v.dockedPairs) for (const id of [a, b]) { const port = v.parts.get(id); if (port && !side.has(id)) flood(id, port.dockName || 'Docked module'); }
      }
      const out = [];
      for (const p of v.partList) {
        if (!p.def.res || !(resource in p.def.res) || !(resource in p.res) || !(p.def.res[resource] > 0)) continue;
        out.push({ id: p.id, name: p.def.name, side: side.get(p.id) || '', amount: p.res[resource], max: p.def.res[resource] });
      }
      return out;
    },
    transferResources() { return ['fuel', 'mono', 'elec'].filter(r => actions.transferParts(r).length >= 2); },
    /** amount: a number, 'all' (as much as fits) or 'balance' (equal fill level in both). → amount moved (signed for balance). */
    transfer(fromId, toId, resource, amount = 'all') {
      const v = active(); if (!v || v.type !== 'ship') return 0;
      const a = v.parts.get(fromId), b = v.parts.get(toId);
      if (!a || !b || a === b) { toast('Pick two different tanks', 'info'); return 0; }
      let from = fromId, to = toId, want = Infinity;
      if (amount === 'balance') {
        const ma = a.def.res[resource] || 0, mb = b.def.res[resource] || 0;
        const level = ((a.res[resource] || 0) + (b.res[resource] || 0)) / Math.max(1e-9, ma + mb);
        want = (a.res[resource] || 0) - level * ma;
        if (want < 0) { from = toId; to = fromId; want = -want; }
        if (want < 1e-6) { toast('Already balanced', 'info'); return 0; }
      } else if (amount !== 'all') {
        want = Number(amount);
        if (!(want > 0)) { toast('Enter an amount above zero', 'info'); return 0; }
      }
      const moved = v.transferResource(from, to, resource, want);
      const unit = RES_UNIT[resource] || '', name = RES_NAME[resource] || resource;
      if (!(moved > 0)) {
        const src = v.parts.get(from), dst = v.parts.get(to);
        toast(!(resource in src.res) || !(resource in dst.res) ? 'That cannot be pumped between these parts' : !(src.res[resource] > 0) ? src.def.name + ' is empty' : dst.def.name + ' is full', 'info');
        return 0;
      }
      toast('Moved ' + fmt.num(moved, moved < 100 ? 1 : 0) + ' ' + unit + ' of ' + name + ': ' + v.parts.get(from).def.name + ' → ' + v.parts.get(to).def.name, 'good');
      hud.refreshPanels();
      return from === fromId ? moved : -moved;
    },
    toggleMap() { toggleMap(); },
    openMenu() { openMenu(); },
    dismissHint() { if (hintCur) hintGone.add(hintCur.id); hintCur = null; hud.setHint(null); },
    cycleCamera() { const m = cam.cycle(); hud.flashCamera(MODE_LABEL[m]); },

    // ---- crew / EVA
    evaStart(partId, name) {
      const v = active(); if (!v || v.type !== 'ship') return null;
      const part = v.parts.get(partId);
      if (part && name) { const i = part.crew.indexOf(name); if (i >= 0 && i !== part.crew.length - 1) { part.crew.splice(i, 1); part.crew.push(name); } }
      const pip = world.evaStart(v, partId);
      if (!pip) { toast('Nobody can go outside right now', 'warn'); return null; }
      controlled = pip; assist = null; assistKind = ''; aboveLine = null; lastTarget = null;
      cam.frame(pip, { keepAngles: true });
      hud.invalidate(); hud.closePanels();
      toast(pip.name + ' is outside. F to climb back in.', 'info');
      return pip;
    },
    board() {
      const eva = active(); if (!eva || eva.type !== 'eva') return false;
      const targets = world.vessels.filter(v => v !== eva && v.type === 'ship' && !v.dead && v.body === eva.body).sort((a, b) => a.pos.distanceTo(eva.pos) - b.pos.distanceTo(eva.pos));
      for (const t of targets) {
        if (t.pos.distanceTo(eva.pos) > 60) break;
        if (world.evaBoard(eva, t)) { controlled = active(); cam.frame(controlled, { keepAngles: true }); hud.invalidate(); aboveLine = null; return true; }
      }
      // not at a hatch: take hold of a ladder within reach (then climb to the hatch and press again)
      if (!eva.ladder && typeof world.evaGrab === 'function' && world.evaGrab(eva)) { toast('On the ladder: W / S climb, F boards at the hatch, Space lets go', 'good'); app.audio.play('switch'); hud.invalidate(); return false; }
      toast(eva.ladder ? 'Climb up to the hatch first (W)' : targets.length && targets[0].pos.distanceTo(eva.pos) < 60 ? 'Get closer to the hatch (within 3 m), or to a ladder' : 'No vessel close enough to board', 'warn');
      return false;
    },
    async plantFlag(givenName) {
      const eva = active(); if (!eva || eva.type !== 'eva') return null;
      if (!eva.landed || eva.splashed) { toast('Stand on solid ground to plant a flag', 'warn'); return null; }
      let name = givenName;
      if (!name) {
        const field = el('input', { class: 'sw-input', value: eva.name + "'s Landing", attrs: { maxlength: 40, autofocus: true, 'data-flag-name': '1' }, style: { width: '100%' } });
        paused = true; app.input.releaseAll();
        const ok = await showModal({ title: 'Plant a flag', body: el('div', null, el('p', { text: 'Name this spot:' }), field), cancelValue: false, buttons: [{ label: 'Cancel', value: false }, { label: 'Plant it', value: true, kind: 'primary' }] });
        paused = false;
        if (!ok || !entered) return null;
        name = (field.value || '').trim() || 'Flag';
      }
      const flag = world.plantFlag(eva, name);
      if (flag) { toast('Flag planted: ' + name, 'good'); app.audio.play('land'); } else toast('The flag would not stay up here', 'warn');
      return flag;
    },
    evaExperiment(exp) {
      const eva = active(); if (!eva || eva.type !== 'eva') return null;
      return actions.runExperiment(eva.controlId, exp);
    },

    // ---- science
    runExperiment(partId, exp) {
      const v = active(); if (!v) return null;
      const before = v.science.length;
      const rec = world.runExperiment(v, partId, exp);
      const def = EXPERIMENTS[exp] || { name: 'Experiment' };
      if (!rec) toast(def.name + ': not possible here', 'warn');
      else if (v.science.length === before) toast(def.name + ': already stored for this place', 'info');
      else {
        const val = career.usesScience ? career.scienceValue(rec.experiment, rec.bodyId, rec.situation).next : 0;
        toast(def.name + ' stored' + (val > 0 ? ' (worth +' + val.toFixed(1) + ' science when recovered)' : ''), 'good');
      }
      hud.refreshPanels();
      return rec;
    },
    canTransmit(v) {
      if (!v || v.type !== 'ship') return { ok: false, why: 'Board a vessel with an antenna to transmit' };
      let antenna = false; for (const p of v.parts.values()) if (p.def.antenna) { antenna = true; break; }
      if (!antenna) return { ok: false, why: 'No antenna aboard' };
      const e = v.resources && v.resources.elec;
      if (!e || e.amount < 5) return { ok: false, why: 'Not enough charge (5 EC needed)' };
      return { ok: true, why: '' };
    },
    transmit(rec) {
      const v = active(); if (!v || !actions.canTransmit(v).ok) return 0;
      const i = v.science.indexOf(rec); if (i < 0) return 0;
      v.science.splice(i, 1);
      let need = 5;
      for (const p of v.parts.values()) { if (need <= 0) break; if (p.res.elec > 0) { const take = Math.min(need, p.res.elec); p.res.elec -= take; need -= take; } }
      const pts = career.creditScience(rec.experiment, rec.bodyId, rec.situation, 0.5, v.crew.slice());
      toast('Transmitted ' + ((EXPERIMENTS[rec.experiment] || {}).name || 'result') + (pts > 0 ? ': +' + pts.toFixed(1) + ' science' : ' (nothing new to learn)'), pts > 0 ? 'good' : 'info');
      if (pts > 0) app.audio.play('success');
      hud.refreshPanels();
      return pts;
    },

    // ---- recovery
    async recover() {
      const v = active();
      if (!v || !v.landed || v.body !== SYSTEM.home) { toast('Recovery needs a vessel landed or floating on ' + SYSTEM.home.name, 'warn'); return null; }
      const name = v.name, cost = v.cost, aboard = v.crew.slice();
      const summary = world.recover(v);
      if (!summary) { toast('Recovery is not possible right now', 'warn'); return null; }
      paused = true; app.input.releaseAll();
      const crewNames = Array.isArray(summary.crew) ? summary.crew.slice() : aboard;
      const funds = career.creditRecovery(summary.partsCost ?? cost, summary.distance || 0, crewNames);
      let sci = 0; const lines = [];
      for (const r of summary.science || []) {
        const pts = career.creditScience(r.experiment, r.bodyId, r.situation, 1, crewNames);
        sci += pts;
        lines.push([((EXPERIMENTS[r.experiment] || {}).name || r.experiment) + ' · ' + ((SYSTEM.byId[r.bodyId] || {}).name || r.bodyId), pts > 0 ? '+' + pts.toFixed(1) : '—']);
      }
      const home = career.returnCrew(summary.crew || []);
      app.save(true);
      app.audio.play('success');
      const grid = el('div', { class: 'fl-sum', data: { summary: 'recovery' } });
      const row = (k, val, cls = '') => grid.append(el('span', { class: 'k ' + cls, text: k }), el('span', { class: 'v ' + cls, text: val }));
      row('Distance from the pad', fmt.dist(summary.distance || 0));
      row('Parts value recovered', career.usesFunds ? fmt.funds(funds) : fmt.funds(funds) + ' (not needed here)');
      row('Crew home safe', (summary.crew || []).length ? (summary.crew || []).join(', ') : 'none aboard');
      for (const [k, val] of lines) row(k, val);
      row('Science banked', '+' + sci.toFixed(1), 'total');
      const others = world.vessels.filter(flyable);
      const buttons = [{ label: 'Back to the Flight Center', value: 'hub', kind: 'primary' }];
      if (others.length) buttons.unshift({ label: 'Fly ' + others[0].name, value: 'stay' });
      const res = await showModal({ title: name + ' recovered' + (summary.splashed ? ' from the sea' : ''), body: grid, buttons, dismissable: false });
      paused = false;
      if (!entered) return summary;
      void home;
      if (res === 'stay' && others.length && takeControl(others[0])) return summary;
      leave('hub');
      return summary;
    },

    // ---- guidance programs (the Autopilot panel). Each one is a core autopilot controller ticked by update().
    /**
     * What the guidance computer can do right now: [{ id, name, note, ok, why, on, plan }]. `plan: true` entries only
     * add a maneuver node (the pilot, or the 'node' program, then flies it); the others take the controls until they
     * finish or the pilot touches the stick.
     */
    programs() {
      const v = active();
      if (!autopilot || !v || v.type !== 'ship') return [];
      const list = [];
      const add = (id, name, note, ok = true, why = '', plan = false) => list.push({ id, name, note, ok: ok && v.controllable, why: v.controllable ? why : 'No control', on: !!assist && assistKind === id, plan });
      const body = v.body, atmoH = body.atmo ? body.atmo.height : 0, tgt = world.getTarget(v);
      const ground = v.landed || v.grounded, inAir = !ground && atmoH > 0 && v.altitude < atmoH;
      const wheels = (v.wheelParts || []).filter(p => p.deployed !== false).length, driven = (v.wheelParts || []).some(p => p.def.wheel.drive > 0);
      const wings = v.partList.some(p => p.def.wing), rocket = v.partList.some(p => p.def.engine && p.def.engine.type !== 'jet' && p.def.engine.type !== 'ion');
      const plane = wings && atmoH > 0;
      const orbiting = !ground && !inAir;
      let closed = false, hyper = false;
      if (orbiting) { try { const o = v.getOrbit(world.ut); hyper = autopilot.leavesSoi(o, body); closed = !hyper && Number.isFinite(o.period) && v.periapsis > Math.max(atmoH, 0); } catch { closed = false; } }
      if (v.nodes.length) {
        const n = v.nodes[0], dv = v.nodeDv || Math.hypot(n.dv.prograde, n.dv.normal, n.dv.radial);
        add('node', 'Fly the next maneuver', fmt.num(dv, 0) + ' m/s in ' + fmt.time(Math.max(0, n.t - world.ut)) + ': warps there, aims and burns', (v.deltaV || 0) > 0 || v.hasEngineStagesLeft(), 'No propellant');
      }
      if (ground) {
        if (plane && wheels >= 2) add('takeoff', 'Take off', 'rolls, rotates, raises the gear and climbs to 1,000 m');
        if (driven && wheels >= 2) add('drive', 'Cruise control', 'holds this heading at ' + (Math.round(roverCruiseSpeed(body, 8) * 2) / 2) + ' m/s for 1 km, and stops short of ground too steep to cross', (v.resources.elec ? v.resources.elec.amount : 0) > 1, 'No charge');
        if (rocket && !(plane && wheels >= 2 && !v.hasEngineStagesLeft() && body === SYSTEM.home && !(v.deltaV > 2500))) add('ascent', 'Ascent to orbit', 'gravity turn to a ' + Math.round(ascentAlt(body) / 1000) + ' km orbit');
      } else if (inAir) {
        if (plane) {
          add('hold', 'Hold heading and altitude', 'wings level at ' + fmt.num(v.altitude, 0) + ' m');
          if (body === SYSTEM.home) add('land', 'Land at the runway', 'flies the approach, flares and brakes', wheels >= 2 || v.hasGear, 'No landing gear');
        }
        if (rocket && body === SYSTEM.home && v.engines.length) {
          add('recovery', 'Fly back and land', 'boostback to the Return Pad by the launch pad, then a landing burn on the engine', v.enginePower().thrust > 0, 'No propellant');
          if (SYSTEM.sites.barge) add('recoverybarge', 'Land on the barge', 'steer to the barge ' + SYSTEM.sites.barge.name + ', ' + Math.round(BARGE.east / 1000) + ' km east of the pad, and land on its deck', v.enginePower().thrust > 0, 'No propellant');
        }
        if (rocket && v.verticalSpeed > -5) add('ascent', 'Ascent to orbit', 'takes over the climb to a ' + Math.round((atmoH + 10000) / 1000) + ' km orbit');
      }
      if (orbiting) {
        if (hyper) add('circ', 'Plan: capture into orbit', 'a braking burn at the periapsis (' + fmt.dist(v.periapsis) + ' up)', v.periapsis > atmoH, 'The periapsis is in the ' + (atmoH ? 'air' : 'ground'), true);
        if (hyper && tgt && !tgt.parts && tgt.radius && tgt.parent === body) add('capmoon', 'Plan: capture, reaching out to ' + tgt.name, 'a smaller braking burn into a long orbit that touches the path of ' + tgt.name + '; match planes at its top for little fuel', v.periapsis > atmoH, 'The periapsis is in the ' + (atmoH ? 'air' : 'ground'), true);
        if (hyper) { /* nothing more until captured */ }
        else if (v.apoapsis > Math.max(atmoH, 0)) {
          add('circ', 'Plan: circularise at the high point', 'a burn at the apoapsis (' + fmt.dist(v.apoapsis) + ')', true, '', true);
          if (closed && v.apoapsis - v.periapsis > 2000) add('circlow', 'Plan: circularise at the low point', 'a burn at the periapsis (' + fmt.dist(v.periapsis) + ')', true, '', true);
        }
        const isBody = tgt && !tgt.parts && tgt.radius;
        if (isBody && tgt.parent === body) {
          add('transfer', 'Plan: transfer to ' + tgt.name, 'a burn that meets the moon', closed, 'Needs a closed orbit first', true);
          add('plane', 'Plan: match the plane of ' + tgt.name, 'needed when you arrived tilted against its orbit', closed, 'Needs a closed orbit first', true);
        } else if (isBody && body.parent && tgt.parent === body.parent && body.parent.type === 'star') {
          add('transfer', 'Plan: transfer to ' + tgt.name, 'finds the next window and the ejection burn', closed, 'Needs a closed orbit first', true);
        } else if (isBody && body.parent === tgt.parent && body.parent) {
          add('transfer', 'Plan: transfer to ' + tgt.name, 'a burn that meets it', false, 'Fly to a low orbit of ' + body.parent.name + ' first', true);
        }
        if (isBody && tgt !== body && (tgt.parent === body || tgt.parent === body.parent)) add('correct', 'Plan: course correction to ' + tgt.name, 'a small burn that fixes the arrival', v.situation !== 'landed', '', true);
        if (body.parent && body.parent.type !== 'star') add('return', 'Plan: return to ' + body.parent.name, 'leaves ' + body.name + ' so the path dips to ' + body.parent.name, closed, 'Needs a closed orbit first', true);
        if (!atmoH && rocket) add('landhere', 'Land here', 'brakes out of orbit, finds level ground and sets down on the engine', (v.deltaV || 0) > 50, 'No propellant');
        if (atmoH && rocket && closed) add('deorbit', 'Deorbit', 'burns retrograde until the path dips into the air', (v.deltaV || 0) > 10, 'No propellant');
      } else if (!ground && !atmoH && rocket) add('landhere', 'Land here', 'brakes, finds level ground and sets down on the engine', (v.deltaV || 0) > 20, 'No propellant');
      return list;
    },
    /** Start (or stop, when it is the one running) a guidance program from programs(). → true when something happened. */
    runProgram(id) {
      const v = active();
      if (!autopilot || !v || v.type !== 'ship' || paused) return false;
      if (assist && assistKind === id) { dropAssist(assistName() + ' off. You have control.'); return true; }
      const prog = actions.programs().find(q => q.id === id);
      if (!prog) { toast('That program is not available right now', 'info'); return false; }
      if (!prog.ok) { toast(prog.name + ': ' + (prog.why || 'not possible right now'), 'info'); return false; }
      const tgt = world.getTarget(v), body = v.body, atmoH = body.atmo ? body.atmo.height : 0;
      try {
        if (prog.plan) return planProgram(id, v, tgt);
        if (assist) dropAssist();
        if (world.warpIndex > 3) world.setWarp(0);
        let ctl = null;
        if (id === 'ascent') { actions.toggleAssist(); return !!assist; }
        if (id === 'takeoff') ctl = autopilot.planeTakeoff(world, v, { altitude: 1000 });
        else if (id === 'hold') ctl = autopilot.planeCruise(world, v, { altitude: v.altitude, heading: state.heading, throttle: Math.max(0.5, v.ctrl.throttle) });
        else if (id === 'land') { if (typeof v.setGear === 'function' && v.hasGear && !v.gearDown) v.setGear(true); ctl = autopilot.planeLand(world, v, { site: runwaySite() }); }
        else if (id === 'drive') ctl = autopilot.roverDrive(world, v, { distance: 1000, speed: 8 });
        else if (id === 'node') ctl = autopilot.executeNode(world, v, { useWarp: true });
        else if (id === 'landhere') { if ((v.legParts || []).length && !v.legsDown) v.toggleLegs(); ctl = autopilot.hoverslamLanding(world, v, { useWarp: true }); }
        else if (id === 'recovery') ctl = autopilot.boosterRecovery(world, v, { target: landingTarget() });
        else if (id === 'recoverybarge') { ctl = autopilot.boosterRecovery(world, v, { target: SYSTEM.sites.barge.dir, targetName: 'the barge' }); id = 'recovery'; }
        else if (id === 'deorbit') ctl = autopilot.deorbit(world, v, { periapsis: Math.min(atmoH * 0.45, 35000) });
        if (!ctl) return false;
        assist = ctl; assistKind = id;
        toast(prog.name + ' engaged. Press any steering key to take over.', 'good');
        if (hud) hud.refreshPanels();
        return true;
      } catch (err) { assist = null; assistKind = ''; console.warn('[flight] program ' + id + ' failed to start:', err && err.message); toast(prog.name + ' is not available', 'warn'); return false; }
    },

    // ---- ascent assist
    toggleAssist() {
      if (assist) { dropAssist(assistName() + ' off. You have control.'); return; }
      const v = active();
      if (!autopilot || !v || v.type !== 'ship') return;
      if (!(v.situation === 'prelaunch' || v.situation === 'landed' || v.situation === 'flying' || v.situation === 'suborbital')) { toast('Ascent assist only flies from the ground to orbit', 'info'); return; }
      try {
        assist = autopilot.ascentProgram(world, { targetAlt: ascentAlt(v.body), useWarp: false, recover: v.body === SYSTEM.home ? { target: landingTarget() } : null });
        assistKind = 'ascent';
        // already flying: skip the program's own "ignite and release" step (it would fire the next stage)
        if (v.stageIndex > 0 && !v.landed) { assist.phase = 'ascent'; v.ctrl.throttle = 1; }
        toast('Ascent assist engaged. Press any attitude key or the button to take over.', 'good');
      } catch (err) { assist = null; assistKind = ''; console.warn('[flight] ascent assist failed to start:', err && err.message); toast('Ascent assist is not available', 'warn'); }
    },

    // ---- saves
    quicksave() {
      if (!world) return false;
      if (!active()) { toast('Nothing to save: no vessel under control', 'warn'); return false; }
      try {
        quick = { world: JSON.stringify(world.toJSON()), career: JSON.stringify(career.toJSON()), ut: world.ut };
        try { localStorage.setItem(quickKey(app), JSON.stringify(quick)); } catch { /* storage full: memory copy still works */ }
        toast('Quicksaved', 'good');
        return true;
      } catch (err) { console.warn('[flight] quicksave failed:', err); toast('Quicksave failed', 'bad'); return false; }
    },
    async quickload(skipConfirm = false) {
      if (!quick) quick = storedQuick();
      if (!quick) { toast('No quicksave yet (F5 or Shift+K)', 'info'); return false; }
      if (!skipConfirm) {
        paused = true; app.input.releaseAll();
        const ok = await app.confirm('Load the quicksave?', 'Everything since ' + fmt.date(quick.ut) + ' will be undone.', { okLabel: 'Load quicksave' });
        paused = false;
        if (!ok || !entered) return false;
      }
      try {
        restoreCareer(quick.career);
        bindWorld(World.fromJSON(JSON.parse(quick.world)));
        if (world.warpIndex !== 0) world.setWarp(0);
        toast('Quicksave loaded', 'good');
        return true;
      } catch (err) { console.error('[flight] quickload failed:', err); toast('The quicksave could not be loaded', 'bad'); return false; }
    },
    /** The newest thing to fall back on when there is no launch to revert to: the quicksave or the moment this flight was resumed. */
    lastSave() {
      if (!quick) quick = storedQuick();
      const list = [];
      if (quick) list.push({ ...quick, kind: 'quick' });
      if (resumeSnap) list.push({ ...resumeSnap, kind: 'resume' });
      list.sort((a, b) => b.ut - a.ut);
      return list[0] || null;
    },
    revertToSave() {
      const snap = actions.lastSave();
      if (!snap) { toast('Nothing to revert to yet. Quicksave with F5.', 'info'); return false; }
      try {
        restoreCareer(snap.career);
        bindWorld(World.fromJSON(JSON.parse(snap.world)));
        if (world.warpIndex !== 0) world.setWarp(0);
        hintGone.clear(); refreshHint(true);
        toast(snap.kind === 'quick' ? 'Quicksave loaded' : 'Back to where you resumed', 'good');
        return true;
      } catch (err) { console.error('[flight] revert failed:', err); toast('That save could not be loaded', 'bad'); return false; }
    },
    revertToLaunch() {
      if (!launchSnap) { toast('This flight was resumed: there is no launch to go back to', 'info'); return false; }
      restoreCareer(launchSnap.career);
      const w = launchSnap.base ? World.fromJSON(JSON.parse(launchSnap.base)) : new World({ ut: launchSnap.ut });
      w.launch(Craft.fromJSON(launchSnap.craft), { crew: launchSnap.crew, site: launchSnap.site === 'runway' ? runwaySite().start : 'pad' });
      bindWorld(w);
      brakeLock = false; brakeHeld = false;
      cam.reset(); cam.frame(world.active);
      setSpeedMode('surface');
      hintGone.clear(); refreshHint(true);
      toast(launchSnap.site === 'runway' ? 'Back on the runway' : 'Back on the pad', 'info');
      return true;
    },
    revertToHangar() {
      if (!launchSnap) { toast('This flight was resumed: there is no launch to go back to', 'info'); return false; }
      restoreCareer(launchSnap.career);
      const craft = Craft.fromJSON(launchSnap.craft);
      if (launchSnap.paid && career.usesFunds) { try { career.funds += career.launchCost ? career.launchCost(craft) : craft.cost(); } catch { /* keep going */ } }
      if (career.releaseCrew) career.releaseCrew(launchSnap.crew || []);
      const w = launchSnap.base ? World.fromJSON(JSON.parse(launchSnap.base)) : new World({ ut: launchSnap.ut });
      bindWorld(w);
      leave('builder', launchSnap.site === 'runway' ? { craft: launchSnap.craft, site: 'runway' } : { craft: launchSnap.craft });
      return true;
    },
    exitToHub() { leave('hub'); },
  };

  /** The "Plan: …" programs: each adds one maneuver node (or says why it cannot). */
  function planProgram(id, v, tgt) {
    const before = v.nodes.length;
    const body = v.body;
    let res = null, what = '';
    if (v.nodes.length && id !== 'correct') { for (const n of v.nodes.slice()) v.removeNode(n); }
    if (id === 'circ' || id === 'circlow') {
      const o = v.getOrbit(world.ut);
      const node = autopilot.planCircularize(world, v, id === 'circlow' || autopilot.leavesSoi(o, body) ? 'periapsis' : 'apoapsis');
      res = node ? { node, dv: Math.abs(node.dv.prograde) } : null; what = autopilot.leavesSoi(o, body) ? 'Capture burn' : 'Circularisation';
    } else if (id === 'capmoon' && tgt && tgt.orbit) {
      // brake at the periapsis just enough that the far end of the orbit reaches the moon's
      const o = v.getOrbit(world.ut), rp = body.radius + v.periapsis, ra = tgt.orbit.a;
      const vNow = Math.sqrt(body.gm * (2 / rp - 1 / o.a)), vWant = Math.sqrt(body.gm * (2 / rp - 2 / (rp + ra)));
      const node = v.addNode(world.ut + o.timeToPeriapsis(world.ut), { prograde: vWant - vNow, normal: 0, radial: 0 });
      res = node ? { node, dv: Math.abs(vWant - vNow) } : null; what = 'Capture burn';
    } else if (id === 'transfer' && tgt) {
      if (tgt.parent === body) { res = autopilot.planHohmannToMoon(world, v, tgt); what = 'Transfer to ' + tgt.name; }
      else {
        const safe = tgt.atmo ? tgt.atmo.height + Math.max(40000, tgt.radius * 0.5) : tgt.radius * 0.6;
        res = autopilot.planInterplanetary(world, v, tgt, { periapsis: safe, planar: true }); what = 'Transfer to ' + tgt.name;
      }
    } else if (id === 'plane' && tgt) {
      res = autopilot.planMatchPlane(world, v, tgt); what = 'Plane change';
      if (res && !res.node) { toast('Already in the plane of ' + tgt.name, 'good'); return true; }
    } else if (id === 'correct' && tgt) {
      const far = tgt.parent !== body;
      // a planet aimed at from solar orbit gets the same wide berth as the transfer plan: a burn of a few hundred
      // m/s weeks out lands tens of kilometres from its mark, and 20 km over the air was not enough room for that
      const wide = far || !body.parent;
      const safe = tgt.atmo ? tgt.atmo.height + (wide ? Math.max(40000, tgt.radius * 0.5) : 20000) : tgt.radius * (wide ? 0.6 : 0.3);
      // on the way home the correction aims into the upper air for an aerobraking pass
      const pe = tgt === SYSTEM.home && far ? tgt.atmo.height * 0.62 : safe;
      const o = v.getOrbit(world.ut);
      const opts = far ? { periapsis: pe, seek: true, horizon: Number.isFinite(o.period) ? o.period : 4e7 } : { periapsis: pe, seek: true };
      for (const n of v.nodes.slice()) v.removeNode(n);
      res = autopilot.planCorrection(world, v, tgt, opts); what = 'Course correction';
      if (res && !res.node && !Number.isFinite(res.periapsis)) { toast('No correction found: this path passes ' + (Number.isFinite(res.miss) ? fmt.dist(res.miss) + ' from ' : 'wide of ') + tgt.name + '. Try earlier on the way, or plan a new transfer.', 'warn'); return false; }
      if (res && !res.node) { toast('On course: ' + tgt.name + ' periapsis ' + fmt.dist(res.periapsis), 'good'); return true; }
    } else if (id === 'return') {
      const parent = body.parent;
      res = autopilot.planReturnFromMoon(world, v, parent === SYSTEM.home ? { periapsis: parent.atmo.height * 0.5 } : {}); what = 'Return to ' + parent.name;
    }
    if (!res || v.nodes.length === 0) {
      toast((what || 'Planning') + ': no solution from this orbit' + (id === 'transfer' ? ' (a low, round orbit works best)' : ''), 'warn');
      return v.nodes.length !== before;
    }
    const node = v.nodes[0];
    const dv = Number.isFinite(res.dv) ? Math.abs(res.dv) : Math.hypot(node.dv.prograde, node.dv.normal, node.dv.radial);
    const pe = Number.isFinite(res.periapsis) ? ', arriving ' + fmt.dist(res.periapsis) + ' up' : res.periapsis === null && Number.isFinite(res.miss) && res.miss > 0 ? ', passing ' + fmt.dist(res.miss) + ' away (correct it on the way)' : '';
    app.toast(what + ' planned: ' + fmt.num(dv, 0) + ' m/s in ' + fmt.time(Math.max(0, node.t - world.ut)) + pe + '. Fly it yourself, or use "Fly the next maneuver".', 'good', 8000);
    if ((v.deltaV || 0) < dv) toast('That burn needs more delta-v than is aboard (' + fmt.num(v.deltaV || 0, 0) + ' m/s)', 'warn');
    if (map && map.pruneNodes) { try { map.pruneNodes(); } catch { /* map closed */ } }
    if (hud) { hud.invalidate(); hud.refreshPanels(); }
    refreshHint(true);
    return true;
  }

  /** Fallback when the core has no fireGroup: run the stored { part, action } entries through the vessel's public switches. */
  function fireGroupFallback(v, key) {
    const g = v.actionGroups || {};
    const list = g[key] || g['custom' + key] || g['group' + key] || [];
    let n = 0;
    for (const it of list) {
      const p = v.parts.get(it.part); if (!p) continue;
      const a = String(it.action || 'toggle');
      const d = p.def;
      if (d.engine && /engine|ignite|activate|shutdown|toggle/i.test(a)) {
        const on = /shutdown|off/i.test(a) ? false : /ignite|activate|on$/i.test(a) ? true : !p.ignited;
        if (d.engine.type === 'solid' && !on) continue;
        p.ignited = on; n++;
      } else if (d.decoupler && /decouple|toggle|fire/i.test(a) && typeof world.decouple === 'function') { world.decouple(v, p.id); n++; }
      else if ('deployed' in p && typeof p.deployed === 'boolean') {
        p.deployed = /retract|off|close/i.test(a) ? false : /deploy|extend|on$|open/i.test(a) ? true : !p.deployed; n++;
      }
    }
    return n;
  }

  /** F1: save the frame (scene + instruments' WebGL part) as a PNG. */
  function shot() {
    try {
      render();
      const url = app.renderer.domElement.toDataURL('image/png');
      const p = fmt.dateParts(world ? world.ut : 0);
      const a = el('a', { attrs: { href: url, download: `starwright-Y${p.year}-D${p.day}-${String(p.h).padStart(2, '0')}${String(p.m).padStart(2, '0')}${String(p.s).padStart(2, '0')}.png` } });
      document.body.appendChild(a); a.click(); a.remove();
      app.audio.play('shutter');
      toast('Screenshot saved to your downloads', 'good');
    } catch (err) { console.warn('[flight] screenshot failed:', err && err.message); toast('The screenshot could not be saved', 'warn'); }
  }

  // ------------------------------------------------------------------ key help (and remapping) + graphics options
  function openKeyHelp() {
    const s = app.settings;
    const grid = el('div', { class: 'sw-controls' });
    let listening = null;
    const stop = () => { if (listening) { window.removeEventListener('keydown', listening.fn, true); listening.btn.classList.remove('listen'); listening.btn.textContent = keyLabel(K(listening.name)); listening = null; } };
    for (const [group, rows] of KEY_HELP) {
      grid.appendChild(el('h4', { text: group }));
      for (const [name, label, fixed] of rows) {
        const keys = el('span', { class: 'keys' });
        if (name) {
          const btn = el('button', { class: 'sw-kbd', text: keyLabel(K(name)), tip: 'Click, then press the new key', attrs: { type: 'button', 'data-key': name }, style: { cursor: 'pointer' } });
          btn.addEventListener('click', () => {
            stop();
            btn.classList.add('listen'); btn.textContent = '…';
            const fn = e => {
              e.preventDefault(); e.stopPropagation();
              const code = e.code;
              if (code !== 'Escape' && !RESERVED.has(code) && !e.metaKey) {
                s.keys = s.keys || {};
                // one key, one job: whatever held this key gets the old one
                for (const other of Object.keys(DEFAULT_KEYS)) if (other !== name && K(other) === code) { s.keys[other] = K(name); const ob = grid.querySelector('[data-key="' + other + '"]'); if (ob) ob.textContent = keyLabel(s.keys[other]); }
                s.keys[name] = code;
                app.applySettings();
              } else if (code !== 'Escape') toast('That key is kept by the browser or the game', 'info');
              stop();
            };
            listening = { fn, btn, name };
            window.addEventListener('keydown', fn, true);
          });
          keys.appendChild(btn);
        } else for (const k of fixed) keys.appendChild(k === '…' ? document.createTextNode('…') : el('span', { class: 'sw-kbd', text: k }));
        grid.appendChild(el('div', { class: 'sw-control' }, el('span', { text: label }), keys));
      }
    }
    const note = el('div', { class: 'sw-note' }, el('div', null,
      el('b', { text: 'W / S pitch, A / D yaw, Q / E roll. ' }), 'Click a key cap to change it. Set up for a Mac keyboard and a Logitech MX mouse: scroll to zoom (the free-spinning wheel is smoothed), right-drag to orbit the camera; the thumb buttons cannot leave the game. If F1, F2, F5 or F9 are media keys on your Mac, hold Fn, or remap them here.'));
    const reset = el('button', { class: 'sw-btn small ghost', text: 'Reset all keys', attrs: { type: 'button', 'data-keys': 'reset' }, on: { click: () => { stop(); s.keys = {}; app.applySettings(); for (const b of grid.querySelectorAll('[data-key]')) b.textContent = keyLabel(K(b.dataset.key)); } } });
    const dlg = showModal({ title: 'Flight controls', body: el('div', null, note, grid, el('div', { style: { marginTop: '10px' } }, reset)), wide: true, buttons: [{ label: 'Got it', value: true, kind: 'primary' }] });
    return Promise.resolve(dlg).finally(stop);
  }

  function openGraphics() {
    const s = app.settings;
    const box = el('div', { class: 'fl-gfx' });
    const apply = () => { app.applySettings(); if (scene && scene.applySettings) scene.applySettings(); };
    const seg = (key, options) => {
      const wrap = el('div', { class: 'fl-seg' });
      const paint = () => { for (const b of wrap.children) b.classList.toggle('primary', String(s[key]) === b.dataset.v); };
      for (const [val, label] of options) wrap.appendChild(el('button', { class: 'sw-btn small', text: label, attrs: { type: 'button', 'data-gfx': key, 'data-v': String(val) }, on: { click: () => { s[key] = val; paint(); apply(); } } }));
      paint();
      return wrap;
    };
    const range = (key, max) => { const i = el('input', { attrs: { type: 'range', min: 0, max: Math.round(max * 100), step: 5, 'data-gfx': key }, value: Math.round((s[key] ?? 0) * 100) }); i.addEventListener('input', () => { s[key] = Number(i.value) / 100; apply(); }); return i; };
    const row = (label, sub, ctl) => box.append(el('div', { class: 'k' }, label, el('small', { text: sub })), ctl);
    // On a software rasteriser (no GPU) the scene runs in a reduced mode whatever the saved setting says: show
    // that mode, not the saved one, and let the player overrule it.
    const soft = !!(scene && scene.softGL);
    if (soft) {
      const note = el('div', { class: 'sw-note', data: { gfx: 'soft-note' }, style: { gridColumn: '1 / -1' } });
      const paintNote = () => { note.textContent = s.gfxForce ? 'This browser draws without a graphics card (software rendering). You have chosen to use the settings below anyway; expect a slow picture.' : 'This browser draws without a graphics card (software rendering), so the view runs in reduced mode: a third of the resolution, no shadows and no bloom. Pick a detail level to overrule that.'; };
      paintNote(); box.append(note);
      const wrap = el('div', { class: 'fl-seg' });
      const opts = [['', 'Reduced (automatic)'], ['low', 'Low'], ['medium', 'Medium'], ['high', 'High']];
      const cur = () => (s.gfxForce ? String(s.gfxQuality) : '');
      const paint = () => { for (const b of wrap.children) b.classList.toggle('primary', cur() === b.dataset.v); };
      for (const [val, label] of opts) wrap.appendChild(el('button', { class: 'sw-btn small', text: label, attrs: { type: 'button', 'data-gfx': 'gfxQuality', 'data-v': val }, on: { click: () => { if (val) { s.gfxQuality = val; s.gfxForce = true; } else s.gfxForce = false; paint(); paintNote(); apply(); } } }));
      paint();
      row('Detail', 'particles, shadow size, anti-aliasing', wrap);
    } else row('Detail', 'particles, shadow size, anti-aliasing', seg('gfxQuality', [['low', 'Low'], ['medium', 'Medium'], ['high', 'High']]));
    row('Vegetation', 'trees, grass and ground detail at the space centre', seg('gfxVegetation', [['auto', 'Auto'], ['low', 'Low'], ['medium', 'Medium'], ['high', 'High'], ['ultra', 'Ultra']]));
    if (!soft) row('Automatic quality', 'lowers resolution, then shadows, then effects when frames come slowly', seg('gfxAuto', [[false, 'Off'], [true, 'On']]));
    row('Shadows', 'the sun casts shadows on the vessel and the ground', seg('gfxShadows', [[false, 'Off'], [true, 'On']]));
    row('Ambient occlusion', 'soft shade in creases and where things touch the ground (high detail only)', seg('gfxAO', [[false, 'Off'], [true, 'On']]));
    row('Bloom', 'glow around flames, the sun and hot metal', range('gfxBloom', 1.5));
    row('Lens effects', 'sun flare, soft vignette, film grain', seg('gfxLens', [[false, 'Off'], [true, 'On']]));
    row('Camera shake', 'from thrust, air and impacts', range('gfxShake', 1.5));
    row('Interface size', 'text, panels and buttons; Auto follows the window', seg('uiScale', [['auto', 'Auto'], [0.8, '80%'], [0.9, '90%'], [1, '100%'], [1.1, '110%'], [1.25, '125%'], [1.5, '150%'], [1.75, '175%']]));
    return showModal({ title: 'Graphics', body: box, buttons: [{ label: 'Done', value: true, kind: 'primary' }] });
  }

  function storedQuick() {
    try {
      const q = JSON.parse(localStorage.getItem(quickKey(app)) || 'null');
      return q && typeof q.world === 'string' && typeof q.career === 'string' && Number.isFinite(q.ut) ? q : null;
    } catch { return null; }
  }

  function restoreCareer(json) {
    if (!json || !app.Career) return;
    const c = app.Career.fromJSON(JSON.parse(json));
    c.settings = app.settings;
    app.career = c; career = c;
  }

  /**
   * The runway as the space-centre model draws it: createBase().runwayAnchor is where vessels stand (SECOND_PASS,
   * ground layout), 100 m in from the west threshold of a 2 km strip heading east. Falls back to the core's own
   * site record when the model is not there. → { dir, heading, length, width, name, start: {dir, heading} }
   */
  /** Parking-orbit height the ascent program aims for: above the air, or low over an airless world (lower still over a small moon). */
  function ascentAlt(body) {
    if (body.atmo) return body.atmo.height + 10000;
    return Math.max(Math.min(20000, Math.max(6000, body.radius * 0.1)), (body.maxElevation || 0) + 3000);
  }
  function runwaySite() {
    const core = SYSTEM.sites && SYSTEM.sites.runway;
    if (runwayCache) return runwayCache;
    let out = core ? { ...core, start: core } : null;
    try {
      const b = scene && scene.base, home = SYSTEM.home;
      if (b && b.runwayAnchor && b.padAnchor && typeof home.dirFromLatLon === 'function') {
        const a = b.runwayAnchor.position, p0 = b.padAnchor.position, R = home.radius;
        const x = a.x - p0.x, z = a.z - p0.z, heading = Number.isFinite(b.runwayAnchor.userData.heading) ? b.runwayAnchor.userData.heading : 90;
        const at = (east, south) => home.dirFromLatLon(-south / R, east / R);
        const h = heading * Math.PI / 180, ex = Math.sin(h), sz = -Math.cos(h);       // unit vector down the strip (east, south)
        const start = { dir: at(x, z), heading, name: (core && core.name) || 'Runway' };
        out = { dir: at(x - 100 * ex, z - 100 * sz), heading, length: 2000, width: (core && core.width) || 60, name: start.name, start };
      }
    } catch { /* keep the core record */ }
    runwayCache = out;
    return out;
  }
  let runwayCache = null;

  function leave(name, params) {
    if (leaving) return;
    leaving = true;
    app.goto(name, params);
  }

  // ------------------------------------------------------------------ pause menu
  async function openMenu() {
    if (paused || isModalOpen() || !entered) return;
    paused = true; app.input.releaseAll();
    app.audio.setEngine(0); app.audio.setWind(0); if (app.audio.setReentry) app.audio.setReentry(0);
    try {
      for (;;) {
        const v = active();
        const canRecover = !!v && v.landed && v.body === SYSTEM.home && v.situation !== 'prelaunch';
        const box = el('div', { class: 'fl-menu' });
        let dlg = null;
        const item = (value, label, note, cls = '', disabled = false) => box.appendChild(el('button', { class: 'sw-btn ' + cls, disabled, attrs: { type: 'button', 'data-menu': value }, on: { click: () => dlg.close(value) } }, label, note ? el('small', { text: note }) : null));
        item('resume', 'Resume flight', 'Esc', 'primary');
        item('controls', 'Controls', 'keys and mouse');
        item('graphics', 'Graphics', 'detail, shadows, bloom');
        item('settings', 'Settings', 'sound, hints');
        item('quicksave', 'Quicksave', 'F5 · Shift+K', '', !v);
        item('quickload', 'Load quicksave', 'F9 · Shift+L');
        if (launchSnap) {
          item('revertLaunch', 'Revert to launch', launchSnap.site === 'runway' ? 'back on the runway' : 'back on the pad');
          item('revertHangar', 'Revert to the hangar', 'refunds the launch');
        } else {
          // a resumed flight has no launch to go back to: offer the newest save point instead
          const snap = actions.lastSave();
          item('revertSave', 'Revert to last save', snap ? (snap.kind === 'quick' ? 'quicksave · ' : 'when you resumed · ') + fmt.date(snap.ut) : 'none yet', '', !snap);
        }
        item('recover', 'Recover vessel', canRecover ? 'bring it home' : 'land on ' + SYSTEM.home.name + ' first', '', !canRecover);
        item('exit', 'Save & return to the Flight Center', '', '');
        dlg = showModal({ title: 'Flight paused', body: box, buttons: [{ label: 'Resume', value: 'resume' }], cancelValue: 'resume', class: 'fl-menu-modal' });
        const res = await dlg;
        if (!entered) return;
        if (res === 'controls') { await openKeyHelp(); continue; }
        if (res === 'graphics') { await openGraphics(); continue; }
        if (res === 'settings') { await openSettings(app); if (scene && scene.applySettings) scene.applySettings(); continue; }
        if (res === 'quicksave') { actions.quicksave(); continue; }
        if (res === 'quickload') { paused = false; await actions.quickload(); return; }
        if (res === 'revertLaunch') {
          if (await app.confirm('Revert to launch?', 'The flight starts over on the ' + (launchSnap.site === 'runway' ? 'runway' : 'pad') + '. Everything since then is undone.', { okLabel: 'Revert', danger: true })) { actions.revertToLaunch(); return; }
          continue;
        }
        if (res === 'revertHangar') {
          if (await app.confirm('Revert to the hangar?', 'The craft goes back to the Assembly Hangar and the launch is refunded.', { okLabel: 'Revert', danger: true })) { actions.revertToHangar(); return; }
          continue;
        }
        if (res === 'revertSave') {
          if (await app.confirm('Revert to the last save?', 'Everything since ' + fmt.date((actions.lastSave() || { ut: 0 }).ut) + ' will be undone.', { okLabel: 'Revert', danger: true })) { actions.revertToSave(); return; }
          continue;
        }
        if (res === 'recover') { paused = false; await actions.recover(); return; }
        if (res === 'exit') { leave('hub'); return; }
        return;
      }
    } finally { paused = false; }
  }

  // ------------------------------------------------------------------ map
  function toggleMap(force) {
    const want = force !== undefined ? !!force : !mapOpen;
    if (want === mapOpen) return;
    if (want) {
      if (!mapModule) { toast('The map is not available', 'warn'); return; }
      if (!map) {
        try { map = mapModule.createMapView(app, { getWorld: () => world, insets: { top: 96, left: 12, right: 54, bottom: Math.round(hud.consoleHeight()) + 64 } }); }
        catch (err) { console.error('[flight] map failed to start:', err); toast('The map could not be opened', 'bad'); return; }
        if (app.flight) app.flight.map = map;
        // first look: stand on the craft's side of its world (the default view is fixed in space and, depending on
        // the time of day, would open with a low craft and its whole trajectory hidden behind the planet)
        try {
          const v = world.active;
          if (v && v.body && map.setView && v.pos.length() < v.body.radius * 4) map.setView({ yaw: Math.atan2(v.pos.x, v.pos.z) + 0.6 });
        } catch { /* keep the default view */ }
      }
      map.enter();
      if (map.resize) map.resize(app.size.w, app.size.h);
      mapOpen = true;
    } else { if (map) map.exit(); mapOpen = false; }
    cam.enabled = !mapOpen;
    state.mapOpen = mapOpen;
    hud.setMapOpen(mapOpen);
  }

  // ------------------------------------------------------------------ destruction
  function showLost() {
    const info = lostInfo; lostInfo = null;
    const lines = [];
    if (lostCrew.length) lines.push('Lost: ' + lostCrew.join(', ') + '. They will be remembered.');
    lostCrew = [];
    const buttons = [];
    const others = world.vessels.filter(v => flyable(v) && v !== world.active);
    if (others.length) buttons.push({ key: 'switch', label: 'Fly ' + others[0].name, onClick: () => takeControl(others[0]) });
    if (launchSnap) buttons.push({ key: 'revertLaunch', label: 'Revert to launch', kind: 'primary', onClick: () => actions.revertToLaunch() });
    if (launchSnap) buttons.push({ key: 'revertHangar', label: 'Revert to the hangar', onClick: () => actions.revertToHangar() });
    if (!quick) quick = storedQuick();
    if (!launchSnap && resumeSnap && !(quick && quick.ut >= resumeSnap.ut)) buttons.push({ key: 'revertSave', label: 'Revert to where you resumed', kind: 'primary', onClick: () => actions.revertToSave() });
    if (quick) buttons.push({ key: 'quickload', label: 'Load quicksave', kind: launchSnap ? '' : 'primary', onClick: () => actions.quickload(true) });
    buttons.push({ key: 'hub', label: 'Flight Center', onClick: () => leave('hub') });
    hud.showCenter({ title: (info && info.name ? info.name : 'Vessel') + ' was lost', text: REASONS[info && info.reason] || 'The vessel was destroyed.', lines, buttons });
    app.audio.play('alarm');
    if (world.warpIndex) world.setWarp(0);
  }

  // ------------------------------------------------------------------ input
  function applyInput(dt) {
    const inp = app.input, v = active();
    const modal = isModalOpen();
    if (modal) { if (v) { const c = v.ctrl; c.pitch = c.yaw = c.roll = 0; c.tx = c.ty = c.tz = 0; } return; }
    const shift = inp.down('ShiftLeft') || inp.down('ShiftRight');
    const ctrlKey = inp.down('ControlLeft') || inp.down('ControlRight');
    const alt = inp.down('AltLeft') || inp.down('AltRight');
    const hit = name => inp.pressed(K(name)), held = name => inp.down(K(name));

    // ---- one-shot keys
    if (inp.pressed('Escape')) { if (mapOpen) toggleMap(false); else if (hud.panelKind) hud.closePanels(); else openMenu(); return; }
    if (hit('quicksave') || (shift && inp.pressed('KeyK'))) { shiftBlocked = true; actions.quicksave(); }
    if (hit('quickload') || (shift && inp.pressed('KeyL'))) { shiftBlocked = true; actions.quickload(); return; }
    if (hit('map')) toggleMap();
    if (hit('missions') && !shift && !ctrlKey && !alt) hud.togglePanel('missions');
    if (hit('hideHud')) hud.setHidden(!hud.hidden);
    if (hit('stress') && !mapOpen && !inp.mods.meta) actions.toggleStress();
    if (hit('screenshot')) shot();
    if (hit('warpUp')) { if (alt) physicsWarp(1); else actions.warpDelta(1); }
    if (hit('warpDown')) { if (alt) physicsWarp(-1); else actions.warpDelta(-1); }
    if (hit('warpStop')) actions.stopWarp();
    if (hit('camera') && !mapOpen) actions.cycleCamera();
    if (hit('nextVessel')) switchVessel(1);
    if (hit('prevVessel')) switchVessel(-1);
    if (hit('hopVessel')) hopVessel();
    if (hit('speedMode')) actions.toggleSpeedMode();
    if (hit('target')) { if (shift) { shiftBlocked = true; if (!actions.clearTarget()) toast('No target set', 'info'); } else actions.cycleTarget(1); }
    // Caps Lock: fine controls (gentler steering and translation)
    if (inp.pressed('CapsLock')) { fine = inp.capsLock !== undefined ? !!inp.capsLock : !fine; state.fine = fine; }
    else if (inp.capsLock !== undefined && inp.capsLock !== fine && !inp.pressed('CapsLock') && capsSeen) { fine = !!inp.capsLock; state.fine = fine; }
    if (inp.capsLock) capsSeen = true;
    if (!v) return;
    const c = v.ctrl;

    if (v.type === 'eva') { applyEvaInput(v, inp, shift, ctrlKey); return; }

    // nobody aboard and no working probe core: the engine and the staging do not answer (the HUD says "No control")
    if (!v.controllable) {
      if (hit('stage') || hit('fullThrottle')) toast(world.vessels.some(o => o.type === 'eva' && !o.dead) ? 'No control: nobody is aboard. Switch to your Pip with [ or ]' : 'No control: this craft has no crew and no working probe core', 'warn');
      if (!shift) shiftHeld = 0; else shiftHeld += dt;
      c.pitch = c.yaw = c.roll = 0; c.tx = c.ty = c.tz = 0;
      if (hit('cutThrottle')) c.throttle = 0;
      if (hit('gear')) actions.toggleLegs();
      return;
    }

    if (hit('stage')) actions.stage();
    if (hit('sas')) { actions.toggleSas(); app.audio.play('switch'); }
    if (hit('rcs')) { actions.toggleRcs(); app.audio.play('switch'); }
    if (hit('gear')) actions.toggleLegs();
    if (hit('lights')) actions.toggleLightsAndPanels();
    if (hit('abort')) actions.fireGroup('abort');
    if (!shift && !ctrlKey && !alt) for (let i = 1; i <= 9; i++) if (inp.pressed('Digit' + i)) actions.fireGroup(i);
    // brakes: on while B is held (a click on the BRK lamp locks them)
    if (actions.brakeState(v) !== null) {
      const hold = held('brakes');
      if (hold && !brakeHeld) { actions.setBrakes(true); brakeHeld = true; }
      else if (!hold && brakeHeld) { brakeHeld = false; if (!brakeLock) actions.setBrakes(false); }
    } else if (hit('brakes')) toast('Nothing to brake with', 'info');

    // ---- attitude (on wheels the same keys drive and steer: the core reads pitch as drive and yaw as steering)
    const inv = app.settings && app.settings.invertPitch ? -1 : 1;
    const gain = fine ? 0.3 : 1;
    const pitch = ((held('pitchUp') ? 1 : 0) - (held('pitchDown') ? 1 : 0)) * inv;
    const yaw = (held('yawRight') ? 1 : 0) - (held('yawLeft') ? 1 : 0);
    const roll = (held('rollRight') ? 1 : 0) - (held('rollLeft') ? 1 : 0);
    if (assist && (pitch || yaw || roll)) dropAssist(assistName() + ' off. You have control.');
    c.pitch = pitch * gain; c.yaw = yaw * gain; c.roll = roll * gain;
    // tail-strike guard: a held pull on or just above the runway eases off before the tail (or the engine) meets the ground
    if (c.pitch > 0 && (v.wheelParts || []).length >= 2 && (v.grounded || v.radarAlt < 4) && typeof v.tailStrikeMargin === 'function' && v.body.atmo) {
      const m = v.tailStrikeMargin() * 180 / Math.PI;
      if (Number.isFinite(m)) c.pitch = Math.min(c.pitch, clamp((m - 2 - 0.35 * v.w.x * 180 / Math.PI) / 3, -0.5, 1));
    }
    // powered wheels: W / S drive (whatever the pitch inversion says), A / D steer (the wheels follow yaw)
    if (!assist && (v.wheelParts || []).length) {
      c.drive = (v.wheelParts.some(p => p.def.wheel.drive > 0) ? (held('pitchDown') ? 1 : 0) - (held('pitchUp') ? 1 : 0) : 0) * gain;
      c.steer = 0;
    }

    // ---- throttle (Shift needs a short hold so Shift+K / Shift+L never bump it)
    if (!shift) { shiftHeld = 0; shiftBlocked = false; } else shiftHeld += dt;
    let dThr = 0;
    if ((shift && shiftHeld > 0.14 && !shiftBlocked) || inp.down('ArrowUp')) dThr += 1;
    if (ctrlKey || inp.down('ArrowDown')) dThr -= 1;
    if (dThr) c.throttle = clamp(c.throttle + dThr * dt * (fine ? 0.25 : 0.7), 0, 1);
    if (hit('fullThrottle') && !ctrlKey) c.throttle = 1;
    if (hit('cutThrottle') && !ctrlKey) c.throttle = 0;

    // ---- RCS translation
    const ty = shift ? 0 : (held('rcsForward') ? 1 : 0) - (held('rcsBack') ? 1 : 0);
    const tz = shift ? 0 : (held('rcsUp') ? 1 : 0) - (held('rcsDown') ? 1 : 0);
    const tx = shift ? 0 : (held('rcsRight') ? 1 : 0) - (held('rcsLeft') ? 1 : 0);
    if (assist && assistKind === 'dock') {
      // the docking assist owns the thrusters until the pilot touches a translation key
      if (tx || ty || tz) dropAssist('Docking assist off. You have control.');
      else return;
    }
    c.tx = tx * gain; c.ty = ty * gain; c.tz = tz * gain;
  }
  let capsSeen = false;

  /** Alt + , / . : step through the physics-warp rates only (1× to 4×), which keep engines and steering live. */
  function physicsWarp(d) {
    if (!world || paused) return;
    if (world.warpTarget !== null && world.cancelWarpTo) world.cancelWarpTo();
    const i = clamp(Math.min(world.warpIndex, 3) + d, 0, 3);
    world.setWarp(i);
    toast('Physics warp ' + (world.rate || [1, 2, 3, 4][world.warpIndex] || 1) + '×', 'info');
  }

  function applyEvaInput(v, inp, shift, ctrlKey) {
    const c = v.ctrl;
    const hit = name => inp.pressed(K(name)), held = name => inp.down(K(name));
    if (hit('board')) { if (actions.board()) return; }
    if (hit('flag')) { actions.plantFlag(); return; }
    if (hit('sas')) actions.toggleSas();
    // R: jetpack on / off
    if (hit('rcs')) { if (jetOff.has(v)) jetOff.delete(v); else jetOff.add(v); app.audio.play('switch'); toast(jetOff.has(v) ? 'Jetpack off' : 'Jetpack on', 'info'); }
    c.rcs = !jetOff.has(v);
    const fwd = (held('pitchDown') ? 1 : 0) - (held('pitchUp') ? 1 : 0);
    const side = (held('yawRight') ? 1 : 0) - (held('yawLeft') ? 1 : 0);
    const space = inp.down(K('stage'));
    const vert = (shift || (space && !v.landed) ? 1 : 0) - (ctrlKey ? 1 : 0);
    c.pitch = 0; c.yaw = 0; c.roll = (held('rollRight') ? 1 : 0) - (held('rollLeft') ? 1 : 0);
    c.tx = c.ty = c.tz = 0;
    q1.copy(v.q).invert();
    if (v.ladder) {
      // on a ladder: W / S (or Shift / Ctrl) climb, Space lets go, F boards from the top (see actions.board)
      c.ty = clamp(fwd + vert, -1, 1);
      if (hit('stage') && typeof world.evaLetGo === 'function') { world.evaLetGo(v); toast('Let go of the ladder', 'info'); }
      evaHold = 0;
    } else if (v.landed) {
      const up = v1.copy(v.pos).normalize();
      // camera-relative directions flattened onto the ground
      const f = v2.copy(cam.forward).addScaledVector(up, -cam.forward.dot(up));
      if (f.lengthSq() < 1e-4) f.copy(cam.up).addScaledVector(up, -cam.up.dot(up));
      f.normalize();
      const r = v3.crossVectors(f, up).normalize();
      if (fwd || side) {
        f.multiplyScalar(fwd).addScaledVector(r, side).normalize();
        f.applyQuaternion(q1);
        c.tx = f.x; c.tz = f.z;                           // the Pip turns to face this before it steps out (Vessel._stepLanded)
      }
      // Space jumps; with the jetpack on, Shift (or holding Space) lifts off on the thrusters
      if (hit('stage') || (c.rcs && (shift || (space && evaHold > 0.35)))) c.ty = 1;
      evaHold = space ? evaHold + 1 / 60 : 0;
    } else if (c.rcs) {
      evaHold = 0;
      const d = v2.set(0, 0, 0).addScaledVector(cam.forward, fwd).addScaledVector(cam.right, side).addScaledVector(cam.up, vert);
      if (d.lengthSq() > 0) { d.normalize().applyQuaternion(q1); c.tx = d.x; c.ty = d.y; c.tz = d.z; }
    } else if ((fwd || side || vert) && hintAcc > 0.45) toast('The jetpack is off: press R', 'info');
  }
  let evaHold = 0;
  const jetOff = new WeakSet();     // Pips who switched their jetpack off (it is on by default)

  // ------------------------------------------------------------------ navball markers
  function updateBall(v) {
    ball.setAttitude(v.q, v.pos);
    state.heading = ball.heading; state.pitch = ball.pitch; state.roll = ball.roll;
    const list = [];
    const ti = v.targetInfo;
    const rel = speedMode === 'target' && !!ti;
    const orbit = speedMode === 'orbit';
    const vel = rel ? ti.relVel : orbit ? v.vel : v.surfaceVel;
    if (vel && vel.lengthSq() > (rel ? 0.0025 : 0.25) && !(v.landed && !orbit && !rel)) {
      markerDirs.prograde.copy(vel).normalize(); markerDirs.retrograde.copy(markerDirs.prograde).negate();
      // relative to the target the two markers are drawn in the target's colour
      list.push({ kind: rel ? 'relPrograde' : 'prograde', dir: markerDirs.prograde }, { kind: rel ? 'relRetrograde' : 'retrograde', dir: markerDirs.retrograde });
    }
    if (orbit && !v.landed) {
      v1.crossVectors(v.pos, v.vel);
      if (v1.lengthSq() > 1e-6) {
        markerDirs.normal.copy(v1).normalize(); markerDirs.antinormal.copy(markerDirs.normal).negate();
        markerDirs.radialOut.crossVectors(v.vel, v1).normalize(); markerDirs.radialIn.copy(markerDirs.radialOut).negate();
        list.push({ kind: 'normal', dir: markerDirs.normal }, { kind: 'antinormal', dir: markerDirs.antinormal },
          { kind: 'radialOut', dir: markerDirs.radialOut }, { kind: 'radialIn', dir: markerDirs.radialIn });
      }
    }
    if (v.nodes.length) {
      const bv = v.burnVector(world.ut, v2);
      if (bv && bv.lengthSq() > 1e-6) { markerDirs.maneuver.copy(bv).normalize(); list.push({ kind: 'maneuver', dir: markerDirs.maneuver, showBehind: true }); }
    }
    if (ti) {
      markerDirs.target.copy(ti.dir); markerDirs.antiTarget.copy(ti.dir).negate();
      list.push({ kind: 'antiTarget', dir: markerDirs.antiTarget }, { kind: 'target', dir: markerDirs.target, showBehind: true });
    }
    ball.setMarkers(list);
  }

  function pruneNodes(v) {
    const node = v.nodes[0];
    if (!node || world.ut <= node.t) return;
    const dv = v.nodeDv || 0;
    const total = Math.hypot(node.dv.prograde, node.dv.normal, node.dv.radial);
    let bt = v.burnTime(total); if (!Number.isFinite(bt)) bt = 0;
    const late = world.ut - node.t;
    // a running program ends its own burn (to 0.03 m/s); cutting it at 0.5 m/s here left a course correction to a
    // small moon up to 0.5 m/s short, which is kilometres of periapsis
    const own = assist && !assist.done;
    if ((node.rem && dv < 0.5 && !own) || late > Math.max(60, bt / 2 + 30)) {
      v.removeNode(node);
      if (v.ctrl.sasMode === 'maneuver') { v.ctrl.sasMode = 'hold'; v.sasTarget = null; }
      if (map && map.pruneNodes) { try { map.pruneNodes(); } catch { /* map closed */ } }
      toast(dv < 0.5 ? 'Maneuver complete' : 'Maneuver expired', dv < 0.5 ? 'good' : 'info');
    }
  }

  /** Where a returning booster is sent: the landing zone by the pad. */
  function landingTarget() { const s = SYSTEM.sites && SYSTEM.sites.landing; return (s || SYSTEM.launchSite).dir; }
  /** A booster's return is called out step by step, whichever vessel is being watched. */
  function callouts(ctl, kind, pv) {
    if (!ctl.log) return;
    if (kind === 'ascent') {                                           // (the assist is quiet, except to say why it staged early)
      for (let i = ctl._said || 0; i < ctl.log.length; i++) if (/fly back/.test(ctl.log[i].msg)) toast('Ascent assist: ' + ctl.log[i].msg, 'info');
      ctl._said = ctl.log.length; return;
    }
    if (kind === 'landhere') {                                         // (what it found on the ground, and nothing else)
      const upTo = ctl.done ? ctl.log.length - 1 : ctl.log.length;
      for (let i = ctl._said || 0; i < upTo; i++) if (ctl.log[i].call) toast('Landing autopilot: ' + ctl.log[i].msg, ctl.log[i].call === 'warn' ? 'warn' : 'info');
      ctl._said = Math.max(ctl._said || 0, upTo); return;
    }
    if (kind !== 'recovery') return;
    const upTo = ctl.done ? ctl.log.length - 1 : ctl.log.length;      // (the last line of a finished program is its own toast)
    for (let i = ctl._said || 0; i < upTo; i++) toast((pv ? pv.name + ': ' : 'Booster: ') + ctl.log[i].msg, 'info');
    ctl._said = Math.max(ctl._said || 0, upTo);
  }
  /** One tick of the programs flying vessels that are not being watched; a program that ends says so. */
  function tickParked(dt) {
    if (!parked.size) return;
    for (const [id, pk] of parked) {
      const pv = world.getVessel(id);
      if (!pv || pv.dead) { parked.delete(id); continue; }
      try { pk.ctl.update(dt); } catch (err) { console.warn('[flight] background program stopped:', err && err.message); pk.ctl.done = true; pk.ctl.failed = true; }
      callouts(pk.ctl, pk.kind, pv);
      if (!pk.ctl.done) continue;
      parked.delete(id); pv.program = null;
      const last = pk.ctl.log && pk.ctl.log.length ? pk.ctl.log[pk.ctl.log.length - 1].msg : '';
      const name = PROGRAM_NAME[pk.kind] || 'Guidance';
      pv.ctrl.sas = true; pv.ctrl.sasMode = 'hold'; pv.sasTarget = null;
      if (!pk.ctl.failed) pv.ctrl.throttle = 0;
      toast(pv.name + ': ' + name + (pk.ctl.failed ? ' gave up' : ' complete') + (last ? ' (' + last + ')' : ''), pk.ctl.failed ? 'warn' : 'good');
    }
  }

  function finishAssist(v) {
    if (!assist || !assist.done) return;
    const last = assist.log && assist.log.length ? assist.log[assist.log.length - 1].msg : '';
    if (assistKind === 'dock') {
      if (assist.failed) toast('Docking assist stopped' + (last ? ': ' + last : ''), 'warn');
      if (v && !v.dead) { v.ctrl.sasMode = 'hold'; v.sasTarget = null; v.ctrl.tx = v.ctrl.ty = v.ctrl.tz = 0; }
    } else if (assistKind !== 'ascent') {
      const kind = assistKind, failed = assist.failed, name = assistName();
      assist = null; assistKind = '';
      if (world.warpIndex > 3 && world.warpTarget === null) world.setWarp(0);
      if (v && !v.dead) {
        if (kind === 'takeoff' && !failed) {
          // airborne: keep the wings level at the altitude reached until the pilot takes the stick
          try { assist = autopilot.planeCruise(world, v, { altitude: v.altitude, heading: state.heading, throttle: 0.75 }); assistKind = 'hold'; } catch { assist = null; assistKind = ''; }
          toast('Take-off complete: holding ' + fmt.num(v.altitude, 0) + ' m. Press any steering key to take over.', 'good');
        } else {
          releaseControls(v);
          if (kind === 'node' || kind === 'landhere' || kind === 'deorbit' || kind === 'land' || kind === 'drive' || kind === 'recovery') v.ctrl.throttle = 0;
          if (kind === 'land' || kind === 'drive') { if (typeof v.setBrakes === 'function') v.setBrakes(true); brakeLock = true; }
          if (kind === 'node' && !failed) toast('Maneuver flown. You have control.', 'good');
          else toast(name + (failed ? ' stopped' : ' complete') + (last ? ': ' + last : ''), failed ? 'warn' : 'good');
        }
      }
      if (hud) hud.refreshPanels();
      return;
    } else {
      toast(assist.failed ? 'Ascent assist gave up' + (last ? ': ' + last : '') : 'Ascent assist: in orbit' + (last ? ' (' + last + ')' : ''), assist.failed ? 'warn' : 'good');
      if (v && !v.dead) { v.ctrl.sasMode = 'hold'; v.sasTarget = null; if (!assist.failed) v.ctrl.throttle = 0; }
    }
    assist = null; assistKind = '';
  }

  // ------------------------------------------------------------------ screen
  async function enter(params = {}) {
    career = app.career;
    fine = false; state.fine = false; brakeHeld = false; brakeLock = false; lastSit = ''; state.danger = 0;
    leaving = false; paused = false; mapOpen = false; assist = null; assistKind = ''; launchSnap = null; resumeSnap = null; lostInfo = null; lostCrew = [];
    quick = storedQuick();
    if (!mapModule) { try { mapModule = await import('./mapview.js'); } catch (err) { console.warn('[flight] map view unavailable:', err && err.message); mapModule = null; } }
    if (!autopilot) { try { autopilot = await import('../core/autopilot.js'); } catch { autopilot = null; } }

    // ---- the world
    let w = null;
    const cleared = [];
    const baseJSON = career.flightState ? JSON.stringify(career.flightState) : null;
    if (params.craft) {
      const craft = Craft.fromJSON(typeof params.craft.toJSON === 'function' ? params.craft.toJSON() : params.craft);
      const crew = params.crew || [];
      // where it rolls out: the caller's choice, else the site the design was saved for (pad by default)
      const rawSite = params.site || (params.craft && params.craft.site);
      const site = rawSite === 'runway' && SYSTEM.sites && SYSTEM.sites.runway ? 'runway' : 'pad';
      // the scene comes first: the runway start is where the space-centre model has its runway anchor
      runwayCache = null;
      scene = createFlightScene(app);
      const rs = site === 'runway' ? runwaySite() : null;
      const siteArg = rs ? rs.start : 'pad';
      const siteDir = rs ? rs.start.dir : SYSTEM.launchSite.dir;
      let base = null;
      if (baseJSON) {
        try {
          w = World.fromJSON(JSON.parse(baseJSON));
          // clear the pad: anything still sitting there is rolled back
          for (const old of w.vessels.slice()) {
            if (old.landed && old.body === SYSTEM.home && old.surface && Math.acos(clamp(old.surface.dir.dot(siteDir), -1, 1)) * old.body.radius < 60) {
              if (career.releaseCrew) career.releaseCrew(old.crew);
              // the craft that was left standing on the pad goes back to the hangar; its parts are refunded
              let back = 0;
              if (old.type === 'ship' && old.situation === 'prelaunch' && career.usesFunds) { try { back = career.creditRecovery(old.cost, 0, []); } catch { back = 0; } }
              if (old.type === 'ship') cleared.push(old.name + ' was rolled off the ' + site + (back > 0 ? ' (' + fmt.funds(back) + ' refunded)' : ''));
              w.removeVessel(old);
            }
          }
          w.ut = Math.max(w.ut, career.ut || 0);
          base = JSON.stringify(w.toJSON());
        } catch (err) { console.warn('[flight] saved flights could not be restored:', err && err.message); w = null; }
      }
      if (!w) w = new World({ ut: career.ut || 0 });
      launchSnap = { career: JSON.stringify(career.toJSON()), craft: craft.toJSON(), crew: crew.slice(), paid: !!params.paid, ut: w.ut, base, site };
      w.launch(craft, { crew, site: siteArg });
    } else {
      if (!baseJSON) throw new Error('There is no flight in progress.');
      try { w = World.fromJSON(JSON.parse(baseJSON)); }
      catch (err) { console.warn('[flight] the flight in progress could not be restored:', err && err.message); const e = new Error('saved flight unreadable'); e.userMessage = 'The flight in progress could not be restored: its save data is damaged. New launches still work.'; e.damagedFlight = true; throw e; }
      if (params.vesselId != null) { const t = w.getVessel(params.vesselId); if (t) w.switchTo(t); }
      if (w.warpIndex) w.setWarp(0);
      resumeSnap = { world: JSON.stringify(w.toJSON()), career: JSON.stringify(career.toJSON()), ut: w.ut };
    }

    // ---- scene, camera, HUD
    if (!scene) { runwayCache = null; scene = createFlightScene(app); }
    cam = createFlightCamera(app, scene.camera);
    ball = createNavball();
    hud = createHud(app, actions);
    hud.mount();
    if (scene.setStressOverlay) scene.setStressOverlay(stressOn);
    hud.setStressOverlay(stressOn);
    cam.attach();
    offs = [app.input.on('mousedown', e => { if (e.button === 3 && !isModalOpen()) toggleMap(); })];
    app.flight = {
      world: w, scene: scene.far, nearScene: scene.near, view: scene, camera: scene.camera, cam, hud, ball, map: null, state, actions,
      setCameraMode(mode) { const m = cam.setMode(mode); return m; },
      get paused() { return paused; }, get mapOpen() { return mapOpen; }, get assist() { return assist; }, get assistKind() { return assistKind; },
    };
    bindWorld(w);
    const v = active();
    lastTarget = v ? world.getTarget(v) : null;
    speedMode = 'surface'; state.speedMode = 'surface';
    if (v) { aboveLine = v.altitude > speedLine(v); setSpeedMode(aboveLine ? 'orbit' : 'surface', null); cam.frame(v); }
    hintGone.clear(); hintCur = null;
    for (const text of cleared) app.toast(text, 'info', 5000);
    if (!active()) hud.showCenter({ title: 'Nothing to fly', text: 'There is no vessel left in this flight.', calm: true, buttons: [{ key: 'hub', label: 'Flight Center', kind: 'primary', onClick: () => leave('hub') }] });
    entered = true;
    // first frame of data so nothing flashes empty
    scene.update(world, 0.016, 0, cam);
    if (v) updateBall(v);
    hud.update(world, v, state, 1);
    refreshHint(true);
    // shader programs link in the background here, not inside the first frames (flightscene.prewarm)
    const sc = scene;
    try { if (sc && sc.prewarm) await sc.prewarm(app.renderer); } catch { /* the first frame compiles them instead */ }
  }

  function exit() {
    entered = false;
    try {
      if (world && career === app.career) {
        if (world.warpIndex && world.setWarp) world.setWarp(0);
        const keep = world.vessels.some(flyable);
        career.flightState = keep ? world.toJSON() : null;
        career.ut = Math.max(career.ut || 0, world.ut);
        // Pips whose vessel is gone for good do not stay "assigned"
        app.save(true);
      }
    } catch (err) { console.error('[flight] could not save the flight:', err); }
    if (unsub) { try { unsub(); } catch { /* ignore */ } unsub = null; }
    for (const off of offs) { try { off(); } catch { /* ignore */ } }
    offs = [];
    if (map) { try { map.exit(); if (map.dispose) map.dispose(); } catch { /* ignore */ } map = null; }
    mapOpen = false;
    if (cam) cam.detach();
    if (hud) hud.unmount();
    if (scene) scene.dispose();
    if (ball) ball.dispose();
    app.audio.stopAll(); app.audio.setAmbient(false); musicOn = false; musicT = 0;
    scene = cam = hud = ball = null; world = null; controlled = null; assist = null; assistKind = ''; lastTarget = null;
    app.world = null; app.flight = null;
    if (app.renderer) { app.renderer.setScissorTest(false); app.renderer.autoClear = true; }
  }

  function update(dt) {
    if (!entered || !world) return;
    applyInput(dt);
    if (!entered || !world) return;
    const utBefore = world.ut;
    let v = active();
    perf.begin('sim');
    if (!paused) {
      if (assist) {
        try { assist.update(dt); } catch (err) { console.warn('[flight] assist stopped:', err && err.message); assist.done = true; assist.failed = true; }
        callouts(assist, assistKind, v);
        finishAssist(v);
      }
      if ((assist && !assist.done) || parked.size) {
        // keep the guidance loop tight under physics warp / slow frames (≤ 0.2 s of flight per update)
        const n = Math.min(8, Math.max(1, Math.ceil(dt * (world.rate || 1) / 0.2)));
        tickParked(dt / n);
        world.step(dt / n);
        for (let i = 1; i < n && ((assist && !assist.done) || parked.size) && active(); i++) { if (assist && !assist.done) { try { assist.update(dt / n); } catch { break; } } tickParked(dt / n); world.step(dt / n); }
        // the docking assist finishes on the `dock` event, which arrives inside world.step
        if (assist && assistKind === 'dock') { try { assist.update(0); } catch { assist.done = true; assist.failed = true; } finishAssist(active()); }
      } else world.step(dt);
      tickAcc += dt;
      if (tickAcc >= 1) {
        tickAcc = 0;
        const a = active();
        if (a) { try { reportMilestones(career.onEvent('tick', { vessel: a }, world)); } catch (err) { console.warn('[flight] tick failed:', err && err.message); } }
      }
    }
    perf.end();
    if (sepUt >= 0) { sepUt = -1; app.audio.play('decouple'); if (cam) cam.kick(0.35); }      // a separation that was not a broken joint
    lastSimDt = world.ut - utBefore;
    v = active();
    if (v && v !== controlled) { controlled = v; lastTarget = world.getTarget(v); hud.invalidate(); cam.frame(v, { keepAngles: true }); aboveLine = null; }
    if (lostInfo && (!v || v.type === 'debris')) showLost();
    else if (lostInfo && v) lostInfo = null;
    if (v) {
      pruneNodes(v);
      // speed reference follows the altitude unless the pilot overrides it
      const above = v.altitude > speedLine(v);
      if (aboveLine === null || lastVesselId !== v.id) { aboveLine = above; lastVesselId = v.id; setSpeedMode(above ? 'orbit' : 'surface', null); }
      else if (above !== aboveLine) { aboveLine = above; if (speedMode !== 'target') setSpeedMode(above ? 'orbit' : 'surface'); }
      if (speedMode === 'target' && !v.targetInfo) setSpeedMode(above ? 'orbit' : 'surface');
      // closest approach to the target: about once a second, or at once when the target changes
      caAcc += dt;
      const key = v.id + ':' + (v.targetId ?? '');
      if (key !== caKey || caAcc >= 1) { caKey = key; caAcc = 0; refreshApproach(v); }
    } else state.approach = null;
    state.paused = paused;
    state.assist = assist ? (assist.phase || 'on') : null;
    state.assistKind = assist ? assistKind : '';
    // the one-click ascent button is for rockets; aeroplanes and rovers find their programs in the Autopilot panel
    const vehicleNow = !!v && v.type === 'ship' && (((v.wheelParts || []).length >= 2 && v.partList.some(p => p.def.wing)) || !(v.engines || []).length);
    state.assistAvailable = !!autopilot && !!v && v.type === 'ship' && ((!!assist && assistKind === 'ascent') || (!vehicleNow && (v.situation === 'prelaunch' || v.situation === 'flying' || v.situation === 'suborbital')));
    state.assistName = assist ? assistName() : '';
    state.guideAvailable = !!autopilot && !!v && v.type === 'ship';
    state.cameraMode = cam.mode;

    perf.begin('scene'); scene.update(world, dt, paused ? 0 : lastSimDt, cam); perf.end();
    perf.begin('hud');
    { const si = scene.info || {};
      state.rumble = si.rumble || 0; state.buffet = si.buffet || 0;
      if (si.jolt > 0) { cam.kick(si.jolt); si.jolt = 0; } }
    if (v) {
      updateBall(v);
      if (v.nodes.length && autopilot && autopilot.stagedBurnTime) { try { state.burnTime = autopilot.stagedBurnTime(v, v.nodeDv || Math.hypot(v.nodes[0].dv.prograde, v.nodes[0].dv.normal, v.nodes[0].dv.radial)); } catch { state.burnTime = undefined; } }
      else state.burnTime = undefined;
    }
    hud.update(world, v, state, dt);
    // what is loading each strained joint, kept for the message if it breaks
    { const st = v && v.structure;
      if (st && st.valid && st.maxUtil > 0.75) { const js = st.joints; for (let i = 0; i < js.length; i++) { const j = js[i]; if (j.util > 0.75) strain.set(strainKey(j.a.id, j.b.id), stressCause(j)); } }
      else if (strain.size > 64) strain.clear(); }
    hintAcc += dt; if (hintHold > 0) hintHold -= dt;
    if (hintAcc >= 0.5) refreshHint();
    perf.end();
    if (mapOpen && map) { perf.begin('scene'); try { map.update(dt); } catch (err) { console.error('[flight] map update failed:', err); toggleMap(false); } perf.end(); }

    // ---- sound
    const au = app.audio, info = scene.info || {};
    if (paused || !v) { au.setEngine(0); au.setWind(0); if (au.setReentry) au.setReentry(0); }
    else {
      const lvl = v.maxThrust > 0 && !v.onRails ? clamp(v.thrust / v.maxThrust, 0, 1) * (v.thrust > 0 ? 1 : 0) : 0;
      let kind = 'liquid', best = 0;
      if (lvl > 0) for (const e of v.engines || []) {
        const p = e.part; if (!p.ignited || p.flameout) continue;
        const k = engineKind(p.def), w = (p.def.engine.thrust || p.def.engine.thrustVac || 1) * (k === 'solid' && !(p.res.solid > 0) ? 0 : 1);
        if (w > best) { best = w; kind = k; }
      }
      const atm = clamp(v.body.pressureAtm(Math.max(0, v.altitude)), 0, 1);
      const quiet = mapOpen ? 0.5 : 1;
      au.setEngine(lvl * quiet, { vacuum: atm < 0.05, solid: kind === 'solid', kind, atm });
      au.setWind(clamp((v.dynamicPressure || 0) / 22000, 0, 1) * (mapOpen ? 0.4 : 1));
      if (au.setReentry) au.setReentry(clamp((info.heatGlow || 0) * 1.2, 0, 1) * quiet);
      // cabin warnings: a caution chirp when a new alert comes up, the master alarm while it is critical
      const hot = v.isHot ? (v.maxTempRatio || 0) : 0;
      const terrain = !v.landed && v.type === 'ship' && v.verticalSpeed < -12 && v.radarAlt > 0 && v.radarAlt < Math.max(250, -v.verticalSpeed * 7) && !(v.chuteParts || []).some(p => p.deployed === 'full' || p.deployed === 'semi');
      const danger = Math.max(clamp((hot - 0.55) / 0.35, 0, 1), clamp(((v.gForce || 0) - 5) / 4, 0, 1), terrain ? clamp(-v.verticalSpeed / 60, 0.3, 1) : 0, v.type === 'ship' && !v.controllable && !v.landed ? 0.4 : 0);
      state.danger += (danger - state.danger) * Math.min(1, dt * 4);
      warnAcc -= dt;
      const crit = hot > 0.85 || (v.gForce || 0) > 8 || (terrain && v.radarAlt < -v.verticalSpeed * 3.5);
      if (crit && warnAcc <= 0 && world.warpIndex <= 3) { au.play('master', { volume: 0.7 }); warnAcc = 1.4; }
      else if (danger > 0.35 && warnAcc <= 0) { au.play('warning', { volume: 0.6 }); warnAcc = 3.2; }
      // a soft beep on each situation change (reaching space, orbit, …) and when a planned burn is ten seconds away
      if (v.situation !== lastSit) { if (lastSit && v.type === 'ship' && v.situation !== 'prelaunch') { au.play('beep'); if (v.situation === 'orbit' && hud) hud.cheer(6); } lastSit = v.situation; }
      if (v.nodes.length && Number.isFinite(state.burnTime)) {
        const lead = v.nodes[0].t - world.ut - state.burnTime / 2;
        if (lead > 0 && lead < 10.5 && !(world.warpIndex > 3)) { beepAcc -= dt; if (beepAcc <= 0) { au.play('beep', { volume: lead < 3.5 ? 1 : 0.6 }); beepAcc = lead < 3.5 ? 1 : 2; } } else beepAcc = 0;
      }
    }
    // the calm score plays while coasting in space, never over a burn or through the air
    const inSpace = !!v && !paused && !v.landed && v.altitude > (v.body.atmo ? v.body.atmo.height : 15000) && !(v.thrust > 0) ;
    if (inSpace !== musicOn) { musicT += dt; if (musicT > (inSpace ? 4 : 1.5)) { musicOn = inSpace; musicT = 0; au.setAmbient(inSpace, 'space'); } } else musicT = 0;
  }
  let musicOn = false, musicT = 0;

  function render() {
    const r = app.renderer;
    if (!r || !entered || !scene) return;
    if (mapOpen && map) { try { map.render(); } catch (err) { console.error('[flight] map render failed:', err); toggleMap(false); } }
    else scene.render(r);
    if (!hud.hidden) {
      const rect = hud.ballRect();
      if (rect) { ball.render(r, rect, app.size.h); perf.begin('hud'); ball.drawOverlay(hud.overlay); perf.end(); }
    }
  }

  function resize(w, h) {
    if (scene) scene.resize(w, h);
    if (hud) hud.invalidate();
    if (map && map.resize) map.resize(w, h);
  }

  return { is3D: true, capturesKeys: true, enter, exit, update, render, resize, actions };
}
