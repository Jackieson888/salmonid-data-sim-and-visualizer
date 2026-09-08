// Shared distance-fog source of truth (color, density, depth ramp, falloff) as GLSL every hand-written ShaderMaterial calls into.
import * as THREE from "three";
import { glslFloat as f } from "./glsl.js";
import { seasonForDay } from "./season.js";

// Shared mutated-in-place instance held by terrain.js, water.js, fishMesh.js, and sceneSetup.js's sky.
export const FOG_COLOR = new THREE.Color("#0d2f57");

// Tuned for a turbid, few-body-lengths-of-visibility river.
const FOG_DENSITY_FACTOR = 3.6;

export function fogDensity(bounds) {
  return FOG_DENSITY_FACTOR / Math.max(bounds.width, bounds.height);
}

// Grades FOG_COLOR by depth so the water column reads a vertical light gradient.
const DEEP_FOG_DARKEN = 0.42;

// Restates RIVER_DEPTH_FRAC from terrain.js to avoid a module-evaluation-order cycle.
const RIVERBED_DEPTH_FRAC = 0.34;
const FOG_DEPTH_FACTOR = Math.log(6);

export function fogDepthRate(bounds) {
  return FOG_DEPTH_FACTOR / (bounds.height * RIVERBED_DEPTH_FRAC);
}

export function setFogSeason(dayOfYear) {
  FOG_COLOR.copy(seasonForDay(dayOfYear).fogColor);
}

// Any material calling into this needs all three uniforms below.
export const FOG_GLSL = /* glsl */ `
  uniform vec3 uFogColor;
  uniform float uFogDensity;
  uniform float uFogDepthRate;

  // Fog color at one point in the water column; at/above the surface it's just FOG_COLOR.
  vec3 fogColorAt(vec3 worldPos) {
    float depth = max(-worldPos.y, 0.0);
    float t = 1.0 - exp(-depth * uFogDepthRate);
    return uFogColor * mix(1.0, ${f(DEEP_FOG_DARKEN)}, t);
  }

  // Falloff alone, without the color blend, for particles.js/godRays.js/fishMesh.js.
  float fogAmount(vec3 worldPos) {
    float dist = length(cameraPosition - worldPos);
    float fogFactor = 1.0 - exp(-uFogDensity * uFogDensity * dist * dist);
    return clamp(fogFactor, 0.0, 1.0);
  }

  vec3 applyFog(vec3 color, vec3 worldPos) {
    return mix(color, fogColorAt(worldPos), fogAmount(worldPos));
  }
`;
