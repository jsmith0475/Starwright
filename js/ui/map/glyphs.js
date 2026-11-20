// Starwright — map marker glyphs (canvas 2D) and vessel roles. All icons are original line drawings.
//
//   ROLES                         [{ id, name }] the roles a player can give a vessel (tracking station "re-type")
//   roleOf(vessel)                'ship' | 'probe' | 'lander' | 'rover' | 'station' | 'base' | 'relay' | 'plane' |
//                                 'debris' | 'eva' | 'flag'   (vessel.role when set, otherwise inferred from its parts)
//   roleName(role)                display name
//   drawIcon(ctx, role, x, y, s, color, { badge, alpha, ring })   icon centred on (x, y); s = half-size in px
//   iconElement(role, color, px)  <canvas> with the icon, for DOM lists

const TAU = Math.PI * 2;
const INK = 'rgba(6,9,13,0.92)';

export const ROLES = [
  { id: 'ship', name: 'Ship' }, { id: 'probe', name: 'Probe' }, { id: 'lander', name: 'Lander' }, { id: 'rover', name: 'Rover' },
  { id: 'station', name: 'Station' }, { id: 'base', name: 'Base' }, { id: 'relay', name: 'Relay' }, { id: 'plane', name: 'Plane' },
];
const NAMES = { ship: 'Ship', probe: 'Probe', lander: 'Lander', rover: 'Rover', station: 'Station', base: 'Base', relay: 'Relay', plane: 'Plane', debris: 'Debris', eva: 'Pip on EVA', flag: 'Flag' };
export const ROLE_COLORS = {
  ship: '#8fd8ff', probe: '#b9c6d3', lander: '#c9f27a', rover: '#e6c88a', station: '#b79cff', base: '#ffb347', relay: '#7fe3d6', plane: '#9db8ff',
  debris: '#7d8996', eva: '#ff8a3d', flag: '#ffd166',
};
export function roleName(role) { return NAMES[role] || 'Vessel'; }

const inferred = new WeakMap();           // vessel → { n: part count, role }
export function roleOf(v) {
  if (!v) return 'ship';
  if (v.type === 'debris' || v.type === 'eva' || v.type === 'flag') return v.type;
  if (v.role && NAMES[v.role] && v.role !== 'debris' && v.role !== 'eva' && v.role !== 'flag') return v.role;
  const parts = v.parts instanceof Map ? v.parts : null;
  if (!parts) return 'ship';
  const c = inferred.get(v);
  if (c && c.n === parts.size) return c.role;
  let crewSeats = 0, wheels = 0, wings = 0, legs = 0, engines = 0, docks = 0, dish = 0;
  for (const p of parts.values()) {
    const d = p && p.def; if (!d) continue;
    if (d.command === 'crew') crewSeats += d.crew || 0;
    if (d.wheel && d.wheel.drive > 0) wheels++;
    if (d.wing && d.shape === 'wing') wings++;
    if (d.legs) legs++;
    if (d.engine) engines++;
    if (d.dock || d.shape === 'dock') docks++;
    if (d.antenna && d.antenna.range > 1e9) dish++;
  }
  let role = 'ship';
  if (wheels >= 2 && !wings) role = 'rover';
  else if (wings >= 2) role = 'plane';
  else if (!crewSeats && dish) role = 'relay';
  else if (!crewSeats) role = 'probe';
  else if (legs >= 3) role = 'lander';
  else if (docks >= 2 && !engines) role = 'station';
  inferred.set(v, { n: parts.size, role });
  return role;
}

// ---- icon paths: drawn in a unit box (−1..1), y down. Each returns nothing; uses the current path.
const PATHS = {
  ship(c) {                   // a stubby rocket
    c.moveTo(0, -1); c.bezierCurveTo(0.55, -0.55, 0.5, 0.1, 0.42, 0.5); c.lineTo(0.85, 0.95); c.lineTo(0.3, 0.8); c.lineTo(-0.3, 0.8); c.lineTo(-0.85, 0.95); c.lineTo(-0.42, 0.5);
    c.bezierCurveTo(-0.5, 0.1, -0.55, -0.55, 0, -1); c.closePath();
  },
  probe(c) {                  // core with two panels
    c.rect(-0.3, -0.42, 0.6, 0.84);
    c.rect(-1, -0.26, 0.55, 0.52); c.rect(0.45, -0.26, 0.55, 0.52);
    c.moveTo(0, -0.42); c.lineTo(0, -0.95);
  },
  lander(c) {                 // cabin on splayed legs
    c.moveTo(-0.42, -0.75); c.lineTo(0.42, -0.75); c.lineTo(0.62, 0.15); c.lineTo(-0.62, 0.15); c.closePath();
    c.moveTo(-0.5, 0.15); c.lineTo(-0.95, 0.9); c.moveTo(0.5, 0.15); c.lineTo(0.95, 0.9);
    c.moveTo(-1.05, 0.9); c.lineTo(-0.7, 0.9); c.moveTo(0.7, 0.9); c.lineTo(1.05, 0.9);
  },
  rover(c) {                  // chassis on wheels
    c.moveTo(-0.9, 0.2); c.lineTo(-0.7, -0.45); c.lineTo(0.45, -0.45); c.lineTo(0.9, 0.2); c.closePath();
    c.moveTo(-0.28, 0.62); c.arc(-0.58, 0.62, 0.3, 0, TAU); c.moveTo(0.88, 0.62); c.arc(0.58, 0.62, 0.3, 0, TAU);
  },
  station(c) {                // ring with a hub and spokes
    c.arc(0, 0, 0.9, 0, TAU); c.moveTo(0.3, 0); c.arc(0, 0, 0.3, 0, TAU);
    c.moveTo(0.3, 0); c.lineTo(0.9, 0); c.moveTo(-0.3, 0); c.lineTo(-0.9, 0); c.moveTo(0, 0.3); c.lineTo(0, 0.9); c.moveTo(0, -0.3); c.lineTo(0, -0.9);
  },
  base(c) {                   // dome on a pad
    c.moveTo(-0.8, 0.5); c.arc(0, 0.5, 0.8, Math.PI, 0); c.closePath();
    c.moveTo(-1, 0.85); c.lineTo(1, 0.85); c.moveTo(-0.25, 0.5); c.lineTo(-0.25, 0.05); c.lineTo(0.25, 0.05); c.lineTo(0.25, 0.5);
  },
  relay(c) {                  // dish on a mast with signal arcs
    c.moveTo(-0.75, -0.55); c.quadraticCurveTo(-0.1, 0.5, 0.75, 0.05); c.closePath();
    c.moveTo(-0.05, 0.02); c.lineTo(-0.35, 0.92); c.moveTo(-0.75, 0.92); c.lineTo(0.05, 0.92);
    c.moveTo(0.18, -0.38); c.lineTo(0.5, -0.86);
  },
  plane(c) {                  // delta-wing, nose up
    c.moveTo(0, -1); c.lineTo(0.22, -0.2); c.lineTo(1, 0.5); c.lineTo(0.25, 0.48); c.lineTo(0.42, 0.95); c.lineTo(-0.42, 0.95); c.lineTo(-0.25, 0.48); c.lineTo(-1, 0.5); c.lineTo(-0.22, -0.2); c.closePath();
  },
  debris(c) {                 // broken shard
    c.moveTo(-0.7, -0.5); c.lineTo(0.1, -0.8); c.lineTo(0.75, -0.1); c.lineTo(0.2, 0.2); c.lineTo(0.5, 0.8); c.lineTo(-0.5, 0.55); c.lineTo(-0.2, 0); c.closePath();
  },
  eva(c) {                    // round helmet with a visor and a bobble antenna
    c.arc(0, 0.12, 0.72, 0, TAU);
    c.moveTo(-0.42, 0.1); c.quadraticCurveTo(0, -0.28, 0.42, 0.1); c.quadraticCurveTo(0, 0.5, -0.42, 0.1);
    c.moveTo(0.3, -0.52); c.lineTo(0.55, -0.95);
  },
  flag(c) {
    c.moveTo(-0.5, 1); c.lineTo(-0.5, -1); c.lineTo(0.8, -0.6); c.lineTo(-0.5, -0.15);
  },
};
const FILLED = { ship: true, plane: true, debris: true, flag: true };

/**
 * Draw a role icon. opts.badge: draw a dark round backing disc (keeps icons readable over planets and lines);
 * opts.ring: colour of an outer ring (selection / highlight); opts.rot: rotation in radians (ship / plane only).
 */
export function drawIcon(ctx, role, x, y, s, color, opts = {}) {
  const path = PATHS[role] || PATHS.ship;
  const a = opts.alpha == null ? 1 : opts.alpha;
  ctx.save();
  ctx.globalAlpha = a;
  if (opts.badge) {
    ctx.beginPath(); ctx.arc(x, y, s * 1.55, 0, TAU);
    ctx.fillStyle = 'rgba(10,15,21,0.86)'; ctx.fill();
    ctx.lineWidth = 1.25; ctx.strokeStyle = opts.ring || 'rgba(160,178,196,0.38)'; ctx.stroke();
  }
  ctx.translate(x, y);
  if (opts.rot) ctx.rotate(opts.rot);
  const k = opts.badge ? s * 0.92 : s;
  ctx.scale(k, k);
  ctx.lineJoin = 'round'; ctx.lineCap = 'round';
  ctx.beginPath(); path(ctx);
  if (!opts.badge) { ctx.lineWidth = 4.2 / k; ctx.strokeStyle = INK; ctx.stroke(); }
  if (FILLED[role]) { ctx.fillStyle = color; ctx.fill(); ctx.lineWidth = 1 / k; ctx.strokeStyle = color; ctx.stroke(); }
  else {
    ctx.fillStyle = 'rgba(10,15,21,0.55)'; ctx.fill();
    ctx.lineWidth = 1.5 / k; ctx.strokeStyle = color; ctx.stroke();
  }
  if (role === 'eva' || role === 'probe' || role === 'relay') {      // antenna bobble
    const [bx, by] = role === 'eva' ? [0.58, -1] : role === 'probe' ? [0, -1] : [0.54, -0.92];
    ctx.beginPath(); ctx.arc(bx, by, 0.16, 0, TAU); ctx.fillStyle = color; ctx.fill();
  }
  ctx.restore();
}

export function iconElement(role, color, px = 18) {
  const c = document.createElement('canvas');
  const dpr = Math.min((typeof window !== 'undefined' && window.devicePixelRatio) || 1, 2);
  c.width = c.height = Math.round(px * dpr);
  c.style.width = c.style.height = px + 'px';
  c.className = 'map-ico';
  const g = c.getContext('2d');
  g.scale(dpr, dpr);
  drawIcon(g, role, px / 2, px / 2, px * 0.36, color || ROLE_COLORS[role] || '#b9c6d3', {});
  return c;
}
