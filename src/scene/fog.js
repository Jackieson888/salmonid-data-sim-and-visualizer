// fog.js
// Shared source of truth for the scene's distance fog: the color and
// density, plus an exponential-squared falloff implemented as GLSL.
//
// THREE's own scene.fog only reaches materials that pull in its fog shader
// chunks, and every material in this scene is a hand-written ShaderMaterial
// (terrain.js, water.js, fishMesh.js, and the sky in sceneSetup.js) — so each
// one includes FOG_GLSL and calls applyFog() itself. This is the whole fog
// implementation; there is no scene.fog to keep in step with it.
import * as THREE from "three";
import { seasonForDay } from "./season.js";

// Fog is what every distant surface in the scene saturates into, which
// makes it the single strongest color in frame — so it can't be a fixed
// constant while the sky moves through the year, or the whole river reads
// as hazing into a color the sky never contains. It's derived per season
// from the same sky/depths pair everything else is (see season.js).
//
// Deliberately ONE shared, mutated-in-place instance rather than a value
// copied out at build time: terrain.js, water.js, fishMesh.js and the sky
// (sceneSetup.js) all pass this exact object into their `uFogColor` uniform,
// so setFogSeason() updating it here reaches every shader in the scene with
// no per-material plumbing. Anything that needs its own copy must .clone()
// it — a consumer that copies the color at construction instead of holding
// the reference would silently stay stuck on the startup season.
export const FOG_COLOR = new THREE.Color("#0d2f57");

// Divided by the world's largest dimension so the falloff distance scales
// with world size instead of being tuned in raw world units (bounds track
// window size in this app — see main.js).
//
// Was 1.2, which left the far bank of the channel plainly legible. A
// shallow inland river carries enough suspended sediment that visibility
// underwater is only a few body lengths — fish a short distance off dissolve
// into the murk entirely, and there is no visible "far side" at all. 3.6
// puts the falloff roughly there: mostly saturated by a third of the way
// across the channel.
const FOG_DENSITY_FACTOR = 3.6;

export function fogDensity(bounds) {
  return FOG_DENSITY_FACTOR / Math.max(bounds.width, bounds.height);
}

// Called from main.js's applySeason() alongside every other setSeason() —
// see the note above on why mutating in place is the whole point here.
export function setFogSeason(dayOfYear) {
  FOG_COLOR.copy(seasonForDay(dayOfYear).fogColor);
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
