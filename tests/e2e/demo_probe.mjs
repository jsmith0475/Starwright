// What a viewer of the demo tour would see right now, as numbers: run in the page with page.evaluate(probeDemo).
// Shared by tests/e2e/demo_film.mjs (one record per filmstrip frame) and tests/e2e/demo.mjs.
//   { chapter, clock, screen, caption, captionRect, fade, card, hudHidden, mapOpen,
//     flight: { name, body, situation, alt, radar, landed, camClear (m, camera above the ground), subject {x, y, behind}
//               (the active vessel on screen, 0..1 from the top left), dist (camera to vessel), lowClear (m, lowest part
//               above the ground under the vessel) } }
export function probeDemo() {
  const app = window.__sw.app, demo = app.demo, st = demo.state();
  const rect = el => { if (!el) return null; const r = el.getBoundingClientRect(); return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) }; };
  const cap = document.querySelector('.swd-caption'), fade = document.querySelector('.swd-fade'), card = document.querySelector('.swd-card');
  const out = {
    chapter: st.chapter, clock: st.clock, screen: app.currentName, caption: st.captionShown ? st.caption : '', captionRect: st.captionShown ? rect(cap) : null,
    fade: fade ? +(+getComputedStyle(fade).opacity).toFixed(2) : 0, card: !!(card && card.classList.contains('show')),
    watch: demo.watchReport ? demo.watchReport() : null,
  };
  const f = app.flight;
  if (app.currentName === 'flight' && f && f.world && f.world.active && f.view) {
    const v = f.world.active, sc = f.view, cam = sc.camera, a = sc.anchor;
    out.hudHidden = !!(f.hud && f.hud.hidden); out.mapOpen = !!f.mapOpen;
    const fl = out.flight = { name: v.name, type: v.type, body: v.body.name, situation: v.situation, alt: Math.round(v.altitude * 10) / 10, radar: Math.round(v.radarAlt * 100) / 100, landed: !!v.landed, throttle: v.ctrl ? v.ctrl.throttle : 0, ut: Math.round(f.world.ut * 10) / 10, warp: f.world.warpIndex };
    try {
      const p = cam.position.clone().add(a.pos);
      const g = typeof a.groundAt === 'function' ? a.groundAt(p) : a.ground;
      fl.camClear = Math.round((p.length() - g) * 100) / 100;
      fl.dist = Math.round(cam.position.length() * 10) / 10;
      const n = cam.position.clone().set(0, 0, 0).project(cam);
      fl.subject = { x: +((n.x + 1) / 2).toFixed(3), y: +((1 - n.y) / 2).toFixed(3), behind: n.z > 1 || n.z < -1 };
    } catch (err) { fl.probeError = String(err && err.message); }
  }
  return out;
}
