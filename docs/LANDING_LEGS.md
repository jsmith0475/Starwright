# Landing legs

How landing legs work in Starwright, what was checked, and what was not. This is roadmap item 1,
"Landing legs that work like legs".

## What you will notice

- A lander sinks onto its legs when it touches down and comes back up to where it rests. The
  struts are drawn closing by exactly what the physics says they closed.
- How hard you land matters. On the standard Lander Strut, on any world:

  | Touchdown speed | What happens |
  | --- | --- |
  | up to about 4 m/s | A clean landing. The legs use part of their travel. |
  | about 5 to 6 m/s | The legs run out of travel and hit their stops. A jolt of 10 g or more, a warning, nothing breaks. |
  | about 7 m/s and up | The legs collapse and the craft comes down on whatever is under it. |
  | about 9 m/s and up | Parts of the hull go too, depending on what the craft comes down on. |

  The Stilt Heavy Leg has 55 cm of travel against 32 cm: on a light test lander it bottomed out
  at 8 m/s and collapsed at 9. The Sprig has 18 cm, so less margin; its limits were not measured.
- Stance matters. A lander set down leaning stands up again below its tipping angle and goes over
  above it. Coming in sideways trips it.
- On small moons a lander now settles onto its feet. Before this work it could be frozen in place
  balanced on one or two feet, with the others 10 to 30 cm in the air.

## The model

Stated plainly, because a game should say what it does and does not simulate.

**A vessel is still one rigid body.** The legs do not flex the craft and joints do not bend. That
is roadmap item 2.

**Each deployed leg is one spring and one damper.** The foot moves up the craft's long axis by the
amount the strut has closed.

- Spring rate per leg: `k = m × ω² / n`, with `m` the mass of the craft at that moment, `n` the
  number of legs that are down, and `ω = 11 rad/s` (1.75 Hz). The spring is sized to the craft, not
  fixed by the part. A real strut has a fixed spring rate; here a heavier craft on the same legs
  gets proportionally stiffer legs. The consequence is that every craft sags by the same amount on
  a given world, `g / ω²`: 7.9 cm on Verda, 1.3 cm on Pell, 2 mm on Dray.
- Damping: ratio 0.3 while the leg closes, 4 while it opens. A real oleo strut is built the same
  way, firm going in and slow coming out, so that it absorbs a landing instead of throwing the
  craft back up. Where gravity is a fiftieth of home, a spring that gave back even a fifth of the
  landing speed would send a lander metres into the air.
- Stroke: 32 cm (Lander Strut), 18 cm (Sprig), 55 cm (Stilt). Against sloping ground a leg has
  less travel, and lying on its side it has none.
- End of stroke: a hard stop with the same stiffness as hull contact. A leg that reaches its stop
  still closing faster than 0.3 × its impact tolerance (4.2 m/s for the Lander Strut) collapses.
- Friction under each foot is the same law as before: sticking up to a friction coefficient of
  1.1, sliding beyond it.
- The ground under each foot is the terrain at that foot, as before. A rigid craft with four legs
  on rough ground can stand on three, with the fourth just clear.

**Three rules outside the springs changed with it**, because the old ones produced the frozen
landers:

1. *Coming to rest.* A craft is pinned in place once it is quiet. "Quiet" was a fixed speed, and on
   a small moon a lander rocking from one pair of feet to the other never exceeds it. The
   threshold now scales with the square root of gravity, the legs must have stopped moving on
   their dampers, and a craft whose loaded contact points lie on a single line (two feet) is not
   pinned. A craft balanced exactly on such a line gets a nudge of 0.002 rad/s once a second,
   because nothing in a computer disturbs a perfect balance and everything in nature does.
2. *Attitude hold.* Standing on the ground with the throttle closed, the attitude hold lets go.
   Reaction wheels strong enough to turn a lander in space were holding it up on one foot on Dray,
   Nym and Wend. Your own stick input still works on the ground.
3. *Legs that cannot be the first to stop you.* A part destroyed on impact takes its tolerance off
   the speed of the whole craft. For a leg rated to 14 m/s that meant arriving at 14 m/s stopped
   the craft dead and was safer than arriving at 12. A leg now takes only what it can take at the
   end of its stroke.

4. *The flight display froze landers.* This is the fault behind the old "legs in the ground"
   reports, and it was found by landing in a real browser, not by the tests. The flight display
   asks every frame how far time may be sped up. For a craft touching the ground with less than
   0.3 m/s of sideways speed that question pinned the craft where it was, as a side effect. A
   lander was therefore frozen within one frame of touching, wherever its feet happened to be. The
   question no longer pins anything except a parked vehicle on wheels. The tests now ask it every
   step, as the display does, so they see what the player sees.

Rules 1 and 2 apply to a craft on its legs. A craft standing on its hull, for example a stage
landed on its engine bell, is pinned as before and keeps its attitude hold. The bell is a single
point in this model, and a tall stack balanced on a point would fall over while it waited.

One more rule exists to keep the springs honest: a strut can only be closed by something that
drove it closed. If you unfold the legs under a craft that is standing on its engine, the feet
start below the ground. They take up the load at 0.15 m/s and lift the craft onto its legs at
walking pace. Released as compressed springs they would throw it off a small moon.

## What was checked

`tests/unit/landing_legs.test.js`, 27 tests, run with `npm test`.

- **Every world with ground** (16 of them, from Verda at 9.6 m/s² to Wend at 0.03): a lander set
  down at 1.5 m/s comes to rest upright, nothing breaks, no foot is in the ground, at least three
  of four feet are on it, the hull is clear, and the closure of the struts adds up to the weight
  they carry within 8 %.
- **Against the textbook.** The depth the legs close to on touchdown is compared with a separate
  solution of the equation for one mass on a spring and damper, `x″ = g − ω²x − 2ζωx′`, integrated
  in the test with a fourth-order Runge-Kutta at 0.1 ms. It shares no code with the game.

  | World | Touchdown | Game | Textbook |
  | --- | --- | --- | --- |
  | Verda | 1 m/s | 13.29 cm | 13.22 cm |
  | Verda | 2 m/s | 18.55 cm | 18.21 cm |
  | Verda | 3 m/s | 24.51 cm | 23.89 cm |
  | Rusk | 1 m/s | 8.25 cm | 7.97 cm |
  | Rusk | 2 m/s | 14.18 cm | 13.93 cm |
  | Rusk | 3 m/s | 20.27 cm | 19.98 cm |
  | Pell | 1 m/s | 7.13 cm | 6.99 cm |
  | Pell | 2 m/s | 13.24 cm | 13.05 cm |
  | Pell | 3 m/s | 19.60 cm | 19.14 cm |

  The game is 0.5 to 3.5 % deep. The test allows 3 % plus 2 mm. The remaining difference is the
  ground not being perfectly level under four feet and the game's 10 ms contact step.
- **The envelope** in the table at the top, at home, and that arriving faster is never safer.
- **The tipping point.** For the test lander (2.37 m between the lines of its feet, centre of mass
  2.81 m up) statics gives `atan(half-stance / height) = 22.9°`. Let go 4° short of that it rocks
  back onto its feet; 4° past it, it goes over. On the wider Stilt legs the same lean stands up.
- **Weak gravity.** Pell, Ost and Dray at 3 m/s: the rebound lifts the feet less than 25 cm
  (measured 0 to 5 cm) and the craft is at rest inside a minute (measured 6 to 12 s).
- **The frozen landers.** On Dray, Nym, Nock, Wend, Slate and Pell, on the rough sites where the
  fault was found and with the attitude hold on, at least three feet are on the ground when the
  craft is pinned.
- **No free energy.** Legs unfolded under a standing craft on Pell and Dray raise it at 0.16 m/s
  at most and no further than its legs.
- The state of the struts survives a save, and they hang at full length again after liftoff.

## What was not checked, and what is left

- **How it looks, and the frame rate, on a real graphics card.** The tests above are physics only.
  The strut animation follows the physics by construction, but it has to be looked at.
- **A fixed spring rate per part.** Legs that are too small for the craft should bottom out under
  its weight alone. Sizing the spring to the craft hides that.
- **The foot pad stays parallel to the craft**, not to the ground, and a leg closes straight up the
  craft's axis where the drawn strut swings on a hinge. On a slope the uphill rim of a pad can
  touch first.
- **Legs unfolding under a craft** are instant in the physics (then eased as above) while the
  animation takes 1.4 s. For a few seconds the drawn foot is below the ground.
- **Rover wheels and aeroplane landing gear** are unchanged. They had their own suspension
  already.
- **Hull contact changed slightly too.** The ground now damps a hull point four times harder on
  its way back out than on its way in, for the same reason as the legs: a craft that strikes its
  engine bell on a small moon should not be thrown back up.
