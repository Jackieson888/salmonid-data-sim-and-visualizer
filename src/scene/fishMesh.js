// fishMesh.js
// Loads the steelhead-updated.glb model (a single skinned mesh + a
// spine-bone swim clip), bakes that clip into a Vertex Animation Texture
// (VAT) at load time, and renders the whole flock as one InstancedMesh.
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
// shape doesn't have, so main.js caps population per-species (not just in
// total) to keep it affordable rather than letting one overwhelming species
// day try to render thousands of these.
//
// bakeVertexAnimationTexture() below falls back to a single static frame
// whenever mesh.isSkinnedMesh is false (no JOINTS_0/WEIGHTS_0, mesh not
// parented to its armature — see git history for when steelhead-updated.glb
// needed that fix) or no clip is found, so a future re-export that drops
// skinning silently degrades to a non-swimming fish instead of erroring.
//
// The clip is looked up by exact name "Swimming" first, falling back to
// gltf.animations[0]; this export's clip is actually named "Swimming.005"
// (Blender's auto-suffix from stray duplicate actions in the source file),
// so it's currently riding the animations[0] fallback, not the name match.
//
// Fish also pick up the same causticGlow() read the terrain/water use (see
// causticsChunk.js), sampled at each vertex's world XZ position, so a fish
// swimming through a bright patch of the water's light net visibly glints —
// the fish read as sitting *in* the water instead of pasted over it.
//
// Species models: SPECIES_MODEL_URL (below) maps each of the four DART
// species (see data.js — Chinook/Jack Chinook/Steelhead/Shad) to a GLB.
// Species that share a URL (currently jackChinook/shad, both still riding
// the steelhead placeholder) are drawn from one shared InstancedMesh and
// told apart only by a flat per-instance color multiply (aTint). A species
// with its own distinct URL (steelhead, chinook) gets its own InstancedMesh
// built from its own geometry/VAT/texture (see createFishInstancedMesh) and
// an identity tint, since its model already looks like that species.

import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { CAUSTIC_GLOW_GLSL } from "./causticsChunk.js";
import { FOG_GLSL, FOG_COLOR, fogDensity } from "./fog.js";
import { riverDepth } from "./terrain.js";
import { seasonForDay } from "./season.js";

const SPECIES_MODEL_URL = {
  steelhead: "/steelhead-updated.glb",
  chinook: "/chinook.glb",
  jackChinook: "/steelhead-updated.glb", //placeholder until a jack-chinook model exists
  shad: "/shad.glb",
};

// Per-model fixup rotation, folded into worldMatrix in loadSpeciesModel
// below, so every model's baked geometry ends up nose-along-+Z the way
// modelLength/noseOffsetLocal (createFishInstancedMesh) assume — which
// correction that takes depends on *where* the source file's rig put its
// compensating rotation, not just which raw local axis the body runs along:
//
// steelhead-updated.glb's root bone sits directly under an ancestor
// "Armature" node that itself carries a rotation, which mesh.matrixWorld
// (an ordinary node-hierarchy transform) picks up — so a plain X-axis
// quarter turn on top of that is enough to land body-along-Z.
//
// chinook.glb's compensating rotation instead lives on its root *bone* —
// part of the animated skin chain, not an ancestor of the mesh node — so it
// cancels out against that bone's own inverse-bind matrix at rest instead
// of ever reaching mesh.matrixWorld. Left uncorrected, the baked mesh keeps
// its raw local axes (body along X, dorsal fin along Y), so it needs a
// Y-axis (not X-axis) quarter turn: rotating about Y moves the long body
// axis onto Z while leaving Y — already the correct up axis — untouched,
// where an X-axis turn (right for steelhead) would instead swap the body's
// height into the depth axis.
const MODEL_ROTATION_FIX = {
  "/steelhead-updated.glb": new THREE.Matrix4().makeRotationX(Math.PI * -0.5),
  "/chinook.glb": new THREE.Matrix4().makeRotationY(Math.PI * 0.5),
  "/shad.glb": new THREE.Matrix4().makeRotationX(Math.PI * -0.5),
};

// Flat per-instance tint for each of the four DART species (see data.js),
// multiplied into the sampled body texture in the fragment shader below.
// Steelhead and chinook are identity (1,1,1) — each has its own model (see
// SPECIES_MODEL_URL) that already looks like that species, no recolor
// needed — jackChinook/shad are still riding the steelhead placeholder
// model, so they get a bright, unmissable tint to read as distinct from it.
const SPECIES_COLORS = {
  steelhead: new THREE.Color(1, 1, 1),
  chinook: new THREE.Color(1, 1, 1),
  jackChinook: new THREE.Color("#ff8c1a"),
  shad: new THREE.Color(1, 1, 1),
};
const DEFAULT_COLOR = SPECIES_COLORS.steelhead;

// Fragment shader matches vertex-shader matId literally (0 = body, 1 = eye,
// 2 = mouth) — kept generic in case a future export adds material groups
// back, though this single-material glb tags every vertex 0 (body).
const EYE_COLOR = new THREE.Color(0.04, 0.04, 0.05);
const MOUTH_COLOR = new THREE.Color(0.690196, 0.67451, 0.694118);

// Poses sampled across one loop of the baked "Swimming" clip. 30 is plenty
// for a low-poly fish with linear interpolation between rows in the shader.
const VAT_FRAME_COUNT = 30;

// Converts a per-frame delta time (ms) and the fish's live sim speed into a
// clip-loops increment, accumulated per-fish frame-over-frame in update()
// below (f.swimCyclePos) rather than recomputed from absolute time each
// frame — recomputing as `uTime * rate * currentSpeed` made the sampled VAT
// frame jump every time currentSpeed changed (worse the longer uTime had
// been running), which read as stutter whenever a fish sped up or slowed
// down. Accumulating avoids that: a change in speed only changes the rate
// future increments are added at, never retroactively re-scales elapsed
// time. A per-fish aPhase (radians, see boids.js wobblePhase) is added on
// top as a fixed offset so fish swimming at the same speed still don't
// lock-step.
const SWIM_CYCLE_RATE = 0.0012 / (2 * Math.PI);
const PHASE_TO_CYCLE = 1 / (2 * Math.PI);

// Fish are drawn at roughly this multiple of their (2D-sim) `length` value,
// matching the visual scale the old sprite used (fish.length * 2.8 tall).
const VISUAL_SCALE = 2.4;

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
  ${CAUSTIC_GLOW_GLSL}

  attribute float aMatId;
  attribute float aVertexIndex;
  attribute float aPhase;
  attribute float aCyclePos;
  attribute float aOpacity;
  attribute vec3 aTint;

  uniform sampler2D uVat;
  uniform float uVatFrameCount;
  uniform float uVatVertexCount;
  uniform sampler2D uWater;
  uniform vec2 uWorldSize;
  uniform vec2 uMargin;
  uniform vec2 uTexel;
  uniform float uDepthDarkenRate;
  uniform float uDepthFogRate;

  varying vec2 vUv;
  varying float vMatId;
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
  vec3 sampleVat(float frame) {
    vec2 uv = vec2(
      (aVertexIndex + 0.5) / uVatVertexCount,
      (mod(frame, uVatFrameCount) + 0.5) / uVatFrameCount
    );
    return texture2D(uVat, uv).xyz;
  }

  void main() {
    vUv = uv;
    vMatId = aMatId;
    vOpacity = aOpacity;
    vTint = aTint;

    float cycles = aCyclePos + aPhase * ${PHASE_TO_CYCLE};
    float frameF = fract(cycles) * uVatFrameCount;
    float frame0 = floor(frameF);
    vec3 bent = mix(sampleVat(frame0), sampleVat(frame0 + 1.0), frameF - frame0);

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

    // Same causticGlow() read terrain.js/water.js use, sampled at this
    // vertex's world position — one read per vertex (cheaper than per
    // fragment, and plenty smooth at the fish's screen size). uWorldSize/
    // uMargin match water.js's waterWorldSize() — the sim covers a bigger,
    // bounds-centered area, not just the raw bounds (see main.js). Left
    // un-dimmed here — depth attenuation is applied in the fragment shader
    // *after* the intensity curve (see FRAGMENT_SHADER) so it stays visible
    // instead of getting swallowed by saturation at high uCausticsStrength.
    vec2 waterUv = (worldPos.xz + uMargin) / uWorldSize;
    vCausticGlow = causticGlow(uWater, waterUv, uTexel);

    vec4 mvPosition = modelViewMatrix * worldPos;
    gl_Position = projectionMatrix * mvPosition;
  }
`;

const FRAGMENT_SHADER = /* glsl */ `
  ${FOG_GLSL}

  uniform sampler2D uBodyMap;
  uniform vec3 uEyeColor;
  uniform vec3 uMouthColor;
  uniform vec3 uLightDir;
  uniform vec3 uCausticsColor1;
  uniform vec3 uCausticsColor2;
  uniform float uCausticsStrength;
  uniform float uShininess;
  uniform float uSpecularStrength;

  varying vec2 vUv;
  varying float vMatId;
  varying vec3 vWorldNormal;
  varying float vCausticGlow;
  varying float vOpacity;
  varying vec3 vTint;
  varying vec3 vWorldPos;
  varying float vDepthDim;
  varying float vDepthFog;

  void main() {
    vec3 base;
    if (vMatId < 0.5) {
      // Species tint (see SPECIES_COLORS in fishMesh.js) multiplies the
      // sampled body texture — steelhead's tint is identity (1,1,1) so it's
      // unaffected, the other three species recolor while keeping the
      // texture's own shading/scale detail instead of flattening to a flat
      // color.
      base = texture2D(uBodyMap, vUv).rgb * vTint;
    } else if (vMatId < 1.5) {
      base = uEyeColor;
    } else {
      base = uMouthColor;
    }

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
    // Soft-saturates toward 1.4 instead of hard-clamping: the live water
    // sim's curvature spikes frame to frame, and a hard min() turns "just
    // under the cap" and "just over it" into a visible on/off pop every
    // time a spike crosses that line. This curve's slope shrinks as it
    // approaches the cap, so the same spike lands as a much smaller,
    // smoother change in brightness instead of a flicker.
    float glowStrength = vCausticGlow * uCausticsStrength;
    float glowSaturated = 1.4 * glowStrength / (glowStrength + 1.4);

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
    float glowNorm = clamp(glowSaturated / 1.4, 0.0, 1.0);
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

// Samples the mesh at `frameCount` evenly-spaced points across the clip's
// duration, CPU-skinning each vertex by hand (mirrors three's
// skinning_vertex.glsl.js chunk: bindMatrix -> weighted bone matrices ->
// bindMatrixInverse) and writes the result into a (vertexCount x
// frameCount) float texture. If the mesh isn't actually skinned (see the
// NOTE at the top of this file), frameCount collapses to 1 and every "pose"
// is just the mesh's own static, world-transformed position — fish render
// but don't swim, with no special-casing needed elsewhere.
function bakeVertexAnimationTexture(scene, mesh, clip, worldMatrix, center) {
  const posAttr = mesh.geometry.attributes.position;
  const vertexCount = posAttr.count;
  const isSkinned = mesh.isSkinnedMesh && !!clip;
  const frameCount = isSkinned ? VAT_FRAME_COUNT : 1;

  const mixer = isSkinned ? new THREE.AnimationMixer(scene) : null;
  if (mixer) mixer.clipAction(clip).play();

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
      mixer.setTime((clip.duration * f) / frameCount);
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

      const o = (f * vertexCount + i) * 4;
      data[o] = world.x;
      data[o + 1] = world.y;
      data[o + 2] = world.z;
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
  const vat = bakeVertexAnimationTexture(
    gltf.scene,
    mesh,
    clip,
    worldMatrix,
    center,
  );

  geometry.deleteAttribute("skinIndex");
  geometry.deleteAttribute("skinWeight");

  // Single-material model (no separate eye/mouth groups like the old OBJ
  // had) — every vertex is body; vMatId/EYE_COLOR/MOUTH_COLOR stay in the
  // fragment shader in case a future export adds material groups back.
  const vertexIndex = new Float32Array(vertexCount);
  const matIds = new Float32Array(vertexCount);
  for (let i = 0; i < vertexCount; i++) vertexIndex[i] = i;
  geometry.setAttribute(
    "aVertexIndex",
    new THREE.Float32BufferAttribute(vertexIndex, 1),
  );
  geometry.setAttribute("aMatId", new THREE.Float32BufferAttribute(matIds, 1));

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

// Builds one species' InstancedMesh + its update/setSeason closures — same
// shader/uniform setup regardless of which model backs it, just scoped to
// the geometry/texture/vat this particular model baked. `maxCount` is this
// mesh's own instance capacity, not the whole flock's.
function buildSpeciesRenderer(
  { geometry, modelLength, texture, vat },
  maxCount,
  waterSimSize,
  bounds,
) {
  const phase = new Float32Array(maxCount);
  const cyclePos = new Float32Array(maxCount);
  const opacity = new Float32Array(maxCount);
  const tint = new Float32Array(maxCount * 3);
  geometry.setAttribute("aPhase", new THREE.InstancedBufferAttribute(phase, 1));
  geometry.setAttribute(
    "aCyclePos",
    new THREE.InstancedBufferAttribute(cyclePos, 1),
  );
  geometry.setAttribute(
    "aOpacity",
    new THREE.InstancedBufferAttribute(opacity, 1),
  );
  geometry.setAttribute("aTint", new THREE.InstancedBufferAttribute(tint, 3));

  const uniforms = {
    uVat: { value: vat.texture },
    uVatFrameCount: { value: vat.frameCount },
    uVatVertexCount: { value: vat.vertexCount },
    uBodyMap: { value: texture },
    uEyeColor: { value: EYE_COLOR },
    uMouthColor: { value: MOUTH_COLOR },
    uLightDir: { value: new THREE.Vector3(0.4, 1, 0.25).normalize() },
    // Blinn-Phong glint (see FRAGMENT_SHADER) — shininess controls how
    // tight/small the highlight is, strength how bright it gets at its
    // peak. Moderate shininess keeps it a soft glint rather than a pinprick
    // hotspot, which reads as noisy/aliased on a mesh this low-poly.
    uShininess: { value: 20 },
    uSpecularStrength: { value: 0.5 },
    uWater: { value: null },
    uWorldSize: { value: new THREE.Vector2(1, 1) }, // real size arrives via update() each frame
    uMargin: { value: new THREE.Vector2(0, 0) }, // ditto
    uTexel: { value: new THREE.Vector2(1 / waterSimSize, 1 / waterSimSize) },
    uCausticsColor1: { value: new THREE.Color("#5cc594") },
    uCausticsColor2: { value: new THREE.Color("#123b28") },
    uCausticsStrength: { value: 130 },
    uFogColor: { value: FOG_COLOR },
    uFogDensity: { value: fogDensity(bounds) },
    uDepthDarkenRate: { value: depthDarkenRate(bounds) },
    uDepthFogRate: { value: depthFogRate(bounds) },
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

  const matrix = new THREE.Matrix4();
  const quaternion = new THREE.Quaternion();
  const pitchQuat = new THREE.Quaternion();
  const eulerY = new THREE.Vector3(0, 1, 0);
  const eulerX = new THREE.Vector3(1, 0, 0);
  const scaleVec = new THREE.Vector3();

  // The geometry is centered on the model's bounding-box center (see
  // loadFishModel), so a heading turn rotated straight around that point
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

  // Real elapsed ms between update() calls, used to accumulate each fish's
  // swim-cycle position (see SWIM_CYCLE_RATE above) — null on the first
  // call, when there's no previous frame to measure from.
  let lastT = null;

  // Writes every living fish's transform + swim-phase attributes for this
  // frame. `fish` is the live flock.fish array — dense (no holes), so
  // instance index i always means "the i-th currently-alive fish", never
  // a stale slot. Horizontal motion (x, y -> world x, z) is the flock's
  // real swim; f.depth (0 = surface .. 1 = riverbed, see boids.js) is a
  // slow, independent secondary drift mapped into the surfaceY..floorY
  // range, with a small wobble and a slight pitch toward whichever way
  // that drift is currently heading so it still reads as swimming rather
  // than an elevator.
  function update(fish, t, depthRange, waterSize, waterTexture, bounds) {
    const { surfaceY, floorY } = depthRange;
    const dt = lastT === null ? 0 : Math.max(0, t - lastT);
    lastT = t;
    const count = Math.min(fish.length, maxCount);
    for (let i = 0; i < count; i++) {
      const f = fish[i];
      const swimSpeed = Math.hypot(f.vx, f.vy);
      const heading = Math.atan2(f.vx, f.vy);
      quaternion.setFromAxisAngle(eulerY, heading);

      const depthDelta = f.depthTarget - f.depth;
      const pitch = Math.max(-0.2, Math.min(0.2, depthDelta * 6));
      pitchQuat.setFromAxisAngle(eulerX, pitch);
      quaternion.multiply(pitchQuat);

      const s = (f.length * VISUAL_SCALE) / modelLength;
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
      // Ties tailbeat rate to how fast the fish is actually swimming (see
      // boids.js flowWeight/maxSpeed) instead of a fixed per-fish random
      // rate, so fish visibly beat their tails faster when cruising quickly
      // and slower when drifting — same knob a faster/slower migration day
      // (main.js applyDaySpeed) already turns. Accumulated frame-over-frame
      // (rather than recomputed as elapsed-time * currentSpeed) so a change
      // in speed changes the rate future frames accumulate at instead of
      // retroactively rescaling all elapsed time, which was previously
      // popping the sampled VAT frame — visible as stutter — every time a
      // fish accelerated or decelerated.
      f.swimCyclePos = (f.swimCyclePos || 0) + dt * SWIM_CYCLE_RATE * swimSpeed;
      cyclePos[i] = f.swimCyclePos;
      opacity[i] = f.opacity;
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
    geometry.attributes.aTint.needsUpdate = true;

    // The water sim's ping-pong texture swaps every frame, and waterSize/
    // bounds can change on resize — all refreshed here rather than wired
    // through a separate setter, since update() already runs once per frame.
    uniforms.uWater.value = waterTexture;
    uniforms.uWorldSize.value.set(waterSize.width, waterSize.height);
    uniforms.uMargin.value.set(waterSize.marginX, waterSize.marginZ);
    uniforms.uFogDensity.value = fogDensity(bounds);
    uniforms.uDepthDarkenRate.value = depthDarkenRate(bounds);
    uniforms.uDepthFogRate.value = depthFogRate(bounds);
  }

  // Ties the two-tone caustic glow (see FRAGMENT_SHADER above) to the same
  // season driving the sky/sun and water surface (see sceneSetup.js/
  // water.js) — called from main.js whenever the displayed date changes.
  function setSeason(dayOfYear) {
    const season = seasonForDay(dayOfYear);
    uniforms.uCausticsColor1.value.copy(season.causticsColor1);
    uniforms.uCausticsColor2.value.copy(season.causticsColor2);
  }

  return { mesh, update, setSeason };
}

// Groups the four DART species by which GLB backs them (see
// SPECIES_MODEL_URL) and builds one InstancedMesh per distinct model —
// jackChinook/shad currently share the steelhead placeholder and are drawn
// from a single shared mesh (as before, told apart by aTint), while
// steelhead and chinook each get their own mesh built from their own
// geometry/VAT/texture. `maxPerSpecies` is the per-species cap (see
// MAX_PER_SPECIES in main.js); a shared mesh's capacity scales with how
// many species are riding it so none of them get starved for room.
export function createFishInstancedMesh(
  assetsByUrl,
  maxPerSpecies,
  waterSimSize,
  bounds,
) {
  const speciesByUrl = new Map();
  for (const [species, url] of Object.entries(SPECIES_MODEL_URL)) {
    if (!speciesByUrl.has(url)) speciesByUrl.set(url, []);
    speciesByUrl.get(url).push(species);
  }

  const group = new THREE.Group();
  group.name = "fish";

  // Each entry pairs a species renderer with the species it draws and a
  // reusable (never reallocated) bucket array `update` below partitions the
  // live flock into, so partitioning every frame doesn't allocate.
  const renderers = [];
  for (const [url, speciesList] of speciesByUrl) {
    const renderer = buildSpeciesRenderer(
      assetsByUrl.get(url),
      maxPerSpecies * speciesList.length,
      waterSimSize,
      bounds,
    );
    group.add(renderer.mesh);
    renderers.push({
      species: new Set(speciesList),
      maxCount: maxPerSpecies * speciesList.length,
      bucket: [],
      ...renderer,
    });
  }

  // Splits the live flock by species into each renderer's bucket, then
  // hands each renderer just its own slice — mirrors how a single shared
  // InstancedMesh used to read `fish` directly, just partitioned first so a
  // chinook-only mesh only ever sees chinook fish (and vice versa).
  function update(fish, t, depthRange, waterSize, waterTexture, bounds) {
    for (const r of renderers) r.bucket.length = 0;
    for (const f of fish) {
      const r = renderers.find((r) => r.species.has(f.species));
      if (r && r.bucket.length < r.maxCount) r.bucket.push(f);
    }
    for (const r of renderers) {
      r.update(r.bucket, t, depthRange, waterSize, waterTexture, bounds);
    }
  }

  function setSeason(dayOfYear) {
    for (const r of renderers) r.setSeason(dayOfYear);
  }

  return { mesh: group, update, setSeason };
}
