# Snake River Salmon Run — Boids Visualization

A Three.js flocking simulation (Reynolds boids: separation, alignment,
cohesion) styled as a salmon run past Lower Granite Dam on the Snake River,
with a timeline scrubber driven by real daily passage counts fetched from
Columbia Basin Research DART.

The shot is a fixed underwater camera in the water column: the school sweeps
left-to-right past it, the lit surface sits overhead, and a caustic-lit gravel
riverbed sits below. Everything — sky, sun, fog, water color, riverbed,
caustics — shifts with the date on the timeline, so scrubbing through the year
reads as the seasons passing.

## Structure

Simulation (dimension-agnostic, no rendering):

- `src/boids.js` — the flocking engine (`Fish`, `Flock`). Physics is fully 2D
  (`x`, `y`); the renderer reinterprets those as `worldX`/`worldZ` at the
  render boundary. Both neighbor searches (flocking forces, overlap
  resolution) run through a spatial grid, not an all-pairs scan.
- `src/data.js` — real Lower Granite daily adult passage counts (Chinook, Jack
  Chinook, Steelhead, Shad) fetched live from DART at module load, with a
  bell-curve placeholder run as an offline fallback.
- `src/main.js` — orchestration: scene wiring, the timeline/population logic,
  the rAF loop.

Rendering (`src/scene/`):

- `sceneSetup.js` — renderer, the fixed camera framing, the sky sphere (an
  underwater view with Snell's-window murk, not a literal sky), and the
  bloom/tone-mapping composer chain. No THREE lights: every material here is a
  hand-written `ShaderMaterial`, so lighting arrives as uniforms.
- `season.js` — maps a date to a blended seasonal palette. Only three colors
  per season are hand-picked; every underwater color is derived from them.
- `fog.js` — the shared fog color/density, plus the same falloff as GLSL,
  since custom `ShaderMaterial`s don't get `scene.fog` for free.
- `terrain.js` — the flat riverbed: a plane whose fragment shader synthesizes
  two Voronoi layers of cobble and gravel, lit per-stone and catching the
  caustics.
- `water.js` — the water surface plane: fresnel-shaded from the live sim's
  height field, with a caustic glint and an edge fade into the fog.
- `waterSim.js` — GPU height-field water simulation (ping-pong render targets),
  ported from martinRenou/threejs-caustics.
- `causticsGenerator.js` — the real-time caustics pass: an environment map of
  the riverbed plus a refraction ray-march, also ported from the same source.
  Its output texture is what terrain, water, and fish all read.
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

- **Play/Pause** and the timeline slider drive the date.
- **D** toggles a camera debug readout — the way to read off a new
  `EYE_FRAC`/`TARGET_FRAC` by eye if the framing ever needs re-tuning.

## Next steps

1. **Per-species models** — all four species currently share
   `steelhead-final.glb`. Each new mesh needs to be authored against the same
   vertex budget and swim rig, then pointed at in `SPECIES_MODEL_URL`.
2. **A fish LOD** — `MAX_POPULATION` (1200) is bounded by vertex cost, not by
   the flocking sim. Most fish on screen are fogged past legibility; a cheaper
   vertex path for those is what would raise the ceiling.
3. **Tune the "feel"** — the `Flock` options in `src/main.js`
   (`perceptionRadius`, `separationRadius`, `maxSpeed`) and the framing
   constants in `src/scene/sceneSetup.js`.
