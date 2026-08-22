// godRays.js
// Shafts of sunlight coming down through the surface.
//
// The scene already computes where light concentrates when it refracts through
// the waves — that is the caustics texture (see causticsGenerator.js), a
// top-down map of how much light reaches each point of the bed. Until now it
// was only ever read at the two ends of that journey: on the surface, and on
// whatever the light landed on. The shafts are the middle of it, the light
// scattering off silt on the way down, and they come from the same texture —
// so a bright knot in the net overhead has a shaft beneath it, and both move
// together as the water moves. That coherence is the reason to derive them
// from the caustics rather than from independent noise, which is the usual way
// this effect is faked and always drifts out of step with the surface.
//
// Implementation is a set of vertical quads standing in the water column,
// turned to face the camera about the Y axis, drawn additively. Each fragment
// traces from its own position back up along the sun direction to find where
// its light entered the surface, and samples the net there — so the shafts
// lean the way the season's sun leans, and lean further the deeper you look.

import * as THREE from "three";
import { CAUSTIC_GLOW_POINT_GLSL, glslFloat as f } from "./glsl.js";
import { FOG_GLSL, FOG_COLOR, fogDensity } from "./fog.js";
import { riverDepth } from "./terrain.js";
import { seasonForDay } from "./season.js";

// Number of shaft planes. Each one is large and additively blended, so this is
// bounded by overdraw, not by vertex count — every extra plane is close to a
// full-screen pass of blending in the worst case. A dozen is enough to read as
// a volume because they are semi-transparent and overlap.
const SHAFT_COUNT = 18;

// Where the shafts stand, as fractions of the world's largest dimension. The
// near bound keeps a plane from sitting on top of the lens; the far one stops
// before the fog has fully saturated, since a shaft out there adds nothing but
// blend cost.
const NEAR_FRAC = 0.34;
const FAR_FRAC = 0.82;

// Half-angle of the arc in front of the camera the shafts are spread across.
const SPREAD_HALF_ANGLE = 1.15;

// Shaft width range in world units, and how far above the surface the quad
// starts. Starting slightly above y=0 means the top edge is hidden behind the
// water surface plane rather than ending in a visible horizontal cut.
const MIN_WIDTH = 38;
const MAX_WIDTH = 125;
const ABOVE_SURFACE = 30;

// How quickly a shaft dies out with depth. Light scattering down through
// turbid water loses intensity fast — much faster than the distance fog does
// — which is what keeps the shafts as a feature of the upper water column
// instead of a glow filling the whole frame.
const DEPTH_FALLOFF = 3.1;

// Overall brightness. Deliberately low: these are additive AND sit under a
// bloom pass (see sceneSetup.js), so they compound twice — a value that looks
// reasonable on its own turns the near planes into flat glowing slabs once
// several overlap and the bloom picks them up.
const INTENSITY = 1.1;

// Scales the raw caustics sample before the saturation and contrast below. The
// net is a dim, broad signal at source (see causticsGenerator.js) — the surface
// reads it at 8 and the fish at 18 — and it has to be lifted well up the
// saturation curve first, or the power curve below crushes the whole range to
// nothing rather than separating bright from dim.
const BEAM_STRENGTH = 30;

// Exponent on the saturated sample. Higher is a harder separation between beam
// and dark water; below about 1.5 the shafts smear back into a general glow.
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
    // Turn each plane about the vertical axis to face the camera. Only about
    // Y: a shaft is a column of light with a real, fixed vertical extent, and
    // letting it pitch toward the camera the way a particle billboard does
    // would tilt it out of the water column.
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

const FRAGMENT_SHADER = /* glsl */ `
  ${CAUSTIC_GLOW_POINT_GLSL}
  ${FOG_GLSL}

  uniform sampler2D uCaustics;
  uniform vec2 uWorldSize;
  uniform vec2 uMargin;
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

    // Trace back up the sun direction to where this light crossed the surface,
    // and read the net there. uSunDir points toward the sun, so going up along
    // it by (depth / sunDir.y) lands on y = 0. The max() keeps a low winter
    // sun from smearing the sample halfway across the river.
    vec2 entry = vWorldPos.xz + uSunDir.xz * (below / max(uSunDir.y, 0.3));
    vec2 uv = (entry + uMargin) / uWorldSize;

    // Saturate, then apply a hard contrast curve. This is what separates
    // beams from a wash: the raw net is a broad, mostly-dim field, and
    // scattering it evenly down the column just fogs the whole frame. The
    // power curve keeps the bright knots and crushes everything else, so what
    // comes down are discrete shafts with dark water between them.
    float lit = causticGlowPoint(uCaustics, uv) * uCausticsStrength;
    lit = lit / (1.0 + lit);
    float glow = pow(lit, ${f(BEAM_CONTRAST)});

    // Fade across the width of the plane so it has no vertical edges, and out
    // with depth so the shaft dissolves rather than ending.
    float acrossFade = 1.0 - smoothstep(0.05, 0.5, abs(vQuad.x));

    // Two vertical fades. The exponential is the physical one — light
    // scattering down through turbid water dies fast. The smoothstep on top
    // forces it to exactly zero at the quad's bottom edge, which the
    // exponential alone never reaches, and a shaft that stops at 4% of full
    // brightness leaves a visible horizontal seam across the frame.
    float t = below / uRiverDepth;
    float depthFade =
      exp(-t * ${f(DEPTH_FALLOFF)}) * (1.0 - smoothstep(0.72, 1.0, t));

    // Ramp in below the surface over a real distance rather than a token one.
    // These planes can sit close to the camera, where a short ramp in world
    // units is a hard bright line across a large part of the screen.
    float surfaceFade = smoothstep(0.0, 0.3, t);

    float strength = glow * acrossFade * depthFade * surfaceFade * uIntensity;

    // Distance fog applies to shafts too, but additively: a shaft far enough
    // away is scattering light that itself has to travel back through the
    // murk, so it arrives dimmer rather than fog-colored. Blending toward
    // uFogColor here would brighten the fog instead of fading the shaft.
    float dist = length(cameraPosition - vWorldPos);
    float fogFactor = 1.0 - exp(-uFogDensity * uFogDensity * dist * dist);
    strength *= 1.0 - clamp(fogFactor, 0.0, 1.0);

    if (strength < 0.002) discard;
    gl_FragColor = vec4(uColor * strength, 1.0);
  }
`;

export function buildGodRays(bounds, cameraPosition, cameraTarget) {
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
    fragmentShader: FRAGMENT_SHADER,
    transparent: true,
    // Additive: shafts are light being added to the scene, not a surface
    // covering it. Overlapping planes therefore accumulate into a brighter
    // core, which is what gives the effect volume from flat geometry.
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

  function setWorldSize(waterSize, bounds) {
    uniforms.uWorldSize.value.set(waterSize.width, waterSize.height);
    uniforms.uMargin.value.set(waterSize.marginX, waterSize.marginZ);
    uniforms.uFogDensity.value = fogDensity(bounds);
  }

  // The direction each fragment traces back up to find its surface entry
  // point. Pushed every frame alongside the caustics generator's own copy
  // (see season.js's sweptSunDirection) — the two have to be the same sun or
  // the shafts would lean one way while the net they sample slid the other.
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
