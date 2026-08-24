# Snake River Salmon Run — Boids Visualization

A Three.js flocking simulation (Reynolds boids: separation, alignment,
cohesion) styled as a salmon run past Lower Granite Dam on the Snake River,
with a timeline scrubber driven by real daily passage counts fetched from
Columbia Basin Research DART.

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
across the bottom of the frame — identity, the day's counts, conditions at the
project, and the season chart, divided into fields by vertical hairlines —
which leaves the frame itself almost entirely clear. The chart shows daily
passage as an area and water temperature as a line, drawn on the timeline
scrubber's own x-axis so the cursor reads directly against both curves.

## Structure

Simulation (dimension-agnostic, no rendering):

- `src/boids.js` — the flocking engine (`Fish`, `Flock`). Physics is fully 2D
  (`x`, `y`); the renderer reinterprets those as `worldX`/`worldZ` at the
  render boundary. Both neighbor searches (flocking forces, overlap
  resolution) run through a spatial grid, not an all-pairs scan.
- `src/data.js` — real Lower Granite daily adult passage counts fetched live
  from DART at module load, with a bell-curve placeholder run as an offline
  fallback. Four species drive the simulation (Chinook, Jack Chinook,
  Steelhead, Shad); the rest of the feed is parsed and reported in the HUD
  without being simulated — wild steelhead (a *subset* of the steelhead count,
  not an addition to it), sockeye, coho, jack coho, Pacific lamprey, water
  temperature, and the scheduled Chinook run for the date. Columns are read by
  header name and the non-essential ones tolerate being absent, since DART's
  column set has changed between years.
- `src/main.js` — orchestration: scene wiring, the timeline/population logic,
  the rAF loop.

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

Assets:

- `public/steelhead-final.glb` — the only model currently loaded. All four
  species point at it (see `SPECIES_MODEL_URL`) and are told apart by a flat
  per-instance tint; give a species its own URL and it gets its own
  `InstancedMesh` with no other change. A new model needs its own
  `MODEL_ROTATION_FIX` entry — see the note there on why the right correction
  depends on where the source file put its compensating rotation.

## Running locally

```
npm install
npm run dev
```

Then open the printed `localhost` URL. `npm run build` / `npm run preview`
produce and serve a production build.

There is no test suite. `scripts/screenshot.mjs` drives the running dev server
in headless Chromium and captures a frame, failing on any console error — which
is the only automatic signal for a GLSL compile failure, since a broken shader
doesn't throw, it just stops drawing one surface:

```
node scripts/screenshot.mjs out.png --day 250
```

## Controls

- **Play/Pause** and the timeline slider drive the date. While playing, each
  day gets `FRAMES_PER_DAY` frames (240 — about four seconds) and the HUD's
  figures count toward the next day's across that span rather than snapping at
  the boundary.
- **D** toggles a camera debug readout — the way to read off a new
  `EYE_FRAC`/`TARGET_FRAC` by eye if the framing ever needs re-tuning.

## Next steps

1. **Per-species models** — all four species currently share
   `steelhead-final.glb`. Each new mesh needs to be authored against the same
   vertex budget and swim rig, then pointed at in `SPECIES_MODEL_URL`.
2. **Revisit the population cap** — this used to read "a fish LOD", on the
   basis that the cap was bounded by vertex cost at ~1300 vertices per fish.
   That figure was wrong: `steelhead-final.glb` holds **435** vertices (654
   triangles), so the flock costs roughly a quarter of what was assumed, and it
   is not the frame's most expensive item — the caustics pass and the water
   simulation each cost considerably more (see `src/quality.js`). The cap is
   really a fill-rate and CPU-simulation limit, and it now scales by device
   tier. Worth re-measuring what the high tier can actually carry before
   building an LOD for a cost that is not the bottleneck.
3. **Tune the "feel"** — the `Flock` options in `src/main.js`
   (`perceptionRadius`, `separationRadius`, `maxSpeed`) and the framing
   constants in `src/scene/sceneSetup.js`.
