// godRays.js
// Design rationale, invariants, gotchas: .claude/context/scene/environment.md
// Shafts of sunlight coming down through the surface, derived from the
// caustics texture rather than independent noise — see environment.md for
// why. Vertical quads facing the camera about Y, drawn additively; each
// fragment traces back up the sun direction to its surface entry point and
// samples the net there.

import * as THREE from "three";
import { causticGlowChunk, glslFloat as f } from "./glsl.js";
import { FOG_GLSL, FOG_COLOR, fogDensity } from "./fog.js";
import { riverDepth } from "./terrain.js";
import { seasonForDay } from "./season.js";
import { QUALITY } from "../quality.js";

// Shaft count comes from QUALITY.shaftCount (quality.js), read at build
// time. Bounded by overdraw, not vertex count — see environment.md. Zero at
// the low tier, where buildGodRays returns an inert stub.

// Where the shafts stand, as fractions of the world's largest dimension.
const NEAR_FRAC = 0.34;
const FAR_FRAC = 0.82;

// Half-angle of the arc in front of the camera the shafts are spread across.
const SPREAD_HALF_ANGLE = 1.15;

// Shaft width range in world units. ABOVE_SURFACE hides the quad's top edge
// behind the water surface plane instead of a visible horizontal cut.
const MIN_WIDTH = 38;
const MAX_WIDTH = 125;
const ABOVE_SURFACE = 30;

// How quickly a shaft dies out with depth — much faster than distance fog.
const DEPTH_FALLOFF = 3.1;

// Overall brightness, deliberately low: additive AND under a bloom pass
// (sceneSetup.js), so they compound twice — see environment.md.
const INTENSITY = 1.1;

// Scales the raw caustics sample before saturation/contrast — see
// environment.md for why (the net is dim; surface reads it at 8, fish at 18).
const BEAM_STRENGTH = 30;

// Exponent on the saturated sample; below ~1.5 shafts smear into a general glow.
const BEAM_CONTRAST = 3.0;

const VERTEX_SHADER = /* glsl */ `
  attribute vec3 aBase;
  attribute float aWidth;
  attribute float aPhase;

  uniform float uTime;
  uniform float uHeight;

  varying vec3 vWorldPos;
  varying vec2 vQuad;
  varying float vPhase;

  void main() {
    // Face the camera about Y only — pitching, like a particle billboard,
    // would tilt the shaft out of the water column.
    vec3 toCamera = cameraPosition - aBase;
    vec3 right = normalize(vec3(-toCamera.z, 0.0, toCamera.x));

    // A slow lateral sway, so the shafts breathe rather than standing rigid.
    float sway = sin(uTime * 0.13 + aPhase) * 0.06;

    vec3 worldPos = aBase
      + right * (position.x * aWidth + sway * aWidth)
      + vec3(0.0, position.y * uHeight, 0.0);

    vWorldPos = worldPos;
    vQuad = position.xy;
    vPhase = aPhase;

    gl_Position = projectionMatrix * modelViewMatrix * vec4(worldPos, 1.0);
  }
`;

// A function for the same reason water.js's fragment shader is — see there.
const fragmentShader = () => /* glsl */ `
  ${causticGlowChunk()}
  ${FOG_GLSL}

  uniform sampler2D uCaustics;
  uniform vec2 uWorldSize;
  uniform vec2 uMargin;
  // Same value as the vertex shader's uTime (shared uniform block); needed
  // here for the procedural caustics path.
  uniform float uTime;
  uniform float uCausticsStrength;
  uniform vec3 uSunDir;
  uniform vec3 uColor;
  uniform float uIntensity;
  uniform float uRiverDepth;

  varying vec3 vWorldPos;
  varying vec2 vQuad;
  varying float vPhase;

  void main() {
    float below = max(0.0, -vWorldPos.y);

    // Trace back up the sun direction to where this light crossed the
    // surface, and read the net there. The max() keeps a low winter sun
    // from smearing the sample halfway across the river.
    vec2 entry = vWorldPos.xz + uSunDir.xz * (below / max(uSunDir.y, 0.3));
    vec2 uv = (entry + uMargin) / uWorldSize;

    // Saturate, then a hard contrast curve — separates beams from a wash
    // (see environment.md).
    float lit = causticGlowAt(uCaustics, uv, vec2(0.0), entry, uTime) * uCausticsStrength;
    lit = lit / (1.0 + lit);
    float glow = pow(lit, ${f(BEAM_CONTRAST)});

    // Fade across the width of the plane so it has no vertical edges, and out
    // with depth so the shaft dissolves rather than ending.
    float acrossFade = 1.0 - smoothstep(0.05, 0.5, abs(vQuad.x));

    // Exponential (physical) fade plus a smoothstep forcing exact zero at
    // the quad's bottom edge, which the exponential alone never reaches.
    float t = below / uRiverDepth;
    float depthFade =
      exp(-t * ${f(DEPTH_FALLOFF)}) * (1.0 - smoothstep(0.72, 1.0, t));

    // Ramps in over a real world distance — these planes can sit close to
    // the camera, where a short ramp is a hard bright line on screen.
    float surfaceFade = smoothstep(0.0, 0.3, t);

    float strength = glow * acrossFade * depthFade * surfaceFade * uIntensity;

    // Additive fog, not a blend toward uFogColor: a distant shaft is
    // scattering light that itself travels back through the murk, so it
    // arrives dimmer, not fog-colored.
    strength *= 1.0 - fogAmount(vWorldPos);

    if (strength < 0.002) discard;
    gl_FragColor = vec4(uColor * strength, 1.0);
  }
`;

export function buildGodRays(bounds, cameraPosition, cameraTarget) {
  const SHAFT_COUNT = QUALITY.shaftCount;

  // See the note on the stub in particles.js — same reasoning, same shape,
  // plus setSunDirection, which the render loop calls unconditionally.
  if (SHAFT_COUNT === 0) {
    return {
      mesh: new THREE.Group(),
      update() {},
      setCausticsTexture() {},
      setWorldSize() {},
      setSeason() {},
      setSunDirection() {},
      dispose() {},
    };
  }

  const span = Math.max(bounds.width, bounds.height);
  const depth = riverDepth(bounds);

  const forward = Math.atan2(
    cameraTarget.z - cameraPosition.z,
    cameraTarget.x - cameraPosition.x,
  );

  const geometry = new THREE.InstancedBufferGeometry();
  const quad = new THREE.PlaneGeometry(1, 1);
  geometry.index = quad.index;
  geometry.attributes.position = quad.attributes.position;
  geometry.attributes.uv = quad.attributes.uv;

  const bases = new Float32Array(SHAFT_COUNT * 3);
  const widths = new Float32Array(SHAFT_COUNT);
  const phases = new Float32Array(SHAFT_COUNT);

  for (let i = 0; i < SHAFT_COUNT; i++) {
    const angle = forward + (Math.random() * 2 - 1) * SPREAD_HALF_ANGLE;
    const radius =
      span * NEAR_FRAC + Math.random() * span * (FAR_FRAC - NEAR_FRAC);
    bases[i * 3] = cameraPosition.x + Math.cos(angle) * radius;
    // The quad spans [-0.5, 0.5] on Y scaled by uHeight, so its center sits
    // half a height below the surface for the top edge to land above it.
    bases[i * 3 + 1] = ABOVE_SURFACE - (depth + ABOVE_SURFACE) * 0.5;
    bases[i * 3 + 2] = cameraPosition.z + Math.sin(angle) * radius;
    widths[i] = MIN_WIDTH + Math.random() * (MAX_WIDTH - MIN_WIDTH);
    phases[i] = Math.random() * Math.PI * 2;
  }

  geometry.setAttribute("aBase", new THREE.InstancedBufferAttribute(bases, 3));
  geometry.setAttribute("aWidth", new THREE.InstancedBufferAttribute(widths, 1));
  geometry.setAttribute("aPhase", new THREE.InstancedBufferAttribute(phases, 1));
  geometry.instanceCount = SHAFT_COUNT;

  const uniforms = {
    uTime: { value: 0 },
    uHeight: { value: depth + ABOVE_SURFACE },
    uCaustics: { value: null },
    uWorldSize: { value: new THREE.Vector2(1, 1) },
    uMargin: { value: new THREE.Vector2(0, 0) },
    uCausticsStrength: { value: BEAM_STRENGTH },
    uSunDir: { value: new THREE.Vector3(0.4, 1, 0.25).normalize() },
    uColor: { value: new THREE.Color("#bfe8ff") },
    uIntensity: { value: INTENSITY },
    uRiverDepth: { value: depth },
    uFogColor: { value: FOG_COLOR },
    uFogDensity: { value: fogDensity(bounds) },
  };

  const material = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: VERTEX_SHADER,
    fragmentShader: fragmentShader(),
    transparent: true,
    // Additive: overlapping planes accumulate into a brighter core, which is
    // what gives the effect volume from flat geometry.
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    // Visible from either face — the camera can end up on either side of a
    // plane as the shafts are scattered all around the near field.
    side: THREE.DoubleSide,
  });

  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = "god-rays";
  mesh.frustumCulled = false;
  // Drawn after the opaque scene and the fish, so the light lands on top of
  // everything it is supposed to be scattering in front of.
  mesh.renderOrder = 2;

  function update(timeSeconds) {
    uniforms.uTime.value = timeSeconds;
  }

  function setCausticsTexture(texture) {
    uniforms.uCaustics.value = texture;
  }

  // `coverage` is the caustics pass's world coverage, not the water sim's —
  // see causticsWorldSize in water.js.
  function setWorldSize(coverage, bounds) {
    uniforms.uWorldSize.value.set(coverage.width, coverage.height);
    uniforms.uMargin.value.set(coverage.marginX, coverage.marginZ);
    uniforms.uFogDensity.value = fogDensity(bounds);
  }

  // Pushed every frame alongside the caustics generator's own copy — must
  // stay the same sun or the shafts lean out of step with the net.
  function setSunDirection(direction) {
    uniforms.uSunDir.value.copy(direction);
  }

  function setSeason(dayOfYear) {
    const season = seasonForDay(dayOfYear);
    // Shafts are the sun's own color, pulled toward the light net's tone —
    // this is sunlight already partway through the water, not sunlight in air.
    uniforms.uColor.value
      .copy(season.sunColor)
      .lerp(season.causticsColor1, 0.45);
    // A low seasonal sun puts less light down the column, so winter shafts
    // are weaker than summer ones without needing their own schedule.
    uniforms.uIntensity.value = INTENSITY * (0.55 + 0.45 * season.sunIntensity);
  }

  function dispose() {
    geometry.dispose();
    material.dispose();
  }

  return {
    mesh,
    update,
    setCausticsTexture,
    setWorldSize,
    setSeason,
    setSunDirection,
    dispose,
  };
}
