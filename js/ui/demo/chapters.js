// Starwright demo tour — the chapters. Each is { id, title, sub, limit (real seconds), run(d) } where `d` is the
// director's chapter context (js/ui/demo.js): waits, tweens, captions, cuts, the flight hook and the scripted pointer.
//
// Rules the chapters keep:
//   · they drive the real screens through their public / test hooks and feature-check every one of them; a missing
//     optional hook is skipped (d.attempt), a missing essential one fails the chapter, which the director then skips;
//   · every wait has a limit; a flight that does not reach its goal in time takes the chapter's stand-in (d.fallback)
//     so the tour always moves on;
//   · a chapter can be opened on its own (?demo=1&chapter=<id>): when the previous chapter did not leave the state it
//     continues from, it makes a cut to a prepared scene instead.
import { SYSTEM } from '../../core/bodies.js';
import { PART_LIST, PARTS } from '../../core/parts.js';
import { TECH_TREE } from '../../core/career.js';
import * as AP from '../../core/autopilot.js';
import * as K from './kit.js';
import * as S from './scenes.js';
import { SCENARIOS } from '../../core/scenarios.js';

const TAU = Math.PI * 2;
const $ = (sel, root = document) => root.querySelector(sel);
const fmtKm = m => (Math.abs(m) >= 1e9 ? Math.round(m / 1e9) + ' million km' : Math.abs(m) >= 1e6 ? Math.round(m / 1e3).toLocaleString('en-US') + ' km' : (m / 1000).toFixed(0) + ' km');
const round = (x, n = 1) => Math.round(x / n) * n;

// ------------------------------------------------------------------------------------------------ flight helpers

/** Point the flight camera: yaw = compass bearing from the vessel to the camera, pitch = height (rad), dist in m. */
function camSet(flight, { yaw, pitch, dist, mode, snap = false } = {}) {
  const c = flight && flight.cam;
  if (!c) return;
  if (mode && c.mode !== mode) { c.setMode(mode); c._pendingDir = null; }
  if (yaw != null) c.yaw = yaw;
  if (pitch != null) c.pitch = pitch;
  if (dist != null) {
    // the camera keeps its zoom goal private: reset() adopts defaultDist, so lend it ours for a moment
    const keep = c.defaultDist, y = c.yaw, p = c.pitch;
    c.defaultDist = K.clamp(dist, 4, 3000); c.reset(); c.defaultDist = keep;
    c.yaw = y; c.pitch = p;
    if (snap) c.dist = K.clamp(dist, 4, 3000);
  }
  // a cut: the camera is there in the next frame (it eases its angles by itself, which swept the picture round the
  // ship for a few frames after every cut that came without a fade)
  if (snap && typeof c.snap === 'function') c.snap();
}
function camTween(d, flight, seconds, to, curve) {
  const c = flight.cam, from = { yaw: c.yaw, pitch: c.pitch, dist: c.dist };
  return d.tween(seconds, k => camSet(flight, K.mixPose(from, to, k)), curve);
}
/** Keep turning the camera slowly round the vessel until the returned function is called. */
function camDrift(d, flight, rate = 0.05) { return d.every(dt => { if (flight.cam) flight.cam.yaw += dt * rate; }); }

function flightFromPrevious(d, key, prev) {
  const s = d.shared[key], f = d.app.flight;
  if (d.shared.previous !== prev || !s || !f || f.world !== s.world || d.app.currentName !== 'flight') return null;
  const v = s.world.active;
  if (!v || v.dead) return null;
  return { world: s.world, vessel: v, flight: f, sim: d.attachSim(s.world), ...s.extra };
}
const hud = (flight, hidden) => { try { if (flight && flight.hud && flight.hud.setHidden) flight.hud.setHidden(!!hidden); } catch { /* optional */ } };
const lapse = (d, sim, scale) => { sim.scale = scale; d.badge(scale > 1 ? 'Time-lapse ×' + scale : null); };

// ------------------------------------------------------------------------------------------------ builder helpers

/** Turn a finished design into the list of placements that rebuilds it, one per part or symmetry group. */
function buildPlan(craft) {
  const steps = [], seen = new Set();
  const parts = craft.parts.slice().sort((a, b) => a.id - b.id);
  for (const p of parts) {
    if (p.sym) { const key = p.sym; if (seen.has(key)) continue; seen.add(key); }
    const group = p.sym ? parts.filter(o => o.sym === p.sym) : [p];
    const parent = p.parent != null ? craft.getPart(p.parent) : null;
    // children of a symmetric parent are mirrored by the editor itself: count only the copies on THIS parent
    const onParent = group.filter(o => o.parent === p.parent).length;
    steps.push({ type: p.type, node: p.node, parent: p.parent, y: p.pos.y, angle: p.rot, symmetry: p.node === 'radial' ? Math.max(1, onParent) : 1, ids: group.map(o => o.id), parentSym: parent ? parent.sym : 0 });
  }
  return steps;
}

async function pickPart(d, b, type, quick = false) {
  const def = PARTS[type];
  // open the part's category the way a player would, then take it from the bin
  const tab = def && $(`.bld-cat[data-cat="${def.cat}"]`);
  if (tab && !tab.classList.contains('active')) { d.attempt(() => tab.click(), 'category tab'); await d.waitFrames(1); }
  const item = $(`.bld [data-part="${type}"]`);
  if (item) {
    d.attempt(() => item.scrollIntoView({ block: 'nearest' }));
    const r = item.getBoundingClientRect();
    d.pointer.leaveCanvas();
    await d.pointer.move(r.left + r.width / 2, r.top + r.height / 2, quick ? 0.3 : 0.42);
    await d.pointer.click();
  }
  if (b.held !== type) { if (b.held) b.cancel(); if (!b.pick(type)) throw new Error('could not pick ' + type); }
}

// ------------------------------------------------------------------------------------------------ chapters

export const CHAPTERS = [
  // ---------------------------------------------------------------------------------------------- 1
  {
    id: 'title', title: 'Starwright', sub: 'An original rocket-building and orbital flight game', limit: 60,
    async run(d) {
      const app = d.app;
      if (app.currentName !== 'title' || !app.current) await d.cut(() => d.goto('title'), { title: false });
      await d.until(() => !!$('.sw-title-screen.ready') || !app.renderer, 6);
      await d.waitFrames(3, 0.3);
      d.caption('Starwright', 'Build rockets, fly them with real orbital mechanics, explore nineteen worlds. Everything in this tour is the live game, running in a browser tab.', { pos: 'title' });
      await d.wait(2.8);
      await d.poster();
      await d.wait(2.8);
    },
  },

  // ---------------------------------------------------------------------------------------------- 2
  {
    id: 'centre', title: 'The space centre', sub: 'Starwright Flight Center, on the coast of Verda', limit: 120,
    async run(d) {
      const app = d.app;
      let view = null, hub = null;
      await d.cut(async () => {
        await d.goto('hub', { fresh: true });
        hub = app.screens.hub; view = hub && hub.debug && hub.debug.view;
        if (!view) throw new Error('the 3D space centre is not available');
        if (d.opts.hq) d.attempt(() => view.lockQuality(0));
        view.setTimeOfDay(0.37);
        view.flyTo({ target: view.byId.pad.focus.clone().setY(20), az: -0.2, el: 0.5, dist: 2600 }, { snap: true });
      });
      const tod = { v: 0.37 };
      d.cleanup(() => { d.attempt(() => view.setTimeOfDay(null)); for (const n of document.querySelectorAll('.sw-dock [data-building]')) n.dispatchEvent(new MouseEvent('mouseleave')); });
      const pose = { target: view.pose.target.clone(), az: view.pose.az, el: view.pose.el, dist: view.pose.dist };
      const apply = () => { view.setTimeOfDay(tod.v); view.flyTo(pose, { snap: true }); };
      const stop = d.every(apply);
      const glide = (to, seconds, curve) => {
        const from = { x: pose.target.x, y: pose.target.y, z: pose.target.z, az: pose.az, el: pose.el, dist: pose.dist };
        const goal = { x: to.target.x, y: to.target.y, z: to.target.z, az: to.az, el: to.el, dist: to.dist };
        return d.tween(seconds, k => { const m = K.mixPose(from, goal, k); pose.target.set(m.x, m.y, m.z); pose.az = m.az; pose.el = m.el; pose.dist = m.dist; }, curve);
      };
      const at = (id, az, el, dist, y = 14) => { const b = view.byId[id]; return { target: b.focus.clone().setY(Math.min(b.focus.y, y)), az, el, dist: dist || K.clamp(b.radius * 5.2, 330, 1100) }; };
      const hover = (id, on) => { const card = $(`.sw-dock [data-building="${id}"]`); if (card) card.dispatchEvent(new MouseEvent(on ? 'mouseenter' : 'mouseleave')); };

      d.caption('The space centre', 'A living coastal base with ten working buildings. Drag to fly around it, hover a building for its name plate, click to walk in.', { pos: 'hub' });
      await glide({ target: view.byId.pad.focus.clone().setY(10), az: -0.74, el: 0.24, dist: 1500 }, 3.4);
      const stops = [['hangar', -0.95, 0.26, 0], ['pad', -0.35, 0.2, 520]].filter(s => view.byId[s[0]]);
      let first = true;
      for (const [id, az, el2, dist] of stops) {
        await glide(at(id, az, el2, dist), 2.0);
        hover(id, true);
        await d.wait(1.4);
        if (first) { await d.poster(); first = false; }
        hover(id, false);
      }
      d.caption('Day turns to night', 'The sun follows game time. At dusk the floodlights, runway lamps and windows come on.', { pos: 'hub' });
      const far = { target: view.byId.pad.focus.clone().setY(10), az: 2.35, el: 0.24, dist: 1250 };      // near enough for the lit windows and lamps to read
      await Promise.all([glide(far, 5.0), d.tween(5.0, k => { tod.v = 0.37 + (0.93 - 0.37) * k; }, d.ease.soft)]);
      await d.wait(1.2);
      stop();
    },
  },

  // ---------------------------------------------------------------------------------------------- 3
  {
    id: 'build', title: 'Vehicle Assembly Building', sub: 'Build a rocket, part by part', limit: 150,
    async run(d) {
      const app = d.app;
      const design = K.stock('Ember Twin') || K.stock('Skylark II');
      if (!design) throw new Error('no stock design to build');
      let b = null;
      await d.cut(async () => {
        await d.goto('builder', { site: 'pad', craft: { name: design.name, parts: [], stages: [] }, quality: d.opts.hq ? 'high' : undefined });
        b = app.builder;
        if (!b || typeof b.pick !== 'function' || typeof b.place !== 'function') throw new Error('the assembly hooks (app.builder) are missing');
        await d.until(() => b.ready, 6);
        d.attempt(() => { if (!b.craft.isEmpty) b.newCraft(); });
        d.attempt(() => b.setSymmetry(1));
      });
      d.cleanup(() => { d.pointer.hide(); d.attempt(() => { if (app.builder && app.builder.held) app.builder.cancel(); }); });
      const vr = d.attempt(() => b.viewRect) || { cx: innerWidth / 2, cy: innerHeight / 2, left: 320, right: innerWidth - 260, top: 50, bottom: innerHeight - 40 };
      d.pointer.show(vr.cx - 120, vr.cy + 60);
      d.caption('Vehicle Assembly Building', `${PART_LIST.filter(p => !p.hidden).length} parts in nine categories. The first one hangs from the crane.`, { pos: 'builder' });

      const plan = buildPlan(design);
      const idMap = new Map();                       // stock part id → id in the hall
      // the camera swings slowly through the open quarter of the hall and back: a full turn would look at the rocket
      // through the service gantry's trusses for a third of the chapter
      const spin0 = 0.45, spinT = { t: 0 };
      const stopSpin = d.every(dt => { spinT.t += dt; d.attempt(() => b.setCamera({ yaw: spin0 + 0.5 * (1 - Math.cos(spinT.t * 0.11)) })); });
      const said = new Set();
      // (a caption that follows hard on another waits until the one before it has had time to be read)
      let lastSay = { at: d.clock, words: 17 };
      const say = async (key, title, line) => {
        if (said.has(key)) return;
        said.add(key);
        const left = Math.max(2, lastSay.words / 5) + 0.6 - (d.clock - lastSay.at);   // 0.6 s of margin: real frames are not the fixed step
        if (left > 0) await d.wait(left);
        d.caption(title, line, { pos: 'builder' });
        lastSay = { at: d.clock, words: (title + ' ' + line).split(/\s+/).length };
      };
      let built = true, n = 0;
      for (const step of plan) {
        d.alive();
        try {
          if (step.node === 'radial') d.attempt(() => b.setSymmetry(step.symmetry)); else d.attempt(() => b.setSymmetry(1));
          const quick = n >= 3;                         // the first few parts go on slowly, then the pace picks up
          await pickPart(d, b, step.type, quick);
          const target = step.parent != null ? idMap.get(step.parent) : null;
          let goal = null, action = null;
          if (step.node === 'root') { goal = () => ({ x: vr.cx, y: vr.top + (vr.bottom - vr.top) * 0.3 }); action = { kind: 'root' }; }
          else if (step.node === 'top' || step.node === 'bottom') {
            await say('nodes', 'Attachment nodes', 'Hold a part and every open node it fits glows. Bring it close and it snaps node to node.');
            goal = () => (d.attempt(() => b.nodes) || []).find(o => o.partId === target && o.node === step.node) || d.attempt(() => b.partScreenPos(target, step.node === 'top' ? 1 : -1, 0));
            action = { kind: 'stack', target, node: step.node };
          } else if (step.node === 'radial') {
            await say('sym' + step.symmetry, step.symmetry > 1 ? `Symmetry ×${step.symmetry}` : 'Surface attachment', step.symmetry > 1 ? 'Mirrored sets: place one, the other follows.' : 'Radial parts stick anywhere on a side, facing outward.');
            const parent = b.craft.getPart(target);
            const fy = parent ? K.clamp((step.y - parent.pos.y) / (PARTS[parent.type].h / 2), -1, 1) : 0;
            goal = () => d.attempt(() => b.partScreenPos(target, fy, 0.9));
            action = { kind: 'radial', target, y: step.y, angle: step.angle, symmetry: step.symmetry, mode: 'radial' };
          } else if (step.node === 'outer') {
            await say('outer', 'Boosters', 'Radial decouplers carry whole stacks: here, solid boosters.');
            goal = () => (d.attempt(() => b.nodes) || []).find(o => o.partId === target && o.node === 'outer') || d.attempt(() => b.partScreenPos(target, 0, 1));
            action = { kind: 'outer', target };
          }
          if (!action) throw new Error('unknown attachment ' + step.node);
          const inView = g => (g && Number.isFinite(g.x) ? { x: K.clamp(g.x, vr.left + 24, vr.right - 24), y: K.clamp(g.y, vr.top + 24, vr.bottom - 24) } : null);
          let g = inView(goal && goal());
          if (g) {
            // approach from the side so the part is seen travelling, then settle on the node (the camera is still
            // easing after the last part, so the node is looked up again for the last stretch)
            await d.pointer.move(K.clamp(g.x + 150, vr.left + 30, vr.right - 30), K.clamp(g.y + 46, vr.top + 30, vr.bottom - 30), quick ? 0.3 : 0.42, { canvas: true });
            g = inView(goal()) || g;
            await d.pointer.move(g.x, g.y, quick ? 0.26 : 0.36, { canvas: true });
            const stop = d.every(() => { const q = inView(goal()); if (q) { d.pointer.set(q.x, q.y); d.pointer.send('pointermove'); } });
            await d.wait(quick ? 0.14 : 0.42);
            stop();
          }
          if (n === 4) await d.poster();
          await d.pointer.click();
          let made = d.attempt(() => b.place(action), 'place ' + step.type) || [];
          if (!made.length && b.held) made = d.attempt(() => b.place({ ...action, symmetry: step.symmetry, mode: 'radial' })) || [];
          if (!made.length) throw new Error('could not attach ' + step.type);
          const ids = made.filter(p => p && typeof p.id === 'number').map(p => p.id).sort((x, y) => x - y);
          step.ids.slice().sort((x, y) => x - y).forEach((id, i) => { if (ids[i] != null) idMap.set(id, ids[i]); });
          if (step.node === 'root') idMap.set(step.ids[0], b.craft.root ? b.craft.root.id : ids[0]);
          d.attempt(() => b.frame());                 // keep the growing rocket in the picture
          // a stage has just gone under an engine: the lattice ring that joins the two appeared with it
          if (step.node === 'bottom' && (d.attempt(() => b.craft.interstages().some(t => ids.includes(t.owner))) || false))
            await say('interstage', 'Interstage', 'A stage never rests on a nozzle. An open lattice ring joins it to the rim above the engine, and drops away with it.');
          n++;
          d.note('placed ' + step.type + ' (' + ids.join(',') + ')');
          await d.wait(quick ? 0.12 : 0.22);
        } catch (err) {
          if (typeof err === 'symbol') throw err;
          d.note('assembly step failed (' + step.type + '): ' + (err && err.message));
          built = false;
          break;
        }
      }
      d.pointer.hide();
      d.attempt(() => { if (b.held) b.cancel(); });
      d.attempt(() => b.setSymmetry(1));
      const same = built && b.craft.parts.length === design.parts.length && d.attempt(() => b.craft.validate().ok);
      if (!same) {
        d.fallback('the part-by-part build did not finish; the stock design was loaded instead');
        d.attempt(() => b.loadCraft(design.toJSON()));
        await d.wait(0.6);
      }
      d.attempt(() => { b.craft.name = design.name; });
      d.shared.craft = d.attempt(() => { const j = b.craft.toJSON(); j.name = design.name; return j; }) || design.toJSON();
      // the finished rocket: staging stack and delta-v read-outs
      d.attempt(() => b.frame());
      const stats = d.attempt(() => b.craft.stats()) || [];
      const dv = stats.reduce((s, x) => s + (x.dvVac || 0), 0), first = stats.find(x => x.thrust > 0);
      d.caption('Staging and delta-v', `${b.craft.stages.length} stages, each with its delta-v, thrust-to-weight and burn time: ${round(dv, 10).toLocaleString('en-US')} m/s in all.`, { pos: 'builder' });
      for (const m of ['com', 'cot']) d.attempt(() => { const btn = $(`.bld [data-marker="${m}"]`); if (btn && !btn.classList.contains('active')) btn.click(); });
      await d.wait(4.0);
      stopSpin();
    },
  },

  // ---------------------------------------------------------------------------------------------- 4
  {
    id: 'launch', title: 'Launch', sub: 'Roll-out, ignition and staging', limit: 140,
    async run(d) {
      const fl = await d.cut(async () => {
        const scene = S.padLaunch(d.shared.craft || null);
        const f = await d.enterFlight(scene.world);
        // From the south and from above: the pad deck in front of the rocket is in the picture, so it is plain that it
        // stands ON the pad. (A low camera here looked along the deck at a rocket framed by the flame channel's dark
        // floor and blast walls, which read as a rocket standing in a pit.) The pad's floodlight masts stand at
        // 134° and 226°, 47 m out: the moves below stay clear of both.
        camSet(f.flight, { mode: 'orbit', yaw: 3.2, pitch: 0.3, dist: 62, snap: true });
        hud(f.flight, true);                            // the roll-out is a clean look at the rocket; the instruments come on at ignition
        return f;
      });
      const { world, sim, flight } = fl, v = world.active;
      d.caption('Roll-out', `${v.name} on the pad you saw from the space centre: ${v.partList ? v.partList.length : v.parts.size} parts, ${(v.mass / 1000).toFixed(1)} tonnes, one Pip aboard.`, { pos: 'flight' });
      await camTween(d, flight, 4.3, { yaw: 3.75, pitch: 0.15, dist: 50 });
      hud(flight, false);
      let dropped = 0;
      const off = world.on('decouple', () => { dropped++; });
      d.cleanup(() => d.attempt(off));
      const ctl = AP.ascentProgram(world, { targetAlt: 85000, useWarp: true });
      sim.ctl = ctl;
      const t0 = world.ut;
      d.caption('Lift-off', 'Solid boosters and the liquid core light together. The ascent guidance flies it; every force is simulated.', { pos: 'flight' });
      camTween(d, flight, 5, { yaw: 3.45, pitch: 0.02, dist: 85 }, d.ease.out).catch(() => {});
      await d.untilSim(world, () => v.altitude > 95, 30);
      await d.poster();
      await d.untilSim(world, () => v.altitude > 240, 30);
      lapse(d, sim, 4);
      const drift = camDrift(d, flight, 0.07);
      camTween(d, flight, 4, { pitch: 0.2, dist: 60 }).catch(() => {});
      await d.untilSim(world, () => world.ut - t0 > 30 || dropped > 0, 80);
      lapse(d, sim, 1);
      d.caption('Staging', 'Spent boosters are cut loose and tumble away. The staging column on the left shows what fires next.', { pos: 'flight' });
      const ok = await d.untilSim(world, () => dropped > 0, 30);
      if (!ok) d.note('no booster separation seen');
      await d.wait(2.2);
      drift();
      if (v.dead) throw new Error('the rocket was lost on the way up');
      d.shared.ascent = { world, extra: { ctl } };
    },
  },

  // ---------------------------------------------------------------------------------------------- 5
  {
    id: 'orbit', title: 'To orbit', sub: 'Gravity turn, coast and circularisation', limit: 170,
    async run(d) {
      let fl = flightFromPrevious(d, 'ascent', 'launch');
      if (fl && (!fl.ctl || fl.ctl.done)) fl = null;
      if (!fl) {
        // no flight to take over (the chapter was opened on its own, or the launch did not hand one on): cut to the
        // same rocket already climbing on its core stage, never back to the pad
        fl = await d.cut(async () => {
          const scene = S.ascentScene(d.shared.craft || null);
          const f = await d.enterFlight(scene.world);
          camSet(f.flight, { mode: 'orbit', yaw: 3.9, pitch: 0.2, dist: 60, snap: true });
          f.ctl = S.ascentResume(f.world);
          f.sim.ctl = f.ctl;
          return f;
        });
      }
      const { world, sim, flight, ctl } = fl, v = world.active;
      sim.ctl = ctl;                                  // the same ascent guidance carries on from the launch chapter
      d.caption('Gravity turn', 'The rocket leans east and lets gravity bend its path, trading height for sideways speed.', { pos: 'flight' });
      lapse(d, sim, 16);
      const drift = camDrift(d, flight, 0.05);
      camTween(d, flight, 6, { pitch: 0.3, dist: 55 }).catch(() => {});
      await d.untilSim(world, () => ctl.done || ctl.phase === 'coast' || ctl.phase === 'coastToAp' || v.altitude > 60000, 400);
      if (!ctl.done) {
        d.caption('Coast to apoapsis', 'Engine off above the air. Time warp carries the ship to the top of its arc.', { pos: 'flight', badge: 'Time warp' });
        // the coast is a quiet stretch: after the caption has been read, the Missions panel (O) is opened over it
        const coasting = () => !(ctl.done || ctl.phase === 'circularise');
        let panelAt = null;
        await d.untilSim(world, () => !coasting(), 900, { real: 4.4 });
        if (coasting() && d.attempt(() => { flight.hud.togglePanel('missions'); return true; }, 'missions panel')) {
          panelAt = d.clock;
          d.cleanup(() => d.attempt(() => flight.hud.closePanels()));
          d.caption('Missions', 'The Missions panel follows the next program mission and your contracts, with live progress, while you fly.', { pos: 'flight', badge: 'Time warp' });
          await d.untilSim(world, () => !coasting(), 900, { real: 56 });
          const left = 4.2 - (d.clock - panelAt);
          if (left > 0) await d.wait(left);
          d.attempt(() => flight.hud.closePanels());
        }
      }
      if (!ctl.done) {
        lapse(d, sim, 5);
        d.caption('Orbit insertion', 'One more burn at the top makes the arc a circle. The upper stage takes over on the way.', { pos: 'flight', badge: 'Time-lapse ×5' });
        camTween(d, flight, 3, { pitch: 0.12, dist: 34 }).catch(() => {});
        await d.untilSim(world, () => ctl.done, 300);
      }
      lapse(d, sim, 1);
      sim.ctl = null;
      if (v.dead) throw new Error('the rocket was lost on the way up');
      if (v.situation !== 'orbit') {
        d.fallback('the ascent did not end in orbit; the ship was placed there');
        K.teleport(world, v, SYSTEM.home, K.orbitState(SYSTEM.home, 85000, world.ut, { phase: -1.1 }));
      }
      v.ctrl.throttle = 0; v.ctrl.sas = true; v.ctrl.sasMode = 'prograde';
      const o = v.getOrbit(world.ut), R = v.body.radius;
      d.caption('In orbit', `${((o.periapsis - R) / 1000).toFixed(0)} by ${((o.apoapsis - R) / 1000).toFixed(0)} km above Verda at ${(v.vel.length() / 1000).toFixed(2)} km/s. From here the ship falls around the planet for free.`, { pos: 'flight' });
      await camTween(d, flight, 2.4, { pitch: 0.34, dist: 26 });
      await d.poster();
      await d.wait(0.7);
      hud(flight, true);
      await d.wait(1.7);
      hud(flight, false);
      drift();
      d.shared.orbit = { world };
    },
  },

  // ---------------------------------------------------------------------------------------------- 6
  {
    id: 'map', title: 'Map and maneuvers', sub: 'Plan a burn, warp to it, leave for the moon', limit: 170,
    async run(d) {
      let fl = flightFromPrevious(d, 'orbit', 'orbit');
      if (fl && fl.vessel.situation !== 'orbit') fl = null;
      const openMap = async flight => {
        if (!flight.mapOpen) flight.actions.toggleMap();
        await d.until(() => flight.mapOpen && flight.map, 4);
        if (!flight.map) throw new Error('the map did not open');
        return flight.map;
      };
      let map = null;
      const setup = async f => { hud(f.flight, false); map = await openMap(f.flight); d.attempt(() => { map.focus(f.world.active, { instant: true }); map.setView({ yaw: 0.5, pitch: 0.5 }); }); return f; };
      if (fl) await d.cut(() => setup(fl), { hold: 0.9 });
      else fl = await d.cut(async () => setup(await d.enterFlight(S.orbitScene().world)));
      const { world, sim, flight } = fl, v = world.active, pell = SYSTEM.byId.pell, home = SYSTEM.home;
      const view = { yaw: 0.5, pitch: 0.5, dist: d.attempt(() => map.debug().dist) || home.radius * 6 };
      const setView = () => d.attempt(() => map.setView(view));
      const viewTo = (to, seconds) => { const from = { ...view }; return d.tween(seconds, k => { Object.assign(view, K.mixPose(from, to, k)); setView(); }); };

      d.caption('Map view', 'Your orbit, drawn from the real orbital mechanics, with every world in the system.', { pos: 'map' });
      await viewTo({ yaw: 1.1, pitch: 0.72 }, 3.8);

      let plan = d.attempt(() => AP.planHohmannToMoon(world, v, pell), 'transfer planning');
      if (!plan) {
        d.fallback('no transfer to Pell was found; a plain prograde burn is shown');
        const node = d.attempt(() => v.addNode(world.ut + 600, { prograde: 860, normal: 0, radial: 0 }));
        plan = { node: node || v.nodes[0], dv: 860, encounterUt: null };
      }
      d.attempt(() => map.selectNode(plan.node));
      d.caption('Maneuver node', `One prograde burn of ${Math.round(plan.dv)} m/s, ${Math.round((plan.node.t - world.ut) / 60)} minutes from now, stretches the orbit out to meet the moon Pell.`, { pos: 'map' });
      d.attempt(() => map.focus(home, { keepDist: true }));
      await viewTo({ yaw: 1.5, pitch: 1.02, dist: pell.orbit.a * 3.1 }, 3.2);
      await d.wait(1.0);
      await d.poster();
      await d.wait(0.6);
      d.attempt(() => map.selectNode(null));

      // warp to the burn, fly it in the flight view
      const exec = AP.executeNode(world, v, { useWarp: true });
      sim.ctl = exec;
      d.caption('Time warp', 'Warp runs the clock up to 100,000 times faster and drops out just before the burn.', { pos: 'map', badge: 'Time warp' });
      d.attempt(() => map.focus(v));
      viewTo({ yaw: 1.9, pitch: 0.6, dist: home.radius * 6.5 }, 2.5).catch(() => {});
      // the game's warp drops out some twenty seconds before the burn; those are run as a time-lapse (it only applies
      // off the rails), or the map would sit still under a "Time warp" caption for twenty real seconds
      sim.scale = 10;
      await d.untilSim(world, () => exec.done || v.thrust > 0, Math.max(300, plan.node.t - world.ut + 200), { real: 45 });
      sim.scale = 1;
      if (!exec.done) {
        flight.actions.toggleMap();
        camSet(flight, { mode: 'orbit', yaw: 0.7, pitch: 0.16, dist: 30, snap: true });
        lapse(d, sim, 8);
        d.caption('Transfer burn', 'The guidance holds the nose on the marker and cuts the engine when the planned delta-v is spent.', { pos: 'flight', badge: 'Time-lapse ×8' });
        const drift = camDrift(d, flight, 0.09);
        await d.untilSim(world, () => exec.done, 400);
        drift();
        lapse(d, sim, 1);
      }
      sim.ctl = null;
      v.ctrl.throttle = 0;                             // whatever ended the burn, the engine is off before the clock is run up
      if (exec.failed || !exec.done) d.fallback('the transfer burn did not complete');
      map = await openMap(flight);
      d.attempt(() => map.focus(home, { keepDist: true }));
      view.dist = pell.orbit.a * 3.1; view.pitch = 1.02; setView();
      d.caption('On the way to Pell', 'The new path climbs for nine hours until the moon’s gravity takes over.', { pos: 'map' });
      await viewTo({ yaw: view.yaw + 0.4, pitch: 0.85 }, 2.2);
      if (plan.encounterUt && !exec.failed) {
        d.badge('Time warp');
        d.attempt(() => world.warpTo(plan.encounterUt + 900));
        const there = await d.untilSim(world, () => v.body === pell, plan.encounterUt - world.ut + 4000, { real: 30 });
        d.attempt(() => { world.warpTarget = null; world.setWarp(0); });
        d.badge(null);
        if (there) {
          d.attempt(() => map.focus(pell));
          view.dist = pell.soi * 2.6; view.pitch = 0.7; setView();
          d.caption('Pell encounter', 'Inside Pell’s sphere of influence the path becomes a flyby. A braking burn here would make it an orbit.', { pos: 'map' });
          await viewTo({ yaw: view.yaw + 0.5, dist: pell.soi * 1.5 }, 4.0);
        } else d.fallback('the encounter with Pell was not reached');
      }
      await d.wait(0.8);
      d.attempt(() => { if (flight.mapOpen) flight.actions.toggleMap(); });
    },
  },

  // ---------------------------------------------------------------------------------------------- 7
  {
    id: 'landing', title: 'Landing on Pell', sub: 'A powered descent with no air to help', limit: 150,
    async run(d) {
      const fl = await d.cut(async () => {
        const scene = S.pellDescent();
        const f = await d.enterFlight(scene.world);
        camSet(f.flight, { mode: 'orbit', yaw: 4.2, pitch: 0.42, dist: 30, snap: true });
        return f;
      });
      const { world, sim, flight } = fl, v = world.active;
      if (typeof v.setLegs === 'function') d.attempt(() => v.setLegs(true));
      const ctl = AP.hoverslamLanding(world, v, { useWarp: false });
      sim.ctl = ctl;
      d.caption('Landing on Pell', 'No air, so no parachutes. The landing guidance waits, then brakes hard at the last safe moment.', { pos: 'flight' });
      lapse(d, sim, 4);
      const drift = camDrift(d, flight, 0.06);
      camTween(d, flight, 6, { pitch: 0.3, dist: 24 }).catch(() => {});
      await d.untilSim(world, () => ctl.phase === 'brake' || ctl.phase === 'final' || v.landed || ctl.done, 120);
      sim.scale = 2; d.badge(null);
      d.caption('Braking burn', 'Full throttle a few hundred metres up, then a slow final descent on four legs.', { pos: 'flight' });
      camTween(d, flight, 5, { pitch: 0.12, dist: 19 }).catch(() => {});
      await d.untilSim(world, () => v.radarAlt < 9 || v.landed || ctl.done, 60);
      await d.poster();
      // the caption changes when the legs touch, not when the guidance has finished settling the lander (it stood on
      // the ground for seconds under "Braking burn")
      await d.untilSim(world, () => v.landed || ctl.done || v.grounded || v.radarAlt < 0.4, 90);
      const tTouch = d.clock;
      if (!v.dead) d.caption('Touchdown', `${v.name} is down on Pell: one sixth of home gravity, grey maria to the horizon.`, { pos: 'flight' });
      const down = await d.untilSim(world, () => v.landed || (ctl.done && !ctl.failed) || (v.grounded && v.groundSpeed < 0.3), 40);
      sim.ctl = null;
      drift();
      if (v.dead) throw new Error('the lander was lost');
      if (!down) {
        d.fallback('the landing took too long; the lander was set down');
        const dir = v.body.inertialToSurfaceDir(v.pos.clone().normalize(), world.ut, v.pos.clone());
        const spot = K.flatSpot(v.body, dir, { reach: 3000, samples: 120 });
        v.ctrl.throttle = 0;
        v.landed = true; v.splashed = false;
        v.surface = { dir: spot.dir, qRel: K.World.padFrame(spot.dir), h: 0, qTarget: null, vehicle: false };
        v.syncLanded(world.ut); v.updateTelemetry(world.ut);
      }
      v.ctrl.throttle = 0;
      sim.scale = 1;
      await camTween(d, flight, 2.8, { yaw: flight.cam.yaw + 0.5, pitch: 0.1, dist: 22 });
      const left = 4.0 - (d.clock - tTouch);            // the caption has been up since the legs touched
      await d.wait(Math.max(0.6, left));
      d.shared.landed = { world };
    },
  },

  // ---------------------------------------------------------------------------------------------- 8
  {
    id: 'eva', title: 'EVA, flag and science', sub: 'Step outside', limit: 120,
    async run(d) {
      let fl = flightFromPrevious(d, 'landed', 'landing');
      if (fl && !fl.vessel.landed) fl = null;
      if (!fl) {
        fl = await d.cut(async () => {
          const f = await d.enterFlight(S.pellSurface().world);
          camSet(f.flight, { mode: 'orbit', yaw: 2.3, pitch: 0.1, dist: 20, snap: true });
          return f;
        });
      }
      const { world, sim, flight } = fl, ship = world.active;
      const seat = (ship.partList || [...ship.parts.values()]).find(p => p.crew && p.crew.length);
      if (!seat) throw new Error('nobody is aboard to go outside');
      d.caption('EVA', 'Any Pip can climb out, walk, jump and fly a jetpack, on every solid world in the system.', { pos: 'flight' });
      await d.wait(0.7);
      const pip = flight.actions.evaStart(seat.id);
      if (!pip) throw new Error('the hatch would not open');
      // look back at the lander past the Pip. The camera is put there in the same frame the view changes to the Pip:
      // that is a cut. (Moved afterwards it swept half a turn round the Pip in a second and a half.)
      const ax = K.localAxes(pip), off = pip.pos.clone().sub(ship.pos);
      const bearing = Math.atan2(off.dot(ax.east), off.dot(ax.north));
      camSet(flight, { mode: 'orbit', yaw: bearing + 0.5, pitch: 0.36, dist: 8.2, snap: true });
      await d.waitFrames(3, 0.4);
      // (from above: a camera at knee height hid the Pip's legs and the lander's feet behind every swell of the ground)
      await camTween(d, flight, 1.4, { yaw: bearing + 0.55, pitch: 0.36, dist: 7.5 });
      // Walk away from the ship. The Pip came out with its back to the hatch and it walks the way it faces (it turns
      // toward the commanded direction before it steps: Vessel._stepLanded), so it comes toward the camera, visor first.
      // The last steps bear off to the left of the picture, so the flag it plants ahead of itself stands beside it in
      // the shot and not between it and the lens.
      const walk = { on: true, veer: 0 }, axes = {};
      sim.hooks.push(() => {
        if (!walk.on || pip.dead || world.active !== pip) return;
        K.localAxes(pip, axes);
        const out = pip.pos.clone().sub(ship.pos); out.addScaledVector(axes.up, -out.dot(axes.up));
        if (out.lengthSq() < 1e-6) out.copy(axes.east);
        out.normalize();
        if (walk.veer) out.multiplyScalar(Math.cos(walk.veer)).addScaledVector(out.clone().cross(axes.up).normalize(), Math.sin(walk.veer));   // + = clockwise on the compass
        const l = out.applyQuaternion(pip.q.clone().invert());
        pip.ctrl.tx = l.x; pip.ctrl.tz = l.z;
      });
      camTween(d, flight, 5, { yaw: bearing + 0.62, pitch: 0.36, dist: 9 }).catch(() => {});
      await d.untilSim(world, () => pip.pos.distanceTo(ship.pos) > 7.6, 10);
      walk.veer = -0.35;
      await d.untilSim(world, () => pip.pos.distanceTo(ship.pos) > 9, 4);
      walk.on = false; pip.ctrl.tx = pip.ctrl.tz = 0;
      await d.wait(0.7);
      const flag = await d.attempt(() => flight.actions.plantFlag('First Steps'), 'flag');
      if (!flag) d.note('no flag was planted');
      d.caption('Flag planted', 'Flags stay where they are planted and show up in the tracking station.', { pos: 'flight' });
      // come in on the Pip and its flag, three-quarter face to the lens, the lander behind them
      await camTween(d, flight, 3.5, { yaw: bearing + 0.36, pitch: 0.26, dist: 6.5 });
      await d.poster();
      const rec = d.attempt(() => flight.actions.evaExperiment('surface_sample'), 'surface sample');
      d.attempt(() => flight.actions.evaExperiment('eva_report'), 'EVA report');
      d.attempt(() => flight.hud.togglePanel('science'), 'science panel');
      d.caption('Science', `A surface sample from Pell’s ${rec && rec.biome ? rec.biome : 'surface'}. Results are worth more from farther worlds. Bring them home or transmit them.`, { pos: 'flight' });
      await d.wait(4.5);
      d.attempt(() => flight.hud.closePanels());
    },
  },

  // ---------------------------------------------------------------------------------------------- 9
  {
    id: 'reentry', title: 'Coming home', sub: 'Re-entry, parachute, splashdown', limit: 150,
    async run(d) {
      const fl = await d.cut(async () => {
        const f = await d.enterFlight(S.reentryScene().world);
        camSet(f.flight, { mode: 'orbit', yaw: 1.0, pitch: 0.28, dist: 13, snap: true });
        return f;
      });
      const { world, sim, flight } = fl, v = world.active;
      v.ctrl.sas = true; v.ctrl.sasMode = 'srfRetrograde';
      d.caption('Re-entry', 'Home again at two kilometres a second. The heat shield takes the plasma and burns away as it goes.', { pos: 'flight' });
      lapse(d, sim, 3);
      const drift = camDrift(d, flight, 0.12);
      await d.untilSim(world, () => (v.heatFlux || 0) > 56000 || v.altitude < 38500, 40);
      d.note('plasma at ' + Math.round(v.altitude) + ' m');
      await d.poster();
      await d.untilSim(world, () => v.altitude < 37200, 30);
      drift();
      if (v.dead) throw new Error('the capsule burned up');
      // cut: the same capsule minutes later, under its parachute off the coast
      await d.cut(async () => {
        lapse(d, sim, 1);
        K.teleport(world, v, SYSTEM.home, S.chuteState(world));
        v.ctrl.sas = true; v.ctrl.sasMode = 'srfRetrograde';
        camSet(flight, { mode: 'orbit', yaw: 1.2, pitch: -0.12, dist: 26, snap: true });
        world.active = v;
        if (v.stageIndex < v.stages.length) flight.actions.stage();
        await d.waitFrames(3, 0.3);
      }, { title: false, settle: 0.5 });
      d.caption('Parachute', 'A small drogue slows the capsule first. Then the main comes out reefed, a narrow sock, and opens fully 900 metres up.', { pos: 'flight' });
      const chuteFull = () => (v.chuteParts || []).some(p => p.deployed === 'full');
      lapse(d, sim, 4); d.badge(null);
      const full = await d.untilSim(world, () => chuteFull() || v.landed, 60);
      sim.scale = 1;
      if (v.dead) throw new Error('the capsule was lost under its parachute');
      d.note('canopy ' + (full ? 'open' : 'not seen open') + ' at ' + Math.round(v.radarAlt) + ' m');
      await d.wait(0.6);
      lapse(d, sim, 30);
      const drift2 = camDrift(d, flight, 0.05);
      camTween(d, flight, 6, { pitch: 0.1, dist: 30 }).catch(() => {});
      await d.untilSim(world, () => v.radarAlt < 45 || v.landed, 400);
      d.note('near the sea: ' + Math.round(v.radarAlt) + ' m');
      lapse(d, sim, 1.5); d.badge(null);
      d.caption('Splashdown', 'Down in the sea a few kilometres off the space centre. Recovery pays back the parts and banks the science.', { pos: 'flight' });
      const down = await d.untilSim(world, () => v.landed, 60);
      if (!down) d.fallback('the capsule did not settle in time');
      sim.scale = 1;
      await camTween(d, flight, 2.0, { pitch: 0.16, dist: 17 });
      await d.wait(0.8);
      drift2();
    },
  },

  // ---------------------------------------------------------------------------------------------- 10
  {
    id: 'plane', title: 'Spaceplane hangar', sub: 'Wings, wheels and a runway take-off', limit: 160,
    async run(d) {
      const app = d.app;
      const design = K.stock('Kite Trainer');
      if (!design) throw new Error('the stock aeroplane is not available');
      // the hangar
      let hangar = false;
      try {
        await d.cut(async () => {
          const json = design.toJSON(); json.site = 'runway';
          await d.goto('builder', { site: 'runway', craft: json, quality: d.opts.hq ? 'high' : undefined });
          const b = app.builder; if (!b) throw new Error('the hangar hooks are missing');
          await d.until(() => b.ready, 6);
          d.attempt(() => b.frame());
        });
        hangar = true;
      } catch (err) {
        if (typeof err === 'symbol') throw err;
        d.fallback('the spaceplane hangar could not be shown: ' + (err && err.message));
      }
      if (hangar) {
        const b = app.builder;
        d.caption('Spaceplane hangar', 'Aircraft are built lying down, with mirror symmetry: wings, control surfaces, gear and jets.', { pos: 'builder' });
        let yaw = d.attempt(() => b.camera.yaw) || 0.7;
        const stop = d.every(dt => { yaw += dt * 0.16; d.attempt(() => b.setCamera({ yaw, dist: 12.5, pitch: 0.26 })); });
        await d.wait(3.7);
        for (const m of ['com', 'col']) d.attempt(() => { const btn = $(`.bld [data-marker="${m}"]`); if (btn && !btn.classList.contains('active')) btn.click(); });
        d.caption('Balance markers', 'Keep the centre of lift a little behind the centre of mass.', { pos: 'builder' });
        await d.wait(1.5);
        await d.poster();
        await d.wait(1.8);
        stop();
      }
      // the runway
      const fl = await d.cut(async () => {
        const f = await d.enterFlight(S.runwayScene(design.name).world);
        camSet(f.flight, { mode: 'orbit', yaw: 3.9, pitch: 0.1, dist: 22, snap: true });
        return f;
      }, { title: 'Runway', sub: 'Take-off', hold: 0.8 });
      const { world, sim, flight } = fl, v = world.active;
      const ctl = AP.planeTakeoff(world, v, { altitude: 300 });
      sim.ctl = ctl;
      d.caption('Runway take-off', `${v.name}: a jet trainer on real wings. Lift, drag and stall come from each surface, so it rotates when the wing is ready, not before.`, { pos: 'flight' });
      sim.scale = 1.8;
      camTween(d, flight, 5, { yaw: 4.6, pitch: 0.08, dist: 26 }).catch(() => {});
      await d.untilSim(world, () => ctl.phase === 'climb' || ctl.done || v.radarAlt > 4, 60);
      lapse(d, sim, 2.6);
      camTween(d, flight, 5, { yaw: 5.6, pitch: 0.02, dist: 30 }).catch(() => {});
      await d.untilSim(world, () => v.radarAlt > 120 || ctl.done, 40);
      if (!d.opts.poster) await d.wait(0.1); else await d.poster('takeoff');
      const up = await d.untilSim(world, () => ctl.done, 60);
      lapse(d, sim, 1);
      if (!up || ctl.failed || v.dead) d.fallback('the take-off did not reach its altitude');
      await d.wait(1.0);
    },
  },

  // ---------------------------------------------------------------------------------------------- 11
  {
    id: 'rover', title: 'Rover on Rusk', sub: 'Wheels on another world', limit: 110,
    async run(d) {
      const fl = await d.cut(async () => {
        const scn = S.roverScene();
        const f = await d.enterFlight(scn.world);
        // behind and to one side of the way it will drive (the route picks its own heading)
        camSet(f.flight, { mode: 'orbit', yaw: 2.4 + ((scn.heading ?? 90) - 90) * Math.PI / 180, pitch: 0.12, dist: 9, snap: true });
        return f;
      });
      const { world, sim, flight } = fl, v = world.active;
      d.attempt(() => { if (typeof v.setLights === 'function') v.setLights(true); });
      const ctl = AP.roverDrive(world, v, { distance: 72, speed: 8 });
      sim.ctl = ctl;
      d.caption('Rover on Rusk', 'Six powered wheels with suspension on real terrain. Every world has its own ground, gravity and sky; here, red dunes under thin air.', { pos: 'flight' });
      lapse(d, sim, 1.5); d.badge(null);
      const drift = camDrift(d, flight, 0.16);
      camTween(d, flight, 7, { pitch: 0.17, dist: 12 }).catch(() => {});
      await d.untilSim(world, () => (ctl.driven || 0) > 36 || ctl.done, 60);
      await d.poster();
      const ok = await d.untilSim(world, () => ctl.done, 90);
      sim.scale = 1;
      if (!ok || ctl.failed) d.fallback('the rover did not finish its drive');
      await d.wait(1.0);
      drift();
    },
  },

  // ---------------------------------------------------------------------------------------------- 12
  {
    id: 'docking', title: 'Docking', sub: 'Two ships become one', limit: 150,
    async run(d) {
      let target = null;
      const fl = await d.cut(async () => {
        const f = await d.enterFlight(S.dockScene().world);
        target = f.world.vessels.find(o => o !== f.world.active && o.type === 'ship');
        if (!target) throw new Error('the station is missing');
        if (!f.world.getTarget(f.world.active)) f.world.setTarget(f.world.active, target);
        camSet(f.flight, { mode: 'orbit', yaw: 0.6, pitch: 0.2, dist: 34, snap: true });
        return f;
      });
      const { world, sim, flight } = fl, v = world.active;
      v.ctrl.rcs = true;
      let docked = false;
      const off = world.on('dock', () => { docked = true; });
      d.cleanup(() => d.attempt(off));
      const ctl = AP.dockingApproach(world, v, target, {});
      sim.ctl = ctl;
      d.caption('Docking', 'RCS thrusters line the chaser up on the station’s Latch Ring. The read-out shows distance and closing speed to the target.', { pos: 'flight' });
      lapse(d, sim, 6);
      const drift = camDrift(d, flight, 0.07);
      camTween(d, flight, 6, { pitch: 0.3, dist: 30 }).catch(() => {});
      await d.untilSim(world, () => docked || ctl.done || ctl.phase === 'final', 300);
      await d.untilSim(world, () => docked || ctl.done || (v.targetInfo && v.targetInfo.distance < 14), 120);
      sim.scale = 2.5; d.badge(null);
      d.caption('Capture', 'Inside half a metre the rings pull themselves together. Docked ships share fuel and fly as one.', { pos: 'flight' });
      camTween(d, flight, 4, { pitch: 0.15, dist: 22 }).catch(() => {});
      await d.untilSim(world, () => docked || ctl.done || (v.targetInfo && v.targetInfo.distance < 6), 120);
      await d.poster();
      const ok = await d.untilSim(world, () => docked, 200);
      sim.ctl = null; sim.scale = 1;
      if (!ok) d.fallback('the ships did not dock in time');
      const a = world.active;
      if (a) { a.ctrl.tx = a.ctrl.ty = a.ctrl.tz = 0; a.ctrl.sasMode = 'hold'; }
      await camTween(d, flight, 2.6, { yaw: flight.cam.yaw + 0.5, pitch: 0.24, dist: 30 });
      drift();
    },
  },

  // ---------------------------------------------------------------------------------------------- 13
  {
    id: 'tracking', title: 'Tracking station', sub: 'Every flight, everywhere', limit: 110,
    async run(d) {
      const app = d.app;
      let trk = null;
      await d.cut(async () => {
        const fleet = S.fleetWorld();
        const release = d.pinFlightState(fleet.world.toJSON());
        try { await d.goto('tracking'); } finally { release(); }
        trk = app.screens.tracking;
        await d.until(() => trk.world && trk.world.vessels && trk.world.vessels.length > 0, 8);
        if (!trk.map) throw new Error('the tracking map is missing');
      });
      const w = trk.world, map = trk.map;
      const ships = w.vessels.filter(o => o.type === 'ship');
      d.shared.tracking = true;
      d.caption('Tracking station', `${ships.length} flights in progress around ${new Set(ships.map(o => o.body.name)).size} worlds. Pick any of them to fly, or let time run and watch them move.`, { pos: 'tracking' });
      const view = { yaw: 0.6, pitch: 0.6 };
      const stop = d.every(dt => { view.yaw += dt * 0.08; d.attempt(() => map.setView({ yaw: view.yaw, pitch: view.pitch })); });
      await d.wait(2.2);
      let shown = 0;
      for (const name of ['Pell Base Camp', 'Farwind', 'Whisper 1']) {
        const o = ships.find(s => s.name === name);
        if (!o) continue;
        // the map glides from one flight to the next, and between two worlds that glide crosses empty space: the
        // centre of the screen was black while the caption stood. Each flight is framed at once, behind a short dip.
        await d.fadeOut(0.2);
        d.attempt(() => { trk.select(o, false); map.focus(o, { instant: true }); });
        await d.waitFrames(2, 0.05);
        await d.fadeIn(0.25);
        await d.wait(shown === 1 ? 1.0 : 1.5);
        if (shown === 1) { await d.poster(); await d.wait(0.8); }
        shown++;
      }
      stop();
    },
  },

  // ---------------------------------------------------------------------------------------------- 14
  {
    id: 'system', title: 'The Helion system', sub: 'Nineteen worlds to visit', limit: 170,
    async run(d) {
      const app = d.app;
      let trk = app.screens.tracking;
      if (!(d.shared.previous === 'tracking' && app.currentName === 'tracking' && trk && trk.map)) {
        await d.cut(async () => {
          const fleet = S.fleetWorld();
          const release = d.pinFlightState(fleet.world.toJSON());
          try { await d.goto('tracking'); } finally { release(); }
          trk = app.screens.tracking;
          await d.until(() => trk.map, 6);
          if (!trk.map) throw new Error('the tracking map is missing');
        });
      }
      const map = trk.map, by = SYSTEM.byId, star = SYSTEM.star;
      d.attempt(() => { const tab = $('.trk-tab[data-tab="worlds"]'); if (tab) tab.click(); });
      const view = { yaw: 0.4, pitch: 0.95, dist: d.attempt(() => map.debug().dist) || 1e10 };
      const setView = () => d.attempt(() => map.setView(view));
      const viewTo = (to, seconds, curve) => { const from = { ...view }; return d.tween(seconds, k => { Object.assign(view, K.mixPose(from, to, k)); setView(); }, curve); };
      const planets = SYSTEM.bodies.filter(b => b.parent === star).length, moons = SYSTEM.bodies.filter(b => b.parent && b.parent !== star).length;

      d.attempt(() => map.focus(star, { keepDist: true }));
      d.caption('The Helion system', `${SYSTEM.bodies.length} bodies: one star, ${planets} worlds circling it, from a lava planet to a comet, and ${moons} moons, each with its own ground and gravity.`, { pos: 'tracking' });
      await viewTo({ yaw: 0.9, pitch: 1.05, dist: (by.rusk ? by.rusk.orbit.a : 2e10) * 3.4 }, 2.6);
      await viewTo({ yaw: 1.3, pitch: 0.8, dist: (by.orrin ? by.orrin.orbit.apoapsis : 1.3e11) * 2.9 }, 2.8);
      await d.wait(0.2);

      const stops = [
        ['sear', 3.3, 'Sear', 'A tidally locked lava world. One face stares at the sun for ever over a molten sea.'],
        ['orrin', 0, 'Orrin', b => `A ringed amber giant ${fmtKm(b.orbit.a)} from the sun, ${Math.round(b.radius / SYSTEM.home.radius * 10) / 10} times the size of home.`],
        ['brim', 3.4, 'Brim', 'Orrin’s ice-shell moon. Under the cracked crust lies an ocean, open in long dark leads.'],
        ['wend', 5, 'Wend', b => `A two-lobed comet on a stretched orbit: it dives inside Verda's path and swings out beyond Thal.`],
      ].filter(s => by[s[0]]);
      let i = 0;
      for (const [id, k, name, line] of stops) {
        const b = by[id];
        const dist = b.ring ? b.ring.outer * 3.3 : b.radius * (k || 3.4);
        d.hideCaption();
        await d.fadeOut(0.3);
        d.attempt(() => map.focus(b, { instant: true, keepDist: true }));
        d.attempt(() => map.select(b));
        view.dist = dist * 1.5; view.pitch = b.ring ? 0.24 : 0.3; view.yaw = 0.3 + i * 0.9; setView();
        await d.waitFrames(d.opts.hq ? 10 : 4, d.opts.hq ? 2.5 : 0.45);
        await d.fadeIn(0.4);
        d.caption(name, typeof line === 'function' ? (d.attempt(() => line(b)) || b.blurb || '') : line, { pos: 'tracking' });
        const move = viewTo({ yaw: view.yaw + 0.7, dist }, 4.1, d.ease.out);
        if (id === 'orrin') { await d.wait(2.0); await d.poster(); }
        await move;
        i++;
      }
      d.attempt(() => map.select(null));
    },
  },

  // ---------------------------------------------------------------------------------------------- 15
  {
    id: 'program', title: 'Running a program', sub: 'Research, contracts and crew', limit: 110,
    async run(d) {
      const app = d.app, career = app.career;
      // ---- research
      await d.cut(async () => { await d.goto('research'); await d.waitFrames(2, 0.2); });
      const owned = TECH_TREE.filter(n => career.tech.has(n.id)).length;
      d.caption('Research', `${TECH_TREE.length} technologies unlock ${PART_LIST.filter(p => !p.hidden).length} parts. Science from experiments pays for them: ${owned} researched so far.`, { pos: 'page' });
      await d.wait(1.6);
      const want = TECH_TREE.filter(n => !career.tech.has(n.id) && d.attempt(() => career.canUnlockTech(n.id).ok)).sort((a, b) => a.cost - b.cost)[0];
      if (want) {
        const node = $(`.sw-node[data-tech="${want.id}"]`);
        if (node) {
          const r = node.getBoundingClientRect();
          d.pointer.show(r.left + r.width / 2 - 160, r.top + r.height / 2 + 120);
          await d.pointer.move(r.left + r.width / 2, r.top + r.height / 2, 0.7);
          await d.pointer.click(); node.click();
          await d.wait(1.2);
          await d.poster();
          const btn = $('[data-action="unlock"]');
          if (btn && !btn.disabled) {
            const q = btn.getBoundingClientRect();
            await d.pointer.move(q.left + q.width / 2, q.top + q.height / 2, 0.7);
            await d.pointer.click(); btn.click();
            d.caption('Researched', `${want.name}: ${want.parts.length} new part${want.parts.length === 1 ? '' : 's'} in the hangar.`, { pos: 'page' });
          }
          await d.wait(2.5);
          d.pointer.hide();
        }
      } else { await d.poster(); await d.wait(2); }
      // ---- contracts
      let ok = true;
      try { await d.cut(async () => { await d.goto('missions'); await d.waitFrames(2, 0.2); }, { title: false }); } catch (err) { if (typeof err === 'symbol') throw err; ok = false; d.fallback('Mission Control could not be opened'); }
      if (ok) {
        d.caption('Contracts', 'Mission Control posts paid work that fits what your program can do: satellites, tourists, rescues, rover drives, stations.', { pos: 'page' });
        await d.wait(1.8);
        const accept = $('.sw-contract.offer [data-action="accept"]:not([disabled])');
        if (accept) {
          const r = accept.getBoundingClientRect();
          d.pointer.show(r.left - 140, r.top + 90);
          await d.pointer.move(r.left + r.width / 2, r.top + r.height / 2, 0.7);
          await d.pointer.click(); accept.click();
          await d.wait(0.4);
          d.pointer.hide();
        }
        await d.wait(0.9);
        if (d.opts.poster) await d.poster('contracts');
        await d.wait(0.9);
      }
      // ---- crew
      ok = true;
      try { await d.cut(async () => { await d.goto('crew'); await d.waitFrames(2, 0.2); }, { title: false }); } catch (err) { if (typeof err === 'symbol') throw err; ok = false; d.fallback('the Crew Quarters could not be opened'); }
      if (ok) {
        d.caption('Crew', 'Pilots, engineers and scientists. Pips earn stars for what they have done.', { pos: 'page' });
        await d.wait(1.6);
        if (d.opts.poster) await d.poster('crew');
        await d.wait(1.3);
      }
      // ---- scenarios: the picker from the title menu, opened here for a look and closed again (nothing is started)
      if (app.scenarios && typeof app.scenarios.open === 'function') {
        const shut = () => { const m = $('.sw-scn-modal'); if (!m) return; const root = m.closest('.sw-modal-backdrop, .sw-modal-wrap, .sw-overlay') || m.parentElement || m; const b = [...root.querySelectorAll('button')].find(x => x.textContent.trim() === 'Close'); if (b) b.click(); };
        d.attempt(() => { const p = app.scenarios.open(); if (p && p.catch) p.catch(() => {}); }, 'scenarios picker');
        d.cleanup(shut);
        await d.until(() => !!$('.sw-scn-modal'), 1.5);
        if ($('.sw-scn-modal')) {
          d.caption('Scenarios', `${SCENARIOS.length} ready-made flights, from a rocket on the pad to a far planet. Pick one and start there.`, { pos: 'page' });
          await d.wait(4.4);
          if (d.opts.poster) await d.poster('scenarios');
          shut();
          await d.until(() => !$('.sw-scn-modal'), 1.5);
        } else d.note('the scenarios picker did not open');
      }
    },
  },

  // ---------------------------------------------------------------------------------------------- 16
  {
    id: 'closing', title: 'Starwright', sub: 'Build it. Launch it. Bring the Pips home.', limit: 70,
    async run(d) {
      await d.cut(async () => {
        document.body.classList.add('sw-demo-closing');
        await d.goto('title');
        await d.until(() => !!$('.sw-title-screen.ready') || !d.app.renderer, 6);
      }, { title: false, settle: 0.5 });
      d.cleanup(() => document.body.classList.remove('sw-demo-closing'));
      d.caption('It all runs in a browser tab', 'Plain JavaScript modules and three.js: no install, no build step, no network. Open the page and play.', { pos: 'closing' });
      await d.wait(2.5);
      await d.poster();
      await d.wait(2.6);
      d.hideCaption();
      await d.fadeOut(0.9);
    },
  },
];

void TAU;
