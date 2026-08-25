# AGENTS.md

This repo (salmonid-data-sim-and-visualizer) is a static Three.js visualization of real Snake River fish passage data at Lower Granite Dam — eight tracked species, not just salmon. Treat [README.md](README.md) as the user-facing overview and [CLAUDE.md](CLAUDE.md) as the agent-facing source of truth for non-trivial edits.

## Project quick facts

- App type: static Vite app, no backend
- Main entry points: [index.html](index.html) and [inspect.html](inspect.html)
- Data sources: vendored DART CSV/JSON files under [public/](public/) and [data/dart/](data/dart/)
- Core logic: [src/main.js](src/main.js), [src/data.js](src/data.js), [src/boids.js](src/boids.js), [src/seasonScale.js](src/seasonScale.js)

## Before editing

- Read the matching context doc in [.claude/context/](.claude/context/) before changing a non-trivial source file.
- Keep data-flow rules intact: boid physics stays 2D in [src/boids.js](src/boids.js); the render layer reinterprets that as 3D at the scene boundary.
- Use [src/seasonScale.js](src/seasonScale.js) for all season/x-axis mapping. Do not mix ad hoc date-to-x logic across the app.
- Preserve the split between simulated and reported species; five species drive flocking, and other counted species remain reported-only.
- Do not add synthetic data fallbacks to the DART path.

## Commands

```bash
npm install
npm run dev
npm run build
npm run preview
```

There is no automated test suite. For visual validation, use the screenshot harness:

```bash
node scripts/screenshot.mjs out.png --day 250
node scripts/screenshot.mjs out.png --day 250 --burst 6
node scripts/screenshot.mjs out.png --url http://localhost:5173/inspect.html
```

The project intentionally runs the screenshot tool in headed mode by default because headless Chromium under-throttles animation and can hide real shader/runtime issues.

## Architecture notes

- [src/main.js](src/main.js) orchestrates the river scene, timeline loop, and population logic.
- [src/inspect.js](src/inspect.js) handles the single-fish viewer and anatomy overlays.
- [src/plates.js](src/plates.js) builds the slide-in analysis drawer; keep it lazy and data-driven.
- [src/data.js](src/data.js) loads DART data on demand by year and is responsible for the historical year switching logic.
- [src/seasonScale.js](src/seasonScale.js) is the single canonical mapping from date to x-position everywhere the HUD/chart timeline is rendered.

## Common pitfalls

- Multi-year switches are live-binding reassignment; rebuild the derived seasonal state when the year changes.
- Season lengths vary (roughly 290–306 days), so never cache length assumptions across a year switch.
- A shader compile failure often appears as a silent no-draw rather than an exception, so screenshot-based verification matters.
- Live DART query behavior is intentionally separate from the vendored historical data path; do not silently invent values when files are missing.

## Useful references

- [README.md](README.md)
- [CLAUDE.md](CLAUDE.md)
- [scripts/screenshot.mjs](scripts/screenshot.mjs)
- [.claude/context/](.claude/context/)
