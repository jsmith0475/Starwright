// The vegetation generators (js/render/treegen.js) and the detail-level rules (js/render/flora.js): pure logic.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ATLAS, cellUV, SPECIES, SPECIES_IDS, growSkeleton, buildTree, hash01, lodBlend, lodDistances } from '../../js/render/treegen.js';
import { VEG_LEVELS, vegLevel } from '../../js/render/flora.js';
import { LEVELS } from '../../js/ui/governor.js';

const finite = (arr, what) => { for (let i = 0; i < arr.length; i++) if (!Number.isFinite(arr[i])) assert.fail(`${what}[${i}] is ${arr[i]}`); };

test('flora: the species the brief asks for exist (three broadleaves, two conifers, a palm)', () => {
  for (const id of ['oak', 'maple', 'birch', 'spruce', 'pine', 'palm']) assert.ok(SPECIES[id], id);
  assert.deepEqual([...SPECIES_IDS].sort(), Object.keys(SPECIES).sort());
});

test('flora: every tree is valid geometry, the same for the same seed, within its triangle budget', () => {
  const BUDGET = { 0: 2000, 1: 400 };
  for (const id of SPECIES_IDS) {
    for (const lod of [0, 1]) {
      const t = buildTree(id, { lod, seed: 7 }), again = buildTree(id, { lod, seed: 7 });
      finite(t.position, id + ' position'); finite(t.normal, id + ' normal'); finite(t.uv, id + ' uv'); finite(t.bark, id + ' bark'); finite(t.leaf, id + ' leaf');
      const verts = t.position.length / 3;
      assert.equal(t.normal.length, verts * 3); assert.equal(t.uv.length, verts * 2); assert.equal(t.bark.length, verts * 3); assert.equal(t.leaf.length, verts * 3);
      assert.equal(t.index.length % 3, 0); assert.equal(t.tris, t.index.length / 3);
      for (let i = 0; i < t.index.length; i++) assert.ok(t.index[i] < verts, id + ' index in range');
      assert.ok(t.tris >= 10 && t.tris <= BUDGET[lod], `${id} lod ${lod}: ${t.tris} triangles (budget ${BUDGET[lod]})`);
      assert.deepEqual(Array.from(t.position), Array.from(again.position), id + ' is deterministic');
      for (let i = 0; i < verts; i++) { const n = Math.hypot(t.normal[i * 3], t.normal[i * 3 + 1], t.normal[i * 3 + 2]); assert.ok(Math.abs(n - 1) < 0.02, `${id} normal ${i} has length ${n}`); }
      for (let i = 0; i < verts; i++) { const ao = t.leaf[i * 3]; assert.ok(ao >= 0 && ao <= 1.0001, `${id} occlusion ${ao}`); }
      assert.ok(t.height > 1.5 && t.height < 40, `${id} is ${t.height} m tall`);
      assert.ok(t.radius > 0.5 && t.radius < 16, `${id} is ${t.radius} m wide`);
      let minY = Infinity; for (let i = 1; i < t.position.length; i += 3) minY = Math.min(minY, t.position[i]);
      assert.ok(minY > -1.6 && minY < 0.3, `${id} stands on the ground (lowest vertex ${minY})`);
    }
    const full = buildTree(id, { lod: 0, seed: 3 }), reduced = buildTree(id, { lod: 1, seed: 3 });
    assert.ok(reduced.tris < full.tris * 0.45, `${id}: the reduced mesh (${reduced.tris}) is much lighter than the full one (${full.tris})`);
    assert.ok(Math.abs(reduced.height - full.height) < full.height * 0.25, `${id}: both levels are the same tree`);
  }
});

test('flora: different seeds grow different trees of the same species', () => {
  const a = growSkeleton('oak', 1), b = growSkeleton('oak', 2);
  assert.notDeepEqual(JSON.stringify(a).slice(0, 4000), JSON.stringify(b).slice(0, 4000));
  assert.throws(() => buildTree('baobab'));
});

test('flora: leaf atlas cells are inside the atlas and do not overlap', () => {
  const seen = [];
  for (const [name, id] of Object.entries(ATLAS.cells)) {
    const [u0, v0, u1, v1] = cellUV(id, 0);
    assert.ok(u0 >= 0 && v0 >= 0 && u1 <= 1 && v1 <= 1 && u1 > u0 && v1 > v0, name);
    for (const [n, r] of seen) assert.ok(u1 <= r[0] + 1e-9 || u0 >= r[2] - 1e-9 || v1 <= r[1] + 1e-9 || v0 >= r[3] - 1e-9, `${name} overlaps ${n}`);
    seen.push([name, [u0, v0, u1, v1]]);
    const inset = cellUV(id, 0.01); assert.ok(inset[0] > u0 && inset[2] < u1);
  }
  assert.equal(seen.length, ATLAS.cols * ATLAS.rows);
  for (const id of SPECIES_IDS) assert.ok(id in ATLAS.cells, id + ' has leaves in the atlas');
});

test('flora: hash01 is a stable number in [0, 1)', () => {
  for (let i = 0; i < 200; i++) { const h = hash01(i, 3); assert.ok(h >= 0 && h < 1); assert.equal(h, hash01(i, 3)); }
});

test('flora: level-of-detail distances grow with the picture and shrink with the detail level', () => {
  let prev = null;
  for (const level of ['low', 'medium', 'high', 'ultra']) {
    const d = lodDistances(1200, 40, level);
    assert.ok(d.d1 >= d.d0 && d.w0 > 0 && d.w1 > 0, `${level}: ${JSON.stringify(d)}`);
    if (prev) assert.ok(d.d0 >= prev.d0 && d.d1 >= prev.d1, level + ' draws real trees at least as far as the level below');
    prev = d;
  }
  const small = lodDistances(300, 40, 'high'), big = lodDistances(600, 40, 'high');
  assert.ok(Math.abs(big.d1 / small.d1 - 2) < 1e-6, 'twice the pixels: real meshes twice as far (a smaller render scale draws fewer)');
  assert.ok(lodDistances(1200, 40, 'low').d0 < 0, 'low never draws the full mesh');
  assert.ok(lodDistances(1e6, 40, 'ultra').d1 <= 700, 'and there is a ceiling however large the picture');
});

test('flora: the cross-fade weights of the three levels always add up to one', () => {
  for (const level of ['low', 'medium', 'high', 'ultra']) {
    const d = lodDistances(1200, 40, level);
    for (let dist = 0; dist < d.d1 * 3 + 50; dist += (d.d1 * 3 + 50) / 211) {
      const w = lodBlend(dist, 1, d);
      assert.ok(Math.abs(w.mesh0 + w.mesh1 + w.impostor - 1) < 1e-6, `${level} at ${dist} m`);
      for (const x of [w.mesh0, w.mesh1, w.impostor]) assert.ok(x >= -1e-9 && x <= 1 + 1e-9);
      if (level === 'low') assert.equal(w.mesh0, 0);
    }
    assert.ok(lodBlend((d.d1 + d.w1) * 1.01, 1, d).impostor > 0.999, 'far away: the impostor');
    assert.ok(lodBlend((d.d1 + d.w1) * 1.01, 2, d).impostor < 0.999, 'a tree twice the size keeps its mesh farther');
  }
  assert.ok(lodBlend(0.5, 1, lodDistances(1200, 40, 'high')).mesh0 > 0.99, 'next to the camera: the full mesh');
});

test('flora: the vegetation level follows the setting, the quality level and the governor', () => {
  assert.deepEqual(VEG_LEVELS, ['low', 'medium', 'high', 'ultra']);
  assert.equal(vegLevel('auto', 'high'), 'high'); assert.equal(vegLevel('auto', 'medium'), 'medium'); assert.equal(vegLevel('auto', 'low'), 'low'); assert.equal(vegLevel('auto', 'soft'), 'low');
  assert.equal(vegLevel(undefined, 'high'), 'high');
  assert.equal(vegLevel('ultra', 'low'), 'ultra', 'an explicit choice wins over the quality level');
  assert.equal(vegLevel('ultra', 'high', 1), 'high'); assert.equal(vegLevel('high', 'high', 2), 'low'); assert.equal(vegLevel('low', 'high', 5), 'low');
  // every governor level names how many vegetation levels it takes away, and never gives detail back on the way down
  for (let i = 0; i < LEVELS.length; i++) { assert.ok(Number.isInteger(LEVELS[i].detail) && LEVELS[i].detail >= 0, 'level ' + i); if (i) assert.ok(LEVELS[i].detail >= LEVELS[i - 1].detail); }
  assert.equal(LEVELS[0].detail, 0);
});

test('flora: mip levels of the leaf atlas keep the cover of the full picture, cell by cell', async () => {
  const { coverMips, loadFloraAssets, floraAssets } = await import('../../js/render/floratex.js');
  // two cells side by side: a fine checker (half covered) and a sparse scatter (about one texel in eight)
  const W = 128, H = 64, d = new Uint8Array(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const o = (y * W + x) * 4, on = x < 64 ? (x + y) % 2 === 0 : hash01(x, y) < 0.125;
    d[o] = on ? 40 : 255; d[o + 1] = on ? 200 : 0; d[o + 2] = on ? 30 : 255; d[o + 3] = on ? 255 : 0;
  }
  const cover = (L, x0, x1) => { let n = 0, t = 0; for (let y = 0; y < L.height; y++) for (let x = x0; x < x1; x++, t++) if (L.data[(y * L.width + x) * 4 + 3] > 0.4 * 255) n++; return n / t; };
  const kept = coverMips(d, W, H, 2, 1, true), plain = coverMips(d, W, H, 2, 1, false);
  assert.equal(kept.length, 8); assert.equal(kept[0].data, d);
  assert.deepEqual(kept.map(L => [L.width, L.height]).slice(-2), [[2, 1], [1, 1]]);
  const L2 = kept[2], P2 = plain[2];
  assert.equal(cover(P2, 16, 32), 0, 'plain averaging loses the sparse cell altogether');
  assert.ok(cover(L2, 16, 32) >= 0.1 && cover(L2, 16, 32) < 0.5, 'the sparse cell keeps its cover');
  assert.ok(cover(L2, 0, 16) > 0.4, 'the half-covered cell keeps its cover');
  // colour is averaged over covered texels only: no magenta from the transparent ones
  assert.ok(L2.data[0] < 60 && L2.data[1] > 180 && L2.data[2] < 60);
  // without a browser there are no scans to load: the promise still resolves and the painted textures are used
  const a = await loadFloraAssets();
  assert.equal(a, floraAssets); assert.equal(a.photo, false); assert.equal(a.leaves, null);
});
