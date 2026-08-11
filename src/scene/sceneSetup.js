// sceneSetup.js
// Renderer, camera, lights, and resize handling for the 3D river scene.
// The camera starts at a world-anchored vantage point chosen to read the
// run as a whole: elevated and pulled back near the spawn edge, angled
// down-and-across so the school's flow sweeps through the frame
// left-to-right while the caustics net on the riverbed stays in view
// below it. From there, OrbitControls hands the camera to the user:
// drag to orbit, scroll to zoom (dolly), right-drag to pan.

import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

const FOV = 90;
const NEAR = 1;

// Initial camera framing, expressed as fractions of the world bounds.
// worldX = fish.x (downstream), worldZ = fish.y (across-river), worldY is
// up (0 = water surface, negative = underwater toward the riverbed). Only
// applied once at startup — after that, the user's OrbitControls drag/zoom
// state is authoritative and resize() must not stomp on it.
const EYE_FRAC = { x: 1, y: 0.008, z: 0.5 };
const TARGET_FRAC = { x: 0.0003, y: -0.005, z: 0.005 }; // look-at point: near the spawn edge, just under the surface

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

  // Resizes the renderer/camera to the new viewport. Deliberately does NOT
  // touch camera position/target — once OrbitControls is live, wherever the
  // user has dragged/zoomed the camera to is authoritative, and snapping it
  // back to the rest framing on every resize would fight their input.
  function resize(b) {
    renderer.setSize(b.width, b.height);
    camera.aspect = b.width / b.height;
    camera.far = Math.max(b.width, b.height) * 5;
    camera.updateProjectionMatrix();
  }

  resize(bounds);

  // Initial framing, applied once: camera starts at EYE_FRAC looking at
  // TARGET_FRAC, both scaled to the starting world bounds.
  camera.position.set(
    bounds.width * EYE_FRAC.x,
    bounds.height * EYE_FRAC.y,
    bounds.height * EYE_FRAC.z,
  );
  const initialTarget = new THREE.Vector3(
    bounds.width * TARGET_FRAC.x,
    bounds.height * TARGET_FRAC.y,
    bounds.height * TARGET_FRAC.z,
  );

  // Hands camera control to the user: left-drag orbits around the target,
  // scroll dollies in/out, right-drag pans. Damping makes drags/scrolls
  // settle smoothly instead of stopping dead the instant input stops —
  // updateCamera() below has to keep calling controls.update() every frame
  // for that easing to actually play out.
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.copy(initialTarget);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.update();

  function updateCamera() {
    controls.update();
  }

  return { renderer, scene, camera, controls, resize, updateCamera };
}
