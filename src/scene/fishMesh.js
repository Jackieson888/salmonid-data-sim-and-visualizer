// fishMesh.js
// Loads the SALMON.OBJ model (body/eye/mouth groups), merges it into one
// non-indexed BufferGeometry tagged per-vertex with a material id and a
// nose->tail "aAlong" parameter, and renders the whole flock as a single
// InstancedMesh. Swim animation is the 3D analog of the old flipbook shear
// (see main.js.old buildSwimFrames): a per-vertex lateral bend driven by a
// traveling sine wave whose amplitude grows toward the tail, evaluated in
// a custom vertex shader instead of baked per-frame on the CPU.
//
// Fish also pick up the same causticGlow() read the terrain/water use (see
// causticsChunk.js), sampled at each vertex's world XZ position, so a fish
// swimming through a bright patch of the water's light net visibly glints —
// the fish read as sitting *in* the water instead of pasted over it.

import * as THREE from "three";
import { OBJLoader } from "three/examples/jsm/loaders/OBJLoader.js";
import { CAUSTIC_GLOW_GLSL } from "./causticsChunk.js";
import { FOG_GLSL, FOG_COLOR, fogDensity } from "./fog.js";
import { riverDepth } from "./terrain.js";

const MODEL_URL = "/salmon.obj";
const SKIN_URL = "/salmon-skin.png";

const MAT_BODY = 0;
const MAT_EYE = 1;
const MAT_MOUTH = 2;
const EYE_COLOR = new THREE.Color(0.04, 0.04, 0.05);
const MOUTH_COLOR = new THREE.Color(0.690196, 0.67451, 0.694118);

// How much of the model's own nose-to-tail length the tail can swing
// sideways at full bend — mirrors the old flipbook's `w * 0.09` amplitude.
const BEND_AMPLITUDE_FRAC = 0.1;
const BEND_FREQUENCY = 5.0; // spatial frequency of the traveling wave along the spine

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

const VERTEX_SHADER = /* glsl */ `
  ${CAUSTIC_GLOW_GLSL}

  attribute float aMatId;
  attribute float aAlong;
  attribute float aPhase;
  attribute float aSpeed;
  attribute float aOpacity;

  uniform float uTime;
  uniform float uBendAmplitude;
  uniform float uBendFrequency;
  uniform sampler2D uWater;
  uniform vec2 uWorldSize;
  uniform vec2 uMargin;
  uniform vec2 uTexel;
  uniform float uDepthDarkenRate;

  varying vec2 vUv;
  varying float vMatId;
  varying vec3 vWorldNormal;
  varying float vCausticGlow;
  varying float vOpacity;
  varying vec3 vWorldPos;
  varying float vDepthDim;

  void main() {
    // Swapped from the raw OBJ (u, 1-v): the source photo runs nose->tail
    // along its horizontal axis, but the model's u/v had that mapped to
    // "around the body" instead of "along it" — repeating the whole
    // head-to-tail image around each cross-section ring and reading as
    // vertical banding. Swapping axes lines the photo up along the spine.
    vUv = vec2(uv.y, 1.0 - uv.x);
    vMatId = aMatId;
    vOpacity = aOpacity;

    float alongSq = aAlong * aAlong;
    float bendPhase = uTime * 0.0012 * aSpeed - aAlong * uBendFrequency + aPhase;
    float bend = sin(bendPhase) * uBendAmplitude * alongSq;

    vec3 bent = position + vec3(bend, 0.0, 0.0);

    vec4 worldPos = instanceMatrix * vec4(bent, 1.0);
    vWorldPos = worldPos.xyz;
    vWorldNormal = normalize((instanceMatrix * vec4(normal, 0.0)).xyz);

    // Darker the deeper below the surface (world Y = 0) this vertex sits —
    // see DEPTH_DARKEN_FACTOR/MIN_DEPTH_DIM above.
    float depthBelowSurface = max(0.0, -worldPos.y);
    vDepthDim = max(${MIN_DEPTH_DIM}, exp(-depthBelowSurface * uDepthDarkenRate));

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

  varying vec2 vUv;
  varying float vMatId;
  varying vec3 vWorldNormal;
  varying float vCausticGlow;
  varying float vOpacity;
  varying vec3 vWorldPos;
  varying float vDepthDim;

  void main() {
    vec3 base;
    if (vMatId < 0.5) {
      base = texture2D(uBodyMap, vUv).rgb;
    } else if (vMatId < 1.5) {
      base = uEyeColor;
    } else {
      base = uMouthColor;
    }

    float ndl = dot(normalize(vWorldNormal), normalize(uLightDir)) * 0.5 + 0.5;
    float band = floor(ndl * 4.0) / 4.0;
    float lit = mix(0.55, 1.2, band);

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

    vec3 color = applyFog(base * lit * vDepthDim + causticsColor * glow, vWorldPos);
    gl_FragColor = vec4(color, vOpacity);
  }
`;

async function loadMergedGeometry() {
  const loader = new OBJLoader();
  const group = await loader.loadAsync(MODEL_URL);

  const groupNameToMatId = {
    sal_body: MAT_BODY,
    sal_eye: MAT_EYE,
    sal_mouth: MAT_MOUTH,
  };

  const positions = [];
  const uvs = [];
  const matIds = [];

  // Track the model's bounding box while walking its meshes, so it can be
  // re-centered and measured (for the nose->tail `aAlong` param below)
  // without a second pass over the data.
  let minX = Infinity,
    maxX = -Infinity;
  let minY = Infinity,
    maxY = -Infinity;
  let minZ = Infinity,
    maxZ = -Infinity;

  // Flatten every sub-mesh (body/eye/mouth) into one flat vertex soup,
  // tagging each vertex with which material it belongs to.
  group.traverse((child) => {
    if (!child.isMesh) return;
    const matId = groupNameToMatId[child.name] ?? MAT_BODY;
    const posAttr = child.geometry.attributes.position;
    const uvAttr = child.geometry.attributes.uv;
    for (let i = 0; i < posAttr.count; i++) {
      const x = posAttr.getX(i);
      const y = posAttr.getY(i);
      const z = posAttr.getZ(i);
      positions.push(x, y, z);
      uvs.push(uvAttr ? uvAttr.getX(i) : 0, uvAttr ? uvAttr.getY(i) : 0);
      matIds.push(matId);
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      if (z < minZ) minZ = z;
      if (z > maxZ) maxZ = z;
    }
  });

  const modelLength = maxZ - minZ;
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const cz = (minZ + maxZ) / 2;

  // Re-center every vertex on the model's own bounding-box center, and
  // compute each vertex's 0 (nose) -> 1 (tail) position along the spine —
  // the vertex shader uses this to grow the swim-bend toward the tail.
  const vertexCount = positions.length / 3;
  const along = new Float32Array(vertexCount);
  for (let i = 0; i < vertexCount; i++) {
    positions[i * 3] -= cx;
    positions[i * 3 + 1] -= cy;
    positions[i * 3 + 2] -= cz;
    // Nose sits at +Z (max), tail at -Z (min) — see head-location probe
    // against the eye/mouth groups' own z-range during modeling analysis.
    const z = positions[i * 3 + 2] + cz;
    along[i] = (maxZ - z) / modelLength;
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    "position",
    new THREE.Float32BufferAttribute(positions, 3),
  );
  geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setAttribute("aMatId", new THREE.Float32BufferAttribute(matIds, 1));
  geometry.setAttribute("aAlong", new THREE.Float32BufferAttribute(along, 1));
  geometry.computeVertexNormals();

  return { geometry, modelLength };
}

let cachedLoad = null;

export function loadFishAssets() {
  if (!cachedLoad) {
    cachedLoad = Promise.all([
      loadMergedGeometry(),
      new THREE.TextureLoader().loadAsync(SKIN_URL),
    ]).then(([{ geometry, modelLength }, texture]) => {
      texture.colorSpace = THREE.SRGBColorSpace;
      return { geometry, modelLength, texture };
    });
  }
  return cachedLoad;
}

export function createFishInstancedMesh(
  { geometry, modelLength, texture },
  maxCount,
  waterSimSize,
  bounds,
) {
  const phase = new Float32Array(maxCount);
  const speed = new Float32Array(maxCount);
  const opacity = new Float32Array(maxCount);
  geometry.setAttribute("aPhase", new THREE.InstancedBufferAttribute(phase, 1));
  geometry.setAttribute("aSpeed", new THREE.InstancedBufferAttribute(speed, 1));
  geometry.setAttribute(
    "aOpacity",
    new THREE.InstancedBufferAttribute(opacity, 1),
  );

  const uniforms = {
    uTime: { value: 0 },
    uBendAmplitude: { value: modelLength * BEND_AMPLITUDE_FRAC },
    uBendFrequency: { value: BEND_FREQUENCY },
    uBodyMap: { value: texture },
    uEyeColor: { value: EYE_COLOR },
    uMouthColor: { value: MOUTH_COLOR },
    uLightDir: { value: new THREE.Vector3(0.4, 1, 0.25).normalize() },
    uWater: { value: null },
    uWorldSize: { value: new THREE.Vector2(1, 1) }, // real size arrives via update() each frame
    uMargin: { value: new THREE.Vector2(0, 0) }, // ditto
    uTexel: { value: new THREE.Vector2(1 / waterSimSize, 1 / waterSimSize) },
    uCausticsColor1: { value: new THREE.Color("#5cc594") },
    uCausticsColor2: { value: new THREE.Color("#123b28") },
    uCausticsStrength: { value: 60 },
    uFogColor: { value: FOG_COLOR },
    uFogDensity: { value: fogDensity(bounds) },
    uDepthDarkenRate: { value: depthDarkenRate(bounds) },
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
    const count = Math.min(fish.length, maxCount);
    for (let i = 0; i < count; i++) {
      const f = fish[i];
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
      matrix.compose(new THREE.Vector3(f.x, y, f.y), quaternion, scaleVec);
      mesh.setMatrixAt(i, matrix);
      phase[i] = f.wobblePhase;
      speed[i] = f.wobbleSpeed;
      opacity[i] = f.opacity;
    }
    mesh.count = count;
    mesh.instanceMatrix.needsUpdate = true;
    geometry.attributes.aPhase.needsUpdate = true;
    geometry.attributes.aSpeed.needsUpdate = true;
    geometry.attributes.aOpacity.needsUpdate = true;
    uniforms.uTime.value = t;

    // The water sim's ping-pong texture swaps every frame, and waterSize/
    // bounds can change on resize — all refreshed here rather than wired
    // through a separate setter, since update() already runs once per frame.
    uniforms.uWater.value = waterTexture;
    uniforms.uWorldSize.value.set(waterSize.width, waterSize.height);
    uniforms.uMargin.value.set(waterSize.marginX, waterSize.marginZ);
    uniforms.uFogDensity.value = fogDensity(bounds);
    uniforms.uDepthDarkenRate.value = depthDarkenRate(bounds);
  }

  return { mesh, update };
}
