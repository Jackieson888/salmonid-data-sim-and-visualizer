# Salmonid Data Sim & Visualizer

A Three.js flocking simulation (Reynolds boids: separation, alignment,
cohesion) of real fish passage data from the Snake River at Lower Granite
Dam, with a timeline scrubber driven by real daily passage counts published
by Columbia Basin Research DART. Eight species are tracked — Chinook, Jack
Chinook, steelhead, shad, Pacific lamprey, sockeye, coho, and jack coho —
five of which drive the flocking simulation itself, styled as the run
passing the dam.

The shot is a fixed underwater camera in the water column: the school sweeps
left-to-right past it, the lit surface sits overhead, and the riverbed falls
away into the murk below. Sunlight comes down through the surface as shafts,
silt drifts past in the water column, and everything — sky, sun, fog, water
color, riverbed, caustics — shifts with the date on the timeline, so scrubbing
through the year reads as the seasons passing.

The sun also moves within the day. That is not decoration: the caustics pass
refracts the sun direction and marches it down to the bed, so moving the sun
slides the whole light net, and the shafts, the surface glints and the glow on
the fish sweep with it off a single uniform.

The HUD is styled as a fish-passage report rather than a consumer overlay,
since the numbers in it are real published daily counts. It is a single bar
across the bottom of the frame — identity and the season control, the day's
counts for all eight species DART tallies at this project, conditions
(temperature, outflow, spill, dissolved gas), where the run stands against the
ten-year average, and the season chart with its transport — divided into
fields by vertical hairlines, which leaves the frame itself almost entirely
clear. The chart shows daily passage as an area and water temperature as a
line, drawn on the timeline scrubber's own x-axis so the cursor reads directly
against both curves.

## Structure

Simulation (dimension-agnostic, no rendering):

- `src/boids.js` — the flocking engine (`Fish`, `Flock`). Physics is fully 2D
  (`x`, `y`); the renderer reinterprets those as `worldX`/`worldZ` at the
  render boundary. Both neighbor searches (flocking forces, overlap
  resolution) run through a spatial grid, not an all-pairs scan.
- `src/dart/parseAdultDaily.js` — the DART adult-daily CSV parser, pure and
  dependency-free (no fetch, no browser globals) so both the browser boot
  path (`src/data.js`) and the Node build script (`scripts/fetch-dart.mjs`)
  share one implementation instead of drifting apart. Reads columns by header
  name, not fixed index, since DART's column set has changed between years —
  the lamprey day/night split is the documented case.
- `src/data.js` — real Lower Granite daily adult passage counts for any of
  the ten counting seasons 2006-2015, each vendored into the repo
  (`public/lwg-adult-daily-{year}.csv`, retrieved 2026-08-24) and loaded on
  demand by `loadYear()`. Every year offered is a fixed historical one, so
  there is nothing to be fresh about; a live DART query is kept behind `?live`
  for a year outside the vendored range. There is no synthetic fallback — the
  HUD presents these as a federal measurement record, so failing visibly beats
  substituting invented numbers under that masthead. Five species drive the
  simulation (Chinook,
  Jack Chinook, Steelhead, Shad, Pacific Lamprey); the rest of the feed is
  parsed and reported in the HUD without being simulated — wild steelhead (a
  *subset* of the count, not an addition to it), sockeye, coho, jack coho,
  water temperature, and the scheduled Chinook run for the date. Columns are
  read by header name and the non-essential ones tolerate being absent, since
  DART's column set has changed between years.

  Also exports `loadRiverConditions()`/`loadRunHistory()` — lazy, memoized
  fetches of the river-environment and ten-year history files the plates
  drawer reads (see below). Unlike `runData` these are off the boot-critical
  path: nothing about the flock, the spawn mix or the timeline depends on
  either one, so a failure in either degrades one plate rather than the
  river.
- `src/seasonScale.js` — the one date → x-position mapping in the app.
  Everything that draws against the season's x-axis (the bar's own chart and
  month axis in `main.js`, every season-x figure in `plates.js`) computes
  through this so a given record index always lands at the same x fraction —
  otherwise the timeline's cursor would read against one curve and lie about
  the rest.
- `src/main.js` — orchestration: scene wiring, the timeline/population logic,
  the rAF loop.
- `src/plates.js` — the slide-in drawer of data plates (open with the corner
  button or **P**): season passage against a ten-year daily mean, species
  composition (all eight DART counts, not just the five simulated), the
  wild/hatchery steelhead split, river conditions (outflow/spill plus a
  water-temp-vs-Chinook scatter), the ten-year run history (season totals by
  year and a day-of-year min/max envelope with the season on screen traced
  through it), and
  lamprey day-vs-night passage. Built lazily on first open rather than at
  boot.

Rendering (`src/scene/`):

- `sceneSetup.js` — renderer, the fixed camera framing, the sky sphere (an
  underwater view with Snell's-window murk, not a literal sky), and the
  bloom/tone-mapping composer chain. No THREE lights: every material here is a
  hand-written `ShaderMaterial`, so lighting arrives as uniforms.
- `season.js` — maps a date to a blended seasonal palette. Only three colors
  per season are hand-picked; every underwater color is derived from them and
  pulled toward the river's own green. Also owns the sun, including the daily
  arc it sweeps along.
- `fog.js` — the shared fog color/density, plus the same falloff as GLSL,
  since custom `ShaderMaterial`s don't get `scene.fog` for free.
- `terrain.js` — the riverbed: two triangles, a color, and a fog falloff. It
  draws no caustics itself but stays in the caustics environment pass as the
  surface the refracted rays terminate against.
- `water.js` — the water surface plane: fresnel-shaded from the live sim's
  height field, with a caustic glint and an edge fade into the fog.
- `waterSim.js` — GPU height-field water simulation (ping-pong render targets),
  ported from martinRenou/threejs-caustics.
- `causticsGenerator.js` — the real-time caustics pass: an environment map of
  the riverbed plus a refraction ray-march, also ported from the same source.
  Its output texture is what the water surface, the fish, the shafts and the
  silt all read.
- `godRays.js` — shafts of sunlight, as additive vertical quads whose every
  fragment traces back up the sun direction to its entry point on the surface
  and samples the caustics net there. Derived from the same texture as
  everything else rather than from independent noise, which is what keeps a
  shaft under the bright knot it belongs to.
- `particles.js` — suspended silt. Entirely GPU-driven: drift and wrap happen
  in the vertex shader, so the per-frame CPU cost is one uniform write no
  matter how many motes there are.
- `glsl.js` — shared GLSL: the caustics read (4-tap for surfaces, 1-tap for
  the fish vertex shader), the soft-saturation curve, the plane edge fade, and
  water-normal reconstruction.
- `fishMesh.js` — loads each species' GLB, bakes its skinned swim clip into a
  Vertex Animation Texture at load time, and draws the flock as one
  `InstancedMesh` per distinct model. Tailbeat rate is derived from each fish's
  actual speed via a stride length, not a per-species frequency table.
- `fishAnatomy.js` — hand-authored anatomy anchors for the fish viewer's
  labeled plate (see "Fish viewer" below). The GLBs carry no anatomical
  structure to key off — one mesh, one material, a bare 16-bone spine — so
  each part is a target point in the model's own local space (nose-tail
  fraction, lateral fraction, vertical fraction), snapped to the nearest real
  vertex. Salmonids, shad and lamprey each get a genuinely different part
  list: shad is a clupeid (no adipose fin, has ventral scutes instead) and
  lamprey is a jawless fish (no jaws, no paired fins, no gill cover — an oral
  disc, a single nostril, gill pores, two dorsal fins).

Assets:

- `public/steelhead-final.glb`, `chinook-final.glb`, `shad-final.glb`,
  `lamprey-final.glb` — four authored models, one per species, each a single
  skinned mesh plus a loop-closed `"Swimming"` clip against a shared 16-bone
  spine (the first three built by `scripts/swim_rig.py`). Jack Chinook has no
  model of its own and borrows the chinook (it is the same species at a
  smaller, earlier-maturing size, not a different body shape), told apart by
  a flat per-instance tint — see `SPECIES_MODEL_URL`. Give it its own URL and
  it gets its own `InstancedMesh` with no other change. A new model needs a
  `MODEL_ROTATION_FIX` entry: see the note there on why the right correction
  depends on where the source file put its compensating rotation — the
  lamprey model needed the opposite quarter-turn from the other three despite
  sharing their rig convention, because its root bone sits at the nose end of
  the body instead of the tail end.

  Each model also carries its own material tuning (`MATERIAL_OVERRIDES` in
  `fishMesh.js`). The four skins are painted to very different keys — the
  chinook is near-white silver, the shad already has its iridescence painted
  in, the lamprey is scaleless and wants almost none of the procedural
  scale-bump the others do — and every shader term here is a modifier on
  finished art rather than a light rig on a blank body. `inspect.html` used
  to expose this tuning as live sliders; it's a labeled species viewer now
  (see "Fish viewer" below), so re-tuning a material means editing
  `MATERIAL_OVERRIDES` directly rather than dragging a slider — the old rig
  is still in git history if it's ever needed again.
- `public/lwg-adult-daily-{2006..2015}.csv` — the passage-count snapshots
  (see `src/data.js`), byte-for-byte as DART served them, footnotes and
  citation included. The 2015 file is frozen at its retrieval date on purpose
  and `scripts/fetch-dart.mjs` copies rather than re-fetches it, so the
  archive can never drift from what the boot path serves.
- `public/lwg-river-2015.csv`, `public/lwg-history-2006-2015.json` — the
  plates drawer's other two data sources: 2015 river conditions (outflow,
  spill, pivoted to wide from DART's long-format export; the other nine
  seasons have no river file yet and degrade to "unavailable") and ten years
  of season totals plus a day-of-year envelope, both derived by
  `scripts/fetch-dart.mjs`. The raw per-year CSVs it derives them from
  archive under `data/dart/` (not `public/` — they don't ship, they just keep
  the derivation auditable without a network trip).
- `public/og-image.png` — the social card, a real capture of the running
  scene. Regenerate with `scripts/screenshot.mjs` rather than hand-making one,
  so the preview cannot drift from what the page looks like.

## Running locally

```
npm install
npm run dev
```

Then open the printed `localhost` URL. `npm run build` / `npm run preview`
produce and serve a production build.

There is no test suite. `scripts/screenshot.mjs` drives the running dev server
and captures a frame, failing on any console error — which is the only
automatic signal for a GLSL compile failure, since a broken shader doesn't
throw, it just stops drawing one surface:

```
node scripts/screenshot.mjs out.png --day 250
node scripts/screenshot.mjs out.png --day 250 --burst 6   # frames over time
node scripts/screenshot.mjs out.png --url http://localhost:5173/inspect.html
```

It runs **headed** by default, which is not a preference: headless Chromium
decides the page isn't visible and throttles `requestAnimationFrame` to about
1Hz, so the settle window buys about nine simulation frames rather than nine
seconds' worth, and captures are of a scene that never filled in. `--headless`
is kept for CI, where a still of an unsettled scene is still enough to catch a
shader that has stopped drawing. `--burst N` writes N frames spread across the
settle window, which is how you catch the defects that only exist in motion —
a fish popping at the cull band, a tailbeat desyncing from travel.

## Controls

- **Play/Pause** and the timeline slider drive the date. While playing, each
  day gets `framesPerDay` frames (240 at 1× — about four seconds) and the
  HUD's figures count toward the next day's across that span rather than
  snapping at the boundary.
- **Speed** (½×–8×) divides that budget. A counting season is ~300 days, so 1×
  is a twenty-minute watch and 8× is about two and a half minutes.
  `POPULATION_CORRECTION_GAIN` scales with it — the gain is per-frame, so at 30
  frames a day the school otherwise chases a target that has already moved on
  and visibly lags the readout beside it.
- **Peak** jumps to the season's heaviest day, the one thing dragging and
  stepping can't find for you.
- **Season** (the select in the masthead) swaps any of the ten counting
  seasons 2006–2015 in place, rebuilding the chart, the month axis, the day
  tables and every plate. `?year=2011` boots straight into one.
- **Month ticks** under the timeline are click targets — each jumps to the
  first counted day of that month. They are thinned by measurement when they
  would collide, since two overlapping labels means one of them jumps to the
  wrong month.
- **Space** toggles play/pause from anywhere on the page; **←/→** step a day
  and hold; **Home/End** go to the ends of the season; **-/=** change speed.
  Under `prefers-reduced-motion: reduce` the scene boots held rather than
  running — the river is fully composed on the first frame, it just is not
  advancing until you start it.
- **D** toggles a camera debug readout — the way to read off a new
  `EYE_FRAC`/`TARGET_FRAC` by eye if the framing ever needs re-tuning.
- **P**, or the corner button, opens/closes the plates drawer
  (`src/plates.js`); **Escape** closes it.

### Multi-year

`runData` and `runYear` are live bindings that `loadYear()` reassigns
(`src/data.js`), so the swap itself costs nothing — but live bindings notify
nobody. Anything DERIVED from a season rebuilds through one hook per module:
`rebuildForYear()` in `main.js` and `rebuildPlatesForYear()` in `plates.js`.
Seasons run 290–306 days, so **nothing may cache `runData.length` across a
switch** — that is what the typed arrays and `plates.js`'s `LAST` are about.

River conditions (outflow, spill, dissolved gas) are vendored for 2015 only;
the other nine degrade to "unavailable" rather than failing. `parseRiverConditionsCsv`
validates its header for exactly that reason — a dev server answers a request
for a file it lacks with `index.html` and HTTP 200, so a parser that trusted
the response would turn a page of HTML into a long list of well-formed rows
holding nothing, and present it as gauge readings.

## Fish viewer

`inspect.html` loads one fish up close on an orbiting camera. The panel is
sectioned: a species list (the whole roster readable at rest, keyed with each
fish's own water tint, binomials visible rather than behind a click), the view
toggles and reset-view, adult length for all five on one scale, and this
species' own season at the dam — a sparkline sharing `seasonScale.js`'s x-axis
and √ scale with the river's chart and every plate, plus share of the counted
run, peak day, first/last, and the middle-80% window. Per-species extras where
DART has them: wild fraction for steelhead, night share for lamprey, run split
for Chinook. All of it reads off the same `runData` the river uses.

The turntable is **off** by default. It reads well as a demo and badly as a
plate — a rotating fish means every anatomy label is chasing an anchor that
never stops moving.

The anatomy labels track a swimming, turning fish rather than a frozen
specimen: the overlay replicates the vertex shader's swim-bend sampling on
the CPU each frame (same baked Vertex Animation Texture, same frame
interpolation) and reads back the instance's real transform via
`meshForSpecies()` on the object `createFishInstancedMesh` returns, rather
than approximating either. A part's leader line only runs the near/far-side
facing test if it's a genuinely paired lateral feature (eye, pectoral fin,
...) — a midline fin is a thin sheet whose face normal points sideways even
though its position doesn't, so testing it the same way blinked whole fins
out for half of every rotation.

### Why the labels hold still

The anchors travel through a tailbeat whether or not the camera moves, so a
layout recomputed from scratch each frame moves each frame. Four things fix
that, and the first is worth more than the rest together:

1. **The layout runs against the REST vertex** under the same instance
   transform, while the leader's endpoint keeps using the animated one. The
   line still points exactly at the feature; the label no longer rides the
   stroke. Smoothing the animated anchor instead was tried and is strictly
   worse — a filter slow enough to flatten a lamprey's tail sweep also lags a
   camera move.
2. **Fixed gutters**, so label x does not move at all.
3. **A vertical fan** (`LABEL_VERTICAL_SPREAD`), so leaders arrive steeply from
   above and below instead of lying flat across the body. Pushing the columns
   further out is the wrong lever: it clears the labels by making every leader
   longer and flatter.
4. **Column hysteresis** and a settle pass that pushes back up as well as down.

Measured over 90 frames, worst-case label movement is 0.08–0.20 px/frame
across all five species, with no column flips.

## Next steps

1. **Caustics coverage** — the largest efficiency win still on the table, and
   the riskiest change in the renderer. The pass covers
   `waterWorldSize(bounds)`: `waterSizeMultiplier` 2.4 on both axes, i.e. 5.76x
   the bounds area. But `applyFog` saturates at
   `1 - exp(-(density·dist)²)` with `density = 3.6 / max(w, h)`, so at
   `density·dist = 2.0` a surface is 98.2% fog and any *added* caustic light is
   2% visible. Useful radius is about `0.55·span` — roughly a 62% area
   reduction, taking high-tier segments from 256 to ~160 and the vertex count
   from ~65k to ~25k at constant world-space density.

   The crux is that the caustics texture's UV space is currently *identical*
   to the water sim's, because both derive from `waterWorldSize()`. Splitting
   them is the change: a new `causticsWorldSize()`, both UVs computed
   separately in `water.js` (it currently computes one and uses it for both),
   every reader's `uWorldSize`/`uMargin` repointed, and a UV edge fade added
   inside `causticGlowAt` in `glsl.js` so all five consumers inherit it from
   one place. Without that fade, sampling outside the new coverage clamps to
   the edge texel and smears the boundary net across the plane.

   Verify by A/B-ing `--brighten` captures at several days, watching
   specifically for a hard line where the coverage ends.
2. **Revisit the population cap** — this used to read "a fish LOD", on the
   basis that the cap was bounded by vertex cost at ~1300 vertices per fish.
   That figure was wrong: the models hold 435–560 vertices each, so the flock
   costs roughly a quarter of what was assumed, and it is not the frame's most
   expensive item — the caustics pass and the water simulation each cost
   considerably more (see `src/quality.js`). The cap is really a fill-rate and
   CPU-simulation limit, and it now scales by device tier. Worth re-measuring
   what the high tier can actually carry before building an LOD for a cost
   that is not the bottleneck.
3. **Tune the "feel"** — the `Flock` options in `src/main.js`
   (`perceptionRadius`, `separationRadius`, `maxSpeed`) and the framing
   constants in `src/scene/sceneSetup.js`. Note that `separationRadius` must
   stay below `perceptionRadius`, or the spatial grid silently truncates it.
