# Reusable boosters

Roadmap item 5: fly the first stage back and land it on its legs while the upper stage carries on
to orbit. It is being built in parts. **Three are in the game:**

1. A dropped stage that can still be flown keeps flying, under full physics, however far it is
   from the vessel you are watching.
2. A stage built to come back flies itself home: it flips, makes a boostback burn, makes an entry
   burn if it needs one, steers on its grid fins, and lands on its legs by the launch pad.

3. There are two places to land: the **Return Pad**, a marked concrete pad 600 m north of the launch
   pad, and the barge ***Patient Tide***, a steel deck anchored in the ocean 40 km east of it.

A stock reusable rocket, a recovery plan you choose before launch, and pay for landing one come
next.

## Flying a booster back

Build the first stage with four things, all below the separator:

- a **guidance ring** (a Wisp, Mote or Facet probe core, or a Beacon or Keystone ring);
- a liquid **engine** that can be throttled (the Goshawk does well);
- **landing legs** near the bottom. The **Heron Folding Leg** is made for this: see "Legs that fold" below;
- **grid fins** (Lattice Vanes) near the top. It will try without them and miss by kilometres.

Then launch with the **ascent assist**. Three things happen without you:

- The assist works out, all the way up, how much propellant the booster needs to turn round and
  land, and **stages early** when only that much is left. It says so: "staged with 2,327 kg left in
  the booster to fly back". With the test rocket that is at about 21 km and 770 m/s.
- The booster **starts its return at once**, in the background. Each step is called out on screen:
  the flip, the boostback burn, whether an entry burn is needed, the landing burn, the touchdown
  and how far from the target it stands.
- The assist carries the upper stage on to orbit.

Press **\\** to watch the booster come down, and **\\** again to go back. Touch the controls while
you are watching it and it is yours to fly. You can also start a return yourself on any rocket in
the air over Verda: Guidance, **Fly back and land**.

The target is the **Return Pad**, 600 m north of the launch pad: a concrete disc 90 m across with
two rings and an amber aim point, a road to it from the launch pad, and four light masts.

## Legs that fold

The **Heron Folding Leg** is a long leg for a stage that comes back. Mount four of them low on the
last tank, with the foot of each leg's box about level with the foot of the tank.

- **On the pad and all the way up and back down, the legs are folded.** Each lies flat against
  the tank, inside its own outline, its smooth back to the airflow. Folded, a leg adds nothing
  below the engine and nothing beside the tank that the ground could catch.
- **Folded, a leg shows the air very little**: 0.2 m² each, not the area of its long box. (The
  first version counted the whole box, 1.9 m² a leg. The climb was so draggy that the booster was
  let go at 15 km and 380 m/s instead of about 20 km and 680 m/s. It still came home, but that was
  wrong, and a whole-flight test now holds it.)
- **Just before touchdown they swing out.** The booster's own landing lowers them when it is
  60 m above the ground, in the landing burn, and says so ("landing legs down at 60 m"). The
  swing takes 2.4 seconds; in the flights measured the legs were told down 7 seconds or more
  before the pads touched.
- **Down, each leg is one rigid swing about its hinge**, about 57° from straight down. The pad
  stands 2.9 m out from the leg's mount and 3.8 m below its middle, which puts it 1.9 m below the
  foot of the tank: about half a metre below a Goshawk's bell. The stance is far wider than the
  small legs give, so the stage stands steadier.
- The struts are sprung like every other leg in the game: 40 cm of travel, and a telescoping
  strut from high on the tank to the middle of the leg, drawn closing as the leg takes the load.
- `G` lowers and raises them by hand, as with any leg. If you fly the stage down yourself,
  lowering them is yours to remember.

The small Sprig and the heavy Stilt still work on a booster; they are stowed and lowered at the
same moments. They are simply too small to see from any distance.

## Three pieces at separation

A plain Stack Separator fires at one end. It lets go of the stage above and stays bolted to the
stage below, so a booster built with one lands carrying the separator and the lattice that stood
round the upper engine. Nothing joins the two stages after it fires; the ring is just a passenger.

The **Twin-Plane Interstage** (sizes M and L) fires at both ends. One staging leaves three pieces:

- the upper stage, pushed forward;
- the first stage, pushed back, with a clean top;
- the ring and its lattice, a piece of debris of its own named "... interstage".

The first plane puts the same impulse between the two sides as a Stack Separator of that size. The
second plane then parts the ring from the first stage with the impulse that leaves the ring moving
at the mean of the two stages' speeds, so it stays in the gap between them and neither stage runs
into it. Mass and momentum are shared out exactly among the three (verification group 9i works the
three speeds out by hand from the catalogue masses and compares them to nine decimal places).

A whole flight from the pad with one, flown by the game: separation at 20.5 km and 745 m/s, and the
booster, 90 kg lighter for the missing ring, lands 0 m from the Return Pad at 1.7 m/s.

What is simple about it: pieces do not collide with each other in flight, so a ring that did drift
into a stage would pass through it. The ascent assist still counts the ring as part of the first
stage when it works out how much propellant to keep, which keeps a few kilograms more than needed.

## Landing on the barge

*Patient Tide* is a flat steel deck, 80 m long and 50 m wide, 4 m above the water, anchored 40 km
east of the launch pad under the path every eastward launch takes. It does not move: no swell and
no drift in this version. The sea under it is about 470 m deep.

To send a booster there, hop to it after separation (**\\**), open Guidance and choose **Land on
the barge**. From then on the return is flown exactly as it is to the Return Pad, with the deck as
the target. The barge suits a stage that has gone too far or too fast to turn all the way round:
it needs less of a boostback, so it needs less propellant.

The deck is solid to the physics and the edge is a real edge. A stage that comes down with its
feet over the side tips off into the sea. One that misses comes down in the water, and the program
reports "down in the sea" and how far from the target, not a landing.

Both sites are marked on the map once Verda is drawn large enough to tell them apart.

## How the return is flown

Everything below runs in `js/core/booster.js`, on the same 20 ms physics step as the rest of the
game. Nothing is scripted and nothing is nudged: the program only moves the controls a player has
(attitude, throttle, legs).

**The predictor.** Four times a second the program asks: if the engine stayed off from here, where
would this stage come down? `predictFall` integrates a point mass under inverse-square gravity and
drag, in air that turns with the planet, using the stage's own tail-first drag area and the game's
own drag rise through Mach 1. It returns the impact point, time, speed, peak dynamic pressure, peak
heating and peak g.

**Flip and boostback.** The stage turns to point its engine along the line that moves the predicted
impact point toward the target, and burns until the predicted miss stops shrinking (within 40 m, or
it would start to grow). This is closed loop on the prediction, so it corrects for its own turn
time and for the fuel it burns. It keeps a reserve for the landing and will not spend it.

**Entry burn, only when needed.** The predictor reports the hottest the skin would get. Above 80%
of the rating of the weakest part, the program plans a burn inside the predictor (so the impact
point already allows for it), sized by bisection to bring the peak back under the limit. Below
that it says "no entry burn needed" and saves the propellant. A stage dropped early on Verda
usually does not need one; one coming back from near-orbital speed does.

**Steering on the fins.** Falling engine first, a stage that leans its nose a few degrees gets a
sideways push from the air. The program leans up to 7 degrees to walk the impact point onto the
target. Without grid fins there is too little control to hold the lean, which is why a stage
without them misses.

**Landing burn.** The ignition height is solved numerically each step: the lowest height from
which the engine, at a throttle that leaves margin, with drag and with the mass falling as
propellant burns, stops the stage 20 m above the ground. Start too early and it runs out of
propellant hovering; too late and it hits the ground.

**Final descent.** From 20 m it kills the last sideways drift, waits at 12 m until it is within
3 m of the target and nearly still, then comes down at about 1.7 m/s onto its legs.

If the target cannot be reached, the program says so and lands where it can. If the propellant is
gone, the stage is lost, as it would be.

## What was measured

- The predictor against the flight: over a 63 km fall through the whole atmosphere, the predicted
  impact point is within 0.1% of the distance flown, and within 2.4 m of an independent
  integration (below).
- 312 returns from random separations (22 to 40 km up, 850 to 1,350 m/s, 12 to 40 km downrange,
  different amounts of propellant): **312 landed**, every one within 0.3 m of the target, at
  1.75 m/s, upright. `node tests/tools/booster_sweep.mjs 200 777` repeats 200 of them.
- A whole mission in a real browser: separation at 21.4 km and 772 m/s, the booster down 0 m from
  the Return Pad at 1.7 m/s with 249 m/s of propellant left, the upper stage in an
  83 × 80 km orbit.
- The same mission sent to the barge, in a real browser: the booster down 0 m from the middle of
  the deck at 1.7 m/s, upright, and the upper stage in the same orbit.

## Flying a booster yourself

1. In the assembly building, put a guidance ring (a Wisp, Mote or Facet probe core, or a Beacon
   or Keystone guidance ring) on the first stage, below the separator. Anything with a guidance
   ring or a crew aboard can be flown.
2. Launch and stage as usual. The dropped stage is now called a **booster** and the game tells
   you it is flying on its own.
3. Press **\\** to hop to it, and **\\** again to hop back. **[** and **]** still step through
   every vessel, and now reach a booster at any distance.
4. Fly it down by hand: it has whatever engines, propellant, fins and legs you gave it. A stage
   with no legs is never flown back for you.
5. If the ascent assist was flying the upper stage when you hopped away, it goes on flying it,
   stages it, and takes it to orbit. It tells you when it is done.

Fast time warp (5× and above) waits while one of the two is still in flight somewhere else, and
the message says which vessel is holding it. Physics warp up to 4× works.

A stage with no guidance ring is debris, exactly as before: it is flown while it is near you and
removed when it falls behind in the air.

## The rule

A vessel other than the one you are flying keeps full physics at any distance when all of this
is true (`World.isTrackable`):

- it is a ship that can be controlled: a guidance ring, or a crew in a capsule;
- it is in flight, and has not been let go (`World.release`);
- it is running a guidance program, or is under thrust, or is inside an atmosphere, or is on a
  path that comes down into the air or the ground;
- it already had full physics on the step before. Nothing that is riding on rails is ever woken
  up by this rule, so a ship parked in orbit, or one arriving from another world, behaves as it
  always did.

At most four vessels are followed this way at once (`MAX_TRACKED`): enough for a core, two side
boosters and an upper stage. A ship coasting on a closed orbit clear of the air goes on rails as
before. A booster that reaches the ground in one piece stays where it stands.

The physics does not know which vessel you are watching. The same launch flown three ways
(watching the upper stage, watching the booster, switching every five seconds) gives the same
positions, velocities, attitudes and masses to the last bit; see "What was checked".

## What a falling stage goes through today

Measured with `node tests/tools/booster_envelope.mjs`, which flies every stock rocket to orbit
with the ascent program and then lets each dropped stage fall on its own, with nobody steering.
Verda is small: 640 km radius, air to 72 km, about 2,340 m/s to orbit at 80 km.

| Stage | Separates at | Speed | Downrange | Falls for | Peak air load | Hottest part | Hits the ground at | Lands downrange |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Skylark II first stage | 19.8 km | 890 m/s | 12 km | 163 s | 19 kPa | 533 | 176 m/s | 47 km |
| Farwind side boosters | 18.8 km | 1,008 m/s | 10 km | 216 s | 24 kPa | 747 | 117 m/s | 60 km |
| Whisper Probe first stage | 23.2 km | 1,022 m/s | 17 km | 215 s | 19 kPa | 723 | 174 m/s | 116 km |
| Latch Chaser first stage | 40.3 km | 1,579 m/s | 54 km | 323 s | 30 kPa | 869 | 188 m/s | 391 km |
| Colossus side boosters | 78.9 km | 822 m/s | 105 km | 234 s | 22 kPa | 754 | 115 m/s | 230 km |
| Pell Runner lifter | 79.5 km | 1,760 m/s | 166 km | 355 s | 31 kPa | 1,700 | 159 m/s | 603 km |
| Ember Twin core | 79.7 km | 1,741 m/s | 238 km | 352 s | 38 kPa | 1,700 | 122 m/s | 647 km |
| Colossus core | 80.1 km | 1,949 m/s | 136 km | 478 s | 15 kPa | 1,700 | 127 m/s | 799 km |

What this says (it was measured before guidance was written, and guidance was built to it):

- **A stage meant to come back has to let go early.** The first four rows separate below 40 km
  and under 1,600 m/s, within 55 km of the pad. Those can turn round. The last three burn almost
  to orbit and come down 600 to 800 km away: no boostback burn reaches the pad from there.
- **An entry burn is real work on the fast ones and not needed on the slow ones.** The slow
  stages peak at 530 to 870 on parts rated 1,400 and up. The fast ones run parts to their limit.
  Guidance burns on the way in when the predicted heat calls for it, and says so when it skips
  the burn.
- **Every one of them hits the ground at 115 to 190 m/s.** That is the speed the landing burn has
  to take out.

## Honest limits

- No stock rocket is built to come back yet. Build one as described above.
- The ascent assist always stages for a return to the Return Pad. There is no recovery plan to
  choose before launch yet: the barge is picked by hand after separation, and the assist does
  not stage later to use it. A stage that separates late and fast (the last four rows of the
  table) cannot reach either site; the program says so and comes down where it falls, which is
  usually the sea.
- The barge does not move, and there is one, in one place.
- The deck is a level rectangle to the physics. The four corner houses and the light masts on
  it are drawn only: a stage can pass through them. They stand outside the marked circle.
- A stage that comes down gently in the sea floats upright. A real one would fall over. The
  program reports it as lost to the sea either way.
- The return was tuned and measured on single-engine stages of the size above. Very different
  designs (many engines, very squat, no fins) are not covered by the measurements.
- The landing burn cannot move the stage sideways: leaning the engine is cancelled by the fins.
  All the steering is done on the way down, so a stage that arrives at the landing burn far off
  target stays off target. In the measured returns it arrived within 40 m and the final descent
  closed the rest.
- Wind does not exist in the game yet, so none of this is tested against it.
- Landing one pays nothing yet in career mode.
- The ascent assist and the booster return keep running when you hop away. The other programs
  stop when you leave their vessel, as before, because they use time warp.
- A program does not survive a quickload or leaving the flight screen: the vessels are restored
  where they were, both still flown, with their controls as they were left.
- There is no button yet to let a booster go so that you can warp at once. Fast warp comes back
  when the booster is down, which is a few minutes at most (`World.release` exists for the part
  to come).
- While you watch one vessel, loose debris near the other is not simulated.
- The delta-v read-out of the vessel you are not watching is refreshed when you come back to it.

## What was checked

- `tests/verify/checks_booster.mjs`, group 9g (12 checks) for the barge. The deck's place and
  size are measured without the game's own distance code: 40 km from the pad by the haversine
  formula, 80 by 50 m by walking outward in 1 cm steps until the ground stops being deck. A stage
  flown down onto the deck stands with its centre of mass 3.844 m above it, the same to 0.15 mm
  as the same flight ended on level ground. Ten returns from varied separations all land on the
  deck inside 10 m, 2 m/s and 3 degrees (worst: 3 cm from the middle).
- `tests/unit/barge.test.js` (8 tests): the Return Pad is level, dry, where the model draws it
  and clear of every building; the deck's outline, height and the water round it; a stage lands
  on the deck and stands; with its feet over the edge it tips off; beside the barge it is in the
  sea and the program says so; a booster on the deck is still there after a save and reload and
  after a day at high warp.
- `tests/e2e/booster_barge.mjs`, in a real browser (26 checks): launch, separation, "Land on the
  barge" from the Guidance panel, the landing on the deck, the map markers, the upper stage in orbit.
- `tests/verify/checks_booster.mjs`, groups 9d to 9f (20 checks). The reference integrator
  shares no code with the game. It has its own exponential atmosphere and its own drag curve, and
  the drag area it uses is measured from one step of the game's flight, not read from the game.
  Over a 63 km fall: impact point within 0.1% of the distance flown, time within 0.3 s, impact
  speed within 0.13%, peak dynamic pressure within 0.6%; the game's predictor lands 2.4 m from the
  reference. The landing burn on airless Pell stops within 0.03% of the distance the rocket
  equation gives, and the reference is itself checked against the closed form. Twelve varied
  returns flown by the game all land inside 10 m, 2 m/s, 3 degrees. A stage whose propellant is
  taken away before the landing burn is lost, and the program reports it.
- `tests/unit/booster_return.test.js` (7 tests): the predictor against the flight, a return from
  each kind of start, the entry burn when forced, what counts as a stage built to come back, and
  the whole mission.
- `tests/e2e/booster_return.mjs`, in a real browser through the real flight screen (22 checks):
  the assist stages early and says why, the return starts in the background, the hop key follows
  it, each step is called out, the booster stands by the pad and the upper stage is in orbit.
- Fins flying backwards: a booster falls tail first, which reverses what a fin deflection does.
  The control law now allows for it, but only when the attitude being held points away from the
  airflow (retrograde hold, or a guidance program pointing the tail into the wind). An aeroplane
  that slides backwards for a moment in a stall keeps its normal control sense: an earlier version
  of this change reversed it there, and the flight suite's hand-flown aeroplane crashed, which is
  how it was caught. All 16 stock designs flown for 400 s give the same digest as before.
- `tests/verify/checks_booster.mjs` (groups 9a to 9c, 15 checks): the separation shares out mass
  and momentum exactly; a booster 5 km from the vessel being flown, on a falling path over airless
  Pell, follows two-body motion from the independent reference to 5 micrometres over 100 s (the
  vessel being flown: 12 micrometres); the launch watched three ways differs by exactly zero.
- `tests/unit/boosters.test.js` (8 tests, one per requirement): followed beyond the load range,
  debris unchanged, the three-ways comparison, the warp hold and letting go, save and restore
  with a booster in flight, coming all the way down under physics, the limit of four, and a
  program flying and staging a vessel nobody is watching.
- `tests/tools/flight_digest.mjs`: 400 s of flight of all 16 stock designs, digest of every
  vessel's state and every event, before and after this change: identical.
- `tests/e2e/booster.mjs`, in a real browser through the real flight screen: launch with the
  ascent assist, separation, the hop key, the stages 14 km apart and both flying, the warp hold and
  its message, the hop back, and the upper stage reaching an 83 × 81 km orbit by itself.
- The folding leg: `tests/unit/folding_leg.test.js` (5 tests: the leg fits its box and its pad
  stands below the engine; folded it adds nothing below or beside and little drag; a return with
  the legs folded down to 60 m, then landed and standing on them with the engine clear; a whole
  flight from the pad that stages above 17 km and 600 m/s and is at rest within 8 s of touching) and verification
  group 9h (8 checks: the rigid swing worked from the part's dimensions, the legs fully out
  before first contact, the standing height from the dimensions to within 2 cm, no strut on its
  stop). `tests/e2e/booster_return.mjs` now flies the folding legs in a real browser: folded as
  the landing burn lights, out just before touchdown, standing afterwards.
- The whole verification passes: 1,338 checks, 0 failed. 478 unit tests pass.

## For developers

- `js/core/world.js`: `MAX_TRACKED`, `World.isTrackable(v)`, `world.tracked`,
  `world.trackedInFlight()`, `world.release(v, released = true)`, `world.stage(vessel = active)`.
  The tracked list is saved with the world.
- `js/core/vessel.js`: `vessel.released`, `vessel.program` (the name of the program flying it; a
  vessel with one stays tracked), both saved. A split-off piece with a command part and an engine
  is named "… booster".
- `js/core/autopilot.js`: `ascentProgram(world, { vessel })` flies a vessel that need not be the
  active one, and `autoStage` stages the vessel it was given.
- `js/core/booster.js`: `predictFall(body, pos, vel, mass, ut, opts)`, `boosterRecovery(world,
  vessel, { target })` (phases flip, boostback, coast, entry, landing, final; `miss`,
  `prediction`, `log`), `recoverableStage(vessel)`, `returnReserve(world, vessel, target)`.
  `ascentProgram(world, { recover: { target } })` stages at the reserve.
- `js/core/vessel.js`: `axialDragArea(tailFirst)`, `axialHeatRatio(flux, tailFirst)`, `machDrag`.
- `js/core/bodies.js`: `SYSTEM.home.sites.landing` (the Return Pad) and `.barge`; `BARGE` (where
  and how big); `Body.decks` and `Body.deckAt(dir)`, a level rectangle that is not part of the
  height field. `terrainAt` in `vessel.js` is what the physics asks, and it includes decks.
- `js/render/barge.js`: `createBarge()`. `js/render/basegfx.js`: `RETURN_PAD`, `buildReturnPad`.
  `js/ui/flightscene.js` places the barge; `js/ui/mapview.js` marks both sites.
- `js/ui/flight.js`: `parked` (programs flying vessels that are not being watched, ticked by
  `tickParked`), `family` (the vessels of this flight), `hopVessel()`, the key `hopVessel`
  (default `\`).
