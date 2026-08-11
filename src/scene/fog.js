// fog.js
// Shared source of truth for the scene's distance fog: the color/density
// feeding THREE.FogExp2 on scene.fog (see sceneSetup.js), plus the same
// exponential-squared falloff reimplemented as GLSL. THREE only applies
// scene.fog automatically inside its own built-in materials — terrain.js,
// water.js, and fishMesh.js are all custom ShaderMaterials, so each one
// includes FOG_GLSL and calls applyFog() itself to actually show it.
import * as THREE from "three";

export const FOG_COLOR = new THREE.Color("#093b2f");

// Divided by the world's largest dimension so the falloff distance scales
// with world size instead of being tuned in raw world units (bounds track
// window size in this app — see main.js).
const FOG_DENSITY_FACTOR = 1.2;

export function fogDensity(bounds) {
  return FOG_DENSITY_FACTOR / Math.max(bounds.width, bounds.height);
}

export const FOG_GLSL = /* glsl */ `
  uniform vec3 uFogColor;
  uniform float uFogDensity;

  vec3 applyFog(vec3 color, vec3 worldPos) {
    float dist = length(cameraPosition - worldPos);
    float fogFactor = 1.0 - exp(-uFogDensity * uFogDensity * dist * dist);
    return mix(color, uFogColor, clamp(fogFactor, 0.0, 1.0));
  }
`;
