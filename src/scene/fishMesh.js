// fishMesh.js
// Loads the SALMON.OBJ model (body/eye/mouth groups), merges it into one
// non-indexed BufferGeometry tagged per-vertex with a material id and a
// nose->tail "aAlong" parameter, and renders the whole flock as a single
// InstancedMesh. Swim animation is the 3D analog of the old flipbook shear
// (see main.js.old buildSwimFrames): a per-vertex lateral bend driven by a
// traveling sine wave whose amplitude grows toward the tail, evaluated in
// a custom vertex shader instead of baked per-frame on the CPU.

import * as THREE from "three";
import { OBJLoader } from "three/examples/jsm/loaders/OBJLoader.js";

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

const VERTEX_SHADER = /* glsl */ `
  attribute float aMatId;
  attribute float aAlong;
  attribute float aPhase;
  attribute float aSpeed;

  uniform float uTime;
  uniform float uBendAmplitude;
  uniform float uBendFrequency;

  varying vec2 vUv;
  varying float vMatId;
  varying vec3 vWorldNormal;

  void main() {
    // Swapped from the raw OBJ (u, 1-v): the source photo runs nose->tail
    // along its horizontal axis, but the model's u/v had that mapped to
    // "around the body" instead of "along it" — repeating the whole
    // head-to-tail image around each cross-section ring and reading as
    // vertical banding. Swapping axes lines the photo up along the spine.
    vUv = vec2(uv.y, 1.0 - uv.x);
    vMatId = aMatId;

    float alongSq = aAlong * aAlong;
    float bendPhase = uTime * 0.0012 * aSpeed - aAlong * uBendFrequency + aPhase;
    float bend = sin(bendPhase) * uBendAmplitude * alongSq;

    vec3 bent = position + vec3(bend, 0.0, 0.0);

    vec4 worldPos = instanceMatrix * vec4(bent, 1.0);
    vWorldNormal = normalize((instanceMatrix * vec4(normal, 0.0)).xyz);

    vec4 mvPosition = modelViewMatrix * worldPos;
    gl_Position = projectionMatrix * mvPosition;
  }
`;

const FRAGMENT_SHADER = /* glsl */ `
  uniform sampler2D uBodyMap;
  uniform vec3 uEyeColor;
  uniform vec3 uMouthColor;
  uniform vec3 uLightDir;

  varying vec2 vUv;
  varying float vMatId;
  varying vec3 vWorldNormal;

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

    gl_FragColor = vec4(base * lit, 1.0);
  }
`;

async function loadMergedGeometry() {
  const loader = new OBJLoader();
  const group = await loader.loadAsync(MODEL_URL);

  const groupNameToMatId = { sal_body: MAT_BODY, sal_eye: MAT_EYE, sal_mouth: MAT_MOUTH };

  const positions = [];
  const uvs = [];
  const matIds = [];

  // Track the model's bounding box while walking its meshes, so it can be
  // re-centered and measured (for the nose->tail `aAlong` param below)
  // without a second pass over the data.
  let minX = Infinity, maxX = -Infinity;
  let minY = Infinity, maxY = -Infinity;
  let minZ = Infinity, maxZ = -Infinity;

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
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
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

export function createFishInstancedMesh({ geometry, modelLength, texture }, maxCount) {
  const phase = new Float32Array(maxCount);
  const speed = new Float32Array(maxCount);
  geometry.setAttribute("aPhase", new THREE.InstancedBufferAttribute(phase, 1));
  geometry.setAttribute("aSpeed", new THREE.InstancedBufferAttribute(speed, 1));

  const uniforms = {
    uTime: { value: 0 },
    uBendAmplitude: { value: modelLength * BEND_AMPLITUDE_FRAC },
    uBendFrequency: { value: BEND_FREQUENCY },
    uBodyMap: { value: texture },
    uEyeColor: { value: EYE_COLOR },
    uMouthColor: { value: MOUTH_COLOR },
    uLightDir: { value: new THREE.Vector3(0.4, 1, 0.25).normalize() },
  };

  const material = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: VERTEX_SHADER,
    fragmentShader: FRAGMENT_SHADER,
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
  function update(fish, t, depthRange) {
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
      const y = THREE.MathUtils.lerp(surfaceY, floorY, f.depth) + Math.sin(t * 0.0007 + f.wobblePhase) * 2.5;
      matrix.compose(new THREE.Vector3(f.x, y, f.y), quaternion, scaleVec);
      mesh.setMatrixAt(i, matrix);
      phase[i] = f.wobblePhase;
      speed[i] = f.wobbleSpeed;
    }
    mesh.count = count;
    mesh.instanceMatrix.needsUpdate = true;
    geometry.attributes.aPhase.needsUpdate = true;
    geometry.attributes.aSpeed.needsUpdate = true;
    uniforms.uTime.value = t;
  }

  return { mesh, update };
}
