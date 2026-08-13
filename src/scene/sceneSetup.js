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
import { FOG_COLOR, fogDensity } from "./fog.js";
import { seasonForDay } from "./season.js";

const FOV = 90;
const NEAR = 1;

// Sky sphere scale, as a fraction of camera.far — kept comfortably inside
// the far plane so it never gets clipped as bounds/camera.far change on resize.
const SKY_RADIUS_FRAC = 0.9;

// Initial camera framing, expressed as fractions of the world bounds.
// worldX = fish.x (downstream), worldZ = fish.y (across-river), worldY is
// up (0 = water surface, negative = underwater toward the riverbed). Only
// applied once at startup — after that, the user's OrbitControls drag/zoom
// state is authoritative and resize() must not stomp on it.
// Values below were picked by eye using the D-key debug readout (see
// main.js) at a 1498x1308 viewport, then expressed as fractions of bounds
// so the same framing holds proportionally at other window sizes.
const EYE_FRAC = { x: 1.0501, y: -0.2362, z: 0.9289 };
const TARGET_FRAC = { x: -0.0381, y: -0.055, z: 0.0757 };

// Clamps how far OrbitControls can dolly out, as a fraction of the world's
// largest dimension — same basis as camera.far below. 1.328 is the
// distance-to-target read off the debug panel at the point zooming out
// started to feel too far.
const MAX_ZOOM_DISTANCE_FRAC = 1.328;

export function createSceneSetup(canvas, bounds) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));

  const scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(FOG_COLOR, fogDensity(bounds));
  const atmosphereColor = new THREE.Color("#1d423b");
  const depthsColor = new THREE.Color("#051b17");

  // Background is a sky sphere rather than a flat scene.background color, so
  // it can gradient by world Y (0 = water surface, matching depthRange/
  // terrain elsewhere): flat atmosphereColor above the surface, fading to
  // depthsColor the further below it a ray points. It's re-centered on the
  // camera every frame (see updateCamera) but never rotated, so its
  // local-space position doubles as world-space view direction with no
  // extra transform needed.
  const sky = new THREE.Mesh(
    new THREE.SphereGeometry(1, 32, 16),
    new THREE.ShaderMaterial({
      uniforms: {
        atmosphereColor: { value: atmosphereColor },
        depthsColor: { value: depthsColor },
      },
      vertexShader: `
        varying vec3 vPosition;
        void main() {
          vPosition = position;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform vec3 atmosphereColor;
        uniform vec3 depthsColor;
        varying vec3 vPosition;
        void main() {
          // clamp(-y, 0, 1) is 0 for any upward/level direction (pure
          // atmosphereColor) and ramps 0->1 as the direction points further
          // below the surface, so one mix() covers both the flat-above and
          // gradient-below halves without a branch.
          float t = clamp(-normalize(vPosition).y, 0.0, 1.0);
          gl_FragColor = vec4(mix(atmosphereColor, depthsColor, t), 1.0);
        }
      `,
      side: THREE.BackSide,
      fog: false,
      depthWrite: false,
    }),
  );
  sky.renderOrder = -1;
  sky.frustumCulled = false;
  scene.add(sky);

  const camera = new THREE.PerspectiveCamera(FOV, 1, NEAR, 1000);

  const sun = new THREE.DirectionalLight(0xfff2d6, 2.2);
  sun.position.set(0.4, 1, 0.25);
  scene.add(sun);
  scene.add(new THREE.AmbientLight(0x8fb8c8, 0.55));
  const fill = new THREE.HemisphereLight(0x9fd8ff, 0x14201a, 0.65);
  scene.add(fill);

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

  // Resizes the renderer/camera to the new viewport. Deliberately does NOT
  // touch camera position/target — once OrbitControls is live, wherever the
  // user has dragged/zoomed the camera to is authoritative, and snapping it
  // back to the rest framing on every resize would fight their input. The
  // zoom-out clamp does scale with bounds, same as camera.far, so it stays
  // proportionally correct as the viewport changes size.
  function resize(b) {
    renderer.setSize(b.width, b.height);
    camera.aspect = b.width / b.height;
    camera.far = Math.max(b.width, b.height) * 5;
    camera.updateProjectionMatrix();
    sky.scale.setScalar(camera.far * SKY_RADIUS_FRAC);
    scene.fog.density = fogDensity(b);
    controls.maxDistance = Math.max(b.width, b.height) * MAX_ZOOM_DISTANCE_FRAC;
  }

  resize(bounds);
  controls.update();

  function updateCamera() {
    controls.update();
    sky.position.copy(camera.position);
  }

  // Blends the sky sphere, sun, and hemisphere fill light toward the given
  // day-of-year's seasonal look (see season.js) — the visible stand-in for
  // a year passing as the timeline advances. atmosphereColor/depthsColor
  // are mutated in place rather than reassigned, since the sky material's
  // uniforms already hold a reference to these exact Color objects.
  function setSeason(dayOfYear) {
    const season = seasonForDay(dayOfYear);
    atmosphereColor.copy(season.atmosphereColor);
    depthsColor.copy(season.depthsColor);
    sun.color.copy(season.sunColor);
    sun.intensity = season.sunIntensity;
    sun.position.copy(season.sunDirection);
    fill.color.copy(season.hemisphereSky);
  }

  return { renderer, scene, camera, controls, resize, updateCamera, setSeason };
}
