// inspect.js
// Standalone single-fish viewer. Same fish shader/animation pipeline as the
// river scene (scene/fishMesh.js) — one InstancedMesh, VAT-baked swim clip,
// caustic glow, depth fog — but with exactly one instance, an orbit camera,
// and none of the river/timeline/quality-governor machinery main.js builds
// around it. For eyeballing the mesh/texture/swim clip in isolation: both
// while authoring a new model (see scripts/swim_rig.py) and as a "look at the
// fish" view for a viewer who just wants to see one up close.
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
import { loadFishAssets, createFishInstancedMesh } from "./scene/fishMesh.js";
import { Fish, BODY_VISUAL_SCALE } from "./boids.js";

const canvas = document.getElementById("fish-canvas");
const fishLoadingEl = document.getElementById("fish-loading");
const speciesSelect = document.getElementById("species-select");
const speedRange = document.getElementById("speed-range");
const amplitudeRange = document.getElementById("amplitude-range");
const playingToggle = document.getElementById("playing-toggle");
const rotateToggle = document.getElementById("rotate-toggle");
const wireframeToggle = document.getElementById("wireframe-toggle");
const shininessRange = document.getElementById("shininess-range");
const specularStrengthRange = document.getElementById("specular-strength-range");
const specularFresnelRange = document.getElementById("specular-fresnel-range");
const specularTintRange = document.getElementById("specular-tint-range");
const diffuseFloorRange = document.getElementById("diffuse-floor-range");
const diffuseCeilRange = document.getElementById("diffuse-ceil-range");
const bumpStrengthRange = document.getElementById("bump-strength-range");
const scaleFrequencyRange = document.getElementById("scale-frequency-range");
const iridescenceStrengthRange = document.getElementById("iridescence-strength-range");

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
// it — called on load and whenever the species changes the rendered body
// length. Not re-run every frame: that would fight the user's own zoom/drag.
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

function resize() {
  const width = window.innerWidth;
  const height = window.innerHeight;
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
  renderer.setSize(width, height);
}
window.addEventListener("resize", resize);
resize();

// ---------------------------------------------------------------------
// The one fish. Built from boids.js's real Fish class rather than a bare
// object literal so it gets the same per-species length range, wobble phase
// and swim-rate/amplitude jitter a flock member would (see the constructor in
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
  return fish;
}

let fishRenderer = null;

function setSpecies(species) {
  previewFish = makePreviewFish(species);
  frameCamera(previewFish.length * BODY_VISUAL_SCALE);
  // Each model carries its own material tuning now (see MATERIAL_OVERRIDES in
  // fishMesh.js), so the panel has to follow the selection rather than sit on
  // whatever was last dragged.
  syncSlidersFromMaterial();
}

setSpecies(speciesSelect.value);

speciesSelect.addEventListener("change", () => setSpecies(speciesSelect.value));

wireframeToggle.addEventListener("change", () => {
  fishRenderer?.mesh.traverse((child) => {
    if (child.material) child.material.wireframe = wireframeToggle.checked;
  });
});

rotateToggle.addEventListener("change", () => {
  controls.autoRotate = rotateToggle.checked;
});

// Shine-tuning knobs, wired straight to the selected species' material
// uniforms — these are things this page wants to poke at, not general
// buildSpeciesRenderer parameters, so they live here rather than in the
// renderer's API.
//
// `scale` maps slider units to uniform units; `toSlider` is its inverse, used
// by syncSlidersFromMaterial below. Both directions matter now: the three
// models no longer share one tuning (see MATERIAL_OVERRIDES in fishMesh.js), so
// these sliders have to be able to SHOW what a species actually ships with, not
// just impose a value on it.
const materialSliders = [
  { input: shininessRange, uniform: "uShininess", scale: (v) => v, toSlider: (v) => v },
  { input: specularStrengthRange, uniform: "uSpecularStrength", scale: (v) => v / 100, toSlider: (v) => v * 100 },
  { input: specularFresnelRange, uniform: "uSpecularFresnel", scale: (v) => v / 100, toSlider: (v) => v * 100 },
  { input: specularTintRange, uniform: "uSpecularTint", scale: (v) => v / 100, toSlider: (v) => v * 100 },
  { input: diffuseFloorRange, uniform: "uDiffuseFloor", scale: (v) => v / 100, toSlider: (v) => v * 100 },
  { input: diffuseCeilRange, uniform: "uDiffuseCeil", scale: (v) => v / 100, toSlider: (v) => v * 100 },
  { input: bumpStrengthRange, uniform: "uBumpStrength", scale: (v) => v / 100, toSlider: (v) => v * 100 },
  { input: scaleFrequencyRange, uniform: "uScaleFrequency", scale: (v) => v, toSlider: (v) => v },
  { input: iridescenceStrengthRange, uniform: "uIridescenceStrength", scale: (v) => v / 100, toSlider: (v) => v * 100 },
];

// The material backing whichever species the select is on. Null until
// loadFishAssets() resolves, which is why every use below is guarded — the
// sliders exist and can be dragged before the model has finished loading.
function activeMaterial() {
  return fishRenderer?.materialForSpecies(speciesSelect.value) ?? null;
}

// Pull the selected species' shipped values into the slider positions. Called
// on load and on every species change, so switching from chinook to shad moves
// the sliders to shad's own tuning instead of silently applying chinook's.
function syncSlidersFromMaterial() {
  const material = activeMaterial();
  if (!material) return;
  for (const { input, uniform, toSlider } of materialSliders) {
    const value = material.uniforms[uniform]?.value;
    if (value !== undefined) input.value = String(Math.round(toSlider(value)));
  }
}

// Writes only the selected species' material, so tuning a chinook leaves the
// steelhead and the shad on their own values.
function applyMaterialSliders() {
  const material = activeMaterial();
  if (!material) return;
  for (const { input, uniform, scale } of materialSliders) {
    if (material.uniforms[uniform]) {
      material.uniforms[uniform].value = scale(Number(input.value));
    }
  }
}

for (const { input } of materialSliders) {
  input.addEventListener("input", applyMaterialSliders);
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
    // Sliders drive these directly every frame rather than being read once —
    // smoothSpeed feeds fishMesh.js's tailbeat-rate derivation (see
    // STRIDE_LENGTH there), so this is a live "what does this rate look
    // like" control, not a one-shot setting. 1.2 matches BASE_MAX_SPEED in
    // main.js, so 100% here reads the same tailbeat a flocking fish at normal
    // cruise would.
    previewFish.smoothSpeed = 1.2 * (Number(speedRange.value) / 100);
    previewFish.swimAmplitude = Number(amplitudeRange.value) / 100;
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
  }

  renderer.render(scene, camera);
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);

loadFishAssets()
  .then((assetsByUrl) => {
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
      if (wireframeToggle.checked && child.material) {
        child.material.wireframe = true;
      }
    });
    // Read, not write. The materials were just built with each model's own
    // tuning; the panel's job is to show it.
    syncSlidersFromMaterial();

    fishLoadingEl.classList.add("hidden");
    fishLoadingEl.addEventListener(
      "transitionend",
      () => fishLoadingEl.remove(),
      { once: true },
    );
  })
  .catch((err) => console.error("Failed to load fish model:", err));
