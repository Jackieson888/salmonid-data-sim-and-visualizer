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
// gltf.animations[0]; this export's clip is actually named "Swimming.005"
// (Blender's auto-suffix from stray duplicate actions in the source file),
// so it's currently riding the animations[0] fallback, not the name match.
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
// All four currently point at steelhead-final.glb — deliberately, as an
// evaluation build: it is the first mesh authored against the vertex budget
// and the procedural swim rig (1320 verts / 654 tris / 16 spine bones, one
// loop-closed "Swimming" cycle), and pointing every species at it isolates
// "how does the new geometry and animation read in-scene" from "are the
// other three models done yet." Restore per-species URLs as each new mesh
// lands; nothing else here needs to change when they do.

import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { CAUSTIC_GLOW_POINT_GLSL, CAUSTIC_SATURATE_GLSL } from "./glsl.js";
import { FOG_GLSL, FOG_COLOR, fogDensity } from "./fog.js";
import { riverDepth } from "./terrain.js";
import { seasonForDay } from "./season.js";
import { BODY_VISUAL_SCALE } from "../boids.js";

const STEELHEAD_FINAL_URL = "/steelhead-final.glb";

const SPECIES_MODEL_URL = {
  steelhead: STEELHEAD_FINAL_URL,
  chinook: STEELHEAD_FINAL_URL,
  jackChinook: STEELHEAD_FINAL_URL,
  shad: STEELHEAD_FINAL_URL,
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
const MODEL_ROTATION_FIX = {
  [STEELHEAD_FINAL_URL]: new THREE.Matrix4().makeRotationY(Math.PI * 0.5),
};

// Flat per-instance tint for each of the four DART species (see data.js),
// multiplied into the sampled body texture in the fragment shader below.
//
// All four species share one model in this build (see SPECIES_MODEL_URL), so
// tint is currently the *only* thing telling them apart on screen — and
// steelhead-final.glb ships no texture, so uBodyMap is the flat
// PLACEHOLDER_BODY_COLOR olive rather than a photographic skin. Both push
// these toward "clearly distinguishable" over "subtle": values above 1 are
// deliberate, since multiplying a mid-olive base by a <1 tint on all three
// channels just produces four shades of the same murk. They still track
// each species' real cast — bronze-maroon spawning chinook, greener jack,
// rosy-striped steelhead, cold silver-blue shad — so the frame doesn't read
// as arbitrarily color-coded. Set steelhead back to identity once its own
// textured model lands.
const SPECIES_COLORS = {
  steelhead: new THREE.Color(1.05, 0.9, 1.0),
  chinook: new THREE.Color(1.15, 1.05, 0.8),
  jackChinook: new THREE.Color(0.95, 1.1, 1.0),
  shad: new THREE.Color(0.85, 1.0, 1.35),
};
const DEFAULT_COLOR = SPECIES_COLORS.steelhead;

// Poses sampled across one loop of the baked "Swimming" clip. 30 is plenty
// for a low-poly fish with linear interpolation between rows in the shader.
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

// Bounds on the derived rate, in cycles per sim step. The sim enforces a
// minimum cruising speed (see boids.js) so the lower bound is mostly a
// safety net against a fish freezing into a rigid plank; the upper stops a
// brief speed spike from blurring the tail into a hum. At 60fps these are
// roughly 0.25Hz and 3.6Hz.
const MIN_BEATS_PER_STEP = 0.004;
const MAX_BEATS_PER_STEP = 0.06;

// Accumulated per-fish frame-over-frame in update() below (f.swimCyclePos)
// rather than recomputed from absolute time each frame — recomputing as
// `uTime * rate` would make the sampled VAT frame jump on every call that
// changed uTime's scale.
//
// Accumulated per sim *step*, not per real second, because the sim itself is
// frame-coupled: main.js's loop calls flock.step(1) once per animation
// frame, so fish cover a fixed distance per frame rather than per second.
// Advancing the tailbeat on the same clock is what keeps stride length
// honest at any refresh rate — on a 120Hz display fish move twice as far per
// second and beat twice as often, holding the same distance per stroke.
// This does assume update() is called exactly once per flock.step(), which
// main.js's loop does.
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

const VERTEX_SHADER = /* glsl */ `
  ${CAUSTIC_GLOW_POINT_GLSL}

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

  varying vec2 vUv;
  varying vec3 vWorldNormal;
  varying float vCausticGlow;
  varying float vOpacity;
  varying vec3 vTint;
  varying vec3 vWorldPos;
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

    vec4 worldPos = instanceMatrix * vec4(bent, 1.0);
    vWorldPos = worldPos.xyz;
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
    // uMargin match water.js's waterWorldSize() — the sim covers a bigger,
    // bounds-centered area, not just the raw bounds (see main.js). Left
    // un-dimmed here — depth attenuation is applied in the fragment shader
    // *after* the intensity curve (see FRAGMENT_SHADER) so it stays visible
    // instead of getting swallowed by saturation at high uCausticsStrength.
    vec2 waterUv = (worldPos.xz + uMargin) / uWorldSize;
    vCausticGlow = causticGlowPoint(uCaustics, waterUv);

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
  uniform float uShininess;
  uniform float uSpecularStrength;

  varying vec2 vUv;
  varying vec3 vWorldNormal;
  varying float vCausticGlow;
  varying float vOpacity;
  varying vec3 vTint;
  varying vec3 vWorldPos;
  varying float vDepthDim;
  varying float vDepthFog;

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

    vec3 normal = normalize(vWorldNormal);
    vec3 lightDir = normalize(uLightDir);

    float ndl = dot(normal, lightDir) * 0.5 + 0.5;
    float band = floor(ndl * 4.0) / 4.0;
    float lit = mix(0.55, 1.2, band);

    // Blinn-Phong specular glint — wet scales reflect the sun as a tight,
    // bright highlight rather than just scattering it like the banded lit
    // term above, which is what was reading as flat/matte. Keyed off the
    // half-vector (not just the normal) so it slides across the fish as the
    // camera orbits, the way a real specular highlight moves on curved,
    // glossy skin instead of staying locked to a fixed lit side.
    vec3 viewDir = normalize(cameraPosition - vWorldPos);
    vec3 halfDir = normalize(lightDir + viewDir);
    float specAngle = max(dot(normal, halfDir), 0.0);
    float specular = pow(specAngle, uShininess) * uSpecularStrength;

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
    float glow = glowSaturated * vDepthDim;

    // Two-tone caustics: uCausticsColor1 (the lighter tone) only takes over
    // where the glow is genuinely intense AND the fish is near the surface —
    // multiplying the two signals means either one fading (a dim glimmer, or
    // the same glimmer deeper down) pulls the tone back toward
    // uCausticsColor2, matching how real underwater light both dims and
    // loses its sharp, bright color with depth.
    float glowNorm = clamp(glowSaturated / CAUSTIC_GLOW_CEILING, 0.0, 1.0);
    float tone = clamp(glowNorm * vDepthDim, 0.0, 1.0);
    vec3 causticsColor = mix(uCausticsColor2, uCausticsColor1, tone);

    // Specular dimmed by the same depth falloff as everything else — a fish
    // deep in murky water shouldn't throw as bright a glint as one near the
    // surface.
    vec3 color = applyFog(
      base * lit * vDepthDim + causticsColor * glow + specular * vDepthDim,
      vWorldPos
    );

    // Blend into the same fog color distant objects fade into (see
    // DEPTH_FOG_FACTOR above) — deep fish camouflage into the murk instead
    // of just going dark, on top of (and independent from) the
    // camera-distance fog applyFog() just applied.
    color = mix(color, uFogColor, vDepthFog);
    gl_FragColor = vec4(color, vOpacity);
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
) {
  const posAttr = mesh.geometry.attributes.position;
  const vertexCount = posAttr.count;
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
      local.set(posAttr.getX(i), posAttr.getY(i), posAttr.getZ(i), 1);

      if (isSkinned) {
        local.applyMatrix4(mesh.bindMatrix);
        skinned.set(0, 0, 0, 0);
        for (let k = 0; k < 4; k++) {
          const weight = skinWeightAttr.getComponent(i, k);
          if (weight === 0) continue;
          boneMatrix.fromArray(
            mesh.skeleton.boneMatrices,
            skinIndexAttr.getComponent(i, k) * 16,
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

  const clip =
    gltf.animations.find((c) => c.name === "Swimming") ??
    gltf.animations[0] ??
    null;
  // posAttr here is the cloned geometry's position attribute, already
  // world-transformed and recentered above — the exact rest pose the vertex
  // shader adds the sampled offsets back onto.
  const vat = bakeVertexAnimationTexture(
    gltf.scene,
    mesh,
    clip,
    worldMatrix,
    center,
    posAttr,
  );

  geometry.deleteAttribute("skinIndex");
  geometry.deleteAttribute("skinWeight");

  // Each vertex's own row index into the VAT (see sampleVatOffset in
  // VERTEX_SHADER) — the one thing the shader can't derive for itself, since
  // gl_VertexID isn't available in WebGL1.
  const vertexIndex = new Float32Array(vertexCount);
  for (let i = 0; i < vertexCount; i++) vertexIndex[i] = i;
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
function buildSpeciesRenderer({ geometry, modelLength, texture, vat }, maxCount) {
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
    // hotspot, which reads as noisy/aliased on a mesh this low-poly.
    uShininess: { value: 20 },
    uSpecularStrength: { value: 0.5 },
    // All five below are pushed by setCausticsTexture()/setBounds() before
    // the first frame is drawn; these placeholders only exist so the material
    // has something to compile against.
    uCaustics: { value: null },
    uWorldSize: { value: new THREE.Vector2(1, 1) },
    uMargin: { value: new THREE.Vector2(0, 0) },
    uCausticsColor1: { value: new THREE.Color("#5cc594") },
    uCausticsColor2: { value: new THREE.Color("#123b28") },
    uCausticsStrength: { value: 18 },
    uFogColor: { value: FOG_COLOR },
    uFogDensity: { value: 0 },
    uDepthDarkenRate: { value: 0 },
    uDepthFogRate: { value: 0 },
  };

  const material = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: VERTEX_SHADER,
    fragmentShader: FRAGMENT_SHADER,
    // Lets aOpacity (spawn fade-in / remove fade-out — see boids.js) actually
    // blend instead of being ignored; most fish sit at opacity 1 (fully
    // opaque) most of the time, so leaving depthWrite at its default keeps
    // normal occlusion correct and only the brief fade window can mis-sort.
    transparent: true,
  });

  const mesh = new THREE.InstancedMesh(geometry, material, maxCount);
  mesh.name = "fish";
  mesh.frustumCulled = false; // instances span the whole river; per-instance culling isn't worth it here
  // Rewritten every frame, same as the per-instance attributes above — and
  // unlike them, three allocates this one itself and leaves it static.
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);

  // Depth range fish swim within, and the world->sim UV mapping for the
  // caustics read. Both change only on resize; setBounds() below pushes them.
  let surfaceY = 0;
  let floorY = 0;

  const matrix = new THREE.Matrix4();
  const quaternion = new THREE.Quaternion();
  const pitchQuat = new THREE.Quaternion();
  const eulerY = new THREE.Vector3(0, 1, 0);
  const eulerX = new THREE.Vector3(1, 0, 0);
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

  // Writes every living fish's transform + swim-phase attributes for this
  // frame. `fish` is the live flock.fish array — dense (no holes), so
  // instance index i always means "the i-th currently-alive fish", never
  // a stale slot. Horizontal motion (x, y -> world x, z) is the flock's
  // real swim; f.depth (0 = surface .. 1 = riverbed, see boids.js) is a
  // slow, independent secondary drift mapped into the surfaceY..floorY
  // range, with a small wobble and a slight pitch toward whichever way
  // that drift is currently heading so it still reads as swimming rather
  // than an elevator.
  function update(fish, t) {
    const count = Math.min(fish.length, maxCount);
    for (let i = 0; i < count; i++) {
      const f = fish[i];
      const heading = Math.atan2(f.vx, f.vy);
      quaternion.setFromAxisAngle(eulerY, heading);

      const depthDelta = f.depthTarget - f.depth;
      const pitch = Math.max(-0.2, Math.min(0.2, depthDelta * 6));
      pitchQuat.setFromAxisAngle(eulerX, pitch);
      quaternion.multiply(pitchQuat);

      const s = (f.length * BODY_VISUAL_SCALE) / modelLength;
      scaleVec.set(s, s, s);
      const y =
        THREE.MathUtils.lerp(surfaceY, floorY, f.depth) +
        Math.sin(t * 0.0007 + f.wobblePhase) * 2.5;
      noseOffsetWorld
        .copy(noseOffsetLocal)
        .multiplyScalar(s)
        .applyQuaternion(quaternion);
      centerPos.set(f.x, y, f.y).sub(noseOffsetWorld);
      matrix.compose(centerPos, quaternion, scaleVec);
      mesh.setMatrixAt(i, matrix);
      phase[i] = f.wobblePhase;
      // Tailbeat rate, derived from how fast this fish is actually moving
      // rather than set per species — see STRIDE_LENGTH above. `s` is the
      // model-to-world scale computed above, so modelLength * s is this
      // fish's rendered nose-to-tail length in the same world units its
      // speed is measured in; dividing speed by it gives body lengths per
      // step, and dividing that by the stride gives beats per step.
      const bodyLength = modelLength * s;
      const beatsPerStep = f.smoothSpeed / (bodyLength * STRIDE_LENGTH);
      const advance =
        Math.min(
          MAX_BEATS_PER_STEP,
          Math.max(MIN_BEATS_PER_STEP, beatsPerStep),
        ) * f.swimRate;
      // Wrapped into [0, 1) rather than left to accumulate. The shader only
      // reads fract() of this, so an unbounded integer part is dead weight
      // that eats the float32 attribute's mantissa — after a few hours the
      // remaining precision is coarse enough to quantize the tailbeat.
      f.swimCyclePos = (f.swimCyclePos + advance) % 1;
      cyclePos[i] = f.swimCyclePos;
      opacity[i] = f.opacity;
      amplitude[i] = f.swimAmplitude;
      const c = SPECIES_COLORS[f.species] ?? DEFAULT_COLOR;
      tint[i * 3] = c.r;
      tint[i * 3 + 1] = c.g;
      tint[i * 3 + 2] = c.b;
    }
    mesh.count = count;
    mesh.instanceMatrix.needsUpdate = true;
    geometry.attributes.aPhase.needsUpdate = true;
    geometry.attributes.aCyclePos.needsUpdate = true;
    geometry.attributes.aOpacity.needsUpdate = true;
    geometry.attributes.aAmplitude.needsUpdate = true;
    geometry.attributes.aTint.needsUpdate = true;
  }

  // Everything the fish shaders derive from the world's dimensions. All of it
  // changes only when bounds does, so it's pushed here (from main.js's
  // createWorld) instead of being recomputed inside update() on every frame
  // the way it used to be — which also gets four resize-invariant arguments
  // out of the per-frame call.
  function setBounds(bounds, waterSize, depthRange) {
    surfaceY = depthRange.surfaceY;
    floorY = depthRange.floorY;
    // uWorldSize/uMargin match water.js's waterWorldSize() — the caustics
    // cover a bigger, bounds-centered area, not just the raw bounds.
    uniforms.uWorldSize.value.set(waterSize.width, waterSize.height);
    uniforms.uMargin.value.set(waterSize.marginX, waterSize.marginZ);
    uniforms.uFogDensity.value = fogDensity(bounds);
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

  return { mesh, update, setBounds, setCausticsTexture, setSeason };
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
      ...buildSpeciesRenderer(assetsByUrl.get(url), capacity),
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
  // The capacity guard is a backstop, not the normal path: `capacity`
  // includes headroom for fish still fading out (see FISH_RENDER_HEADROOM in
  // main.js), so a bucket reaching it means the population overran even that,
  // and dropping the overflow is better than writing past the buffer.
  function update(fish, t) {
    for (const r of renderers) r.bucket.length = 0;
    for (const f of fish) {
      const r = rendererBySpecies.get(f.species);
      if (r && r.bucket.length < capacity) r.bucket.push(f);
    }
    for (const r of renderers) r.update(r.bucket, t);
  }

  function setBounds(bounds, waterSize, depthRange) {
    for (const r of renderers) r.setBounds(bounds, waterSize, depthRange);
  }

  function setCausticsTexture(causticsTexture) {
    for (const r of renderers) r.setCausticsTexture(causticsTexture);
  }

  function setSeason(dayOfYear) {
    for (const r of renderers) r.setSeason(dayOfYear);
  }

  return { mesh: group, update, setBounds, setCausticsTexture, setSeason };
}
