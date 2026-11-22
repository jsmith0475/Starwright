// The ground the physics stands on must not move when the worlds are made to look better (roadmap item 4,
// docs/WORLDS.md). tests/unit/fixtures/terrain_golden.json holds body.terrainHeight at 400 directions spread over
// each of the 16 solid bodies and on a 2 m grid of 100 points at one place, recorded from `main` before the
// higher-fidelity worlds work began. Anything that changes a height by a micrometre fails here.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { SYSTEM } from '../../js/core/bodies.js';

const golden = JSON.parse(fs.readFileSync(new URL('./fixtures/terrain_golden.json', import.meta.url), 'utf8'));

test('terrain heights are exactly those recorded before the higher-fidelity worlds work', () => {
  const solid = SYSTEM.bodies.filter((b) => !b.gas && b.type !== 'star');
  assert.equal(solid.length, 16);
  for (const b of solid) {
    const want = golden[b.id], N = 400;
    assert.ok(want && want.length === 500, b.id);
    let worst = 0;
    for (let i = 0; i < N; i++) {
      const y = 1 - (2 * (i + 0.5)) / N, r = Math.sqrt(1 - y * y), a = i * 2.399963229728653;
      worst = Math.max(worst, Math.abs(b.terrainHeight({ x: r * Math.cos(a), y, z: r * Math.sin(a) }) - want[i]));
    }
    const d0 = { x: 0.6, y: 0.48, z: 0.64 };
    for (let i = 0; i < 100; i++) worst = Math.max(worst, Math.abs(b.terrainHeight({ x: d0.x + (i % 10) * 2 / b.radius, y: d0.y, z: d0.z + Math.floor(i / 10) * 2 / b.radius }) - want[N + i]));
    assert.ok(worst <= 1e-6, `${b.id}: a height moved by ${worst} m`);
  }
});
