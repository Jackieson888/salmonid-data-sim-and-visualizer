# Snake River Salmon Run — Boids Visualization

A Three.js flocking simulation (Reynolds boids: separation, alignment,
cohesion) styled as a Chinook salmon run through the Snake River, with a
timeline scrubber driven by real daily passage counts. Fish are the real
`SALMON.OBJ` model, swum via a per-vertex shader spine bend and rendered
as a single `InstancedMesh`; terrain, water, and camera framing all
leverage 3D depth to read as a diorama rather than a flat map.

## Structure

- `index.html` — page shell + HUD (title, play/pause, timeline slider)
- `style.css` — HUD styling (unchanged from the 2D version — it's an
  absolutely-positioned overlay on top of whichever canvas is under it)
- `src/boids.js` — the flocking engine (`Fish`, `Flock` classes) and the
  shared bank/island curves. Physics stays fully 2D (`x, y`); the 3D
  renderer reinterprets those as `worldX`/`worldZ` at the render boundary
  (see `src/main.js`) rather than the simulation itself going 3D.
- `src/data.js` — **placeholder** run-timing data (bell-curve shaped)
- `src/main.js` — orchestration: scene wiring, the timeline/population
  logic (ported unchanged from the old Canvas2D version), the rAF loop
- `src/scene/sceneSetup.js` — renderer, camera, lights, resize, and the
  slow autonomous camera drift around a fixed hero angle
- `src/scene/terrain.js` — turns `bankTopY`/`bankBottomY`/`islandSpace`
  into an elevation mesh (vertex-colored, beach-sloped shoreline) plus
  the island's vegetation speckles
- `src/scene/water.js` — the water plane: a ported version of the old
  procedural caustic-texture generator, scrolled via a custom shader,
  plus the per-pod "lens ripple" glow (see `src/scene/pods.js`)
- `src/scene/fishMesh.js` — loads `SALMON.OBJ`, merges its body/eye/mouth
  groups into one geometry, and drives the swim animation + instancing
- `src/scene/waterSim.js` — GPU height-field water simulation (ping-pong
  render targets) that the caustics pass and water surface both read from
- `src/scene/caustics.js` — the two-pass caustics pipeline (terrain depth
  map + refracted ray-march) that lights the riverbed and water surface
- `src/scene/pods.js` — bridges `boids.js`'s CPU-side fish clustering into
  the ripple sources the water shader reads
- `public/salmon.obj` / `public/salmon-skin.png` — runtime copies of the
  Wavefront model and its texture (TIFF converted to PNG since browsers
  can't decode it)

## Running locally

```
npm install
npm run dev
```

Then open the printed `localhost` URL. `npm run build` / `npm run
preview` produce and serve a production build.

## Next steps

1. **Swap in real data** — Replace `src/data.js` with actual Lower
   Granite Dam daily counts from DART:
   https://www.cbr.washington.edu/dart/query/adult_daily
   Export CSV for a season, parse into `{ date, count }[]`, keep the same
   export shape (`runData`) so `main.js` doesn't need to change.

2. **Tune the "feel"** — the values worth playing with live in `Flock`
   options in `src/boids.js` (`perceptionRadius`, `separationWeight`,
   `alignmentWeight`, `cohesionWeight`, `maxSpeed`), plus the camera
   framing/drift constants in `src/scene/sceneSetup.js` and the swim-bend
   constants in `src/scene/fishMesh.js`.

3. **Further visual polish** — water Fresnel/transmission for a more
   "wet" read from the angled camera, per-instance fish color variance,
   a proper eye texture (currently a flat dark color, since only the body
   texture was available).

4. **Performance** — verified ~60fps at ~300-400 fish (real GPU, not
   headless software rendering) via `InstancedMesh`. The boids neighbor
   search is still O(n²) (same as the original), fine up to roughly
   1000-1500 fish — the `InstancedMesh` cap in `fishMesh.js` matches that.

5. **Capture the hero clip** — once tuned, screen-record ~8-10 seconds
   around the run's peak for the LinkedIn post.
