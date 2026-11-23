// Starwright — the landing barge "Patient Tide": a flat steel deck anchored in the ocean east of the launch site,
// where a booster that cannot fly all the way back comes down (docs/BOOSTERS.md).
//
//   createBarge({ length, width, freeboard })  → THREE.Group, named 'barge'
//
// Local frame: +X along the deck's long side, +Y up, +Z to its right; the origin is the centre of the deck's top
// surface. The physics knows the deck as a level rectangle of exactly this length and width at this height
// (Body.deckAt, js/core/bodies.js: BARGE); everything drawn above the deck stands outside the marked landing circle,
// at the four corners, so that what is drawn and what is solid agree where a booster lands.
// Two meshes: the lit structure (vertex colours) and the lamps (unlit). No textures, about 1,500 triangles.
import * as THREE from '../lib/three.module.min.js';
import { mergeGeometries, PALETTE as P } from './partmesh.js';

const Mx = (x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0) => new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz)), new THREE.Vector3(1, 1, 1));

export function createBarge({ length = 80, width = 50, freeboard = 4 } = {}) {
  const lit = [], lamp = [];
  const add = (geo, color, m, list = lit) => list.push({ geo, color, m });
  const box = (w, h, d, color, x, y, z, list = lit) => add(new THREE.BoxGeometry(w, h, d), color, Mx(x, y, z), list);
  const flat = (w, d, color, x, z, y = 0.03) => add(new THREE.PlaneGeometry(w, d), color, Mx(x, y, z, -Math.PI / 2));
  const ring = (r0, r1, color, y = 0.04, seg = 64) => add(new THREE.RingGeometry(r0, r1, seg), color, Mx(0, y, 0, -Math.PI / 2));
  const hull = 0x2b3038, hullLow = 0x7a2f26, deck = 0x4a4f56, deckDark = 0x3b4046, line = 0xe9e6dc, steel = 0x8a929c;
  const hx = length / 2, hz = width / 2, draft = 3;

  // --- hull: a plain rectangular pontoon, dark above the water and red lead below it
  box(length, freeboard, width, hull, 0, -freeboard / 2 - 0.01, 0);
  box(length - 0.6, draft, width - 0.6, hullLow, 0, -freeboard - draft / 2, 0);
  box(length + 0.5, 0.5, width + 0.5, steel, 0, -0.9, 0);                               // rubbing strake
  // --- deck plating and its seams
  flat(length, width, deck, 0, 0, 0.005);
  for (let x = -hx + 8; x < hx; x += 8) flat(0.12, width, deckDark, x, 0, 0.012);
  for (let z = -hz + 5; z < hz; z += 5) flat(length, 0.12, deckDark, 0, z, 0.012);
  // --- the landing mark: two rings, an amber aim point, and four bars pointing in (the Return Pad's mark, smaller)
  const R = Math.min(hz, hx) - 3;
  ring(R - 1.2, R, line); ring(11, 12, P.teal); ring(2.6, 3.4, P.amber); add(new THREE.CircleGeometry(0.9, 16), 0x26282c, Mx(0, 0.045, 0, -Math.PI / 2));
  for (let i = 0; i < 4; i++) { const a = i * Math.PI / 2, c = Math.cos(a), s = Math.sin(a); flat(s ? 1.4 : 7, s ? 7 : 1.4, line, c * 16.5, s * 16.5, 0.04); }
  // --- amber and black edge to the deck
  for (const s of [-1, 1]) {
    for (let x = -hx + 2; x < hx; x += 4) flat(2, 0.8, ((x + hx) / 4 | 0) % 2 ? P.amber : 0x26282c, x, s * (hz - 0.4), 0.02);
    for (let z = -hz + 2; z < hz; z += 4) flat(0.8, 2, ((z + hz) / 4 | 0) % 2 ? P.amber : 0x26282c, s * (hx - 0.4), z, 0.02);
  }
  // --- the four corners: an equipment house, a light mast and a pair of bollards each, clear of the landing circle
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    const x = sx * (hx - 5), z = sz * (hz - 4.5);
    box(7, 2.8, 6, P.white, x, 1.4, z); box(7.2, 0.3, 6.2, P.teal, x, 2.95, z); box(0.1, 1.6, 2.2, 0x18303a, x - sx * 3.52, 1.3, z);
    const mx = sx * (hx - 10.5), mz = sz * (hz - 1.2);
    box(0.9, 0.3, 0.9, steel, mx, 0.15, mz); box(0.28, 13, 0.28, steel, mx, 6.5, mz); box(1.8, 0.9, 0.5, 0x2b3038, mx, 13.2, mz - sz * 0.2);
    for (const i of [-0.5, 0.5]) add(new THREE.CircleGeometry(0.3, 10), 0xfff3c4, Mx(mx + i, 13.2, mz - sz * 0.47, 0, sz > 0 ? Math.PI : 0), lamp);
    add(new THREE.SphereGeometry(0.22, 8, 6), sx > 0 ? 0x4dff7a : 0xff3524, Mx(mx, 13.9, mz), lamp);      // green to one end, red to the other
    for (const k of [0, 1]) add(new THREE.CylinderGeometry(0.28, 0.34, 0.9, 10), steel, Mx(sx * (hx - 16 - k * 1.6), 0.45, sz * (hz - 1.1)));
  }

  const g = new THREE.Group(); g.name = 'barge';
  const m1 = new THREE.Mesh(mergeGeometries(lit), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.8, metalness: 0.15, side: THREE.DoubleSide }));
  const m2 = new THREE.Mesh(mergeGeometries(lamp), new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide }));
  m1.name = 'bargeStructure'; m2.name = 'bargeLamps'; m1.castShadow = true; m1.receiveShadow = true;
  g.add(m1, m2);
  g.userData.dispose = () => { m1.geometry.dispose(); m1.material.dispose(); m2.geometry.dispose(); m2.material.dispose(); };
  return g;
}
