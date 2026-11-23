# Reusable boosters

Roadmap item 5: fly the first stage back and land it on its legs while the upper stage carries on
to orbit. It is being built in three parts. **This page describes the first part, which is in the
game:** a dropped stage that can still be flown keeps flying, under full physics, however far it
is from the vessel you are watching. Guidance that lands it, somewhere to land it, and pay for
landing it come next.

## What you can do now

1. In the assembly building, put a guidance ring (a Wisp, Mote or Facet probe core, or a Beacon
   or Keystone guidance ring) on the first stage, below the separator. Anything with a guidance
   ring or a crew aboard can be flown.
2. Launch and stage as usual. The dropped stage is now called a **booster** and the game tells
   you it is flying on its own.
3. Press **\\** to hop to it, and **\\** again to hop back. **[** and **]** still step through
   every vessel, and now reach a booster at any distance.
4. Fly it down by hand: it has whatever engines, propellant, fins and legs you gave it.
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

What this says about the parts still to build:

- **A stage meant to come back has to let go early.** The first four rows separate below 40 km
  and under 1,600 m/s, within 55 km of the pad. Those can turn round. The last three burn almost
  to orbit and come down 600 to 800 km away: no boostback burn reaches the pad from there.
- **An entry burn is real work on the fast ones and not needed on the slow ones.** The slow
  stages peak at 530 to 870 on parts rated 1,400 and up. The fast ones run parts to their limit.
  Guidance will burn on the way in when the predicted heat or air load calls for it, and say so
  when it skips the burn.
- **Every one of them hits the ground at 115 to 190 m/s.** That is the speed the landing burn has
  to take out.

## Honest limits of this part

- Nothing lands itself yet. The booster is yours to fly by hand, and an unguided one crashes.
- No stock rocket carries a guidance ring on its first stage yet. Add one in the assembly building.
- Only the ascent assist keeps running when you hop away. The other programs stop when you leave
  their vessel, as before, because they use time warp.
- A program does not survive a quickload or leaving the flight screen: the vessels are restored
  where they were, both still flown, with their controls as they were left.
- There is no button yet to let a booster go so that you can warp at once. Fast warp comes back
  when the booster is down, which is a few minutes at most (`World.release` exists for the part
  to come).
- While you watch one vessel, loose debris near the other is not simulated.
- The delta-v read-out of the vessel you are not watching is refreshed when you come back to it.

## What was checked

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
- The whole verification passes: 1,287 checks, 0 failed. 454 unit tests pass.

## For developers

- `js/core/world.js`: `MAX_TRACKED`, `World.isTrackable(v)`, `world.tracked`,
  `world.trackedInFlight()`, `world.release(v, released = true)`, `world.stage(vessel = active)`.
  The tracked list is saved with the world.
- `js/core/vessel.js`: `vessel.released`, `vessel.program` (the name of the program flying it; a
  vessel with one stays tracked), both saved. A split-off piece with a command part and an engine
  is named "… booster".
- `js/core/autopilot.js`: `ascentProgram(world, { vessel })` flies a vessel that need not be the
  active one, and `autoStage` stages the vessel it was given.
- `js/ui/flight.js`: `parked` (programs flying vessels that are not being watched, ticked by
  `tickParked`), `family` (the vessels of this flight), `hopVessel()`, the key `hopVessel`
  (default `\`).
