// Starwright assembly building — the load overlay: one band around every joint of the craft, coloured by how much
// of its strength the joint uses (the scale of builder/loads.js), and the rings that point out the joint a row of
// the Structure list is about. Lives in craft space (a child of the craft group).
//
// Two instanced meshes for the whole craft (bands, and the pulse of joints that will break), one more for the
// pointer rings. Nothing is allocated per frame: update() rewrites the instance matrices of the overloaded joints only.
import * as THREE from '../../lib/three.module.min.js';
import { loadColor, LOAD } from './loads.js';

const Y = new THREE.Vector3(0, 1, 0);

export function createLoadOverlay(parent) {
  const group = new THREE.Group(); group.name = 'load_overlay'; group.visible = false; group.renderOrder = 890; parent.add(group);
  const focusGroup = new THREE.Group(); focusGroup.name = 'load_focus'; focusGroup.visible = false; parent.add(focusGroup);
  const mat = (opacity, color = 0xffffff) => new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthTest: false, depthWrite: false, side: THREE.DoubleSide, fog: false, toneMapped: false });
  const bandGeo = new THREE.CylinderGeometry(1, 1, 1, 48, 1, true);                 // unit band about +Y
  const ringGeo = new THREE.TorusGeometry(1, 0.035, 8, 56).rotateX(Math.PI / 2);     // unit ring about +Y
  const bandMat = mat(0.82), haloMat = mat(0.6, LOAD.COLORS.bad), focusMat = mat(0.95, 0xf2f6f9);
  let bands = null, halos = null, cap = 0;
  const focus = new THREE.InstancedMesh(ringGeo, focusMat, 16); focus.count = 0; focus.frustumCulled = false; focus.renderOrder = 892; focusGroup.add(focus);

  // per joint: position (3), normal quaternion (4), radius, band height; and the indices of the overloaded ones
  let data = new Float32Array(0), hot = new Uint16Array(0), count = 0, hotCount = 0, focusCount = 0;
  const m4 = new THREE.Matrix4(), p = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3(), nrm = new THREE.Vector3(), col = new THREE.Color();
  const focusIdx = new Uint16Array(16);

  function ensure(n) {
    if (n <= cap) return;
    cap = Math.max(32, 2 ** Math.ceil(Math.log2(n)));
    for (const m of [bands, halos]) if (m) { group.remove(m); m.dispose(); }
    bands = new THREE.InstancedMesh(bandGeo, bandMat, cap); bands.frustumCulled = false; bands.renderOrder = 890;
    halos = new THREE.InstancedMesh(ringGeo, haloMat, cap); halos.frustumCulled = false; halos.renderOrder = 891;
    bands.count = 0; halos.count = 0;
    group.add(bands, halos);
    data = new Float32Array(cap * 9); hot = new Uint16Array(cap);
  }
  /** The matrix of joint i: a band of radius `rad` and height `h` in the joint plane. */
  function place(mesh, slot, i, rad, h) {
    const o = i * 9;
    p.set(data[o], data[o + 1], data[o + 2]); q.set(data[o + 3], data[o + 4], data[o + 5], data[o + 6]); s.set(rad, h, rad);
    m4.compose(p, q, s); mesh.setMatrixAt(slot, m4);
  }
  const bandR = r => r * 1.03 + 0.012, bandH = r => Math.min(0.2, Math.max(0.05, r * 0.16));

  return {
    group, focusGroup,
    get count() { return count; }, get hot() { return hotCount; }, get focused() { return focusCount; },
    get visible() { return group.visible; },
    setVisible(on) { group.visible = !!on && count > 0; },
    /** marks: [{ x, y, z, nx, ny, nz, r, util }] (loadReport().marks). */
    set(marks) {
      const n = marks ? Math.min(marks.length, 65535) : 0;
      ensure(n);
      count = n; hotCount = 0; focusCount = 0; focus.count = 0; focusGroup.visible = false;
      if (!bands) return;
      for (let i = 0; i < n; i++) {
        const k = marks[i], o = i * 9;
        nrm.set(k.nx, k.ny, k.nz); if (nrm.lengthSq() < 1e-8) nrm.set(0, 1, 0); nrm.normalize();
        q.setFromUnitVectors(Y, nrm);
        data[o] = k.x; data[o + 1] = k.y; data[o + 2] = k.z; data[o + 3] = q.x; data[o + 4] = q.y; data[o + 5] = q.z; data[o + 6] = q.w;
        data[o + 7] = k.r; data[o + 8] = bandH(k.r);
        place(bands, i, i, bandR(k.r), data[o + 8]);
        bands.setColorAt(i, col.setHex(loadColor(k.util)));
        if (k.util >= LOAD.BREAK) hot[hotCount++] = i;
      }
      bands.count = n; halos.count = hotCount;
      for (let h = 0; h < hotCount; h++) place(halos, h, hot[h], bandR(data[hot[h] * 9 + 7]), 1);
      bands.instanceMatrix.needsUpdate = true; halos.instanceMatrix.needsUpdate = true;
      if (bands.instanceColor) bands.instanceColor.needsUpdate = true;
      if (!n) group.visible = false;
    },
    /** Point out some joints (indices into the marks given to set()), or none. Shown whether the overlay is on or not. */
    focus(indices) {
      focusCount = 0;
      if (indices) for (let i = 0; i < indices.length && focusCount < focusIdx.length; i++) if (indices[i] < count) focusIdx[focusCount++] = indices[i];
      focus.count = focusCount; focusGroup.visible = focusCount > 0;
    },
    /** t: seconds. Joints that will break throb, and a red ring runs outward from each of them. */
    update(t) {
      if (group.visible && hotCount) {
        const beat = 1 + 0.07 * Math.sin(t * 8), k = (t * 1.3) % 1;
        for (let h = 0; h < hotCount; h++) {
          const i = hot[h], r = bandR(data[i * 9 + 7]);
          place(bands, i, i, r * beat, data[i * 9 + 8] * (1 + 3 * (beat - 1)));
          place(halos, h, i, r * (1.05 + 0.85 * k), 1);
        }
        haloMat.opacity = 0.75 * (1 - k);
        bands.instanceMatrix.needsUpdate = true; halos.instanceMatrix.needsUpdate = true;
      }
      if (focusCount) {
        const beat = 1.12 + 0.05 * Math.sin(t * 6);
        for (let f = 0; f < focusCount; f++) { const i = focusIdx[f]; place(focus, f, i, bandR(data[i * 9 + 7]) * beat + 0.03, 1); }
        focus.instanceMatrix.needsUpdate = true;
      }
    },
    dispose() {
      for (const m of [bands, halos, focus]) if (m) m.dispose();
      bandGeo.dispose(); ringGeo.dispose(); bandMat.dispose(); haloMat.dispose(); focusMat.dispose();
      group.removeFromParent(); focusGroup.removeFromParent();
    },
  };
}
