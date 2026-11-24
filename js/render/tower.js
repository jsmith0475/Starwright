// Starwright — the Catch Tower and its catch arms, "the Tongs" (docs/SHEARWATER.md), and the Tall Bay beside it.
// The physics has no arms (js/core/tower.js): it takes a stage by its two catch pins when the stage comes down
// slowly over the launch mount. This is the drawing of what does the taking.
//
//   createTower({ quality })  → THREE.Group, named 'tower'
//     .userData.setArms(k, height, dx, dz)   k: 0 open … 1 closed; height: the level the pins rest at, metres above
//                                            the ground (the top of the rails is one pin radius below it); dx, dz: how
//                                            far east and south of the mount's axis the arms close (a stage's own axis)
//     .userData.setService(k)                k: 0 the service arm's head drawn back … 1 resting on the hull of a
//                                            stack that stands on the mount (hull radius .userData.plan.service.r)
//     .userData.dispose()
//
// Local frame, the space centre's: +X east, +Y up, +Z south; the origin is the launch mount's axis at ground level.
// The numbers come from TOWER (js/core/bodies.js): the tower stands TOWER.offset west of the mount and is TOWER.height
// tall; the stack stands on the ground inside the mount's ring, so nothing is drawn within 3.3 m of the mount's axis.
// Each arm swings about its own hinge on the carriage: open, they stand 50° apart from the mount's line, 11 m clear of
// its axis on each side where they pass it; closed, the inner side of each passes 3.1 m north or south of the axis of
// the stage it holds, which is where the rail has to be for a pin that points north or south.
// Six meshes: structure (with the Tall Bay), lamps, carriage, the two arms and the service arm's head. No textures; 5,800 triangles (3,300 at
// low quality).
import * as THREE from '../lib/three.module.min.js';
import { mergeGeometries } from './partmesh.js';
import { TOWER } from '../core/bodies.js';

// the space centre's colours (js/render/basegfx.js)
const C = { white: 0xe4e7ea, shell: 0xcfd4d9, cream: 0xd6cfbd, slate: 0x39414c, dark: 0x171b20, teal: 0x1e9c90, tealDeep: 0x14695f,
  amber: 0xe59a2f, red: 0xc5382b, orange: 0xe2702a, steel: 0x8b949e, steelDark: 0x555d66, conc: 0xb9b5aa, concDark: 0x8c8981, core: 0x4a525c, deck: 0x6b727b };
const _Y = new THREE.Vector3(0, 1, 0);
const Mx = (x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0) => new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz)), new THREE.Vector3(1, 1, 1));

/** A list of pieces to merge into one mesh; `at` (a Matrix4) moves everything added through it. */
function kit(at = null) {
  const items = [];
  const add = (geo, color, m) => { items.push({ geo, color, m: at ? at.clone().multiply(m) : m }); };
  return {
    items, add,
    /** Box standing on y0, centred on x, z. */
    box(x, y0, z, w, h, d, color, ry = 0) { add(new THREE.BoxGeometry(w, h, d), color, Mx(x, y0 + h / 2, z, 0, ry)); },
    /** Square beam between two points. */
    beam(a, b, th, color) {
      const A = new THREE.Vector3(...a), d = new THREE.Vector3(...b).sub(A), len = d.length();
      add(new THREE.BoxGeometry(th, len, th), color, new THREE.Matrix4().compose(A.addScaledVector(d, 0.5), new THREE.Quaternion().setFromUnitVectors(_Y, d.normalize()), new THREE.Vector3(1, 1, 1)));
    },
    cyl(x, y0, z, r, h, color, seg = 12, r1 = r) { add(new THREE.CylinderGeometry(r1, r, h, seg), color, Mx(x, y0 + h / 2, z)); },
    /** A ring-shaped block: outer and inner walls and a flat top. */
    annulus(r0, r1, y0, y1, color, seg = 32) {
      add(new THREE.CylinderGeometry(r1, r1, y1 - y0, seg, 1, true), color, Mx(0, (y0 + y1) / 2, 0));
      add(new THREE.CylinderGeometry(r0, r0, y1 - y0, seg, 1, true), color, Mx(0, (y0 + y1) / 2, 0));
      add(new THREE.RingGeometry(r0, r1, seg), color, Mx(0, y1, 0, -Math.PI / 2));
    },
  };
}

// what the arms are: shared by the builder and by setArms
const ARM = { length: 22, half: 0.8, gap: 3.1, open: 50 * Math.PI / 180, park: 45, pin: 0.135 };
// the service arm: its level, where its fixed truss ends, the hull it reaches (the XXL stack's radius), how far off
// that hull its pads stand, and how far the head draws back
const SERVICE = { y: 55.5, x1: -4.6, hull: 2.8125, stand: 0.04, back: 1.0 };
/** Where things stand, for whoever places something beside the tower (metres east and south of the mount).
 *  `service`: the hull radius the service arm reaches and the levels its head covers. */
export const TOWER_PLAN = { bay: { x: -125, z: -80, w: 30, d: 40, h: 55 }, armGap: ARM.gap * 2, armPark: ARM.park,
  service: { r: SERVICE.hull, y0: SERVICE.y - 1.5, y1: SERVICE.y + 0.9 } };

export function createTower({ quality = 'high' } = {}) {
  const low = quality === 'low';
  const S = kit(), L = kit(), K = kit(), V = kit(), bay = [];
  const H = TOWER.height, tx = -TOWER.offset, W = 7.5, hw = W / 2, face = tx + hw;      // `face`: the tower's east face
  const top = H - 5;                                                                      // the lattice ends here; the winch house stands on it

  // ---- the tower: a square lattice round a closed core (the core is what shows from far away)
  S.box(tx, -0.4, 0, W + 4.5, 1.6, W + 4.5, C.concDark);                                  // (feet a little into the ground: the ground curves away, this does not)
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) S.beam([tx + sx * hw, 1.2, sz * hw], [tx + sx * hw, top, sz * hw], 0.85, C.white);
  const bays = low ? 8 : 13;
  for (let i = 0; i <= bays; i++) {
    const y = 1.2 + (top - 1.2) * i / bays, y2 = 1.2 + (top - 1.2) * (i + 1) / bays, col = i % 4 === 0 ? C.teal : C.shell;
    for (const s of [-1, 1]) { S.beam([tx - hw, y, s * hw], [tx + hw, y, s * hw], 0.5, col); S.beam([tx + s * hw, y, -hw], [tx + s * hw, y, hw], 0.5, col); }
    if (i === bays) break;
    const f = i % 2 ? 1 : -1;
    for (const s of [-1, 1]) {
      S.beam([tx - f * hw, y, s * hw], [tx + f * hw, y2, s * hw], 0.36, C.white); S.beam([tx + s * hw, y, -f * hw], [tx + s * hw, y2, f * hw], 0.36, C.white);
      if (!low) { S.beam([tx + f * hw, y, s * hw], [tx - f * hw, y2, s * hw], 0.3, C.white); S.beam([tx + s * hw, y, f * hw], [tx + s * hw, y2, -f * hw], 0.3, C.white); }
    }
  }
  S.box(tx - 0.4, 1.2, 0, 4.8, top - 1.2, 5.2, C.core);
  // the carriage's two tracks up the east face, and the propellant lines up the north face
  for (const s of [-1, 1]) S.box(face + 0.22, 6, s * 2.3, 0.44, top - 8, 0.6, C.steelDark);
  if (!low) for (const [z, col] of [[-1.6, C.shell], [0, C.teal], [1.6, C.orange]]) S.cyl(tx + z, 1.2, -hw - 0.45, 0.32, top - 14, col, 8);
  // top: a deck, the winch house that hauls the carriage, the lightning rod
  S.box(tx, top, 0, W + 2.6, 0.45, W + 2.6, C.deck);
  S.box(tx, top + 0.45, 0, 5.6, 3.6, 5.6, C.tealDeep); S.box(tx, top + 4.05, 0, 6.2, 0.5, 6.2, C.white);
  if (!low) for (const s of [-1, 1]) { S.beam([tx - hw - 1.3, top + 1.5, s * (hw + 1.3)], [tx + hw + 1.3, top + 1.5, s * (hw + 1.3)], 0.12, C.amber); S.beam([tx + s * (hw + 1.3), top + 1.5, -hw - 1.3], [tx + s * (hw + 1.3), top + 1.5, hw + 1.3], 0.12, C.amber); }
  S.box(face + 0.6, top + 0.45, 0, 2.2, 1.6, 3.4, C.steelDark);                          // sheaves over the carriage's tracks
  S.beam([tx, top + 4.5, 0], [tx, H + 16, 0], 0.3, C.shell);
  L.add(new THREE.SphereGeometry(0.45, 8, 6), 0xff3524, Mx(tx, H + 16.3, 0));
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) L.add(new THREE.SphereGeometry(0.3, 6, 4), 0xff3524, Mx(tx + sx * (hw + 1.1), top + 0.9, sz * (hw + 1.1)));
  L.add(new THREE.SphereGeometry(0.22, 6, 4), 0xff3524, Mx(tx - hw - 0.5, H * 0.5, 0));

  // ---- the service arm (the quick-disconnect arm), at the ship's lower tank: a fixed truss and, sliding in it, a
  //      head whose two padded cheeks rest on the hull of a stack standing on the mount (setService). East of
  //      x = −5.9 nothing of the arm or its head comes within 0.27 m of the plane z = 0: the ship's aft flap and the
  //      booster's grid fin on the tower's side go up through that gap, so the arm is never in their way.
  { const y = SERVICE.y, x1 = SERVICE.x1, len = x1 - face;
    for (const s of [-1, 1]) { S.beam([face, y, s * 0.9], [x1, y, s * 0.9], 0.3, C.white); S.beam([face, y - 1.5, s * 0.9], [x1, y - 1.0, s * 0.9], 0.26, C.white); S.beam([face + len * 0.5, y, s * 0.9], [face + len * 0.5, y - 1.25, s * 0.9], 0.2, C.white); S.beam([face, y - 1.5, s * 0.9], [face + len * 0.5, y, s * 0.9], 0.18, C.shell); }
    S.box((face - 6) / 2, y + 0.1, 0, -6 - face, 0.14, 1.9, C.deck);
    for (const s of [-1, 1]) S.box((x1 - 6) / 2, y + 0.1, s * 0.65, x1 + 6, 0.14, 0.6, C.deck);                       // the deck, split where the flap passes
    for (const s of [-1, 1]) S.beam([face, y - 5.5, s * 0.9], [x1 - 0.8, y - 1.3, s * 0.9], 0.26, C.white);          // (the ship's aft flap passes between these two)
    if (!low) for (const [z, col] of [[-0.45, C.teal], [0.45, C.orange]]) S.beam([face, y - 0.5, z], [x1 - 0.5, y - 0.5, z], 0.22, col);
    // the head, drawn where it stands when it rests on the hull: for each side of the gap a prong that slides in
    // the truss, a cheek, and two pads set round the hull and standing SERVICE.stand off it
    const R = SERVICE.hull, rp = R + SERVICE.stand, xc = -R - 0.2, xr = xc - 0.55;
    for (const s of [-1, 1]) {
      V.add(new THREE.BoxGeometry(xr + 6.1, 0.55, 0.42), C.steelDark, Mx((xr - 6.1) / 2, y - 0.975, s * 0.51));
      V.add(new THREE.BoxGeometry(0.55, 2.2, 0.87), C.tealDeep, Mx((xc + xr) / 2, y - 0.4, s * 0.715));
      V.add(new THREE.BoxGeometry(0.61, 0.12, 0.93), C.white, Mx((xc + xr) / 2, y + 0.76, s * 0.715));
      for (const [a, th] of [[10, 0.2], [19, 0.37]]) {
        const an = a * Math.PI / 180, c = rp + th / 2;
        V.add(new THREE.BoxGeometry(th, 1.7, 2 * rp * Math.tan(4.5 * Math.PI / 180)), C.dark, Mx(-c * Math.cos(an), y - 0.4, s * c * Math.sin(an), 0, Math.PI + s * an));
        if (!low) for (const dy of [-0.95, 0.55]) V.add(new THREE.BoxGeometry(th + 0.04, 0.1, 2 * rp * Math.tan(4.5 * Math.PI / 180) + 0.04), C.amber, Mx(-(c + 0.03) * Math.cos(an), y - 0.4 + dy, s * (c + 0.03) * Math.sin(an), 0, Math.PI + s * an));
      }
    }
    V.add(new THREE.BoxGeometry(0.2, 0.55, 1.44), C.steelDark, Mx(-6, y - 0.975, 0));                                  // the prongs' cross-piece, behind where the flap reaches
  }

  // ---- the launch mount: a ring table round the flame hole. The stack stands on the ground inside it.
  { const seg = low ? 20 : 36;
    S.annulus(4.3, 7.2, -0.4, 0.9, C.concDark, seg); S.annulus(3.8, 6.4, 0.9, 1.7, C.steelDark, seg); S.annulus(3.6, 4.4, 1.7, 1.9, C.amber, seg);
    const n = low ? 10 : 20;
    for (let i = 0; i < n; i++) { const a = (i + 0.5) * Math.PI * 2 / n, c = Math.cos(a), s = Math.sin(a); S.box(c * 3.85, 1.2, s * 3.85, 0.7, 0.9, 0.5, i % 2 ? C.shell : C.steel, -a); }   // hold-down clamps, 3.5 m out
    for (let i = 0; i < 6; i++) { const a = i * Math.PI / 3 + Math.PI / 6; S.box(Math.cos(a) * 6.9, 0, Math.sin(a) * 6.9, 1.5, 1.3, 1.5, C.conc, -a); }
    // propellant and water lines from the tower's foot to the table
    for (const [z, col] of [[-1.4, C.shell], [1.4, C.orange]]) { S.beam([face + 0.5, 0.6, z], [-6.3, 0.6, z], 0.45, col); S.box(-7.1, 0, z, 0.4, 0.5, 1.1, C.steelDark); }
  }

  // ---- the carriage: rides the tower's east face and carries the two hinges. Its own origin: the tower's east face
  //      at the level the pins rest at.
  const xh = face + 0.95, zh = ARM.gap + ARM.half;                                       // the hinges
  K.box(0.28, -3.7, 0, 0.56, 5.0, 10.6, C.tealDeep);
  K.box(0.3, -3.9, 0, 0.62, 0.5, 10.9, C.white); K.box(0.3, 1.0, 0, 0.62, 0.4, 10.9, C.white);
  for (const s of [-1, 1]) {
    K.box(-1.5, -3.7, s * (hw + 0.5), 3.6, 5.0, 0.5, C.tealDeep); K.box(-1.5, -3.9, s * (hw + 0.5), 3.7, 0.5, 0.62, C.white);   // cheeks round the tower's sides
    K.box(0.2, -3.2, s * 2.3, 0.9, 4.0, 1.0, C.dark);                                                                 // shoes on the tracks
    K.box(xh - face - 0.15, -3.6, s * zh, 1.5, 3.8, 1.9, C.steelDark); K.cyl(xh - face, -3.8, s * zh, 0.42, 4.15, C.amber, 10);  // hinge block and its pin
    if (!low) K.beam([0.5, -3.4, s * 5.1], [xh - face, -1.6, s * zh], 0.3, C.white);
  }

  // ---- the two arms. An arm's own frame: the hinge at the origin, +X along the arm, y = 0 where the pins rest.
  //      The side facing the other arm is at z = −s · ARM.half, and the rail runs along the top of that side.
  const armGeo = s => {
    const A = kit(), Ln = ARM.length, hf = ARM.half, top0 = -ARM.pin - 0.14, d0 = 3.3, d1 = 1.4, n = low ? 4 : 7;
    A.box(Ln / 2, top0 - 0.5, 0, Ln, 0.5, hf * 2, C.white);                              // top chord: a closed box, the deck of the arm
    A.box(Ln / 2 + 0.6, top0, -s * (hf - 0.28), Ln - 2.4, 0.14, 0.56, C.amber);          // the rail the pins come down on
    const yb = x => top0 - d0 - (d1 - d0) * (x / Ln);
    for (const z of [-hf + 0.2, hf - 0.2]) {
      A.beam([0, yb(0), z], [Ln, yb(Ln), z], 0.4, C.white);
      for (let i = 0; i <= n; i++) {
        const x = Ln * i / n, x2 = Ln * (i + 1) / n;
        A.beam([x, top0 - 0.4, z], [x, yb(x), z], 0.26, C.white);
        if (i < n) A.beam(i % 2 ? [x, top0 - 0.4, z] : [x, yb(x), z], i % 2 ? [x2, yb(x2), z] : [x2, top0 - 0.4, z], 0.22, C.shell);
      }
    }
    for (let i = 0; i <= n; i++) { const x = Ln * i / n; A.beam([x, yb(x), -hf + 0.2], [x, yb(x), hf - 0.2], 0.22, C.white); }
    A.box(0.1, top0 - d0 - 0.2, 0, 1.3, d0 + 0.2, hf * 2 + 0.1, C.steelDark);            // the root, round the hinge pin
    A.box(Ln - 0.1, top0 - d1 - 0.1, 0, 0.6, d1 + 0.1, hf * 2 + 0.06, C.teal);           // the tip
    if (!low) for (let i = 0; i < 6; i++) A.box(Ln - 1 - i * 0.8, top0 - 0.52, s * (hf + 0.02), 0.4, 0.5, 0.06, i % 2 ? C.amber : C.dark);
    return mergeGeometries(A.items);
  };

  // ---- the Tall Bay: where the stack is put together. Its door faces the mount.
  { const b = TOWER_PLAN.bay, yaw = Math.atan2(b.z, -b.x), B = kit(Mx(b.x, 0, b.z, 0, yaw)), w = b.w, d = b.d, h = b.h, e = w / 2;   // B's +X: toward the mount
    B.box(0, -0.6, 0, w + 1, 3.6, d + 1, C.concDark);
    B.box(0, 3, 0, w, h - 15, d, C.white); B.box(0, h - 12, 0, w + 0.4, 3, d + 0.4, C.tealDeep); B.box(0, h - 9, 0, w, 7, d, C.slate); B.box(0, h - 2, 0, w + 1.4, 2, d + 1.4, C.shell);
    if (!low) {
      for (let i = -2; i <= 2; i++) for (const s of [-1, 1]) B.box(i * 6, 3, s * (d / 2 + 0.5), 1.4, h - 15, 1, C.shell);
      for (const z of [-15, -9.5, 9.5, 15]) { B.box(e + 0.5, 3, z, 1, h - 15, 1.4, C.shell); B.box(-e - 0.5, 3, z, 1, h - 15, 1.4, C.shell); }
    }
    // the door: a slate frame, six lifting leaves, the lowest raised over a dark opening with a strip of work light
    B.box(e + 1.2, 0, -8.6, 2.4, h - 6, 3.2, C.slate); B.box(e + 1.2, 0, 8.6, 2.4, h - 6, 3.2, C.slate); B.box(e + 1.2, h - 10, 0, 2.4, 4, 20.4, C.slate);
    B.box(e + 0.4, 0.1, 0, 0.8, 13, 14, 0x0b0d10);
    for (let i = 0; i < 6; i++) B.box(e + 0.7 + (i % 2) * 0.3, 13 + i * 5.4, 0, 0.8, 5.2, 14, i % 2 ? 0xc3c9cf : 0xd3d8dd);
    for (const s of [-1, 1]) for (let i = 0; i < (low ? 0 : 5); i++) B.box(e + 2.45, 2 + i * 9, s * 7.4, 0.12, 4.5, 1, i % 2 ? C.amber : C.dark);
    // a low wing on the far side, plant on the roof
    B.box(-e - 6, -0.6, 4, 12, 9.6, 24, C.cream); B.box(-e - 6, 9, 4, 12.6, 0.8, 24.6, C.slate);
    B.box(4, h, -8, 7, 2.6, 6, 0x9aa2ab); B.box(-6, h, 9, 5, 2, 8, 0x7c858f);
    const P = (x, y, z) => new THREE.Vector3(x, y, z).applyMatrix4(Mx(b.x, 0, b.z, 0, yaw));
    L.add(new THREE.BoxGeometry(0.2, 0.9, 12.5), 0xffc98a, Mx(b.x, 0, b.z, 0, yaw).multiply(Mx(e + 0.85, 11.6, 0)));
    bay.push(...B.items);
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) { const p = P(sx * e, h + 0.8, sz * d / 2); L.add(new THREE.SphereGeometry(0.4, 6, 4), 0xff3524, Mx(p.x, p.y, p.z)); }
  }

  const g = new THREE.Group(); g.name = 'tower';
  const lit = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.62, metalness: 0.22, side: THREE.DoubleSide });
  const glow = new THREE.MeshBasicMaterial({ vertexColors: true });
  const mesh = (name, geo, mat = lit) => { const m = new THREE.Mesh(geo, mat); m.name = name; m.castShadow = mat === lit; m.receiveShadow = mat === lit; return m; };
  const structure = mesh('towerStructure', mergeGeometries(S.items.concat(bay))), lamps = mesh('towerLamps', mergeGeometries(L.items), glow);
  const carriage = new THREE.Group(); carriage.name = 'towerCarriage'; carriage.position.set(face, ARM.park, 0);
  carriage.add(mesh('towerCarriageFrame', mergeGeometries(K.items)));
  const arms = [1, -1].map(s => { const a = mesh(s > 0 ? 'towerArmSouth' : 'towerArmNorth', armGeo(s)); a.position.set(xh - face, 0, s * zh); a.userData.side = s; carriage.add(a); return a; });
  const service = mesh('towerService', mergeGeometries(V.items));
  g.add(structure, lamps, carriage, service);

  /** Pose the arms: see the head of this file. Nothing is smoothed here: the caller glides the numbers. */
  function setArms(k = 0, height = ARM.park, dx = 0, dz = 0) {
    k = Math.min(1, Math.max(0, +k || 0)); const e = k * k * (3 - 2 * k);
    carriage.position.y = Math.min(top - 3, Math.max(9, Number.isFinite(height) ? height : ARM.park));
    dx = +dx || 0; dz = +dz || 0;
    const off = Math.hypot(dx, dz); if (off > TOWER.reach) { dx *= TOWER.reach / off; dz *= TOWER.reach / off; }
    for (const a of arms) {
      // closed: the arm's inner side passes ARM.gap north or south of the stage's axis, so its rail is under a pin
      // that points that way; and it never turns so far that the inner side comes within 2.9 m of the axis
      const s = a.userData.side, run = dx - xh;
      let t = dz / run; for (let i = 0; i < 2; i++) t = (dz + s * ARM.half * (Math.sqrt(1 + t * t) - 1)) / run;
      const closed = s * Math.min(0.36, Math.max(-0.36, Math.atan(t)));
      a.rotation.y = -s * (ARM.open + (closed - ARM.open) * e);
    }
  }
  /** Pose the service arm's head: k = 1 resting on the hull, 0 drawn back SERVICE.back clear of it. */
  function setService(k = 0) {
    k = Math.min(1, Math.max(0, +k || 0));
    service.position.x = -SERVICE.back * (1 - k * k * (3 - 2 * k));
  }
  setArms(0, ARM.park, 0, 0); setService(0);
  g.userData.setArms = setArms;
  g.userData.setService = setService;
  g.userData.plan = TOWER_PLAN;
  g.userData.dispose = () => { g.traverse(o => { if (o.isMesh) o.geometry.dispose(); }); lit.dispose(); glow.dispose(); };
  return g;
}
