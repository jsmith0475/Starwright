// Starwright — the frame every building interior shares (Research Lab, Mission Control, Crew Quarters, Flight School).
//
//   const frame = interiorFrame(app, { name, building, title, code, subtitle, onBack, backLabel })
//     → { root, page, stats, view, setSubtitle(text), setStatus(text, tone), update(dt), render(), resize(w, h), dispose() }
//
// The screen is "at" its building: the live 3D Flight Center keeps rendering behind the panels with the camera parked
// close to that building (it glides there from wherever the hub left it and then sways slowly), under a dark vignette.
// The panels on top are compact instrument panels (see `.sw-interior` in css/career.css). Without WebGL the frame is a
// plain opaque screen and everything still works.
//
//   partIcon(app, defOrId, size)   → <canvas> with the real part mesh (js/render/partmesh.js thumbnails, cached, drawn a
//                                    few per frame by pumpPartIcons). Falls back to a category glyph without WebGL.
//   pumpPartIcons(app, n)          draws up to n queued icons; interiorFrame.update() calls it.
import { el, icon, statsBar } from './dom.js';
import { getBaseView } from './baseview.js';
import { ensureCareerCss } from './careerui.js';
import { PARTS } from '../core/parts.js';

ensureCareerCss();

// Where the camera parks: azimuth (rad, 0 = looking north from the south), elevation, distance as a multiple of the
// building's radius, the height of the look-at point, and how far the view sways.
const POSES = {
  research: { az: 0.62, el: 0.2, k: 1.9, y: 14, sway: 0.09 },
  missions: { az: -0.5, el: 0.19, k: 2.1, y: 12, sway: 0.08 },
  crew: { az: -0.85, el: 0.2, k: 2.3, y: 8, sway: 0.09 },
  school: { az: 0.75, el: 0.17, k: 2.0, y: 14, sway: 0.08 },
  admin: { az: 0.5, el: 0.2, k: 2.0, y: 24, sway: 0.07 },
  tracking: { az: 1.1, el: 0.2, k: 2.0, y: 18, sway: 0.08 },
};

const ICON_OF = { research: 'lab', missions: 'board', crew: 'crew', school: 'school', admin: 'gear', tracking: 'dish' };

export function interiorFrame(app, { name, building = name, title, code = '', subtitle = '', onBack, backLabel = 'Flight Center' } = {}) {
  const stats = statsBar(app, { date: false });
  const sub = el('span', { class: 'sw-topbar-sub', text: subtitle });
  const status = el('span', { class: 'sw-istatus sw-hidden', data: { role: 'status' } });
  const back = el('button', { class: 'sw-btn sw-iback', attrs: { type: 'button', 'data-action': 'back' }, tip: `Back to the ${backLabel === 'Main menu' ? 'main menu' : 'Flight Center'} (Esc)`,
    on: { click: () => (onBack ? onBack() : app.goto('hub')) } }, icon('back'), el('span', { text: backLabel }), el('kbd', { text: 'Esc' }));
  const page = el('div', { class: 'sw-page' });
  let view = null;
  try { view = app.renderer ? getBaseView(app) : null; } catch (err) { console.warn('[interior] no 3D backdrop:', err && err.message); view = null; }
  const root = el('div', { class: 'sw-screen sw-interior ' + (view ? 'live' : 'opaque'), data: { screen: name, building } },
    el('div', { class: 'sw-ishade', attrs: { 'aria-hidden': 'true' } }),
    el('div', { class: 'sw-topbar sw-ibar' }, back,
      el('div', { class: 'sw-iplaque' }, el('span', { class: 'ico' }, icon(ICON_OF[building] || 'star')),
        el('div', { class: 'txt' }, el('span', { class: 'sw-title big', text: title }), el('div', { class: 'line' }, code ? el('span', { class: 'code', text: code }) : null, sub))),
      status, stats.node),
    page);

  let t = 0, base = null;
  if (view) {
    const b = view.byId[building], p = POSES[building] || POSES.research;
    view.begin();
    if (app.career) { view.setTimeOfDay(null); view.setTime(app.career.ut || 0); } else view.setTimeOfDay(0.3);
    if (b) {
      base = { target: b.focus.clone().setY(p.y), az: p.az, el: p.el, dist: Math.max(150, b.radius * p.k), sway: p.sway };
      const far = view.pose.target.distanceTo(base.target) > 1500 || !app.career;
      view.flyTo(base, { snap: far, speed: 2.4 });
      view.update(0, { drift: false });
    }
  }

  return {
    root, page, stats, view,
    setSubtitle(text) { sub.textContent = text; },
    /** A small lamp + caption in the header (tone: '' | 'good' | 'amber' | 'teal'). */
    setStatus(text, tone = '') { status.className = 'sw-istatus ' + tone + (text ? '' : ' sw-hidden'); status.textContent = text || ''; },
    update(dt) {
      pumpPartIcons(app, 3);
      if (!view) return;
      t += dt;
      if (app.career) view.setTime(app.career.ut || 0);
      if (base) { view.goal.az = base.az + Math.sin(t * 0.11) * base.sway; view.goal.el = base.el + Math.sin(t * 0.07 + 1) * 0.012; }
      view.update(dt, { drift: false });
    },
    render() { if (view) view.render(null); else if (app.renderer) app.renderer.clear(); },
    resize(w, h) { if (view) view.resize(w, h); },
    dispose() { if (view) { view.setTimeOfDay(null); view.release(); } root.remove(); },
  };
}

// ------------------------------------------------------------------ part icons (real meshes)

const iconStore = new Map();        // def id → data URL | false (failed)
let iconQueue = [], meshMod = null, meshWanted = false;
const CAT_GLYPH = { command: 'crew', tanks: 'hangar', engines: 'rocket', structure: 'engineer', aero: 'pilot', wings: 'pilot', utility: 'gear', science: 'science', ground: 'gear' };

function paint(canvas, url) {
  const img = new Image();
  img.onload = () => { if (!canvas.isConnected && !canvas.width) return; const g = canvas.getContext('2d'); g.clearRect(0, 0, canvas.width, canvas.height); g.drawImage(img, 0, 0, canvas.width, canvas.height); canvas.dataset.ready = '1'; };
  img.src = url;
}

export function partIcon(app, defOrId, size = 44) {
  const def = typeof defOrId === 'string' ? PARTS[defOrId] : defOrId;
  const box = el('span', { class: 'sw-picon', data: { part: def ? def.id : '' }, style: { width: size + 'px', height: size + 'px' } });
  if (!def) return box;
  if (!app.renderer) { box.appendChild(icon(CAT_GLYPH[def.cat] || 'star')); return box; }
  const c = el('canvas', { attrs: { width: size * 2, height: size * 2 } });
  box.appendChild(c);
  const hit = iconStore.get(def.id);
  if (hit) paint(c, hit);
  else if (hit === false) box.replaceChildren(icon(CAT_GLYPH[def.cat] || 'star'));
  else {
    iconQueue.push({ def, canvas: c, box });
    if (!meshWanted) { meshWanted = true; import('../render/partmesh.js').then(m => { meshMod = m; }).catch(err => { console.warn('[interior] part icons unavailable:', err && err.message); meshMod = false; }); }
  }
  return box;
}

export function pumpPartIcons(app, n = 2) {
  if (!iconQueue.length || meshMod == null) return;
  for (let i = 0; i < n && iconQueue.length; i++) {
    const { def, canvas, box } = iconQueue.shift();
    if (!canvas.isConnected) { i--; continue; }                          // the panel was redrawn meanwhile: skip without cost
    let url = iconStore.get(def.id);
    if (url == null) {
      try { url = meshMod ? meshMod.renderPartThumbnail(app.renderer, def, 64) : false; } catch (err) { console.warn('[interior] icon failed for ' + def.id + ':', err && err.message); url = false; }
      if (url && typeof url !== 'string') url = url.toDataURL ? url.toDataURL() : false;
      iconStore.set(def.id, url || false);
    }
    if (url) paint(canvas, url); else box.replaceChildren(icon(CAT_GLYPH[def.cat] || 'star'));
  }
}
export const partIconsPending = () => iconQueue.length;
