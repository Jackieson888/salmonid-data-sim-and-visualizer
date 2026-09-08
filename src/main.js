import { inject as injectAnalytics } from "@vercel/analytics";
import { injectSpeedInsights } from "@vercel/speed-insights";
import { Flock, REMOVE_FADE_FRAMES } from "./boids.js";

injectAnalytics();
injectSpeedInsights();
import {
  runData,
  runYear,
  AVAILABLE_YEARS,
  loadYear,
  loadRiverConditions,
  loadRunHistory,
} from "./data.js";
import { seasonFraction } from "./seasonScale.js";
import {
  initPlates,
  setPlatesDay,
  updatePlatesToday,
  rebuildPlatesForYear,
} from "./plates.js";
import { initInsightToast, createInfoButton } from "./insights.js";
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
import { dayOfYear, setSunSeason, sweptSunDirection } from "./scene/season.js";
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
const dateLabelCompact = document.getElementById("date-label-compact");
const dayOrdinalLabel = document.getElementById("day-ordinal");
const yearSelect = document.getElementById("year-select");
const yearSelectValue = document.getElementById("year-select-value");
const yearListbox = document.getElementById("year-listbox");
// Dimmed during a season switch (setYear) — see .field-loading in style.css.
const seasonSwitchFields = [
  document.getElementById("passage"),
  document.getElementById("conditions"),
  document.getElementById("run-status"),
  document.getElementById("controls"),
];
const playPauseBtn = document.getElementById("play-pause");
const timelineInput = document.getElementById("timeline");
const timelineAxis = document.getElementById("timeline-axis");
const fishCountLabel = document.getElementById("fish-count");

// The five species the flock actually draws; sum to #fish-count.
const SIMULATED_COUNT_KEYS = [
  "chinook",
  "jackChinook",
  "steelhead",
  "shad",
  "lamprey",
];

// Counted at the dam, reported here, never in the water; kept separate from SIMULATED_COUNT_KEYS deliberately.
const REPORTED_COUNT_KEYS = ["sockeye", "coho", "jackCoho"];

const speciesCountEls = Object.fromEntries(
  [...SIMULATED_COUNT_KEYS, ...REPORTED_COUNT_KEYS].map((key) => [
    key,
    document.getElementById(`count-${key}`),
  ]),
);
const fishLoadingEl = document.getElementById("fish-loading");
const noticeEl = document.getElementById("notice");

const reportEl = document.getElementById("report");
const reportToggle = document.getElementById("report-toggle");

// Collapses #report to the current reading, day total and playback; defaults collapsed on a small/short viewport, read once at boot.
function setReportCollapsed(collapsed) {
  reportEl.classList.toggle("collapsed", collapsed);
  reportToggle.setAttribute("aria-pressed", String(collapsed));
  reportToggle.setAttribute(
    "aria-label",
    collapsed ? "Expand panel" : "Collapse panel",
  );
  // #timeline-axis has clientWidth 0 while collapsed, so thinMonthLabels() needs a fresh pass once the axis has a width again.
  if (!collapsed) requestAnimationFrame(thinMonthLabels);
}
reportToggle.addEventListener("click", () =>
  setReportCollapsed(!reportEl.classList.contains("collapsed")),
);
// A collapsed bar is one big "tap to expand" surface; its own controls (Pause, year picker, info buttons) still get their own click.
reportEl.addEventListener("click", (e) => {
  if (!reportEl.classList.contains("collapsed")) return;
  if (e.target.closest("button, a, input")) return;
  setReportCollapsed(false);
});
setReportCollapsed(
  typeof matchMedia === "function" &&
    matchMedia("(max-width: 640px), (max-height: 500px)").matches,
);

// Surfaces a real failure to the viewer instead of only to the console.
function showNotice(message, kind = "error") {
  if (!noticeEl) return;
  noticeEl.textContent = message;
  noticeEl.hidden = false;
  // className reset, then a forced reflow before adding "shown", or the unhide and the transition's start state land in the same tick.
  noticeEl.className = kind;
  void noticeEl.offsetWidth;
  noticeEl.classList.add("shown");
}

// Mirrors the entrance above but in reverse; the timeout, not transitionend, is the real guarantee it un-hides.
function hideNotice() {
  if (!noticeEl || noticeEl.hidden) return;
  noticeEl.classList.remove("shown");
  setTimeout(() => {
    noticeEl.hidden = true;
  }, 260);
}

// Fades the loading overlay out and drops it from the DOM; the timeout is the real guarantee, not transitionend.
function dismissLoadingOverlay() {
  if (!fishLoadingEl || !fishLoadingEl.isConnected) return;
  fishLoadingEl.classList.add("hidden");
  const remove = () => fishLoadingEl.remove();
  fishLoadingEl.addEventListener("transitionend", remove, { once: true });
  setTimeout(remove, 1200);
}

const waterTempLabel = document.getElementById("water-temp");
const outflowLabel = document.getElementById("outflow");
const spillLabel = document.getElementById("spill");
const dissolvedGasLabel = document.getElementById("dissolved-gas");
const chinookRunLabel = document.getElementById("chinook-run");
const seasonTotalLabel = document.getElementById("season-total");
const seasonAverageLabel = document.getElementById("season-average");
const seasonDeltaLabel = document.getElementById("season-delta");
const chartPassagePath = document.getElementById("chart-passage");
const chartTempPath = document.getElementById("chart-temp");
const chartPeakValue = document.getElementById("chart-peak-value");
const chartRangeValue = document.getElementById("chart-range-value");

// Writes a number into the HUD, guarded on the rendered string to avoid dirtying layout for an unchanged digit.
function setReadout(el, value) {
  const text = value.toLocaleString();
  if (el.textContent !== text) el.textContent = text;
}

// The HUD's counts "partway through day `idx`" (progress 0=start, 1=end), interpolated from the real per-day DART numbers.
function updateFishCountDisplay(idx, progress = 0) {
  const today = runData[idx];
  const tomorrow = runData[(idx + 1) % runData.length];
  const at = (key) =>
    Math.round(
      (today[key] ?? 0) + ((tomorrow[key] ?? 0) - (today[key] ?? 0)) * progress,
    );

  // Only the simulated five feed the headline total; the reported three are written to their own cells and excluded.
  let total = 0;
  for (const key of SIMULATED_COUNT_KEYS) {
    const value = at(key);
    total += value;
    setReadout(speciesCountEls[key], value);
  }
  for (const key of REPORTED_COUNT_KEYS) {
    setReadout(speciesCountEls[key], at(key));
  }
  setReadout(fishCountLabel, today.chinook === undefined ? at("count") : total);

  // Dam-counted-but-not-swum species plus the steelhead wild/hatchery split; no-op until the drawer's been opened once.
  updatePlatesToday(at);

  // River/water readings ramp day-to-day, but only where both ends of the interpolation exist.
  writeMeasurement(
    waterTempLabel,
    today.tempC,
    tomorrow.tempC,
    progress,
    1,
    "°C",
  );

  // Outflow/spill/dissolved gas load after boot and are absent for most seasons until riverConditionsByDate resolves.
  const flowToday = riverConditionsByDate.get(today.date);
  const flowTomorrow = riverConditionsByDate.get(tomorrow.date);
  writeMeasurement(
    outflowLabel,
    flowToday?.outflowKcfs,
    flowTomorrow?.outflowKcfs,
    progress,
    1,
    "kcfs",
  );
  writeMeasurement(
    spillLabel,
    flowToday?.spillKcfs,
    flowTomorrow?.spillKcfs,
    progress,
    1,
    "kcfs",
  );
  writeMeasurement(
    dissolvedGasLabel,
    flowToday?.dissolvedGasMmHg,
    flowTomorrow?.dissolvedGasMmHg,
    progress,
    0,
    "mmHg",
  );

  // A label, not a measurement, so it snaps at the day boundary.
  chinookRunLabel.textContent = today.chinookRun ?? "—";

  setReadout(seasonTotalLabel, seasonToDate[idx]);
  updateRunComparison(idx);
}

// One gauge reading, interpolated across the day; a null means the gauge published nothing, and must stay visibly different from zero.
function writeMeasurement(el, today, tomorrow, progress, digits, unit) {
  if (today === null || today === undefined) {
    if (el.textContent !== "—") el.textContent = "—";
    return;
  }
  const blended =
    tomorrow === null || tomorrow === undefined
      ? today
      : today + (tomorrow - today) * progress;
  const text = `${blended.toFixed(digits)} ${unit}`;
  if (el.textContent !== text) el.textContent = text;
}

// date -> { outflowKcfs, spillKcfs, dissolvedGasMmHg }; replaced wholesale, never mutated, so a stale year can't half-mix with a new one.
let riverConditionsByDate = new Map();

function loadConditionsForYear() {
  const year = runYear;
  riverConditionsByDate = new Map();
  loadRiverConditions(year)
    .then((rows) => {
      // A slow fetch may land after the viewer moved to another season.
      if (year !== runYear) return;
      riverConditionsByDate = new Map(rows.map((row) => [row.date, row]));
      updateFishCountDisplay(dayIndex);
    })
    .catch((err) => {
      console.warn(`River conditions unavailable for ${year}:`, err);
    });
}

// The 2006-2015 day-of-year envelope, and the cumulative mean derived from it; both null until the history file resolves.
let historyEnvelope = null;
let meanToDate = null;

function loadHistoryComparison() {
  loadRunHistory()
    .then((history) => {
      historyEnvelope = history.dailyEnvelope;
      rebuildMeanToDate();
      updateRunComparison(dayIndex);
    })
    .catch((err) => {
      console.warn("Ten-year comparison unavailable:", err);
    });
}

// Walks the season's dates against the day-of-year envelope, accumulating the mean daily count; rebuilt per season.
function rebuildMeanToDate() {
  if (!historyEnvelope) return;
  const meanByDoy = new Map(historyEnvelope.map((d) => [d.doy, d.mean]));
  meanToDate = new Float64Array(runData.length);
  let running = 0;
  for (let i = 0; i < runData.length; i++) {
    running += meanByDoy.get(dayOfYear(runData[i].date)) ?? 0;
    meanToDate[i] = running;
  }
}

function updateRunComparison(idx) {
  if (!meanToDate || meanToDate.length !== runData.length) {
    seasonAverageLabel.textContent = "—";
    seasonDeltaLabel.textContent = "—";
    seasonDeltaLabel.className = "";
    return;
  }
  const average = meanToDate[idx];
  setReadout(seasonAverageLabel, Math.round(average));

  // The first counted day can land on a day-of-year no other year in the envelope reached, making the running mean genuinely 0.
  if (average <= 0) {
    seasonDeltaLabel.textContent = "—";
    seasonDeltaLabel.className = "";
    return;
  }
  const delta = ((seasonToDate[idx] - average) / average) * 100;
  const text = `${delta >= 0 ? "+" : "−"}${Math.abs(delta).toFixed(0)}%`;
  if (seasonDeltaLabel.textContent !== text)
    seasonDeltaLabel.textContent = text;
  // The one saturated color in the bar, reserved for running ahead of average; behind average is the neutral case, not an alarm.
  seasonDeltaLabel.className = delta >= 0 ? "above" : "below";
}

// The masthead's date line; ordinal counts position in the record, not day-of-year.
function setDateReadout(idx) {
  dateLabel.textContent = runData[idx].date;
  dateLabelCompact.textContent = runData[idx].date;
  dayOrdinalLabel.textContent =
    `Day ${idx + 1} of ${runData.length} Tracked` +
    (seasonComplete ? "" : " · season in progress");
}

// Month ticks under the timeline, positioned from real dates in runData, not spaced evenly.
const MONTH_ABBREVIATIONS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

// Running total of the five simulated species through day i; reallocated per season by rebuildForYear().
let seasonToDate = new Float64Array(0);

// The season's heaviest day, for the transport's "peak" jump.
let peakDayIndex = 0;

// A complete counting season ends in December; one that doesn't is still being counted by DART, not a short year.
let seasonComplete = true;

function rebuildSeasonTotals() {
  seasonToDate = new Float64Array(runData.length);
  seasonComplete = runData.at(-1).date.slice(5, 7) === "12";
  let running = 0;
  let peak = -1;
  for (let i = 0; i < runData.length; i++) {
    const count = runData[i].count ?? 0;
    running += count;
    seasonToDate[i] = running;
    if (count > peak) {
      peak = count;
      peakDayIndex = i;
    }
  }
}

// The whole season as one chart: daily passage as a filled area, water temperature as a line, both on the timeline's x-axis.
function buildSeasonChart() {
  const last = runData.length - 1;
  if (last <= 0) return;

  const x = (i) => (seasonFraction(i, last) * 1000).toFixed(2);

  const peak = Math.max(...runData.map((d) => d.count ?? 0), 1);
  const passageY = (value) => (100 - Math.sqrt(value / peak) * 100).toFixed(2);

  // Closed at both bottom corners so it fills as an area, not a line.
  const area = [`M 0 100`];
  for (let i = 0; i <= last; i++) {
    area.push(`L ${x(i)} ${passageY(runData[i].count ?? 0)}`);
  }
  area.push("L 1000 100 Z");
  chartPassagePath.setAttribute("d", area.join(" "));

  chartPeakValue.textContent = `${peak.toLocaleString()} / day`;

  const temps = runData
    .map((d) => d.tempC)
    .filter((t) => typeof t === "number");
  if (temps.length < 2) {
    chartRangeValue.textContent = "—";
    return;
  }
  const minTemp = Math.min(...temps);
  const maxTemp = Math.max(...temps);
  const span = maxTemp - minTemp || 1;
  // Inset from top/bottom so the line never sits on the frame as a border.
  const tempY = (value) => (92 - ((value - minTemp) / span) * 84).toFixed(2);

  // Days with no reading break the line rather than bridging it.
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

  chartRangeValue.textContent = `${minTemp.toFixed(1)}–${maxTemp.toFixed(1)} °C`;
}

function buildTimelineAxis() {
  const last = runData.length - 1;
  if (last <= 0) return;

  const marks = [];
  let previousMonth = -1;
  for (let i = 0; i <= last; i++) {
    // "YYYY-MM-DD"
    const month = Number(runData[i].date.slice(5, 7)) - 1;
    if (month === previousMonth || !MONTH_ABBREVIATIONS[month]) continue;
    // The axis only ever labels March through November; positions still come from real dates via seasonFraction(), label set is capped.
    if (month < 2 || month > 10) continue;
    previousMonth = month;
    const percent = (seasonFraction(i, last) * 100).toFixed(3);
    // The <i> is the 1px hairline mark; the button (the label) is the actual click target.
    marks.push(
      `<i style="left:${percent}%">` +
        `<button type="button" data-index="${i}">${MONTH_ABBREVIATIONS[month]}</button>` +
        `</i>`,
    );
  }
  // Only fixed abbreviations and array-index numbers — nothing off the network reaches this string.
  timelineAxis.innerHTML = marks.join("");
  thinMonthLabels();
}

// Hides any month label that would overlap the one before it, measured rather than guessed; the ticks themselves stay visible.
const MONTH_LABEL_GAP_PX = 6;

function thinMonthLabels() {
  // Runs during module evaluation, before first paint, when nothing is laid out yet.
  if (timelineAxis.clientWidth === 0) return;

  const labels = timelineAxis.querySelectorAll("button");
  // Cleared first: a hidden label has a zero-width rect and would never be seen by the collision test again.
  for (const label of labels) label.style.visibility = "";

  let previousRight = -Infinity;
  for (const label of labels) {
    const rect = label.getBoundingClientRect();
    if (rect.left < previousRight + MONTH_LABEL_GAP_PX) {
      label.style.visibility = "hidden";
      continue;
    }
    previousRight = rect.right;
  }
}

// First layout: buildTimelineAxis() runs before the bar is laid out.
requestAnimationFrame(thinMonthLabels);

// Delegated once at module scope, not rebound inside buildTimelineAxis(), which re-runs every year change.
timelineAxis.addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-index]");
  if (!btn) return;
  setPlaying(false);
  jumpToDay(Number(btn.dataset.index));
});

// Scene bounds: worldX = fish.x (downstream), worldZ = fish.y (across-river), worldY is cosmetic-only "up" the 2D sim never sees.
// `bounds` (the simulated world) is smaller than `pixelBounds` (the real viewport) by WORLD_SCALE.
const WORLD_SCALE = 0.55;

let pixelBounds = { width: window.innerWidth, height: window.innerHeight };
let bounds = {
  width: pixelBounds.width * WORLD_SCALE,
  height: pixelBounds.height * WORLD_SCALE,
};

const sceneSetup = createSceneSetup(canvas, pixelBounds, bounds);
const { renderer, scene, camera, cameraTarget, setSeason } = sceneSetup;
const renderScene = sceneSetup.render;

// Camera debug readout, toggled with "D"; how EYE_FRAC/TARGET_FRAC get re-tuned by eye if ever needed.
const debugPanel = document.getElementById("debug-panel");
window.addEventListener("keydown", (e) => {
  if (e.key.toLowerCase() !== "d" || e.target.tagName === "INPUT") return;
  debugPanel.hidden = !debugPanel.hidden;
});

// Water simulation grid size from the device tier; 0 at the low tier, where the sim isn't built and surfaces fall back to procedural stand-ins.
const waterSimSize = () => QUALITY.waterSimSize;

// Last day-of-year passed to setSeason(), so createWorld() can re-apply it after a resize rebuilds these meshes from scratch.
let currentDayOfYear = 0;

// The simulation clock every time-driven thing reads instead of the rAF timestamp, so pause is a genuine freeze-frame.
let simTime = 0;
let lastFrameTime = null;

// The bounds-shaped half of the scene, sized directly off `bounds`, so a resize disposes and rebuilds the whole set.
let waterSize;
// The caustics pass's own, shorter world coverage than waterSize.
let causticsSize;
let terrainMesh;
let particles;
let godRays;
let depthRange;
let waterSim;
let causticsGenerator;
let water;

function createWorld() {
  // Covers a bigger area than the river bounds so ripples can propagate out to the water plane's faded edges.
  waterSize = waterWorldSize(bounds);
  // Depends on the camera too — centered on what the eye looks through.
  causticsSize = causticsWorldSize(bounds, camera.position, cameraTarget);

  terrainMesh = buildTerrainMesh(bounds);

  // Depth range fish swim within.
  depthRange = { surfaceY: -8, floorY: -riverDepth(bounds) + 6 };

  // waterSim/causticsGenerator are the two most expensive things in the scene and aren't built at the low tier; nulled rather than stubbed since the loop must skip stepping/rendering them entirely.
  if (QUALITY.realCaustics) {
    waterSim = createWaterSimulation(
      renderer,
      waterSimSize(),
      waterSize.height / waterSize.width,
    );

    // Real-time caustics, recomputed every frame from the water sim's live height field.
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

  // Suspended silt and light shafts, placed relative to the fixed camera.
  particles = buildParticles(bounds, camera.position, cameraTarget);
  godRays = buildGodRays(bounds, camera.position, cameraTarget);

  // The caustics render target's texture never changes identity, so it's bound once here; null at the low tier is harmless.
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
  // Rendered once directly here, not left to the play-gated loop, so a paused resize still gets a valid net.
  causticsGenerator?.setSunDirection(sweptSunDirection(simTime * 0.001));
  if (causticsGenerator) causticsGenerator.render(waterSim.texture);

  // Everything the fish shaders derive from bounds; only changes on resize. Null until the models finish loading.
  fishRenderer?.setBounds(bounds, causticsSize, depthRange, camera.position);
  fishRenderer?.setCausticsTexture(causticsTexture);

  // Explicit transparency layering: terrain behind water behind fish (2, set in fishMesh.js) behind silt/shafts.
  terrainMesh.renderOrder = 0;
  water.mesh.renderOrder = 1;
  particles.mesh.renderOrder = 3;
  godRays.mesh.renderOrder = 3;
  scene.add(terrainMesh, water.mesh, particles.mesh, godRays.mesh);
}

// Old GPU resources are disposed before their replacements are created to avoid leaking memory across a resize.
function destroyWorld() {
  scene.remove(terrainMesh, water.mesh, particles.mesh, godRays.mesh);
  terrainMesh.geometry.dispose();
  terrainMesh.material.dispose();
  water.mesh.geometry.dispose();
  water.mesh.material.dispose();
  // Both null at the low tier.
  waterSim?.dispose();
  causticsGenerator?.dispose();
  particles.dispose();
  godRays.dispose();
}

// Deliberately not called straight off the resize event — see the debounce below.
function rebuildWorld() {
  flock.setBounds(bounds);
  destroyWorld();
  createWorld();
}

// Re-applies the whole scene at a new device tier, since tier-scaled resources are fixed at construction.
// Order matters: sceneSetup, then the bounds-shaped world, then the fish (reads the fresh caustics texture).
function applyTier() {
  sceneSetup.applyQuality(pixelBounds, bounds);
  rebuildWorld();
  buildFishRenderer();

  // Must run before the trim below, against the new cap.
  rebuildDayTables();

  // Cut the live population down to the new cap immediately rather than waiting for it to drain.
  const excess = flock.activeCount() - maxPopulation();
  if (excess > 0) flock.removeActive(excess);
}

// Always created so the debug panel has a frame time to show; a forced tier (?quality=) gets a null callback that only measures.
const governor = createPerfGovernor(qualityForced() ? null : applyTier);

const SPECIES_KEYS = ["chinook", "jackChinook", "steelhead", "shad", "lamprey"];

// Caps how many fish are simulated/rendered at once, as a single pooled total across all species, not a per-species clamp.
const maxPopulation = () => QUALITY.population;

// Extra instance slots each species renderer gets on top of maxPopulation(), for fish that crossed the exit line and are still fading out over REMOVE_FADE_FRAMES.
const FISH_RENDER_HEADROOM = 8 * REMOVE_FADE_FRAMES;

// loadFishAssets() loads+bakes every distinct per-species GLB, so fishRenderer stays null until it resolves.
let fishRenderer = null;

// The baked per-URL GLB assets (geometry + VAT + texture), held so the renderers can be rebuilt without re-fetching or re-baking.
let fishAssets = null;

// Builds (or rebuilds) the instanced fish renderers against the current tier; a full rebuild, not an in-place adjustment.
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
  // createWorld()/applySeason() already ran by the first call, so hand the new mesh the current state directly.
  fishRenderer.setBounds(bounds, causticsSize, depthRange, camera.position);
  fishRenderer.setCausticsTexture(causticsGenerator?.texture ?? null);
  fishRenderer.setSeason(currentDayOfYear);
}

// Drives sky/sun, fog, water color, terrain color/sun direction, and caustic glow all from the same date.
function applySeason(dateStr) {
  currentDayOfYear = dayOfYear(dateStr);
  setFogSeason(currentDayOfYear);
  setSeason(currentDayOfYear);
  water.setSeason(currentDayOfYear);
  setTerrainSeason(terrainMesh, currentDayOfYear);
  particles.setSeason(currentDayOfYear);
  godRays.setSeason(currentDayOfYear);
  fishRenderer?.setSeason(currentDayOfYear);
  // Fixes the sun's daily high point; the render loop sweeps around it.
  setSunSeason(currentDayOfYear);
}

// A dragged window edge fires `resize` on nearly every frame; rebuildWorld() is too expensive for that rate, so cheap resize
// work runs immediately on every event, and the expensive rebuild is debounced.
const REBUILD_DEBOUNCE_MS = 150;
let rebuildTimer = 0;

// Mobile browsers also fire `resize` when their own chrome (address bar, toolbar) slides in/out; a height-only change smaller than this is absorbed without a full world rebuild.
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

  // Cheap, and the bar reflows on a chrome-bar change too.
  if (widthChanged) thinMonthLabels();

  pixelBounds = { width, height };
  // Runs on every event regardless, including the chrome-bar case — the
  // viewport really changed even though the simulated world shouldn't.
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
    // The composer's render targets are reallocated here, not per event.
    sceneSetup.resizeComposer(pixelBounds);
    rebuildWorld();
  }, REBUILD_DEBOUNCE_MS);
});

// Tuned crossing speed, scaled by WORLD_SCALE so crossing time, not raw world-units/frame, stays where it was tuned.
const BASE_MAX_SPEED = 1.2 * WORLD_SCALE;

const flock = new Flock(bounds, {
  maxSpeed: BASE_MAX_SPEED,
  perceptionRadius: 70,
  // Must stay just under perceptionRadius.
  separationRadius: 65,
});

// Run timeline: dimension-agnostic, only touches flock.fish.length/bounds, never rendering.
let dayIndex = 0;
// Boots held, not running, when the OS asks for reduced motion; Play (or Space) starts it. Read once at boot, not watched.
const PREFERS_REDUCED_MOTION =
  typeof matchMedia === "function" &&
  matchMedia("(prefers-reduced-motion: reduce)").matches;

let isPlaying = !PREFERS_REDUCED_MOTION;
let frameCounter = 0;
// Frames a simulated day is given before the timeline advances; the transport's speed selector divides this base figure.
const BASE_FRAMES_PER_DAY = 240;
let framesPerDay = BASE_FRAMES_PER_DAY;
let speedMultiple = 1;

// Per-day population/species tables, precomputed per season. dayTargets[i] is day i's on-screen population;
// dayWeights[] is flat cumulative per-species counts per day, for a weighted species pick.
let dayTargets = new Int32Array(0);
let dayWeights = new Float64Array(0);

// Day-over-day change in target population, used by applyDaySpeed; derived from dayTargets, rebuilt with it.
let dailyRateOfChange = new Int32Array(0);

// (Re)fills all three tables against the current tier's population cap; must be re-runnable since applyTier() calls it on a downgrade.
// Arrays are reallocated, not filled in place, since runData.length changes with the year (seasons run 290-306 days).
function rebuildDayTables() {
  const cap = maxPopulation();

  if (dayTargets.length !== runData.length) {
    dayTargets = new Int32Array(runData.length);
    dayWeights = new Float64Array(runData.length * SPECIES_KEYS.length);
    dailyRateOfChange = new Int32Array(runData.length);
  }

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

    // Falls back to the day's plain `count` (still capped) with no species breakdown; rounded for integer fish counts.
    dayTargets[i] =
      total > 0
        ? Math.round(cumulative)
        : Math.min(cap, Math.round(day.count ?? 0));
  }

  for (let i = 0; i < runData.length; i++) {
    dailyRateOfChange[i] = i === 0 ? 0 : dayTargets[i] - dayTargets[i - 1];
  }
}

// Diurnal arrival shape: ladder passage is heaviest through the middle of the day, thin at the edges, blended with a flat baseline so it never hits zero.
const DIURNAL_BASELINE = 0.3;

// Relative arrival rate at `progress` through the day, normalized to average 1.0; redistributes when fish arrive, not how many.
function diurnalRate(progress) {
  return (
    DIURNAL_BASELINE +
    (1 - DIURNAL_BASELINE) * (1 - Math.cos(2 * Math.PI * progress))
  );
}

// diurnalRate integrated from 0 to `progress`, rising 0 -> 1 across the day; the easing curve the population ramp below runs on.
function diurnalProgress(progress) {
  return (
    DIURNAL_BASELINE * progress +
    (1 - DIURNAL_BASELINE) *
      (progress - Math.sin(2 * Math.PI * progress) / (2 * Math.PI))
  );
}

// Population target for "partway through day `idx`", eased along diurnalProgress; exact at each end, only the path between changes.
function desiredPopulation(idx, progress) {
  const today = dayTargets[idx];
  const tomorrow = dayTargets[(idx + 1) % runData.length];
  return today + (tomorrow - today) * diurnalProgress(progress);
}

// Weighted-random species pick for a spawn on day `idx`, matching that day's real percentages via dayWeights.
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

// Maps a day's rate-of-change in population to a swim-speed multiplier: a fast-rising run swims slower, a fast-falling one faster.
function speedMultiplierForRate(rate) {
  const normalized = Math.max(-1, Math.min(1, rate / 40));
  return 1 - normalized * 0.45;
}

// Applies the day's speed multiplier to the flock's shared maxSpeed, interpolated across the day rather than stepped at the boundary.
function applyDaySpeed(idx, progress = 0) {
  const today = speedMultiplierForRate(dailyRateOfChange[idx]);
  const tomorrow = speedMultiplierForRate(
    dailyRateOfChange[(idx + 1) % runData.length],
  );
  flock.options.maxSpeed =
    BASE_MAX_SPEED * (today + (tomorrow - today) * progress);
}

let spawnAccumulator = 0;

// Fraction of the remaining gap to the day's target closed per frame; scaled by playback speed since the ramp is a fraction of a day, not a second.
const POPULATION_CORRECTION_GAIN = 0.15;

// Capped well below 1 — past ~0.6 the "ramp" becomes a visible pop at each day boundary.
const MAX_CORRECTION_GAIN = 0.6;

function correctionGain() {
  return Math.min(
    MAX_CORRECTION_GAIN,
    POPULATION_CORRECTION_GAIN * speedMultiple,
  );
}

// Floor on how much of the outgoing flow gets replaced by replacementFraction() below; picked from an offline replay of 2015's DART series.
const REPLACEMENT_FLOOR = 0.4;

// How much of the flow leaving downstream to replace with fish entering upstream, given where the population sits against target.
// Replaces one-for-one at or under target, tapers off above it, never below REPLACEMENT_FLOOR (a floor-less version left long stretches with zero arrivals).
function replacementFraction(target, active) {
  if (active <= 0) return 1;
  return Math.max(REPLACEMENT_FLOOR, Math.min(1, target / active));
}

// New fish enter from the upstream (left) edge at a random point, so the run reads as continuously arriving.
function spawnAtLeftEdge() {
  const x = -Math.random() * 40;
  const margin = 15;
  const y = margin + Math.random() * (bounds.height - margin * 2);
  flock.spawn(x, y, pickSpeciesForDay(dayIndex));
}

// Scrubbing the timeline jumps straight to a day: spawn/remove fish until the population matches, then reset per-day state.
function jumpToDay(idx) {
  // Hard resync point: flush any fade-out still pending, rather than layering more on top, keeping a fast slider drag bounded.
  flock.finalizeRemovals();

  // activeCount() read once and acted on directly — re-counting as a loop condition was quadratic on every slider `input` event.
  const target = dayTargets[idx];
  const active = flock.activeCount();
  for (let i = active; i < target; i++) {
    // Anywhere in open water — these fish aren't meant to visibly "arrive" the way a spawnAtLeftEdge() fish is.
    flock.spawn(
      Math.random() * bounds.width,
      Math.random() * bounds.height,
      pickSpeciesForDay(idx),
    );
  }
  if (active > target) {
    flock.removeActive(active - target);
    // removeActive() only flags fish; Flock.step() fades and drops them, but a paused flock never steps — finalize now or they hang forever.
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

// One place that writes play state, so the button's label and aria-pressed can never drift apart.
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

// Season switching: runData is a live binding, so the swap itself is free; rebuildForYear() knows everything derived from it that isn't.
// Called both at boot and on every year change so the two paths can't drift.
function rebuildForYear() {
  rebuildSeasonTotals();
  rebuildDayTables();
  // Keyed by day-of-year, so a new season maps onto different envelope entries; no-op before the history file resolves.
  rebuildMeanToDate();
  timelineInput.max = String(runData.length - 1);
  buildTimelineAxis();
  buildSeasonChart();
  // The heaviest day differs every season; this is the only place that says.
  peakBtn.title = `Heaviest day of ${runYear}: ${runData[peakDayIndex].date}`;
  peakBtn.setAttribute(
    "aria-label",
    `Jump to the heaviest day of ${runYear}, ${runData[peakDayIndex].date}`,
  );
  // Clamped, not reset to 0 — a season switch should land near the same point in the season, not throw the viewer back to March.
  jumpToDay(Math.min(dayIndex, runData.length - 1));
}

// Guards a second switch landing mid-fetch; the control is disabled too, but a keyboard repeat can outrun the network.
let yearSwitchInFlight = false;

async function setYear(year) {
  if (yearSwitchInFlight || year === runYear) return;
  yearSwitchInFlight = true;
  yearSelect.disabled = true;
  // The four fields whose figures are about to go stale mid-fetch; masthead is left alone since #year-select's :disabled already marks it.
  for (const field of seasonSwitchFields) field.classList.add("field-loading");

  // A season change reallocates the day tables the pacing loop reads every frame, so playback is held for the duration.
  const wasPlaying = isPlaying;
  setPlaying(false);

  try {
    await loadYear(year);
    rebuildForYear();
    rebuildPlatesForYear();
    loadConditionsForYear();
    if (noticeEl && noticeEl.classList.contains("warn")) hideNotice();
  } catch (err) {
    console.warn(`Could not load the ${year} season:`, err);
    // runData/runYear are untouched on failure — still a warning, not the app's error state.
    showNotice(
      `The ${year} counting season could not be loaded. ` +
        `Still showing ${runYear}.`,
      "warn",
    );
  } finally {
    syncYearControl();
    yearSelect.disabled = false;
    yearSwitchInFlight = false;
    setPlaying(wasPlaying);
    for (const field of seasonSwitchFields)
      field.classList.remove("field-loading");
  }
}

// A hand-built listbox, not a native <select>, since the platform popup ignores color-scheme:dark on Windows/Chromium.
// yearListboxOptions maps year -> its <li>, so selection/highlight updates are a lookup, not a DOM query per call.
const yearListboxOptions = new Map();
let yearListboxOpen = false;

for (const year of AVAILABLE_YEARS) {
  const option = document.createElement("li");
  option.id = `year-option-${year}`;
  option.setAttribute("role", "option");
  option.textContent = String(year);
  option.dataset.year = String(year);
  yearListbox.appendChild(option);
  yearListboxOptions.set(year, option);
}

// Marks the currently-loaded season in the listbox and the trigger's own label; called on boot and after every setYear().
function syncYearControl() {
  yearSelectValue.textContent = String(runYear);
  for (const [year, option] of yearListboxOptions) {
    option.setAttribute("aria-selected", String(year === runYear));
  }
}

// The keyboard-navigated row, independent of aria-selected (the loaded season); also what aria-activedescendant points at.
function setActiveYearOption(year) {
  for (const [y, option] of yearListboxOptions) {
    option.classList.toggle("active", y === year);
  }
  const option = yearListboxOptions.get(year);
  if (!option) return;
  yearListbox.setAttribute("aria-activedescendant", option.id);
  option.scrollIntoView({ block: "nearest" });
}

function activeYear() {
  const id = yearListbox.getAttribute("aria-activedescendant");
  const year = id && Number(id.slice("year-option-".length));
  return AVAILABLE_YEARS.includes(year) ? year : runYear;
}

// Fixed, not absolute: #year-listbox sits outside #report to escape its overflow, so position is computed from the trigger's viewport rect.
// Anchored above the button since the trigger sits near the bottom of the HUD bar; max-height clamps to the actual room above it.
function positionYearListbox() {
  const rect = yearSelect.getBoundingClientRect();
  const gap = 4;
  yearListbox.style.left = `${Math.round(rect.left)}px`;
  yearListbox.style.top = "auto";
  yearListbox.style.bottom = `${Math.round(window.innerHeight - rect.top + gap)}px`;
  yearListbox.style.minWidth = `${Math.round(rect.width)}px`;
  yearListbox.style.maxHeight = `${Math.min(260, Math.max(120, rect.top - gap - 8))}px`;

  // Clamp off the right edge after layout, since the list's real width isn't known until it's rendered.
  const overflowRight =
    yearListbox.getBoundingClientRect().right - (window.innerWidth - 8);
  if (overflowRight > 0) {
    yearListbox.style.left = `${Math.round(rect.left - overflowRight)}px`;
  }
}

function setYearListboxOpen(open) {
  if (open === yearListboxOpen) return;
  yearListboxOpen = open;
  yearListbox.hidden = !open;
  yearSelect.setAttribute("aria-expanded", String(open));
  if (open) {
    positionYearListbox();
    setActiveYearOption(runYear);
    yearListbox.focus({ preventScroll: true });
  }
}

function chooseYear(year) {
  setYearListboxOpen(false);
  yearSelect.focus({ preventScroll: true });
  setYear(year);
}

yearSelect.addEventListener("click", () =>
  setYearListboxOpen(!yearListboxOpen),
);

// ArrowDown/Up from the closed trigger opens straight into the list, landing on the loaded season.
yearSelect.addEventListener("keydown", (e) => {
  if (yearListboxOpen) return;
  if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
  e.preventDefault();
  setYearListboxOpen(true);
});

yearListbox.addEventListener("click", (e) => {
  const option = e.target.closest("li[role='option']");
  if (option) chooseYear(Number(option.dataset.year));
});

// stopPropagation on every handled key, or the page's own global keydown listener would also step the timeline underneath the open list.
yearListbox.addEventListener("keydown", (e) => {
  const years = AVAILABLE_YEARS;
  const idx = years.indexOf(activeYear());

  switch (e.key) {
    case "ArrowDown":
      e.preventDefault();
      e.stopPropagation();
      setActiveYearOption(years[Math.min(idx + 1, years.length - 1)]);
      return;
    case "ArrowUp":
      e.preventDefault();
      e.stopPropagation();
      setActiveYearOption(years[Math.max(idx - 1, 0)]);
      return;
    case "Home":
      e.preventDefault();
      e.stopPropagation();
      setActiveYearOption(years[0]);
      return;
    case "End":
      e.preventDefault();
      e.stopPropagation();
      setActiveYearOption(years[years.length - 1]);
      return;
    case "Enter":
    case " ":
      e.preventDefault();
      e.stopPropagation();
      chooseYear(activeYear());
      return;
    case "Escape":
      e.preventDefault();
      e.stopPropagation();
      setYearListboxOpen(false);
      yearSelect.focus({ preventScroll: true });
      return;
    case "Tab":
      setYearListboxOpen(false);
      return;
    default:
      return;
  }
});

// Closing on outside pointerdown, not click, so a drag ending outside the list still closes it.
window.addEventListener("pointerdown", (e) => {
  if (!yearListboxOpen) return;
  if (yearSelect.contains(e.target) || yearListbox.contains(e.target)) return;
  setYearListboxOpen(false);
});

// A resize can invalidate the fixed position outright; closing is simpler and safer than tracking it.
window.addEventListener("resize", () => setYearListboxOpen(false));

syncYearControl();

// Transport: both route through jumpToDay(), which already holds playback and re-seeds everything.
function stepDay(delta) {
  setPlaying(false);
  // Wraps at both ends, matching the loop's own `(dayIndex + 1) % length`.
  jumpToDay((dayIndex + delta + runData.length) % runData.length);
}

// The one jump not reachable by dragging or stepping.
const peakBtn = document.getElementById("to-peak");
peakBtn.addEventListener("click", () => {
  setPlaying(false);
  jumpToDay(peakDayIndex);
});

// Keyboard control for run/hold and moving through the season; stepping a day reuses jumpToDay().
// Keys a focused BUTTON handles itself — everything else is safe to act on even while a button has focus.
const BUTTON_OWN_KEYS = new Set([" ", "Spacebar", "Enter"]);

window.addEventListener("keydown", (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;

  // Never steal a key from a focused control: INPUT/SELECT skipped outright, BUTTON only owns Space/Enter.
  const tag = e.target.tagName;
  if (tag === "INPUT" || tag === "SELECT") return;
  if (tag === "BUTTON" && BUTTON_OWN_KEYS.has(e.key)) return;

  switch (e.key) {
    // preventDefault: the browser default also fires a focused button, which would double-toggle.
    case " ":
    case "Spacebar":
      e.preventDefault();
      setPlaying(!isPlaying);
      return;
    case "ArrowRight":
      e.preventDefault();
      stepDay(1);
      return;
    case "ArrowLeft":
      e.preventDefault();
      stepDay(-1);
      return;
    case "Home":
      e.preventDefault();
      setPlaying(false);
      jumpToDay(0);
      return;
    case "End":
      e.preventDefault();
      setPlaying(false);
      jumpToDay(runData.length - 1);
      return;
    // "=" works without Shift; "_"/"+" accepted too for anyone holding it.
    case "-":
    case "_":
      e.preventDefault();
      nudgeSpeed(-1);
      return;
    case "=":
    case "+":
      e.preventDefault();
      nudgeSpeed(1);
      return;
  }
});

// Water ripples: slow ambient "rain," independent of the fish sim — no mouse interactivity, no per-fish disturbance.
const AMBIENT_DROP_INTERVAL_FRAMES = 30;
let rippleFrame = 0;

// Parity counter for the reduced-rate caustics pass — see the render loop.
let causticsFrame = 0;

// How often the HUD's figures are rewritten, in frames — see the render loop.
const HUD_UPDATE_INTERVAL_FRAMES = 8;
let hudFrame = 0;

// Reused across drops for the ripple's position in the water sim's normalized [-1, 1] uv space, shifted by the sim's margin.
const rippleCenter = { x: 0, z: 0 };

// `dt` is in 60fps frames, so drop cadence stays tied to wall-clock time; wrapped via modulo to keep working after a long session.
function emitRipples(dt) {
  rippleFrame = (rippleFrame + dt) % AMBIENT_DROP_INTERVAL_FRAMES;
  if (rippleFrame >= dt) return;

  // Radius scaled down to keep the tuned real-world size now that the sim maps onto the bigger waterSize.
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

// Animation loop. One frame at 60fps, in ms — the sim's constants were all tuned against this, so dt = 1 is the reference.
const REFERENCE_FRAME_MS = 1000 / 60;

// Upper bound on a single step, in reference frames, capping how far a backgrounded-tab or tier-change hitch can teleport the flock.
const MAX_STEP_FRAMES = 3;

function loop(t) {
  // Advance the simulation clock. Everything below reads `simTime`, never `t`, so pausing stops the whole scene, not just the date.
  const rawDelta =
    lastFrameTime === null ? REFERENCE_FRAME_MS : t - lastFrameTime;
  if (lastFrameTime !== null && isPlaying) simTime += rawDelta;
  lastFrameTime = t;
  const seconds = simTime * 0.001;

  // The governor wants real elapsed time regardless of play state — a paused frame still renders.
  governor?.sample(rawDelta);

  // Simulated time this frame represents, in 60fps frames, decoupling sim speed from display refresh rate.
  const dt = Math.min(MAX_STEP_FRAMES, rawDelta / REFERENCE_FRAME_MS);

  // 1. Advance the flocking simulation; the HUD's counts are driven by the real DART data instead.
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

  // 2. Advance the water surface: drop ripples, relax the height field, re-render caustics off the stepped field.
  // Gated on play so a paused frame holds its ripples; setWaterTexture stays outside the gate since re-handing the
  // same ping-pong target costs nothing. Skipped entirely at the low tier, where waterSim is null.
  if (waterSim) {
    if (isPlaying) {
      emitRipples(dt);
      waterSim.step();
    }
    water.setWaterTexture(waterSim.texture);
  }
  water.setTime(seconds);

  // Walk the sun along the day's arc and hand the same direction to everything that needs to agree on where the light is.
  const sun = sweptSunDirection(seconds);
  sceneSetup.setSunDirection(sun);
  causticsGenerator?.setSunDirection(sun);
  godRays.setSunDirection(sun);
  fishRenderer?.setSunDirection(sun);

  // The caustics accumulation pass is the frame's most expensive thing, so it runs at a fraction of frame rate — the water sim
  // damps slowly, so the light net has no per-frame detail to lose. Not applied to waterSim.step, which would actually slow down.
  if (
    causticsGenerator &&
    isPlaying &&
    causticsFrame++ % QUALITY.causticsInterval === 0
  ) {
    causticsGenerator.render(waterSim.texture);
  }

  // 3. Sync the instanced fish mesh to the flock's current state. Still called while paused, since a resize rewrites the
  // instance buffers even with the fish standing still. `isPlaying` lets the tailbeat keep a fraction of its rate through a pause.
  if (fishRenderer) fishRenderer.update(flock.fish, simTime, isPlaying, dt);

  // Silt drift and shaft sway are driven entirely from this one uniform each.
  particles.update(seconds);
  godRays.update(seconds);

  renderScene();

  // 4. Population pacing: while playing, continuously spawn fish toward desiredPopulation's smooth ramp, and advance the day once its frame budget is spent.
  if (isPlaying) {
    const progress = frameCounter / framesPerDay;

    // Throttled — not cheap, and moves by well under one digit per frame anyway.
    if (hudFrame++ % HUD_UPDATE_INTERVAL_FRAMES === 0) {
      updateFishCountDisplay(dayIndex, progress);
    }

    applyDaySpeed(dayIndex, progress);

    const target = desiredPopulation(dayIndex, progress);
    const active = flock.activeCount();

    // Growth: close the gap to the day's target. Not shaped by diurnalRate again since `target` is already the eased ramp.
    let arrivals = Math.max(0, target - active) * correctionGain();
    spawnAccumulator += arrivals * dt;

    // Turnover: fish leaving downstream make room for fish entering upstream, keeping the run continuous when growth sits out.
    // Added after the dt scaling above deliberately — combining it with that scaling caused unbounded growth.
    spawnAccumulator +=
      flock.exitedLastStep *
      replacementFraction(target, active) *
      diurnalRate(progress);

    // Hard ceiling, structurally independent of the day tables above.
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
    if (frameCounter >= framesPerDay) {
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

// The outstanding rAF handle, so the loop can be stopped, not just ignored.
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
  // Re-seeded before the first frame back, or the governor reads the background-tab gap as a catastrophic frame.
  lastFrameTime = null;
  frameHandle = requestAnimationFrame(loop);
}

// Browsers throttle rAF in a hidden tab but don't stop it, and the water sim/caustics steps aren't cheap — stop outright.
document.addEventListener("visibilitychange", () => {
  if (document.hidden) stopLoop();
  else startLoop();
});

// Context loss is routine on mobile; unhandled, it used to leave a permanently black canvas.
sceneSetup.renderer.domElement.addEventListener(
  "webglcontextlost",
  (event) => {
    // Without this, the context is never restorable and webglcontextrestored below can never fire.
    event.preventDefault();
    stopLoop();
    showNotice("Rendering was interrupted. Restoring…", "warn");
  },
  false,
);

sceneSetup.renderer.domElement.addEventListener(
  "webglcontextrestored",
  () => {
    // Every GPU resource is gone; three re-uploads what it holds JS-side, but the world's own targets have to rebuild.
    rebuildWorld();
    if (noticeEl) noticeEl.hidden = true;
    startLoop();
  },
  false,
);

// Insight toast text: each is a function, not a plain string, so it reads runData/dayIndex fresh when a viewer opens it.
const INSIGHT_SPECIES_LABELS = {
  chinook: "Chinook",
  jackChinook: "Jack Chinook",
  steelhead: "Steelhead",
  shad: "Shad",
  lamprey: "Lamprey",
  sockeye: "Sockeye",
  coho: "Coho",
  jackCoho: "Jack Coho",
};

function panelTitleInsightText() {
  return (
    "This scene simulates the Snake River salmonid run past Lower Granite " +
    "Dam. The fish swimming past are drawn straight from the daily adult " +
    "passage counts in this panel — real numbers from Columbia Basin " +
    "Research DART, not a synthetic population."
  );
}

function passageInsightText() {
  const today = runData[dayIndex];
  const keys = [...SIMULATED_COUNT_KEYS, ...REPORTED_COUNT_KEYS];
  const counted = keys.filter((key) => (today[key] ?? 0) > 0);
  let text =
    "Every adult fish that reaches Lower Granite climbs the dam's fish " +
    "ladder and is tallied crossing an underwater viewing window — the " +
    "same style of count the Corps of Engineers has run at Columbia and " +
    "Snake River dams for decades.";
  if (counted.length > 0) {
    const top = counted.reduce((a, b) =>
      (today[b] ?? 0) > (today[a] ?? 0) ? b : a,
    );
    text +=
      ` Today's count spans ${counted.length} of the eight species DART ` +
      `tracks here, led by ${INSIGHT_SPECIES_LABELS[top]}.`;
  }
  return text;
}

function conditionsInsightText() {
  const temp = runData[dayIndex].tempC;
  let text =
    "Spilling water over the dam, instead of running it through the " +
    "turbines, puts oxygen back into the river — but it also whips extra " +
    "nitrogen into the water, a supersaturated dissolved-gas load that can " +
    "hurt fish swimming through it. Adult salmon and steelhead also start " +
    "feeling heat stress somewhere around 20°C (68°F), so water " +
    "temperature here doubles as a comfort report for the run outside.";
  if (typeof temp === "number") {
    text +=
      temp >= 20
        ? ` Today's reading is ${temp.toFixed(1)}°C — into that stressful range.`
        : ` Today's reading is ${temp.toFixed(1)}°C.`;
  }
  return text;
}

function runStatusInsightText() {
  if (!meanToDate || meanToDate.length !== runData.length) {
    return (
      '"Run to date" adds up every fish counted so far this season and ' +
      "checks it against the same running total averaged over 2006–2015 " +
      "— that ten-year comparison is still loading."
    );
  }
  const average = meanToDate[dayIndex];
  const total = seasonToDate[dayIndex];
  let text = `Through ${runData[dayIndex].date}, ${Math.round(total).toLocaleString()} fish have passed this season.`;
  if (average > 0) {
    const delta = ((total - average) / average) * 100;
    text += ` That's ${Math.abs(delta).toFixed(0)}% ${delta >= 0 ? "above" : "below"} the 2006–2015 average for this same date — `;
    text +=
      delta >= 0
        ? "neither figure says much about the rest of the season on its own."
        : "not a red flag by itself; runs swing year to year with ocean conditions, snowpack, and hatchery release timing.";
  }
  return text;
}

function seasonChartInsightText() {
  return (
    "The passage curve is drawn on a square-root scale, not a straight " +
    "linear one. Plotted straight, a single 7,000-fish day in September " +
    "would flatten the rest of the season into a flat line along the " +
    "bottom — the root keeps that peak in view while still showing the " +
    "smaller shoulders of the run in spring and fall."
  );
}

function initInsights() {
  initInsightToast();

  // Static: nothing here changes day to day, unlike the other three.
  const panelTitleLabel = document.querySelector(
    "#masthead .panel-title .label",
  );
  if (panelTitleLabel) {
    panelTitleLabel.appendChild(
      createInfoButton(
        "panel-title",
        panelTitleInsightText,
        "Salmonid Data Simulation",
      ),
    );
  }

  // Cache keys thread the season and exact day shown through, so yesterday's answer is never handed back for today.
  const passageLabel = document.querySelector("#passage .field-head .label");
  if (passageLabel) {
    passageLabel.appendChild(
      createInfoButton(
        () => `passage:${runYear}:${runData[dayIndex].date}`,
        passageInsightText,
        "Daily adult passage",
      ),
    );
  }

  const conditionsLabel = document.querySelector(
    "#conditions .field-head .label",
  );
  if (conditionsLabel) {
    conditionsLabel.appendChild(
      createInfoButton(
        () => `conditions:${runYear}:${runData[dayIndex].date}`,
        conditionsInsightText,
        "Conditions",
      ),
    );
  }

  const runStatusLabel = document.querySelector(
    "#run-status .field-head .label",
  );
  if (runStatusLabel) {
    runStatusLabel.appendChild(
      createInfoButton(
        () => `run-status:${runYear}:${runData[dayIndex].date}`,
        runStatusInsightText,
        "Run to date",
      ),
    );
  }
}

// Boot: build the world, seed the timeline, start the loop, let the fish models load in the background.
initInsights();
initPlates();
createWorld();
// Same function the year control calls, so boot and a switch can't drift.
rebuildForYear();
loadConditionsForYear();
loadHistoryComparison();
frameHandle = requestAnimationFrame(loop);

loadFishAssets()
  .then((assetsByUrl) => {
    // Stashed so a tier change can rebuild renderers without re-fetching.
    fishAssets = assetsByUrl;
    buildFishRenderer();
    dismissLoadingOverlay();
  })
  .catch((err) => {
    console.error("Failed to load fish model:", err);
    // The overlay has to come down either way — the rest of the scene works without the fish.
    dismissLoadingOverlay();
    showNotice(
      "The fish models could not be loaded, so the river is running empty. " +
        "Reloading the page may fix it.",
    );
  });

// Tells the boot handler in index.html to stop treating a later failure as fatal; from here on this module reports via showNotice().
window.__riverBooted = true;
