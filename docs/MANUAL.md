# Starwright player's manual

The reference for everything on the keyboard and every screen. New here? Start with the
[README](../README.md) for how to install the game and fly a first orbit, then come back.

Contents: [Controls](#controls-mac-keyboard--logitech-mx-mouse) ·
[A first flight](#a-first-flight) ·
[Targeting, rendezvous and docking](#targeting-rendezvous-and-docking) ·
[Career, contracts and Flight School](#career-contracts-and-flight-school) ·
[Demo tour](#demo-tour)

The key names are for a Mac keyboard. On Windows and Linux, `Cmd` is `Ctrl`.

## Controls (Mac keyboard + Logitech MX mouse)

### Flight
| Keys | Action |
|---|---|
| W / S | Pitch down / up |
| A / D | Yaw left / right |
| Q / E | Roll left / right |
| Shift / Ctrl (or ↑ / ↓) | Throttle up / down |
| Z / X | Full throttle / cut throttle |
| Space | Launch / fire next stage |
| T | SAS (stability assist) on/off |
| R | RCS thrusters on/off |
| H / N, I / K, J / L | RCS translate forward/back, up/down, left/right |
| G | Landing legs |
| U | Solar panels |
| M | Map view (click your orbit to plan a maneuver) |
| O | Missions: the next flight-program mission and your active contracts, with live progress |
| . / , | Time warp faster / slower |
| / | Stop time warp |
| V | Camera mode |
| C | Speed readout: surface / orbit / relative to the target (when one is set) |
| Y | Target the nearest vessel; press again for the next one |
| Shift+Y | Clear the target |
| [ / ] | Switch to a nearby vessel |
| F5 or Shift+K | Quicksave |
| F9 or Shift+L | Quickload |
| Esc | Pause menu (revert, recover, return to Flight Center) |

### Mouse
| Input | Action |
|---|---|
| Scroll wheel | Zoom |
| Right-drag | Orbit the camera |
| Middle-drag | Pan (hangar) / offset view |
| Double-click | Centre / reset view |

### Flight screen buttons
The bar at the top right has **Map**, **Missions**, **Crew** (spacewalks), **Science** (run and transmit
experiments), **Target** (list of vessels and worlds), **Dock** (Latch Rings, docking assist,
undocking), **Fuel** (pump between tanks), **Ascent assist** and **Menu**. Dock and Fuel only appear
on vessels that can use them. Messages at the top of the screen queue up: two show at a time.

### Assembly Hangar
Click a part in the catalogue, then click on the rocket to attach it. `X` cycles symmetry
(Shift+X backwards), `Delete` removes the part under the mouse, `Esc` drops the held part,
`Cmd+Z` / `Shift+Cmd+Z` undo and redo.

## A first flight

1. New Game → Sandbox (everything unlocked) or Career.
2. Flight Center → Launch Pad → pick the stock craft **Skylark II**.
3. SAS is already on (the `T` key toggles it). Press `Z` (full throttle), then `Space` (ignite).
4. At about 1 km start tipping east with `D`; aim for roughly 45° by 10 km and nearly flat by 40 km.
5. Press `Space` when the first stage runs dry. Open the map with `M` and keep burning until the
   apoapsis is about 80 km, then cut with `X`.
6. In the map, click your orbit near the apoapsis to add a maneuver node, drag the prograde handle
   until the periapsis is above 72 km, then burn at the node. You are in orbit.

## Landing on legs

Press G to let the legs down before you land. Each leg is a spring and a damper with a fixed
amount of travel, and how fast you touch down decides what happens:

| Touchdown speed | Lander Strut (32 cm of travel) |
| --- | --- |
| up to about 4 m/s | A clean landing. |
| about 5 to 6 m/s | The legs run out of travel. A hard jolt and a warning, nothing breaks. |
| about 7 m/s and up | The legs collapse. |

The Stilt Heavy Leg has 55 cm of travel and takes 2 to 3 m/s more; the Sprig has 18 cm and less
margin. Land level and slow across the ground: a lander leaning past the line of its feet, or
arriving sideways, goes over. A wide stance and a low centre of mass stand steeper.

Once you are standing on the ground with the throttle closed, the attitude hold (T) lets go so
the craft can settle onto all its feet. Your own stick input still works. The full description
of the model is in [LANDING_LEGS.md](LANDING_LEGS.md).

## Targeting, rendezvous and docking

Two stock craft are made for this: **Latch Target** (an uncrewed station core) and **Latch
Chaser** (a crewed ship with RCS thrusters). Both carry a **Latch Ring S** on the nose. Launch the
target into orbit first, return to the Flight Center (the flight is kept), then launch the chaser.

**Pick a target.** Press `Y` for the nearest vessel, open **Target** for a list of vessels and
worlds, or click a vessel or world in the map and choose *Set as target*. `Shift+Y` or the `×` on
the read-out clears it. A target that is destroyed or burns up is dropped for you.

**Read-outs.** With a target set, a card above the altitude panel shows its name, the distance,
the relative speed (`▸◂` closing, `◂▸` opening) and the closest approach on your present orbit.
The ball gains two orchid markers: a bracketed dot for the target and three spokes for the
direction directly away from it. Press `C` until the speed chip says **Target** to read your speed
relative to the target; the prograde and retrograde markers then show your drift relative to it.

**SAS target modes.** Four small buttons under the SAS / RCS lights: point at the target, point
away from it, point along your drift relative to it, and point against that drift. The last one
is the useful one: hold it and burn until the relative speed reads zero and you are parked beside
the target.

**Getting close.** In the map, plan a burn that brings the *closest approach* marker down to a
few hundred metres (lower orbits go round faster, so a lower orbit catches up and a higher one
falls back). At the closest approach, point against the drift and burn to stop. Flight School has
a lesson on it: *Rendezvous basics*.

**Docking.** Rings of the same size (S with S, M with M) latch by themselves when they touch nose
to nose, roughly aligned, slower than 1.5 m/s. By hand: turn on RCS (`R`), point at the target,
and close the last metres with `H` / `N` (forward / back) and `I` `K` `J` `L` (slide). Or open
**Dock** and press **Engage** on *Docking assist* once you are within 1.5 km and drifting slowly
relative to the target: the guidance computer lines up the rings and flies the approach on
monopropellant. Any steering or translation key hands control back to you.

Docked vessels are one vessel: one set of controls, shared stages, and engines can draw from tanks
on both sides. **Dock → Undock** releases a module; the two drift apart at 0.3 m/s and each keeps
its own name and crew.

### Fuel transfer

Open **Fuel** on any vessel with at least two tanks that hold the same thing (it does not have to
be docked). Choose *Propellant*, *Monoprop* or *Charge*, pick the tank to take **From** and the
tank to pump **Into** (each is labelled with the vessel it arrived with), then:

- type an amount and press **Transfer** (leave it empty for as much as fits),
- **All** pumps until the source is empty or the destination is full,
- **Balance** brings both tanks to the same fill level,
- `⇅` swaps the two tanks.

Solid fuel and heat-shield ablator cannot be pumped.

## Career, contracts and Flight School

- **Game modes.** *Career* has funds, science and reputation; *Science* drops the budget;
  *Sandbox* unlocks everything.
- **Science and research.** Run experiments from the Science button in flight. Recover the vessel
  to bank results in full, or transmit them with an antenna for half. Spend science in the
  Research Lab to unlock tech nodes and their parts. If a stock craft in the launch dialog needs
  parts you do not have yet, the dialog names the tech nodes to research.
- **Interface size.** Settings has an *Interface size* row (Auto, or 80 % to 175 %). Auto leaves the interface as it
  is up to a 1600 x 900 window and enlarges it on bigger ones (160 % at 2560 x 1440), so text stays readable on a
  large display. The 3D picture is not affected.
- **Missions.** *Missions* on the title menu opens Mission Control (or explains missions and starts a career if
  you have none). Two kinds of mission live there:
  - **The flight program**: 71 missions in a fixed order, so there is always a next goal: first launch, 10 km,
    space, an orbit of Verda, a crewed return, a spacewalk, then Pell and Ost (fly by, orbit, land, come back) and
    after them every other world of the Helion system. Nothing to sign and no deadline: fly it and it counts. It is
    tracked in every game mode; a career is paid funds, science and reputation for each one.
  - **Contracts** (career only), described next.
  In flight, the **Missions** button (or `O`) lists the next program mission and your active contracts, each
  objective with a tick and a live read-out (altitude against the target, the orbit and what is wrong with it,
  seconds held, time left on the deadline).
- **Contracts (Mission Board).** The board keeps three to five offers, growing with reputation,
  and you can hold three to five at once. Accepting pays an advance (a quarter of the fee);
  finishing every objective pays the rest plus science and reputation; missing the deadline or
  cancelling costs funds and reputation. Jobs include reaching an altitude with a Pip aboard,
  test-firing a part inside an altitude and speed window, delivering an experiment result from a
  named place, planting a flag, holding a given orbit, deploying a relay satellite, flying by or
  landing on another world, tourist round trips, and recovering a well-travelled vessel. Offers
  only ask for things your unlocked parts can do. In flight, a toast tells you when an objective
  or a contract is completed (or failed).
- **Crew.** Pips gain experience and stars from recovered flights; starred pilots, engineers and
  scientists improve recovery payouts and science.
- **Flight School** (its own building at the Flight Center, also on the title menu): eight short
  illustrated lessons — *Your first hop*, *How orbits work*, *Reaching orbit, step by step*,
  *Maneuver nodes*, *Getting to Pell*, *Landing on an airless moon*, *Re-entry and parachutes* and
  *Rendezvous basics* — most with a **Try it** button that puts the right stock craft on the pad,
  plus a controls reference, a delta-v card for the whole Helion system and a glossary.
- **Saves.** The game saves when you leave a screen. In flight, `F5` quicksaves and `F9` loads.
  If a flight in progress can no longer be loaded, the message that says so has a **Discard it**
  button; new launches keep working either way.

## Demo tour

Starwright can show itself off. **Demo tour** on the title screen (also in the Flight Center menu)
starts a self-running, captioned tour of the real game: the space centre from day to night, a
rocket built part by part, launch and staging, the gravity turn to orbit, a maneuver node and the
transfer to the moon Pell, a landing with EVA, flag and science, re-entry and splashdown, a
spaceplane take-off, a rover on Rusk, a docking, the tracking station, the nineteen-body Helion
system, and research, contracts and crew. It takes about six minutes, runs on a throw-away
program and never touches your save.

- Start it directly with <http://localhost:8642/?demo=1>; add `&clean=1` to hide the control strip
  and the mouse cursor for a recording, or `&chapter=<id>` to start at one chapter.
- `Space` pauses, `←` `→` change chapter, `Esc` leaves.
- [docs/DEMO.md](docs/DEMO.md) has the chapter list and step-by-step instructions for recording
  the tour as a video on a Mac.
