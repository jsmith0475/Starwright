// The automatic landing comes down the glide slope steadily and sets the aeroplane down gently. Round 3: the final
// approach had no damping on the path, so a craft slow in pitch (the Skimmer) swung between +2 and −9 m/s vertical
// speed all the way down and touched at 5 to 7 m/s; whether its tail fin survived turned on which way the swing
// happened to be going. The flare also let the nose rise past the tail-strike angle while there was air under it.
// Each craft is flown from several starting conditions so that the result does not rest on one lucky phase.
import test from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../../js/core/world.js';
import { stockCrafts } from '../../js/core/craft.js';
import * as AP from '../../js/core/autopilot.js';

for (const name of ['Kite Trainer', 'Skimmer']) {
  test(`${name}: steady down the glide slope, a gentle touchdown, nothing broken, from four starting conditions`, () => {
    for (const [alt, dt] of [[400, 1 / 30], [300, 1 / 30], [350, 1 / 30], [400, 1 / 50]]) {
      const w = new World();
      const craft = stockCrafts().find(c => c.name === name);
      const v = w.launch(craft, { crew: ['Ada'], site: 'runway' });
      const broke = []; w.on('explosion', d => broke.push(d.partName));
      const to = AP.fly(w, AP.planeTakeoff(w, v, { altitude: alt }), { dt, physWarp: 0, maxSim: 400 });
      assert.ok(to.done && !to.failed, `take-off to ${alt} m`);
      const ctl = AP.planeLand(w, v, {}), frame = AP.runwayFrame();
      let lo = Infinity, hi = -Infinity;
      const update = ctl.update;
      ctl.update = h => { update(h); if (ctl.phase === 'final') { const p = AP.siteCoords(frame, v, w.ut); if (p.along > -1500) { lo = Math.min(lo, v.verticalSpeed); hi = Math.max(hi, v.verticalSpeed); } } };
      const ld = AP.fly(w, ctl, { dt, physWarp: 0, maxSim: 2500 });
      const how = `from ${alt} m, steps of ${(dt * 1000).toFixed(0)} ms`;
      assert.ok(ld.done && !ld.failed, `${how}: landed (${ld.log.map(l => l.msg).join('; ')})`);
      assert.ok(hi - lo < 1.5 && hi < 0, `${how}: vertical speed over the last 1.5 km of the approach stays within 1.5 m/s (${lo.toFixed(1)} … ${hi.toFixed(1)} m/s)`);
      assert.ok(ctl.touchdown && ctl.touchdown.sink < 2.5, `${how}: touchdown sinking ${ctl.touchdown && ctl.touchdown.sink.toFixed(1)} m/s`);
      for (let i = 0; i < 300; i++) w.step(1 / 30);
      assert.deepEqual(broke, [], `${how}: nothing broke`);
      assert.equal(v.parts.size, craft.parts.length);
      const end = AP.siteCoords(frame, v, w.ut);
      assert.ok(v.landed && end.along > 0 && end.along < frame.length && Math.abs(end.cross) < 20, `${how}: stopped on the runway (${end.along.toFixed(0)} m along, ${end.cross.toFixed(0)} m off the centreline)`);
    }
  });
}
