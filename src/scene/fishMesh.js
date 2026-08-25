// fishMesh.js
// Loads each species' GLB, bakes its swim clip into a Vertex Animation Texture (VAT) at load
// time, and renders the whole flock as one InstancedMesh per distinct model.
// Design rationale, invariants, gotchas: .claude/context/scene/fishMesh.md

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
const LAMPREY_FINAL_URL = "/lamprey-final.glb";

// Maps each of the five DART species to the GLB that renders it; species sharing a URL share one InstancedMesh.
export const SPECIES_MODEL_URL = {
  steelhead: STEELHEAD_FINAL_URL,
  chinook: CHINOOK_FINAL_URL,
  jackChinook: CHINOOK_FINAL_URL,
  shad: SHAD_FINAL_URL,
  lamprey: LAMPREY_FINAL_URL,
};

// Per-model fixup rotation folded into worldMatrix in loadSpeciesModel, so every model's baked
// geometry ends up nose-along-+Z the way modelLength/noseOffsetLocal assume. See the doc for the
// bone-vs-node rotation semantics behind each entry before adding a new model here.
const MODEL_ROTATION_FIX = {
  [STEELHEAD_FINAL_URL]: new THREE.Matrix4().makeRotationY(Math.PI * 0.5),
  [CHINOOK_FINAL_URL]: new THREE.Matrix4().makeRotationY(Math.PI * 0.5),
  [SHAD_FINAL_URL]: new THREE.Matrix4().makeRotationY(Math.PI * 0.5),
  [LAMPREY_FINAL_URL]: new THREE.Matrix4().makeRotationY(Math.PI * -0.5),
};

// Flat per-instance tint for each of the five DART species, multiplied into the sampled body
// texture in the fragment shader. Only jackChinook (which borrows chinook's model) needs one;
// see the doc for why the strength is pushed well past 1.
const TINT_STRENGTH = 2.1;

// Rec. 709 luminance weights, for the renormalization in speciesTint().
const LUMA_R = 0.2126;
const LUMA_G = 0.7152;
const LUMA_B = 0.0722;

// Pushes a cast away from neutral by TINT_STRENGTH, then renormalizes to unit luminance so
// species differ in hue, not brightness (brightness already means near/far in this scene).
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
  lamprey: NO_TINT,
};
const DEFAULT_COLOR = SPECIES_COLORS.steelhead;

// Per-model material overrides, layered onto the shared defaults in buildSpeciesRenderer's
// `uniforms`. Keyed by GLB URL, not species (jackChinook shares chinook's mesh/material).
// The four authored skins are not variations on a theme — see the doc for what each one
// is compensating for. Anything not named here keeps the shared default.
const MATERIAL_OVERRIDES = {
  [CHINOOK_FINAL_URL]: {
    uDiffuseCeil: 0.98,
    uDiffuseFloor: 0.66,
    uSpecularStrength: 0.38,
    uCausticsGain: 0.8,
    uScaleFrequency: 17,
    uBumpStrength: 0.16,
    uIridescenceStrength: 0.04,
  },
  [SHAD_FINAL_URL]: {
    uDiffuseCeil: 1.02,
    uSpecularStrength: 0.45,
    uScaleFrequency: 8,
    uBumpStrength: 0.18,
    uIridescenceStrength: 0.03,
  },
  [LAMPREY_FINAL_URL]: {
    uBumpStrength: 0.05,
    uScaleFrequency: 5,
    uIridescenceStrength: 0.02,
  },
};

// Poses sampled across one loop of the baked "Swimming" clip. 30 is plenty for a low-poly fish
// with linear interpolation between rows in the shader. Fixed rather than per-quality-tier — see
// doc for why a QUALITY.vatFrames knob couldn't actually work here.
const VAT_FRAME_COUNT = 30;

// Body lengths travelled per complete tailbeat — ties the swim animation's rate to how fast a
// fish is actually moving (rather than a hardcoded per-species Hz table), so the tail never reads
// as sliding out of sync with the body's travel. See doc for the derivation.
const STRIDE_LENGTH = 0.7;

// Peak body roll (banking around the fish's own forward axis) at full tailbeat effort, scaled
// toward zero as the tail idles — see rollActivity in update().
const ROLL_AMPLITUDE = THREE.MathUtils.degToRad(8);

// Bounds on the derived tailbeat rate, in cycles per sim step (~0.25Hz-3.6Hz at 60fps).
const MIN_BEATS_PER_STEP = 0.004;
const MAX_BEATS_PER_STEP = 0.06;

// Per-sim-step blend factor easing a fish's body pitch toward its current depth-drift target
// (see the pitch block in update()) — a time constant of ~17 steps.
const PITCH_SMOOTHING = 0.06;

// Tailbeat rate while playback is paused, as a fraction of the derived rate — not zero, so a
// paused school still reads as holding station rather than frozen mid-stroke.
const PAUSED_SWIM_RATE = 0.05;

// Accumulated per-fish, per sim STEP (not per real second) in update() below (f.swimCyclePos),
// which is what keeps stride length honest at any refresh rate — see doc for the dt bug this
// replaced. Exported so fishAnatomy.js's CPU-side VAT sample can reproduce the exact cycle
// position VERTEX_SHADER's `cycles` line computes.
export const PHASE_TO_CYCLE = 1 / (2 * Math.PI);

// How much a fish dims the deeper below the water surface (world Y = 0) it swims. ln(4) means a
// fish at riverDepth(bounds) sits at 1/4 brightness before the MIN_DEPTH_DIM floor.
const DEPTH_DARKEN_FACTOR = Math.log(4);
const MIN_DEPTH_DIM = 0.15;

function depthDarkenRate(bounds) {
  return DEPTH_DARKEN_FACTOR / riverDepth(bounds);
}

// Separate, more aggressive falloff blending a fish toward uFogColor as it swims deeper, on top
// of the dimming above — a fish at riverDepth(bounds) is ~95% blended into the fog color.
const DEPTH_FOG_FACTOR = Math.log(20);

function depthFogRate(bounds) {
  return DEPTH_FOG_FACTOR / riverDepth(bounds);
}

// Distance-cull fade band, in units of the fog's own falloff (density * dist) rather than world
// units. At 2.2 a fish is 99.2% fog color; at 2.6, 99.9% — see doc for the measured cull yield
// and why these thresholds are conservative.
const CULL_FADE_START_FOG = 2.2;
const CULL_FADE_END_FOG = 2.6;


// How much more aggressively fish fade into the fog color with camera distance than every other
// surface does (terrain.js/water.js keep the unboosted rate) — see doc for why this is 1.1 and
// not the original 1.35.
const FISH_FOG_DISTANCE_BOOST = 1.1;

// Multiplies the raw caustic glow before it's added on top of the fish's own body texture. See
// doc for why 18 washed out the authored skins and 11 doesn't.
const FISH_CAUSTICS_STRENGTH = 11;

// Where the fish sit in the scene's explicit draw order (terrain 0, water 1, particles/godRays 3
// — see main.js's createWorld). One fixed value for all species: the fish are opaque and
// depth-tested, so the depth buffer settles occlusion per pixel.
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

  // uVat: one column per model vertex, one row per baked pose. NearestFilter on both axes —
  // linear filtering along the vertex axis would blend unrelated vertices together, so
  // frame-to-frame smoothing (below) is done by hand instead. Stores each pose as an OFFSET
  // from the rest pose so it can be added back at a per-instance scale (aAmplitude).
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

    // Rest pose + VAT offset scaled by aAmplitude: 1.0 is the authored clip, 0.0 a motionless fish.
    vec3 bent = position + swim * aAmplitude;
    // Pre-instance-transform surface position, for the specular bump wobble in FRAGMENT_SHADER.
    vLocalPos = bent;

    vec4 worldPos = instanceMatrix * vec4(bent, 1.0);
    vWorldPos = worldPos.xyz;
    vWorldNormal = normalize((instanceMatrix * vec4(normal, 0.0)).xyz);

    // Darker the deeper below the surface (world Y = 0) this vertex sits.
    float depthBelowSurface = max(0.0, -worldPos.y);
    vDepthDim = max(${MIN_DEPTH_DIM}, exp(-depthBelowSurface * uDepthDarkenRate));

    // How much this vertex should blend into uFogColor (applied in the fragment shader).
    vDepthFog = 1.0 - exp(-depthBelowSurface * uDepthFogRate);

    // Single-tap caustics sample (see causticGlowAt in glsl.js) — left un-dimmed here, since depth
    // attenuation is applied in the fragment shader after the intensity curve.
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
  // Both default to 1 (a no-op) except during the fish viewer's construction reveal (inspect.js):
  // uTextureMix blends the body map toward flat grey; uHighlightsMix zeroes caustic/specular/rim.
  uniform float uTextureMix;
  uniform float uHighlightsMix;

  varying vec2 vUv;
  varying vec3 vWorldNormal;
  varying float vCausticGlow;
  varying float vOpacity;
  varying vec3 vTint;
  varying vec3 vWorldPos;
  varying vec3 vLocalPos;
  varying float vDepthDim;
  varying float vDepthFog;

  // Wobbles N by a smooth function of local-space position so the specular lobe catches a bit of
  // texture instead of one soft blob. Not a real tangent-frame bump (dFdx/dFdy): this mesh's UV
  // seams and mirrored fin back-faces make that derivative unstable — see doc.
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
    // Species tint multiplies the sampled body texture, keeping its own shading/scale detail
    // rather than flattening to a flat color. (The old per-vertex material-id branch for
    // body/eye/mouth is gone — every model is single-material now.)
    vec3 texColor = texture2D(uBodyMap, vUv).rgb;
    vec3 base = mix(vec3(0.55), texColor, uTextureMix) * vTint;

    // Single-sided material with a real mirrored back face on the fin sheets (doubleOpenSheets),
    // so every fragment already has a genuine outward normal — no front/back branch needed.
    vec3 normal = normalize(vWorldNormal);
    vec3 lightDir = normalize(uLightDir);

    // Wrapped ("half-Lambert") diffuse — deliberately gentle, since the authored skins already
    // carry their own painted countershading. See doc for the old quantized version this replaced.
    float ndl = dot(normal, lightDir) * 0.5 + 0.5;
    float lit = mix(uDiffuseFloor, uDiffuseCeil, ndl * ndl * (3.0 - 2.0 * ndl));

    // Blinn-Phong specular glint, keyed off the half-vector so it slides across the fish as the
    // camera orbits. Compiled out at the low tier along with the rim below (see quality.js).
    vec3 specular = vec3(0.0);
    vec3 sheen = vec3(0.0);
    #ifdef FISH_HIGHLIGHTS
      vec3 viewDir = normalize(cameraPosition - vWorldPos);

      // Shading LOD: 0 at the eye, 1 once fogAmount() has fully taken over — fades out the bump
      // normal and iridescence tint, both small-scale detail invisible at distance anyway.
      float detail = 1.0 - fogAmount(vWorldPos);

      // Bump-perturbed normal, used only for specular — the diffuse and rim stay on the smooth
      // per-vertex normal (see perturbNormal). Skipped once detail has nothing left to perturb.
      vec3 bumpedNormal = normal;
      if (detail > 0.02) {
        bumpedNormal = perturbNormal(normal, vLocalPos, uBumpStrength * detail);
      }
      vec3 halfDir = normalize(lightDir + viewDir);
      float specAngle = max(dot(bumpedNormal, halfDir), 0.0);

      // Schlick Fresnel on specular STRENGTH (not lobe width) — a wet dielectric flashes at
      // grazing angles rather than sitting evenly glossy. Built from multiplies, which also hands
      // the sheen term below its own ^2 for free.
      float viewFacing = 1.0 - max(dot(normal, viewDir), 0.0);
      float viewFacing2 = viewFacing * viewFacing;
      float fresnel = viewFacing2 * viewFacing2 * viewFacing;

      // Tinted toward the underwater illuminant (uCausticsColor1) rather than staying white — an
      // untinted glint on a green-lit body read as synthetic. uSpecularTint stops partway.
      vec3 specTint = mix(vec3(1.0), uCausticsColor1, uSpecularTint);
      specular = specTint * pow(specAngle, uShininess) * uSpecularStrength
        * (1.0 + fresnel * uSpecularFresnel);

      // Iridescent sheen (guanine platelets) — ADDED as light on the broader ^2 term, with hue
      // shifting warm/cool by view angle. See doc for why an earlier version (mixed into base,
      // riding the specular's ^5 Fresnel) read as a flat blue outline instead.
      vec3 sheenHue = mix(uSheenWarm, uSheenCool, viewFacing);
      sheen = sheenHue * viewFacing2 * uIridescenceStrength * detail;
    #endif

    // Caustic glow, saturated through the same softSaturate() curve terrain.js/water.js use.
    float glowSaturated = softSaturate(vCausticGlow * uCausticsStrength);

    // vDepthDim applied AFTER saturation (not folded into vCausticGlow), so the surface->depth
    // falloff stays proportional rather than getting swallowed by the saturation curve.
    // causticFacing gates the glow to top-facing normals — caustics arrive from above, so a
    // fish's belly shouldn't catch the same light net its back does (see doc for why this is
    // gated on world-up rather than uLightDir: Snell's window confines underwater sunlight to
    // ~48.6 degrees of straight down regardless of the sun's elevation above the surface).
    float causticFacing = mix(1.0, normal.y * 0.5 + 0.5, uCausticFacing);
    float glow = glowSaturated * vDepthDim * causticFacing * uHighlightsMix;

    // Two-tone caustics: the lighter tone only takes over where the glow is intense AND the fish
    // is near the surface, matching how real underwater light both dims and desaturates with depth.
    float glowNorm = clamp(glowSaturated / CAUSTIC_GLOW_CEILING, 0.0, 1.0);
    float tone = clamp(glowNorm * vDepthDim, 0.0, 1.0);
    vec3 causticsColor = mix(uCausticsColor2, uCausticsColor1, tone);

    // Rim light — the bright outline where the body turns from the eye and surface light wraps
    // around it, keeping a fish readable once the water column has gone dark.
    vec3 rimLight = vec3(0.0);
    #ifdef FISH_HIGHLIGHTS
      float rim = pow(viewFacing, uRimExponent);
      // Gated to the sun's side only, so it travels around the fish as the sun crosses the sky
      // rather than reading as a flat shader outline.
      rim *= smoothstep(-0.15, 0.55, dot(normal, lightDir));
      // Faded by distance (detail) rather than run through applyFog, so an edge highlight doesn't
      // survive out into the murk as a fish-shaped outline drawn on the haze.
      rimLight =
        uCausticsColor1 * rim * uRimStrength * vDepthDim * detail;
    #endif

    // The caustic net reaches the skin two ways: mostly it MODULATES the light already on the
    // body (so the painted pattern scales together and survives), with a small ADDED share for
    // the bright cusps themselves, which read as light sitting on the fish. See doc for why an
    // all-additive version washed the painted skins out to a pale green blob.
    float glowModulate = 1.0 + glow * uCausticsGain / CAUSTIC_GLOW_CEILING;
    vec3 color = applyFog(
      base * lit * vDepthDim * glowModulate
        + causticsColor * glow * uCausticsAdd
        + (specular + sheen) * vDepthDim * uHighlightsMix,
      vWorldPos
    );

    // Blend into the fog color AT THIS DEPTH (not uFogColor) on top of applyFog()'s camera-distance
    // blend, so a fish near the bed camouflages into the dark bottom of the column.
    color = mix(color, fogColorAt(vWorldPos), vDepthFog);

    // Rim added AFTER that blend, not into it — a fish at the bed is ~95% fog color, so a rim
    // mixed in beforehand would be erased exactly where it's needed to keep the silhouette readable.
    color += rimLight * uHighlightsMix;

    // vOpacity is a DISSOLVE toward the murk at this depth, not an alpha (the material is opaque) —
    // what the spawn/despawn fades and the distance cull all ride on, so a fish never turns see-through.
    gl_FragColor = vec4(mix(fogColorAt(vWorldPos), color, vOpacity), 1.0);
  }
`;

// Samples the mesh at `frameCount` evenly-spaced points across one cycle of the clip,
// CPU-skinning each vertex by hand (mirrors three's skinning_vertex.glsl.js chunk) and writing
// each pose as an OFFSET from `restPositions` — see doc for the non-skinned fallback.
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
  // The baked geometry can hold MORE vertices than the source mesh (mirrored fin-sheet copies —
  // see doubleOpenSheets); srcVertex maps each output vertex back to the one it's skinned from.
  const vertexCount = restPositions.count;
  const isSkinned = mesh.isSkinnedMesh && !!clip;
  const frameCount = isSkinned ? VAT_FRAME_COUNT : 1;

  const mixer = isSkinned ? new THREE.AnimationMixer(scene) : null;
  if (mixer) mixer.clipAction(clip).play();

  // Which slice of the clip's timeline one full cycle occupies — [firstKey, duration], not
  // [0, duration], since Blender's frame-1-not-0 numbering would otherwise misalign the loop
  // point by a frame (see doc for the measured steelhead example).
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

  // The real armature, baked the same way the vertices are, for the fish viewer's construction
  // reveal (src/inspect.js). See doc for how mesh.bindMatrixInverse reconciles a bone's own
  // matrixWorld path with the mesh-local space the skinned vertices are in.
  const bones = isSkinned ? mesh.skeleton.bones : [];
  const boneCount = bones.length;
  const boneParentIndex = new Int32Array(boneCount);
  for (let b = 0; b < boneCount; b++) boneParentIndex[b] = bones.indexOf(bones[b].parent);
  const boneData = new Float32Array(boneCount * frameCount * 3);
  const boneWorld = new THREE.Vector3();

  for (let f = 0; f < frameCount; f++) {
    if (isSkinned) {
      mixer.setTime(clipStart + (clipSpan * f) / frameCount);
      scene.updateMatrixWorld(true);
      mesh.skeleton.update();
    }
    for (let b = 0; b < boneCount; b++) {
      boneWorld.setFromMatrixPosition(bones[b].matrixWorld);
      boneWorld.applyMatrix4(mesh.bindMatrixInverse);
      boneWorld.applyMatrix4(worldMatrix).sub(center);
      const bo = (f * boneCount + b) * 3;
      boneData[bo] = boneWorld.x;
      boneData[bo + 1] = boneWorld.y;
      boneData[bo + 2] = boneWorld.z;
    }
    for (let i = 0; i < vertexCount; i++) {
      // Source vertex driving this output vertex — itself, unless it's a mirrored fin copy.
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

      // Stored as an offset from the rest pose, not an absolute position (see aAmplitude in
      // VERTEX_SHADER) — restPositions is already in this same transformed, recentered space.
      const o = (f * vertexCount + i) * 4;
      data[o] = world.x - restPositions.getX(i);
      data[o + 1] = world.y - restPositions.getY(i);
      data[o + 2] = world.z - restPositions.getZ(i);
      data[o + 3] = 1;
    }
  }

  // Remove any net TRANSLATION the clip carries (these are meant to be swim-in-place clips, so
  // the mean offset should be ~zero) — chinook-final.glb's clip drifted the body -2.082 along Z
  // per frame, half a body length, and this correction is what fixes it. See doc.
  let meanX = 0;
  let meanY = 0;
  let meanZ = 0;
  const sampleCount = vertexCount * frameCount;
  for (let o = 0; o < data.length; o += 4) {
    meanX += data[o];
    meanY += data[o + 1];
    meanZ += data[o + 2];
  }
  meanX /= sampleCount;
  meanY /= sampleCount;
  meanZ /= sampleCount;
  for (let o = 0; o < data.length; o += 4) {
    data[o] -= meanX;
    data[o + 1] -= meanY;
    data[o + 2] -= meanZ;
  }
  // Same correction, same reason, for the baked bone data.
  for (let o = 0; o < boneData.length; o += 3) {
    boneData[o] -= meanX;
    boneData[o + 1] -= meanY;
    boneData[o + 2] -= meanZ;
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

  return {
    texture,
    frameCount,
    vertexCount,
    bones: { positions: boneData, parentIndex: boneParentIndex, count: boneCount },
  };
}

// Placeholder body color for models with no baseColorTexture — a muted silver-olive rather than
// the flat baseColorFactor (a Blender default, not an authored color) some exports carry.
const PLACEHOLDER_BODY_COLOR = new THREE.Color(0.4, 0.42, 0.36);

// Bakes the placeholder color into a 1x1 texture so uBodyMap always has something to sample.
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

// Gives every zero-thickness sheet in `geometry` (the fins — the bodies are watertight manifolds)
// a real mirrored back face, so the material can be single-sided instead of DoubleSide, which
// on these transparent-turned-opaque fish used to draw the inside of the far body wall through
// the near one. See doc for the boundary-edge detection and the normal-mirroring math.
// Returns srcVertex: for each vertex of the result, the vertex of the ORIGINAL mesh it came from.
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

  // Every model was authored body-along-local-X; correct to body-along-Z once here rather than
  // special-casing every downstream consumer (see MODEL_ROTATION_FIX above for which rotation).
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

  // Give the open fin sheets a real back face, so the material can be single-sided.
  const srcVertex = doubleOpenSheets(geometry);

  const clip =
    gltf.animations.find((c) => c.name === "Swimming") ??
    gltf.animations[0] ??
    null;
  // geometry.attributes.position is already world-transformed, recentered, and sheet-doubled —
  // the exact rest pose the vertex shader adds the sampled offsets onto.
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

  // Each vertex's own row index into the VAT — gl_VertexID isn't available in WebGL1.
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

// Loads every distinct GLB referenced by SPECIES_MODEL_URL (species sharing a URL only fetch/bake
// it once) and resolves to a Map<url, assets> for createFishInstancedMesh.
export function loadFishAssets() {
  if (!cachedLoad) {
    const urls = [...new Set(Object.values(SPECIES_MODEL_URL))];
    cachedLoad = Promise.all(
      urls.map((url) => loadSpeciesModel(url).then((assets) => [url, assets])),
    ).then((entries) => new Map(entries));
  }
  return cachedLoad;
}

// Builds one species' InstancedMesh + its update/setBounds/setSeason closures — same
// shader/uniform setup regardless of which model backs it, scoped to this model's baked assets.
function buildSpeciesRenderer({ geometry, modelLength, texture, vat }, maxCount, modelUrl) {
  const phase = new Float32Array(maxCount);
  const cyclePos = new Float32Array(maxCount);
  const opacity = new Float32Array(maxCount);
  const amplitude = new Float32Array(maxCount);
  const tint = new Float32Array(maxCount * 3);

  // Rewritten in full every frame, so flagged DynamicDrawUsage (default StaticDrawUsage assumes
  // an upload-once buffer).
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
    // Blinn-Phong glint — shininess controls highlight size, strength its peak brightness.
    // Moderate shininess avoids a noisy/aliased pinprick hotspot on this low-poly mesh; the wet
    // look is bought with uSpecularFresnel below instead of tightening the lobe further.
    uShininess: { value: 24 },
    uSpecularStrength: { value: 0.5 },
    // How far the specular glint is tinted toward the underwater illuminant instead of white.
    uSpecularTint: { value: 0.55 },
    // How much harder the specular fires at grazing angles (Schlick Fresnel). The GLB's own
    // metallicFactor/roughnessFactor aren't read; shine is tuned here and nowhere else.
    uSpecularFresnel: { value: 2.0 },
    // How strongly the caustic glow follows "up" — 0 lights the belly as brightly as the back,
    // 1 takes the belly fully dark. Held below 1 for scattered light off the riverbed.
    uCausticFacing: { value: 0.85 },
    // Rim/edge light — exponent sets how far in from the silhouette it reaches, strength how
    // bright. The exponent has to stay tight: the rim is the only term that survives at full
    // strength in the near field (fogAmount() ~0 there), so a broad band would read as the
    // school glowing rather than backlit.
    uRimStrength: { value: 0.45 },
    uRimExponent: { value: 5.0 },
    // Fake scale-bump normal detail for the specular lobe only (not the diffuse or rim, which
    // stay smooth). uScaleFrequency is in cycles per local-space unit (~4.76-unit body — see
    // swim_rig.py), not UV cycles, so it stays stable across UV seams; retune via inspect.html.
    uBumpStrength: { value: 0.22 },
    uScaleFrequency: { value: 12 },
    // Wrapped-diffuse range, kept narrow — the authored skins already carry their own
    // countershading, so this only has to say where the sun is.
    uDiffuseFloor: { value: 0.7 },
    uDiffuseCeil: { value: 1.1 },
    // The iridescent sheen's angle-dependent hue ramp: warm where the flank faces the eye, cool
    // where it turns away. Added as light, never mixed into the skin.
    uSheenWarm: { value: new THREE.Color("#ffd9a8") },
    uSheenCool: { value: new THREE.Color("#8fb8ff") },
    uIridescenceStrength: { value: 0.06 },
    // 1 everywhere except the fish viewer's construction reveal (see FRAGMENT_SHADER).
    uTextureMix: { value: 1 },
    uHighlightsMix: { value: 1 },
    // Pushed by setCausticsTexture()/setBounds()/setSeason() before the first frame; these
    // placeholders only exist so the material has something to compile against.
    uCaustics: { value: null },
    uTime: { value: 0 },
    uWorldSize: { value: new THREE.Vector2(1, 1) },
    uMargin: { value: new THREE.Vector2(0, 0) },
    uCausticsColor1: { value: new THREE.Color("#5cc594") },
    uCausticsColor2: { value: new THREE.Color("#123b28") },
    uCausticsStrength: { value: FISH_CAUSTICS_STRENGTH },
    // The modulate/additive caustic split (see FRAGMENT_SHADER) — uCausticsAdd is kept small on
    // purpose, since it's the term that flattens the painted pattern.
    uCausticsGain: { value: 0.95 },
    uCausticsAdd: { value: 0.25 },
    uFogColor: { value: FOG_COLOR },
    uFogDensity: { value: 0 },
    uFogDepthRate: { value: 0 },
    uDepthDarkenRate: { value: 0 },
    uDepthFogRate: { value: 0 },
  };

  // Layer this model's own tuning over the shared defaults. Scalar overrides only — a typo in
  // MATERIAL_OVERRIDES throws a TypeError at build time rather than silently doing nothing.
  for (const [name, value] of Object.entries(MATERIAL_OVERRIDES[modelUrl] ?? {})) {
    uniforms[name].value = value;
  }

  const material = new THREE.ShaderMaterial({
    uniforms,
    // A define, not a uniform, so the low tier never compiles the specular/rim pow() calls at
    // all rather than just multiplying the result by zero (see quality.js).
    defines: QUALITY.fishHighlights ? { FISH_HIGHLIGHTS: "" } : {},
    vertexShader: vertexShader(),
    fragmentShader: FRAGMENT_SHADER,
    // OPAQUE, with real depth — the only material in the scene that draws one. Used to be
    // transparent, which bought nothing (distance falloff and the spawn/despawn/cull fades all
    // dissolve toward the fog color as a COLOUR now, not alpha) and cost a lot: a see-through
    // fish showed its own far wall through its near one, and with nothing writing depth, draw
    // order was the only thing deciding occlusion — see doc for the sort/ranking machinery this
    // replaced.
    transparent: false,
    // On, now that the fish are opaque — this is what sorts them against each other and the rest
    // of the scene. It was off while transparent (a depth-writing transparent instance still
    // writes depth at opacity ~0, punching a hole through mid-fade); every other material in the
    // scene keeps depthWrite off and relies on renderOrder instead (terrain 0, water 1, silt/
    // shafts 3 — see createWorld in main.js), since those really are translucent.
    depthWrite: true,
    depthTest: true,
    // Single-sided, safe now that the fin sheets carry a real mirrored back face (doubleOpenSheets)
    // instead of relying on DoubleSide, which used to draw the inside of the far body wall through
    // the near one on these (formerly transparent) fish.
    side: THREE.FrontSide,
  });

  const mesh = new THREE.InstancedMesh(geometry, material, maxCount);
  mesh.name = "fish";
  mesh.frustumCulled = false; // instances span the whole river; per-instance culling isn't worth it here
  mesh.renderOrder = FISH_RENDER_ORDER_BASE;
  // Rewritten every frame, same as the per-instance attributes above — but three allocates this
  // one itself and leaves it static by default.
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);

  // Depth range fish swim within, and the world->sim UV mapping for the caustics read. Both
  // change only on resize; setBounds() below pushes them.
  let surfaceY = 0;
  let floorY = 0;

  // Distance-cull band in world XZ around the camera, squared so the per-fish test needs no sqrt
  // unless it's actually inside the fade band. Camera position is written by
  // createFishInstancedMesh's partition pass into each fish's `_camDistSq`, once for the whole
  // flock, rather than recomputed here per species.
  let fadeStart = Infinity;
  let fadeEnd = Infinity;
  let fadeStartSq = Infinity;
  let fadeEndSq = Infinity;

  // Flags an instanced attribute for upload of just its first `instances` entries. three's update
  // ranges are in array elements, hence the itemSize multiply.
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
  // Forward/travel axis — rolling about this (see noseOffsetLocal below) banks the body without
  // touching heading.
  const eulerZ = new THREE.Vector3(0, 0, 1);
  const scaleVec = new THREE.Vector3();

  // Nose-first turning: the geometry is centered on the model's bbox center, so a heading turn
  // rotated straight around that point would pinwheel the whole body instead of pivoting near
  // the head. noseOffsetLocal is the nose's position relative to that center; each frame it's
  // rotated by the fish's current heading/pitch and subtracted from the boid's tracked point so
  // that point lands on the nose, then the mesh is placed from there. See doc.
  const noseOffsetLocal = new THREE.Vector3(0, 0, modelLength / 2);
  const noseOffsetWorld = new THREE.Vector3();
  const centerPos = new THREE.Vector3();

  // Writes the visible fish's transform + swim-phase attributes for this frame. `n` (the write
  // cursor) runs ahead of the loop index since culled fish (see CULL_FADE_*) must not leave a
  // hole in the dense instance range. `dt` is the same simulated-time step main.js hands
  // flock.step(), in 60fps-frame units — required, not optional, since the tailbeat/pitch below
  // are accumulated per call (see doc for the desync bug this fixed). `playing` only scales the
  // tailbeat (beatScale) — everything else is already frozen upstream via the sim clock.
  function update(fish, t, playing = true, dt = 1) {
    const beatScale = playing ? 1 : PAUSED_SWIM_RATE;
    // Pitch easing stops dead on pause, unlike the tailbeat which deliberately keeps ticking.
    const simDt = playing ? dt : 0;
    // Seconds, matching every other consumer of the procedural caustics; `t` is in milliseconds.
    uniforms.uTime.value = t * 0.001;

    let n = 0;

    // Overflow drops from the FAR end (fish is sorted farthest-first), not the near one — the
    // old i=0..maxCount shape silently discarded the closest, most on-screen fish instead. Never
    // actually triggers with the population cap honoured (see rebuildDayTables in main.js).
    for (let i = Math.max(0, fish.length - maxCount); i < fish.length; i++) {
      const f = fish[i];

      // Cheap reject before any quaternion/matrix work — distance was computed once for the
      // whole flock by createFishInstancedMesh's partition pass.
      const distSq = f._camDistSq;
      if (distSq >= fadeEndSq) continue;

      let visibility = f.opacity;
      if (distSq > fadeStartSq) {
        visibility *=
          1 - (Math.sqrt(distSq) - fadeStart) / (fadeEnd - fadeStart);
      }

      // Rendered nose-to-tail length in world units.
      const bodyLength = f.length * BODY_VISUAL_SCALE;

      const heading = Math.atan2(f.vx, f.vy);
      quaternion.setFromAxisAngle(eulerY, heading);

      // Nose-up/nose-down toward the current depth-drift target, LOW-PASSED rather than taken
      // raw — depthTarget jumps discontinuously every 90-240 frames (see boids.js), and easing
      // toward it instead of snapping is what stopped the school reading as stuttering. The
      // clamp stays on the target, not the eased value, so the range is unchanged.
      const targetPitch = Math.max(
        -0.2,
        Math.min(0.2, (f.depthTarget - f.depth) * 6),
      );
      f.pitch += (targetPitch - f.pitch) * Math.min(1, PITCH_SMOOTHING * simDt);
      pitchQuat.setFromAxisAngle(eulerX, f.pitch);
      quaternion.multiply(pitchQuat);

      const s = bodyLength / modelLength;
      scaleVec.set(s, s, s);

      // Tailbeat rate, derived from how fast this fish is actually moving (see STRIDE_LENGTH).
      const beatsPerStep = f.smoothSpeed / (bodyLength * STRIDE_LENGTH);
      const clampedBeats = Math.min(
        MAX_BEATS_PER_STEP,
        Math.max(MIN_BEATS_PER_STEP, beatsPerStep),
      );
      // Scaled by dt, for the same reason flock.step() is — without it, stride length comes out
      // wrong on any non-60Hz display and frame-time jitter desyncs the tail from the motion. See
      // doc.
      const advance = clampedBeats * f.swimRate * dt;
      // Wrapped into [0, 1) rather than left to accumulate, since the shader only reads fract() —
      // an unbounded integer part would eventually eat the float32 mantissa's precision.
      f.swimCyclePos = (f.swimCyclePos + advance * beatScale) % 1;

      // Bank opposite the tail's lateral sweep (see ROLL_AMPLITUDE). rollActivity renormalizes
      // clampedBeats so an idling fish holds level instead of banking on a barely-moving tail.
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

    // Upload only the `n` instances actually drawn, not all `capacity` slots — a bare
    // `needsUpdate = true` would re-upload the entire backing buffer every frame regardless of
    // how many fish are on screen. The loop above fills slots 0..n densely, so one update range
    // covers exactly the live data.
    uploadRange(mesh.instanceMatrix, n);
    uploadRange(geometry.attributes.aPhase, n);
    uploadRange(geometry.attributes.aCyclePos, n);
    uploadRange(geometry.attributes.aOpacity, n);
    uploadRange(geometry.attributes.aAmplitude, n);
    uploadRange(geometry.attributes.aTint, n);
  }

  // Everything the fish shaders derive from the world's dimensions, changes only on resize, so
  // it's pushed here (from main.js's createWorld) rather than recomputed in update() every frame.
  // Takes no camera — the cull band's radii are a function of bounds alone; the measuring point
  // is held one level up in createFishInstancedMesh (see its setBounds).
  function setBounds(bounds, causticsSize, depthRange) {
    surfaceY = depthRange.surfaceY;
    floorY = depthRange.floorY;

    // Cull band converted from fog units to world units (vertical distance ignored — XZ
    // dominates). Boosted by FISH_FOG_DISTANCE_BOOST, matching the boosted rate pushed to the
    // shader below, so the cull band lines up with where this renderer's fog has actually
    // camouflaged a fish.
    const density = fogDensity(bounds) * FISH_FOG_DISTANCE_BOOST;
    fadeStart = CULL_FADE_START_FOG / density;
    fadeEnd = CULL_FADE_END_FOG / density;
    fadeStartSq = fadeStart * fadeStart;
    fadeEndSq = fadeEnd * fadeEnd;
    // The CAUSTICS pass's own coverage — the only thing this shader samples world XZ against.
    uniforms.uWorldSize.value.set(causticsSize.width, causticsSize.height);
    uniforms.uMargin.value.set(causticsSize.marginX, causticsSize.marginZ);
    uniforms.uFogDensity.value = density;
    uniforms.uFogDepthRate.value = fogDepthRate(bounds);
    uniforms.uDepthDarkenRate.value = depthDarkenRate(bounds);
    uniforms.uDepthFogRate.value = depthFogRate(bounds);
  }

  // The caustics accumulation target is cleared/re-rendered in place each frame, so the texture
  // object is stable — bound once rather than re-assigned per frame.
  function setCausticsTexture(causticsTexture) {
    uniforms.uCaustics.value = causticsTexture;
  }

  // Ties the two-tone caustic glow to the same season driving the sky/sun/water surface.
  function setSeason(dayOfYear) {
    const season = seasonForDay(dayOfYear);
    uniforms.uCausticsColor1.value.copy(season.causticsColor1);
    uniforms.uCausticsColor2.value.copy(season.causticsColor2);
  }

  // Already refracted by the caller — fish are underwater, lit by the sun's Snell's-window
  // direction, not the above-surface direction sceneSetup/godRays are handed.
  function setSunDirection(refracted) {
    uniforms.uLightDir.value.copy(refracted);
  }

  // Releases only what this renderer owns — NOT the geometry/texture/VAT, which come from the
  // shared per-URL asset and are reused by whatever renderer is built next on a tier change.
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

// Groups the DART species by which GLB backs them and builds one InstancedMesh per distinct
// model. Every renderer is sized to `capacity` — the whole population plus fade headroom, not a
// per-species share — because a single-species day (2015's Chinook peak is nearly one) can
// legitimately put every fish on one renderer; see doc for the waste/guarantee tradeoff.
export function createFishInstancedMesh(assetsByUrl, capacity) {
  const speciesByUrl = new Map();
  for (const [species, url] of Object.entries(SPECIES_MODEL_URL)) {
    if (!speciesByUrl.has(url)) speciesByUrl.set(url, []);
    speciesByUrl.get(url).push(species);
  }

  const group = new THREE.Group();
  group.name = "fish";

  // Each entry pairs a species renderer with a reusable (never reallocated) bucket array `update`
  // partitions the live flock into.
  const renderers = [];
  // Which renderer draws a given species — a Map rather than a find(), since the partition below
  // runs ~1200 times a frame.
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

  // Splits the live flock by species into each renderer's bucket, writing each fish's squared
  // camera-XZ distance along the way (see _camDistSq) since it's already walking the whole flock.
  // No capacity guard here — the per-renderer update() clamps from the far end instead (see doc).
  function update(fish, t, playing = true, dt = 1) {
    for (const r of renderers) r.bucket.length = 0;
    for (const f of fish) {
      const dx = f.x - camX;
      const dz = f.y - camZ;
      f._camDistSq = dx * dx + dz * dz;
      const r = rendererBySpecies.get(f.species);
      if (r) r.bucket.push(f);
    }
    // `playing` and `dt` must be forwarded, not just accepted — this is the only caller of the
    // per-renderer update(), so anything dropped here falls back to that function's defaults.
    for (const r of renderers) r.update(r.bucket, t, playing, dt);
  }

  // Where the per-fish `_camDistSq` is measured from. The camera is fixed (see sceneSetup.js) and
  // only re-framed on resize, so this belongs on setBounds' cadence, not the per-frame one.
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

  // Takes the same above-water sun every other consumer in main.js gets, and refracts it once
  // here rather than per renderer.
  function setSunDirection(sun) {
    const refracted = refractedSunDirection(sun, _fishSun);
    for (const r of renderers) r.setSunDirection(refracted);
  }

  // Instances actually drawn last frame, summed across renderers — the flock minus what the
  // distance cull dropped. Only read by main.js's debug panel.
  function renderedCount() {
    let n = 0;
    for (const r of renderers) n += r.mesh.count;
    return n;
  }

  // The material actually drawing a given species, for callers (inspect.js) that need to tune
  // one model's uniforms without flattening the per-species MATERIAL_OVERRIDES on every other
  // species back to a shared set.
  function materialForSpecies(species) {
    return rendererBySpecies.get(species)?.mesh.material ?? null;
  }

  // The actual InstancedMesh drawing a given species, as opposed to `mesh` (the Group holding all
  // of them) — inspect.js's anatomy overlay needs this for getMatrixAt(), which Group lacks.
  function meshForSpecies(species) {
    return rendererBySpecies.get(species)?.mesh ?? null;
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
    meshForSpecies,
    dispose,
  };
}
