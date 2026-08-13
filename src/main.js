import { Flock } from "./boids.js";
import { runData } from "./data.js";
import { createSceneSetup } from "./scene/sceneSetup.js";
import {
  buildTerrainMesh,
  setTerrainWaterTexture,
  setTerrainSeason,
  riverDepth,
} from "./scene/terrain.js";
import { buildWaterMesh, waterWorldSize } from "./scene/water.js";
import { createWaterSimulation } from "./scene/waterSim.js";
import { loadFishAssets, createFishInstancedMesh } from "./scene/fishMesh.js";
import { dayOfYear } from "./scene/season.js";

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

// Drives the HUD's fish counts from the real per-day DART numbers (see
// data.js) rather than flock.activeCount() — the simulated/rendered boid
// count is capped well below these for performance (see MAX_PER_SPECIES
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
const { renderer, scene, camera, controls, setSeason } = sceneSetup;

// ---------------------------------------------------------------------
// Camera debug readout — toggle with "D". Shows live distance-to-target
// plus camera/target/bounds numbers so a sensible OrbitControls
// minDistance/maxDistance can be read off directly instead of guessed.
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
// by worldAspect to stay circular. The terrain and water surface both
// read caustic glow straight off this sim's texture (see
// scene/causticsChunk.js) rather than through a separate render pass.
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

let terrainMesh = buildTerrainMesh(bounds, WATER_SIM_SIZE);
// scene.add(terrainMesh);

// Depth range fish swim within: a little below the surface down to just
// above the riverbed floor. See boids.js's fish.depth and fishMesh.js.
let depthRange = { surfaceY: -8, floorY: -riverDepth(bounds) + 6 };

let waterSim = createWaterSimulation(
  renderer,
  WATER_SIM_SIZE,
  waterSize.height / waterSize.width,
);

let water = buildWaterMesh(bounds, WATER_SIM_SIZE);
scene.add(water.mesh);

// Tracks the day-of-year last passed to setSeason/water.setSeason, so
// resize() can re-apply it after rebuilding `water` from scratch (a fresh
// buildWaterMesh() call otherwise resets its sky-reflection tint to a
// pre-season default — see water.js).
let currentDayOfYear = 0;

// Drives the sky/sun (sceneSetup.js), the water surface's reflected-sky
// tint (water.js), the caustic glow on fish/riverbed, and the riverbed's
// sun direction (terrain.js) from the same date, so the whole scene reads
// as one consistent season instead of drifting independently.
function applySeason(dateStr) {
  currentDayOfYear = dayOfYear(dateStr);
  setSeason(currentDayOfYear);
  water.setSeason(currentDayOfYear);
  setTerrainSeason(terrainMesh, currentDayOfYear);
  fishRenderer?.setSeason(currentDayOfYear);
}

const SPECIES_KEYS = ["chinook", "jackChinook", "steelhead", "shad"];

// Caps how many fish of any single species are simulated/rendered at once.
// Unlike a flat total cap, this is per-species: the real steelhead-
// updated.glb mesh (see fishMesh.js) is far more expensive per instance
// than a placeholder shape would be — texture sampling, VAT skinning
// lookups, caustics/fog/specular — so an overwhelming single-species day
// (2015's Chinook peak alone hits ~7500 — see data.js) needs its own
// ceiling rather than sharing one pooled total with three other species
// nowhere near it. MAX_POPULATION (the sum across all species) is what
// createFishInstancedMesh's instance count is sized to below.
const MAX_PER_SPECIES = 400;
const MAX_POPULATION = MAX_PER_SPECIES * SPECIES_KEYS.length;

// loadFishAssets() loads+bakes every distinct per-species GLB (see
// SPECIES_MODEL_URL in fishMesh.js) — real async work, unlike a placeholder
// shape — so fishRenderer stays null until it resolves; every reader below
// (applySeason, the render loop) guards for that.
let fishRenderer = null;
loadFishAssets()
  .then((assetsByUrl) => {
    fishRenderer = createFishInstancedMesh(
      assetsByUrl,
      MAX_PER_SPECIES,
      WATER_SIM_SIZE,
      bounds,
    );
    scene.add(fishRenderer.mesh);
    // applySeason() may already have run once (jumpToDay(0) below) before
    // the model finished loading — the mesh didn't exist yet to receive it.
    fishRenderer.setSeason(currentDayOfYear);
  })
  .catch((err) => console.error("Failed to load fish model:", err));

// Window resize handler: everything bounds-shaped (terrain, water, the
// water sim) is rebuilt from scratch at the new size, since these
// meshes/render targets are sized directly off `bounds` rather than being
// resizable in place. Old GPU resources are disposed before their
// replacements are created to avoid leaking memory.
function resize() {
  bounds = { width: window.innerWidth, height: window.innerHeight };
  sceneSetup.resize(bounds);
  flock.setBounds(bounds);

  scene.remove(terrainMesh, water.mesh);
  terrainMesh.geometry.dispose();
  terrainMesh.material.dispose();
  water.mesh.geometry.dispose();
  water.mesh.material.dispose();
  waterSim.dispose();

  waterSize = waterWorldSize(bounds);
  terrainMesh = buildTerrainMesh(bounds, WATER_SIM_SIZE);
  setTerrainSeason(terrainMesh, currentDayOfYear);
  depthRange = { surfaceY: -8, floorY: -riverDepth(bounds) + 6 };
  waterSim = createWaterSimulation(
    renderer,
    WATER_SIM_SIZE,
    waterSize.height / waterSize.width,
  );
  water = buildWaterMesh(bounds, WATER_SIM_SIZE);
  water.setSeason(currentDayOfYear);
  scene.add(water.mesh);
}

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

window.addEventListener("resize", resize);

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

// Per-species counts for day `idx`, each capped at MAX_PER_SPECIES (see
// above) — the shared source of truth for both how many fish that day
// targets in total (targetFishForDay) and what mix new spawns should be
// weighted toward (pickSpeciesForDay), so an over-cap species is
// under-represented consistently in both instead of just at the total.
function speciesCountsForDay(idx) {
  const day = runData[idx];
  const counts = {};
  for (const key of SPECIES_KEYS) {
    counts[key] = Math.min(MAX_PER_SPECIES, day[key] ?? 0);
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
  return total;
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
// capped Chinook/Jack Chinook/Steelhead/Shad mix (see speciesCountsForDay) —
// using the same capped counts as targetFishForDay so a species pinned at
// MAX_PER_SPECIES is under-represented in new spawns to match, not just in
// the total. Falls back to all-steelhead when a day has no species
// breakdown at all.
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
    const dist = camera.position.distanceTo(controls.target);
    debugPanel.textContent =
      `distance to target: ${dist.toFixed(1)}\n` +
      `camera: (${camera.position.x.toFixed(0)}, ${camera.position.y.toFixed(0)}, ${camera.position.z.toFixed(0)})\n` +
      `target: (${controls.target.x.toFixed(0)}, ${controls.target.y.toFixed(0)}, ${controls.target.z.toFixed(0)})\n` +
      `bounds: ${bounds.width.toFixed(0)} x ${bounds.height.toFixed(0)}\n` +
      `camera.far: ${camera.far.toFixed(0)}`;
  }

  // 2. Advance the water surface: drop this frame's ripples, relax the
  // height field, then hand the resulting texture to the terrain and water
  // shaders (both read their caustic glow straight off it — see
  // scene/causticsChunk.js).
  emitRipples();
  waterSim.step();
  setTerrainWaterTexture(terrainMesh, waterSim.texture);
  water.setSources(waterSim.texture);

  // 3. Sync the instanced fish mesh to the simulation's current fish array
  // (positions, headings, depth, swim-phase, species tint, caustic glow) —
  // only once the model has loaded.
  if (fishRenderer)
    fishRenderer.update(
      flock.fish,
      t,
      depthRange,
      waterSize,
      waterSim.texture,
      bounds,
    );

  renderer.render(scene, camera);

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
