// fog.js
// Shared source of truth for the scene's distance fog: the color and
// density, the depth ramp that darkens that color down the water column,
// plus an exponential-squared falloff implemented as GLSL.
//
// THREE's own scene.fog only reaches materials that pull in its fog shader
// chunks, and every material in this scene is a hand-written ShaderMaterial
// (terrain.js, water.js, fishMesh.js, and the sky in sceneSetup.js) — so each
// one includes FOG_GLSL and calls applyFog() itself. This is the whole fog
// implementation; there is no scene.fog to keep in step with it.
import * as THREE from "three";
import { glslFloat as f } from "./glsl.js";
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

// ---------------------------------------------------------------------
// The depth ramp
// ---------------------------------------------------------------------
// FOG_COLOR alone is one flat color that every surface hazes into no matter
// where in the water column it sits — which is exactly what makes a river
// read as a shallow pane of water however dense the fog over it is. There is
// no vertical light gradient, so the eye has nothing to measure depth
// against: the bed under the camera saturates to the same tone as the
// surface above it.
//
// So the fog color is graded by depth instead (see fogColorAt in FOG_GLSL).
// Sunlight is absorbed on the way down, so the murk is brightest just under
// the surface and falls away toward the bed, and each surface dissolves into
// whichever shade belongs to its own depth.
//
// Value only, deliberately — a straight multiply on the season's own fog
// color rather than a second hand-picked color or a deeper stop on
// season.js's sky->depths ramp. That ramp is a poor lever here: RIVER_TINT
// dominates its deep end, so pushing FOG_DEPTH from 0.52 to 1.0 moves the
// result by about 3% lightness, nowhere near enough to read as depth. A
// multiply gets the full range while making it impossible for the deep end
// to drift out of the season's color family.
//
// 0.42 is a bit under half the light at the bed. Lower starts crushing the
// bottom of the frame toward black, which costs the riverbed and the deep
// fish their silhouettes — the point is a legible gradient, not a dark
// stripe.
const DEEP_FOG_DARKEN = 0.42;

// The ramp is measured in world Y, so it scales with the depth of the water
// column rather than with max(width, height) the way the distance falloff
// above does.
//
// RIVERBED_DEPTH_FRAC restates RIVER_DEPTH_FRAC from terrain.js rather than
// importing it: terrain.js pulls FOG_GLSL out of this module at module
// scope, and importing back would make the two files' evaluation order
// load-bearing (whichever ran second would hit the other's uninitialized
// const). One number in two places, against a cycle in the module graph.
//
// ln(6) puts the fog ~83% of the way to its deep color by the time it
// reaches the bed, so most of the ramp is spent inside the water column that
// actually exists instead of trailing off below it.
const RIVERBED_DEPTH_FRAC = 0.34;
const FOG_DEPTH_FACTOR = Math.log(6);

export function fogDepthRate(bounds) {
  return FOG_DEPTH_FACTOR / (bounds.height * RIVERBED_DEPTH_FRAC);
}

// Called from main.js's applySeason() alongside every other setSeason() —
// see the note above on why mutating in place is the whole point here.
export function setFogSeason(dayOfYear) {
  FOG_COLOR.copy(seasonForDay(dayOfYear).fogColor);
}

// Every material that calls applyFog(), fogColorAt() or fogAmount() needs
// all three of
// these uniforms; uFogDepthRate defaulting to 0 in a material that forgets
// it is a silent no-op (a flat fog color again), not a visible break, so
// prefer copying an existing material's block over adding them by hand.
// particles.js and godRays.js want only the falloff, not the blend, so
// they call fogAmount() and never touch uFogColor/uFogDepthRate; the
// compiler strips what they don't reach, and their unset uniforms with
// it.
export const FOG_GLSL = /* glsl */ `
  uniform vec3 uFogColor;
  uniform float uFogDensity;
  uniform float uFogDepthRate;

  // The fog color at one point in the water column — see the depth ramp
  // note in fog.js. Anything at or above the surface gets FOG_COLOR itself.
  vec3 fogColorAt(vec3 worldPos) {
    float depth = max(-worldPos.y, 0.0);
    float t = 1.0 - exp(-depth * uFogDepthRate);
    return uFogColor * mix(1.0, ${f(DEEP_FOG_DARKEN)}, t);
  }

  // How completely the murk has taken over at this point: 0 at the eye, 1
  // once distance has erased everything. Split out of applyFog() because
  // three shaders want the falloff without the blend — particles.js fades a
  // mote's alpha by it, godRays.js dims a shaft by it, and fishMesh.js
  // fades the rim light by it — and all three used to carry their own copy
  // of this expression with a comment saying it matched this one.
  float fogAmount(vec3 worldPos) {
    float dist = length(cameraPosition - worldPos);
    float fogFactor = 1.0 - exp(-uFogDensity * uFogDensity * dist * dist);
    return clamp(fogFactor, 0.0, 1.0);
  }

  vec3 applyFog(vec3 color, vec3 worldPos) {
    // Graded at the shaded point's own depth rather than at the camera's:
    // what the viewer is judging is how deep *that surface* is, and a fog
    // color that tracked the eye instead would slide the entire gradient up
    // and down with the framing.
    return mix(color, fogColorAt(worldPos), fogAmount(worldPos));
  }
`;
