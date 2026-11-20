# The demo tour

Starwright has a self-running tour of itself, made to be recorded as a video. It is not a slide
show: it drives the real screens with real state. The rocket is assembled in the real editor, the
flights are flown by the game's own guidance programs on the real physics, and the maps, the
tracking station and the management screens are the ones a player uses. Captions explain what is
on screen.

The tour runs on a throw-away space program in memory. Your saved game, quicksave and settings are
not read into it and are never written while it runs; when it ends you are back where you started.

## Run it

1. Start the game as usual (double-click `start.command`, or `python3 serve.py 8642` in the
   project folder) and open <http://localhost:8642/> in Chrome.
2. Click **Demo tour** on the title screen. (Inside a game: the menu button in the Flight Center,
   then **Demo tour**.)

Or open the tour directly from the address bar:

| Address | What it does |
| --- | --- |
| `http://localhost:8642/?demo=1` | starts the tour as soon as the page has loaded |
| `…/?demo=1&clean=1` | the same, with no control strip and no mouse cursor: use this for recording |
| `…/?demo=1&chapter=landing` | starts at one chapter (ids in the table below) and carries on from there |
| `…/?demo=1&pointer=0` | hides the scripted pointer in the assembly chapters |
| `…/?demo=1&seed=7` | another random seed (the default, 20260, gives the same tour every time) |

More switches exist for checking and filming the tour:

| Switch | What it does |
| --- | --- |
| `&watch=1` | turns on the per-frame monitor (see "Check a run" below) |
| `&fast=1` | runs everything eight times quicker (the automated test) |
| `&hq=1&poster=1` | what the preview script uses to take its pictures |
| `&step=1/60` | fixed step: every frame advances the tour and the game by exactly that much, whatever the real frame rate (filming on a slow renderer; `&step=0.1` is a machine that draws ten frames a second) |
| `&film=2` | with `&step`: stops every 2 s of tour time until `__sw.app.demo.resume()` is called (the filmstrip script) |
| `&draw=N` | draws only every Nth frame (every frame is still simulated) |
| `&fail=<id>` | makes that chapter fail on purpose, to see what the tour does next |

### Check a run

Open `http://localhost:8642/?demo=1&clean=1&watch=1` and let the tour run to its end (just under
six minutes; keep the tab in front). The tour never stops for a problem. While it runs, every drawn
frame is checked for what a viewer would notice:

- the flight camera under the ground (`camera-low`) or the ship under it (`ship-underground`),
- the ship out of the picture for more than 0.4 s (`out-of-picture`),
- a jump of the picture with no cut (`jump`),
- a ship near the ground in the dark (`dark`),
- ground that is still loading when a scene is shown (`ground-loading`, or `ground-late` when the
  longest wait behind the black of a cut was not enough),
- a caption that left before it could be read (`caption-pace`), a chapter that failed (`failed`),
  used a stand-in (`fallback`) or had a time-lapse cut short (`lapse-cut`).

Each chapter prints one line in the console when it ends, `[demo] report {…}`, and the whole result
is in `window.__demoReport`:

```
{ chapters: [{ id, tourSeconds, wallSeconds, ok, status, fallback, groundWaitSeconds,
               problems: [{ t, kind, detail }], captions: [{ text, words, seconds }] }],
  total: { tourSeconds, wallSeconds, chapters, ok, problems, ended } }
```

`t` is seconds into the chapter. `tourSeconds` is the tour's own clock (it stops when the tour is
paused and never counts more than a tenth of a second for one frame), `wallSeconds` is real time: on a
machine that keeps up they agree. To have the report judged by the test suite, type
`copy(JSON.stringify(__demoReport))` in the console, paste it into a file and run
`DEMO_REPORT=that-file.json node tests/e2e/demo.mjs`.

### Controls while it runs

| Key | Action |
| --- | --- |
| `Space` (or `P`) | pause and resume; flights, cameras and captions all freeze |
| `→` | next chapter |
| `←` | restart this chapter, or go to the previous one in its first few seconds |
| `Esc` | leave the tour |

Move the mouse and a small control strip with the same actions appears at the top right; it hides
again after a couple of seconds. In clean mode there is no strip and no cursor; the keys still work.
All other keys and the mouse are kept away from the game while the tour runs, so you cannot knock a
flight off course by accident.

## Chapters

The whole tour takes about five minutes and forty seconds on a machine that draws it smoothly. Times
are approximate: flights wait for what actually happens (booster separation, touchdown, the docking
latch) rather than for a stopwatch, and each cut to a flight holds the black until the ground of the
new scene has loaded (a fraction of a second on a fast machine).

| # | id | Chapter | What you see | About |
| --- | --- | --- | --- | --- |
| 1 | `title` | Starwright | the title screen | 0:07 |
| 2 | `centre` | The space centre | a fly-around of the Flight Center, name plates on the hangar and the pad, day turning to night with the lights coming on | 0:19 |
| 3 | `build` | Vehicle Assembly Building | the Ember Twin built part by part: floating root part, glowing attachment nodes, mirrored boosters and fins, then the staging stack and delta-v read-outs | 0:33 |
| 4 | `launch` | Launch | the rocket you just saw built on the pad (seen from above the deck, instruments off), lift-off, booster separation | 0:22 |
| 5 | `orbit` | To orbit | gravity turn (time-lapse), coast under time warp with the Missions panel open, circularisation, a HUD-free beauty shot | 0:25 |
| 6 | `map` | Map and maneuvers | the map view, a maneuver node for the transfer to Pell, warp to the node, the burn, warp to the encounter | 0:40 |
| 7 | `landing` | Landing on Pell | a Moonstep lander's powered descent and touchdown | 0:23 |
| 8 | `eva` | EVA, flag and science | a Pip climbs out, walks, plants a flag and takes a surface sample | 0:15 |
| 9 | `reentry` | Coming home | re-entry plasma, then (after a cut) parachute and a daylight splashdown off the space centre | 0:32 |
| 10 | `plane` | Spaceplane hangar | the Kite Trainer in the hangar with its balance markers, then a runway take-off | 0:24 |
| 11 | `rover` | Rover on Rusk | a Trundle Scout driving over the dunes of another planet | 0:17 |
| 12 | `docking` | Docking | a Latch Chaser closing on a station core and docking | 0:17 |
| 13 | `tracking` | Tracking station | eight flights in progress around six worlds | 0:10 |
| 14 | `system` | The Helion system | the whole system, then close-ups of Sear, ringed Orrin, the ice moon Brim and the comet Wend | 0:25 |
| 15 | `program` | Running a program | the research tree (a node is bought), Mission Control (a contract is accepted), the Crew Quarters, the Scenarios picker | 0:25 |
| 16 | `closing` | Starwright | closing card | 0:09 |

Where real time would be dull the tour says so on screen: an amber **Time-lapse ×N** badge means the
same physics is being stepped faster, **Time warp** means the game's own warp is running. Where the
story jumps (from the Pell flyby to a lander already descending, from the plasma to the parachute)
there is a clear cut through black with a chapter card.

If a chapter cannot do its job (a screen is missing, a flight does not arrive in time) it is skipped
or falls back to a prepared state, and the tour goes on. Time limits count the tour's own clock, not
real time, so a slow machine cannot fail a chapter. A stand-in is always a scene that fits the story
(after a failed launch, the next chapter opens on the rocket already climbing, not on the pad again). Open the browser console to see what
happened: lines starting `[demo]`. `__sw.app.demo.state()` in the console gives the status of every
chapter.

## Record it on a Mac

You need nothing but macOS and Chrome. Plan for two or three takes.

### Set up

1. **Quit what you do not need** (mail, chat, other browser windows) and plug the Mac in. The game
   wants the graphics card to itself for a smooth 60 frames a second.
2. **Turn on Do Not Disturb**: Control Centre (top right of the menu bar) → Focus → Do Not Disturb,
   so no notification slides into the picture.
3. **Start the game**: double-click `start.command` and leave its Terminal window open.
4. **Open a clean Chrome window**: File → New Window, and open
   `http://localhost:8642/` once so the game is loaded and cached. Leave it on the title screen.
5. **Make the picture exactly 1920×1080.** Pick one:
   - *Full screen (simplest).* If your display is 1920×1080, or you set it to that in
     System Settings → Displays, press `Ctrl-Cmd-F` to make Chrome full screen. Then in the View
     menu untick **Always Show Toolbar in Full Screen** so only the game is visible.
   - *A window of exactly that size.* Open Chrome's developer tools (`Opt-Cmd-I`), click the
     device toolbar button (`Shift-Cmd-M`), choose **Responsive** and type `1920` × `1080`, zoom
     100%. Undock the developer tools into their own window (the ⋮ menu in the tools → dock side →
     separate window) and move them out of the way. The page area is now exactly 1920×1080; in
     step 7 you record just that area.
6. **Decide about sound.** The simplest video is silent, with music added afterwards. Started
   from the address bar the tour makes no sound at all, because browsers only allow a page to
   play audio after a click inside it. (Started with the **Demo tour** button it plays the game's
   own engine and effect sounds, but the screen recorder captures the microphone, not the Mac's
   sound, unless you install a loopback audio driver and choose it as the microphone in step 7.)

### Record

7. Press `Shift-Cmd-5`. The screenshot toolbar appears at the bottom of the screen.
   - Click **Record Entire Screen** (if you went full screen) or **Record Selected Portion** and
     drag the frame to fit the 1920×1080 page area.
   - Click **Options**: choose where to save (Desktop is fine), set **Timer** to *None*, and untick
     **Show Mouse Clicks**. Under *Microphone* choose *None* (or the loopback device).
8. Type this address into Chrome but do not press Return yet:
   `http://localhost:8642/?demo=1&clean=1`
9. Click **Record** in the toolbar, then click in the Chrome window and press `Return`. The tour
   starts by itself once the page has loaded. Keep your hands off the mouse and keyboard: in clean
   mode the cursor is hidden while it is over the page.
10. The tour ends by fading to black and returning to the title screen, a little over six
    minutes later. Stop the recording: click the stop button in the menu bar (a circle with a
    square), or press `Ctrl-Cmd-Esc`.
11. The video opens as a thumbnail at the bottom right and is saved as a `.mov` where you chose.

(QuickTime Player does the same job: File → New Screen Recording opens the same toolbar.)

### Tidy up

12. Open the `.mov` in QuickTime Player. Edit → Trim (`Cmd-T`) and drag the yellow handles to cut
    the second or two of page loading at the start and the title screen at the end. Save.
13. For the web, export a smaller file: File → Export As → 1080p. GitHub accepts videos up to
    100 MB in a README; a six-minute 1080p export is usually near that, so either trim, export at
    720p, or upload the video elsewhere and link to it.
14. **Put it in the README.** On GitHub, edit `README.md`, and drag the video file into the editor
    under the *Demo tour* heading (there is a comment marking the place). GitHub uploads it and
    inserts a link that plays inline. Commit the change.

### If a take goes wrong

- **A chapter looked wrong.** Re-record just that one: `…/?demo=1&clean=1&chapter=<id>` starts
  there. Press `Esc` after the chapter, and cut the pieces together in iMovie or QuickTime
  (Edit → Add Clip to End).
- **Stutter.** Close other apps and tabs, make sure the Mac is on mains power, and try a smaller
  window (1600×900). The tour paces its flights on game time, so a slow machine shows shorter
  time-lapses rather than a frozen picture, but the camera moves only look smooth at a steady
  frame rate.
- **You bumped the keyboard.** `Space` pauses and resumes; arrow keys jump chapters. If the control
  strip showed up in a normal run, use `&clean=1`.
- **The same every time?** Yes. The tour seeds its random numbers and starts every cut scene from a
  fixed state, so two takes match shot for shot apart from small timing differences in the flights.

## For developers

| File | Role |
| --- | --- |
| `js/ui/demo.js` | the director: sandbox program, overlay, keys, the tour clock, waits and tweens, the flight hook (`world.step` wrapper for the guidance programs and time-lapse), `app.demo` |
| `js/ui/demo/chapters.js` | the sixteen chapters, each `{ id, title, sub, limit, run(d) }` |
| `js/ui/demo/scenes.js` | the prepared scenes the cuts start from (pure simulation, no DOM) |
| `js/ui/demo/kit.js` | pure helpers: seeded random numbers, easing, orbit and landing spawners |
| `css/demo.css` | captions, chapter cards, progress bar, pointer, control strip |
| `tests/unit/demo.test.js` | flies every prepared scene with the guidance programs, without a browser (part of `npm test`) |
| `tests/e2e/demo.mjs` | runs the whole tour accelerated in headless Chromium: every chapter must start, caption and finish, with no page errors and the stored game untouched; a chapter made to fail must not send the next one back to the pad; a lying wall clock must not fail a chapter. With `REAL_GPU=1` (a real Chrome window on a machine with a GPU) it also runs the tour in order at real speed and judges `window.__demoReport`; `DEMO_REPORT=file.json` judges a saved report without a browser |
| `tests/e2e/demo_film.mjs` | a filmstrip: the tour in order at full quality in fixed step, one picture every 2 s of tour time into `tests/out/film/<tag>/` (slow on a software renderer: the whole tour takes about an hour) |
| `tests/e2e/demo_probe.mjs` | what is on screen as numbers (chapter, caption, camera height above the ground, where the ship is in the picture), used by the filmstrip |
| `tests/e2e/preview_demo.mjs` | one full-quality 1920×1080 picture per chapter into `tests/out/demo-*.png` |

Hooks in files the tour does not own: `js/main.js` installs it (`installDemo(app)`), honours
`?demo=1`, and its frame loop obeys `app.fixedStep` and `app.drawEvery` (set by `&step` and `&draw`); `js/ui/hub.js` has the **Demo tour** entries on the title screen and in the Flight
Center menu. Everything else goes through hooks the screens already expose for the test suites
(`app.builder`, `app.flight`, the hub's `debug.view`, the map's `focus` / `setView`).

Adding a chapter: append an object to `CHAPTERS` in `js/ui/demo/chapters.js`. Use `d.cut()` for the
scene change (it holds the black until the flight scene's ground has loaded, eight seconds at most),
`d.caption()` for the lower third (a fifth of a second a word, two seconds at least), `d.untilSim()` / `d.until()` for waits (always with
a limit), `d.fallback()` when a stand-in was used, and `d.poster()` at the frame the preview script
should capture. Feature-check any hook that might not exist and let the chapter throw if it cannot
do its job: the director logs it and moves on.
