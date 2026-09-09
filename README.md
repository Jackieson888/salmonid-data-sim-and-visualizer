# Salmonid Data Sim & Visualizer

A Three.js boids simulation of a salmon run passing Lower Granite Dam on the
Snake River, driven by real daily fish-passage counts from Columbia Basin
Research DART. A fixed underwater camera watches the school swim by while
the water, light, and riverbed shift with the date on the timeline — scrub
through a season and watch it turn from spring runoff to summer haze to fall
light.

Eight species are tracked (Chinook, Jack Chinook, steelhead, shad, Pacific
lamprey, sockeye, coho, jack coho); five of them actually swim in the scene,
all eight are counted in the HUD, which is styled like a fish-passage report
rather than a game overlay.

There's also a fish viewer (`inspect.html`) — one species up close, with
labeled anatomy and its own passage stats.

## Running locally

```
npm install
npm run dev
```

Open the printed `localhost` URL. `npm run build` / `npm run preview`
produce and serve a production build.

## Controls

- **Play/Pause** and the timeline slider drive the date; **Space** toggles
  play from anywhere.
- **Speed** (½×–8×) controls playback rate.
- **Peak** jumps to the season's heaviest passage day.
- **Season** picker swaps between the ten counting seasons on record
  (2006–2015); `?year=2011` boots straight into one.
- **←/→** step a day, **Home/End** jump to the ends of the season, **-/=**
  change speed.
- **P** (or the corner button) opens the data plates drawer — passage vs.
  the ten-year average, species composition, river conditions, run history,
  and lamprey day/night split.
- **D** toggles a camera debug readout, for re-tuning the framing.

## Structure

- `src/boids.js`, `src/data.js`, `src/main.js` — the simulation and data
  layer, no rendering.
- `src/scene/` — everything Three.js: camera/renderer setup, water and
  caustics, terrain, fish meshes, particles, shared shader code.
- `src/plates.js`, `src/inspect.js` — the data-plates drawer and the fish
  viewer page.
- `public/` — vendored DART CSV/JSON snapshots and the fish GLB models.

Each source file has a short header comment, and the design rationale,
gotchas, and "why not the obvious thing" reasoning for each module lives in
`.claude/context/` — start there before making non-trivial changes.

## Testing

There's no test suite. `scripts/screenshot.mjs` drives the running dev
server with Playwright and fails on any console error, which is the only
way to catch a GLSL shader that silently stops drawing:

```
node scripts/screenshot.mjs out.png --day 250
node scripts/screenshot.mjs out.png --day 250 --burst 6   # frames over time
node scripts/screenshot.mjs out.png --url http://localhost:5173/inspect.html
```

Run it **headed** (the default) — headless Chromium throttles
`requestAnimationFrame` so a headless capture never actually settles.
`--headless` is for CI only.

## Credits

Fish models: `steelhead-final.glb`, `chinook-final.glb`, `shad-final.glb`,
`lamprey-final.glb`, each a single skinned mesh with a swim clip built via
`scripts/swim_rig.py`. Passage data: Columbia Basin Research DART, vendored
into `public/` as static CSV/JSON.
