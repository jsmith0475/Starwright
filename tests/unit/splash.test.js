// The numbers behind a floating craft riding the swell (js/render/swell.js): gentle, smooth, smaller for wide hulls.
import test from 'node:test';
import assert from 'node:assert/strict';
import { swellAt, swellShare, SWELL } from '../../js/render/swell.js';

test('swell: gentle, bounded, and never still', () => {
  const maxHeave = SWELL.HEAVE.reduce((s, t) => s + t[0], 0), maxTilt = SWELL.TILT_A.reduce((s, t) => s + t[0], 0);
  assert.ok(maxHeave <= 0.2, 'a capsule never rises or sinks more than 20 cm on the swell');
  assert.ok(maxTilt <= 4 * Math.PI / 180, 'and never tips more than 4 degrees');
  let lo = Infinity, hi = -Infinity, tl = 0;
  for (let t = 0; t < 120; t += 0.05) {
    const s = swellAt(t, 3.3, 1.25);
    assert.ok(Math.abs(s.heave) <= maxHeave + 1e-9 && Math.abs(s.tiltA) <= maxTilt + 1e-9 && Math.abs(s.tiltB) <= maxTilt + 1e-9);
    lo = Math.min(lo, s.heave); hi = Math.max(hi, s.heave); tl = Math.max(tl, Math.abs(s.tiltA));
  }
  assert.ok(hi - lo > 0.15, 'the capsule visibly rises and falls: ' + (hi - lo).toFixed(3) + ' m');
  assert.ok(tl > 0.03, 'and visibly rocks');
});

test('swell: smooth from frame to frame (no step the eye could catch)', () => {
  let prev = swellAt(0, 1, 1.25).heave;
  for (let t = 1 / 60; t < 30; t += 1 / 60) {
    const h = swellAt(t, 1, 1.25).heave;
    assert.ok(Math.abs(h - prev) < 0.005, 'less than 5 mm a frame');
    prev = h;
  }
});

test('swell: a wide hull moves less than a small capsule, two craft do not move as one', () => {
  assert.equal(swellShare(1.0), 1);
  assert.ok(swellShare(4.5) < swellShare(2) && swellShare(2) < 1);
  assert.equal(swellShare(100), SWELL.MIN_SHARE);
  assert.equal(swellShare(undefined), 1);
  const a = swellAt(7, 1, 1.25).heave, b = swellAt(7, 9, 1.25).heave;
  assert.ok(Math.abs(a - b) > 1e-3);
  assert.ok(Math.abs(swellAt(7, 1, 4.5).heave) < Math.abs(a));
});
