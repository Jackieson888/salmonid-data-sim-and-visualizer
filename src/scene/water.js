// water.js
// Water surface: a flat plane at world Y=0, fragment-shaded from the live
// GPU height-field simulation in waterSim.js (real ripples, not a canned
// texture) and lit by the same causticGlow() helper terrain.js uses (see
// causticsChunk.js), so the sparkle on the surface and the light net on
// the riverbed come from one consistent read of the same water texture.
//
// The plane itself is drawn larger than the river bounds (WATER_SIZE_MULTIPLIER)
// and the entire margin beyond the real bounds fades to 0 opacity — full
// opacity right up to where the simulation actually is, then a gradual
// dissolve into the scene background across the added margin, rather than
// ending in a visible rectangle.
//
// The water sim itself (see waterWorldSize() below) is mapped to cover this
// same oversized area, not just the literal play-field bounds — so ripples
// genuinely propagate out into the fade margin via the sim's own wave
// diffusion, instead of the margin just clamping to (and stretching) the
// sim texture's edge texel. Anything else that converts a world position
// into this sim's uv space (main.js's worldToSim, fishMesh.js's caustic
// sampling) must use the same waterWorldSize() to stay in registration.

import * as THREE from "three";
import { CAUSTIC_GLOW_GLSL } from "./causticsChunk.js";
import { FOG_GLSL, FOG_COLOR, fogDensity } from "./fog.js";

// How much bigger than the river bounds the water sim/plane covers — the
// entire added margin (from the real edge out to the plane's own edge) is
// both the caustics fade zone and the region the sim can propagate ripples
// into, so a bigger multiplier reads as a longer, softer dissolve.
export const WATER_SIZE_MULTIPLIER = 2.4;

// {width, height} = the sim/plane's actual world coverage, oversized by
// WATER_SIZE_MULTIPLIER; {marginX, marginZ} = how far that coverage extends
// past bounds on each side (the plane is centered on bounds, not corner
// anchored, so this offset is what keeps world->uv math consistent).
export function waterWorldSize(bounds) {
  const width = bounds.width * WATER_SIZE_MULTIPLIER;
  const height = bounds.height * WATER_SIZE_MULTIPLIER;
  return {
    width,
    height,
    marginX: (width - bounds.width) / 2,
    marginZ: (height - bounds.height) / 2,
  };
}

const VERTEX_SHADER = /* glsl */ `
  varying vec3 vWorldPos;
  void main() {
    vWorldPos = position;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const FRAGMENT_SHADER = /* glsl */ `
  ${CAUSTIC_GLOW_GLSL}
  ${FOG_GLSL}

  uniform sampler2D uWater;
  uniform vec2 uWorldSize;
  uniform vec2 uMargin;
  uniform vec2 uTexel;
  uniform vec3 uBaseColor;
  uniform vec3 uSkyColor;
  uniform float uCausticsStrength;
  uniform vec2 uCenter;
  uniform vec2 uPlaneHalfSize;
  uniform float uCoreFrac;

  varying vec3 vWorldPos;

  void main() {
    // Sample the live height-field sim for this point's surface normal
    // (stored in the .ba channels — see waterSim.js's UPDATE_FRAGMENT_SHADER).
    // uWorldSize/uMargin match waterWorldSize() below — the sim covers this
    // whole oversized area, centered on bounds rather than corner-anchored,
    // hence the margin shift before normalizing into [0, 1] uv space.
    vec2 uv = (vWorldPos.xz + uMargin) / uWorldSize;
    vec4 info = texture2D(uWater, uv);
    vec3 normal = normalize(vec3(info.b, sqrt(max(0.0, 1.0 - dot(info.ba, info.ba))), info.a));

    // Fresnel: water looks more like a mirror (sky-colored) at grazing
    // angles and more like its base color when viewed head-on.
    vec3 viewDir = normalize(cameraPosition - vWorldPos);
    float fresnel = pow(1.0 - clamp(dot(normal, viewDir), 0.0, 1.0), 3.0);
    vec3 color = mix(uBaseColor, uSkyColor, fresnel * 0.6);

    // Same causticGlow() read terrain.js uses, at this same point — the
    // surface glints with the same light pattern that lands underwater
    // instead of an unrelated procedural shimmer.
    float glint = min(causticGlow(uWater, uv, uTexel) * uCausticsStrength, 1.4);
    color += vec3(0.75, 0.92, 0.98) * glint * 0.35;

    // Edge fade: fully opaque out to uCoreFrac (exactly where the real
    // river bounds end — see buildWaterMesh), then a smooth dissolve across
    // the rest of the oversized plane out to its own edge. max() so the
    // fade wraps all four sides/corners of the rectangle evenly instead of
    // rounding it off into a circle.
    vec2 t = abs(vWorldPos.xz - uCenter) / uPlaneHalfSize;
    float edgeT = max(t.x, t.y);
    float edgeFade = 1.0 - smoothstep(uCoreFrac, 1.0, edgeT);

    color = applyFog(color, vWorldPos);

    // Semi-transparent: fish swim below the surface (world Y < 0), and the
    // caustics-lit riverbed sits further below still — both need to show
    // through, so this can't be an opaque sheet the way a pool's water
    // surface is in the source demo.
    gl_FragColor = vec4(color, 0.8 * edgeFade);
  }
`;

export function buildWaterMesh(bounds, waterSimSize) {
  // Drawn WATER_SIZE_MULTIPLIER bigger than the river bounds, but
  // re-centered on the same center point, so the extra size grows evenly
  // past the edges rather than shifting the visible area.
  const {
    width: planeWidth,
    height: planeHeight,
    marginX,
    marginZ,
  } = waterWorldSize(bounds);
  const centerX = bounds.width / 2;
  const centerZ = bounds.height / 2;

  const geometry = new THREE.PlaneGeometry(planeWidth, planeHeight, 1, 1);
  geometry.rotateX(-Math.PI / 2);
  geometry.translate(centerX, 0, centerZ);

  const uniforms = {
    uWater: { value: null },
    uWorldSize: { value: new THREE.Vector2(planeWidth, planeHeight) },
    uMargin: { value: new THREE.Vector2(marginX, marginZ) },
    uTexel: { value: new THREE.Vector2(1 / waterSimSize, 1 / waterSimSize) },
    uBaseColor: { value: new THREE.Color("#0c3636") },
    uSkyColor: { value: new THREE.Color("#366374") },
    uCausticsStrength: { value: 30 },
    uCenter: { value: new THREE.Vector2(centerX, centerZ) },
    uPlaneHalfSize: {
      value: new THREE.Vector2(planeWidth / 2, planeHeight / 2),
    },
    // t-value (see fragment shader) where the real river bounds end —
    // exactly 1/WATER_SIZE_MULTIPLIER, since the plane is that much bigger.
    uCoreFrac: { value: 1 / WATER_SIZE_MULTIPLIER },
    uFogColor: { value: FOG_COLOR },
    uFogDensity: { value: fogDensity(bounds) },
  };

  const material = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: VERTEX_SHADER,
    fragmentShader: FRAGMENT_SHADER,
    transparent: true,
    depthWrite: false,
    // OrbitControls lets the camera go both above the surface and below it
    // (looking up from underwater) — without this the plane back-face
    // culls and disappears from whichever side isn't its default front face.
    side: THREE.DoubleSide,
  });

  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = "water";

  // The water sim's ping-pong texture swaps every frame — refresh the
  // uniform each frame (see main.js's loop).
  function setSources(waterTexture) {
    uniforms.uWater.value = waterTexture;
  }

  return { mesh, setSources };
}
