import { Flock } from "./boids.js";
import { runData } from "./data.js";
import { createSceneSetup } from "./scene/sceneSetup.js";
import {
  buildTerrainMesh,
  setTerrainCausticsTexture,
  setTerrainSeason,
  riverDepth,
} from "./scene/terrain.js";
import { buildWaterMesh, waterWorldSize } from "./scene/water.js";
import { createWaterSimulation } from "./scene/waterSim.js";
import {
  createCausticsGenerator,
  CAUSTICS_TARGET_SIZE,
} from "./scene/causticsGenerator.js";
import { loadFishAssets, createFishInstancedMesh } from "./scene/fishMesh.js";
import { dayOfYear } from "./scene/season.js";
import { setFogSeason } from "./scene/fog.js";

const canvas = document.getElementById("river-canvas");

const dateLabel = document.getElementById("date-label");
const playPauseBtn = document.getElementById("play-pause");
const timelineInput = document.getElementById("timeline");
const fishCountLabel = document.getElementById("fish-count");
const speciesCountEls = {
  chinook: document.getElementById("count-chinook"),
  jackChinook: document.getElementById("count-jackChinook"),
  steelhead: document.getElementById("count-steelhead"),
  shad: document.getElementById("count-shad"),
};
const fishLoadingEl = document.getElementById("fish-loading");

// Drives the HUD's fish counts from the real per-day DART numbers (see
// data.js) rather than flock.activeCount() — the simulated/rendered boid
// count is capped well below these for performance (see MAX_POPULATION
// below), so it's not what a viewer wants to read as "how many fish passed
// today." Falls back to 0 for a day with no species breakdown at all (see
// generatePlaceholderRun() in data.js).
function updateFishCountDisplay(idx) {
  const day = runData[idx];
  fishCountLabel.textContent = `${(day.count ?? 0).toLocaleString()} fish`;
  for (const key of Object.keys(speciesCountEls)) {
    speciesCountEls[key].textContent = (day[key] ?? 0).toLocaleString();
  }
}

// ---------------------------------------------------------------------
// Scene: bounds map 1:1 onto world units — worldX = fish.x (downstream),
// worldZ = fish.y (across-river), worldY is a cosmetic-only "up" the 2D
// simulation never sees. See scene/*.js for the render-side details.
// ---------------------------------------------------------------------
let bounds = { width: window.innerWidth, height: window.innerHeight };

const sceneSetup = createSceneSetup(canvas, bounds);
const { renderer, scene, camera, cameraTarget, setSeason } = sceneSetup;
const renderScene = sceneSetup.render;

// ---------------------------------------------------------------------
// Camera debug readout — toggle with "D". The camera is fixed now (see
// sceneSetup.js), so these numbers no longer change frame to frame; they're
// still the way to read off a new EYE_FRAC/TARGET_FRAC by eye if the
// framing ever needs re-tuning.
// ---------------------------------------------------------------------
const debugPanel = document.getElementById("debug-panel");
window.addEventListener("keydown", (e) => {
  if (e.key.toLowerCase() !== "d" || e.target.tagName === "INPUT") return;
  debugPanel.hidden = !debugPanel.hidden;
});

// ---------------------------------------------------------------------
// Water simulation (see scene/waterSim.js, ported from
// martinRenou/threejs-caustics). The water sim's own [-1, 1] space is
// square regardless of world aspect ratio, so ripple radii get corrected
// by worldAspect to stay circular. The terrain, water surface, and fish all
// read their caustic glow off a separate texture (see
// scene/causticsGenerator.js, also ported from martinRenou/threejs-caustics)
// that this sim's height field feeds into every frame.
// ---------------------------------------------------------------------
const WATER_SIM_SIZE = 600;

// The sim actually covers a bigger area than the river bounds (see
// waterWorldSize()/WATER_SIZE_MULTIPLIER in water.js) so ripples can
// propagate all the way out to the water plane's faded edges instead of
// the edge texel just clamping/stretching across that whole margin.
let waterSize = waterWorldSize(bounds);

// Converts a world-space (x, z) position into the water sim's normalized
// [-1, 1] uv space, used whenever we need to drop a ripple at a world
// point. Shifted by the sim's margin since it's centered on bounds rather
// than corner-anchored at world (0, 0) — see waterWorldSize().
function worldToSim(x, z) {
  return {
    x: ((x + waterSize.marginX) / waterSize.width) * 2 - 1,
    z: ((z + waterSize.marginZ) / waterSize.height) * 2 - 1,
  };
}

let terrainMesh = buildTerrainMesh(bounds, CAUSTICS_TARGET_SIZE);
scene.add(terrainMesh);

// Depth range fish swim within: a little below the surface down to just
// above the riverbed floor. See boids.js's fish.depth and fishMesh.js.
let depthRange = { surfaceY: -8, floorY: -riverDepth(bounds) + 6 };

let waterSim = createWaterSimulation(
  renderer,
  WATER_SIM_SIZE,
  waterSize.height / waterSize.width,
);

// Real-time caustics (see scene/causticsGenerator.js, ported from
// martinRenou/threejs-caustics) — recomputed every frame from the water
// sim's live height field, terrain/water/fish all sample its output
// texture for their caustic glow (see scene/causticsChunk.js) instead of
// reading the water sim texture directly.
let causticsGenerator = createCausticsGenerator(renderer, bounds, terrainMesh);

let water = buildWaterMesh(bounds, CAUSTICS_TARGET_SIZE);
scene.add(water.mesh);

// Tracks the day-of-year last passed to setSeason/water.setSeason, so
// resize() can re-apply it after rebuilding `water` from scratch (a fresh
// buildWaterMesh() call otherwise resets its sky-reflection tint to a
// pre-season default — see water.js).
let currentDayOfYear = 0;

// Drives the sky/sun (sceneSetup.js), the distance fog every surface fades
// into (fog.js), the water surface's body/reflection colors (water.js), the
// riverbed's color and sun direction (terrain.js), and the caustic glow on
// fish/riverbed from the same date, so the whole scene reads as one
// consistent season instead of drifting independently.
//
// setFogSeason() is the odd one out: it takes no target, because it mutates
// the single shared FOG_COLOR that every ShaderMaterial's uFogColor uniform
// already points at (see fog.js).
function applySeason(dateStr) {
  currentDayOfYear = dayOfYear(dateStr);
  setFogSeason(currentDayOfYear);
  setSeason(currentDayOfYear);
  water.setSeason(currentDayOfYear);
  setTerrainSeason(terrainMesh, currentDayOfYear);
  causticsGenerator.setSeason(currentDayOfYear);
  fishRenderer?.setSeason(currentDayOfYear);
}

const SPECIES_KEYS = ["chinook", "jackChinook", "steelhead", "shad"];

// Caps how many fish are simulated/rendered at once, across all species.
//
// This is a single pooled total, deliberately, and the per-species clamp it
// replaces was distorting exactly the days that matter most. Clamping each
// species independently at 400 turned 2015's Chinook peak — ~7500 chinook
// against a few hundred steelhead, a genuinely ~94% chinook day — into 400
// of each, i.e. a 50/50 split on screen. The mix a viewer reads was an
// artifact of the cap rather than the data. speciesCountsForDay() below now
// scales the whole day proportionally instead, so the percentages survive
// and only the absolute number is capped.
//
// The ceiling is set by vertex cost, not fish logic: the real mesh (see
// fishMesh.js) is ~1300 vertices, each doing 2 VAT samples plus a caustics
// read, on top of per-instance fog/specular/depth work. 1200 fish keeps that
// near 2M vertex shader invocations per frame, which holds 60fps on
// mid-range hardware. Raise it only alongside a cheaper vertex path (an LOD
// for the ~80% of fish that are fogged past legibility is the obvious one).
const MAX_POPULATION = 1200;

// loadFishAssets() loads+bakes every distinct per-species GLB (see
// SPECIES_MODEL_URL in fishMesh.js) — real async work, unlike a placeholder
// shape — so fishRenderer stays null until it resolves; every reader below
// (applySeason, the render loop) guards for that.
let fishRenderer = null;
loadFishAssets()
  .then((assetsByUrl) => {
    fishRenderer = createFishInstancedMesh(assetsByUrl, MAX_POPULATION, bounds);
    scene.add(fishRenderer.mesh);
    // applySeason() may already have run once (jumpToDay(0) below) before
    // the model finished loading — the mesh didn't exist yet to receive it.
    fishRenderer.setSeason(currentDayOfYear);

    // Fade the loading overlay out, then drop it from the DOM once the
    // transition finishes (see style.css) rather than leaving a hidden-but-
    // present element around indefinitely.
    fishLoadingEl.classList.add("hidden");
    fishLoadingEl.addEventListener(
      "transitionend",
      () => fishLoadingEl.remove(),
      { once: true },
    );
  })
  .catch((err) => console.error("Failed to load fish model:", err));

// Everything bounds-shaped (terrain, water, the water sim, the caustics
// render targets) is rebuilt from scratch at the new size, since these
// meshes/render targets are sized directly off `bounds` rather than being
// resizable in place. Old GPU resources are disposed before their
// replacements are created to avoid leaking memory.
//
// Deliberately NOT called straight off the resize event — see the debounce
// below.
function rebuildWorld() {
  flock.setBounds(bounds);

  scene.remove(terrainMesh, water.mesh);
  terrainMesh.geometry.dispose();
  terrainMesh.material.dispose();
  water.mesh.geometry.dispose();
  water.mesh.material.dispose();
  waterSim.dispose();
  causticsGenerator.dispose();

  waterSize = waterWorldSize(bounds);
  terrainMesh = buildTerrainMesh(bounds, CAUSTICS_TARGET_SIZE);
  setTerrainSeason(terrainMesh, currentDayOfYear);
  scene.add(terrainMesh);
  depthRange = { surfaceY: -8, floorY: -riverDepth(bounds) + 6 };
  waterSim = createWaterSimulation(
    renderer,
    WATER_SIM_SIZE,
    waterSize.height / waterSize.width,
  );
  causticsGenerator = createCausticsGenerator(renderer, bounds, terrainMesh);
  causticsGenerator.setSeason(currentDayOfYear);
  water = buildWaterMesh(bounds, CAUSTICS_TARGET_SIZE);
  water.setSeason(currentDayOfYear);
  scene.add(water.mesh);
}

// A dragged window edge fires `resize` on nearly every frame of the drag,
// and rebuildWorld() above is expensive enough — disposing and reallocating
// the water sim's ping-pong targets, the two 1024x1024 caustics targets, and
// two full plane meshes — that running it at that rate visibly hitches and
// churns GPU memory for the whole duration of the drag.
//
// So the two halves are split by cost: the cheap half (renderer/composer
// buffers, camera aspect, fog density) runs immediately on every event so
// the canvas never looks stretched or wrongly-proportioned mid-drag, and
// the expensive rebuild waits until the drag has been still this long. In
// between, terrain/water/sim are simply still at their previous size —
// visible only as the water plane not yet reaching a freshly-widened
// viewport edge, which the plane's own fade margin already softens.
const REBUILD_DEBOUNCE_MS = 150;
let rebuildTimer = 0;

// Was 2.4 — halved so a fish's spawn-to-exit crossing takes roughly twice as
// long (see FRAMES_PER_DAY below, doubled to match), giving more time to
// actually watch individual fish swim through the scene instead of them
// blowing past in a couple seconds.
const BASE_MAX_SPEED = 1.2;

const flock = new Flock(bounds, {
  maxSpeed: BASE_MAX_SPEED,
  perceptionRadius: 70,
  // Was 20 — well under a fish's actual rendered body length (~72-84 world
  // units, fish.length * fishMesh.js's VISUAL_SCALE), so the separation
  // force's steady state let meshes clip well before this force pushed back
  // hard. Now close to Flock.step's overlap-resolution clearance so the
  // soft force does most of the work and the hard correction is a rare
  // safety net instead of the only thing keeping fish apart.
  separationRadius: 45,
});

// Registered below `flock` because rebuildWorld() reads it (see the
// debounce note above).
window.addEventListener("resize", () => {
  bounds = { width: window.innerWidth, height: window.innerHeight };
  sceneSetup.resize(bounds);
  clearTimeout(rebuildTimer);
  rebuildTimer = setTimeout(rebuildWorld, REBUILD_DEBOUNCE_MS);
});

// ---------------------------------------------------------------------
// Run timeline — ported unchanged from the Canvas2D version. All of this
// is dimension-agnostic: it only ever touches flock.fish.length/bounds,
// never rendering, so the 3D migration doesn't change any of it.
// ---------------------------------------------------------------------
let dayIndex = 0;
let isPlaying = true;
let frameCounter = 0;
// Was 40 — doubled so each simulated day plays out over twice as long.
const FRAMES_PER_DAY = 80;

timelineInput.max = String(runData.length - 1);

// Per-species counts for day `idx`, scaled down proportionally if the day's
// real total exceeds MAX_POPULATION — the shared source of truth for both
// how many fish that day targets in total (targetFishForDay) and what mix
// new spawns should be weighted toward (pickSpeciesForDay), so the two can
// never disagree about the day's composition.
//
// Scaling the whole day by one factor (rather than clamping each species
// separately — see MAX_POPULATION above) is what preserves the percentages:
// every species keeps its exact share of the day, and only the absolute
// number shrinks. A day already under the cap passes through untouched.
//
// Counts come back fractional after scaling. That's fine and intentional for
// both consumers: pickSpeciesForDay treats them as weights, and
// targetFishForDay rounds only the total.
function speciesCountsForDay(idx) {
  const day = runData[idx];
  const counts = {};
  let total = 0;
  for (const key of SPECIES_KEYS) {
    counts[key] = day[key] ?? 0;
    total += counts[key];
  }
  if (total > MAX_POPULATION) {
    const scale = MAX_POPULATION / total;
    for (const key of SPECIES_KEYS) counts[key] *= scale;
  }
  return counts;
}

// How many fish should be on-screen for a given day, straight from the
// data (no interpolation) — the base number `desiredPopulation` ramps
// toward. Falls back to the day's plain `count`, still capped, when there's
// no species breakdown at all — generatePlaceholderRun()'s fallback entries
// (see data.js) only carry `count`.
function targetFishForDay(idx) {
  const counts = speciesCountsForDay(idx);
  let total = 0;
  for (const key of SPECIES_KEYS) total += counts[key];
  if (total === 0) total = Math.min(MAX_POPULATION, runData[idx].count ?? 0);
  // Rounded because callers compare it against integer fish counts —
  // jumpToDay() spawns/removes until activeCount() matches, and a fractional
  // target there would never be reachable.
  return Math.round(total);
}

// Precomputed day-over-day change in target population, one entry per day,
// used by applyDaySpeed to make the school swim faster/slower as the run
// ramps up or tapers off.
const dailyRateOfChange = runData.map((_, i) =>
  i === 0 ? 0 : targetFishForDay(i) - targetFishForDay(i - 1),
);

// Population target for "partway through day `idx`": linearly interpolates
// between today's and tomorrow's counts so fish spawn in smoothly across
// the day instead of jumping in a single step at the day boundary.
function desiredPopulation(idx, progress) {
  const today = targetFishForDay(idx);
  const tomorrow = targetFishForDay((idx + 1) % runData.length);
  return today + (tomorrow - today) * progress;
}

// Weighted-random species pick for a spawn on day `idx`, matching that day's
// real Chinook/Jack Chinook/Steelhead/Shad percentages (see
// speciesCountsForDay) — the same counts targetFishForDay sums, so the mix
// new spawns are drawn from always agrees with the population they're
// filling. Falls back to all-steelhead when a day has no species breakdown
// at all.
function pickSpeciesForDay(idx) {
  const counts = speciesCountsForDay(idx);
  let total = 0;
  for (const key of SPECIES_KEYS) total += counts[key];
  if (total <= 0) return "steelhead";
  let r = Math.random() * total;
  for (const key of SPECIES_KEYS) {
    r -= counts[key];
    if (r <= 0) return key;
  }
  return "steelhead";
}

// Maps a day's rate-of-change in population to a swim-speed multiplier:
// a fast-rising run swims slower (more fish arriving = feels denser/slower),
// a fast-falling run swims faster. Clamped so extreme days don't blow the
// multiplier out of a sane range.
function speedMultiplierForRate(rate) {
  const normalized = Math.max(-1, Math.min(1, rate / 40));
  return 1 - normalized * 0.45;
}

// Applies the current day's speed multiplier to the flock's shared maxSpeed.
function applyDaySpeed(idx) {
  flock.options.maxSpeed =
    BASE_MAX_SPEED * speedMultiplierForRate(dailyRateOfChange[idx]);
}

let spawnAccumulator = 0;
const POPULATION_CORRECTION_GAIN = 0.15;

// New fish enter from the upstream (left) edge, at a random point along the
// river's width, so the run reads as continuously arriving rather than
// popping in at one fixed spot.
function spawnAtLeftEdge() {
  const x = -Math.random() * 40;
  const margin = 15;
  const y = margin + Math.random() * (bounds.height - margin * 2);
  flock.spawn(x, y, pickSpeciesForDay(dayIndex));
}

// Used only for bulk-filling/draining the population when jumping straight
// to a day (see jumpToDay) — anywhere in open water is fine since these
// fish aren't meant to visibly "arrive".
function randomOpenWaterPoint() {
  return { x: Math.random() * bounds.width, y: Math.random() * bounds.height };
}

// Scrubbing the timeline jumps straight to a day: spawn/flag-for-removal
// fish until the population matches that day's target (they still fade
// in/out — see boids.js — rather than popping), then reset the per-day
// animation state (frame counter, spawn accumulator, speed, HUD).
function jumpToDay(idx) {
  // A fresh jump is a hard resync point: flush any fade-out still pending
  // from a previous jump rather than layering more on top of it (see
  // Flock.finalizeRemovals() — this is what keeps a fast slider drag from
  // growing the fish array without bound).
  flock.finalizeRemovals();

  const target = targetFishForDay(idx);
  while (flock.activeCount() < target) {
    const { x, y } = randomOpenWaterPoint();
    flock.spawn(x, y, pickSpeciesForDay(idx));
  }
  while (flock.activeCount() > target) {
    // activeCount() excludes fish already mid-fade-out, so this always
    // finds a fresh candidate — remove() itself is a no-op on a fish
    // that's already flagged, which is what would infinite-loop otherwise.
    flock.remove(flock.fish.find((f) => !f.removing));
  }
  dayIndex = idx;
  frameCounter = 0;
  spawnAccumulator = 0;
  applyDaySpeed(idx);
  dateLabel.textContent = runData[idx].date;
  updateFishCountDisplay(idx);
  timelineInput.value = String(idx);
  applySeason(runData[idx].date);
}

jumpToDay(0);

playPauseBtn.addEventListener("click", () => {
  isPlaying = !isPlaying;
  playPauseBtn.textContent = isPlaying ? "Pause" : "Play";
});

timelineInput.addEventListener("input", (e) => {
  isPlaying = false;
  playPauseBtn.textContent = "Play";
  jumpToDay(Number(e.target.value));
});

// ---------------------------------------------------------------------
// Water ripples — no mouse interactivity, no per-fish disturbance either:
// this used to also drop a ripple per clustered "pod" of nearby fish (see
// git history / former scene/pods.js), but finding those pods meant
// clustering the entire flock (an O(n^2) union-find pass) every 20 frames —
// real money at thousands of fish, for a purely decorative effect. A slow
// ambient "rain," independent of the fish sim entirely, reads almost as
// well and costs nothing per fish.
// ---------------------------------------------------------------------
// Calm-water tuning: dropped less often, each drop bigger and gentler than
// a sharp poke, to read as slow, broad swells rather than busy chop (see
// the matching propagation/damping tuning in waterSim.js).
const AMBIENT_DROP_INTERVAL_FRAMES = 30;
let rippleFrame = 0;

function emitRipples() {
  rippleFrame++;
  if (rippleFrame % AMBIENT_DROP_INTERVAL_FRAMES !== 0) return;

  // One broad, soft ripple every AMBIENT_DROP_INTERVAL_FRAMES frames. The
  // 0.05-0.08 sim-space radius was tuned back when the sim's [-1, 1] space
  // mapped 1:1 onto bounds; now that it maps onto the bigger waterSize, the
  // same sim-space radius reads as a bigger real-world ripple, so it's
  // scaled down by that same ratio to keep the tuned size.
  const x = Math.random() * bounds.width;
  const z = Math.random() * bounds.height;
  const center = worldToSim(x, z);
  const radiusScale = bounds.width / waterSize.width;
  waterSim.addDrop(center, (0.05 + Math.random() * 0.03) * radiusScale, 0.018);
}

// ---------------------------------------------------------------------
// Animation loop
// ---------------------------------------------------------------------
function loop(t) {
  // 1. Advance the flocking simulation one tick. The HUD's fish counts are
  // driven by the real per-day DART data instead (see
  // updateFishCountDisplay), not this simulated count, so nothing here
  // needs to run every frame — only when dayIndex actually changes (see
  // jumpToDay and the day-rollover below).
  flock.step(1);

  sceneSetup.updateCamera(t);

  if (!debugPanel.hidden) {
    const dist = camera.position.distanceTo(cameraTarget);
    debugPanel.textContent =
      `distance to target: ${dist.toFixed(1)}\n` +
      `camera: (${camera.position.x.toFixed(0)}, ${camera.position.y.toFixed(0)}, ${camera.position.z.toFixed(0)})\n` +
      `target: (${cameraTarget.x.toFixed(0)}, ${cameraTarget.y.toFixed(0)}, ${cameraTarget.z.toFixed(0)})\n` +
      `bounds: ${bounds.width.toFixed(0)} x ${bounds.height.toFixed(0)}\n` +
      `camera.far: ${camera.far.toFixed(0)}`;
  }

  // 2. Advance the water surface: drop this frame's ripples, relax the
  // height field, then re-render the caustics pass (see
  // scene/causticsGenerator.js) off the freshly-stepped height field, then
  // hand the resulting caustics texture to the terrain/water/fish shaders
  // (all three read their caustic glow straight off it — see
  // scene/causticsChunk.js).
  emitRipples();
  waterSim.step();
  causticsGenerator.render(waterSim.texture);
  setTerrainCausticsTexture(terrainMesh, causticsGenerator.texture);
  water.setSources(waterSim.texture, causticsGenerator.texture);

  // 3. Sync the instanced fish mesh to the simulation's current fish array
  // (positions, headings, depth, swim-phase, species tint, caustic glow) —
  // only once the model has loaded.
  if (fishRenderer)
    fishRenderer.update(
      flock.fish,
      t,
      depthRange,
      waterSize,
      causticsGenerator.texture,
      bounds,
    );

  renderScene();

  // 4. Population pacing: while playing, continuously spawn fish so the
  // count tracks `desiredPopulation`'s smooth ramp (rather than snapping),
  // and advance to the next day once this day's frame budget is spent.
  if (isPlaying) {
    const progress = frameCounter / FRAMES_PER_DAY;
    const target = desiredPopulation(dayIndex, progress);
    const error = target - flock.activeCount();
    spawnAccumulator += Math.max(0, error) * POPULATION_CORRECTION_GAIN;
    while (spawnAccumulator >= 1) {
      spawnAtLeftEdge();
      spawnAccumulator -= 1;
    }

    frameCounter++;
    if (frameCounter >= FRAMES_PER_DAY) {
      frameCounter = 0;
      dayIndex = (dayIndex + 1) % runData.length;
      applyDaySpeed(dayIndex);
      dateLabel.textContent = runData[dayIndex].date;
      updateFishCountDisplay(dayIndex);
      timelineInput.value = String(dayIndex);
      applySeason(runData[dayIndex].date);
    }
  }

  requestAnimationFrame(loop);
}

requestAnimationFrame(loop);
