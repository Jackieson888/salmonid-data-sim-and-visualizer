// Suspended silt drifting in the water column, the scene's strongest depth cue; billboarded quads driven entirely on the GPU.
import * as THREE from "three";
import { causticGlowChunk, glslFloat as f } from "./glsl.js";
import { FOG_GLSL, FOG_COLOR, fogDensity } from "./fog.js";
import { riverDepth } from "./terrain.js";
import { seasonForDay } from "./season.js";
import { QUALITY } from "../quality.js";

// Drift volume as a fraction of the world's largest dimension.
const VOLUME_FRAC = 0.62;

// Mote size range in world units, small enough to read as suspended matter rather than snow.
const MIN_SIZE = 2.0;
const MAX_SIZE = 5.5;

// Overall visibility of the field, split across three dials that trade off against each other.
const OPACITY = 0.46;
// Motes catch light from every direction, so they sit brighter than the riverbed color they're derived from.
const BRIGHTNESS = 1.85;
// How much of a caustic highlight a mote picks up when it drifts through one.
const GLOW_GAIN = 0.35;

// World units per second of downstream drift; far slower than the fish since it's carried by water, not swimming.
const DRIFT_X = 7;

// Gentle vertical churn, so the field isn't a rigid sheet sliding sideways.
const BOB_AMPLITUDE = 5.5;
const BOB_SPEED = 0.22;

// A function so causticGlowChunk() resolves against the current quality tier at build time.
const vertexShader = () => /* glsl */ `
  ${causticGlowChunk()}

  attribute vec3 aOrigin;
  attribute float aSize;
  attribute float aPhase;

  uniform float uTime;
  uniform vec3 uVolumeMin;
  uniform vec3 uVolumeSize;
  uniform sampler2D uCaustics;
  uniform vec2 uWorldSize;
  uniform vec2 uMargin;
  uniform float uDepthDarkenRate;

  varying vec2 vQuad;
  varying float vGlow;
  varying float vDepthDim;
  varying vec3 vWorldPos;

  void main() {
    vec3 drifted = aOrigin;

    // Drift and wrap inside the volume with mod() — endless with no CPU bookkeeping.
    drifted.x += uTime * ${f(DRIFT_X)};
    drifted.y += sin(uTime * ${f(BOB_SPEED)} + aPhase) * ${f(BOB_AMPLITUDE)};
    drifted = mod(drifted - uVolumeMin, uVolumeSize) + uVolumeMin;

    // Billboard: quad corners offset along the camera's right/up axes, read out of the view matrix.
    vec3 right = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
    vec3 up = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
    vec3 worldPos = drifted + (right * position.x + up * position.y) * aSize;

    vWorldPos = worldPos;
    vQuad = position.xy;

    // Sampled per vertex — a mote is a few pixels across already, finer sampling isn't needed.
    vec2 waterUv = (worldPos.xz + uMargin) / uWorldSize;
    vGlow = causticGlowAt(uCaustics, waterUv, vec2(0.0), worldPos.xz, uTime);

    vDepthDim = exp(-max(0.0, -worldPos.y) * uDepthDarkenRate);

    gl_Position = projectionMatrix * modelViewMatrix * vec4(worldPos, 1.0);
  }
`;

const FRAGMENT_SHADER = /* glsl */ `
  ${FOG_GLSL}

  uniform vec3 uColor;
  uniform vec3 uGlowColor;
  uniform float uOpacity;

  varying vec2 vQuad;
  varying float vGlow;
  varying float vDepthDim;
  varying vec3 vWorldPos;

  void main() {
    // Soft round mote — a hard-edged quad reads as a square at close range.
    float r = length(vQuad) * 2.0;
    float alpha = (1.0 - smoothstep(0.35, 1.0, r)) * uOpacity;

    // Fades alpha, not a blend toward fog color, so a mote disappears rather than tinting.
    alpha *= 1.0 - fogAmount(vWorldPos);
    if (alpha < 0.004) discard;

    vec3 color = (uColor + uGlowColor * vGlow * ${f(GLOW_GAIN)}) * vDepthDim;
    gl_FragColor = vec4(color, alpha);
  }
`;

export function buildParticles(bounds, cameraPosition, cameraTarget) {
  const PARTICLE_COUNT = QUALITY.particleCount;

  // Nothing to draw at the low tier — a stub with the same shape so every caller stays unconditional.
  if (PARTICLE_COUNT === 0) {
    return {
      mesh: new THREE.Group(),
      update() {},
      setCausticsTexture() {},
      setWorldSize() {},
      setSeason() {},
      dispose() {},
    };
  }

  const span = Math.max(bounds.width, bounds.height);
  const depth = riverDepth(bounds);

  // Centered midway between the eye and what it's looking at, not on the eye itself.
  const half = span * VOLUME_FRAC * 0.5;
  const centerX = (cameraPosition.x + cameraTarget.x) * 0.5;
  const centerZ = (cameraPosition.z + cameraTarget.z) * 0.5;
  const volumeMin = new THREE.Vector3(centerX - half, -depth, centerZ - half);
  const volumeSize = new THREE.Vector3(half * 2, depth, half * 2);

  const geometry = new THREE.InstancedBufferGeometry();
  // One quad, corners in [-0.5, 0.5]; the vertex shader scales and billboards it per instance.
  const quad = new THREE.PlaneGeometry(1, 1);
  geometry.index = quad.index;
  geometry.attributes.position = quad.attributes.position;
  geometry.attributes.uv = quad.attributes.uv;

  const origins = new Float32Array(PARTICLE_COUNT * 3);
  const sizes = new Float32Array(PARTICLE_COUNT);
  const phases = new Float32Array(PARTICLE_COUNT);
  for (let i = 0; i < PARTICLE_COUNT; i++) {
    origins[i * 3] = volumeMin.x + Math.random() * volumeSize.x;
    origins[i * 3 + 1] = volumeMin.y + Math.random() * volumeSize.y;
    origins[i * 3 + 2] = volumeMin.z + Math.random() * volumeSize.z;
    // Biased small: uniformly-sized motes read as a texture, a few larger ones close by read as a volume.
    const r = Math.random();
    sizes[i] = MIN_SIZE + r * r * (MAX_SIZE - MIN_SIZE);
    phases[i] = Math.random() * Math.PI * 2;
  }
  geometry.setAttribute("aOrigin", new THREE.InstancedBufferAttribute(origins, 3));
  geometry.setAttribute("aSize", new THREE.InstancedBufferAttribute(sizes, 1));
  geometry.setAttribute("aPhase", new THREE.InstancedBufferAttribute(phases, 1));
  geometry.instanceCount = PARTICLE_COUNT;

  const uniforms = {
    uTime: { value: 0 },
    uVolumeMin: { value: volumeMin },
    uVolumeSize: { value: volumeSize },
    uCaustics: { value: null },
    uWorldSize: { value: new THREE.Vector2(1, 1) },
    uMargin: { value: new THREE.Vector2(0, 0) },
    uDepthDarkenRate: { value: Math.log(4) / depth },
    // Overwritten by setSeason(); these only show before the first call.
    uColor: { value: new THREE.Color("#7d8c84") },
    uGlowColor: { value: new THREE.Color("#5cc594") },
    uOpacity: { value: OPACITY },
    uFogColor: { value: FOG_COLOR },
    uFogDensity: { value: fogDensity(bounds) },
  };

  const material = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: vertexShader(),
    fragmentShader: FRAGMENT_SHADER,
    transparent: true,
    // Unlit specks in suspension; sorting thousands of overlapping quads correctly isn't worth paying for.
    depthWrite: false,
  });

  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = "particles";
  // Instances are placed in the vertex shader, where three's bounding sphere can't see them.
  mesh.frustumCulled = false;

  function update(timeSeconds) {
    uniforms.uTime.value = timeSeconds;
  }

  function setCausticsTexture(texture) {
    uniforms.uCaustics.value = texture;
  }

  // `coverage` is the caustics pass's world coverage, not the water sim's.
  function setWorldSize(coverage, bounds) {
    uniforms.uWorldSize.value.set(coverage.width, coverage.height);
    uniforms.uMargin.value.set(coverage.marginX, coverage.marginZ);
    uniforms.uFogDensity.value = fogDensity(bounds);
  }

  function setSeason(dayOfYear) {
    const season = seasonForDay(dayOfYear);
    // Silt takes the season's riverbed color, scaled by BRIGHTNESS.
    uniforms.uColor.value.copy(season.floorColor).multiplyScalar(BRIGHTNESS);
    uniforms.uGlowColor.value.copy(season.causticsColor1);
  }

  function dispose() {
    // Only `geometry` — it shares `quad`'s attribute objects, so disposing both would double-release.
    geometry.dispose();
    material.dispose();
  }

  return {
    mesh,
    update,
    setCausticsTexture,
    setWorldSize,
    setSeason,
    dispose,
  };
}
