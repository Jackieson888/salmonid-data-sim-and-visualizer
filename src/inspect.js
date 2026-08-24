// inspect.js
// Standalone single-fish viewer. Same fish shader/animation pipeline as the
// river scene (scene/fishMesh.js) — one InstancedMesh, VAT-baked swim clip,
// caustic glow, depth fog — but with exactly one instance, an orbit camera,
// and none of the river/timeline/quality-governor machinery main.js builds
// around it. A visitor's window onto one fish: which species, whether it
// swims and turns, and a labeled anatomy plate (see scene/fishAnatomy.js).
//
// The fish is visually static — it never translates — so what this actually
// renders is the same VAT sampling loop fishMesh.js runs per instance, driven
// by a synthetic fish record instead of a flock member. Everything about how
// it looks (species tint, depth fog, caustic glow, highlights) is identical
// to the river; only the world around it and the camera are different.

import { QUALITY } from "./quality.js";

// Only one instance is ever drawn here, so unlike the river scene (which
// scales these down per device tier to hold frame rate across a flock of
// hundreds) this always renders at the richest settings available. Set
// before createFishInstancedMesh() below reads them at material-build time —
// see buildSpeciesRenderer in fishMesh.js.
//
// realCaustics is forced OFF rather than on: "on" compiles a shader that
// expects a real accumulation texture from causticsGenerator.js, which this
// page never builds (there's no water simulation to generate one from), so
// that path would just sample an unbound sampler and stay flat. "Off"
// compiles the procedural stand-in (see causticGlowProc in glsl.js), which
// needs nothing but world position and time and gives the fish a moving
// glint even with no caustics pipeline behind it.
QUALITY.realCaustics = false;
QUALITY.fishHighlights = true;

import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import {
  loadFishAssets,
  createFishInstancedMesh,
  SPECIES_MODEL_URL,
} from "./scene/fishMesh.js";
import { resolveAnatomy, animatedLocalPosition } from "./scene/fishAnatomy.js";
import { Fish, BODY_VISUAL_SCALE, SPECIES_LENGTH_INCHES } from "./boids.js";
import { runData, runYear } from "./data.js";
import { seasonFraction } from "./seasonScale.js";

const canvas = document.getElementById("fish-canvas");
const fishLoadingEl = document.getElementById("fish-loading");
const speciesListEl = document.getElementById("species-list");
const playingToggle = document.getElementById("playing-toggle");
const rotateToggle = document.getElementById("rotate-toggle");
const labelsToggle = document.getElementById("labels-toggle");
const resetViewBtn = document.getElementById("reset-view");
const lengthScaleEl = document.getElementById("length-scale");
const seasonCardEl = document.getElementById("season-card");
const fieldGuideEl = document.getElementById("field-guide");
const overlaySvg = document.getElementById("anatomy-overlay");
const inspectPanel = document.getElementById("inspect-panel");

// The species on show, in the order the panel lists them — largest salmonid
// first, then down the run to the one that isn't a bony fish at all. The
// river's own tables key off the same five (see SPECIES_KEYS in main.js).
const SPECIES = [
  "chinook",
  "jackChinook",
  "steelhead",
  "shad",
  "lamprey",
];

// Replaces the old `speciesSelect.value` reads. The picker is a list of
// buttons now, so there is no control holding the current value — this is it.
let currentSpecies = "steelhead";

const PREFERS_REDUCED_MOTION = window.matchMedia(
  "(prefers-reduced-motion: reduce)",
).matches;
// A default, not a lock — a visitor who explicitly turns swimming or the
// turntable back on gets it, same spirit as the river booting held under
// this preference rather than autoplaying (see PREFERS_REDUCED_MOTION in
// main.js).
if (PREFERS_REDUCED_MOTION) {
  playingToggle.checked = false;
  rotateToggle.checked = false;
}

// ---------------------------------------------------------------------
// Scene: a plain neutral backdrop rather than the river's underwater fog —
// this view exists to see the fish clearly, not to see it in context. No
// THREE lights are added, matching sceneSetup.js: fishMesh.js's material is a
// hand-written ShaderMaterial lit entirely by its own uLightDir uniform, so
// scene lights would be dead weight here too.
// ---------------------------------------------------------------------
const scene = new THREE.Scene();
const BACKDROP_COLOR = 0x0b0f13;
scene.background = new THREE.Color(BACKDROP_COLOR);

const camera = new THREE.PerspectiveCamera(45, 1, 1, 5000);

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
// Matches sceneSetup.js's grading (ACESFilmicToneMapping, exposure 0.55) so a
// model reads here the same way it will in the river — the whole point of a
// mesh/texture debugging view is that it not lie about the real look.
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.55;

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.minDistance = 10;
controls.maxDistance = 4000;
controls.autoRotateSpeed = 6;
controls.autoRotate = rotateToggle.checked;

let grid = null;

// Points the camera/orbit target at the fish and sizes the reference grid to
// it — called on load, whenever the species changes the rendered body
// length, and from the reset-view button. Not re-run every frame: that would
// fight the user's own zoom/drag.
function frameCamera(bodyLength) {
  // The mesh's bbox center sits half a body length behind the tracked nose
  // point (see noseOffsetLocal in fishMesh.js) — previewFish is nose-anchored
  // at the world origin (see below), heading straight down +Z, so the body
  // itself extends back along -Z from there.
  const target = new THREE.Vector3(0, 0, -bodyLength / 2);
  controls.target.copy(target);
  camera.position.set(
    target.x + bodyLength * 1.1,
    target.y + bodyLength * 0.45,
    target.z + bodyLength * 1.3,
  );
  camera.near = Math.max(1, bodyLength * 0.02);
  camera.far = bodyLength * 40;
  camera.updateProjectionMatrix();

  if (grid) {
    scene.remove(grid);
    grid.geometry.dispose();
    grid.material.dispose();
  }
  // Colors matched to style.css's --line/--line-soft so the grid reads as
  // this page's own chrome rather than an arbitrary three.js default.
  grid = new THREE.GridHelper(bodyLength * 5, 20, 0x2c3841, 0x1b242a);
  grid.position.y = target.y - bodyLength * 0.35;
  scene.add(grid);
}

let lastBodyLength = 0;

resetViewBtn.addEventListener("click", () => {
  if (lastBodyLength > 0) frameCamera(lastBodyLength);
  // The camera moves instantly, so the labels have to as well — see
  // snapLabelLayout for why the smoothing cannot work this out on its own.
  snapLabelLayout();
});

function resize() {
  const width = window.innerWidth;
  const height = window.innerHeight;
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
  renderer.setSize(width, height);
  overlaySvg.setAttribute("viewBox", `0 0 ${width} ${height}`);
}
window.addEventListener("resize", resize);
resize();

// ---------------------------------------------------------------------
// The one fish. Built from boids.js's real Fish class rather than a bare
// object literal so it gets the same per-species length range, wobble phase
// and swim-rate jitter a flock member would (see the constructor in
// boids.js) — the only overrides below are the ones that make sense for a
// fish that isn't part of a running simulation.
// ---------------------------------------------------------------------
let previewFish = null;

function makePreviewFish(species) {
  const fish = new Fish(0, 0, species);
  // Fish.opacity ramps in over SPAWN_FADE_FRAMES of Flock.step() calls (see
  // boids.js) — nothing here ever steps a Flock, so age would otherwise sit
  // at 0 forever and the fish would render fully transparent. Forcing it past
  // the fade window is the fix; it's a getter, so age is what's actually set.
  fish.age = 999;
  // Depth wander is a flocking-scene concern (drifting up/down the water
  // column); pinned flat here so the fish sits at a predictable height
  // instead of the constructor's random depth.
  fish.depth = 0;
  fish.depthTarget = 0;
  // Heading fixed to +Z (see frameCamera's target math above) rather than the
  // constructor's random forward-ish angle, so re-picking a species doesn't
  // also spin the fish to a new facing.
  fish.vx = 0;
  fish.vy = 1;
  // No speed/amplitude sliders any more — this is the natural cruise a
  // flocking fish swims at (1.2 matches BASE_MAX_SPEED in main.js) and the
  // clip's full authored stroke, rather than a tunable.
  fish.smoothSpeed = 1.2;
  fish.swimAmplitude = 1;
  return fish;
}

let fishRenderer = null;
// The full Map loadFishAssets() resolves to (url -> {geometry, modelLength,
// texture, vat}), and the current species' own entry out of it — kept
// separately because resolveAnatomy() wants the Map (it does its own
// species -> url lookup) while the per-frame swim-bend sampling wants one
// species' assets directly.
let assetsByUrlRef = null;
let fishAssets = null;
let anatomyParts = [];

const SCIENTIFIC_NAMES = {
  chinook: "Oncorhynchus tshawytscha",
  jackChinook: "Oncorhynchus tshawytscha",
  steelhead: "Oncorhynchus mykiss",
  shad: "Alosa sapidissima",
  lamprey: "Entosphenus tridentatus",
};
const COMMON_NAMES = {
  chinook: "Chinook Salmon",
  jackChinook: "Jack Chinook Salmon",
  steelhead: "Steelhead",
  shad: "American Shad",
  lamprey: "Pacific Lamprey",
};
const SPECIES_NOTES = {
  chinook: "The largest Pacific salmon, and the species this counting season is named for.",
  jackChinook: "A “jack” is a precocious male Chinook that returns to spawn a year early, at a much smaller size than a typical adult.",
  steelhead: "A sea-run form of rainbow trout. Unlike Pacific salmon, some steelhead survive spawning and return to the ocean to spawn again.",
  shad: "Not native to the Columbia Basin — introduced from the Atlantic coast in the 1870s.",
  lamprey: "A jawless fish, not a true fish in the bony-fish sense at all — closer kin to hagfish than to salmon. Parasitic on other fish at sea, then dies after its one spawning run, like Pacific salmon.",
};
const MONTH_NAMES = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

// The eight species DART counts at this project — the five drawn here plus
// the three counted but never modelled. Only used as the denominator for
// "share of the counted run" below, so the figure is a share of everything
// the dam counted rather than of the five this page happens to show.
const ALL_COUNTED = [...SPECIES, "sockeye", "coho", "jackCoho"];

// Real per-day DART counts for one species, off the same record the river and
// the plates drawer read (see data.js). Everything the panel reports comes
// from this one pass.
function seasonStatsFor(species) {
  let total = 0;
  let peakValue = -1;
  let peakDate = null;
  let firstDate = null;
  let lastDate = null;
  let countedTotal = 0;

  for (const day of runData) {
    const value = day[species] ?? 0;
    total += value;
    for (const key of ALL_COUNTED) countedTotal += day[key] ?? 0;
    if (value > peakValue) {
      peakValue = value;
      peakDate = day.date;
    }
    // First and last day this species was actually SEEN, not the first and
    // last day the dam was counting — the two are months apart for a species
    // with a short run, and the counting window is the same for all of them.
    if (value > 0) {
      if (firstDate === null) firstDate = day.date;
      lastDate = day.date;
    }
  }

  // The dates by which 10% and 90% of the season's fish had passed. A far more
  // honest answer to "when does this species run" than first-to-last, which
  // one stray fish in February can stretch across the whole calendar.
  let running = 0;
  let tenth = null;
  let ninetieth = null;
  if (total > 0) {
    for (const day of runData) {
      running += day[species] ?? 0;
      if (tenth === null && running >= total * 0.1) tenth = day.date;
      if (ninetieth === null && running >= total * 0.9) ninetieth = day.date;
    }
  }

  return {
    total,
    peakValue: peakValue > 0 ? peakValue : 0,
    peakDate: total > 0 ? peakDate : null,
    firstDate,
    lastDate,
    share: countedTotal > 0 ? total / countedTotal : 0,
    middleWindow: tenth && ninetieth ? [tenth, ninetieth] : null,
  };
}

// Facts DART publishes for one species and not the others. Each returns a
// [label, value] row or null — a species with nothing extra to say adds
// nothing rather than an empty row.
function speciesExtraRows(species) {
  const rows = [];

  if (species === "steelhead") {
    let wild = 0;
    let all = 0;
    for (const day of runData) {
      wild += day.wildSteelhead ?? 0;
      all += day.steelhead ?? 0;
    }
    // A SUBSET of the steelhead count, never an addition to it — DART's own
    // notes say the Stlhd column already includes both, and the wild figure
    // may itself include unmarked hatchery fish.
    if (all > 0) {
      rows.push(["Wild (unclipped)", `${((wild / all) * 100).toFixed(1)}%`]);
    }
  }

  if (species === "lamprey") {
    let night = 0;
    let day = 0;
    for (const row of runData) {
      night += row.lampreyNight ?? 0;
      day += row.lampreyDay ?? 0;
    }
    // 0 for a season that published no day/night split at all (2006-2008),
    // in which case the row is omitted rather than reported as 0% night.
    if (day + night > 0) {
      rows.push(["Passed at night", `${((night / (day + night)) * 100).toFixed(0)}%`]);
    }
  }

  if (species === "chinook" || species === "jackChinook") {
    // DART labels each date with the run schedule it falls in (see
    // CHINOOK_RUN_NAMES in dart/parseAdultDaily.js). These are Corps run
    // schedules for the project, not a determination about the fish counted.
    const byRun = new Map();
    for (const day of runData) {
      if (!day.chinookRun) continue;
      byRun.set(day.chinookRun, (byRun.get(day.chinookRun) ?? 0) + (day[species] ?? 0));
    }
    const total = [...byRun.values()].reduce((a, b) => a + b, 0);
    if (total > 0) {
      const share = (name) => Math.round(((byRun.get(name) ?? 0) / total) * 100);
      rows.push([
        "Sp / Su / Fa",
        `${share("Spring")} / ${share("Summer")} / ${share("Fall")}%`,
      ]);
    }
  }

  return rows;
}

function formatDate(dateStr) {
  const [, month, day] = dateStr.split("-").map(Number);
  return `${MONTH_NAMES[month - 1]} ${day}`;
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function labelledRow(label, value) {
  const row = el("p", "fg-row");
  row.appendChild(el("span", "label", label));
  row.appendChild(el("b", null, value));
  return row;
}

// ---------------------------------------------------------------------
// The species picker.
// ---------------------------------------------------------------------
const speciesButtons = new Map();

function buildSpeciesList() {
  for (const species of SPECIES) {
    const btn = el("button", "species-option");
    btn.type = "button";
    btn.setAttribute("role", "radio");
    btn.dataset.species = species;

    // The key square carries the species' water tint, so the panel and the
    // fish in the river are keyed the same colour.
    btn.appendChild(el("i", "species-key"));
    const names = el("span", "species-names");
    names.appendChild(el("span", "species-common", COMMON_NAMES[species]));
    names.appendChild(el("i", "species-scientific", SCIENTIFIC_NAMES[species]));
    btn.appendChild(names);

    btn.addEventListener("click", () => setSpecies(species));
    speciesListEl.appendChild(btn);
    speciesButtons.set(species, btn);
  }

  // Roving focus: the group is one tab stop and the arrows move within it,
  // which is what a radiogroup is expected to do.
  speciesListEl.addEventListener("keydown", (e) => {
    const step = e.key === "ArrowDown" || e.key === "ArrowRight" ? 1
      : e.key === "ArrowUp" || e.key === "ArrowLeft" ? -1
      : 0;
    if (step === 0) return;
    e.preventDefault();
    const i = SPECIES.indexOf(currentSpecies);
    const next = SPECIES[(i + step + SPECIES.length) % SPECIES.length];
    setSpecies(next);
    speciesButtons.get(next).focus();
  });
}

function markSpeciesSelection() {
  for (const [species, btn] of speciesButtons) {
    const selected = species === currentSpecies;
    btn.setAttribute("aria-checked", String(selected));
    btn.classList.toggle("selected", selected);
    // Only the selected option is in the tab order — the rest are reached
    // with the arrows.
    btn.tabIndex = selected ? 0 : -1;
  }
}

// ---------------------------------------------------------------------
// Adult length, all five on one scale.
//
// Built once and only re-marked on a species change: the bars themselves
// never change, and rebuilding five rows of SVG to move one highlight would
// be work for its own sake.
// ---------------------------------------------------------------------
const LENGTH_AXIS_MAX = 48; // inches; clears the longest Chinook
const LENGTH_AXIS_TICKS = [0, 12, 24, 36, 48];
const lengthRows = new Map();

// Row labels for the length scale only. The full common names do not fit the
// name column at this panel width and truncating them gave five rows of
// "CHINO…"/"AMERI…", which identifies nothing — the picker above already
// carries the full name and the binomial.
const SHORT_NAMES = {
  chinook: "Chinook",
  jackChinook: "Jack",
  steelhead: "Steelhead",
  shad: "Shad",
  lamprey: "Lamprey",
};

function buildLengthScale() {
  const head = el("p", "field-head");
  head.appendChild(el("span", "label", "Adult length"));
  lengthScaleEl.appendChild(head);

  for (const species of SPECIES) {
    const [min, max] = SPECIES_LENGTH_INCHES[species];
    const row = el("div", "len-row");
    row.dataset.species = species;
    row.appendChild(el("span", "len-name", SHORT_NAMES[species]));

    // The bar is the RANGE, not a single figure — these species are given as
    // spans in boids.js because that is what they are.
    const track = el("span", "len-track");
    const bar = el("span", "len-bar");
    bar.style.left = `${(min / LENGTH_AXIS_MAX) * 100}%`;
    bar.style.width = `${((max - min) / LENGTH_AXIS_MAX) * 100}%`;
    track.appendChild(bar);
    row.appendChild(track);

    row.appendChild(el("span", "len-figure", `${min}–${max}`));
    lengthScaleEl.appendChild(row);
    lengthRows.set(species, row);
  }

  // The axis reuses the row layout — a blank name cell, the ticks inside a
  // real track, a blank figure cell — rather than being a separate line with
  // hand-guessed margins. That is what keeps "24" actually above the 24-inch
  // mark instead of near it.
  const axisRow = el("div", "len-row len-axis-row");
  axisRow.appendChild(el("span", "len-name"));
  const axisTrack = el("span", "len-track len-axis-track");
  for (const tick of LENGTH_AXIS_TICKS) {
    const mark = el("span", "len-tick", String(tick));
    mark.style.left = `${(tick / LENGTH_AXIS_MAX) * 100}%`;
    axisTrack.appendChild(mark);
  }
  axisRow.appendChild(axisTrack);
  axisRow.appendChild(el("span", "len-figure", "in"));
  lengthScaleEl.appendChild(axisRow);
}

function markLengthSelection() {
  for (const [species, row] of lengthRows) {
    row.classList.toggle("current", species === currentSpecies);
  }
}

// ---------------------------------------------------------------------
// This species' season at the dam.
//
// The sparkline shares seasonScale.js's x-axis with the river's own chart and
// every plate in the drawer, and the √ scale with them too — so it reads as
// the same instrument at a smaller size rather than a different one.
// ---------------------------------------------------------------------
const SPARK_W = 300;
const SPARK_H = 46;
const SVG_NS = "http://www.w3.org/2000/svg";
// Quarter-year rules. Not every season reaches all three (a run counted only
// through September has no October), so these are looked up rather than
// assumed — see buildSparkline.
const SPARK_AXIS_MONTHS = [4, 7, 10];

function buildSparkline(species, stats) {
  const last = runData.length - 1;
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", `0 0 ${SPARK_W} ${SPARK_H}`);
  svg.setAttribute("preserveAspectRatio", "none");
  svg.setAttribute("class", "spark");
  svg.setAttribute("aria-hidden", "true");

  const peak = Math.max(stats.peakValue, 1);
  const x = (i) => (seasonFraction(i, last) * SPARK_W).toFixed(2);
  const y = (v) => (SPARK_H - Math.sqrt(v / peak) * SPARK_H).toFixed(2);

  // Month rules at the quarters, so the shape can be placed in the year
  // without spending a row on an axis. Their record indices are handed back to
  // the caller so the labels underneath can be positioned at the SAME
  // fractions — evenly spacing the labels under unevenly spaced rules is how
  // an axis ends up pointing at the wrong month.
  const rules = [];
  for (const target of SPARK_AXIS_MONTHS) {
    const i = runData.findIndex((day) => Number(day.date.slice(5, 7)) === target);
    if (i === -1) continue;
    rules.push({ index: i, month: target });
    const rule = document.createElementNS(SVG_NS, "line");
    rule.setAttribute("class", "spark-rule");
    rule.setAttribute("x1", x(i));
    rule.setAttribute("x2", x(i));
    rule.setAttribute("y1", 0);
    rule.setAttribute("y2", SPARK_H);
    svg.appendChild(rule);
  }

  const d = [`M 0 ${SPARK_H}`];
  for (let i = 0; i <= last; i++) d.push(`L ${x(i)} ${y(runData[i][species] ?? 0)}`);
  d.push(`L ${SPARK_W} ${SPARK_H} Z`);
  const area = document.createElementNS(SVG_NS, "path");
  area.setAttribute("class", "spark-area");
  area.setAttribute("data-species", species);
  area.setAttribute("d", d.join(" "));
  svg.appendChild(area);

  // The peak day, in the accent — the current-reading colour, used here for
  // the one day the whole shape is about.
  if (stats.peakDate) {
    const peakIndex = runData.findIndex((day) => day.date === stats.peakDate);
    if (peakIndex >= 0) {
      const mark = document.createElementNS(SVG_NS, "line");
      mark.setAttribute("class", "spark-peak");
      mark.setAttribute("x1", x(peakIndex));
      mark.setAttribute("x2", x(peakIndex));
      mark.setAttribute("y1", 0);
      mark.setAttribute("y2", SPARK_H);
      svg.appendChild(mark);
    }
  }
  return { svg, rules };
}

// Month labels under the sparkline, positioned at the same seasonFraction
// their rules are drawn at rather than spaced evenly — an evenly spaced row of
// labels under unevenly spaced rules points at the wrong months, and these
// rules sit wherever the season's own dates put them.
function buildSparkAxis(rules) {
  const last = runData.length - 1;
  const axis = el("div", "spark-axis");
  for (const { index, month } of rules) {
    const mark = el("span", null, MONTH_NAMES[month - 1]);
    mark.style.left = `${(seasonFraction(index, last) * 100).toFixed(2)}%`;
    axis.appendChild(mark);
  }
  return axis;
}

function updateSeasonCard(species) {
  const stats = seasonStatsFor(species);
  seasonCardEl.replaceChildren();

  const head = el("p", "field-head");
  head.appendChild(el("span", "label", `At Lower Granite, ${runYear}`));
  seasonCardEl.appendChild(head);

  if (stats.total === 0) {
    // A real outcome, not an error: shad were barely counted in some seasons,
    // and lamprey not at all in others. Saying so beats a flat line and a
    // column of zeroes.
    seasonCardEl.appendChild(
      el("p", "fg-note", `None counted at this project in ${runYear}.`),
    );
    return;
  }

  const { svg, rules } = buildSparkline(species, stats);
  seasonCardEl.appendChild(svg);
  seasonCardEl.appendChild(buildSparkAxis(rules));

  const rows = [
    ["Season total", stats.total.toLocaleString()],
    ["Share of run", `${(stats.share * 100).toFixed(1)}%`],
    ["Peak day", `${stats.peakValue.toLocaleString()} · ${formatDate(stats.peakDate)}`],
    [
      "First / last",
      stats.firstDate
        ? `${formatDate(stats.firstDate)} · ${formatDate(stats.lastDate)}`
        : "—",
    ],
    [
      "Middle 80%",
      stats.middleWindow
        ? `${formatDate(stats.middleWindow[0])} – ${formatDate(stats.middleWindow[1])}`
        : "—",
    ],
    ...speciesExtraRows(species),
  ];
  for (const [label, value] of rows) {
    seasonCardEl.appendChild(labelledRow(label, value));
  }
}

function updateFieldGuide(species) {
  fieldGuideEl.replaceChildren();

  const head = el("p", "field-head");
  head.appendChild(el("span", "label", "Field notes"));
  fieldGuideEl.appendChild(head);

  fieldGuideEl.appendChild(el("p", "fg-note", SPECIES_NOTES[species]));
}

function setSpecies(species) {
  currentSpecies = species;
  previewFish = makePreviewFish(species);
  lastBodyLength = previewFish.length * BODY_VISUAL_SCALE;
  frameCamera(lastBodyLength);

  markSpeciesSelection();
  markLengthSelection();
  updateSeasonCard(species);
  updateFieldGuide(species);

  // A different species is a different part list — anything remembered from
  // the last one would be eased from rather than snapped past.
  resetLabelLayout();

  if (assetsByUrlRef) {
    fishAssets = assetsByUrlRef.get(SPECIES_MODEL_URL[species]);
    anatomyParts = resolveAnatomy(species, assetsByUrlRef);
  }
}

rotateToggle.addEventListener("change", () => {
  controls.autoRotate = rotateToggle.checked;
});

// ---------------------------------------------------------------------
// Anatomy overlay — leader lines drawn each frame from the projected screen
// position of the resolved anchors (see scene/fishAnatomy.js).
//
// The anchors move whether or not the camera does: they are sampled off the
// swimming mesh, so every one of them is travelling through a tailbeat all
// the time. A layout recomputed from scratch each frame therefore MOVES each
// frame, and the labels never settle into something you can read. Four things
// hold them still, in rough order of how much each is worth:
//
//   1. Fixed gutters. The label column x is a property of the viewport, not
//      of the anchor, so label x does not move at all. (This is also what
//      pushes the leaders further off the model.)
//   2. Damping. Label y chases its target instead of snapping to it, so the
//      tailbeat's residual is smoothed away rather than tracked.
//   3. Column hysteresis. A part keeps its side until its anchor is well
//      past the midline, so a feature hovering near centre stops ping-ponging
//      between the two columns.
//   4. A settle pass that pushes back up as well as down, so a crowded column
//      stays centred on its anchors instead of drifting off the bottom.
// ---------------------------------------------------------------------

// How far the label columns sit either side of the viewport centre.
// frameCamera() centres the fish, so a symmetric gutter about the centre is
// stable frame to frame.
//
// Deliberately modest. Pushing the columns further out does get the LABELS
// off the model, but it does it by making every leader longer and flatter —
// and a long flat leader lies straight across the body, which is worse than
// the label would have been. Distance is not what keeps the plate clear; the
// vertical fan below is.
const LABEL_GUTTER_FRACTION = 0.22;
const LABEL_GUTTER_MAX = 230;
// Wider than the text needs. The gap is doing layout work here, not just
// preventing overlap: it is what spreads a column out enough for its leaders
// to leave their anchors at a steep angle.
const LABEL_MIN_GAP = 26;

// How far each label is pulled from its anchor's own height toward an even
// share of the column's vertical band.
//
// At 0 the labels sit level with their anchors, which is where they started
// and why the leaders ran horizontally across the fish. At 1 they are evenly
// spaced regardless of what they point at, which reads as a list rather than
// a plate. In between, the column fans out over the full height of the frame
// while keeping each label nearest the feature it names, so the leaders
// arrive from above and below instead of straight through the body.
const LABEL_VERTICAL_SPREAD = 0.62;
// The band the fan is distributed across, as a fraction of viewport height.
const LABEL_BAND_TOP = 0.1;
const LABEL_BAND_BOTTOM = 0.9;
// Room for the longest label text ("Second Dorsal Fin") between the column and
// the edge of the viewport.
const LABEL_EDGE_MARGIN = 130;
// Fraction of the remaining distance a label closes per frame. Low enough to
// swallow a tailbeat, high enough that a species change or a camera move does
// not visibly crawl into place.
const LABEL_DAMPING = 0.18;

// NOTE ON WHAT THE LAYOUT ACTUALLY RUNS AGAINST.
//
// Two positions are computed per part, and keeping them apart is the single
// biggest reason the plate holds still:
//
//   the leader's endpoint — the ANIMATED vertex, sampled out of the VAT the
//     same way the shader does. It has to be exact, or the line stops
//     pointing at the feature it names.
//   the layout's input — the REST vertex under the same instance transform.
//     It carries every change that should move a label (the camera, the
//     body's own transform) and none of the change that should not (the
//     tailbeat).
//
// Smoothing the animated anchor was tried first and is strictly worse: a
// low-pass filter slow enough to flatten a lamprey's tail sweep is also slow
// enough to lag a camera move, so it traded one artefact for another. The
// rest pose is not an approximation of the still position — it IS the still
// position, so there is nothing left to filter and no lag to pay for it.
// How far past the midline an anchor has to travel before its label changes
// sides. Without it, a feature sitting near centre swaps columns on the
// tailbeat alone.
const COLUMN_HYSTERESIS_PX = 40;

const tmpVec = new THREE.Vector3();
const tmpRest = new THREE.Vector3();
const tmpNormal = new THREE.Vector3();
const tmpMatrix = new THREE.Matrix4();
const viewDir = new THREE.Vector3();

// Per-part render state, keyed by part id: the SVG nodes (built once and
// updated in place rather than recreated 60 times a second), the last y the
// label was drawn at (what the damping eases from), and which column it was
// in (what the hysteresis compares against).
const labelState = new Map();

// True while the user is dragging the camera. Damping is skipped then: the
// lag that reads as "settling" during a tailbeat reads as "unresponsive"
// during a drag, because the user is the one moving the anchors.
let orbiting = false;
controls.addEventListener("start", () => { orbiting = true; });
controls.addEventListener("end", () => { orbiting = false; });

function setAttrIfMoved(node, name, value) {
  // Sub-pixel writes are invisible and still dirty the SVG's layout, and
  // there are ~33 of them a frame.
  const next = value.toFixed(1);
  if (node.getAttribute(name) !== next) node.setAttribute(name, next);
}

// The nodes for one part, created on first sight and reused thereafter.
function nodesFor(part) {
  let state = labelState.get(part.id);
  if (state) return state;

  const svgNs = "http://www.w3.org/2000/svg";
  const leader = document.createElementNS(svgNs, "line");
  leader.setAttribute("class", "anatomy-leader");
  const tick = document.createElementNS(svgNs, "circle");
  tick.setAttribute("class", "anatomy-tick");
  tick.setAttribute("r", 2.5);
  const text = document.createElementNS(svgNs, "text");
  text.setAttribute("class", "anatomy-label");
  const title = document.createElementNS(svgNs, "title");
  text.appendChild(title);

  state = {
    leader,
    tick,
    text,
    title,
    labelY: null,
    onLeft: null,
    // The smoothed anchor the layout runs against — see ANCHOR_SMOOTHING.
    layoutX: null,
    layoutY: null,
  };
  labelState.set(part.id, state);
  overlaySvg.append(leader, tick, text);
  return state;
}

function hideAllLabels() {
  for (const state of labelState.values()) {
    state.leader.style.display = "none";
    state.tick.style.display = "none";
    state.text.style.display = "none";
  }
}

// Species change: the new species' parts are a different set, and any y
// remembered from the old one would be eased FROM rather than snapped past.
function resetLabelLayout() {
  overlaySvg.replaceChildren();
  labelState.clear();
}

// Keeps the nodes but drops every remembered position, so the next frame
// places the labels outright instead of easing to them.
//
// Needed because the layout runs against a heavily smoothed anchor: an
// instantaneous camera move (Reset view) is a real jump the smoothing has no
// way to tell apart from a very fast swim, and without this the whole plate
// would crawl into its new position over a couple of seconds.
function snapLabelLayout() {
  for (const state of labelState.values()) {
    state.labelY = null;
    state.layoutX = null;
    state.layoutY = null;
  }
}

function renderAnatomyOverlay() {
  if (!labelsToggle.checked || !fishRenderer || anatomyParts.length === 0) {
    hideAllLabels();
    return;
  }

  const instanceMesh = fishRenderer.meshForSpecies(currentSpecies);
  if (!instanceMesh) {
    hideAllLabels();
    return;
  }
  const width = window.innerWidth;
  const height = window.innerHeight;
  instanceMesh.getMatrixAt(0, tmpMatrix);

  const visible = [];
  for (const part of anatomyParts) {
    animatedLocalPosition(
      fishAssets,
      part,
      previewFish.swimCyclePos,
      previewFish.wobblePhase,
      tmpVec,
    );
    tmpVec.applyMatrix4(tmpMatrix);

    // Facing test — but only for genuinely paired lateral features (eye,
    // operculum, pectoral/pelvic fin, lateral line: |part.side| > 0.5, see
    // fishAnatomy.js). A midline feature like the dorsal or adipose fin is a
    // thin sheet, and the sheet's FACE normal points sideways even though
    // its POSITION is on the midline — testing it the same way as a real
    // paired feature made the whole fin blink out for roughly half of every
    // rotation, which is a property of that one vertex's normal, not of
    // whether the fin itself is actually facing away.
    const screen = tmpVec.clone().project(camera);
    if (Math.abs(part.side) > 0.5) {
      tmpNormal.copy(part.restNormal).transformDirection(tmpMatrix);
      viewDir.copy(tmpVec).sub(camera.position);
      if (tmpNormal.dot(viewDir) > 0) continue;
    }
    if (screen.z > 1) continue; // behind the camera

    // The same vertex in its REST pose, under the same instance transform —
    // what the layout runs against. See the note by LABEL_DAMPING above.
    const restScreen = tmpRest
      .copy(part.restPosition)
      .applyMatrix4(tmpMatrix)
      .project(camera);

    visible.push({
      part,
      // Where the leader actually ends: the real, animated vertex.
      x: (screen.x * 0.5 + 0.5) * width,
      y: (-screen.y * 0.5 + 0.5) * height,
      // Where the layout places it from: the same feature, not mid-stroke.
      layoutX: (restScreen.x * 0.5 + 0.5) * width,
      layoutY: (-restScreen.y * 0.5 + 0.5) * height,
    });
  }

  // The panel narrows the usable right half of the screen. That used to be
  // handled by routing any anchor whose label would land inside the panel's
  // footprint over to the left column — a per-ANCHOR test, which was right
  // when a label's x came from its anchor's x.
  //
  // It is not right any more, and it failed loudly: the test was "x past the
  // midline and y above the panel's bottom", and the panel now runs nearly
  // the full height of the viewport, so it captured the entire right half and
  // stacked all eleven labels into one column. With the columns at fixed
  // gutters the whole question is answered once, by clamping the right column
  // clear of the panel below — a label there can never be underneath it.
  const panelRect = inspectPanel.getBoundingClientRect();

  // The two columns. Fixed for the frame, and derived from the viewport
  // rather than from any anchor — this is what stops label x moving at all.
  const gutter = Math.min(width * LABEL_GUTTER_FRACTION, LABEL_GUTTER_MAX);
  const leftX = Math.max(width / 2 - gutter, LABEL_EDGE_MARGIN);
  const rightX = Math.min(
    width / 2 + gutter,
    width - LABEL_EDGE_MARGIN,
    // Never under the panel, whatever the gutter says.
    panelRect.left - 12,
  );

  // Below this the right column would have to sit left of the left one — two
  // columns need more room than a narrow phone screen has, so everything goes
  // to the one column that is actually clear top to bottom.
  const singleColumn = rightX - leftX < 120;

  // Column assignment, with hysteresis against whichever side each part was
  // on last frame. A part with no history takes the plain midline test.
  for (const v of visible) {
    const previous = labelState.get(v.part.id);
    const wasLeft = previous?.onLeft;
    if (singleColumn) {
      v.onLeft = true;
    } else if (wasLeft === true) {
      v.onLeft = v.layoutX < width / 2 + COLUMN_HYSTERESIS_PX;
    } else if (wasLeft === false) {
      v.onLeft = v.layoutX < width / 2 - COLUMN_HYSTERESIS_PX;
    } else {
      v.onLeft = v.layoutX < width / 2;
    }
  }

  // Sorted on the smoothed height, so the running order of a column does not
  // reshuffle every time two features cross during a stroke.
  const left = visible.filter((v) => v.onLeft).sort((a, b) => a.layoutY - b.layoutY);
  const right = visible.filter((v) => !v.onLeft).sort((a, b) => a.layoutY - b.layoutY);

  const bandTop = height * LABEL_BAND_TOP;
  const bandBottom = height * LABEL_BAND_BOTTOM;

  for (const column of [left, right]) {
    if (column.length === 0) continue;

    // The fan. Each label is pulled from its anchor's height toward an even
    // share of the band — sorted by anchor y just above, so a feature higher
    // on the fish still gets a higher label and the leaders never cross.
    //
    // This is what keeps the leaders off the model: level labels mean flat
    // leaders straight through the body, and a column spread over the full
    // frame height means they arrive steeply from above and below instead.
    const span = bandBottom - bandTop;
    column.forEach((v, i) => {
      const slot =
        column.length === 1
          ? (bandTop + bandBottom) / 2
          : bandTop + (span * i) / (column.length - 1);
      v.labelY = v.layoutY + (slot - v.layoutY) * LABEL_VERTICAL_SPREAD;
    });

    // Down-pass: separate anything still closer than the minimum gap. The fan
    // above spaces the column out but does not guarantee the gap — two
    // features at nearly the same height stay nearly together after it.
    let previousY = -Infinity;
    for (const v of column) {
      v.labelY = Math.max(v.labelY, previousY + LABEL_MIN_GAP);
      previousY = v.labelY;
    }
    // Up-pass: the down-pass can only ever push labels lower, so a crowded
    // column walks off the bottom of the viewport and away from the anchors
    // it belongs to. This pushes the overflow back up against the bottom
    // edge, which re-centres the column on its own anchors.
    let ceiling = height - LABEL_EDGE_MARGIN / 4;
    for (let i = column.length - 1; i >= 0; i--) {
      column[i].labelY = Math.min(column[i].labelY, ceiling);
      ceiling = column[i].labelY - LABEL_MIN_GAP;
    }
  }

  const drawn = new Set();
  for (const v of visible) {
    const state = nodesFor(v.part);
    drawn.add(v.part.id);

    const labelX = v.onLeft ? leftX : rightX;

    // Damped unless the label has just appeared, just changed sides, or the
    // user is driving the camera. No distance threshold here either, for the
    // same reason as the anchor smoothing above.
    let labelY = v.labelY;
    if (state.labelY !== null && !orbiting && state.onLeft === v.onLeft) {
      labelY = state.labelY + (labelY - state.labelY) * LABEL_DAMPING;
    }
    state.labelY = labelY;
    state.onLeft = v.onLeft;
    state.layoutX = v.layoutX;
    state.layoutY = v.layoutY;

    state.leader.style.display = "";
    state.tick.style.display = "";
    state.text.style.display = "";

    setAttrIfMoved(state.leader, "x1", v.x);
    setAttrIfMoved(state.leader, "y1", v.y);
    setAttrIfMoved(state.leader, "x2", labelX);
    setAttrIfMoved(state.leader, "y2", labelY);

    setAttrIfMoved(state.tick, "cx", v.x);
    setAttrIfMoved(state.tick, "cy", v.y);

    setAttrIfMoved(state.text, "x", labelX);
    setAttrIfMoved(state.text, "y", labelY);
    const anchor = v.onLeft ? "end" : "start";
    if (state.text.getAttribute("text-anchor") !== anchor) {
      state.text.setAttribute("text-anchor", anchor);
    }
    if (state.text.firstChild !== state.title || state.label !== v.part.label) {
      state.label = v.part.label;
      state.text.replaceChildren(state.title, document.createTextNode(v.part.label));
      state.title.textContent = v.part.note;
    }
  }

  // Culled this frame (facing test, behind the camera). Hidden rather than
  // removed, and their remembered y is dropped so they ease in from their
  // real position when they come back rather than from wherever the column
  // happened to leave them.
  for (const [id, state] of labelState) {
    if (drawn.has(id)) continue;
    state.leader.style.display = "none";
    state.tick.style.display = "none";
    state.text.style.display = "none";
    state.labelY = null;
    state.layoutX = null;
    state.layoutY = null;
  }
}

// ---------------------------------------------------------------------
// Boot the panel.
//
// Deliberately down here rather than beside the functions above: setSpecies()
// calls resetLabelLayout(), which touches the overlay's `labelState` — a
// module-scope const declared in the section above this one. Running the
// bootstrap up with its own functions put it before that declaration and hit
// the temporal dead zone on load.
// ---------------------------------------------------------------------
buildSpeciesList();
buildLengthScale();
setSpecies(currentSpecies);

// ---------------------------------------------------------------------
// Animation loop
// ---------------------------------------------------------------------
let simTime = 0;
let lastFrameTime = null;

// One frame at 60fps, the unit fishMesh.js's update() expects its dt in.
const REFERENCE_FRAME_MS = 1000 / 60;

function loop(t) {
  const dt = lastFrameTime === null ? 0 : t - lastFrameTime;
  lastFrameTime = t;
  simTime += dt;

  controls.update();

  if (fishRenderer && previewFish) {
    // dt in 60fps-frame units, matching main.js's loop — fishMesh.js's update()
    // ACCUMULATES the tailbeat per call, so leaving it at the parameter default
    // of 1 makes the stroke rate a function of refresh rate: 2.4x too fast on a
    // 144Hz display, half speed at 30fps. Clamped for the same reason main.js
    // clamps its own: a tab that was backgrounded comes back with one enormous
    // delta, and the tail should drop that motion rather than snap through it.
    fishRenderer.update(
      [previewFish],
      simTime,
      playingToggle.checked,
      Math.min(4, dt / REFERENCE_FRAME_MS),
    );
    renderAnatomyOverlay();
  }

  renderer.render(scene, camera);
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);

loadFishAssets()
  .then((assetsByUrl) => {
    assetsByUrlRef = assetsByUrl;
    fishAssets = assetsByUrl.get(SPECIES_MODEL_URL[currentSpecies]);
    fishRenderer = createFishInstancedMesh(assetsByUrl, 1);
    scene.add(fishRenderer.mesh);

    // uCausticsStrength (see buildSpeciesRenderer in fishMesh.js) is tuned
    // for the river, where depth dimming and distance fog both cut it down
    // before it reaches the eye — neither exists on this page, so at the
    // river's value the procedural glow (see QUALITY.realCaustics above)
    // reads as flat green blotches sitting on the fins instead of a glint.
    // Reaching into the material's own uniforms rather than adding a new
    // buildSpeciesRenderer parameter for a tweak only this page wants.
    fishRenderer.mesh.traverse((child) => {
      if (child.material?.uniforms?.uCausticsStrength) {
        child.material.uniforms.uCausticsStrength.value = 3;
      }
    });

    anatomyParts = resolveAnatomy(currentSpecies, assetsByUrl);

    fishLoadingEl.classList.add("hidden");
    fishLoadingEl.addEventListener(
      "transitionend",
      () => fishLoadingEl.remove(),
      { once: true },
    );
  })
  .catch((err) => console.error("Failed to load fish model:", err));
