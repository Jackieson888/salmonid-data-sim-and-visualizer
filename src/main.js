import { Flock, REMOVE_FADE_FRAMES } from "./boids.js";
import { runData } from "./data.js";
import { seasonFraction } from "./seasonScale.js";
import { initPlates, setPlatesDay, updatePlatesToday } from "./plates.js";
import { createSceneSetup } from "./scene/sceneSetup.js";
import {
  buildTerrainMesh,
  setTerrainSeason,
  riverDepth,
} from "./scene/terrain.js";
import {
  buildWaterMesh,
  waterWorldSize,
  causticsWorldSize,
} from "./scene/water.js";
import { buildParticles } from "./scene/particles.js";
import { buildGodRays } from "./scene/godRays.js";
import { createWaterSimulation } from "./scene/waterSim.js";
import {
  createCausticsGenerator,
  causticsTargetSize,
} from "./scene/causticsGenerator.js";
import { loadFishAssets, createFishInstancedMesh } from "./scene/fishMesh.js";
import {
  dayOfYear,
  setSunSeason,
  sweptSunDirection,
} from "./scene/season.js";
import { setFogSeason } from "./scene/fog.js";
import {
  QUALITY,
  qualityTier,
  qualityReason,
  qualityForced,
  createPerfGovernor,
} from "./quality.js";

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
const noticeEl = document.getElementById("notice");

// Surfaces a real failure to the viewer instead of only to the console. Kept
// deliberately small: this scene has exactly two things that can fail in a way
// someone watching would notice and be able to act on — the fish assets not
// loading, and an opted-in live data refresh not arriving — and both are
// recoverable enough that a reload is genuine advice rather than a shrug.
function showNotice(message, kind = "error") {
  if (!noticeEl) return;
  noticeEl.textContent = message;
  noticeEl.className = kind;
  noticeEl.hidden = false;
}

// Fades the loading overlay out and then drops it from the DOM.
//
// The removal is NOT left to transitionend alone. That event does not fire at
// all if the element is already at its target opacity, if the tab is
// backgrounded when the class lands, or if a user agent honouring
// prefers-reduced-motion has zeroed the duration — and in every one of those
// cases the overlay would sit there dimming the finished scene forever. The
// timeout is the actual guarantee; the event just makes it prompt.
function dismissLoadingOverlay() {
  if (!fishLoadingEl || !fishLoadingEl.isConnected) return;
  fishLoadingEl.classList.add("hidden");
  const remove = () => fishLoadingEl.remove();
  fishLoadingEl.addEventListener("transitionend", remove, { once: true });
  setTimeout(remove, 1200);
}

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
// performance (see maxPopulation()), so it is not what a viewer wants to read
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
// them disagree by a digit or two mid-day. The `?? 0` guards are what keep
// this honest against a row missing a column — DART's column set has changed
// between years (see parseDartCsv), so a future year could legitimately arrive
// without one of these.
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

  // Species counted at the dam but not in the water, plus the wild/hatchery
  // steelhead split (see data.js) — reported in the plates drawer rather than
  // the bar itself now (see plates.js). No-ops until the drawer has actually
  // been opened once and built its figures.
  updatePlatesToday(at);

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

  const x = (i) => (seasonFraction(i, last) * 1000).toFixed(2);

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
    const percent = (seasonFraction(i, last) * 100).toFixed(3);
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
//
// `bounds` (the world) and `pixelBounds` (the actual browser viewport) used
// to be the same object — every world unit was exactly one CSS pixel. They
// are split now so the river can be smaller than the window: WORLD_SCALE
// shrinks `bounds` on both axes, camera framing/fog/terrain/water/the flock
// all read the smaller `bounds` and are none the wiser, and `pixelBounds`
// alone reaches sceneSetup's renderer/composer sizing, so the canvas still
// fills the real viewport at full resolution. Fish are the one thing whose
// absolute size (BODY_VISUAL_SCALE, in boids.js) does NOT scale down with
// `bounds` — that's deliberate, and it's the entire effect: relative to a
// smaller river, a fish of the same real-world size reads as bigger and the
// channel reads as more full, so a smaller simulated population still holds
// the shot, which is the performance win (fewer flocked, shaded, VAT-sampled
// instances) and the visual one (a tighter, more intimate river) both at
// once. Since both axes scale by the same factor, `bounds`' aspect ratio
// always matches `pixelBounds`', so nothing about the framing distorts.
// ---------------------------------------------------------------------
const WORLD_SCALE = 0.55;


let pixelBounds = { width: window.innerWidth, height: window.innerHeight };
let bounds = {
  width: pixelBounds.width * WORLD_SCALE,
  height: pixelBounds.height * WORLD_SCALE,
};

const sceneSetup = createSceneSetup(canvas, pixelBounds, bounds);
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
// From the device tier (see quality.js). The relax pass does seven texture
// fetches per texel every frame, so this is quadratic in cost: 600^2 was ~2.5M
// fetches a frame, and 600 is not even a power of two — the high tier's 512
// drops 27% of them for no visible change in the height field. At the low tier
// it is 0 and the simulation is not constructed at all; the surface and the
// caustics both switch to the procedural stand-ins in glsl.js.
const waterSimSize = () => QUALITY.waterSimSize;

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
// The caustics pass's own, shorter world coverage. Separate from waterSize
// because they answer different questions: waterSize is how much PLANE has to
// be drawn for its edges to dissolve into fog, causticsSize is how far light
// is still legible. See causticsWorldSize in water.js.
let causticsSize;
let terrainMesh;
let particles;
let godRays;
let depthRange;
let waterSim;
let causticsGenerator;
let water;

function createWorld() {
  // The sim actually covers a bigger area than the river bounds (see
  // waterWorldSize()/waterSizeMultiplier() in water.js) so ripples can
  // propagate all the way out to the water plane's faded edges instead of
  // the edge texel just clamping/stretching across that whole margin.
  waterSize = waterWorldSize(bounds);
  // Depends on the camera as well as on bounds — it is centered on what the
  // eye is actually looking through, not on the river's middle.
  causticsSize = causticsWorldSize(bounds, camera.position, cameraTarget);

  terrainMesh = buildTerrainMesh(bounds);

  // Depth range fish swim within: a little below the surface down to just
  // above the riverbed floor. See boids.js's fish.depth and fishMesh.js.
  depthRange = { surfaceY: -8, floorY: -riverDepth(bounds) + 6 };

  // The water simulation and the caustics generator are the two most expensive
  // things in this scene, and at the low tier neither one is built (see
  // quality.js). Everything that reads them switches to the procedural
  // stand-ins in glsl.js, chosen when each material is compiled — so there is
  // no per-frame branch anywhere downstream, only these two nulls.
  //
  // They are nulled rather than stubbed because, unlike particles/godRays,
  // they are not scene objects with a uniform interface — the loop has to skip
  // stepping and rendering them, which is a real difference in what the frame
  // does rather than a no-op call.
  if (QUALITY.realCaustics) {
    waterSim = createWaterSimulation(
      renderer,
      waterSimSize(),
      waterSize.height / waterSize.width,
    );

    // Real-time caustics (see scene/causticsGenerator.js, ported from
    // martinRenou/threejs-caustics) — recomputed every frame from the water
    // sim's live height field. The riverbed is the surface the refracted light
    // is marched against, but it no longer displays the result (see terrain.js)
    // — the caustics you can actually see are on the water surface and the fish.
    causticsGenerator = createCausticsGenerator(
      renderer,
      bounds,
      terrainMesh,
      causticsSize,
    );
  } else {
    waterSim = null;
    causticsGenerator = null;
  }

  water = buildWaterMesh(bounds, causticsTargetSize() || 1, causticsSize);

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
  //
  // Null at the low tier, which is harmless: those materials were compiled
  // against the procedural path, so the sampler is dead code the shader
  // compiler drops, and three never looks the uniform up.
  const causticsTexture = causticsGenerator?.texture ?? null;
  water.setCausticsTexture(causticsTexture);
  particles.setCausticsTexture(causticsTexture);
  godRays.setCausticsTexture(causticsTexture);
  particles.setWorldSize(causticsSize, bounds);
  godRays.setWorldSize(causticsSize, bounds);
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
  causticsGenerator?.setSunDirection(sweptSunDirection(simTime * 0.001));
  if (causticsGenerator) causticsGenerator.render(waterSim.texture);

  // Everything the fish shaders derive from bounds — fog density, the two
  // depth-attenuation rates, and the world->sim UV mapping. Only changes on
  // resize, so it's pushed here rather than recomputed inside the per-frame
  // update(). Null until the models finish loading, which re-pushes it.
  fishRenderer?.setBounds(bounds, causticsSize, depthRange, camera.position);
  fishRenderer?.setCausticsTexture(causticsTexture);


  // Explicit transparency layering (see the matching note on fishRenderer's
  // InstancedMesh in fishMesh.js for why this has to be explicit rather than
  // left to THREE's automatic sort): terrain (the riverbed, farthest from a
  // camera that sits well up off the bottom) behind water (the Y=0 ceiling,
  // usually farther than the fish swimming beneath it) behind fish (2 — set
  // in fishMesh.js, since this function only reaches these four) behind the
  // silt/shafts, which drift through the whole column and read best as a
  // hazy overlay on top of everything solid.
  terrainMesh.renderOrder = 0;
  water.mesh.renderOrder = 1;
  particles.mesh.renderOrder = 3;
  godRays.mesh.renderOrder = 3;
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
  // Both are null at the low tier — see createWorld.
  waterSim?.dispose();
  causticsGenerator?.dispose();
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

// Re-applies the whole scene at a new device tier, after the governor has
// decided the current one isn't holding frame rate (see quality.js).
//
// Everything scaled by the tier is fixed when a resource is constructed —
// render-target sizes, geometry segment counts, instance capacity, which
// caustics path is compiled into each material, whether the bloom pass exists
// at all — so the only way to change it is to build it again. That is a real
// stall of a few frames, which is why the governor is deliberately slow to
// trigger and never reverses itself.
//
// The order matters: the renderer's pixel ratio and the composer come first
// (sceneSetup owns those), then the bounds-shaped world, then the fish, which
// read the freshly-built caustics texture.
function applyTier() {
  sceneSetup.applyQuality(pixelBounds, bounds);
  rebuildWorld();
  buildFishRenderer();

  // Re-derive the per-day population targets against the new cap, BEFORE the
  // trim below. Without this the trim was cosmetic: it cut the live flock, and
  // the pacing loop refilled it moments later against targets still scaled to
  // the tier the page booted at. See rebuildDayTables for the full shape of
  // that bug — it made the governor's single biggest lever a no-op.
  rebuildDayTables();

  // Bring the live population down to the new cap immediately rather than
  // waiting for fish to drain out through the exit line. The pacing loop only
  // ever adds fish (see the render loop), so without this a downgrade would
  // leave the flock above its new ceiling for as long as it took the run to
  // turn over — which is exactly the interval the downgrade was meant to fix.
  const excess = flock.activeCount() - maxPopulation();
  if (excess > 0) flock.removeActive(excess);
}

// Always created, so the debug panel has a frame time to show. When a tier is
// forced via ?quality= it is handed a null callback: it keeps measuring but
// never acts, so A/B testing a tier on desktop isn't immediately overridden by
// the governor deciding otherwise.
const governor = createPerfGovernor(qualityForced() ? null : applyTier);

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
// The ceiling was documented here as vertex-bound, on the basis that the mesh
// is ~1300 vertices and 1200 fish therefore cost ~2M vertex shader invocations
// a frame. That figure was wrong. steelhead-final.glb's POSITION accessor holds
// **435** vertices (654 triangles), so the flock is ~522K invocations — a
// quarter of what the old note claimed, and comfortably not the most expensive
// thing in the frame. The caustics pass and the water simulation each cost far
// more (see quality.js), which is why they are what the tiers cut first and
// why the fish LOD the README lists as a next step is not the win it looks
// like.
//
// What this number actually bounds is fill rate and CPU: every fish is a
// transparent, blended, sorted draw, and the flocking simulation walks the
// whole array four times a step. Both scale with the tier, hence the table in
// quality.js rather than a constant here.
const maxPopulation = () => QUALITY.population;

// Extra instance slots each species renderer gets on top of maxPopulation().
//
// maxPopulation() bounds the *active* fish, but flock.fish also holds fish
// that have crossed the exit line and are still fading out over
// REMOVE_FADE_FRAMES (see boids.js). Sizing renderer capacity to
// maxPopulation() alone meant those pushed the array past capacity and the
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

// The baked per-URL GLB assets (geometry + VAT + texture), held from the one
// load so the renderers can be rebuilt without re-fetching or re-baking.
let fishAssets = null;

// Builds (or rebuilds) the instanced fish renderers against the current tier.
//
// This has to be a rebuild rather than an in-place adjustment because the
// caustics path — real texture sample or procedural stand-in — is compiled
// into the material (see causticGlowChunk in glsl.js), and instance capacity
// is fixed when the InstancedMesh is allocated. Both change with the tier.
//
// Safe to call before the assets resolve; it simply does nothing until then.
function buildFishRenderer() {
  if (!fishAssets) return;

  if (fishRenderer) {
    scene.remove(fishRenderer.mesh);
    fishRenderer.dispose();
  }

  fishRenderer = createFishInstancedMesh(
    fishAssets,
    maxPopulation() + FISH_RENDER_HEADROOM,
  );
  scene.add(fishRenderer.mesh);
  // createWorld()/applySeason() have both already run by the first call — the
  // mesh didn't exist yet to receive either, so hand it the current state.
  fishRenderer.setBounds(bounds, causticsSize, depthRange, camera.position);
  fishRenderer.setCausticsTexture(causticsGenerator?.texture ?? null);
  fishRenderer.setSeason(currentDayOfYear);
}

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

// Mobile browsers fire `resize` when their own chrome slides in or out — the
// address bar collapsing on scroll, the toolbar reappearing on a tap. Those
// events change the height by roughly a chrome bar and the width by nothing,
// and treating them as real viewport changes means a full world rebuild
// (terrain, water planes, both caustics targets, the sim's ping-pong pair)
// every time a finger moves. The scene visibly hitches for something the user
// did not do.
//
// So a height-only change smaller than this is absorbed: the canvas is
// re-sized to fill the new viewport, but `bounds` is left alone and nothing
// downstream of it is rebuilt. The threshold is above a typical mobile
// address bar (~56-100 CSS px) and well below any deliberate resize.
const CHROME_BAR_THRESHOLD_PX = 120;
let lastViewport = { width: window.innerWidth, height: window.innerHeight };

window.addEventListener("resize", () => {
  const width = window.innerWidth;
  const height = window.innerHeight;
  const widthChanged = width !== lastViewport.width;
  const heightDelta = Math.abs(height - lastViewport.height);
  const isBrowserChrome =
    !widthChanged && heightDelta > 0 && heightDelta < CHROME_BAR_THRESHOLD_PX;
  lastViewport = { width, height };

  pixelBounds = { width, height };
  // The cheap half runs on every event regardless, so the canvas never looks
  // stretched — that includes the chrome-bar case, where the viewport really
  // has changed even though the simulated world should not.
  if (!isBrowserChrome) {
    bounds = {
      width: pixelBounds.width * WORLD_SCALE,
      height: pixelBounds.height * WORLD_SCALE,
    };
  }
  sceneSetup.resize(pixelBounds, bounds);

  if (isBrowserChrome) return;

  clearTimeout(rebuildTimer);
  rebuildTimer = setTimeout(() => {
    // The composer's ~13 render targets are reallocated here rather than on
    // every event — see resizeComposer in sceneSetup.js.
    sceneSetup.resizeComposer(pixelBounds);
    rebuildWorld();
  }, REBUILD_DEBOUNCE_MS);
});

// Was 2.4 — halved so a fish's spawn-to-exit crossing takes roughly twice as
// long (see FRAMES_PER_DAY below, doubled to match), giving more time to
// actually watch individual fish swim through the scene instead of them
// blowing past in a couple seconds.
//
// Scaled by WORLD_SCALE on top of that halving, for the same reason: crossing
// distance (bounds.width) just shrank by WORLD_SCALE, and a fish's absolute
// swim speed did not previously depend on how big the river was, so left
// alone it would now cross in WORLD_SCALE as many frames — the same "blowing
// past in a couple seconds" problem the halving above already fixed once.
// This keeps crossing TIME where it was tuned, at the cost of the fish now
// swimming slower in raw world-units/frame — which is invisible on its own,
// since nothing else in the sim reads an absolute speed independent of the
// bounds it's crossing.
const BASE_MAX_SPEED = 1.2 * WORLD_SCALE;

const flock = new Flock(bounds, {
  maxSpeed: BASE_MAX_SPEED,
  perceptionRadius: 70,
  // Was 20, then 45. 20 was well under a fish's actual rendered body length
  // (~72-105 world units, fish.length * boids.js's BODY_VISUAL_SCALE), so the
  // separation force's steady state let meshes clip well before this force
  // pushed back hard.
  //
  // 45 overcorrected in a way that was easy to miss, because it was chosen to
  // sit "close to" Flock.step's overlap-resolution clearance — and close is
  // exactly wrong. That clearance is at most
  // (44 + 44) * 0.5 * BODY_VISUAL_SCALE * OVERLAP_CLEARANCE ≈ 42.2 for two
  // large Chinook, so a separation radius of 45 gave the soft force a working
  // band under three units wide before the hard positional correction took
  // over. The stated intent — soft force does most of the work, hard
  // correction is a rare safety net — needs the opposite: a wide margin
  // between where steering starts pushing back and where the sim gives up and
  // moves fish bodily, since only the first of those two turns the fish to
  // face where it is going.
  //
  // 65 gives that force about 23 units of approach to work across instead of
  // 3. It is deliberately just UNDER perceptionRadius below and must stay
  // there: Flock.step only ever examines neighbours inside perceptionRadius
  // (its spatial grid is sized to exactly that, so nothing beyond it is even
  // found), and a separationRadius above it would silently clamp to it while
  // reading as though it were doing something more.
  separationRadius: 65,
});

// ---------------------------------------------------------------------
// Run timeline — ported unchanged from the Canvas2D version. All of this
// is dimension-agnostic: it only ever touches flock.fish.length/bounds,
// never rendering, so the 3D migration doesn't change any of it.
// ---------------------------------------------------------------------
let dayIndex = 0;
// A full-screen animated scene is the clearest case there is for honouring
// this: the whole page is motion, and there is no way to opt out of it once it
// starts. So it boots HELD rather than running — the first frame is rendered
// and the river is fully composed, it simply is not advancing, and Play (or
// Space) starts it. Nobody who wants the animation is prevented from having
// it; nobody who asked not to be moved is moved without asking.
//
// Deliberately read once at boot rather than watched: flipping the OS setting
// mid-session should not yank a running simulation out from under someone.
const PREFERS_REDUCED_MOTION =
  typeof matchMedia === "function" &&
  matchMedia("(prefers-reduced-motion: reduce)").matches;

let isPlaying = !PREFERS_REDUCED_MOTION;
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
// maxPopulation() above): a day over the cap has every species multiplied by
// one shared factor, so each keeps its exact share and only the absolute
// number shrinks. A day already under the cap passes through untouched.
// Counts stay fractional after scaling — deliberately, since they're only
// ever used as weights or summed before rounding.
// ---------------------------------------------------------------------
const dayTargets = new Int32Array(runData.length);
const dayWeights = new Float64Array(runData.length * SPECIES_KEYS.length);

// Precomputed day-over-day change in target population, one entry per day,
// used by applyDaySpeed to make the school swim faster/slower as the run
// ramps up or tapers off. Derived from dayTargets, so it is rebuilt with it.
const dailyRateOfChange = new Int32Array(runData.length);

// (Re)fills all three tables against the CURRENT tier's population cap.
//
// This has to be re-runnable, and for a long time it wasn't — it was
// straight-line code at module scope, evaluated once against whatever tier
// detection guessed at boot. The performance governor's whole job is to
// correct that guess (see quality.js), and `population` is the biggest lever
// it has, but a downgrade only ever trimmed the LIVE flock: applyTier() cut
// the excess, and then the pacing loop immediately refilled it against these
// stale, higher targets. Within a second or two the flock was back over the
// new cap and the downgrade had bought nothing at all.
//
// Worse, it was quietly destructive. The fish renderers are rebuilt at the new
// tier during the same applyTier(), so their instance capacity is
// maxPopulation() + FISH_RENDER_HEADROOM at the LOW figure while the flock
// refilled to the high one — and the overflow was silently dropped from the
// draw.
//
// The arrays are sized off runData.length, which never changes after the fetch
// resolves, so they stay `const` and are filled in place. Anything holding a
// reference to them keeps seeing current values.
function rebuildDayTables() {
  const cap = maxPopulation();

  for (let i = 0; i < runData.length; i++) {
    const day = runData[i];
    let total = 0;
    for (const key of SPECIES_KEYS) total += day[key] ?? 0;

    const scale = total > cap ? cap / total : 1;
    const base = i * SPECIES_KEYS.length;
    let cumulative = 0;
    for (let s = 0; s < SPECIES_KEYS.length; s++) {
      cumulative += (day[SPECIES_KEYS[s]] ?? 0) * scale;
      dayWeights[base + s] = cumulative;
    }

    // Falls back to the day's plain `count`, still capped, when there's no
    // species breakdown at all. Rounded because callers compare it against
    // integer fish counts, and a fractional target would never be reachable.
    dayTargets[i] =
      total > 0 ? Math.round(cumulative) : Math.min(cap, Math.round(day.count ?? 0));
  }

  for (let i = 0; i < runData.length; i++) {
    dailyRateOfChange[i] = i === 0 ? 0 : dayTargets[i] - dayTargets[i - 1];
  }
}

rebuildDayTables();

// ---------------------------------------------------------------------
// Diurnal arrival shape
//
// Fish don't pass a dam evenly around the clock: ladder passage is a daytime
// affair, thin around first light, heaviest through the middle of the day,
// tapering off again toward dusk. The day's arrivals used to ignore that
// entirely — desiredPopulation() interpolated linearly, so the whole day's
// change came in at one flat rate — and since the scene already sweeps the
// sun across each simulated day (see sweptSunDirection in season.js), a flat
// arrival rate was visibly at odds with the light.
//
// DIURNAL_BASELINE is what keeps this a hump rather than an on/off switch. A
// bare raised cosine falls to zero at both ends of the day, which would empty
// the upstream edge for the first and last stretch of every single day. So
// the rate is a blend: a flat baseline running all day, plus the mid-day hump
// on top of it. At 0.3 the middle of the day runs ~5.7x the rate of the
// edges — an unmistakable mid-day peak that still has fish swimming in early
// and late.
const DIURNAL_BASELINE = 0.3;

// Relative arrival rate at `progress` through the day, normalized to average
// exactly 1.0 across the day: this redistributes *when* a day's fish arrive
// without changing how many do.
function diurnalRate(progress) {
  return (
    DIURNAL_BASELINE +
    (1 - DIURNAL_BASELINE) * (1 - Math.cos(2 * Math.PI * progress))
  );
}

// diurnalRate integrated from 0 to `progress` — the fraction of the day's
// arrivals that have come in by then, rising 0 -> 1 across the day. This is
// the easing curve the population ramp below runs on, and it's what turns a
// day's growth from a straight line into ease-in, rush through midday,
// ease-out. Closed form rather than numerically integrated: the only term
// with any shape to it is a cosine.
function diurnalProgress(progress) {
  return (
    DIURNAL_BASELINE * progress +
    (1 - DIURNAL_BASELINE) *
      (progress - Math.sin(2 * Math.PI * progress) / (2 * Math.PI))
  );
}

// Population target for "partway through day `idx`": interpolates between
// today's and tomorrow's counts so fish spawn in smoothly across the day
// instead of jumping in a single step at the day boundary, eased along
// diurnalProgress so the bulk of a day's change lands around midday.
//
// Still exactly today's count at progress 0 and exactly tomorrow's at
// progress 1, so the curve stays continuous across the day rollover — the
// easing changes the path between them, never the endpoints.
function desiredPopulation(idx, progress) {
  const today = dayTargets[idx];
  const tomorrow = dayTargets[(idx + 1) % runData.length];
  return today + (tomorrow - today) * diurnalProgress(progress);
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

// Applies the day's speed multiplier to the flock's shared maxSpeed,
// interpolated across the day rather than stepped at the boundary.
//
// `speedMultiplierForRate` spans 0.55 to 1.45, and this used to be set once
// per day rollover — so at FRAMES_PER_DAY the shared speed clamp could jump by
// up to 45% in a single frame, every four seconds, applied to every fish at
// once. The whole school surged or braked together on a schedule, which is
// exactly the kind of periodic hitch the eye reads as the simulation
// stuttering rather than as the run speeding up.
//
// `smoothSpeed` (boids.js) does not help here: it low-passes what the renderer
// drives the TAILBEAT from, well downstream of the velocity clamp doing the
// jumping — so the tail stayed smooth while the fish underneath it lurched.
//
// Interpolating toward tomorrow's multiplier on the same `progress` the
// population ramp runs on gets the same total change spread across the day's
// 240 frames. Endpoints are unchanged, so days still line up exactly where
// they did; only the path between them is continuous now.
function applyDaySpeed(idx, progress = 0) {
  const today = speedMultiplierForRate(dailyRateOfChange[idx]);
  const tomorrow = speedMultiplierForRate(
    dailyRateOfChange[(idx + 1) % runData.length],
  );
  flock.options.maxSpeed =
    BASE_MAX_SPEED * (today + (tomorrow - today) * progress);
}

let spawnAccumulator = 0;
const POPULATION_CORRECTION_GAIN = 0.15;

// Floor on how much of the outgoing flow gets replaced — see
// replacementFraction() below for what this is a floor on.
//
// 0.4 is a compromise, picked by replaying 2015's real DART series through
// this pacing loop offline against a range of assumed crossing times (fish
// don't swim straight downstream at maxSpeed, so the real one can only be
// bracketed, not derived — 1600-2700 frames was the bracket used). Higher
// keeps the upstream edge busier but holds the school further above the day
// it is meant to be showing. Across that bracket, 0.4 took the share of
// frames sitting in a stretch with nothing arriving — longer than a whole
// simulated day — from 56-64% down to 18-26%, and the worst such stretch
// from 26-44s down to ~17s, for a median population error moving from
// 18-21% to 28-35%.
const REPLACEMENT_FLOOR = 0.4;

// How much of the flow leaving downstream to replace with fish entering
// upstream, given where the population currently sits against the day's
// target.
//
// This exists because population and target move on completely different
// clocks. A fish takes thousands of frames to cross the scene, i.e. the best
// part of ten simulated days at FRAMES_PER_DAY, while the target it's chasing
// is a real daily count that can halve overnight. The old pacing spawned on
// `Math.max(0, error)` alone, so the day after any drop the school was
// already over target and *nothing at all* entered from upstream — and with a
// residence time that long it stayed over target for days. In the same
// offline replay, 120-136 of 2015's 302 counted days went by without a single
// fish swimming in, in runs of six to ten days at a stretch. That's the empty
// upstream edge this fixes.
//
// So: replace one-for-one when the school is at or under target, and taper
// off as it runs over — but never below REPLACEMENT_FLOOR, because a school
// draining back down to a quiet day is exactly when the river would otherwise
// go silent for a very long time. The taper still drains: below 1.0 fewer
// fish enter than leave.
function replacementFraction(target, active) {
  if (active <= 0) return 1;
  return Math.max(REPLACEMENT_FLOOR, Math.min(1, target / active));
}

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
  setPlatesDay(idx);
}

// One place that writes the play state, so the button's label and its
// aria-pressed can never drift apart from `isPlaying` — they did before,
// because the timeline handler below set the state and the label by hand.
//
// aria-pressed rather than the old static aria-label="Play or pause": that
// label overrode the button's visible text, so a screen reader announced the
// same "Play or pause" whichever state it was in — it named the control but
// never reported it. With the attribute gone, the visible word IS the
// accessible name, and aria-pressed carries the state.
function setPlaying(next) {
  isPlaying = next;
  playPauseBtn.textContent = isPlaying ? "Pause" : "Play";
  playPauseBtn.setAttribute("aria-pressed", String(!isPlaying));
}

setPlaying(isPlaying);

playPauseBtn.addEventListener("click", () => setPlaying(!isPlaying));

timelineInput.addEventListener("input", (e) => {
  setPlaying(false);
  jumpToDay(Number(e.target.value));
});

// Keyboard control for the two things the interface actually does: run/hold,
// and move through the season. Until now the only key bound was the debug
// panel's "D", so a keyboard user could reach the timeline slider by tab but
// had no way to pause and nothing at all outside that one control.
//
// Space and the arrows are the conventional bindings for a transport, and
// stepping a day reuses jumpToDay(), which already pauses and re-seeds
// everything a scrub does.
window.addEventListener("keydown", (e) => {
  // Never steal a key from a focused control — the timeline slider's own
  // arrow-key handling in particular, which fires `input` and routes through
  // the handler above.
  if (e.target.tagName === "INPUT" || e.target.tagName === "SELECT") return;
  if (e.metaKey || e.ctrlKey || e.altKey) return;

  if (e.key === " " || e.key === "Spacebar") {
    // Space scrolls the page by default. This page has nothing to scroll, but
    // the default also fires the focused button, which would double-toggle.
    e.preventDefault();
    setPlaying(!isPlaying);
    return;
  }

  const step = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
  if (step === 0) return;
  e.preventDefault();
  setPlaying(false);
  // Wraps at both ends, matching the loop's own `(dayIndex + 1) % length`.
  jumpToDay((dayIndex + step + runData.length) % runData.length);
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

// Parity counter for the reduced-rate caustics pass — see the render loop.
let causticsFrame = 0;

// How often the HUD's figures are rewritten, in frames. See the call site in
// the render loop for why this is throttled at all.
const HUD_UPDATE_INTERVAL_FRAMES = 8;
let hudFrame = 0;

// Reused across drops to hold the ripple's position in the water sim's
// normalized [-1, 1] uv space. Shifted by the sim's margin below, since the
// sim is centered on bounds rather than corner-anchored at world (0, 0) —
// see waterWorldSize().
const rippleCenter = { x: 0, z: 0 };

// `dt` is in 60fps frames (see the render loop), so the counter advances in
// the same units AMBIENT_DROP_INTERVAL_FRAMES is expressed in and the drop
// cadence stays tied to wall-clock time rather than to the display's rate.
// Wrapped rather than left to climb, so the modulo below keeps working after
// a long session.
function emitRipples(dt) {
  rippleFrame = (rippleFrame + dt) % AMBIENT_DROP_INTERVAL_FRAMES;
  if (rippleFrame >= dt) return;

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
// One frame at 60fps, in milliseconds. `dt` is expressed in these units
// throughout — the simulation's constants were all tuned against a 60fps
// frame, so dt = 1 is the reference and nothing needed retuning to decouple
// from it.
const REFERENCE_FRAME_MS = 1000 / 60;

// Upper bound on a single step, in reference frames. A backgrounded tab stops
// receiving rAF entirely, so the first frame back can be minutes long; a tier
// change rebuilds every GPU resource in the scene and stalls for a beat. Both
// would otherwise teleport the whole flock downstream in one step. Three
// frames is enough headroom to stay smooth through an ordinary hitch and low
// enough that a big one just drops motion instead of exploding the sim.
const MAX_STEP_FRAMES = 3;

function loop(t) {
  // Advance the simulation clock (see its declaration above). Everything
  // below that moves reads `simTime`, never `t`, so pausing stops the whole
  // scene rather than just the date.
  const rawDelta = lastFrameTime === null ? REFERENCE_FRAME_MS : t - lastFrameTime;
  if (lastFrameTime !== null && isPlaying) simTime += rawDelta;
  lastFrameTime = t;
  const seconds = simTime * 0.001;

  // Frame time is what the governor watches, and it wants the real elapsed
  // time whether or not the scene is playing — a paused frame still renders.
  governor?.sample(rawDelta);

  // How much simulated time this frame represents, in 60fps frames.
  //
  // This used to be the constant 1, which coupled the whole scene to the
  // display: a phone holding 30fps ran the river at half speed, and a 120Hz
  // display ran it at double. Both are now the same river at the same speed,
  // dropping motion rather than slowing down — which matters most on exactly
  // the low-end devices this scene is being scaled for, since a slideshow that
  // is also in slow motion reads as broken rather than as merely coarse.
  const dt = Math.min(MAX_STEP_FRAMES, rawDelta / REFERENCE_FRAME_MS);

  // 1. Advance the flocking simulation. The HUD's fish counts are
  // driven by the real per-day DART data instead (see
  // updateFishCountDisplay), not this simulated count, so nothing here
  // needs to run every frame — only when dayIndex actually changes (see
  // jumpToDay and the day-rollover below).
  if (isPlaying) flock.step(dt);

  sceneSetup.updateCamera();

  if (!debugPanel.hidden) {
    const dist = camera.position.distanceTo(cameraTarget);
    const info = renderer.info.render;
    const median = governor?.medianMs ?? 0;
    debugPanel.textContent =
      `tier: ${qualityTier()}${qualityForced() ? " (forced)" : ""}\n` +
      `  why: ${qualityReason()}\n` +
      `frame: ${median ? `${median.toFixed(1)}ms · ${(1000 / median).toFixed(0)}fps` : "measuring…"}\n` +
      `pixelRatio: ${renderer.getPixelRatio().toFixed(2)}\n` +
      `caustics: ${QUALITY.realCaustics ? `${QUALITY.causticsSegments}seg / ${QUALITY.causticsTargetSize}px / ${QUALITY.causticsIterations}it` : "procedural"}\n` +
      `waterSim: ${QUALITY.waterSimSize || "off"}\n` +
      `bloom: ${QUALITY.bloom} · silt: ${QUALITY.particleCount} · shafts: ${QUALITY.shaftCount}\n` +
      `draws: ${info.calls} · tris: ${info.triangles.toLocaleString()}\n` +
      `distance to target: ${dist.toFixed(1)}\n` +
      `camera: (${camera.position.x.toFixed(0)}, ${camera.position.y.toFixed(0)}, ${camera.position.z.toFixed(0)})\n` +
      `target: (${cameraTarget.x.toFixed(0)}, ${cameraTarget.y.toFixed(0)}, ${cameraTarget.z.toFixed(0)})\n` +
      `bounds: ${bounds.width.toFixed(0)} x ${bounds.height.toFixed(0)}\n` +
      `camera.far: ${camera.far.toFixed(0)}\n` +
      `fish: ${flock.activeCount()} active / ${flock.fish.length} total (cap ${maxPopulation()})\n` +
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
  //
  // All of it is skipped at the low tier, where waterSim is null and the
  // surface generates its own height field and glint procedurally in-shader
  // (see createWorld, and glsl.js). water.setTime is what drives that, and is
  // pushed unconditionally so the two paths share one call site.
  if (waterSim) {
    if (isPlaying) {
      emitRipples(dt);
      waterSim.step();
    }
    water.setWaterTexture(waterSim.texture);
  }
  water.setTime(seconds);

  // Walk the sun along the day's arc and hand the same direction to everything
  // that needs to agree on where the light is: the disc in the sky, the
  // refraction the caustics pass traces, the shafts tracing back up to their
  // surface entry points, and the fish — which refract it themselves, since
  // they are the only one of the four that is lit from below the surface
  // (see refractedSunDirection in season.js). Pushed before the caustics render below so the
  // net this frame accumulates is the one belonging to this frame's sun.
  //
  // This is what makes the shafts sweep instead of standing still — see
  // sweptSunDirection in season.js for why moving the sun (rather than the
  // shafts) is the thing that does it.
  const sun = sweptSunDirection(seconds);
  sceneSetup.setSunDirection(sun);
  causticsGenerator?.setSunDirection(sun);
  godRays.setSunDirection(sun);
  fishRenderer?.setSunDirection(sun);

  // The caustics accumulation pass is the most expensive thing in the frame —
  // by a wide margin, and well ahead of the fish, despite what the note here
  // used to say. It is a grid of up to 257x257 vertices, each running a loop
  // of up to 40 texture fetches in the VERTEX shader, splatted additively into
  // a 1024^2 half-float target. It runs at a fraction of the frame rate
  // because the thing it is tracking barely moves: the water sim damps at
  // 0.9975 and gets a drop every 30 frames (see AMBIENT_DROP_INTERVAL_FRAMES),
  // so the light net is a slow swell, not something with per-frame detail to
  // lose. The divisor comes from the tier (see quality.js); at the low tier
  // this whole block is skipped, because causticsGenerator is null.
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
  if (
    causticsGenerator &&
    isPlaying &&
    causticsFrame++ % QUALITY.causticsInterval === 0
  ) {
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
  //
  // `dt` is passed for the same reason flock.step() gets it: the renderer
  // accumulates the tailbeat and the body pitch per call, so both have to
  // advance by the amount of simulated time this frame actually represents
  // rather than by one fixed step per rendered frame. See the note on
  // `advance` in fishMesh.js's update().
  if (fishRenderer) fishRenderer.update(flock.fish, simTime, isPlaying, dt);

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
    //
    // Throttled rather than run every frame. A day takes FRAMES_PER_DAY frames
    // to cross, so these figures move by well under one displayed digit per
    // frame — but the call is not cheap: ten toLocaleString() allocations, a
    // querySelector per secondary row, and a handful of textContent writes
    // that dirty layout. At this interval it is still smooth to the eye (the
    // numbers were never changing faster than this anyway) and costs an eighth
    // as much.
    if (hudFrame++ % HUD_UPDATE_INTERVAL_FRAMES === 0) {
      updateFishCountDisplay(dayIndex, progress);
    }

    // Walk the shared swim speed toward tomorrow's across the day, rather
    // than stepping it at the boundary — see applyDaySpeed.
    applyDaySpeed(dayIndex, progress);

    const target = desiredPopulation(dayIndex, progress);
    const active = flock.activeCount();

    // Growth: close whatever gap is left to the day's target. Not shaped by
    // diurnalRate — `target` is already the eased ramp, so the midday hump is
    // baked into this term's own slope and applying it again would square it.
    //
    // A per-frame RATE, hence the dt below.
    let arrivals = Math.max(0, target - active) * POPULATION_CORRECTION_GAIN;

    // Scaled by dt for the same reason flock.step() is: `arrivals` above is a
    // per-60fps-frame rate, so leaving it unscaled would make the run fill in
    // at a speed that depended on the display.
    spawnAccumulator += arrivals * dt;

    // Turnover: fish that left downstream this step make room for fish
    // entering upstream. This is the term that keeps the run continuous
    // through the long flat and falling stretches the growth term above sits
    // out entirely, and it *is* shaped by diurnalRate, so the steady stream
    // thickens toward midday and thins to a trickle at either end of the day
    // rather than running at one rate around the clock.
    //
    // Added AFTER the dt scaling above, deliberately, and this is a fix rather
    // than a rearrangement. `exitedLastStep` is a COUNT of departures from a
    // step of size dt — it already scales with dt, because step(dt) advances
    // positions by vx * dt — so folding it in before the multiply scaled it a
    // second time. That was not a mild over-spawn: replacement only balances
    // where replacementFraction * diurnalRate * dt ≈ 1, and with
    // REPLACEMENT_FLOOR at 0.4 any dt >= 2 through a midday diurnalRate above
    // 1.25 leaves that product permanently over 1 — no equilibrium at all, so
    // a device running at 30fps grew its flock without bound through every
    // simulated midday. On exactly the hardware least able to carry it.
    spawnAccumulator +=
      flock.exitedLastStep *
      replacementFraction(target, active) *
      diurnalRate(progress);

    // Hard ceiling, independent of the day tables above.
    //
    // A no-op in normal operation — dayTargets is already capped at
    // maxPopulation() (see rebuildDayTables) — but the pacing loop had no
    // ceiling of its own, so every path to an over-target population depended
    // on those tables being correct and current to stop it. Making the cap
    // structural means a future bug in the tables costs some accuracy in the
    // run's shape rather than an unbounded flock.
    const ceiling = maxPopulation();
    while (spawnAccumulator >= 1) {
      spawnAccumulator -= 1;
      if (flock.activeCount() >= ceiling) {
        spawnAccumulator = 0;
        break;
      }
      spawnAtLeftEdge();
    }

    frameCounter += dt;
    if (frameCounter >= FRAMES_PER_DAY) {
      frameCounter = 0;
      dayIndex = (dayIndex + 1) % runData.length;
      applyDaySpeed(dayIndex, 0);
      setDateReadout(dayIndex);
      updateFishCountDisplay(dayIndex);
      timelineInput.value = String(dayIndex);
      applySeason(runData[dayIndex].date);
      setPlatesDay(dayIndex);
    }
  }

  frameHandle = requestAnimationFrame(loop);
}

// ---------------------------------------------------------------------
// Lifecycle: page visibility and WebGL context loss.
//
// Neither of these was handled, and both are routine rather than exotic on
// the mobile browsers this now ships to.
// ---------------------------------------------------------------------

// The outstanding rAF handle, so the loop can actually be stopped rather than
// merely ignored. `loop` reassigns it on every frame (above).
let frameHandle = 0;
let loopRunning = true;

function stopLoop() {
  if (!loopRunning) return;
  loopRunning = false;
  cancelAnimationFrame(frameHandle);
}

function startLoop() {
  if (loopRunning) return;
  loopRunning = true;
  // The clock has to be re-seeded before the first frame back. `loop` derives
  // dt from `t - lastFrameTime`, and after minutes in a background tab that
  // difference is enormous — MAX_STEP_FRAMES caps how far the sim jumps, but
  // the frame-time governor would still read the gap as a catastrophically
  // slow frame and downgrade the tier for something that never rendered.
  lastFrameTime = null;
  frameHandle = requestAnimationFrame(loop);
}

// Browsers already throttle rAF in a hidden tab, but they do not stop it, and
// what keeps running here is not cheap: the water sim's ping-pong step and the
// caustics pass both advance on frames nobody is looking at. Stopping outright
// is both cheaper and kinder to a phone's battery.
document.addEventListener("visibilitychange", () => {
  if (document.hidden) stopLoop();
  else startLoop();
});

// Context loss is a normal event on mobile — the OS reclaims the GPU when the
// browser is backgrounded, another tab allocates heavily, the device sleeps.
// Nothing listened for it, so the routine outcome was a permanently black
// canvas with no indication of why.
sceneSetup.renderer.domElement.addEventListener(
  "webglcontextlost",
  (event) => {
    // WITHOUT preventDefault the context is never restorable and
    // webglcontextrestored below can never fire. This one line is the
    // difference between a recoverable interruption and a dead canvas.
    event.preventDefault();
    stopLoop();
    showNotice("Rendering was interrupted. Restoring…", "warn");
  },
  false,
);

sceneSetup.renderer.domElement.addEventListener(
  "webglcontextrestored",
  () => {
    // Every GPU resource is gone: textures, buffers, programs, render
    // targets. three re-uploads what it still holds JS-side on the next
    // render, but the world's own targets (the water sim's ping-pong pair,
    // the caustics accumulation) are ours and have to be rebuilt.
    rebuildWorld();
    if (noticeEl) noticeEl.hidden = true;
    startLoop();
  },
  false,
);

// ---------------------------------------------------------------------
// Boot. Ordered so every `let` above is initialized before anything reads
// it: build the bounds-shaped world, seed the timeline at day 0, start the
// loop, and let the fish models finish loading in the background.
// ---------------------------------------------------------------------
initPlates();
createWorld();
jumpToDay(0);
frameHandle = requestAnimationFrame(loop);

loadFishAssets()
  .then((assetsByUrl) => {
    // Stashed so a tier change can rebuild the renderers off the same baked
    // assets without re-fetching or re-baking them — see buildFishRenderer.
    fishAssets = assetsByUrl;
    buildFishRenderer();
    dismissLoadingOverlay();
  })
  .catch((err) => {
    console.error("Failed to load fish model:", err);
    // The overlay has to come down either way. It was console-only before, so
    // this failure left the scene dimmed under "Loading fish assets"
    // permanently — the river, the water and the HUD all work without the
    // fish, and a viewer looking at a working scene they cannot see is worse
    // off than one told what is missing.
    dismissLoadingOverlay();
    showNotice(
      "The fish models could not be loaded, so the river is running empty. " +
        "Reloading the page may fix it.",
    );
  });

// Everything above has evaluated, so a failure from here on is a runtime
// problem this module can report through showNotice() itself. Tells the boot
// handler in index.html to stop claiming errors as fatal startup failures.
window.__riverBooted = true;
