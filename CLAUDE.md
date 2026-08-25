# Salmonid Data Sim & Visualizer — agent guide

A Three.js boids flocking simulation styled as a salmon run past Lower
Granite Dam on the Snake River, driven by real daily passage counts from
Columbia Basin Research DART. Two entry points share one data layer:
`index.html` (`src/main.js`) is the river scene; `inspect.html`
(`src/inspect.js`) is a single-fish viewer with anatomy labels. There is no
backend — everything is a static build reading vendored CSV/JSON from
`public/`.

## Before editing a file

Every source file's own header comment is now a one-liner. The design
rationale, invariants, historical gotchas, and "why not the obvious thing"
reasoning that used to live in block comments now live in a matching doc
under `.claude/context/`, so the source file itself stays cheap to read and
you only pay for the module(s) you're actually touching. Read the linked
doc before a non-trivial change; skip it for a genuinely mechanical fix
(renaming, formatting, a one-line constant tweak).

If you extend a file, extend its context doc too — don't let new rationale
drift back into a growing comment block.

| Source | Context doc | Covers |
|---|---|---|
| `src/boids.js` | `.claude/context/boids.md` | Flocking engine, spatial grid, 2D physics contract |
| `src/data.js`, `src/dart/parseAdultDaily.js`, `src/seasonScale.js` | `.claude/context/data.md` | DART loading/parsing, multi-year rebuild, the season↔x mapping |
| `src/main.js` | `.claude/context/main.md` | Orchestration, timeline/population loop, boot/context-loss lifecycle |
| `src/inspect.js` | `.claude/context/inspect.md` | Fish viewer page (species list, turntable, sparkline, anatomy overlay) |
| `src/plates.js` | `.claude/context/plates.md` | Slide-in data plates drawer |
| `src/drawer.js` | `.claude/context/drawer.md` | Shared slide-in drawer mechanics (`#plates`, `#inspect-panel`) |
| `src/insights.js` | `.claude/context/insights.md` | Shared insight toast and its `.info-btn` triggers (used from `main.js`, `plates.js`, `inspect.js`) |
| `src/quality.js` | `.claude/context/quality.md` | Quality tiers, perf governor |
| `src/scene/fishMesh.js` | `.claude/context/scene/fishMesh.md` | GLB loading, VAT baking, instancing, per-model rotation fixups, material tuning |
| `src/scene/fishAnatomy.js` | `.claude/context/scene/fishAnatomy.md` | Hand-authored anatomy anchors for the fish viewer's labeled plate |
| `src/scene/sceneSetup.js` | `.claude/context/scene/sceneSetup.md` | Renderer, fixed camera framing, sky sphere, bloom/tone-mapping composer |
| `src/scene/season.js` | `.claude/context/scene/season.md` | Seasonal palette derivation, sun position and daily arc |
| `src/scene/terrain.js`, `src/scene/fog.js`, `src/scene/godRays.js`, `src/scene/particles.js` | `.claude/context/scene/environment.md` | Riverbed, fog falloff, light shafts, suspended silt |
| `src/scene/water.js`, `src/scene/waterSim.js`, `src/scene/causticsGenerator.js` | `.claude/context/scene/water-and-caustics.md` | GPU height-field sim, water surface shading, real-time caustics |
| `src/scene/glsl.js` | `.claude/context/scene/glsl.md` | Shared GLSL chunks (caustics read, soft-saturation, edge fade, water normals) |
| `style.css`, `inspect.css`, `index.html`, `inspect.html` | `.claude/context/ui.md` | Corps-of-Engineers/PNW visual language, HUD/panel structure |

## Rules that hold everywhere

- Boid physics is fully 2D (`x`, `y`). Only the render boundary
  (`fishMesh.js`) reinterprets those as `worldX`/`worldZ` — don't let 3D
  concerns leak back into `boids.js`.
- `src/seasonScale.js` is the **only** date→x-position mapping in the app.
  Anything that draws against the season's x-axis (the HUD chart, the month
  axis, every plate) must compute through it, or the timeline cursor will
  read against one curve and lie about the rest.
- Multi-year switches are live-binding reassignment (`loadYear()` in
  `data.js`), which notifies nobody. Anything derived from a season rebuilds
  through `rebuildForYear()` (`main.js`) or `rebuildPlatesForYear()`
  (`plates.js`). Seasons run 290–306 days — never cache `runData.length`
  across a switch.
- Five species drive the simulation (`SIMULATED_COUNT_KEYS` in `main.js`):
  Chinook, Jack Chinook, Steelhead, Shad, Pacific Lamprey. Three more are
  counted and reported but never swum (`REPORTED_COUNT_KEYS`: sockeye, coho,
  jack coho) — keep that split; don't fold them into one map.
- No synthetic data fallback anywhere in the DART data path — the HUD
  presents these as a federal measurement record, so a missing file should
  fail visibly, not substitute invented numbers.
- No test suite. `scripts/screenshot.mjs` is the only automated signal for a
  broken GLSL shader (a compile failure doesn't throw, it just stops
  drawing). Run it non-headless for real settle time — see `README.md`.

## See also

- `README.md` — human-facing project overview, controls, and asset
  provenance (kept in prose; not a substitute for the context docs above,
  which are written for an agent mid-task rather than a first-time reader).
