// How a floating craft rides the swell once it has come to rest on the sea. Plain numbers, no drawing: the flight
// scene moves the picture of the craft by these amounts, and tests can read them without a browser.
//
// The physics floats a craft on buoyancy and water drag, and that is what moves it in the first seconds after
// splashdown (it plunges, comes back up and rocks until the water has taken the energy out). Once it is quiet the
// physics pins it to the surface, as it does a lander on the ground, and from then on this slow swell is what is
// seen. It is a picture of the sea's motion only: the craft's position, attitude and everything computed from them
// stay exactly where the physics left them.
//
//   swellAt(t, seed, baseRadius)   → { heave (m, + is up), tiltA, tiltB (rad, about two level axes at right angles) }
//   SWELL                          the amplitudes and periods

const TAU = Math.PI * 2;

export const SWELL = {
  // two unrelated periods each, so the motion never visibly repeats
  HEAVE: [[0.10, 3.4], [0.05, 5.3]],          // m, s
  TILT_A: [[0.040, 2.9], [0.018, 4.6]],       // rad, s   (2.3° and 1.0°)
  TILT_B: [[0.030, 3.7], [0.014, 6.1]],
  REF_RADIUS: 1.3,                            // m: a craft this wide at the base rides the swell in full
  MIN_SHARE: 0.25,                            // the widest craft still move this much of it
};

/** Share of the swell a craft of this base radius follows: a small capsule is thrown about, a wide hull averages the waves under it. */
export function swellShare(baseRadius) {
  const r = Number.isFinite(baseRadius) && baseRadius > 0 ? baseRadius : SWELL.REF_RADIUS;
  return Math.min(1, Math.max(SWELL.MIN_SHARE, SWELL.REF_RADIUS / r));
}

const sum = (terms, t, seed, k) => {
  let s = 0;
  for (let i = 0; i < terms.length; i++) s += terms[i][0] * Math.sin(TAU * t / terms[i][1] + seed * (k + i * 1.7));
  return s;
};

/**
 * @param t           seconds on the craft's own swell clock (it stops when the game is paused)
 * @param seed        any number, different for each craft, so two capsules side by side do not move as one
 * @param baseRadius  m, the craft's radius at the base
 * @param out         optional object to fill
 */
export function swellAt(t, seed = 0, baseRadius = SWELL.REF_RADIUS, out = {}) {
  const k = swellShare(baseRadius);
  out.heave = k * sum(SWELL.HEAVE, t, seed, 1.0);
  out.tiltA = k * sum(SWELL.TILT_A, t, seed, 2.3);
  out.tiltB = k * sum(SWELL.TILT_B, t, seed, 3.9);
  return out;
}
