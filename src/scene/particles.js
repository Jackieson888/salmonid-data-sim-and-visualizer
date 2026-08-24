// particles.js
// Suspended silt drifting in the water column — the single strongest depth cue
// this scene can have.
//
// A shallow inland river is turbid (it is why the fog is tuned as heavily as it
// is, see fog.js), and what actually tells a viewer they are looking *through*
// water rather than at a blue-tinted void is the debris hanging in it: near
// specks sliding past quickly and legibly, far ones dissolving into the murk.
// The fog alone gives distance but no texture, so the water column between the
// camera and the school reads as empty.
//
// Entirely GPU-driven. Each mote's start position is uploaded once as an
// instance attribute and never touched again; drift and wrap-around happen in
// the vertex shader from uTime, so the per-frame CPU cost is one uniform write
// no matter how many motes there are. That was the whole point of doing it this
// way — there is no per-particle JavaScript to get expensive.
//
// Motes are billboarded quads rather than THREE.Points: gl_PointSize is capped
// by the driver and is specified in pixels, so points cannot hold a consistent
// *world* size as they recede, which is exactly the cue this is here to give.

import * as THREE from "three";
import { causticGlowChunk, glslFloat as f } from "./glsl.js";
import { FOG_GLSL, FOG_COLOR, fogDensity } from "./fog.js";
import { riverDepth } from "./terrain.js";
import { seasonForDay } from "./season.js";
import { QUALITY } from "../quality.js";

// The mote count is no longer a constant here — it comes from QUALITY.
// particleCount (see quality.js), read at build time below. Every mote is a
// transparent, blended, camera-facing quad that also does a caustics lookup in
// its vertex shader, so this is a fill-rate number rather than a geometry one,
// which is exactly the budget a phone has least of. At the low tier it is zero
// and buildParticles returns an inert stub rather than an empty mesh.

// The drift volume, as a fraction of the world's largest dimension. Sized so
// density lands where motes are actually resolvable — fog has anything beyond
// this regardless, so a bigger box would just be spending instances on
// invisible specks.
const VOLUME_FRAC = 0.62;

// Mote size range in world units. A fish renders 72-84 units nose-to-tail (see
// boids.js), so these are on the order of a centimetre of real silt against a
// three-foot Chinook. Small enough to read as suspended matter rather than
// snow, which is the failure mode this effect always has — MAX_SIZE came down
// from 9.0 because the largest near-field motes were crossing into it.
const MIN_SIZE = 2.6;
const MAX_SIZE = 7.2;

// Overall visibility of the field, split across the three dials that set it.
//
// Silt is meant to be noticed as texture in the water, not counted as
// individual objects. Kept as named constants because they trade off against
// each other — dropping opacity while raising brightness gets you back where
// you started — and because this is the first thing to reach for when the
// effect is over- or under-stated.
const OPACITY = 0.62;
// Motes catch light from every direction rather than presenting one shaded
// face, so they sit brighter than the riverbed color they're derived from.
const BRIGHTNESS = 1.85;
// How much of a caustic highlight a mote picks up when it drifts through one.
const GLOW_GAIN = 0.35;

// World units per second of downstream drift. The run flows +x (see boids.js),
// so the silt goes with it — but far slower than the fish, since it is being
// carried by the water rather than swimming through it. Reading a mote drift
// past while a salmon powers by is a big part of what sells the fish as fast.
const DRIFT_X = 7;

// Gentle vertical churn, so the field isn't a rigid sheet sliding sideways.
const BOB_AMPLITUDE = 5.5;
const BOB_SPEED = 0.22;

// A function for the same reason water.js's fragment shader is — see there.
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

    // Drift and wrap inside the volume. mod() is what makes the field endless
    // without any CPU bookkeeping: a mote leaving the downstream face
    // reappears at the upstream one, and since every mote has a different
    // start position they don't wrap in unison.
    drifted.x += uTime * ${f(DRIFT_X)};
    drifted.y += sin(uTime * ${f(BOB_SPEED)} + aPhase) * ${f(BOB_AMPLITUDE)};
    drifted = mod(drifted - uVolumeMin, uVolumeSize) + uVolumeMin;

    // Billboard: the quad's corners are offset along the camera's own right
    // and up axes, read out of the view matrix, so every mote faces the viewer
    // regardless of where it sits.
    vec3 right = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
    vec3 up = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
    vec3 worldPos = drifted + (right * position.x + up * position.y) * aSize;

    vWorldPos = worldPos;
    vQuad = position.xy;

    // Motes catch the same light net as everything else, so one drifting
    // through a bright patch flares briefly. Sampled per vertex — a mote is a
    // few pixels across, so this is already far finer than it needs to be.
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
    // Soft round mote. A hard-edged quad reads as a square at close range, and
    // these get close.
    float r = length(vQuad) * 2.0;
    float alpha = (1.0 - smoothstep(0.35, 1.0, r)) * uOpacity;

    // Distance fade, applied to ALPHA rather than by blending toward the fog
    // color. Tinting a mote to fog color makes it vanish against the
    // background but still lays a visible speck over any fish in front of it;
    // fading it out removes it from the frame entirely, which is what a mote
    // too far away to resolve should do. fogAmount() is applyFog's own
    // falloff (see fog.js), taken here for its factor instead of its result.
    alpha *= 1.0 - fogAmount(vWorldPos);
    if (alpha < 0.004) discard;

    vec3 color = (uColor + uGlowColor * vGlow * ${f(GLOW_GAIN)}) * vDepthDim;
    gl_FragColor = vec4(color, alpha);
  }
`;

export function buildParticles(bounds, cameraPosition, cameraTarget) {
  const PARTICLE_COUNT = QUALITY.particleCount;

  // Nothing to draw at the low tier. Returns a stub with the same shape as the
  // real thing — an empty Group so createWorld's scene.add() and destroyWorld's
  // scene.remove() still have an Object3D to work with, and no-op methods so
  // every caller stays unconditional. Cheaper and much less error-prone than
  // sprinkling `particles?.` through the render loop.
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

  // The volume spans the whole water column, and is centered midway between
  // the eye and what it is looking at rather than on the eye itself.
  //
  // Centering on the camera is the obvious thing and it is wrong for a
  // broadside shot (see EYE_FRAC in sceneSetup.js): the eye sits at the edge
  // of the channel, so half the box would hang off the bank behind it, and the
  // far half of the water actually in frame would have no silt in it at all.
  // The midpoint puts the density in the volume being looked through.
  const half = span * VOLUME_FRAC * 0.5;
  const centerX = (cameraPosition.x + cameraTarget.x) * 0.5;
  const centerZ = (cameraPosition.z + cameraTarget.z) * 0.5;
  const volumeMin = new THREE.Vector3(centerX - half, -depth, centerZ - half);
  const volumeSize = new THREE.Vector3(half * 2, depth, half * 2);

  const geometry = new THREE.InstancedBufferGeometry();
  // One quad, corners in [-0.5, 0.5] — the vertex shader scales and billboards
  // it per instance.
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
    // Biased small: a field of uniformly-sized motes reads as a texture, a
    // field with a few larger ones close by reads as a volume.
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
    // Motes are unlit specks in suspension, not solid objects — they should
    // never occlude a fish behind them, and with thousands of overlapping
    // quads the sorting to do that correctly isn't worth paying for.
    depthWrite: false,
  });

  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = "particles";
  // The volume is bigger than any single frustum test would usefully cull, and
  // instances are placed in the vertex shader where three's bounding sphere
  // can't see them.
  mesh.frustumCulled = false;

  function update(timeSeconds) {
    uniforms.uTime.value = timeSeconds;
  }

  function setCausticsTexture(texture) {
    uniforms.uCaustics.value = texture;
  }

  function setWorldSize(waterSize, bounds) {
    uniforms.uWorldSize.value.set(waterSize.width, waterSize.height);
    uniforms.uMargin.value.set(waterSize.marginX, waterSize.marginZ);
    uniforms.uFogDensity.value = fogDensity(bounds);
  }

  function setSeason(dayOfYear) {
    const season = seasonForDay(dayOfYear);
    // Silt is lit by the same water it hangs in, so it takes the season's
    // riverbed color, scaled by BRIGHTNESS.
    uniforms.uColor.value.copy(season.floorColor).multiplyScalar(BRIGHTNESS);
    uniforms.uGlowColor.value.copy(season.causticsColor1);
  }

  function dispose() {
    // Only `geometry` — it shares `quad`'s attribute objects rather than
    // copying them, so disposing both would try to release the same buffers
    // twice.
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
