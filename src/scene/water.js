// water.js — surface plane, fragment-shaded from waterSim.js's live height field.
// Design rationale, invariants, gotchas: .claude/context/scene/water-and-caustics.md
//
// NOTE: vertex displacement from the sim's height field was attempted and
// reverted — see context doc. Don't retry without reading that first.

import * as THREE from "three";
import {
  causticGlowChunk,
  waterInfoChunk,
  CAUSTIC_SATURATE_GLSL,
  EDGE_FADE_GLSL,
  WATER_NORMAL_GLSL,
  glslFloat as f,
} from "./glsl.js";
import { FOG_GLSL, FOG_COLOR, fogDensity, fogDepthRate } from "./fog.js";
import { seasonForDay } from "./season.js";
import { QUALITY } from "../quality.js";

// Device-tier-scaled multiplier for how much bigger than the river bounds
// the water sim/plane covers (see context doc). A function, not a const:
// the tier can change mid-session (quality.js).
export const waterSizeMultiplier = () => QUALITY.waterSizeMultiplier;

// World-Y scale for the sim's raw (unitless) height — also imported by
// causticsGenerator.js's refraction ray-march for the same calibration.
export const WATER_HEIGHT_SCALE = 150;

// ---------------------------------------------------------------------
// Snell's window — see context doc for the optics and the critical-angle math.
// ---------------------------------------------------------------------
const COS_CRITICAL_MIN = 0.6;
const COS_CRITICAL_MAX = 0.73;

// How much sky the window shows, against the water body's own color. Not
// 1.0 — the sky sphere behind this plane already shows a fogged sky through
// the same window (see sceneSetup.js), so a fully sky-colored plane would
// double-count it.
const WINDOW_SKY_MIX = 0.8;

// Fraction of the surface glint the mirror (outside the window) still shows,
// read as the same light net glimpsed in reflection.
const MIRROR_GLINT = 0.5;

// {width, height} = the sim/plane's actual world coverage, oversized by
// waterSizeMultiplier(); {marginX, marginZ} = how far that coverage extends
// past bounds on each side (plane is centered on bounds, not corner anchored).
export function waterWorldSize(bounds) {
  const multiplier = waterSizeMultiplier();
  const width = bounds.width * multiplier;
  const height = bounds.height * multiplier;
  return {
    width,
    height,
    marginX: (width - bounds.width) / 2,
    marginZ: (height - bounds.height) / 2,
  };
}

// How far out the caustic net is worth computing, as a multiple of the fog's
// own saturation distance (see context doc for the derivation).
const CAUSTICS_FOG_REACH = 2.0;

// The caustics pass's own world coverage — deliberately NOT waterWorldSize().
// The two used to be the same function; they diverged because the water
// plane's extent (how far it dissolves into fog) and the caustics' legible
// reach are set by different things. See context doc — this is the frame's
// most expensive pass, so the split matters for cost, not just correctness.
//
// Centered on the eye->target midpoint for the same reason particles.js sizes
// its silt volume that way: a box centered on the eye alone would starve the
// far water actually in frame.
export function causticsWorldSize(bounds, cameraPosition, cameraTarget) {
  const span = Math.max(bounds.width, bounds.height);
  const reach = CAUSTICS_FOG_REACH / fogDensity(bounds);

  const centerX = (cameraPosition.x + cameraTarget.x) * 0.5;
  const centerZ = (cameraPosition.z + cameraTarget.z) * 0.5;

  // Never larger than the water coverage: past that edge the surface and bed
  // have already faded out, so there is nothing left to light.
  const water = waterWorldSize(bounds);
  const width = Math.min(reach * 2, water.width);
  const height = Math.min(reach * 2, water.height);

  return {
    width,
    height,
    marginX: width / 2 - centerX,
    marginZ: height / 2 - centerZ,
    centerX,
    centerZ,
    span,
  };
}

const VERTEX_SHADER = /* glsl */ `
  varying vec3 vWorldPos;
  void main() {
    vWorldPos = position;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

// A function, not a constant: the spliced-in chunks depend on the current
// quality tier (glsl.js), which can change mid-session.
const fragmentShader = () => /* glsl */ `
  ${causticGlowChunk({ taps: QUALITY.causticTaps })}
  ${waterInfoChunk()}
  ${CAUSTIC_SATURATE_GLSL}
  ${EDGE_FADE_GLSL}
  ${WATER_NORMAL_GLSL}
  ${FOG_GLSL}

  uniform sampler2D uWater;
  uniform sampler2D uCaustics;
  uniform vec2 uWorldSize;
  uniform vec2 uMargin;
  // Separate world->uv mapping: the caustics pass covers a shorter reach
  // than the water sim (see causticsWorldSize in this file).
  uniform vec2 uCausticsWorldSize;
  uniform vec2 uCausticsMargin;
  uniform vec2 uTexel;
  // Drives the procedural stand-in at the low tier (no sim to read there);
  // pushed unconditionally so the per-frame call has no branch.
  uniform float uTime;
  uniform vec3 uBaseColor;
  uniform vec3 uSkyColor;
  uniform vec3 uCausticsColor;
  uniform float uCausticsStrength;
  uniform vec2 uCenter;
  uniform vec2 uPlaneHalfSize;
  uniform float uCoreFrac;

  varying vec3 vWorldPos;

  void main() {
    // Sample the live height-field sim for this point's surface normal
    // (.ba channels — see waterSim.js). uWorldSize/uMargin match
    // waterWorldSize() below.
    vec2 uv = (vWorldPos.xz + uMargin) / uWorldSize;
    vec3 normal = waterSurfaceNormal(waterInfoAt(uWater, uv, vWorldPos.xz, uTime));

    // Snell's window: sky inside the cone, mirrored water column outside it.
    // abs() (not clamp) because the normal always points up and viewDir
    // always points down here — see context doc for the dead fresnel term
    // this replaced.
    vec3 viewDir = normalize(cameraPosition - vWorldPos);
    float cosView = abs(dot(normal, viewDir));
    float window = smoothstep(
      ${f(COS_CRITICAL_MIN)}, ${f(COS_CRITICAL_MAX)}, cosView
    );

    // What the mirror shows: the murk one fog length along the reflected
    // ray (same probe the sky sphere's background uses — sceneSetup.js).
    vec3 mirrorDir = reflect(-viewDir, normal);
    vec3 mirrored = fogColorAt(vWorldPos + mirrorDir / uFogDensity);

    vec3 color = mix(
      mirrored, mix(uBaseColor, uSkyColor, ${f(WINDOW_SKY_MIX)}), window
    );

    // Same causticGlow() read terrain.js uses, at this same point, so the
    // surface glints with the light pattern that actually lands underwater.
    vec2 causticsUv = (vWorldPos.xz + uCausticsMargin) / uCausticsWorldSize;
    float glint = softSaturate(
      causticGlowAt(uCaustics, causticsUv, uTexel, vWorldPos.xz, uTime)
        * uCausticsStrength
    );
    color +=
      uCausticsColor * glint * 0.35 * mix(${f(MIRROR_GLINT)}, 1.0, window);

    // Opaque out to uCoreFrac (real river bounds), dissolving beyond it —
    // the riverbed fades at the same edge (planeEdgeFade in glsl.js).
    float edgeFade =
      planeEdgeFade(vWorldPos.xz, uCenter, uPlaneHalfSize, uCoreFrac);

    color = applyFog(color, vWorldPos);

    // Semi-transparent, not opaque: fish and the caustics-lit riverbed below
    // the surface both need to show through.
    gl_FragColor = vec4(color, 0.8 * edgeFade);
  }
`;

export function buildWaterMesh(bounds, causticsTextureSize, causticsCoverage) {
  // Drawn waterSizeMultiplier() bigger than the river bounds, re-centered
  // so the extra size grows evenly past the edges.
  const {
    width: planeWidth,
    height: planeHeight,
    marginX,
    marginZ,
  } = waterWorldSize(bounds);
  const centerX = bounds.width / 2;
  const centerZ = bounds.height / 2;

  const geometry = new THREE.PlaneGeometry(planeWidth, planeHeight, 1, 1);
  geometry.rotateX(-Math.PI / 2);
  geometry.translate(centerX, 0, centerZ);

  const uniforms = {
    uWater: { value: null },
    uCaustics: { value: null },
    uTime: { value: 0 },
    uWorldSize: { value: new THREE.Vector2(planeWidth, planeHeight) },
    uMargin: { value: new THREE.Vector2(marginX, marginZ) },
    uCausticsWorldSize: {
      value: new THREE.Vector2(
        causticsCoverage.width,
        causticsCoverage.height,
      ),
    },
    uCausticsMargin: {
      value: new THREE.Vector2(
        causticsCoverage.marginX,
        causticsCoverage.marginZ,
      ),
    },
    uTexel: {
      value: new THREE.Vector2(1 / causticsTextureSize, 1 / causticsTextureSize),
    },
    // Overwritten by setSeason() to track season.waterColor; this starting
    // value (and the two below) only shows before the first setSeason() call.
    uBaseColor: { value: new THREE.Color("#09223f") },
    // Sky seen through Snell's window — tracks the sky sphere's skyColor.
    uSkyColor: { value: new THREE.Color("#1a56a8") },
    // Surface glint tint — tracks fishMesh.js's causticsColor1.
    uCausticsColor: { value: new THREE.Color(0.75, 0.92, 0.98) },
    uCausticsStrength: { value: 8 },
    uCenter: { value: new THREE.Vector2(centerX, centerZ) },
    uPlaneHalfSize: {
      value: new THREE.Vector2(planeWidth / 2, planeHeight / 2),
    },
    // Where the real river bounds end, as a t-value: 1/waterSizeMultiplier().
    uCoreFrac: { value: 1 / waterSizeMultiplier() },
    uFogColor: { value: FOG_COLOR },
    uFogDensity: { value: fogDensity(bounds) },
    // Y=0, so this is the top (undarkened) end of the depth ramp — passed so
    // fish/riverbed below grade consistently against it (see fog.js).
    uFogDepthRate: { value: fogDepthRate(bounds) },
  };

  const material = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: VERTEX_SHADER,
    fragmentShader: fragmentShader(),
    transparent: true,
    depthWrite: false,
    // Double-sided: culling would save nothing measurable on this two-triangle
    // quad, and it means a camera vantage change can't make the surface vanish.
    side: THREE.DoubleSide,
  });

  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = "water";

  // Per-frame setter: the water sim's ping-pong targets swap identity every
  // frame (see main.js's loop).
  function setWaterTexture(waterTexture) {
    uniforms.uWater.value = waterTexture;
  }

  // Bound once, not per frame: the caustics accumulation target is cleared
  // and re-rendered in place (causticsGenerator.js), so its identity never changes.
  function setCausticsTexture(causticsTexture) {
    uniforms.uCaustics.value = causticsTexture;
  }

  // Called whenever the displayed date changes, and again after any resize
  // rebuilds this mesh (a fresh buildWaterMesh() resets these to defaults).
  function setSeason(dayOfYear) {
    const season = seasonForDay(dayOfYear);
    uniforms.uBaseColor.value.copy(season.waterColor);
    uniforms.uSkyColor.value.copy(season.skyColor);
    uniforms.uCausticsColor.value.copy(season.causticsColor1);
  }

  // Drives the procedural stand-in at the low tier; same clock every other
  // animated thing reads, so the surface freezes on pause too.
  function setTime(seconds) {
    uniforms.uTime.value = seconds;
  }

  return { mesh, setWaterTexture, setCausticsTexture, setSeason, setTime };
}
