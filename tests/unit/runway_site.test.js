// One runway, not two: the core's site record (where World.launch, the autopilot and the demo put an aeroplane) and
// the space-centre model (where the strip is drawn) must name the same ground. Round 3: they were 550 m apart, and
// the demo's aeroplane began its roll on grass west of the drawn runway.
import test from 'node:test';
import assert from 'node:assert/strict';
import { SYSTEM } from '../../js/core/bodies.js';
import { World } from '../../js/core/world.js';
import { stockCrafts } from '../../js/core/craft.js';
import { BASE_LAYOUT as LAYOUT } from '../../js/render/basegfx.js';

const home = SYSTEM.home, R = home.radius;
const east = d => -d.z * R, south = d => -d.y * R;      // local metres at the pad, as the model lays them out (+X east, +Z south)

test('the core runway record is the strip the space-centre model draws', () => {
  const rw = SYSTEM.sites.runway;
  assert.ok(Math.abs(east(rw.dir) - LAYOUT.runwayX[0]) < 0.01, `threshold at x = ${east(rw.dir).toFixed(2)}, drawn at ${LAYOUT.runwayX[0]}`);
  assert.ok(Math.abs(south(rw.dir) - LAYOUT.runwayZ) < 0.6, `centreline at z = ${south(rw.dir).toFixed(2)}, drawn at ${LAYOUT.runwayZ}`);
  assert.equal(rw.length, LAYOUT.runwayX[1] - LAYOUT.runwayX[0]);
  assert.ok(Math.abs(east(rw.center.dir) - (LAYOUT.runwayX[0] + LAYOUT.runwayX[1]) / 2) < 0.01);
  assert.equal(rw.heading, 90);
  assert.ok(Math.abs(east(rw.start.dir) - (LAYOUT.runwayX[0] + 100)) < 0.01, 'vessels stand 100 m past the threshold (the model\'s runwayAnchor)');
});

test('World.launch(…, {site: "runway"}) puts an aeroplane on the drawn strip, with all of it ahead', () => {
  const w = new World();
  const v = w.launch(stockCrafts().find(c => c.name === 'Kite Trainer'), { crew: ['Ada'], site: 'runway' });
  const d = v.surface.dir, x = east(d), z = south(d);
  assert.ok(x > LAYOUT.runwayX[0] + 50 && x < LAYOUT.runwayX[0] + 200, `starts at x = ${x.toFixed(1)}, strip from ${LAYOUT.runwayX[0]}`);
  assert.ok(Math.abs(z - LAYOUT.runwayZ) < 1, `on the centreline: z = ${z.toFixed(2)}`);
  assert.ok(LAYOUT.runwayX[1] - x > 1500, 'at least 1.5 km of runway ahead');
  assert.equal(v.launchSite, 'runway');
});
