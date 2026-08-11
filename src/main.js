import { Flock } from "./boids.js";
import { runData } from "./data.js";
import { createSceneSetup } from "./scene/sceneSetup.js";
import {
  buildTerrainMesh,
  setTerrainWaterTexture,
  riverDepth,
} from "./scene/terrain.js";
import { buildWaterMesh, waterWorldSize } from "./scene/water.js";
import { createWaterSimulation } from "./scene/waterSim.js";
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
const { renderer, scene, camera, controls } = sceneSetup;

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

let fishRenderer = null;
loadFishAssets()
  .then((assets) => {
    fishRenderer = createFishInstancedMesh(assets, 1500, WATER_SIM_SIZE, bounds);
    scene.add(fishRenderer.mesh);
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
  depthRange = { surfaceY: -8, floorY: -riverDepth(bounds) + 6 };
  waterSim = createWaterSimulation(
    renderer,
    WATER_SIM_SIZE,
    waterSize.height / waterSize.width,
  );
  water = buildWaterMesh(bounds, WATER_SIM_SIZE);
  scene.add(water.mesh);
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
  flock.spawn(x, y);
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
    flock.spawn(x, y);
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
  fishCountLabel.textContent = `${flock.activeCount()} fish`;
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
// Calm-water tuning: dropped less often, each drop bigger and gentler than
// a sharp poke, to read as slow, broad swells rather than busy chop (see
// the matching propagation/damping tuning in waterSim.js).
const AMBIENT_DROP_INTERVAL_FRAMES = 30;
const POD_DROP_INTERVAL_FRAMES = 20;
let rippleFrame = 0;

function emitRipples() {
  rippleFrame++;

  // Ambient "rain": one broad, soft ripple every AMBIENT_DROP_INTERVAL_FRAMES
  // frames, purely cosmetic so the water surface is never perfectly still.
  // The 0.05-0.08 sim-space radius was tuned back when the sim's [-1, 1]
  // space mapped 1:1 onto bounds; now that it maps onto the bigger
  // waterSize, the same sim-space radius reads as a bigger real-world
  // ripple, so it's scaled down by that same ratio to keep the tuned size.
  if (rippleFrame % AMBIENT_DROP_INTERVAL_FRAMES === 0) {
    const x = Math.random() * bounds.width;
    const z = Math.random() * bounds.height;
    const center = worldToSim(x, z);
    const radiusScale = bounds.width / waterSize.width;
    waterSim.addDrop(
      center,
      (0.05 + Math.random() * 0.03) * radiusScale,
      0.018,
    );
  }

  // Pod ripples: each clustered group of fish (see pods.js) drops a ripple
  // sized to the pod and sign-alternating over time (sin of its phase), so
  // passing schools visibly disturb the surface above them. Normalized
  // against waterSize (not bounds) so the real-world ripple size tracks
  // the pod regardless of how much bigger the sim's mapped area is.
  if (rippleFrame % POD_DROP_INTERVAL_FRAMES === 0) {
    const pods = computePods(flock.fish);
    for (const pod of pods) {
      const center = worldToSim(pod.x, pod.z);
      const radius = Math.min(0.18, (pod.radius / waterSize.width) * 2);
      const strength = Math.sin(pod.phase) >= 0 ? 0.02 : -0.02;
      waterSim.addDrop(center, radius, strength);
    }
  }
}

// ---------------------------------------------------------------------
// Animation loop
// ---------------------------------------------------------------------
function loop(t) {
  // 1. Advance the flocking simulation one tick and reflect the live count in
  // the HUD. activeCount() excludes fish mid-fade-out (see boids.js) so the
  // number reflects the run's logical population, not the fading stragglers
  // still on screen.
  flock.step(1);
  fishCountLabel.textContent = `${flock.activeCount()} fish`;

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
  // (positions, headings, depth, swim-phase, caustic glow) — only once the
  // model has loaded.
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
      timelineInput.value = String(dayIndex);
    }
  }

  requestAnimationFrame(loop);
}

requestAnimationFrame(loop);
