// sceneSetup.js
// Renderer, camera, lights, and resize handling for the 3D river scene.
// The camera is a fixed, world-anchored vantage point (not tracking the
// fish) chosen to read the run as a whole: elevated and pulled back near
// the spawn edge, angled down-and-across so the school's flow sweeps
// through the frame left-to-right while the caustics net on the riverbed
// stays in view below it. A slow orbit + distance "breathe" keeps it from
// feeling like a frozen screenshot without ever following the fish.

import * as THREE from "three";

const FOV = 50;
const NEAR = 1;

// Camera framing, expressed as fractions of the world bounds. worldX =
// fish.x (downstream), worldZ = fish.y (across-river), worldY is up
// (0 = water surface, negative = underwater toward the riverbed).
const EYE_FRAC = { x: 0.2, y: 0.08, z: 0.5 };
const TARGET_FRAC = { x: 0.03, y: -0.05, z: 0.5 }; // look-at point: near the spawn edge, just under the surface

// Slow sinusoidal orbit around the look-at point — enough for parallax,
// not a full spin. Plus a slower, non-matching-period dolly "breathe" so
// the motion doesn't feel like a mechanical loop even on a short clip.
const DRIFT_AMPLITUDE = 0.1; // radians
const DRIFT_PERIOD_MS = 26000;
const BREATHE_AMPLITUDE = 0.03; // fraction of camera distance
const BREATHE_PERIOD_MS = 34000;

export function createSceneSetup(canvas, bounds) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));

  const scene = new THREE.Scene();
  scene.background = new THREE.Color("#04121a");

  const camera = new THREE.PerspectiveCamera(FOV, 1, NEAR, 1000);

  const sun = new THREE.DirectionalLight(0xfff2d6, 2.2);
  sun.position.set(0.4, 1, 0.25);
  scene.add(sun);
  scene.add(new THREE.AmbientLight(0x8fb8c8, 0.55));
  const fill = new THREE.HemisphereLight(0x9fd8ff, 0x14201a, 0.5);
  scene.add(fill);

  let baseEye = new THREE.Vector3();
  let target = new THREE.Vector3();

  // Recomputes the camera's rest eye/look-at points from the *_FRAC
  // fractions above, scaled to the current world bounds.
  function setFraming(b) {
    baseEye.set(b.width * EYE_FRAC.x, b.height * EYE_FRAC.y, b.height * EYE_FRAC.z);
    target.set(b.width * TARGET_FRAC.x, b.height * TARGET_FRAC.y, b.height * TARGET_FRAC.z);
  }

  // Resizes the renderer/camera to the new viewport and re-derives the
  // framing points (they're expressed as fractions of bounds, not fixed units).
  function resize(b) {
    renderer.setSize(b.width, b.height);
    camera.aspect = b.width / b.height;
    camera.far = Math.max(b.width, b.height) * 5;
    camera.updateProjectionMatrix();
    setFraming(b);
  }

  resize(bounds);

  const offset = new THREE.Vector3();
  const yAxis = new THREE.Vector3(0, 1, 0);

  // Per-frame camera update: starts from the rest eye->target offset, then
  // rotates it slowly around the target (drift) and scales its length
  // (breathe), so the camera orbits/pulses gently without ever tracking
  // the fish or completing a full, loop-obvious cycle.
  function updateCamera(t) {
    offset.copy(baseEye).sub(target);
    const driftAngle = Math.sin((t / DRIFT_PERIOD_MS) * Math.PI * 2) * DRIFT_AMPLITUDE;
    offset.applyAxisAngle(yAxis, driftAngle);
    const breathe = 1 + Math.sin((t / BREATHE_PERIOD_MS) * Math.PI * 2) * BREATHE_AMPLITUDE;
    offset.multiplyScalar(breathe);
    camera.position.copy(target).add(offset);
    camera.lookAt(target);
  }

  updateCamera(0);

  return { renderer, scene, camera, resize, updateCamera };
}
