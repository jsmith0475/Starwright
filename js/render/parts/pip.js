// Starwright part models: the Pips (crew). Carried over from the first pass; materials come from the shared kit.
import * as THREE from '../../lib/three.module.min.js';
import { PB, P, M } from './geo.js';

// --- Pip ------------------------------------------------------------------------------------
export function buildPipInto(g) {
  const parts = {};
  const sub = (name, x, y, z, parent = g) => { const o = new THREE.Group(); o.name = 'pip_' + name; o.position.set(x, y, z); parent.add(o); parts[name] = o; return o; };
  // torso (orange jumpsuit) — origin of the figure is its centre, feet at y = -0.45
  const torso = sub('torso', 0, -0.1, 0);
  let pb = new PB();
  pb.sphere(0.155, P.orange, M(0, 0, 0, 0, 0, 0, 1, 1.12, 0.9), 'paint', 16, 12);
  pb.add(new THREE.CylinderGeometry(0.1, 0.1, 0.04, 14), P.white, M(0, 0.15, 0)); // collar
  pb.box(0.1, 0.07, 0.02, P.teal, M(0, 0.03, 0.135)); // chest panel
  pb.sphere(0.014, P.amber, M(-0.025, 0.03, 0.148), 'lamp', 6, 4); pb.sphere(0.014, P.white, M(0.025, 0.03, 0.148), 'lamp', 6, 4);
  pb.add(new THREE.TorusGeometry(0.142, 0.018, 6, 18), P.white, M(0, -0.09, 0, Math.PI / 2, 0, 0, 1, 0.9, 1)); // belt
  pb.build(torso);
  // backpack
  const pack = sub('pack', 0, 0.0, -0.15, torso);
  pb = new PB();
  pb.box(0.2, 0.24, 0.1, P.white, M(0, 0, 0)); pb.box(0.21, 0.04, 0.105, P.teal, M(0, 0.07, 0));
  pb.add(new THREE.CylinderGeometry(0.025, 0.025, 0.08, 8), P.gun, M(-0.06, -0.14, 0), 'metal'); pb.add(new THREE.CylinderGeometry(0.025, 0.025, 0.08, 8), P.gun, M(0.06, -0.14, 0), 'metal');
  pb.build(pack);
  // head: round white helmet, big dark visor with highlight
  const head = sub('head', 0, 0.22, 0);
  pb = new PB();
  pb.sphere(0.2, P.white, M(0, 0, 0), 'paint', 22, 16);
  pb.add(new THREE.SphereGeometry(0.19, 20, 12, 0, Math.PI * 2, 0, 0.92), 0x10242c, M(0, 0.005, 0.022, Math.PI / 2 - 0.12, 0, 0, 1.0, 1, 0.82), 'glass');
  pb.add(new THREE.TorusGeometry(0.15, 0.016, 6, 24), P.teal, M(0, 0.024, 0.138, -0.12, 0, 0, 1, 0.84, 1));
  pb.sphere(0.035, 0xffffff, M(-0.055, 0.075, 0.185, -0.3, -0.3, 0, 1.2, 0.7, 0.25), 'lamp', 8, 6);
  pb.sphere(0.014, 0xffffff, M(-0.085, 0.03, 0.18, 0, 0, 0, 1, 1, 0.3), 'lamp', 6, 4);
  pb.add(new THREE.CylinderGeometry(0.03, 0.03, 0.03, 10), P.grey, M(0.2, 0, 0, 0, 0, Math.PI / 2)); pb.add(new THREE.CylinderGeometry(0.03, 0.03, 0.03, 10), P.grey, M(-0.2, 0, 0, 0, 0, Math.PI / 2));
  pb.build(head);
  const ant = sub('antenna', 0.09, 0.17, -0.03, head);
  pb = new PB();
  pb.add(new THREE.CylinderGeometry(0.006, 0.008, 0.13, 6), P.steel, M(0, 0.065, 0), 'metal');
  pb.sphere(0.028, P.teal, M(0, 0.14, 0), 'paint', 10, 8);
  pb.build(ant); ant.rotation.z = -0.25;
  // stubby limbs (pivot at shoulder / hip)
  for (const [name, sx] of [['armL', 1], ['armR', -1]]) {
    const a = sub(name, sx * 0.16, -0.03, 0);
    pb = new PB();
    pb.add(new THREE.CapsuleGeometry(0.048, 0.1, 4, 10), P.orange, M(0, -0.085, 0));
    pb.add(new THREE.CylinderGeometry(0.052, 0.052, 0.025, 10), P.teal, M(0, -0.135, 0));
    pb.sphere(0.052, P.white, M(0, -0.18, 0), 'paint', 10, 8);
    pb.build(a); a.rotation.z = sx * 0.35;
  }
  for (const [name, sx] of [['legL', 1], ['legR', -1]]) {
    const l = sub(name, sx * 0.075, -0.24, 0);
    pb = new PB();
    pb.add(new THREE.CapsuleGeometry(0.058, 0.07, 4, 10), P.orange, M(0, -0.07, 0));
    pb.add(new THREE.SphereGeometry(0.068, 12, 8), P.gun, M(0, -0.165, 0.022, 0, 0, 0, 1, 0.66, 1.35));
    pb.build(l);
  }
  g.userData.pipRefs = true;
  return parts;
}

/** A Pip: ~0.9 m tall, origin at the centre (feet at y ≈ −0.45), visor facing +Z.
 *  userData.parts = { torso, pack, head, antenna, armL, armR, legL, legR } (pivot groups). */
export function buildPipMesh() {
  const g = new THREE.Group(); g.name = 'pip';
  g.userData.parts = buildPipInto(g);
  return g;
}
/** Simple limb animation. walk in 0..1 blends the walk cycle; t is time in seconds. */
export function animatePip(group, { walk = 0, t = 0 } = {}) {
  const p = group.userData.parts; if (!p) return;
  const sw = Math.sin(t * 9) * 0.75 * walk;
  p.legL.rotation.x = sw; p.legR.rotation.x = -sw;
  p.armL.rotation.x = -sw * 0.8; p.armR.rotation.x = sw * 0.8;
  p.armL.rotation.z = 0.35 + Math.sin(t * 1.7) * 0.05 * (1 - walk); p.armR.rotation.z = -0.35 - Math.sin(t * 1.7 + 1) * 0.05 * (1 - walk);
  p.torso.position.y = -0.1 + Math.abs(Math.sin(t * 9)) * 0.015 * walk;
  p.head.position.y = 0.22 + Math.abs(Math.sin(t * 9)) * 0.02 * walk + Math.sin(t * 1.3) * 0.004;
  p.head.rotation.y = Math.sin(t * 0.7) * 0.18 * (1 - walk);
  p.head.rotation.z = Math.sin(t * 9) * 0.04 * walk;
  p.antenna.rotation.z = -0.25 + Math.sin(t * 6.3) * (0.07 + 0.3 * walk);
  p.antenna.rotation.x = Math.cos(t * 5.1) * (0.05 + 0.2 * walk);
}

