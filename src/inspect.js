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
import { runData } from "./data.js";

const canvas = document.getElementById("fish-canvas");
const fishLoadingEl = document.getElementById("fish-loading");
const speciesSelect = document.getElementById("species-select");
const playingToggle = document.getElementById("playing-toggle");
const rotateToggle = document.getElementById("rotate-toggle");
const labelsToggle = document.getElementById("labels-toggle");
const resetViewBtn = document.getElementById("reset-view");
const fieldGuideEl = document.getElementById("field-guide");
const overlaySvg = document.getElementById("anatomy-overlay");
const inspectPanel = document.getElementById("inspect-panel");

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
};
const COMMON_NAMES = {
  chinook: "Chinook Salmon",
  jackChinook: "Jack Chinook Salmon",
  steelhead: "Steelhead",
  shad: "American Shad",
};
const SPECIES_NOTES = {
  chinook: "The largest Pacific salmon, and the species this counting season is named for.",
  jackChinook: "A “jack” is a precocious male Chinook that returns to spawn a year early, at a much smaller size than a typical adult.",
  steelhead: "A sea-run form of rainbow trout. Unlike Pacific salmon, some steelhead survive spawning and return to the ocean to spawn again.",
  shad: "Not native to the Columbia Basin — introduced from the Atlantic coast in the 1870s.",
};
const MONTH_NAMES = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

// Real per-day DART counts for the species currently on screen — the season
// total and the date it peaked on, both sourced from the same record the
// river and the plates drawer read (see data.js).
function seasonStatsFor(species) {
  let total = 0;
  let peakValue = -1;
  let peakDate = null;
  for (const day of runData) {
    const value = day[species] ?? 0;
    total += value;
    if (value > peakValue) {
      peakValue = value;
      peakDate = day.date;
    }
  }
  return { total, peakDate };
}

function formatDate(dateStr) {
  const [, month, day] = dateStr.split("-").map(Number);
  return `${MONTH_NAMES[month - 1]} ${day}`;
}

function updateFieldGuide(species) {
  const [minLen, maxLen] = SPECIES_LENGTH_INCHES[species];
  const { total, peakDate } = seasonStatsFor(species);
  fieldGuideEl.innerHTML = "";

  const head = document.createElement("p");
  head.className = "field-head";
  head.innerHTML = `<span class="label">Field notes</span>`;
  fieldGuideEl.appendChild(head);

  const common = document.createElement("p");
  common.className = "fg-common";
  common.textContent = COMMON_NAMES[species];
  fieldGuideEl.appendChild(common);

  const scientific = document.createElement("p");
  scientific.className = "fg-scientific";
  scientific.innerHTML = `<i>${SCIENTIFIC_NAMES[species]}</i>`;
  fieldGuideEl.appendChild(scientific);

  const rows = [
    ["Adult length", `${minLen}–${maxLen} in`],
    ["Season total, LWG 2015", total.toLocaleString()],
    ["Peak passage", peakDate ? formatDate(peakDate) : "—"],
  ];
  for (const [label, value] of rows) {
    const row = document.createElement("p");
    row.className = "fg-row";
    row.innerHTML = `<span class="label">${label}</span><b>${value}</b>`;
    fieldGuideEl.appendChild(row);
  }

  const note = document.createElement("p");
  note.className = "fg-note";
  note.textContent = SPECIES_NOTES[species];
  fieldGuideEl.appendChild(note);
}

function setSpecies(species) {
  previewFish = makePreviewFish(species);
  lastBodyLength = previewFish.length * BODY_VISUAL_SCALE;
  frameCamera(lastBodyLength);
  updateFieldGuide(species);
  if (assetsByUrlRef) {
    fishAssets = assetsByUrlRef.get(SPECIES_MODEL_URL[species]);
    anatomyParts = resolveAnatomy(species, assetsByUrlRef);
  }
}

setSpecies(speciesSelect.value);

speciesSelect.addEventListener("change", () => setSpecies(speciesSelect.value));

rotateToggle.addEventListener("change", () => {
  controls.autoRotate = rotateToggle.checked;
});

// ---------------------------------------------------------------------
// Anatomy overlay — leader lines drawn each frame from the projected screen
// position of the resolved anchors (see scene/fishAnatomy.js). Built fresh
// every frame rather than diffed: at ~10 parts this is a handful of DOM
// writes, well under what would need pooling.
// ---------------------------------------------------------------------
const LABEL_OFFSET = 130;
const LABEL_MIN_GAP = 15;
// Room for the longest label text ("Caudal Peduncle") between its anchor
// point and the edge of the viewport — see the clamp in the render loop.
const LABEL_EDGE_MARGIN = 115;

const tmpVec = new THREE.Vector3();
const tmpNormal = new THREE.Vector3();
const tmpMatrix = new THREE.Matrix4();
const viewDir = new THREE.Vector3();

function renderAnatomyOverlay() {
  if (!labelsToggle.checked || !fishRenderer || anatomyParts.length === 0) {
    overlaySvg.replaceChildren();
    return;
  }

  const instanceMesh = fishRenderer.meshForSpecies(speciesSelect.value);
  if (!instanceMesh) {
    overlaySvg.replaceChildren();
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
    visible.push({
      part,
      x: (screen.x * 0.5 + 0.5) * width,
      y: (-screen.y * 0.5 + 0.5) * height,
    });
  }

  // The panel narrows the usable right half of the screen — on a narrow
  // viewport it can cover most of it (see inspect.css's #inspect-panel).
  // Any anchor that would land a right-column label inside the panel's own
  // footprint goes to the left column instead, rather than drawing a label
  // the panel immediately covers.
  const panelRect = inspectPanel.getBoundingClientRect();
  const underPanel = (v) => v.x >= width / 2 && v.y < panelRect.bottom;
  // Below this, a right-column label plus its offset runs past the edge of
  // the viewport before it runs into the panel — two columns need more room
  // than a narrow phone screen has, so everything goes to the one column
  // that's actually clear top to bottom.
  const singleColumn = width < 2 * LABEL_OFFSET + 260;

  const left = visible
    .filter((v) => singleColumn || v.x < width / 2 || underPanel(v))
    .sort((a, b) => a.y - b.y);
  const right = singleColumn
    ? []
    : visible.filter((v) => v.x >= width / 2 && !underPanel(v)).sort((a, b) => a.y - b.y);
  for (const column of [left, right]) {
    let prevY = -Infinity;
    for (const v of column) {
      v.labelY = Math.max(v.y, prevY + LABEL_MIN_GAP);
      prevY = v.labelY;
    }
  }

  const svgNs = "http://www.w3.org/2000/svg";
  const frag = document.createDocumentFragment();
  // Which column a point renders in (and so which way its leader runs) is
  // decided by the filters above — not re-derived from v.x here, since
  // underPanel() can route a right-half anchor into the left column.
  for (const [column, onLeft] of [[left, true], [right, false]]) {
    for (const v of column) {
      // Clamped rather than left to run past the viewport edge — a label
      // near the left or right edge of a narrow screen otherwise draws
      // partly off-screen instead of just sitting closer to its anchor.
      const rawLabelX = onLeft ? v.x - LABEL_OFFSET : v.x + LABEL_OFFSET;
      const labelX = onLeft
        ? Math.max(rawLabelX, LABEL_EDGE_MARGIN)
        : Math.min(rawLabelX, width - LABEL_EDGE_MARGIN);

      const leader = document.createElementNS(svgNs, "line");
      leader.setAttribute("class", "anatomy-leader");
      leader.setAttribute("x1", v.x.toFixed(1));
      leader.setAttribute("y1", v.y.toFixed(1));
      leader.setAttribute("x2", labelX.toFixed(1));
      leader.setAttribute("y2", v.labelY.toFixed(1));
      frag.appendChild(leader);

      const tick = document.createElementNS(svgNs, "circle");
      tick.setAttribute("class", "anatomy-tick");
      tick.setAttribute("cx", v.x.toFixed(1));
      tick.setAttribute("cy", v.y.toFixed(1));
      tick.setAttribute("r", 2.5);
      frag.appendChild(tick);

      const text = document.createElementNS(svgNs, "text");
      text.setAttribute("class", "anatomy-label");
      text.setAttribute("x", labelX.toFixed(1));
      text.setAttribute("y", v.labelY.toFixed(1));
      text.setAttribute("text-anchor", onLeft ? "end" : "start");
      text.textContent = v.part.label;
      text.appendChild(document.createElementNS(svgNs, "title")).textContent = v.part.note;
      frag.appendChild(text);
    }
  }
  overlaySvg.replaceChildren(frag);
}

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
    fishAssets = assetsByUrl.get(SPECIES_MODEL_URL[speciesSelect.value]);
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

    anatomyParts = resolveAnatomy(speciesSelect.value, assetsByUrl);

    fishLoadingEl.classList.add("hidden");
    fishLoadingEl.addEventListener(
      "transitionend",
      () => fishLoadingEl.remove(),
      { once: true },
    );
  })
  .catch((err) => console.error("Failed to load fish model:", err));
