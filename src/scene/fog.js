// fog.js
// Design rationale, invariants, gotchas: .claude/context/scene/environment.md
// Shared source of truth for the scene's distance fog: color, density, the
// depth ramp, and the falloff, all as GLSL every hand-written ShaderMaterial
// includes and calls applyFog() from — there is no scene.fog in play here.
import * as THREE from "three";
import { glslFloat as f } from "./glsl.js";
import { seasonForDay } from "./season.js";

// One shared, mutated-in-place instance — terrain.js, water.js, fishMesh.js,
// and sceneSetup.js's sky all hold this exact reference in their uFogColor
// uniform. A consumer needing its own copy must .clone() it. See
// environment.md.
export const FOG_COLOR = new THREE.Color("#0d2f57");

// Divided by the world's largest dimension so the falloff scales with world
// size (bounds track window size — see main.js). Was 1.2; see environment.md
// for why 3.6 is tuned to a turbid, few-body-lengths-of-visibility river.
const FOG_DENSITY_FACTOR = 3.6;

export function fogDensity(bounds) {
  return FOG_DENSITY_FACTOR / Math.max(bounds.width, bounds.height);
}

// ---------------------------------------------------------------------
// The depth ramp — grades FOG_COLOR by depth (see fogColorAt in FOG_GLSL)
// instead of leaving it flat, which is what gives the water column a
// vertical light gradient to read depth against. See environment.md for why
// this is a value-only multiply rather than a second hand-picked color.
// ---------------------------------------------------------------------
const DEEP_FOG_DARKEN = 0.42;

// Measured in world Y, so it scales with water column depth rather than
// max(width, height). RIVERBED_DEPTH_FRAC restates RIVER_DEPTH_FRAC from
// terrain.js rather than importing it, to avoid a module-evaluation-order
// cycle (see environment.md). ln(6) puts the fog ~83% of the way to its
// deep color by the bed.
const RIVERBED_DEPTH_FRAC = 0.34;
const FOG_DEPTH_FACTOR = Math.log(6);

export function fogDepthRate(bounds) {
  return FOG_DEPTH_FACTOR / (bounds.height * RIVERBED_DEPTH_FRAC);
}

// Called from main.js's applySeason() alongside every other setSeason().
export function setFogSeason(dayOfYear) {
  FOG_COLOR.copy(seasonForDay(dayOfYear).fogColor);
}

// A material calling applyFog()/fogColorAt()/fogAmount() needs all three
// uniforms below; uFogDepthRate defaulting to 0 is a silent no-op, not a
// visible break — prefer copying an existing material's uniform block.
export const FOG_GLSL = /* glsl */ `
  uniform vec3 uFogColor;
  uniform float uFogDensity;
  uniform float uFogDepthRate;

  // The fog color at one point in the water column. Anything at or above
  // the surface gets FOG_COLOR itself.
  vec3 fogColorAt(vec3 worldPos) {
    float depth = max(-worldPos.y, 0.0);
    float t = 1.0 - exp(-depth * uFogDepthRate);
    return uFogColor * mix(1.0, ${f(DEEP_FOG_DARKEN)}, t);
  }

  // How completely the murk has taken over: 0 at the eye, 1 once distance
  // has erased everything. Split out of applyFog() since particles.js,
  // godRays.js, and fishMesh.js all want the falloff without the blend.
  float fogAmount(vec3 worldPos) {
    float dist = length(cameraPosition - worldPos);
    float fogFactor = 1.0 - exp(-uFogDensity * uFogDensity * dist * dist);
    return clamp(fogFactor, 0.0, 1.0);
  }

  vec3 applyFog(vec3 color, vec3 worldPos) {
    // Graded at the shaded point's own depth, not the camera's.
    return mix(color, fogColorAt(worldPos), fogAmount(worldPos));
  }
`;
