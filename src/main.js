import { Flock, REMOVE_FADE_FRAMES } from "./boids.js";
import { runData } from "./data.js";
import { createSceneSetup } from "./scene/sceneSetup.js";
import {
  buildTerrainMesh,
  setTerrainSeason,
  riverDepth,
} from "./scene/terrain.js";
import { buildWaterMesh, waterWorldSize } from "./scene/water.js";
import { buildParticles } from "./scene/particles.js";
import { buildGodRays } from "./scene/godRays.js";
import { createWaterSimulation } from "./scene/waterSim.js";
import {
  createCausticsGenerator,
  CAUSTICS_TARGET_SIZE,
} from "./scene/causticsGenerator.js";
import { loadFishAssets, createFishInstancedMesh } from "./scene/fishMesh.js";
import {
  dayOfYear,
  setSunSeason,
  sweptSunDirection,
} from "./scene/season.js";
import { setFogSeason } from "./scene/fog.js";

const canvas = document.getElementById("river-canvas");

const dateLabel = document.getElementById("date-label");
const dayOrdinalLabel = document.getElementById("day-ordinal");
const playPauseBtn = document.getElementById("play-pause");
const timelineInput = document.getElementById("timeline");
const timelineAxis = document.getElementById("timeline-axis");
const fishCountLabel = document.getElementById("fish-count");
const speciesCountEls = {
  chinook: document.getElementById("count-chinook"),
  jackChinook: document.getElementById("count-jackChinook"),
  steelhead: document.getElementById("count-steelhead"),
  shad: document.getElementById("count-shad"),
};
const fishLoadingEl = document.getElementById("fish-loading");

// Reported but not simulated (see data.js). Keyed by the same field names the
// parser writes, so the loop below is a straight lookup.
const secondaryCountEls = new Map(
  [...document.querySelectorAll("#secondary-counts [data-field]")].map((el) => [
    el.dataset.field,
    el,
  ]),
);
const waterTempLabel = document.getElementById("water-temp");
const chinookRunLabel = document.getElementById("chinook-run");
const seasonTotalLabel = document.getElementById("season-total");
const chartPassagePath = document.getElementById("chart-passage");
const chartTempPath = document.getElementById("chart-temp");
const chartScaleLabel = document.getElementById("chart-scale");

// Writes a number into the HUD, guarded on the rendered string rather than
// the value: while playing these are re-derived every frame, but the
// interpolation below only crosses an integer every few frames, and an
// unchanged textContent assignment still dirties layout.
function setReadout(el, value) {
  const text = value.toLocaleString();
  if (el.textContent !== text) el.textContent = text;
}

// The HUD's counts "partway through day `idx`", where progress is 0 at the
// start of the day and 1 at the end.
//
// These are the real per-day DART numbers (see data.js), not
// flock.activeCount(): the simulated population is capped well below them for
// performance (see MAX_POPULATION), so it is not what a viewer wants to read
// as "how many fish passed today."
//
// The figures tick between one day and the next across the day rather than
// snapping at the boundary — the same linear interpolation
// desiredPopulation() uses to spawn fish in smoothly, wrapping onto day 0
// the same way, so the readout never disagrees with the school it describes.
// At progress 1 it is already showing tomorrow's figure, so when the day
// actually advances there is nothing left to jump.
//
// The total is summed from the four displayed species rather than
// interpolated on its own, so the column always adds up: `count` is exactly
// that sum in the source data (see parseDartCsv in data.js), but rounding
// four interpolated values independently and a fifth separately would let
// them disagree by a digit or two mid-day. Days with no breakdown at all —
// generatePlaceholderRun()'s fallback entries — have only `count`, and fall
// back to interpolating it.
function updateFishCountDisplay(idx, progress = 0) {
  const today = runData[idx];
  const tomorrow = runData[(idx + 1) % runData.length];
  const at = (key) =>
    Math.round(
      (today[key] ?? 0) + ((tomorrow[key] ?? 0) - (today[key] ?? 0)) * progress,
    );

  let total = 0;
  for (const key of Object.keys(speciesCountEls)) {
    const value = at(key);
    total += value;
    setReadout(speciesCountEls[key], value);
  }
  // Bare number: the HUD labels it (see index.html), the way a report column
  // is headed once rather than repeating its unit on every row.
  setReadout(fishCountLabel, today.chinook === undefined ? at("count") : total);

  // Species counted at the dam but not in the water (see data.js). Each row
  // hides itself on a day with none, rather than showing a zero: over a full
  // season most of these are zero most of the time, and five permanent zeroes
  // would read as broken instrumentation instead of as an absent species.
  for (const [field, el] of secondaryCountEls) {
    const value = at(field);
    el.hidden = value === 0;
    if (value !== 0) setReadout(el.querySelector("b"), value);
  }

  // Conditions. Temperature interpolates like the counts do — it is a real
  // continuous quantity, so a day-to-day ramp is honest — but only when both
  // ends of the interpolation actually exist. A null means DART published no
  // reading, and inventing one would be worse than showing nothing.
  const tempToday = today.tempC;
  const tempTomorrow = tomorrow.tempC;
  if (tempToday === null || tempToday === undefined) {
    waterTempLabel.textContent = "—";
  } else {
    const blended =
      tempTomorrow === null || tempTomorrow === undefined
        ? tempToday
        : tempToday + (tempTomorrow - tempToday) * progress;
    waterTempLabel.textContent = `${blended.toFixed(1)} °C`;
  }

  // Null outside the runs' scheduled windows, which is most of the winter.
  // Snaps at the day boundary rather than interpolating — it is a label, not
  // a measurement.
  chinookRunLabel.textContent = today.chinookRun ?? "—";

  setReadout(seasonTotalLabel, seasonToDate[idx]);
}

// The masthead's date line. Both halves move together, and three call sites
// used to set only the first — hence the one function.
//
// The ordinal counts position in the *record*, not day-of-year: DART only
// publishes rows for the dam's counting season (see data.js), so this is
// "day 172 of the 275 counted", which is what the timeline is actually
// indexing.
function setDateReadout(idx) {
  dateLabel.textContent = runData[idx].date;
  dayOrdinalLabel.textContent = `Rec ${idx + 1} / ${runData.length}`;
}

// Month ticks under the timeline, built once at boot. Positions come from
// runData rather than being spaced evenly, for the same reason the ordinal
// above is a record index: the season starts partway through March and the
// months are not equal fractions of the track.
const MONTH_ABBREVIATIONS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

// Running total of the four simulated species from the first counted day
// through day i — the figure a passage report actually leads with, since a
// single day's count says nothing about whether the run is large or small.
// Precomputed once: runData never changes after the fetch resolves.
const seasonToDate = (() => {
  const totals = new Float64Array(runData.length);
  let running = 0;
  for (let i = 0; i < runData.length; i++) {
    running += runData[i].count ?? 0;
    totals[i] = running;
  }
  return totals;
})();

// The whole season as one chart, drawn once at boot into the SVG in the HUD:
// daily passage as a filled area, water temperature as a line over it, both
// on the timeline's own x-axis so the scrubber's cursor reads against them.
//
// The two share an x-axis but not a y-axis — they are different quantities in
// different units, and forcing them onto one scale would be a lie. So each is
// normalized to its own range and the ranges are printed in the caption
// instead of drawn as axes, which at this size would cost more room than they
// return.
//
// Passage uses a square-root scale. Linear is the honest default and it was
// tried first, but the run is far too spiky for it: one 7,500-fish September
// day flattens the other three hundred into a line along the floor, so the
// chart shows a single spike and hides the shape of the season. The root
// keeps the peak where it belongs while leaving the shoulders legible, and
// the caption says so rather than passing it off as linear.
function buildSeasonChart() {
  const last = runData.length - 1;
  if (last <= 0) return;

  const x = (i) => ((i / last) * 1000).toFixed(2);

  const peak = Math.max(...runData.map((d) => d.count ?? 0), 1);
  const passageY = (value) => (100 - Math.sqrt(value / peak) * 100).toFixed(2);

  // Closed at both bottom corners so it fills as an area rather than reading
  // as a second line.
  const area = [`M 0 100`];
  for (let i = 0; i <= last; i++) {
    area.push(`L ${x(i)} ${passageY(runData[i].count ?? 0)}`);
  }
  area.push("L 1000 100 Z");
  chartPassagePath.setAttribute("d", area.join(" "));

  const temps = runData.map((d) => d.tempC).filter((t) => typeof t === "number");
  if (temps.length < 2) {
    chartScaleLabel.textContent = `Peak ${peak.toLocaleString()} / day · √ scale`;
    return;
  }
  const minTemp = Math.min(...temps);
  const maxTemp = Math.max(...temps);
  const span = maxTemp - minTemp || 1;
  // Inset from the top and bottom edges so the line never sits exactly on the
  // frame, where it would be indistinguishable from a border.
  const tempY = (value) => (92 - ((value - minTemp) / span) * 84).toFixed(2);

  // Days with no reading break the line rather than being bridged: a straight
  // segment across a gauge outage would invent a trend that was never
  // measured. `M` after a gap starts a new subpath.
  let penDown = false;
  const line = [];
  for (let i = 0; i <= last; i++) {
    const t = runData[i].tempC;
    if (typeof t !== "number") {
      penDown = false;
      continue;
    }
    line.push(`${penDown ? "L" : "M"} ${x(i)} ${tempY(t)}`);
    penDown = true;
  }
  chartTempPath.setAttribute("d", line.join(" "));

  chartScaleLabel.textContent =
    `Peak ${peak.toLocaleString()} / day · √ scale · ` +
    `${minTemp.toFixed(1)}–${maxTemp.toFixed(1)} °C`;
}

function buildTimelineAxis() {
  const last = runData.length - 1;
  if (last <= 0) return;

  const marks = [];
  let previousMonth = -1;
  for (let i = 0; i <= last; i++) {
    // "YYYY-MM-DD" (see parseDartCsv in data.js).
    const month = Number(runData[i].date.slice(5, 7)) - 1;
    if (month === previousMonth || !MONTH_ABBREVIATIONS[month]) continue;
    previousMonth = month;
    const percent = ((i / last) * 100).toFixed(3);
    marks.push(
      `<i style="left:${percent}%"><b>${MONTH_ABBREVIATIONS[month]}</b></i>`,
    );
  }
  // Only ever the fixed abbreviations above and numbers derived from the
  // array index — nothing off the network reaches this string.
  timelineAxis.innerHTML = marks.join("");
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
// The simulation clock.
//
// Pause used to stop only the timeline: the flock kept swimming, the water
// kept rippling and the sun kept crossing the sky, so the one thing that
// didn't advance was the date. This is the clock everything time-driven now
// reads instead of the rAF timestamp — the fish bob, the tailbeats, the silt
// drift, the shaft sway and the sun's daily arc — and it only accumulates
// while `isPlaying`. Pause is a freeze-frame.
//
// It has to be a separate accumulator rather than an offset subtracted from
// `t`, because the render loop keeps running while paused (the canvas still
// has to repaint, and resize still has to work) and would otherwise resume
// having skipped however long the pause lasted.
// ---------------------------------------------------------------------
let simTime = 0;
let lastFrameTime = null;

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
let particles;
let godRays;
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

  terrainMesh = buildTerrainMesh(bounds);

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
  // sim's live height field. The riverbed is the surface the refracted light
  // is marched against, but it no longer displays the result (see terrain.js)
  // — the caustics you can actually see are on the water surface and the fish.
  causticsGenerator = createCausticsGenerator(renderer, bounds, terrainMesh);

  water = buildWaterMesh(bounds, CAUSTICS_TARGET_SIZE);

  // Suspended silt and the light shafts coming down through the surface (see
  // particles.js/godRays.js). Both are placed relative to the fixed camera and
  // both read the caustics texture, so they belong to the same lifecycle as
  // everything else here.
  particles = buildParticles(bounds, camera.position, cameraTarget);
  godRays = buildGodRays(bounds, camera.position, cameraTarget);

  // The caustics render target is reused every frame, so its texture object
  // never changes identity — bind it once here rather than re-assigning the
  // same object to the same uniforms 60 times a second. (The water sim's own
  // texture genuinely does alternate between two ping-pong targets, so that
  // one still has to be handed over per frame — see the render loop.)
  water.setCausticsTexture(causticsGenerator.texture);
  particles.setCausticsTexture(causticsGenerator.texture);
  godRays.setCausticsTexture(causticsGenerator.texture);
  particles.setWorldSize(waterSize, bounds);
  godRays.setWorldSize(waterSize, bounds);
  particles.setSeason(currentDayOfYear);
  godRays.setSeason(currentDayOfYear);

  setTerrainSeason(terrainMesh, currentDayOfYear);
  water.setSeason(currentDayOfYear);
  // The caustics pass needs a sun before its first render(): the loop pushes
  // one every frame, but createWorld() runs ahead of the first frame, and on a
  // resize rebuild it runs with a brand-new generator whose light uniform is
  // still at its constructed default.
  //
  // Then one render right here, rather than leaving it to the loop, because
  // the loop's own caustics pass is gated on `isPlaying` — resize the window
  // while paused and this brand-new target would otherwise stay empty, and
  // the water surface and fish would lose their glints until playback
  // resumed.
  causticsGenerator.setSunDirection(sweptSunDirection(simTime * 0.001));
  causticsGenerator.render(waterSim.texture);

  // Everything the fish shaders derive from bounds — fog density, the two
  // depth-attenuation rates, and the world->sim UV mapping. Only changes on
  // resize, so it's pushed here rather than recomputed inside the per-frame
  // update(). Null until the models finish loading, which re-pushes it.
  fishRenderer?.setBounds(bounds, waterSize, depthRange, camera.position);
  fishRenderer?.setCausticsTexture(causticsGenerator.texture);

  scene.add(terrainMesh, water.mesh, particles.mesh, godRays.mesh);
}

// Old GPU resources are disposed before their replacements are created to
// avoid leaking memory across a resize.
function destroyWorld() {
  scene.remove(terrainMesh, water.mesh, particles.mesh, godRays.mesh);
  terrainMesh.geometry.dispose();
  terrainMesh.material.dispose();
  water.mesh.geometry.dispose();
  water.mesh.material.dispose();
  waterSim.dispose();
  causticsGenerator.dispose();
  particles.dispose();
  godRays.dispose();
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
  particles.setSeason(currentDayOfYear);
  godRays.setSeason(currentDayOfYear);
  fishRenderer?.setSeason(currentDayOfYear);
  // The season fixes where the sun sits at its daily high point; the render
  // loop sweeps it either side of that (see sweptSunDirection in season.js).
  // Like setFogSeason above, this takes no target — season.js holds the sun
  // itself, and the loop asks it for the current one.
  setSunSeason(currentDayOfYear);
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
// Frames a simulated day is given before the timeline advances. 40 -> 80 ->
// 240: at 60fps that is four seconds a day, and a little over twenty minutes
// for the whole counting season.
//
// The last tripling is for the HUD. Now that the day's figures count toward
// tomorrow's across the day (see updateFishCountDisplay) rather than snapping
// at midnight, the readout is something to actually watch, and at 80 frames
// the numbers moved too fast to follow. It also stretches the spawn ramp that
// shares this progress value, so the school fills in and thins out more
// gradually.
const FRAMES_PER_DAY = 240;

timelineInput.max = String(runData.length - 1);
buildTimelineAxis();
buildSeasonChart();

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

// Scrubbing the timeline jumps straight to a day: spawn/remove fish until the
// population matches that day's target, then reset the per-day animation
// state (frame counter, spawn accumulator, speed, HUD).
//
// Spawns still fade in over their first frames (see boids.js). Removals used
// to fade out too, but scrubbing pauses playback and a paused flock never
// steps, so there is nothing left to drive that fade — see the note at the
// removeActive() call below.
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
  if (active > target) {
    flock.removeActive(active - target);
    // removeActive() only *flags* fish, and Flock.step() is what fades and
    // then drops them — but scrubbing pauses playback, so step() is not going
    // to run. Without this the flagged fish would hang at full opacity
    // forever and the school would visibly disagree with the count the HUD
    // just wrote. A hard cut is right here anyway: nothing else in the frame
    // is animating for a fade to be visible against.
    if (!isPlaying) flock.finalizeRemovals();
  }

  dayIndex = idx;
  frameCounter = 0;
  spawnAccumulator = 0;
  applyDaySpeed(idx);
  setDateReadout(idx);
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

// Parity counter for the half-rate caustics pass — see the render loop.
let causticsFrame = 0;

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
  // Advance the simulation clock (see its declaration above). Everything
  // below that moves reads `simTime`, never `t`, so pausing stops the whole
  // scene rather than just the date.
  if (lastFrameTime !== null && isPlaying) simTime += t - lastFrameTime;
  lastFrameTime = t;
  const seconds = simTime * 0.001;

  // 1. Advance the flocking simulation one tick. The HUD's fish counts are
  // driven by the real per-day DART data instead (see
  // updateFishCountDisplay), not this simulated count, so nothing here
  // needs to run every frame — only when dayIndex actually changes (see
  // jumpToDay and the day-rollover below).
  if (isPlaying) flock.step(1);

  sceneSetup.updateCamera();

  if (!debugPanel.hidden) {
    const dist = camera.position.distanceTo(cameraTarget);
    debugPanel.textContent =
      `distance to target: ${dist.toFixed(1)}\n` +
      `camera: (${camera.position.x.toFixed(0)}, ${camera.position.y.toFixed(0)}, ${camera.position.z.toFixed(0)})\n` +
      `target: (${cameraTarget.x.toFixed(0)}, ${cameraTarget.y.toFixed(0)}, ${cameraTarget.z.toFixed(0)})\n` +
      `bounds: ${bounds.width.toFixed(0)} x ${bounds.height.toFixed(0)}\n` +
      `camera.far: ${camera.far.toFixed(0)}\n` +
      `fish: ${flock.activeCount()} active / ${flock.fish.length} total\n` +
      `drawn: ${fishRenderer?.renderedCount() ?? 0} instances`;
  }

  // 2. Advance the water surface: drop this frame's ripples, relax the
  // height field, then re-render the caustics pass (see
  // scene/causticsGenerator.js) off the freshly-stepped height field. The
  // caustics texture itself was bound to terrain/water/fish once at
  // construction (see createWorld) — only the water sim's own texture has to
  // be re-handed each frame, since it alternates between two ping-pong
  // targets rather than staying one object.
  // Gated on play, so a paused frame holds its ripples exactly where they
  // are. setWaterTexture stays outside: the sim only swaps ping-pong targets
  // when it steps, so re-handing the same one costs nothing, and it keeps the
  // surface correct if the world is rebuilt (a resize) while paused.
  if (isPlaying) {
    emitRipples();
    waterSim.step();
  }
  water.setWaterTexture(waterSim.texture);

  // Walk the sun along the day's arc and hand the same direction to everything
  // that needs to agree on where the light is: the disc in the sky, the
  // refraction the caustics pass traces, and the shafts tracing back up to
  // their surface entry points. Pushed before the caustics render below so the
  // net this frame accumulates is the one belonging to this frame's sun.
  //
  // This is what makes the shafts sweep instead of standing still — see
  // sweptSunDirection in season.js for why moving the sun (rather than the
  // shafts) is the thing that does it.
  const sun = sweptSunDirection(seconds);
  sceneSetup.setSunDirection(sun);
  causticsGenerator.setSunDirection(sun);
  godRays.setSunDirection(sun);

  // The caustics accumulation pass is the most expensive thing in the frame
  // after the fish — a 256x256 grid whose vertex shader ray-marches the
  // environment map up to 40 steps per vertex. It runs at half rate because
  // the thing it is tracking barely moves: the water sim damps at 0.9975 and
  // gets a drop every 30 frames (see AMBIENT_DROP_INTERVAL_FRAMES), so the
  // light net is a slow swell, not something with per-frame detail to lose.
  //
  // Deliberately NOT applied to waterSim.step() as well. That is a discrete
  // wave equation stepped once per frame, so halving its rate would halve the
  // propagation speed of every ripple — a change to how the water behaves,
  // not just how often it is sampled.
  //
  // Also gated on play: with the water frozen and the sun stopped, the net it
  // would produce is identical to the one already in the target. createWorld()
  // renders it once directly, so a resize while paused still gets a valid net
  // rather than an empty one.
  if (isPlaying && causticsFrame++ % 2 === 0) {
    causticsGenerator.render(waterSim.texture);
  }

  // 3. Sync the instanced fish mesh to the simulation's current fish array
  // (positions, headings, depth, swim-phase, species tint, caustic glow) —
  // only once the model has loaded. Everything else the fish shaders need is
  // resize-invariant and was pushed by setBounds() (see createWorld).
  //
  // Still called while paused — a resize rebuilds depthRange and the cull
  // distances, and the instance buffers have to be rewritten against them
  // even with the fish standing still. `isPlaying` is passed through so the
  // tailbeat can keep running at a fraction of its rate through a pause while
  // everything else holds; see PAUSED_SWIM_RATE in fishMesh.js.
  if (fishRenderer) fishRenderer.update(flock.fish, simTime, isPlaying);

  // Silt drift and shaft sway are driven entirely from this one uniform each
  // — see particles.js for why nothing per-mote happens on the CPU.
  particles.update(seconds);
  godRays.update(seconds);

  renderScene();

  // 4. Population pacing: while playing, continuously spawn fish so the
  // count tracks `desiredPopulation`'s smooth ramp (rather than snapping),
  // and advance to the next day once this day's frame budget is spent.
  if (isPlaying) {
    const progress = frameCounter / FRAMES_PER_DAY;

    // Tick the HUD's figures toward tomorrow's across the day, on the same
    // `progress` the spawn ramp below runs on — so the readout climbs at the
    // rate the school is actually filling in rather than announcing the whole
    // day's change in one step at midnight.
    updateFishCountDisplay(dayIndex, progress);

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
      setDateReadout(dayIndex);
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
    fishRenderer.setBounds(bounds, waterSize, depthRange, camera.position);
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
