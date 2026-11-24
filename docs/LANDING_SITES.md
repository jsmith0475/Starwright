# The landing autopilot looks at the ground

How "Land here" chooses where to stand a lander, what was checked, and what it still cannot do.

## Why

Until this change the landing autopilot did not look at the ground. It braked out of orbit, stopped
40 m above whatever was under it, and went straight down. Whether the lander was still standing
afterwards depended on where the orbit happened to bring it. Two long test flights had been passing
by that luck. A crew does not get a second try at a landing, so this is a flight-safety fault, and
it was fixed as one.

Flown from 24 points round a low orbit of each of the twelve airless worlds, with the stock Wayfarer
lander (a tall lander that tips over its feet at 13 degrees):

| | Landers still standing, of 288 |
| --- | --- |
| The old autopilot | 212 |
| This one | 288 |

The old program fell over on slopes on every world, and on three of the 288 it flew into rising
ground during the braking burn.

On nine of the 288, all on the two smallest worlds (Nock and Wend), the new one found nothing fit
within the short distance it can cross there, said so, and went to the best ground it had. Those
landers stood as well, because gravity that weak barely pulls a lander over. It pulled up from
rising ground three times. Propellant used is about the same as before on the large worlds and
less on the small ones.

## What you will notice

- **It may wait in orbit.** Engage Land here from orbit and it first works out where a burn begun
  now would bring you down. If the ground there is too steep it says so, stays in orbit under time
  warp, and looks again a little further round, for one orbit at most.
- **The braking burn keeps clear of hills.** The burn is planned so that the whole path, not only its
  end, stays above the ground. If the ground still rises in front of the lander it pulls up: the
  engine points mostly upward until the way ahead is clear.
- **At the hover it looks round and flies across.** It tells you what it found: "the ground here
  slopes 16°: moving 150 m to ground that slopes 3°". It crosses about 25 m up (lower on small
  worlds), stops over the spot, and comes straight down.
- **It warns you when it cannot find a safe place.** "No ground fit to stand on within 400 m: the
  best slopes 9°, this lander's limit is 5°". It gives the reason: too steep, broken ground, or the
  edge of something steeper. It then goes to the least steep ground it found. The
  warning is your cue to take over, or to expect a lander on its side.
- **A booster that cannot reach its pad does the same** with the little propellant it has, over a
  shorter distance.

You can take over at any time with any steering key, as before.

## What "fit to stand on" means

`js/core/landingsite.js` reads the same height field the physics stands the craft on.

**Slope.** Seventeen heights are taken under the lander: the middle, a ring at the footprint radius
and a ring at half of it. The footprint radius is the lander's own (how far its feet stand from its
middle) plus 2 m for a touchdown that is a little off, and never less than 3 m. A plane is fitted to
the seventeen heights by least squares, and its tilt is the slope.

**Roughness.** The largest distance of any of the seventeen heights from that plane. More than
8 % of the footprint radius (32 cm for a 4 m footprint) is not fit: a boulder or the lip of a small
crater under one foot.

**The limit.** A lander tips over when the slope passes the angle between its outermost foot and
its centre of mass, `atan(footprint radius / height of the centre of mass)`. It does not arrive
perfectly still, and the downhill leg takes the load first, so the autopilot uses 40 % of that
angle, never more than 6 degrees and never less than 1.5. The number was set by experiment: stock
landers were set down at 1 m/s on real ground of measured slope.

| Lander | Tips over at | Stood on everything up to | Limit used |
| --- | --- | --- | --- |
| Wayfarer lander, on Pell | 13.3° | 6° | 5.3° |
| Pellfarer lander, on Pell | 26.0° | 8° | 6.0° |

**Not on a lip.** The ground three footprints wide round the spot must be no steeper than 1.4 times
the limit and must not be water. A level shelf one metre from a cliff is not chosen.

**Dry.** Open water is never fit. The deck of the landing barge is level by construction and is fit.

## How it chooses

**In orbit (the survey).** The program flies the deorbit burn on paper exactly as it will fly it
(retrograde, easing off as the periapsis comes down), follows the descent orbit to the point where
the braking burn must start, and runs that burn to a stop. That gives the hover point. It then
searches for fit ground within 300 m of that point and of four points 500 m off it, and goes when at
least four of the five have some. The four extra points cover the error of the prediction, which
was measured against the flights: within 150 m on Dray, within 700 m on Pell, within 850 m on Slate.

**At the hover (the choice).** `findSite` tests up to 600 spots on a fixed spiral out to 400 m, or
less if the propellant is short: crossing may use a tenth of what is left. It takes the fit spot
that is nearest, counting flatter ground as nearer. If nothing within 400 m is fit and the
propellant allows, it looks once more out to 1,200 m. The spiral is fixed, so the same situation
always gives the same answer.

**The crossing.** A hovering engine leaned by an angle θ pushes sideways with `g × tan θ` and no
more, so on a small world the lander can only cross slowly. It leans up to 17 degrees (29 where
gravity is under 0.5 m/s²), holds its height above the highest ground on the way, and gives the
crossing up if what is left in the tanks would not see it there and down. It is over the spot when
it is within 0.8 m and stopped, and it then descends as the old program did: upright, drift killed,
committed at 5 m.

## Keeping clear of the ground on the way down

**The plan.** The braking burn is timed from a prediction of where the burn would stop. That
prediction now looks at the ground under the whole of its path, every 40 m when within a kilometre
of the surface, and the burn is timed so that the path stays at least 20 m lower than the hover
height and no lower. The old prediction looked only under the end point, and a burn aimed at a
valley floor beyond a ridge met the ridge.

**The last line.** During the burn the program extends the lander's motion five seconds ahead,
with the push of its engine and of gravity as they are at that moment. If that path comes within
12 m of the ground and the lander is sinking, it pulls up and says so. A pull-up costs propellant
(about 100 to 250 m/s where it was seen), so it is set to act late.

## A fault found on the way

The deorbit burn was meant to wait until the lander had turned to face backwards. The check that
did the waiting compared a direction with itself and always passed, so the engine lit while the
lander was still turning. The burn pushed sideways first, the descent orbit came out a different
shape, and on Dray the fall took 1,720 seconds in place of 960. It is fixed. Landings now use
slightly less propellant on most worlds than before, even with the hover across.

The same check guards the throttle during the braking burn and is still open there. Closing it
changes how every landing brakes, so it was left for a change of its own.

## What was checked

Run `node tests/verify/run.mjs --only 12` for the independent checks and
`node --test tests/unit/landing_site.test.js` for the unit tests.
`node tests/tools/landing_sweep.mjs bodies=airless n=24` repeats the 288 landings.

- **The slope and roughness measure** against made-up worlds whose slope is a formula, and on real
  ground against a separate 400-point least-squares fit: within 1.2 degrees on 181 smooth spots.
- **"Fit" means the lander stands.** Landers were set down at 1 m/s on spots the search calls fit,
  chosen from the steeper half of what it allows, and stood on every one. Set down on ground at
  twice their tipping angle they fell.
- **The search** against a dense search by the separate fit: every spot it called fit was fit by the
  other measure, and where it found nothing within 200 m the other search found next to nothing.
- **Landings from orbit** on six worlds: all standing, on the ground chosen, within 4 m of the spot,
  never closer than 20 m to the ground at speed.
- **The hover across** against a hand calculation: no flight crossed faster than `g × tan θ`
  allows, and each paid about `g × time` for it, which is what a hover costs.
- **The survey** against the flights, as given above.
- **In the real game**, in Chrome on the project owner's Mac: see the pull request.

## What it does not do

- **It does not see rocks, trees or buildings.** It reads the height field. Scatter drawn on the
  ground is not in the physics either, so nothing it cannot see can trip a lander.
- **It cannot fix a landing with no propellant.** With too little left it comes down where it is
  and says so.
- **It only chooses along the orbit you are on.** It will not change the orbit's plane to reach
  better ground. If a whole orbit passes over nothing it likes, it goes down to look closer and
  warns you.
- **After a pull-up it is somewhere it did not plan to be.** It looks round again from there, out to
  1,200 m if it can. On a mountainside that may still find nothing, and it will say so.
- **On the two smallest worlds (Nock and Wend) it touches down 2 to 3 m from the chosen spot**, not
  within 1 m. A hovering engine has almost nothing to lean with there. The footprint allows for it.
- **Aeroplanes and worlds with air are untouched.** "Land here" is offered only where there is no
  air. The booster's return to its pad or the barge is unchanged; only its landing away from them
  looks at the ground.
