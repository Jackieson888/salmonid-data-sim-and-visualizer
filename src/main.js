import { Flock, REMOVE_FADE_FRAMES } from "./boids.js";
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

// Tracks the day-of-year last passed to the various setSeason() calls, so
// createWorld() can re-apply it after a resize rebuilds these meshes from
// scratch (a fresh buildWaterMesh()/buildTerrainMesh() call otherwise resets
// them to their pre-season defaults — see water.js/terrain.js).
let currentDayOfYear = 0;

// ---------------------------------------------------------------------
// The bounds-shaped half of the scene. Every one of these is sized directly
// off `bounds` rather than being resizable in place, so a resize disposes
// and rebuilds the whole set (see destroyWorld/rebuildWorld below).
//
// Declared here and assigned in createWorld() so that construction exists in
// exactly one place: this block used to appear once at module top level and
// again, verbatim, inside rebuildWorld(), which is precisely where a new
// bounds-dependent resource gets added to one copy and forgotten in the
// other.
// ---------------------------------------------------------------------
let waterSize;
let terrainMesh;
let depthRange;
let waterSim;
let causticsGenerator;
let water;

function createWorld() {
  // The sim actually covers a bigger area than the river bounds (see
  // waterWorldSize()/WATER_SIZE_MULTIPLIER in water.js) so ripples can
  // propagate all the way out to the water plane's faded edges instead of
  // the edge texel just clamping/stretching across that whole margin.
  waterSize = waterWorldSize(bounds);

  terrainMesh = buildTerrainMesh(bounds, CAUSTICS_TARGET_SIZE);

  // Depth range fish swim within: a little below the surface down to just
  // above the riverbed floor. See boids.js's fish.depth and fishMesh.js.
  depthRange = { surfaceY: -8, floorY: -riverDepth(bounds) + 6 };

  waterSim = createWaterSimulation(
    renderer,
    WATER_SIM_SIZE,
    waterSize.height / waterSize.width,
  );

  // Real-time caustics (see scene/causticsGenerator.js, ported from
  // martinRenou/threejs-caustics) — recomputed every frame from the water
  // sim's live height field, terrain/water/fish all sample its output
  // texture for their caustic glow (see scene/glsl.js) instead of reading
  // the water sim texture directly.
  causticsGenerator = createCausticsGenerator(renderer, bounds, terrainMesh);

  water = buildWaterMesh(bounds, CAUSTICS_TARGET_SIZE);

  // The caustics render target is reused every frame, so its texture object
  // never changes identity — bind it once here rather than re-assigning the
  // same object to the same uniforms 60 times a second. (The water sim's own
  // texture genuinely does alternate between two ping-pong targets, so that
  // one still has to be handed over per frame — see the render loop.)
  setTerrainCausticsTexture(terrainMesh, causticsGenerator.texture);
  water.setCausticsTexture(causticsGenerator.texture);

  setTerrainSeason(terrainMesh, currentDayOfYear);
  causticsGenerator.setSeason(currentDayOfYear);
  water.setSeason(currentDayOfYear);

  // Everything the fish shaders derive from bounds — fog density, the two
  // depth-attenuation rates, and the world->sim UV mapping. Only changes on
  // resize, so it's pushed here rather than recomputed inside the per-frame
  // update(). Null until the models finish loading, which re-pushes it.
  fishRenderer?.setBounds(bounds, waterSize, depthRange);
  fishRenderer?.setCausticsTexture(causticsGenerator.texture);

  scene.add(terrainMesh, water.mesh);
}

// Old GPU resources are disposed before their replacements are created to
// avoid leaking memory across a resize.
function destroyWorld() {
  scene.remove(terrainMesh, water.mesh);
  terrainMesh.geometry.dispose();
  terrainMesh.material.dispose();
  water.mesh.geometry.dispose();
  water.mesh.material.dispose();
  waterSim.dispose();
  causticsGenerator.dispose();
}

// Deliberately NOT called straight off the resize event — see the debounce
// below.
function rebuildWorld() {
  flock.setBounds(bounds);
  destroyWorld();
  createWorld();
}

const SPECIES_KEYS = ["chinook", "jackChinook", "steelhead", "shad"];

// Caps how many fish are simulated/rendered at once, across all species.
//
// This is a single pooled total, deliberately, and the per-species clamp it
// replaces was distorting exactly the days that matter most. Clamping each
// species independently at 400 turned 2015's Chinook peak — ~7500 chinook
// against a few hundred steelhead, a genuinely ~94% chinook day — into 400
// of each, i.e. a 50/50 split on screen. The mix a viewer reads was an
// artifact of the cap rather than the data. The precomputed day tables below
// scale the whole day proportionally instead, so the percentages survive and
// only the absolute number is capped.
//
// The ceiling is set by vertex cost, not fish logic: the real mesh (see
// fishMesh.js) is ~1300 vertices, each doing 2 VAT samples plus a caustics
// read, on top of per-instance fog/specular/depth work. 1200 fish keeps that
// near 2M vertex shader invocations per frame, which holds 60fps on
// mid-range hardware. Raise it only alongside a cheaper vertex path (an LOD
// for the ~80% of fish that are fogged past legibility is the obvious one).
const MAX_POPULATION = 1200;

// Extra instance slots each species renderer gets on top of MAX_POPULATION.
//
// MAX_POPULATION bounds the *active* fish, but flock.fish also holds fish
// that have crossed the exit line and are still fading out over
// REMOVE_FADE_FRAMES (see boids.js). Sizing renderer capacity to
// MAX_POPULATION alone meant those pushed the array past capacity and the
// overflow was silently dropped from the draw — and since fading fish are the
// oldest and sit at the front of the array, the fish actually dropped were
// the newest spawns, which then popped in a beat late.
//
// The number of fish fading at once is (exit rate) x REMOVE_FADE_FRAMES. At
// the cap, the exit rate is roughly population / crossing time, and a fish
// crosses in bounds.width / maxSpeed frames — so a narrow window (the worst
// case, since it shortens the crossing without shrinking the population)
// lands around 5 exits/frame, i.e. ~120 fading. 192 leaves margin on top of
// that at a cost of ~17KB of unused instance data per renderer.
const FISH_RENDER_HEADROOM = 8 * REMOVE_FADE_FRAMES;

// loadFishAssets() loads+bakes every distinct per-species GLB (see
// SPECIES_MODEL_URL in fishMesh.js) — real async work, unlike a placeholder
// shape — so fishRenderer stays null until it resolves; every reader below
// (createWorld, applySeason, the render loop) guards for that.
let fishRenderer = null;

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

window.addEventListener("resize", () => {
  bounds = { width: window.innerWidth, height: window.innerHeight };
  sceneSetup.resize(bounds);
  clearTimeout(rebuildTimer);
  rebuildTimer = setTimeout(rebuildWorld, REBUILD_DEBOUNCE_MS);
});

// Was 2.4 — halved so a fish's spawn-to-exit crossing takes roughly twice as
// long (see FRAMES_PER_DAY below, doubled to match), giving more time to
// actually watch individual fish swim through the scene instead of them
// blowing past in a couple seconds.
const BASE_MAX_SPEED = 1.2;

const flock = new Flock(bounds, {
  maxSpeed: BASE_MAX_SPEED,
  perceptionRadius: 70,
  // Was 20 — well under a fish's actual rendered body length (~72-84 world
  // units, fish.length * boids.js's BODY_VISUAL_SCALE), so the separation
  // force's steady state let meshes clip well before this force pushed back
  // hard. Now close to Flock.step's overlap-resolution clearance so the
  // soft force does most of the work and the hard correction is a rare
  // safety net instead of the only thing keeping fish apart.
  separationRadius: 45,
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

// ---------------------------------------------------------------------
// Per-day population/species tables, precomputed once at load.
//
// These are pure functions of runData, which never changes after the fetch
// resolves, but they used to be recomputed on demand — and each computation
// allocated a fresh counts object. desiredPopulation() alone called it twice
// per frame, and every single spawn called it again to pick a species, so a
// busy day was allocating dozens of throwaway objects per frame for numbers
// that were identical every time.
//
// dayTargets[i]  — how many fish day i should have on screen.
// dayWeights[]   — flat, SPECIES_KEYS.length entries per day, holding the
//                  running cumulative species counts for that day, so a
//                  weighted-random pick is a walk over a slice rather than a
//                  rebuild of the whole table.
//
// The scaling is what preserves the day's real percentages (see
// MAX_POPULATION above): a day over the cap has every species multiplied by
// one shared factor, so each keeps its exact share and only the absolute
// number shrinks. A day already under the cap passes through untouched.
// Counts stay fractional after scaling — deliberately, since they're only
// ever used as weights or summed before rounding.
// ---------------------------------------------------------------------
const dayTargets = new Int32Array(runData.length);
const dayWeights = new Float64Array(runData.length * SPECIES_KEYS.length);

for (let i = 0; i < runData.length; i++) {
  const day = runData[i];
  let total = 0;
  for (const key of SPECIES_KEYS) total += day[key] ?? 0;

  const scale = total > MAX_POPULATION ? MAX_POPULATION / total : 1;
  const base = i * SPECIES_KEYS.length;
  let cumulative = 0;
  for (let s = 0; s < SPECIES_KEYS.length; s++) {
    cumulative += (day[SPECIES_KEYS[s]] ?? 0) * scale;
    dayWeights[base + s] = cumulative;
  }

  // Falls back to the day's plain `count`, still capped, when there's no
  // species breakdown at all — generatePlaceholderRun()'s fallback entries
  // (see data.js) only carry `count`. Rounded because callers compare it
  // against integer fish counts, and a fractional target would never be
  // reachable.
  dayTargets[i] =
    total > 0
      ? Math.round(cumulative)
      : Math.min(MAX_POPULATION, Math.round(day.count ?? 0));
}

// Precomputed day-over-day change in target population, one entry per day,
// used by applyDaySpeed to make the school swim faster/slower as the run
// ramps up or tapers off.
const dailyRateOfChange = Int32Array.from(runData, (_, i) =>
  i === 0 ? 0 : dayTargets[i] - dayTargets[i - 1],
);

// Population target for "partway through day `idx`": linearly interpolates
// between today's and tomorrow's counts so fish spawn in smoothly across
// the day instead of jumping in a single step at the day boundary.
function desiredPopulation(idx, progress) {
  const today = dayTargets[idx];
  const tomorrow = dayTargets[(idx + 1) % runData.length];
  return today + (tomorrow - today) * progress;
}

// Weighted-random species pick for a spawn on day `idx`, matching that day's
// real Chinook/Jack Chinook/Steelhead/Shad percentages — drawn from the same
// table dayTargets was summed from, so the mix new spawns come from always
// agrees with the population they're filling. Falls back to all-steelhead
// when a day has no species breakdown at all.
function pickSpeciesForDay(idx) {
  const base = idx * SPECIES_KEYS.length;
  const total = dayWeights[base + SPECIES_KEYS.length - 1];
  if (total <= 0) return "steelhead";
  const r = Math.random() * total;
  for (let s = 0; s < SPECIES_KEYS.length; s++) {
    if (r <= dayWeights[base + s]) return SPECIES_KEYS[s];
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

  // activeCount() is read once and the difference acted on directly, rather
  // than re-counting the whole flock as a loop condition. Spawning ~1200
  // fish one activeCount() at a time was quadratic, and it ran on every
  // `input` event of a slider drag.
  const target = dayTargets[idx];
  const active = flock.activeCount();
  for (let i = active; i < target; i++) {
    // Anywhere in open water is fine — these fish aren't meant to visibly
    // "arrive" the way a spawnAtLeftEdge() fish is.
    flock.spawn(
      Math.random() * bounds.width,
      Math.random() * bounds.height,
      pickSpeciesForDay(idx),
    );
  }
  if (active > target) flock.removeActive(active - target);

  dayIndex = idx;
  frameCounter = 0;
  spawnAccumulator = 0;
  applyDaySpeed(idx);
  dateLabel.textContent = runData[idx].date;
  updateFishCountDisplay(idx);
  timelineInput.value = String(idx);
  applySeason(runData[idx].date);
}

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

// Reused across drops to hold the ripple's position in the water sim's
// normalized [-1, 1] uv space. Shifted by the sim's margin below, since the
// sim is centered on bounds rather than corner-anchored at world (0, 0) —
// see waterWorldSize().
const rippleCenter = { x: 0, z: 0 };

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
  rippleCenter.x = ((x + waterSize.marginX) / waterSize.width) * 2 - 1;
  rippleCenter.z = ((z + waterSize.marginZ) / waterSize.height) * 2 - 1;
  const radiusScale = bounds.width / waterSize.width;
  waterSim.addDrop(
    rippleCenter,
    (0.05 + Math.random() * 0.03) * radiusScale,
    0.018,
  );
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

  sceneSetup.updateCamera();

  if (!debugPanel.hidden) {
    const dist = camera.position.distanceTo(cameraTarget);
    debugPanel.textContent =
      `distance to target: ${dist.toFixed(1)}\n` +
      `camera: (${camera.position.x.toFixed(0)}, ${camera.position.y.toFixed(0)}, ${camera.position.z.toFixed(0)})\n` +
      `target: (${cameraTarget.x.toFixed(0)}, ${cameraTarget.y.toFixed(0)}, ${cameraTarget.z.toFixed(0)})\n` +
      `bounds: ${bounds.width.toFixed(0)} x ${bounds.height.toFixed(0)}\n` +
      `camera.far: ${camera.far.toFixed(0)}\n` +
      `fish: ${flock.activeCount()} active / ${flock.fish.length} total`;
  }

  // 2. Advance the water surface: drop this frame's ripples, relax the
  // height field, then re-render the caustics pass (see
  // scene/causticsGenerator.js) off the freshly-stepped height field. The
  // caustics texture itself was bound to terrain/water/fish once at
  // construction (see createWorld) — only the water sim's own texture has to
  // be re-handed each frame, since it alternates between two ping-pong
  // targets rather than staying one object.
  emitRipples();
  waterSim.step();
  causticsGenerator.render(waterSim.texture);
  water.setWaterTexture(waterSim.texture);

  // 3. Sync the instanced fish mesh to the simulation's current fish array
  // (positions, headings, depth, swim-phase, species tint, caustic glow) —
  // only once the model has loaded. Everything else the fish shaders need is
  // resize-invariant and was pushed by setBounds() (see createWorld).
  if (fishRenderer) fishRenderer.update(flock.fish, t);

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

// ---------------------------------------------------------------------
// Boot. Ordered so every `let` above is initialized before anything reads
// it: build the bounds-shaped world, seed the timeline at day 0, start the
// loop, and let the fish models finish loading in the background.
// ---------------------------------------------------------------------
createWorld();
jumpToDay(0);
requestAnimationFrame(loop);

loadFishAssets()
  .then((assetsByUrl) => {
    fishRenderer = createFishInstancedMesh(
      assetsByUrl,
      MAX_POPULATION + FISH_RENDER_HEADROOM,
    );
    scene.add(fishRenderer.mesh);
    // createWorld()/applySeason() have both already run by now — the mesh
    // didn't exist yet to receive either, so hand it the current state.
    fishRenderer.setBounds(bounds, waterSize, depthRange);
    fishRenderer.setCausticsTexture(causticsGenerator.texture);
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
