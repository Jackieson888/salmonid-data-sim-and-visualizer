# Snake River Salmon Run — Boids Visualization

A canvas-based flocking simulation (Reynolds boids: separation, alignment,
cohesion) styled as a Chinook salmon run through the Snake River, with a
timeline scrubber driven by real daily passage counts.

## Structure

- `index.html` — page shell + HUD (title, play/pause, timeline slider)
- `style.css` — river scene + HUD styling
- `boids.js` — the flocking engine (`Fish`, `Flock` classes)
- `main.js` — canvas setup, rendering, animation loop, HUD wiring
- `data.js` — **placeholder** run-timing data (bell-curve shaped)

## Running locally

No build step yet — it's plain ES modules. Serve the folder with any
static server, e.g.:

```
npx serve .
```

(Opening `index.html` directly via `file://` will fail due to ES module
CORS restrictions — needs an actual HTTP server.)

## Next steps

1. **Swap in real data** — Replace `data.js` with actual Lower Granite
   Dam daily counts from DART:
   https://www.cbr.washington.edu/dart/query/adult_daily
   Export CSV for a season, parse into `{ date, count }[]`, keep the same
   export shape (`runData`) so `main.js` doesn't need to change.

2. **Tune the "feel"** — the values worth playing with live in
   `Flock` options in `boids.js`: `perceptionRadius`, `separationWeight`,
   `alignmentWeight`, `cohesionWeight`, `maxSpeed`. Small changes here
   have a big visual impact — this is most of the "craft" of the project.

3. **Visual polish** — current version is a basic gradient background +
   flat fish shapes. Consider: subtle current/caustic shader effect,
   motion trails (draw a low-alpha rect instead of clearing each frame),
   depth-of-field via size/opacity variance, a dam or riverbend silhouette
   for spatial framing.

4. **Performance check** — current neighbor search is O(n²), fine up to
   roughly 1000-1500 fish. If pushing higher, add a spatial grid to
   `Flock.step()` to bucket neighbor lookups.

5. **Capture the hero clip** — once tuned, screen-record ~8-10 seconds
   around the run's peak for the LinkedIn post.
