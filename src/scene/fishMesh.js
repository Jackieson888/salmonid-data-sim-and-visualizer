// fishMesh.js
// Loads each species' GLB (a single skinned mesh + a spine-bone swim clip —
// see SPECIES_MODEL_URL below), bakes that clip into a Vertex Animation
// Texture (VAT) at load time, and renders the whole flock as one
// InstancedMesh per distinct model.
// Baking to a VAT is what makes a baked skeletal animation work across many
// instances in a single draw call: vanilla InstancedMesh can't skin each
// instance independently, but it can sample a per-vertex position from a
// texture in the vertex shader, which is exactly what real-time skinning
// would compute anyway, just precomputed for a fixed set of poses instead
// of re-evaluated per frame. Each instance still gets its own
// phase/cycle-position (aPhase/aCyclePos) so the flock's tail-beats don't
// lock-step.
//
// This is real per-instance cost (texture sampling, causticGlow reads,
// Blinn-Phong specular, fog blending — everything below) that a placeholder
// shape doesn't have, so main.js caps the total population (MAX_POPULATION,
// a single pooled figure across all species) to keep it affordable.
//
// bakeVertexAnimationTexture() below falls back to a single static frame
// whenever mesh.isSkinnedMesh is false (no JOINTS_0/WEIGHTS_0, mesh not
// parented to its armature — see git history for when an earlier steelhead
// export needed that fix) or no clip is found, so a future re-export that
// drops skinning silently degrades to a non-swimming fish instead of erroring.
//
// The clip is looked up by exact name "Swimming" first, falling back to
// gltf.animations[0]. All three GLBs shipping today name their clip exactly
// "Swimming" (verified against each file's animation JSON), so the name match
// is what actually fires; the index fallback is there for a re-export that
// picks up one of Blender's auto-suffixes (an earlier steelhead build arrived
// as "Swimming.005", from stray duplicate actions in the source file).
//
// Fish also read the same caustics texture the terrain/water do, sampled at
// each vertex's world XZ position, so a fish swimming through a bright patch
// of the water's light net visibly glints — the fish read as sitting *in*
// the water instead of pasted over it. They use causticGlowPoint (a single
// tap) rather than the 4-tap causticGlow those two use; see glsl.js for
// why the blur isn't worth its cost per vertex.
//
// Species models: SPECIES_MODEL_URL (below) maps each of the four DART
// species (see data.js — Chinook/Jack Chinook/Steelhead/Shad) to a GLB.
// Species that share a URL are drawn from one shared InstancedMesh and told
// apart only by a flat per-instance color multiply (aTint); a species with
// its own distinct URL gets its own InstancedMesh built from its own
// geometry/VAT/texture (see createFishInstancedMesh).
//
// Three of the four have their own mesh now: steelhead-final.glb,
// chinook-final.glb and shad-final.glb, each authored against the same
// vertex budget and the same procedural swim rig (scripts/swim_rig.py —
// 16 spine bones, one loop-closed "Swimming" cycle; see
// MODEL_ROTATION_FIX below for why that shared rig means they also share a
// rotation fix). jackChinook still has no model of its own and borrows
// chinook-final.glb — a jack chinook is the same species at a smaller,
// earlier-maturing size, not a different body shape, so that's the correct
// species to borrow rather than an eventual placeholder.

import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { causticGlowChunk, CAUSTIC_SATURATE_GLSL } from "./glsl.js";
import { QUALITY } from "../quality.js";
import { FOG_GLSL, FOG_COLOR, fogDensity, fogDepthRate } from "./fog.js";
import { riverDepth } from "./terrain.js";
import { seasonForDay, refractedSunDirection } from "./season.js";
import { BODY_VISUAL_SCALE } from "../boids.js";

// Scratch for setSunDirection below, so the per-frame sun push allocates
// nothing.
const _fishSun = new THREE.Vector3();

const STEELHEAD_FINAL_URL = "/steelhead-final.glb";
const CHINOOK_FINAL_URL = "/chinook-final.glb";
const SHAD_FINAL_URL = "/shad-final.glb";

const SPECIES_MODEL_URL = {
  steelhead: STEELHEAD_FINAL_URL,
  chinook: CHINOOK_FINAL_URL,
  jackChinook: CHINOOK_FINAL_URL,
  shad: SHAD_FINAL_URL,
};

// Per-model fixup rotation, folded into worldMatrix in loadSpeciesModel
// below, so every model's baked geometry ends up nose-along-+Z the way
// modelLength/noseOffsetLocal (createFishInstancedMesh) assume.
//
// A new model needs its own entry here, and working out which rotation is
// the right one is not just "which raw local axis does the body run along" —
// it depends on WHERE in the source file the rig put its compensating
// rotation, because only some of those places reach mesh.matrixWorld:
//
//   - A rotation on an ancestor "Armature" NODE is an ordinary
//     node-hierarchy transform, so mesh.matrixWorld already picks it up.
//     Earlier steelhead exports were this case, and needed only a plain
//     X-axis quarter turn on top.
//   - A rotation on the root BONE is part of the animated skin chain, not an
//     ancestor of the mesh node, so it cancels against that bone's own
//     inverse-bind matrix at rest and never reaches mesh.matrixWorld. The
//     baked mesh keeps its raw local axes (body along X, dorsal fin along Y)
//     and needs a Y-axis quarter turn: rotating about Y moves the long body
//     axis onto Z while leaving Y — already the correct up axis — untouched,
//     where an X-axis turn would instead swap the body's height into the
//     depth axis.
//
// steelhead-final.glb is the second case: its "Armature" node is identity and
// the -90°-about-Z compensation sits on the root bone ("Bone"). Its raw local
// axes are body-along-X (extent 4.76) / dorsal-along-Y (1.78) / lateral-
// along-Z (0.77), hence the Y-axis quarter turn. Direction matters as well as
// axis: rotating +90° about Y maps +X onto -Z, and this model's nose is at -X
// (verified from the rig — per-bone swing rises 3.9° at the -X end to 15.9°
// at the +X end, and the high-amplitude end of a swim cycle is the tail), so
// the nose lands on +Z exactly as noseOffsetLocal expects.
//
// chinook-final.glb and shad-final.glb are both the same case, not a fresh
// analysis each: they're built on the identical bone-name/parenting skeleton
// as steelhead's (same "Bone"-rooted 16-bone chain, same head-at-"Bone"
// direction, only the per-segment lengths and body proportions differ — see
// scripts/swim_rig.py, which is written to walk that shared chain rather than
// a hardcoded one) and both carry their own root-bone compensation, not an
// Armature-node one (verified directly against each GLB's node/animation
// JSON), with the same body-along-X/dorsal-along-Y/lateral-along-Z raw local
// axes. Same rig shape in, same fixup out.
const MODEL_ROTATION_FIX = {
  [STEELHEAD_FINAL_URL]: new THREE.Matrix4().makeRotationY(Math.PI * 0.5),
  [CHINOOK_FINAL_URL]: new THREE.Matrix4().makeRotationY(Math.PI * 0.5),
  [SHAD_FINAL_URL]: new THREE.Matrix4().makeRotationY(Math.PI * 0.5),
};

// Flat per-instance tint for each of the four DART species (see data.js),
// multiplied into the sampled body texture in the fragment shader below.
//
// jackChinook is the only one that still needs this: it borrows
// chinook-final.glb wholesale (see SPECIES_MODEL_URL) rather than having its
// own model, so a tint is the only thing separating it on screen from an
// adult chinook rendered from the same mesh and the same authored skin. The
// value below is pushed well past 1 for the same reason the old four-way
// version of this comment gave — multiplying all three channels by <1 just
// dims toward the same murk, and the water is green (see RIVER_TINT in
// season.js) and actively compresses hue differences with distance
// (DEPTH_FOG_FACTOR below) — so "clearly distinguishable" has to win out
// over "subtle" for a cast to survive at all. It still tracks jack chinook's
// real cast (greener, smaller) rather than an arbitrary color code.
//
// Steelhead, chinook and shad are all untinted: each now has its own
// authored skin (steelhead-final.glb, chinook-final.glb, shad-final.glb —
// see SPECIES_MODEL_URL), so its flank is already the right color and any
// multiply here can only push it away from what was painted. Give one of
// them a speciesTint() again only if it ever goes back to borrowing another
// species' model.
//
// How far from neutral the casts below are pushed. The hand-picked values are
// the *direction* of each species' color; this is the only magnitude knob.
//
// Raised from 1 (the casts used verbatim) because at that strength the four
// were only just separable in the near field and indistinguishable past a
// body length or two: the water is green (see RIVER_TINT in season.js) and
// every fish fades toward that same green with distance (DEPTH_FOG_FACTOR
// below), so both ends of the pipeline are actively compressing the hue
// differences this has to survive.
const TINT_STRENGTH = 2.1;

// Rec. 709 luminance weights, for the renormalization in speciesTint().
const LUMA_R = 0.2126;
const LUMA_G = 0.7152;
const LUMA_B = 0.0722;

// Pushes a cast away from neutral by TINT_STRENGTH, then renormalizes it to
// unit luminance so the four species differ in hue and not in brightness.
//
// That second step is the important one. Brightness already means something
// specific in this scene — near/far, via the depth dimming and the fog — so a
// tint that also carried brightness would make a distant chinook and a nearby
// shad ambiguous in exactly the way the tint exists to prevent. Scaling a cast
// like (1.15, 1.05, 0.8) without renormalizing brightens it as a side effect,
// and the brighter a species got the further away it would appear to be.
function speciesTint(r, g, b) {
  const tint = new THREE.Color(
    1 + (r - 1) * TINT_STRENGTH,
    1 + (g - 1) * TINT_STRENGTH,
    1 + (b - 1) * TINT_STRENGTH,
  );
  const luminance = LUMA_R * tint.r + LUMA_G * tint.g + LUMA_B * tint.b;
  return tint.multiplyScalar(1 / luminance);
}

// Identity multiply — leaves an authored texture exactly as painted.
const NO_TINT = new THREE.Color(1, 1, 1);

const SPECIES_COLORS = {
  steelhead: NO_TINT,
  chinook: NO_TINT,
  jackChinook: speciesTint(0.95, 1.1, 1.0),
  shad: NO_TINT,
};
const DEFAULT_COLOR = SPECIES_COLORS.steelhead;

// Per-model material overrides, layered onto the shared defaults in
// buildSpeciesRenderer's `uniforms` below. Keyed by GLB URL rather than by
// species because a renderer IS a model — jackChinook and chinook share one
// mesh, one texture and therefore one material (see SPECIES_MODEL_URL), and
// what differs between them is aTint, which is per instance.
//
// This table exists because the shared defaults were all tuned against
// steelhead and then inherited by two skins painted to a completely different
// key. The three authored textures are not variations on a theme:
//
//   steelhead  512px, mid-tone — olive speckled back, silver-pink lateral
//              band, white belly. The one species that genuinely has visible
//              iridophores, and the one the defaults already suit.
//   chinook    1024px, and very BRIGHT — a near-white silver flank over most
//              of the body. Every additive term here lands on top of that, so
//              it is the species that blows out first; it wants less of
//              everything, and it is a big-bodied fish with fine scales, so
//              it wants them denser too.
//   shad       1024px, and the artist already painted the iridescence — the
//              whole skin is blue-green scale rows with a gold sheen through
//              them. Adding much of our own on top is drawing the same effect
//              twice. Big, coarse, high-contrast diamond scales, so the
//              procedural bump wants to be sparser or it fights the painting.
//
// Anything not named here keeps the shared default.
const MATERIAL_OVERRIDES = {
  [CHINOOK_FINAL_URL]: {
    // Already near-white; a ceiling of 1.1 pushed the flank into the tone
    // mapper's shoulder and flattened the black spotting along with it.
    uDiffuseCeil: 0.98,
    uDiffuseFloor: 0.66,
    uSpecularStrength: 0.38,
    // A multiplicative caustic gain scales what is already there, so the
    // brightest skin of the three gains the most from the same net. Pulled
    // back to keep a chinook near the surface from being the one fish that
    // still blows out.
    uCausticsGain: 0.8,
    // Fine scales on the largest body in the run — more cycles, less depth.
    uScaleFrequency: 17,
    uBumpStrength: 0.16,
    uIridescenceStrength: 0.04,
  },
  [SHAD_FINAL_URL]: {
    uDiffuseCeil: 1.02,
    uSpecularStrength: 0.45,
    // Large diamond scales, painted with high contrast already.
    uScaleFrequency: 8,
    uBumpStrength: 0.18,
    // Halved, not zeroed: the painted sheen is fixed in the texture and so
    // cannot shift as the fish turns, which is the one thing a real
    // iridescent flank does. A little of ours on top puts the motion back.
    uIridescenceStrength: 0.03,
  },
};

// Poses sampled across one loop of the baked "Swimming" clip. 30 is plenty
// for a low-poly fish with linear interpolation between rows in the shader.
//
// A fixed number, not a per-tier one. It used to read QUALITY.vatFrames, which
// could not work: the bake happens exactly once, inside loadFishAssets()'s
// cachedLoad, so the value was read at first load and never again. A
// high->low downgrade from the frame-time governor rebuilds the renderers but
// reuses the baked asset, so it never halved anything — the knob could only
// ever fire on a forced `?quality=low` boot, which is a debugging path.
//
// Deleted rather than fixed. Re-baking three VATs mid-session to reclaim a few
// hundred KB is not a trade worth making on a device already dropping frames,
// and the fish are documented throughout this file as not being the
// bottleneck. The tier has better levers (see quality.js).
const VAT_FRAME_COUNT = 30;

// How far a fish travels per complete tailbeat, in body lengths — the
// "stride length" of carangiform swimming, which for a salmonid at steady
// cruise is roughly 0.6-0.8 body lengths per beat.
//
// This is what ties the animation to the locomotion, and it replaces a
// hardcoded per-species Hz table. Tailbeat rate is not a free visual
// parameter: a fish that beats its tail twice while sliding forward one body
// length reads as swimming in treacle no matter how good the clip is,
// because the eye reads thrust per stroke directly. Deriving the rate from
// how fast the fish is actually moving keeps the two locked no matter what
// changes underneath — BASE_MAX_SPEED, a day's speed multiplier (see
// speedMultiplierForRate in main.js), or a fish working out of a crowd.
//
// Species differentiation falls out of this for free rather than needing its
// own table: every fish shares one maxSpeed, so a ~89-world-unit chinook
// covers far fewer body lengths per second than a ~38-unit shad and beats
// correspondingly slower. That spread (~2.3x) is wider than real biology's
// (~1.5x, since real chinook also swim faster in absolute terms than shad
// do), but the sim gives every species the same speed, and matching the
// motion on screen matters more here than matching a scaling law the sim
// doesn't model anyway.
const STRIDE_LENGTH = 0.7;

// Peak body roll (banking around the fish's own forward axis), reached at
// full tailbeat effort and scaled down toward zero as the tail idles — see
// rollActivity in update(). Real subcarangiform swimmers bank opposite their
// tail's lateral thrust; this is most of what reads as "alive" beyond the
// tail sweep itself, and it's nearly free since update() already builds a
// quaternion per fish per frame. 8 degrees sits comfortably inside the
// pitch clamp's range (+/-0.2rad, ~11.5deg) so roll never dominates the pose.
const ROLL_AMPLITUDE = THREE.MathUtils.degToRad(8);

// Bounds on the derived rate, in cycles per sim step. The sim enforces a
// minimum cruising speed (see boids.js) so the lower bound is mostly a
// safety net against a fish freezing into a rigid plank; the upper stops a
// brief speed spike from blurring the tail into a hum. At 60fps these are
// roughly 0.25Hz and 3.6Hz.
const MIN_BEATS_PER_STEP = 0.004;
const MAX_BEATS_PER_STEP = 0.06;

// Per-sim-step blend factor for a fish's body pitch easing toward the pitch
// its current depth drift implies (see the pitch block in update()).
//
// ~0.06 is a time constant of roughly 17 steps, a bit over a quarter second at
// 60fps. The value is bounded on both sides by what it has to hide: fast
// enough that a fish is visibly nosing into a new drift well within the
// 90-240 steps that drift lasts (see depthCooldown in boids.js), slow enough
// that the instantaneous retarget driving it never shows through as a flick.
const PITCH_SMOOTHING = 0.06;

// Tailbeat rate while playback is paused, as a fraction of the derived rate.
//
// Not zero: a school frozen mid-stroke reads as a bug, and fish holding
// station with their tails still working reads as alive. But it has to be
// *much* slower than cruising, and the useful range turned out to be far
// lower than it looks — a fish beating at anything near full rate while
// covering no ground is exactly what reads as broken. A quarter still looked
// like a glitch; a tenth read as slow motion; a twentieth reads as barely
// moving at all, which is the intent.
//
// Applied only to the beat — everything else about a paused fish (position,
// heading, bob) is frozen, because it is driven off the simulation clock in
// main.js, which stops.
const PAUSED_SWIM_RATE = 0.05;

// Accumulated per-fish frame-over-frame in update() below (f.swimCyclePos)
// rather than recomputed from absolute time each frame — recomputing as
// `uTime * rate` would make the sampled VAT frame jump on every call that
// changed uTime's scale.
//
// Accumulated per sim *step*, not per real second, because the sim measures
// itself in steps: main.js's loop calls flock.step(dt) with dt in 60fps-frame
// units, so a fish covers a fixed distance per STEP rather than per second.
// Advancing the tailbeat on that same clock is what keeps stride length honest
// at any refresh rate — on a 120Hz display each frame is half a step, so fish
// move half as far and beat half as often per frame, holding the same distance
// per stroke.
//
// That only works if update() is handed the same dt flock.step() got. It was
// not, for a while: dt reached the flock but the renderer advanced the beat by
// a fixed amount per frame regardless, so stride length came out wrong on any
// display that wasn't 60Hz and, worse, frame-time jitter desynced the tail
// from the motion frame to frame. See the `advance` line in update().
//
// Two per-fish offsets keep the school from locking together: aPhase (a
// fixed radian offset, see boids.js wobblePhase) and swimRate (a +/-12% rate
// multiplier, see boids.js). The latter matters more — a school where every
// fish beats at exactly the same frequency reads as cloned however well the
// phases are spread, since the relative pattern never changes.
const PHASE_TO_CYCLE = 1 / (2 * Math.PI);

// How much a fish dims the deeper below the water surface (world Y = 0) it
// swims, simulating sunlight attenuating with depth. ln(4) means a fish at
// exactly riverDepth(bounds) — the riverbed — sits at 1/4 brightness before
// the MIN_DEPTH_DIM floor below; fish are never scaled darker than that
// floor even past the riverbed, so they stay readable at the very bottom.
const DEPTH_DARKEN_FACTOR = Math.log(4);
const MIN_DEPTH_DIM = 0.15;

function depthDarkenRate(bounds) {
  return DEPTH_DARKEN_FACTOR / riverDepth(bounds);
}

// Separate, more aggressive falloff that blends a fish toward uFogColor
// (the same backdrop color distant objects fade into via applyFog — see
// fog.js) as it swims deeper, on top of the light-attenuation dimming
// above. A fish right at the surface is unaffected (factor ~0); one down
// at riverDepth(bounds) is ~95% blended into the fog color, camouflaging
// it into the murk rather than just going dark — this is what actually
// reads as "blending into the depths" instead of "getting dimmer."
const DEPTH_FOG_FACTOR = Math.log(20);

function depthFogRate(bounds) {
  return DEPTH_FOG_FACTOR / riverDepth(bounds);
}

// Distance culling, expressed in units of the fog's own falloff rather than
// world units, so it tracks whatever fogDensity() is tuned to.
//
// applyFog (see fog.js) blends toward the fog color by
// 1 - exp(-(density * dist)^2), so `density * dist` is the only number that
// matters. At 2.2 a fish is 99.2% fog color; at 2.6, 99.9%. Past that it is
// costing 435 vertices of VAT sampling and caustics work to contribute
// well under one percent of one pixel's color.
//
// So fish fade out across that band and are then skipped entirely. The fade
// reuses the same aOpacity path the spawn/despawn fades use, which is what
// makes this invisible rather than a pop: by the time a fish is dropped it
// has already been faded to nothing *and* was 99.9% fog color anyway.
//
// Measured at a full 1200-fish day, this drops 18-20% of the flock across
// viewports from 1280x800 to 2560x1080 — a fifth of the scene's dominant
// vertex cost, for pixels that were already indistinguishable from fog.
//
// The thresholds are deliberately conservative. Pulling them inward would cull
// more, but 2.2 is the last point where the fish being faded is still provably
// below one percent of its own color; past that the saving starts being paid
// for in things you could actually see.
const CULL_FADE_START_FOG = 2.2;
const CULL_FADE_END_FOG = 2.6;


// How much more aggressively fish fade into the fog color with camera
// distance than every other surface does. Applied as a straight multiplier on
// top of fogDensity(bounds) when it's pushed into this renderer's own
// uFogDensity uniform (see setBounds below) — terrain.js/water.js keep
// reading the unboosted rate, so only the fish get the steeper falloff.
//
// This exists on top of applyFog()'s existing camera-distance blend (see
// fog.js) rather than replacing it: that blend is shared scene-wide fog and
// has to stay consistent across every surface, but fish are the one thing in
// the shot that moves through the whole depth of the river, so they're also
// the one thing that can sell "this school recedes into the murk" on its own.
// A boosted rate also pulls the distance-cull band (below) in to match, so
// fish that are already fog-camouflaged by this steeper curve are dropped
// from the draw sooner too, rather than lagging behind on the shared rate.
//
// Was 1.35, which turned out too strong once stacked on top of WORLD_SCALE
// (main.js): fogDensity(bounds) already climbs ~1/WORLD_SCALE as the world
// shrinks (deliberately — see fog.js — so the murk still closes in at the
// same FRACTION of the smaller river), so 1.35 on top of that squeezed the
// cull band's absolute width (CULL_FADE_END_FOG - CULL_FADE_START_FOG,
// divided by this density) down to well under half its pre-shrink size.
// Flocking's normal frame-to-frame jitter was enough to carry a fish back
// and forth across a band that narrow, which read as fish popping in and out
// of view near the fade boundary rather than as a jitter-free fade. 1.1
// still fades fish somewhat faster than terrain/water, just not into a band
// thin enough for ordinary steering noise to straddle.
const FISH_FOG_DISTANCE_BOOST = 1.1;

// Multiplies the raw caustic glow (see vCausticGlow/glowSaturated in
// FRAGMENT_SHADER) before it's added on top of the fish's own body texture.
//
// Was 18. softSaturate's ceiling is 1.4 (see CAUSTIC_SATURATE_GLSL in
// glsl.js), and the real accumulation pass's raw signal sits "mostly in the
// low tenths" per its own docs — so at 18, a glow of just 0.15 already
// saturates to ~0.92 of that ceiling, and anything brighter is pinned at
// effectively the max. A fish riding through a bright patch near the surface
// (vDepthDim close to 1, where this term is least attenuated) got that
// near-ceiling glow ADDED on top of its base color, not blended with it —
// which is fine on the old flat placeholder skin with nothing to lose, but on
// the authored steelhead/chinook/shad textures it was bright enough to wash
// the skin's own color and pattern out entirely, leaving a pale, low-detail
// silhouette that read as merging into the equally bright caustic net on the
// water surface right above it rather than as a lit fish in front of it.
// 11 still reads as a real glint — brighter than the water surface's own 8,
// since caustics genuinely do land more directly on a fish's back than on the
// rippled surface — without saturating from a routine glow value alone.
const FISH_CAUSTICS_STRENGTH = 11;

// Where the fish sit in the scene's explicit draw order (see main.js's
// createWorld, which sets the rest: terrain 0, water 1, particles/godRays 3).
//
// One fixed value for all species, not a per-species band. It used to be a
// band, spread across a rank recomputed every frame from each species' mean
// camera distance, because draw order was the only thing deciding which
// species occluded which. The fish are opaque and depth-tested now, so the
// depth buffer settles that per pixel and every fish mesh can share one value.
const FISH_RENDER_ORDER_BASE = 2;

// A function for the same reason water.js's fragment shader is — see there.
const vertexShader = () => /* glsl */ `
  ${causticGlowChunk()}

  attribute float aVertexIndex;
  attribute float aPhase;
  attribute float aCyclePos;
  attribute float aOpacity;
  attribute float aAmplitude;
  attribute vec3 aTint;

  uniform sampler2D uVat;
  uniform float uVatFrameCount;
  uniform float uVatVertexCount;
  uniform sampler2D uCaustics;
  uniform vec2 uWorldSize;
  uniform vec2 uMargin;
  uniform float uDepthDarkenRate;
  uniform float uDepthFogRate;
  // Drives the procedural caustics at the low tier, where no accumulation
  // target exists to sample (see quality.js). Pushed from update()'s clock.
  uniform float uTime;

  varying vec2 vUv;
  varying vec3 vWorldNormal;
  varying float vCausticGlow;
  varying float vOpacity;
  varying vec3 vTint;
  varying vec3 vWorldPos;
  varying vec3 vLocalPos;
  varying float vDepthDim;
  varying float vDepthFog;

  // uVat: one column per model vertex, one row per baked pose (see
  // bakeVertexAnimationTexture in fishMesh.js). NearestFilter on both axes —
  // linear filtering along the vertex axis would blend unrelated vertices
  // together, so frame-to-frame smoothing is done by hand below instead.
  //
  // Stores each pose as an OFFSET from the rest pose, not an absolute
  // position, so the rest pose can be added back below at a per-instance
  // scale (aAmplitude).
  vec3 sampleVatOffset(float frame) {
    vec2 uv = vec2(
      (aVertexIndex + 0.5) / uVatVertexCount,
      (mod(frame, uVatFrameCount) + 0.5) / uVatFrameCount
    );
    return texture2D(uVat, uv).xyz;
  }

  void main() {
    vUv = uv;
    vOpacity = aOpacity;
    vTint = aTint;

    float cycles = aCyclePos + aPhase * ${PHASE_TO_CYCLE};
    float frameF = fract(cycles) * uVatFrameCount;
    float frame0 = floor(frameF);
    vec3 swim = mix(
      sampleVatOffset(frame0),
      sampleVatOffset(frame0 + 1.0),
      frameF - frame0
    );

    // The rest pose (three's built-in "position" attribute) was previously
    // uploaded per vertex and never read, since the VAT held absolute
    // positions. Baking offsets
    // instead puts it to work and makes per-instance stroke strength free:
    // aAmplitude 1.0 reproduces the authored clip exactly, 0.0 is a
    // straight, motionless fish, and values between let a school vary how
    // hard each fish is working without a second baked clip.
    vec3 bent = position + swim * aAmplitude;
    // Pre-instance-transform surface position, for the specular bump wobble
    // in FRAGMENT_SHADER — glued to the fish's own body rather than sliding
    // in world space as it swims/turns.
    vLocalPos = bent;

    vec4 worldPos = instanceMatrix * vec4(bent, 1.0);
    vWorldPos = worldPos.xyz;
    // Every triangle now carries a genuine outward normal, including the fin
    // sheets, which get a mirrored back face baked in at load time (see
    // doubleOpenSheets in fishMesh.js). The material is single-sided, so there
    // is no back face left to reconstruct a normal for in the fragment shader.
    vWorldNormal = normalize((instanceMatrix * vec4(normal, 0.0)).xyz);

    // Darker the deeper below the surface (world Y = 0) this vertex sits —
    // see DEPTH_DARKEN_FACTOR/MIN_DEPTH_DIM above.
    float depthBelowSurface = max(0.0, -worldPos.y);
    vDepthDim = max(${MIN_DEPTH_DIM}, exp(-depthBelowSurface * uDepthDarkenRate));

    // See DEPTH_FOG_FACTOR above — how much this vertex should blend into
    // uFogColor (applied in the fragment shader) on top of the dimming
    // above.
    vDepthFog = 1.0 - exp(-depthBelowSurface * uDepthFogRate);

    // The same caustics texture terrain.js/water.js read, sampled at this
    // vertex's world position — but through causticGlowPoint (a single tap)
    // rather than the 4-tap blur those two use, since this runs per vertex
    // and gets interpolated across the triangle anyway; see glsl.js
    // for why that trade is worth 4 vertex texture fetches. uWorldSize/
    // uMargin are the caustics pass's own coverage (see causticsWorldSize in
    // water.js) — a shorter reach than the water sim's, since what this reads
    // is the accumulation texture and not the height field. Left
    // un-dimmed here — depth attenuation is applied in the fragment shader
    // *after* the intensity curve (see FRAGMENT_SHADER) so it stays visible
    // instead of getting swallowed by saturation at high uCausticsStrength.
    vec2 causticsUv = (worldPos.xz + uMargin) / uWorldSize;
    vCausticGlow = causticGlowAt(uCaustics, causticsUv, vec2(0.0), worldPos.xz, uTime);

    vec4 mvPosition = modelViewMatrix * worldPos;
    gl_Position = projectionMatrix * mvPosition;
  }
`;

const FRAGMENT_SHADER = /* glsl */ `
  ${CAUSTIC_SATURATE_GLSL}
  ${FOG_GLSL}

  uniform sampler2D uBodyMap;
  uniform vec3 uLightDir;
  uniform vec3 uCausticsColor1;
  uniform vec3 uCausticsColor2;
  uniform float uCausticsStrength;
  uniform float uCausticsGain;
  uniform float uCausticsAdd;
  uniform float uShininess;
  uniform float uSpecularStrength;
  uniform float uSpecularFresnel;
  uniform float uCausticFacing;
  uniform float uSpecularTint;
  uniform float uRimStrength;
  uniform float uRimExponent;
  uniform float uBumpStrength;
  uniform float uScaleFrequency;
  uniform float uDiffuseFloor;
  uniform float uDiffuseCeil;
  uniform vec3 uSheenWarm;
  uniform vec3 uSheenCool;
  uniform float uIridescenceStrength;

  varying vec2 vUv;
  varying vec3 vWorldNormal;
  varying float vCausticGlow;
  varying float vOpacity;
  varying vec3 vTint;
  varying vec3 vWorldPos;
  varying vec3 vLocalPos;
  varying float vDepthDim;
  varying float vDepthFog;

  // Wobbles N by a small amount that's a smooth function of the fish's own
  // local-space surface position (vLocalPos — glued to the body rather than
  // sliding in world space as the fish swims/turns), so the specular lobe
  // below can catch a bit of texture instead of one soft blob.
  //
  // An earlier version built a per-fragment tangent frame from screen-space
  // derivatives (dFdx/dFdy) of world position and UV (the standard
  // cotangent-frame trick). That's fine on a dense, continuously-shaded
  // mesh, but on this one — a few hundred tris, a UV layout with seams,
  // mirrored fin-sheet back faces (see doubleOpenSheets) — the
  // derivative ratio goes unstable at triangle boundaries and UV seams, so
  // the tangent direction occasionally comes out wrong rather than just
  // noisy. pow(specAngle, uShininess) below turns "occasionally wrong" into
  // hard bright streaks. This version has no derivative and no per-triangle
  // discontinuity to trip on: sin/cos of a smooth linear function of
  // position is continuous everywhere, and orthogonalizing against N (rather
  // than building a tangent basis to perturb within) means there's no basis
  // construction to go wrong either.
  vec3 perturbNormal(vec3 N, vec3 localPos, float strength) {
    vec2 p = localPos.xz * uScaleFrequency;
    float y = localPos.y * uScaleFrequency;
    vec3 wobble = vec3(
      sin(p.x * 1.0 + p.y * 0.6 + y * 0.4),
      cos(p.x * -0.7 + p.y * 1.8 - y * 0.3 + 1.7) * 0.7,
      sin(p.x * 0.5 - p.y * 1.1 + y * 0.5 + 0.9) * 0.6
    );
    wobble -= N * dot(wobble, N);
    return normalize(N + wobble * strength * 0.3);
  }

  void main() {
    // Species tint (see SPECIES_COLORS in fishMesh.js) multiplies the
    // sampled body texture, so a species recolors while keeping the
    // texture's own shading/scale detail instead of flattening to a flat
    // color.
    //
    // There used to be a three-way branch here on a per-vertex material id
    // (body/eye/mouth), left over from the old multi-group OBJ. Every model
    // since has been single-material, so the attribute was a buffer of zeros
    // and only this first arm could ever run — see git history if a future
    // export brings material groups back.
    vec3 base = texture2D(uBodyMap, vUv).rgb * vTint;

    // No front/back branch: the material is single-sided now, and the fin
    // sheets carry a real mirrored back face baked in at load time (see
    // doubleOpenSheets in fishMesh.js), so every fragment already has a
    // genuine outward normal.
    vec3 normal = normalize(vWorldNormal);
    vec3 lightDir = normalize(uLightDir);

    // Wrapped ("half-Lambert") diffuse, shaped by a smoothstep so the
    // terminator has a soft S-curve rather than a linear ramp's flat, plastic
    // falloff. Narrow range, and that is the point.
    //
    // This used to quantize — floor(ndl * 4.0) / 4.0 into mix(0.55, 1.2, band)
    // — which was tuned against a flat placeholder skin that had no shading of
    // its own to lose. The three GLBs now carry hand-painted skins that already
    // include their countershading: a dark olive back grading through a silver
    // flank to a white belly, which is the fish's own lighting baked in by the
    // artist. Multiplying a 2.2x range in four hard steps on top of that
    // buried it — whole triangles flipped between steps as a fish turned or as
    // the sun swept, so the painted grade read as faceting instead.
    //
    // What is left here is deliberately gentle: enough to say which side of
    // the body the sun is on and to let that travel as the sun crosses the sky
    // (see sweptSunDirection in season.js), not enough to re-light it. The
    // texture is the shading; this is the reminder that there is a light.
    float ndl = dot(normal, lightDir) * 0.5 + 0.5;
    float lit = mix(uDiffuseFloor, uDiffuseCeil, ndl * ndl * (3.0 - 2.0 * ndl));

    // Blinn-Phong specular glint — wet scales reflect the sun as a tight,
    // bright highlight rather than just scattering it like the banded lit
    // term above, which is what was reading as flat/matte. Keyed off the
    // half-vector (not just the normal) so it slides across the fish as the
    // camera orbits, the way a real specular highlight moves on curved,
    // glossy skin instead of staying locked to a fixed lit side.
    // Both the specular below and the rim further down are compiled out at
    // the low tier (see quality.js). Between them they are two pow() calls
    // per fragment across every fish on screen, and they are view-dependent
    // detail — a tight glint sliding over the scales, a hairline outline at
    // the silhouette — that is legible on a large display and essentially
    // invisible on a phone. The banded diffuse term and the caustic glow,
    // which carry the actual shape and the sense of being lit from the
    // surface, both stay.
    vec3 specular = vec3(0.0);
    vec3 sheen = vec3(0.0);
    #ifdef FISH_HIGHLIGHTS
      vec3 viewDir = normalize(cameraPosition - vWorldPos);

      // Shading LOD: 0 at the eye, 1 once fogAmount() (see fog.js) has fully
      // taken over. The bump normal and the iridescence tint below are
      // exactly the small-scale detail fogAmount()'s own doc comment
      // describes as legible up close and invisible at distance, so both
      // fade out by this same factor rather than paying full cost across a
      // population of hundreds regardless of how much of it is on screen at
      // any real size. Reused again below for the rim's own distance fade,
      // in place of that block's own fogAmount() call.
      float detail = 1.0 - fogAmount(vWorldPos);

      // Bump-perturbed normal, used only here — the banded diffuse (lit,
      // above) and the rim (below) stay on the smooth per-vertex normal on
      // purpose. See perturbNormal's own comment for why. Skipped entirely
      // past the point where detail has nothing left to perturb.
      vec3 bumpedNormal = normal;
      if (detail > 0.02) {
        bumpedNormal = perturbNormal(normal, vLocalPos, uBumpStrength * detail);
      }
      vec3 halfDir = normalize(lightDir + viewDir);
      float specAngle = max(dot(bumpedNormal, halfDir), 0.0);

      // Schlick Fresnel on the specular STRENGTH (not the lobe width). A wet
      // fish is a dielectric under a film of water: reflectance is low
      // looking square at the flank and climbs steeply toward grazing
      // angles, which is why a salmon flashes when it turns instead of
      // sitting evenly glossy. Buying the same brightness by raising
      // uShininess would tighten the lobe into a pinprick that strobes
      // across this mesh's large flat triangles (654 of them — see the note
      // on uShininess in the uniforms). Scaling by view angle leaves the
      // lobe alone and puts the extra light where a real wet surface puts
      // it: on the parts turning away from the eye.
      // Schlick's ^5 by multiplies rather than pow(). Not just cheaper: it
      // also hands the sheen below its own ^2 term for free, and the two want
      // genuinely different widths (see there).
      float viewFacing = 1.0 - max(dot(normal, viewDir), 0.0);
      float viewFacing2 = viewFacing * viewFacing;
      float fresnel = viewFacing2 * viewFacing2 * viewFacing;

      // Tinted with the light that actually reaches the fish. A specular
      // highlight is a mirror image of its illuminant, and down here the
      // illuminant is not white — it is sunlight that has already been
      // filtered through the water column, which is the same tone the caustic
      // net and the rim are drawn in (uCausticsColor1). An untinted white
      // glint on a green-lit body was the single most synthetic-looking thing
      // left on these fish. Not tinted all the way: the core of a real
      // sun glint is bright enough to read as white regardless, so
      // uSpecularTint stops partway.
      vec3 specTint = mix(vec3(1.0), uCausticsColor1, uSpecularTint);
      specular = specTint * pow(specAngle, uShininess) * uSpecularStrength
        * (1.0 + fresnel * uSpecularFresnel);

      // Iridescent sheen — the guanine platelets in a salmonid's skin, which
      // throw a structural, angle-dependent colour on top of the pigment.
      //
      // Two things about this were wrong before. It was mix()ed INTO base,
      // which is a pigment operator: up to 25% of the painted skin was
      // literally replaced by a flat light blue everywhere the body turned
      // away from the eye, so all three species picked up the same blue
      // outline and the artwork underneath was thrown away to get it. And it
      // rode the specular's ^5 Fresnel, which is ~0 except within a few
      // degrees of grazing, so what little it did was crammed into the
      // silhouette instead of playing across the flank the way real
      // iridescence does.
      //
      // Now it is ADDED as light, on the broader ^2 term, and its hue shifts
      // with angle — warm/gold where the flank faces the eye, cool where it
      // turns away. That angle-dependent shift is the whole perceptual signal
      // of iridescence; a fixed colour, however carefully picked, is just a
      // rim light wearing its name. Dimmed with depth like every other lit
      // term here, and faded by detail for the same reason the bump normal is.
      vec3 sheenHue = mix(uSheenWarm, uSheenCool, viewFacing);
      sheen = sheenHue * viewFacing2 * uIridescenceStrength * detail;
    #endif

    // Fake the same light net the riverbed/surface show, glinting across
    // the fish as they pass through a bright patch — a highlight added on
    // top rather than a full relight, so it doesn't fight the body texture.
    // Through the same softSaturate() curve terrain.js and water.js use (see
    // glsl.js), which is what keeps the sim's frame-to-frame curvature
    // spikes from popping.
    float glowSaturated = softSaturate(vCausticGlow * uCausticsStrength);

    // vDepthDim applied AFTER saturation, not folded into vCausticGlow —
    // multiplying it in beforehand let a high uCausticsStrength push even
    // the dimmed deep-water signal into the saturated region, where the
    // curve's output barely moves regardless of the input's scale. Scaling
    // the already-saturated result instead keeps the surface->depth falloff
    // proportional (and visible) no matter how intense the raw glow is.
    // Caustics arrive from above, so they light a fish's back and not its
    // belly. This was the one term missing that gate: vCausticGlow is sampled
    // purely from world XZ (see the vertex shader), with no normal in it at
    // all, so before this an upturned belly caught exactly the same light net
    // as the dorsal surface did.
    //
    // The specular and the rim never needed this. Both are half-vector /
    // light-direction terms, so with uLightDir above the fish they already
    // fall to zero on downward-facing normals on their own — measured at
    // 0.00000 on the belly from every camera elevation. Only this one is
    // positional.
    //
    // Gated on world up rather than on uLightDir, because refraction confines
    // sunlight underwater to Snell's window: whatever elevation the sun sits
    // at, once through the surface it travels within ~48.6 degrees of
    // straight down. A low winter sun still throws its net downward, so "up"
    // is the more honest axis here than "toward the sun".
    //
    // Wrapped (*0.5 + 0.5) rather than clamped so the flanks keep half the
    // glow and only the belly goes dark, and floored by uCausticFacing < 1
    // because water scatters: a real fish's underside does pick up light
    // bounced off the bed, it just isn't lit by the net directly.
    float causticFacing = mix(1.0, normal.y * 0.5 + 0.5, uCausticFacing);
    float glow = glowSaturated * vDepthDim * causticFacing;

    // Two-tone caustics: uCausticsColor1 (the lighter tone) only takes over
    // where the glow is genuinely intense AND the fish is near the surface —
    // multiplying the two signals means either one fading (a dim glimmer, or
    // the same glimmer deeper down) pulls the tone back toward
    // uCausticsColor2, matching how real underwater light both dims and
    // loses its sharp, bright color with depth.
    float glowNorm = clamp(glowSaturated / CAUSTIC_GLOW_CEILING, 0.0, 1.0);
    float tone = clamp(glowNorm * vDepthDim, 0.0, 1.0);
    vec3 causticsColor = mix(uCausticsColor2, uCausticsColor1, tone);

    // Rim light. At the silhouette the body turns away from the eye, and
    // the light coming down from the surface wraps around it there — the
    // bright outline that separates a fish from the murk in underwater
    // footage, and the term that keeps a fish readable at the depths where
    // the water column has gone dark (see the depth ramp in fog.js).
    vec3 rimLight = vec3(0.0);
    #ifdef FISH_HIGHLIGHTS
      float rim = pow(viewFacing, uRimExponent);

      // Only on the sun's side. A rim is light wrapping around the body, so
      // it belongs on the edges the sun can actually reach — dorsal ones
      // under a high summer sun, flank ones under a low winter one, and it
      // travels around the fish as the sun crosses the sky (see
      // sweptSunDirection in season.js). Ungated, every fish gets the same
      // even outline, which reads as a shader effect rather than as light.
      rim *= smoothstep(-0.15, 0.55, dot(normal, lightDir));

      // Tinted with the light net's own lighter tone rather than a color of
      // its own, and dimmed by the same depth falloff as everything else: it
      // is the same sunlight the caustics are, so it can't outlive them on
      // the way down.
      //
      // Faded by distance with detail (1 - fogAmount(), see fog.js, computed
      // once above) rather than being run through applyFog with the rest of
      // the body — an edge highlight that survived out into the murk would
      // read as fish-shaped outlines drawn on the haze.
      rimLight =
        uCausticsColor1 * rim * uRimStrength * vDepthDim * detail;
    #endif

    // The caustic net reaches the skin two ways, and the split matters more
    // than the total.
    //
    // Most of it MODULATES the light already falling on the body — a caustic
    // cusp is not a new light source, it is the same sunlight focused into a
    // bright patch, so where it lands the skin gets brighter *as itself*: the
    // olive back, the pink lateral band and the black spotting all scale
    // together and the pattern survives.
    //
    // Only a small part is ADDED. Additive was the whole of it before, and on
    // the authored skins that was the single most destructive term in this
    // shader — near the surface, where vDepthDim is ~1 and the term is least
    // attenuated, it laid a near-saturated green over everything. Contrast
    // collapses under an add: a black spot at 0.15 and a silver flank at 0.7
    // are 4.7:1 apart until you add 0.6 of green to both, and then they are
    // 1.6:1 apart and the fish is a pale green blob. A multiply leaves that
    // ratio exactly where the artist painted it.
    //
    // What the additive part is still for is the bright cusps themselves,
    // which genuinely do read as light sitting ON the fish rather than as the
    // fish being lit — and it is the only one of the two that carries the
    // two-tone color mix above, so it is also what puts the water's own hue
    // into the glint.
    //
    // Specular and sheen dimmed by the same depth falloff as everything else —
    // a fish deep in murky water shouldn't throw as bright a glint as one near
    // the surface.
    float glowModulate = 1.0 + glow * uCausticsGain / CAUSTIC_GLOW_CEILING;
    vec3 color = applyFog(
      base * lit * vDepthDim * glowModulate
        + causticsColor * glow * uCausticsAdd
        + (specular + sheen) * vDepthDim,
      vWorldPos
    );

    // Blend into the same fog color distant objects fade into (see
    // DEPTH_FOG_FACTOR above) — deep fish camouflage into the murk instead
    // of just going dark, on top of (and independent from) the
    // camera-distance fog applyFog() just applied.
    //
    // fogColorAt(), not uFogColor: the murk a fish disappears into is the
    // one at its own depth (see fog.js), so a fish near the bed vanishes
    // into the dark bottom of the column rather than into the brighter
    // mid-column color — which would leave it reading as a pale patch
    // against the water behind it.
    color = mix(color, fogColorAt(vWorldPos), vDepthFog);

    // The rim goes on last, after that blend rather than into it. Everything
    // else about a deep fish is supposed to dissolve into the murk, but the
    // outline is the one thing that has to survive it — a fish at the bed is
    // ~95% fog color, so a rim mixed in beforehand is 95% erased and the
    // term does nothing exactly where it was added to help. It still dims
    // with depth (vDepthDim) and fades with distance (above); what it no
    // longer does is get camouflaged away.
    color += rimLight;

    // vOpacity is a DISSOLVE, not an alpha — the material is opaque (see the
    // note on its transparent flag). 1 is the fish as shaded above; 0 is the
    // murk it is swimming in, sampled at its own depth so it disappears into
    // the shade of water it actually occupies rather than a flat grey.
    //
    // This is what the spawn fade-in, the despawn fade-out and the far
    // distance cull all ride on now. Thinning a fish out was always the wrong
    // picture of any of them: a fish arriving from upstream is not becoming
    // see-through, it is coming into view out of water you cannot see very far
    // through. Blending toward the murk says exactly that, and it leaves the
    // body solid the entire way.
    gl_FragColor = vec4(mix(fogColorAt(vWorldPos), color, vOpacity), 1.0);
  }
`;

// Samples the mesh at `frameCount` evenly-spaced points across one cycle of
// the clip (see clipStart/clipSpan below), CPU-skinning each vertex by hand
// (mirrors three's skinning_vertex.glsl.js chunk: bindMatrix -> weighted
// bone matrices -> bindMatrixInverse) and writes each pose into a
// (vertexCount x frameCount) float texture as an OFFSET from `restPositions`
// rather than as an absolute position — which is what lets the vertex
// shader scale the swim per instance (aAmplitude) for free.
//
// If the mesh isn't actually skinned (see the NOTE at the top of this file),
// frameCount collapses to 1 and that single pose is the mesh's own static,
// world-transformed position — identical to restPositions, so every offset
// is zero and the fish simply renders at rest. Fish don't swim, with no
// special-casing needed elsewhere.
function bakeVertexAnimationTexture(
  scene,
  mesh,
  clip,
  worldMatrix,
  center,
  restPositions,
  srcVertex,
) {
  const posAttr = mesh.geometry.attributes.position;
  // The baked geometry can hold MORE vertices than the source mesh — the fin
  // sheets get mirrored copies appended (see doubleOpenSheets) so the material
  // can be single-sided. Those copies are not in the skinned source at all, so
  // each output vertex is skinned from whichever source vertex it was copied
  // from. For an unduplicated vertex that is itself.
  const vertexCount = restPositions.count;
  const isSkinned = mesh.isSkinnedMesh && !!clip;
  const frameCount = isSkinned ? VAT_FRAME_COUNT : 1;

  const mixer = isSkinned ? new THREE.AnimationMixer(scene) : null;
  if (mixer) mixer.clipAction(clip).play();

  // Which slice of the clip's timeline one full cycle actually occupies.
  //
  // Not simply [0, clip.duration]: Blender numbers its first frame 1, not 0,
  // so an exported clip's tracks start at 1/fps while clip.duration reports
  // the *last* key's absolute time (steelhead-final.glb: keys run 0.0417 ->
  // 1.2917 at 24fps). Sampling [0, duration] would spend the first sample on
  // the flat pre-roll before the first key and then stop a frame short of
  // the loop point, leaving a small phase jump every single cycle on every
  // fish — the same class of glitch as a clip whose ends don't match, just
  // subtler and introduced on our side rather than the exporter's.
  //
  // Sampling [firstKey, duration] instead is exactly one authored cycle,
  // provided the export closes its loop (pose at duration == pose at
  // firstKey — worth verifying per model, it is the one property of the
  // clip this code cannot check for itself).
  let clipStart = 0;
  let clipSpan = 0;
  if (isSkinned) {
    const starts = clip.tracks
      .map((track) => track.times[0])
      .filter((t) => Number.isFinite(t));
    clipStart = starts.length > 0 ? Math.min(...starts) : 0;
    clipSpan = Math.max(1e-6, clip.duration - clipStart);
  }

  const skinIndexAttr = mesh.geometry.attributes.skinIndex;
  const skinWeightAttr = mesh.geometry.attributes.skinWeight;

  const local = new THREE.Vector4();
  const skinned = new THREE.Vector4();
  const scratch = new THREE.Vector4();
  const boneMatrix = new THREE.Matrix4();
  const world = new THREE.Vector3();

  const data = new Float32Array(vertexCount * frameCount * 4);

  for (let f = 0; f < frameCount; f++) {
    if (isSkinned) {
      mixer.setTime(clipStart + (clipSpan * f) / frameCount);
      scene.updateMatrixWorld(true);
      mesh.skeleton.update();
    }
    for (let i = 0; i < vertexCount; i++) {
      // Which vertex of the SOURCE skinned mesh drives this output vertex —
      // itself, unless it is a mirrored fin copy (see doubleOpenSheets).
      const s = srcVertex ? srcVertex[i] : i;
      local.set(posAttr.getX(s), posAttr.getY(s), posAttr.getZ(s), 1);

      if (isSkinned) {
        local.applyMatrix4(mesh.bindMatrix);
        skinned.set(0, 0, 0, 0);
        for (let k = 0; k < 4; k++) {
          const weight = skinWeightAttr.getComponent(s, k);
          if (weight === 0) continue;
          boneMatrix.fromArray(
            mesh.skeleton.boneMatrices,
            skinIndexAttr.getComponent(s, k) * 16,
          );
          scratch.copy(local).applyMatrix4(boneMatrix);
          skinned.x += scratch.x * weight;
          skinned.y += scratch.y * weight;
          skinned.z += scratch.z * weight;
          skinned.w += scratch.w * weight;
        }
        skinned.applyMatrix4(mesh.bindMatrixInverse);
        world.set(skinned.x, skinned.y, skinned.z);
      } else {
        world.set(local.x, local.y, local.z);
      }

      world.applyMatrix4(worldMatrix).sub(center);

      // Stored as an offset from the rest pose rather than as an absolute
      // position — see the aAmplitude note in VERTEX_SHADER. restPositions
      // is the caller's already-transformed, already-recentered geometry, so
      // both sides of this subtraction are in the same space.
      const o = (f * vertexCount + i) * 4;
      data[o] = world.x - restPositions.getX(i);
      data[o + 1] = world.y - restPositions.getY(i);
      data[o + 2] = world.z - restPositions.getZ(i);
      data[o + 3] = 1;
    }
  }

  const texture = new THREE.DataTexture(
    data,
    vertexCount,
    frameCount,
    THREE.RGBAFormat,
    THREE.FloatType,
  );
  texture.minFilter = THREE.NearestFilter;
  texture.magFilter = THREE.NearestFilter;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;

  return { texture, frameCount, vertexCount };
}

// Placeholder body color for models with no baseColorTexture — a muted
// silver-olive in the range a Chinook's flank actually reads as, since the
// flat baseColorFactor these exports carry (e.g. salmon.glb's near-black
// navy) is a Blender default, not an authored color.
const PLACEHOLDER_BODY_COLOR = new THREE.Color(0.4, 0.42, 0.36);

// Fallback for models exported with a flat baseColorFactor instead of a
// baseColorTexture (e.g. salmon.glb) — bakes a placeholder color into a 1x1
// texture so uBodyMap always has something to sample instead of going black.
function solidColorTexture() {
  const srgb = PLACEHOLDER_BODY_COLOR.clone().convertLinearToSRGB();
  const data = new Uint8Array([
    Math.round(srgb.r * 255),
    Math.round(srgb.g * 255),
    Math.round(srgb.b * 255),
    255,
  ]);
  const texture = new THREE.DataTexture(data, 1, 1, THREE.RGBAFormat);
  texture.needsUpdate = true;
  return texture;
}

// Gives every zero-thickness sheet in `geometry` a real back face, so the
// material can be rendered FrontSide.
//
// These models are almost closed solids — measured on the three that ship, the
// bodies are watertight manifolds and only the fins are open sheets: 28 of 672
// triangles on steelhead, 27 of 742 on chinook, 2 of 474 on shad. A fin is a
// single layer of polygons with no back, so it disappears when viewed from its
// unwound side, which is the whole reason the material was DoubleSide.
//
// DoubleSide is a bad way to buy that here, because these fish are TRANSPARENT
// (see the material's own notes): it does not only fill in the fins, it also
// draws the inside of the far wall of the body through the near one. That
// reads as hollow, inside-out fish rather than solid ones.
//
// So: find the triangles that touch a boundary edge — an edge used by exactly
// one triangle, which is what makes a sheet a sheet — and append a mirrored
// copy of each, wound the other way. ~4% more triangles, and the material can
// then be single-sided, which is both correct and cheaper.
//
// The appended normals flip only local X, reproducing exactly what the
// fragment shader's old gl_FrontFacing branch computed for a backface: the
// body's lateral axis is local X after MODEL_ROTATION_FIX, so that is the true
// mirror image across the fish's sagittal plane, which a plain negation is not
// for a sloped fin face.
//
// Returns srcVertex: for each vertex of the result, the index of the vertex in
// the ORIGINAL mesh it came from, so the VAT bake can skin the copies.
function doubleOpenSheets(geometry) {
  const pos = geometry.attributes.position;
  const index = geometry.getIndex();
  const originalVertexCount = pos.count;

  const srcVertex = new Uint32Array(originalVertexCount);
  for (let i = 0; i < originalVertexCount; i++) srcVertex[i] = i;

  if (!index) return srcVertex;

  const idx = index.array;
  const triCount = idx.length / 3;

  // Weld by position so vertices split only for UV or normal seams still count
  // as one point — otherwise every seam looks like a boundary and the whole
  // mesh reads as open.
  const welded = new Map();
  const weld = new Uint32Array(originalVertexCount);
  for (let i = 0; i < originalVertexCount; i++) {
    const k = `${pos.getX(i).toFixed(4)},${pos.getY(i).toFixed(4)},${pos.getZ(i).toFixed(4)}`;
    let id = welded.get(k);
    if (id === undefined) welded.set(k, (id = welded.size));
    weld[i] = id;
  }

  // Count triangles per undirected welded edge; anything used once is a
  // boundary, and the triangle holding it is part of an open sheet.
  const edgeUse = new Map();
  for (let t = 0; t < triCount; t++) {
    for (let e = 0; e < 3; e++) {
      const a = weld[idx[t * 3 + e]];
      const b = weld[idx[t * 3 + ((e + 1) % 3)]];
      const k = a < b ? a * 0x100000 + b : b * 0x100000 + a;
      const prev = edgeUse.get(k);
      edgeUse.set(k, prev === undefined ? [t] : (prev.push(t), prev));
    }
  }
  const sheetTris = new Set();
  for (const tris of edgeUse.values()) {
    if (tris.length === 1) sheetTris.add(tris[0]);
  }
  if (sheetTris.size === 0) return srcVertex;

  // Append a mirrored, reverse-wound copy of each sheet triangle. New vertices
  // rather than reusing the originals, because the copy needs its own normal.
  const attrs = Object.keys(geometry.attributes);
  const extraVerts = sheetTris.size * 3;
  const grown = {};
  for (const name of attrs) {
    const a = geometry.attributes[name];
    const out = new Float32Array((originalVertexCount + extraVerts) * a.itemSize);
    out.set(a.array.subarray(0, originalVertexCount * a.itemSize));
    grown[name] = { out, itemSize: a.itemSize };
  }

  const src = new Uint32Array(originalVertexCount + extraVerts);
  src.set(srcVertex);

  const newIdx = new Uint32Array(idx.length + sheetTris.size * 3);
  newIdx.set(idx);

  let v = originalVertexCount;
  let w = idx.length;
  for (const t of sheetTris) {
    const a = idx[t * 3];
    const b = idx[t * 3 + 1];
    const c = idx[t * 3 + 2];
    // Reversed winding, so the copy faces the other way.
    for (const s of [c, b, a]) {
      for (const name of attrs) {
        const { out, itemSize } = grown[name];
        const from = geometry.attributes[name];
        for (let k = 0; k < itemSize; k++) {
          out[v * itemSize + k] = from.array[s * itemSize + k];
        }
        // Mirror the normal across the sagittal plane — local X only.
        if (name === "normal") out[v * itemSize] = -out[v * itemSize];
      }
      src[v] = s;
      newIdx[w++] = v;
      v++;
    }
  }

  for (const name of attrs) {
    const { out, itemSize } = grown[name];
    geometry.setAttribute(name, new THREE.BufferAttribute(out, itemSize));
  }
  geometry.setIndex(new THREE.BufferAttribute(newIdx, 1));

  return src;
}

async function loadSpeciesModel(url) {
  const loader = new GLTFLoader();
  const gltf = await loader.loadAsync(url);
  gltf.scene.updateMatrixWorld(true);

  let mesh = null;
  gltf.scene.traverse((child) => {
    if (!mesh && child.isMesh) mesh = child;
  });

  // The mesh's own node carries a translation/rotation/scale independent of
  // the armature (see NOTE at top of file) — fold that into every vertex
  // now so the baked positions and the base geometry agree.
  const worldMatrix = mesh.matrixWorld.clone();

  // Every model here was authored with its body running along local X
  // instead of Z — everything downstream (modelLength below, the
  // per-instance heading rotation in createFishInstancedMesh) assumes the
  // body runs along Z, so correct for it once here rather than
  // special-casing every consumer. Which rotation actually lands that
  // correctly differs per model (see MODEL_ROTATION_FIX above).
  const rotationFix = MODEL_ROTATION_FIX[url];
  if (rotationFix) worldMatrix.multiply(rotationFix);

  const normalMatrix = new THREE.Matrix3().getNormalMatrix(worldMatrix);

  const geometry = mesh.geometry.clone();
  const posAttr = geometry.attributes.position;
  const normalAttr = geometry.attributes.normal;
  const vertexCount = posAttr.count;

  const p = new THREE.Vector3();
  const box = new THREE.Box3();
  for (let i = 0; i < vertexCount; i++) {
    p.fromBufferAttribute(posAttr, i).applyMatrix4(worldMatrix);
    posAttr.setXYZ(i, p.x, p.y, p.z);
    box.expandByPoint(p);
    if (normalAttr) {
      p.fromBufferAttribute(normalAttr, i)
        .applyMatrix3(normalMatrix)
        .normalize();
      normalAttr.setXYZ(i, p.x, p.y, p.z);
    }
  }

  // Re-center every vertex on the model's own bounding-box center, matching
  // the pivot InstancedMesh's per-instance transform expects.
  const center = box.getCenter(new THREE.Vector3());
  const modelLength = box.max.z - box.min.z;
  for (let i = 0; i < vertexCount; i++) {
    posAttr.setXYZ(
      i,
      posAttr.getX(i) - center.x,
      posAttr.getY(i) - center.y,
      posAttr.getZ(i) - center.z,
    );
  }
  posAttr.needsUpdate = true;
  if (normalAttr) normalAttr.needsUpdate = true;

  // Give the open fin sheets a real back face, so the material can be
  // single-sided (see the note on `side` in buildSpeciesRenderer).
  //
  // `srcVertex` maps every vertex of the result back to the vertex of the
  // ORIGINAL skinned mesh it was copied from, which is what lets the VAT bake
  // below skin the added vertices — they are not in the source mesh at all.
  const srcVertex = doubleOpenSheets(geometry);

  const clip =
    gltf.animations.find((c) => c.name === "Swimming") ??
    gltf.animations[0] ??
    null;
  // geometry.attributes.position here is the cloned geometry's position
  // attribute, already world-transformed, recentered, and sheet-doubled above
  // — the exact rest pose the vertex shader adds the sampled offsets onto.
  const vat = bakeVertexAnimationTexture(
    gltf.scene,
    mesh,
    clip,
    worldMatrix,
    center,
    geometry.attributes.position,
    srcVertex,
  );

  geometry.deleteAttribute("skinIndex");
  geometry.deleteAttribute("skinWeight");

  // Each vertex's own row index into the VAT (see sampleVatOffset in
  // VERTEX_SHADER) — the one thing the shader can't derive for itself, since
  // gl_VertexID isn't available in WebGL1.
  const finalCount = geometry.attributes.position.count;
  const vertexIndex = new Float32Array(finalCount);
  for (let i = 0; i < finalCount; i++) vertexIndex[i] = i;
  geometry.setAttribute(
    "aVertexIndex",
    new THREE.Float32BufferAttribute(vertexIndex, 1),
  );

  const texture = mesh.material?.map ? mesh.material.map : solidColorTexture();
  texture.colorSpace = THREE.SRGBColorSpace;

  return { geometry, modelLength, texture, vat };
}

let cachedLoad = null;

// Loads every distinct GLB referenced by SPECIES_MODEL_URL (species that
// share a URL, e.g. jackChinook/shad riding the steelhead placeholder,
// only fetch/bake it once) and resolves to a Map<url, assets> for
// createFishInstancedMesh to build one InstancedMesh per distinct model
// from.
export function loadFishAssets() {
  if (!cachedLoad) {
    const urls = [...new Set(Object.values(SPECIES_MODEL_URL))];
    cachedLoad = Promise.all(
      urls.map((url) => loadSpeciesModel(url).then((assets) => [url, assets])),
    ).then((entries) => new Map(entries));
  }
  return cachedLoad;
}

// Builds one species' InstancedMesh + its update/setBounds/setSeason closures
// — same shader/uniform setup regardless of which model backs it, just scoped
// to the geometry/texture/vat this particular model baked. `maxCount` is how
// many instances this one mesh can hold; see createFishInstancedMesh below for
// why every renderer is sized to the whole flock rather than a species share.
function buildSpeciesRenderer({ geometry, modelLength, texture, vat }, maxCount, modelUrl) {
  const phase = new Float32Array(maxCount);
  const cyclePos = new Float32Array(maxCount);
  const opacity = new Float32Array(maxCount);
  const amplitude = new Float32Array(maxCount);
  const tint = new Float32Array(maxCount * 3);

  // Every one of these is rewritten in full on every frame, so they're
  // flagged DynamicDrawUsage — the default (StaticDrawUsage) tells the driver
  // to expect a buffer that's uploaded once, which is the opposite of how
  // these are used.
  const instanced = (array, itemSize) => {
    const attribute = new THREE.InstancedBufferAttribute(array, itemSize);
    attribute.setUsage(THREE.DynamicDrawUsage);
    return attribute;
  };
  geometry.setAttribute("aPhase", instanced(phase, 1));
  geometry.setAttribute("aCyclePos", instanced(cyclePos, 1));
  geometry.setAttribute("aOpacity", instanced(opacity, 1));
  geometry.setAttribute("aAmplitude", instanced(amplitude, 1));
  geometry.setAttribute("aTint", instanced(tint, 3));

  const uniforms = {
    uVat: { value: vat.texture },
    uVatFrameCount: { value: vat.frameCount },
    uVatVertexCount: { value: vat.vertexCount },
    uBodyMap: { value: texture },
    uLightDir: { value: new THREE.Vector3(0.4, 1, 0.25).normalize() },
    // Blinn-Phong glint (see FRAGMENT_SHADER) — shininess controls how
    // tight/small the highlight is, strength how bright it gets at its
    // peak. Moderate shininess keeps it a soft glint rather than a pinprick
    // hotspot, which reads as noisy/aliased on a mesh this low-poly. That
    // ceiling on shininess is why the wet look is bought with uSpecularFresnel
    // below instead of by tightening the lobe.
    uShininess: { value: 24 },
    uSpecularStrength: { value: 0.5 },
    // How far the glint is tinted toward the underwater illuminant
    // (uCausticsColor1) instead of staying white — see FRAGMENT_SHADER. 0 is
    // the old white highlight, 1 is fully the water's own tone.
    uSpecularTint: { value: 0.55 },
    // How much harder the specular fires at grazing angles (Schlick Fresnel;
    // see FRAGMENT_SHADER). 0 is the old view-angle-flat glint. The GLB's own
    // metallicFactor/roughnessFactor cannot do this job — loadSpeciesModel
    // reads only material.map off the glTF and everything else about how a
    // fish reflects light lives in this shader, so shine is tuned here and
    // nowhere else.
    uSpecularFresnel: { value: 2.0 },
    // How strongly the caustic glow follows "up" (see FRAGMENT_SHADER).
    // 0 restores the old ungated behaviour, where a fish's belly caught the
    // light net as brightly as its back; 1 takes the belly to fully dark.
    // Held below 1 for the scattered light that reaches a real fish's
    // underside off the riverbed.
    uCausticFacing: { value: 0.85 },
    // Rim/edge light (see FRAGMENT_SHADER) — the exponent sets how far in
    // from the silhouette the glow reaches, the strength how bright that
    // edge gets.
    //
    // The exponent is the one that matters, and it has to be tight. Nothing
    // else here fades a fish for being CLOSE — the rim is the only term
    // that survives at full strength in the near field, since fogAmount()
    // is ~0 there — so a broad band lights most of the flank on the fish
    // that fill the most pixels, and the school reads as glowing rather
    // than as backlit. At 5 it stays a thin edge on a fish crossing the
    // lens while still being wide enough not to break into facets on a
    // mesh with this few faces.
    uRimStrength: { value: 0.45 },
    uRimExponent: { value: 5.0 },
    // Fake scale-bump normal detail, used only by the specular lobe (see
    // FRAGMENT_SHADER's perturbNormal) — NOT the banded diffuse or the rim,
    // both of which stay on the smooth per-vertex normal deliberately (the
    // rim in particular needs to stay a clean edge, not break into facets;
    // see its own comment below). This is what lets the highlight itself
    // look like it's catching individual scales instead of one soft blob,
    // without needing an authored normal map or tangent attribute this GLB
    // doesn't carry. uScaleFrequency is in cycles per local-space unit (the
    // rig is a ~4.76-unit body, see swim_rig.py) rather than UV cycles, so
    // it stays stable across the mesh's UV seams; retune by eye via
    // inspect.html.
    uBumpStrength: { value: 0.22 },
    uScaleFrequency: { value: 12 },
    // Wrapped-diffuse range (see FRAGMENT_SHADER). Kept narrow on purpose:
    // the authored skins already carry their own countershading, so this only
    // has to say where the sun is, not light the fish from scratch.
    uDiffuseFloor: { value: 0.7 },
    uDiffuseCeil: { value: 1.1 },
    // The two ends of the iridescent sheen's angle-dependent hue ramp (see
    // FRAGMENT_SHADER): warm where the flank faces the eye, cool where it
    // turns away. Added as light, never mixed into the skin.
    uSheenWarm: { value: new THREE.Color("#ffd9a8") },
    uSheenCool: { value: new THREE.Color("#8fb8ff") },
    uIridescenceStrength: { value: 0.06 },
    // Everything below is pushed by setCausticsTexture()/setBounds()/
    // setSeason() before the first frame is drawn; these placeholders only
    // exist so the material has something to compile against.
    uCaustics: { value: null },
    uTime: { value: 0 },
    uWorldSize: { value: new THREE.Vector2(1, 1) },
    uMargin: { value: new THREE.Vector2(0, 0) },
    uCausticsColor1: { value: new THREE.Color("#5cc594") },
    uCausticsColor2: { value: new THREE.Color("#123b28") },
    uCausticsStrength: { value: FISH_CAUSTICS_STRENGTH },
    // How the caustic net splits between brightening the skin's own colour and
    // laying light on top of it (see FRAGMENT_SHADER). uCausticsGain is the
    // multiply — how much brighter a full-strength cusp makes the body — and
    // uCausticsAdd is what is left over as an additive glint. The additive
    // share is small on purpose: it is the one that flattens the painted
    // pattern, and it is the reason the skins read as pale blobs near the
    // surface before this split existed.
    uCausticsGain: { value: 0.95 },
    uCausticsAdd: { value: 0.25 },
    uFogColor: { value: FOG_COLOR },
    uFogDensity: { value: 0 },
    uFogDepthRate: { value: 0 },
    uDepthDarkenRate: { value: 0 },
    uDepthFogRate: { value: 0 },
  };

  // Layer this model's own tuning over the shared defaults (see
  // MATERIAL_OVERRIDES). Scalar overrides only — every key in the table names
  // a uniform that already exists above, so a typo shows up as a thrown
  // TypeError at build time rather than as a silently ignored setting.
  for (const [name, value] of Object.entries(MATERIAL_OVERRIDES[modelUrl] ?? {})) {
    uniforms[name].value = value;
  }

  const material = new THREE.ShaderMaterial({
    uniforms,
    // Gates the Blinn-Phong specular and the rim light, which are two pow()
    // calls per fragment across the whole flock — see the fragment shader and
    // quality.js. A define rather than a uniform so the low tier does not
    // merely multiply the result by zero, it never compiles the work at all.
    defines: QUALITY.fishHighlights ? { FISH_HIGHLIGHTS: "" } : {},
    vertexShader: vertexShader(),
    fragmentShader: FRAGMENT_SHADER,
    // OPAQUE, with real depth. Fish are solid animals and this is the only
    // material in the scene that draws one.
    //
    // They used to be transparent, which was never about how a fish looks —
    // it was carrying two unrelated jobs. The first was distance falloff, and
    // that never needed alpha at all: applyFog() and the vDepthFog blend below
    // already dissolve a fish toward the murk as a COLOUR, which is what
    // recession actually looks like. The second was the spawn/despawn and
    // distance-cull fades, which now dissolve toward that same fog colour (see
    // the end of the fragment shader) rather than thinning the fish out.
    //
    // What transparency cost was steep. A see-through fish shows its own far
    // wall through its near one, so the school read as glass rather than
    // flesh. And because nothing in this scene wrote depth, draw order was the
    // ONLY thing deciding occlusion — which is why this file grew a
    // back-to-front sort of every instance every frame, plus a cross-species
    // renderOrder ranking, plus smoothing and hysteresis to stop that ranking
    // flickering whole species in front of each other. All of it was standing
    // in for a depth buffer that the composer's render target has had the
    // whole time. Opaque geometry gets correct per-PIXEL occlusion for free,
    // so every one of those mechanisms is gone.
    transparent: false,
    // On, now that the fish are opaque. This is what actually sorts them —
    // against each other and against the rest of the scene.
    //
    // It was off for a good reason while they were transparent: a
    // depth-writing transparent instance still writes depth at opacity ~0, so
    // a fish mid-fade punched a hole clean through to the background instead
    // of fading. That failure mode no longer exists, because a fading fish is
    // fully opaque and merely fog-coloured.
    //
    // Every other material in the scene still has depthWrite off and is drawn
    // in renderOrder sequence (terrain 0, water 1, silt/shafts 3 — see
    // createWorld in main.js). Those are genuinely translucent surfaces and
    // should stay that way. They are all depth-TESTED though, so now that the
    // fish lay down depth in the opaque pass, the riverbed behind a fish, the
    // silt behind a fish and a sun shaft behind a fish are all correctly
    // hidden by it — none of which the old all-transparent stack could do.
    depthWrite: true,
    depthTest: true,
    // Single-sided, which it could not be while the fins were zero-thickness
    // sheets — FrontSide culls a sheet away from whichever flank its winding
    // doesn't match, so the fins vanished from one side.
    //
    // DoubleSide fixed that and broke something worse. These fish are
    // transparent, so drawing back faces did not merely fill in the fins: it
    // drew the INSIDE of the far wall of every body through the near one, and
    // the interior surface is lit by a normal pointing away from the light. A
    // fish read as a hollow, inside-out shell rather than a solid animal, most
    // obviously on the big near-camera ones where there are the most pixels to
    // notice it in.
    //
    // loadSpeciesModel now gives the fin sheets a real mirrored back face
    // instead (see doubleOpenSheets), at a cost of ~4% more triangles, so
    // every triangle in the mesh has a genuine outward normal and this can be
    // what it should always have been.
    side: THREE.FrontSide,
  });

  const mesh = new THREE.InstancedMesh(geometry, material, maxCount);
  mesh.name = "fish";
  mesh.frustumCulled = false; // instances span the whole river; per-instance culling isn't worth it here
  // Opaque geometry, so THREE draws this in the opaque queue ahead of every
  // transparent surface in the scene regardless — the value mainly keeps the
  // fish behind the sky sphere's -1 and documents where they sit in the stack
  // (see FISH_RENDER_ORDER_BASE). Which species covers which is no longer a
  // draw-order question at all; the depth buffer answers it per pixel.
  mesh.renderOrder = FISH_RENDER_ORDER_BASE;
  // Rewritten every frame, same as the per-instance attributes above — and
  // unlike them, three allocates this one itself and leaves it static.
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);

  // Depth range fish swim within, and the world->sim UV mapping for the
  // caustics read. Both change only on resize; setBounds() below pushes them.
  let surfaceY = 0;
  let floorY = 0;

  // Distance-cull band, in world XZ around the camera (see the CULL_FADE_*
  // constants). Squared so the per-fish test needs no sqrt unless the fish is
  // actually inside the fade band. Set by setBounds().
  //
  // The camera position these are measured from lives one level up, in
  // createFishInstancedMesh — it writes each fish's `_camDistSq` once for the
  // whole flock while partitioning it by species, and this renderer compares
  // against that rather than keeping its own copy of the camera and
  // recomputing the same distance per species.
  let fadeStart = Infinity;
  let fadeEnd = Infinity;
  let fadeStartSq = Infinity;
  let fadeEndSq = Infinity;




  // Flags an instanced attribute for upload of just its first `instances`
  // entries. three's update ranges are expressed in array elements rather
  // than in instances, hence the itemSize multiply — 16 floats for a matrix,
  // 3 for a color, 1 for a scalar.
  const uploadRange = (attribute, instances) => {
    attribute.clearUpdateRanges();
    attribute.addUpdateRange(0, instances * attribute.itemSize);
    attribute.needsUpdate = true;
  };

  const matrix = new THREE.Matrix4();
  const quaternion = new THREE.Quaternion();
  const pitchQuat = new THREE.Quaternion();
  const rollQuat = new THREE.Quaternion();
  const eulerY = new THREE.Vector3(0, 1, 0);
  const eulerX = new THREE.Vector3(1, 0, 0);
  // Forward/travel axis — see noseOffsetLocal below (body runs along local
  // Z), so rolling about this axis banks the body without touching heading.
  const eulerZ = new THREE.Vector3(0, 0, 1);
  const scaleVec = new THREE.Vector3();

  // The geometry is centered on the model's bounding-box center (see
  // loadSpeciesModel), so a heading turn rotated straight around that point
  // swings the nose and tail through equal, opposite arcs — every turn
  // reads as the whole body pinwheeling around its middle, which is what
  // was landing as a robotic snap. Real fish turn nose-first, pivoting near
  // the head with the tail sweeping the wide arc instead. noseOffsetLocal
  // is the nose's position relative to that bbox center (the body runs
  // along local Z — see modelLength); each frame we rotate that offset by
  // the fish's current heading/pitch and subtract it from the boid's
  // tracked (f.x, y, f.y) point so *that* point lands on the nose instead
  // of the bbox center, then place the mesh from there.
  const noseOffsetLocal = new THREE.Vector3(0, 0, modelLength / 2);
  const noseOffsetWorld = new THREE.Vector3();
  const centerPos = new THREE.Vector3();

  // Writes the visible fish's transform + swim-phase attributes for this
  // frame. Horizontal motion (x, y -> world x, z) is the flock's real swim;
  // f.depth (0 = surface .. 1 = riverbed, see boids.js) is a slow,
  // independent secondary drift mapped into the surfaceY..floorY range, with
  // a small wobble and a slight pitch toward whichever way that drift is
  // currently heading so it still reads as swimming rather than an elevator.
  //
  // Fish past the fog's saturation distance are skipped entirely (see the
  // CULL_FADE_* constants), so `n` — the write cursor — runs ahead
  // independently of the loop index: instance slots have to stay dense from 0
  // to mesh.count, and a culled fish must not leave a hole behind.
  // `playing` is the pause state from main.js. A paused frame freezes the
  // flock, so the fish hold position — but their tails keep going at
  // PAUSED_SWIM_RATE rather than stopping dead, which reads as a school
  // holding station in the current instead of a photograph.
  //
  // Only the tailbeat is scaled, not `t`: everything else this function reads
  // off the clock is already frozen upstream (see the simulation clock in
  // main.js), and that is the point — the beat is the one motion deliberately
  // left running through a pause.
  //
  // `dt` is the same simulated-time step main.js hands flock.step(), in 60fps
  // frames. It is NOT optional and it is not a refinement: the tailbeat and
  // the pitch below are both accumulated per call, so without it they advance
  // a fixed amount per rendered FRAME while the fish covers a distance that
  // varies with frame time. See the note at the `advance` line below for what
  // that looked like.
  function update(fish, t, playing = true, dt = 1) {
    // Hoisted out of the loop — they are the same for every instance, and the
    // loop runs up to MAX_POPULATION times a frame.
    const beatScale = playing ? 1 : PAUSED_SWIM_RATE;
    // Pitch easing is a property of the SIMULATION, not of the render clock,
    // so it stops dead on pause the way the flock does — unlike the tailbeat
    // just above, which deliberately keeps ticking over.
    const simDt = playing ? dt : 0;
    // Seconds, matching what every other consumer of the procedural caustics
    // is handed (see quality.js); `t` is the simulation clock in milliseconds.
    // Compiled out on the tiers that sample the real accumulation target.
    uniforms.uTime.value = t * 0.001;

    // No back-to-front sort. The material is opaque and writes depth (see
    // its own notes), so overlapping fish are resolved per pixel by the depth
    // buffer instead of by which instance index happened to be written last.
    // That is both correct and cheaper: this used to sort every live fish,
    // every frame, per species.

    let n = 0;

    // Overflow is dropped from the FAR end, not the near one.
    //
    // `fish` is sorted farthest-first, so the old `i = 0; n < maxCount` shape
    // filled the instance buffer with the farthest maxCount fish and then
    // stopped — silently discarding the closest, largest, most on-screen fish
    // in the school, which is the worst possible set to lose. Skipping the
    // leading excess instead drops the fish that were already deepest in the
    // fog, where the loss is invisible. (Some of those would have been culled
    // outright a few lines down anyway, since the cull band trims from this
    // same far end.)
    //
    // With the population cap honoured this never triggers — see
    // rebuildDayTables in main.js, which is what keeps a tier downgrade from
    // leaving the flock above the capacity this buffer was sized for.
    for (let i = Math.max(0, fish.length - maxCount); i < fish.length; i++) {
      const f = fish[i];

      // Cheap reject first — before any quaternion/matrix work. The distance
      // was computed once for the whole flock by createFishInstancedMesh's
      // partition pass (see _camDistSq there); this function is only ever
      // called from it, so the value is always current.
      const distSq = f._camDistSq;
      if (distSq >= fadeEndSq) continue;

      let visibility = f.opacity;
      if (distSq > fadeStartSq) {
        visibility *=
          1 - (Math.sqrt(distSq) - fadeStart) / (fadeEnd - fadeStart);
      }

      // Rendered nose-to-tail length in world units. `modelLength * s` below
      // is the same figure with s cancelled out, leaving what the sim already
      // knows.
      const bodyLength = f.length * BODY_VISUAL_SCALE;

      const heading = Math.atan2(f.vx, f.vy);
      quaternion.setFromAxisAngle(eulerY, heading);

      // Nose-up/nose-down toward wherever this fish's depth wander is
      // currently heading, LOW-PASSED rather than taken raw.
      //
      // The raw value is a step function. `depthTarget` is re-picked outright
      // whenever depthCooldown expires (see boids.js), so `depthTarget - depth`
      // — and the pitch derived from it — jumped discontinuously in a single
      // frame, every 90-240 frames, independently per fish. One fish doing
      // that is a nose-flick; several hundred doing it on their own timers is a
      // constant scatter of snapping across the whole school, and it was a
      // real part of what read as the fish stuttering rather than swimming.
      //
      // Easing toward the target pitch instead spends those same 90-240 frames
      // turning into the new drift the way a fish actually would. The clamp
      // stays on the target, not on the eased value, so the range is unchanged.
      const targetPitch = Math.max(
        -0.2,
        Math.min(0.2, (f.depthTarget - f.depth) * 6),
      );
      f.pitch += (targetPitch - f.pitch) * Math.min(1, PITCH_SMOOTHING * simDt);
      pitchQuat.setFromAxisAngle(eulerX, f.pitch);
      quaternion.multiply(pitchQuat);

      const s = bodyLength / modelLength;
      scaleVec.set(s, s, s);

      // Tailbeat rate, derived from how fast this fish is actually moving
      // rather than set per species — see STRIDE_LENGTH above. `bodyLength`
      // (computed with the near fade above) is this fish's rendered
      // nose-to-tail length in the same world units its speed is measured in;
      // dividing speed by it gives body lengths per step, and dividing that by
      // the stride gives beats per step.
      const beatsPerStep = f.smoothSpeed / (bodyLength * STRIDE_LENGTH);
      const clampedBeats = Math.min(
        MAX_BEATS_PER_STEP,
        Math.max(MIN_BEATS_PER_STEP, beatsPerStep),
      );
      // Scaled by dt, for the same reason flock.step() is.
      //
      // `clampedBeats` is beats per 60fps-equivalent STEP, derived from
      // smoothSpeed which is itself world-units per step — so the beat only
      // stays locked to the distance travelled if it advances by the same
      // number of steps the flock just moved through. Without this it advanced
      // once per rendered frame regardless: stride length came out 2x fast on
      // a 120Hz display and half speed at 30fps, and — the visible part —
      // ordinary frame-time jitter desynced the tail from the motion frame to
      // frame, which is what read as the fish stuttering as they swam.
      const advance = clampedBeats * f.swimRate * dt;
      // Wrapped into [0, 1) rather than left to accumulate. The shader only
      // reads fract() of this, so an unbounded integer part is dead weight
      // that eats the float32 attribute's mantissa — after a few hours the
      // remaining precision is coarse enough to quantize the tailbeat.
      f.swimCyclePos = (f.swimCyclePos + advance * beatScale) % 1;

      // Bank opposite the tail's lateral sweep — see ROLL_AMPLITUDE above.
      // rollActivity renormalizes clampedBeats across its own clamp range so
      // a fish idling near MIN_BEATS_PER_STEP holds level instead of banking
      // on a tail that's barely moving. Applied before matrix.compose but
      // after noseOffsetWorld would be computed, though order doesn't
      // actually matter there: noseOffsetLocal sits on the local Z axis (see
      // below), which rolling about that same axis leaves unchanged.
      const rollActivity =
        (clampedBeats - MIN_BEATS_PER_STEP) /
        (MAX_BEATS_PER_STEP - MIN_BEATS_PER_STEP);
      const roll =
        ROLL_AMPLITUDE * rollActivity * Math.sin(f.swimCyclePos * Math.PI * 2);
      rollQuat.setFromAxisAngle(eulerZ, roll);
      quaternion.multiply(rollQuat);

      const y =
        THREE.MathUtils.lerp(surfaceY, floorY, f.depth) +
        Math.sin(t * 0.0007 + f.wobblePhase) * 2.5;
      noseOffsetWorld
        .copy(noseOffsetLocal)
        .multiplyScalar(s)
        .applyQuaternion(quaternion);
      centerPos.set(f.x, y, f.y).sub(noseOffsetWorld);
      matrix.compose(centerPos, quaternion, scaleVec);
      mesh.setMatrixAt(n, matrix);
      phase[n] = f.wobblePhase;
      cyclePos[n] = f.swimCyclePos;
      opacity[n] = visibility;
      amplitude[n] = f.swimAmplitude;
      const c = SPECIES_COLORS[f.species] ?? DEFAULT_COLOR;
      tint[n * 3] = c.r;
      tint[n * 3 + 1] = c.g;
      tint[n * 3 + 2] = c.b;
      n++;
    }
    mesh.count = n;


    // Upload only the `n` instances actually drawn, not all `capacity` slots.
    //
    // A bare `needsUpdate = true` re-uploads the entire backing buffer, and
    // these are sized to MAX_POPULATION + FISH_RENDER_HEADROOM (see main.js) —
    // so the frame was pushing ~128KB across the bus every frame regardless of
    // how many fish were on screen, most of it stale slots past `count` that
    // the draw call never reads. The loop above fills slots 0..n densely, so a
    // single update range covers exactly the live data.
    //
    // This matters more than it looks: capacity is per-renderer, so once
    // Chinook and Shad get their own meshes the untrimmed version would be
    // uploading three full buffers a frame instead of one.
    uploadRange(mesh.instanceMatrix, n);
    uploadRange(geometry.attributes.aPhase, n);
    uploadRange(geometry.attributes.aCyclePos, n);
    uploadRange(geometry.attributes.aOpacity, n);
    uploadRange(geometry.attributes.aAmplitude, n);
    uploadRange(geometry.attributes.aTint, n);
  }

  // Everything the fish shaders derive from the world's dimensions. All of it
  // changes only when bounds does, so it's pushed here (from main.js's
  // createWorld) instead of being recomputed inside update() on every frame
  // the way it used to be — which also gets three resize-invariant arguments
  // out of the per-frame call.
  //
  // Takes no camera: the cull band's radii are a function of bounds alone, and
  // the point they are measured FROM is held one level up in
  // createFishInstancedMesh, which is where each fish's `_camDistSq` is
  // written (see its setBounds).
  function setBounds(bounds, causticsSize, depthRange) {
    surfaceY = depthRange.surfaceY;
    floorY = depthRange.floorY;

    // The cull band, converted from fog units into world units. Vertical
    // distance is ignored: the whole water column is riverDepth deep, a small
    // fraction of the fog's reach, so XZ distance is what decides this.
    //
    // Boosted by FISH_FOG_DISTANCE_BOOST (see above), and the uniform pushed
    // to the shader below uses the same boosted rate — so the cull band lines
    // up with the distance at which this renderer's own fog blend has
    // actually camouflaged a fish, not with the shared, unboosted rate every
    // other surface fades at.
    const density = fogDensity(bounds) * FISH_FOG_DISTANCE_BOOST;
    fadeStart = CULL_FADE_START_FOG / density;
    fadeEnd = CULL_FADE_END_FOG / density;
    fadeStartSq = fadeStart * fadeStart;
    fadeEndSq = fadeEnd * fadeEnd;
    // uWorldSize/uMargin are the CAUSTICS pass's coverage (see
    // causticsWorldSize in water.js), which is the only thing this shader
    // samples world XZ against. They used to be waterWorldSize()'s, back when
    // the caustics pass and the water sim shared one extent.
    uniforms.uWorldSize.value.set(causticsSize.width, causticsSize.height);
    uniforms.uMargin.value.set(causticsSize.marginX, causticsSize.marginZ);
    uniforms.uFogDensity.value = density;
    uniforms.uFogDepthRate.value = fogDepthRate(bounds);
    uniforms.uDepthDarkenRate.value = depthDarkenRate(bounds);
    uniforms.uDepthFogRate.value = depthFogRate(bounds);
  }

  // The caustics accumulation target is cleared and re-rendered in place each
  // frame (see causticsGenerator.js), so the texture object itself is stable
  // — bound once when the world is built rather than re-assigned per frame.
  function setCausticsTexture(causticsTexture) {
    uniforms.uCaustics.value = causticsTexture;
  }

  // Ties the two-tone caustic glow (see FRAGMENT_SHADER above) to the same
  // season driving the sky/sun and water surface (see sceneSetup.js/
  // water.js) — called from main.js whenever the displayed date changes.
  function setSeason(dayOfYear) {
    const season = seasonForDay(dayOfYear);
    uniforms.uCausticsColor1.value.copy(season.causticsColor1);
    uniforms.uCausticsColor2.value.copy(season.causticsColor2);
  }

  // Already refracted by the caller (see the outer setSunDirection) — fish are
  // underwater, so what lights them is the sun Snell's window puts overhead,
  // not the above-surface direction sceneSetup/godRays are handed.
  function setSunDirection(refracted) {
    uniforms.uLightDir.value.copy(refracted);
  }

  // Releases only what this renderer owns.
  //
  // Deliberately NOT the geometry, the body texture or the VAT: all three come
  // from the shared per-URL asset (see loadSpeciesModel) and are reused by
  // whatever renderer is built next. A tier change rebuilds these renderers
  // (the caustics path is compiled into the material, so it cannot be switched
  // in place) and disposing the asset's geometry here would leave that rebuild
  // with a released buffer.
  function dispose() {
    material.dispose();
    mesh.dispose();
  }


  return {
    mesh,
    update,
    setBounds,
    setCausticsTexture,
    setSeason,
    setSunDirection,
    dispose,
  };
}

// Groups the four DART species by which GLB backs them (see
// SPECIES_MODEL_URL) and builds one InstancedMesh per distinct model. In
// this build all four share steelhead-final.glb, so that is a single mesh
// with the species told apart by aTint alone; give a species its own URL and
// it gets its own mesh built from its own geometry/VAT/texture, no other
// change required.
//
// Every renderer is sized to `capacity` — the whole population plus fade
// headroom — rather than to a per-species share. That is what the
// proportional species mix in main.js costs: with counts scaled to preserve
// the day's real percentages instead of clamped per species, a single-species
// day (2015's Chinook peak is nearly one — see data.js) legitimately puts
// every fish on one renderer, so any smaller capacity would silently drop the
// overflow. The waste is small — roughly 88 bytes per unused slot across
// instanceMatrix and the per-instance attributes above, so a few hundred KB
// even with four renderers — and it buys the guarantee that no day can
// exceed capacity.
export function createFishInstancedMesh(assetsByUrl, capacity) {
  const speciesByUrl = new Map();
  for (const [species, url] of Object.entries(SPECIES_MODEL_URL)) {
    if (!speciesByUrl.has(url)) speciesByUrl.set(url, []);
    speciesByUrl.get(url).push(species);
  }

  const group = new THREE.Group();
  group.name = "fish";

  // Each entry pairs a species renderer with a reusable (never reallocated)
  // bucket array `update` below partitions the live flock into, so
  // partitioning every frame doesn't allocate.
  const renderers = [];
  // Which renderer draws a given species. A Map rather than a find() over
  // `renderers`: the partition below runs once per fish per frame, so a
  // linear scan there was allocating a closure and walking the renderer list
  // ~1200 times a frame to answer a question fixed at construction.
  const rendererBySpecies = new Map();

  for (const [url, speciesList] of speciesByUrl) {
    const entry = {
      bucket: [],
      ...buildSpeciesRenderer(assetsByUrl.get(url), capacity, url),
    };
    group.add(entry.mesh);
    renderers.push(entry);
    for (const species of speciesList) rendererBySpecies.set(species, entry);
  }


  // Splits the live flock by species into each renderer's bucket, then
  // hands each renderer just its own slice — mirrors how a single shared
  // InstancedMesh used to read `fish` directly, just partitioned first so a
  // chinook-only mesh only ever sees chinook fish (and vice versa).
  //
  // The partition pass also writes each fish's squared camera-XZ distance,
  // since it is already walking the whole flock. Every downstream consumer —
  // the back-to-front sort, the cull test, the species ranking — reads that
  // one value instead of recomputing it (the sort alone used to recompute both
  // operands on every one of its O(n log n) comparisons).
  //
  // No capacity guard here any more. Truncating the bucket dropped fish in
  // flock-AGE order, before the per-renderer sort had run, so an overflow lost
  // an arbitrary set rather than the least visible one. The per-renderer
  // update() clamps to its own instance capacity instead, from the far end
  // where the loss doesn't show.
  function update(fish, t, playing = true, dt = 1) {
    for (const r of renderers) r.bucket.length = 0;
    for (const f of fish) {
      const dx = f.x - camX;
      const dz = f.y - camZ;
      f._camDistSq = dx * dx + dz * dz;
      const r = rendererBySpecies.get(f.species);
      if (r) r.bucket.push(f);
    }
    // `playing` and `dt` both have to be forwarded, not just accepted: this is
    // the only caller of the per-renderer update(), so anything dropped here
    // silently falls back to that function's defaults — and for `dt` that
    // default is the 60fps assumption the whole tailbeat was wrongly built on.
    for (const r of renderers) r.update(r.bucket, t, playing, dt);

    // No cross-species ranking either. Each species is its own
    // InstancedMesh, so THREE never sorted individual fish across that
    // boundary — but with opaque, depth-writing fish it does not need to: the
    // depth buffer resolves a chinook against a shad per pixel, whichever
    // order the two meshes are drawn in.
  }

  // Where the per-fish `_camDistSq` written in update() is measured from. The
  // camera is fixed (see sceneSetup.js) and only re-framed on resize, so this
  // belongs on setBounds' cadence rather than the per-frame one.
  let camX = 0;
  let camZ = 0;

  function setBounds(bounds, causticsSize, depthRange, cameraPosition) {
    camX = cameraPosition.x;
    camZ = cameraPosition.z;
    for (const r of renderers) r.setBounds(bounds, causticsSize, depthRange);
  }

  function setCausticsTexture(causticsTexture) {
    for (const r of renderers) r.setCausticsTexture(causticsTexture);
  }

  function setSeason(dayOfYear) {
    for (const r of renderers) r.setSeason(dayOfYear);
  }

  // Takes the same above-water sun every other consumer in main.js gets, and
  // refracts it once here rather than per renderer. Until this existed
  // uLightDir was a hardcoded (0.4, 1, 0.25) that nothing ever wrote, so the
  // fish were the only thing in the scene that did not follow the sun — the
  // rim light's note about travelling as the sun crosses the sky was
  // describing an intent, not the behaviour.
  function setSunDirection(sun) {
    const refracted = refractedSunDirection(sun, _fishSun);
    for (const r of renderers) r.setSunDirection(refracted);
  }

  // Instances actually drawn last frame, summed across renderers — i.e. the
  // flock minus everything the distance cull dropped. Only read by main.js's
  // debug panel, which is where you can see what the cull is actually buying.
  function renderedCount() {
    let n = 0;
    for (const r of renderers) n += r.mesh.count;
    return n;
  }


  // The material actually drawing a given species, for callers that need to
  // read or tune one model's uniforms rather than all of them.
  //
  // inspect.js is the reason this exists. It used to reach in via
  // mesh.traverse() and write every material it found, which was fine when all
  // three shared one tuning — but now that each model carries its own (see
  // MATERIAL_OVERRIDES) that broadcast would flatten the per-species values
  // back to a single set the moment a slider moved, hiding exactly the
  // difference the viewer is there to look at.
  function materialForSpecies(species) {
    return rendererBySpecies.get(species)?.mesh.material ?? null;
  }

  function dispose() {
    for (const r of renderers) {
      group.remove(r.mesh);
      r.dispose();
    }
    renderers.length = 0;
    rendererBySpecies.clear();
  }

  return {
    mesh: group,
    update,
    setBounds,
    setCausticsTexture,
    setSeason,
    setSunDirection,
    renderedCount,
    materialForSpecies,
    dispose,
  };
}
