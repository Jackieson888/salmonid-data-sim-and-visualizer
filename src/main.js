import { Flock } from "./boids.js";
import { runData } from "./data.js";
import { createSceneSetup } from "./scene/sceneSetup.js";
import { buildTerrainMesh, applyCaustics, riverDepth } from "./scene/terrain.js";
import { buildWaterMesh } from "./scene/water.js";
import { createWaterSimulation } from "./scene/waterSim.js";
import { createCausticsPipeline } from "./scene/caustics.js";
import { loadFishAssets, createFishInstancedMesh } from "./scene/fishMesh.js";
import { computePods } from "./scene/pods.js";

const canvas = document.getElementById("river-canvas");

const dateLabel = document.getElementById("date-label");
const playPauseBtn = document.getElementById("play-pause");
const timelineInput = document.getElementById("timeline");
const fishCountLabel = document.getElementById("fish-count");

// ---------------------------------------------------------------------
// Scene: bounds map 1:1 onto world units — worldX = fish.x (downstream),
// worldZ = fish.y (across-river), worldY is a cosmetic-only "up" the 2D
// simulation never sees. See scene/*.js for the render-side details.
// ---------------------------------------------------------------------
let bounds = { width: window.innerWidth, height: window.innerHeight };

const sceneSetup = createSceneSetup(canvas, bounds);
const { renderer, scene, camera } = sceneSetup;

// ---------------------------------------------------------------------
// Water simulation + caustics pipeline (see scene/waterSim.js and
// scene/caustics.js — ported from martinRenou/threejs-caustics). The
// water sim's own [-1, 1] space is square regardless of world aspect
// ratio, so ripple radii get corrected by worldAspect to stay circular.
// ---------------------------------------------------------------------
const WATER_SIM_SIZE = 192;
const WATER_AMPLITUDE = 10; // world units of ripple height, for the caustics ray origin

// Converts a world-space (x, z) position into the water sim's normalized
// [-1, 1] uv space, used whenever we need to drop a ripple at a world point.
function worldToSim(x, z) {
  return { x: (x / bounds.width) * 2 - 1, z: (z / bounds.height) * 2 - 1 };
}

let terrainMesh = buildTerrainMesh(bounds);
scene.add(terrainMesh);

// Depth range fish swim within: a little below the surface down to just
// above the riverbed floor. See boids.js's fish.depth and fishMesh.js.
let depthRange = { surfaceY: -8, floorY: -riverDepth(bounds) + 6 };

let causticsPipeline = createCausticsPipeline({ bounds, terrainMesh });
applyCaustics(terrainMesh, causticsPipeline);
causticsPipeline.renderTerrainDepthMap(renderer);

let waterSim = createWaterSimulation(renderer, WATER_SIM_SIZE, bounds.height / bounds.width);

let water = buildWaterMesh(bounds);
scene.add(water.mesh);

let fishRenderer = null;
loadFishAssets()
  .then((assets) => {
    fishRenderer = createFishInstancedMesh(assets, 1500);
    scene.add(fishRenderer.mesh);
  })
  .catch((err) => console.error("Failed to load fish model:", err));

// Window resize handler: everything bounds-shaped (terrain, water, the
// caustics pipeline, the water sim) is rebuilt from scratch at the new
// size, since these meshes/render targets are sized directly off `bounds`
// rather than being resizable in place. Old GPU resources are disposed
// before their replacements are created to avoid leaking memory.
function resize() {
  bounds = { width: window.innerWidth, height: window.innerHeight };
  sceneSetup.resize(bounds);
  flock.setBounds(bounds);

  scene.remove(terrainMesh, water.mesh);
  terrainMesh.geometry.dispose();
  terrainMesh.material.dispose();
  water.mesh.geometry.dispose();
  water.mesh.material.dispose();
  causticsPipeline.dispose();
  waterSim.dispose();

  terrainMesh = buildTerrainMesh(bounds);
  depthRange = { surfaceY: -8, floorY: -riverDepth(bounds) + 6 };
  causticsPipeline = createCausticsPipeline({ bounds, terrainMesh });
  applyCaustics(terrainMesh, causticsPipeline);
  causticsPipeline.renderTerrainDepthMap(renderer);
  waterSim = createWaterSimulation(renderer, WATER_SIM_SIZE, bounds.height / bounds.width);
  water = buildWaterMesh(bounds);
  scene.add(terrainMesh, water.mesh);
}

const BASE_MAX_SPEED = 2.4;

const flock = new Flock(bounds, {
  maxSpeed: BASE_MAX_SPEED,
  perceptionRadius: 60,
  separationRadius: 20,
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
const FRAMES_PER_DAY = 40;

timelineInput.max = String(runData.length - 1);

// How many fish should be on-screen for a given day, straight from the
// data (no interpolation) — the base number `desiredPopulation` ramps toward.
function targetFishForDay(idx) {
  const SCALE = 1;
  return Math.round(runData[idx].count * SCALE);
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
  flock.options.maxSpeed = BASE_MAX_SPEED * speedMultiplierForRate(dailyRateOfChange[idx]);
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
  flock.spawn(x, y);
}

// Used only for bulk-filling/draining the population when jumping straight
// to a day (see jumpToDay) — anywhere in open water is fine since these
// fish aren't meant to visibly "arrive".
function randomOpenWaterPoint() {
  return { x: Math.random() * bounds.width, y: Math.random() * bounds.height };
}

// Scrubbing the timeline jumps straight to a day: instantly spawn/remove
// fish until the population matches that day's target, then reset the
// per-day animation state (frame counter, spawn accumulator, speed, HUD).
function jumpToDay(idx) {
  const target = targetFishForDay(idx);
  while (flock.fish.length < target) {
    const { x, y } = randomOpenWaterPoint();
    flock.spawn(x, y);
  }
  while (flock.fish.length > target) {
    flock.remove(flock.fish[flock.fish.length - 1]);
  }
  dayIndex = idx;
  frameCounter = 0;
  spawnAccumulator = 0;
  applyDaySpeed(idx);
  dateLabel.textContent = runData[idx].date;
  fishCountLabel.textContent = `${flock.fish.length} fish`;
  timelineInput.value = String(idx);
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
// Water ripples — no mouse interactivity: the fish themselves disturb the
// surface (pods drop ripples as they pass), plus a slow ambient "rain" so
// the surface never goes fully static.
// ---------------------------------------------------------------------
const AMBIENT_DROP_INTERVAL_FRAMES = 12;
const POD_DROP_INTERVAL_FRAMES = 12;
let rippleFrame = 0;

function emitRipples() {
  rippleFrame++;

  // Ambient "rain": one small random ripple every AMBIENT_DROP_INTERVAL_FRAMES
  // frames, purely cosmetic so the water surface is never perfectly still.
  if (rippleFrame % AMBIENT_DROP_INTERVAL_FRAMES === 0) {
    const x = Math.random() * bounds.width;
    const z = Math.random() * bounds.height;
    const center = worldToSim(x, z);
    waterSim.addDrop(center, 0.02 + Math.random() * 0.015, 0.025);
  }

  // Pod ripples: each clustered group of fish (see pods.js) drops a ripple
  // sized to the pod and sign-alternating over time (sin of its phase), so
  // passing schools visibly disturb the surface above them.
  if (rippleFrame % POD_DROP_INTERVAL_FRAMES === 0) {
    const pods = computePods(flock.fish);
    for (const pod of pods) {
      const center = worldToSim(pod.x, pod.z);
      const radius = Math.min(0.12, (pod.radius / bounds.width) * 1.5);
      const strength = Math.sin(pod.phase) >= 0 ? 0.03 : -0.03;
      waterSim.addDrop(center, radius, strength);
    }
  }
}

// ---------------------------------------------------------------------
// Animation loop
// ---------------------------------------------------------------------
function loop(t) {
  // 1. Advance the flocking simulation one tick and reflect the live count in the HUD.
  flock.step(1);
  fishCountLabel.textContent = `${flock.fish.length} fish`;

  sceneSetup.updateCamera(t);

  // 2. Advance the water surface: drop this frame's ripples, relax the
  // height field, re-render the caustics that refract through it, then hand
  // both textures to the water mesh's shader.
  emitRipples();
  waterSim.step();
  causticsPipeline.renderCaustics(renderer, waterSim.texture, WATER_AMPLITUDE);
  water.setSources(waterSim.texture, causticsPipeline);

  // 3. Sync the instanced fish mesh to the simulation's current fish array
  // (positions, headings, depth, swim-phase) — only once the model has loaded.
  if (fishRenderer) fishRenderer.update(flock.fish, t, depthRange);

  renderer.render(scene, camera);

  // 4. Population pacing: while playing, continuously spawn fish so the
  // count tracks `desiredPopulation`'s smooth ramp (rather than snapping),
  // and advance to the next day once this day's frame budget is spent.
  if (isPlaying) {
    const progress = frameCounter / FRAMES_PER_DAY;
    const target = desiredPopulation(dayIndex, progress);
    const error = target - flock.fish.length;
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
      timelineInput.value = String(dayIndex);
    }
  }

  requestAnimationFrame(loop);
}

requestAnimationFrame(loop);
