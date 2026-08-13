// terrain.js
// Flat riverbed floor: a simple plane sitting below the water surface that
// exists mainly to catch the stylized caustic glow (see causticsChunk.js).
// No banks or island — fish swim through the open water column above it.

import * as THREE from "three";
import { CAUSTIC_GLOW_GLSL } from "./causticsChunk.js";
import { FOG_GLSL, FOG_COLOR, fogDensity } from "./fog.js";
import { seasonForDay } from "./season.js";

export const RIVER_DEPTH_FRAC = 0.5; // floor depth below the water surface, as a fraction of bounds.height

const GRID_STEP = 20; // world units per floor vertex — just enough for gentle per-vertex color noise

const FLOOR_COLOR = new THREE.Color("#152423");
const COLOR_NOISE = 0.05; // per-vertex brightness jitter, keeps the floor from reading as flat-shaded

export function riverDepth(bounds) {
  return bounds.height * RIVER_DEPTH_FRAC;
}

export function buildTerrainMesh(bounds, waterSimSize) {
  // A flat, subdivided plane sitting `depth` world units below the water
  // surface, rotated to lie horizontal (X/Z) and translated so it spans
  // [0, bounds.width] x [0, bounds.height] instead of being centered on origin.
  const depth = riverDepth(bounds);
  const cols = Math.max(2, Math.round(bounds.width / GRID_STEP));
  const rows = Math.max(2, Math.round(bounds.height / GRID_STEP));
  const geometry = new THREE.PlaneGeometry(
    bounds.width,
    bounds.height,
    cols,
    rows,
  );
  geometry.rotateX(-Math.PI / 2);
  geometry.translate(bounds.width / 2, -depth, bounds.height / 2);

  // Per-vertex color jitter around FLOOR_COLOR, so the floor reads as a
  // textured surface rather than one flat-shaded polygon.
  const position = geometry.attributes.position;
  const colors = new Float32Array(position.count * 3);
  const color = new THREE.Color();

  for (let i = 0; i < position.count; i++) {
    const jitter = 1 + (Math.random() * 2 - 1) * COLOR_NOISE;
    color.copy(FLOOR_COLOR).multiplyScalar(jitter);
    colors[i * 3] = color.r;
    colors[i * 3 + 1] = color.g;
    colors[i * 3 + 2] = color.b;
  }
  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  geometry.computeVertexNormals();

  const material = buildTerrainMaterial(bounds, waterSimSize);

  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = "terrain";
  return mesh;
}

const TERRAIN_VERTEX_SHADER = /* glsl */ `
  attribute vec3 color;

  uniform vec3 sunDir;

  varying vec3 vColor;
  varying float vLightIntensity;
  varying vec3 vWorldPos;

  void main() {
    vColor = color;

    // Standard Lambertian term against the scene sun, for the toon-banded diffuse below.
    vec3 worldNormal = normalize(mat3(modelMatrix) * normal);
    vLightIntensity = max(dot(worldNormal, sunDir), 0.0);

    // Geometry is already translated into world space at build time (see
    // buildTerrainMesh) and this mesh never itself moves, so the raw
    // position IS the world position the caustic glow/fog need.
    vWorldPos = position;

    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const TERRAIN_FRAGMENT_SHADER = /* glsl */ `
  ${CAUSTIC_GLOW_GLSL}
  ${FOG_GLSL}

  uniform sampler2D water;
  uniform vec2 worldSize;
  uniform vec2 texel;
  uniform vec3 causticsColor;
  uniform float causticsStrength;

  varying vec3 vColor;
  varying float vLightIntensity;
  varying vec3 vWorldPos;

  void main() {
    // Toon-ish quantized diffuse, three bands.
    float band = vLightIntensity > 0.72 ? 1.0 : (vLightIntensity > 0.4 ? 0.78 : 0.6);
    vec3 base = vColor * (0.45 + 0.55 * band);

    vec2 uv = vWorldPos.xz / worldSize;
    float glow = min(causticGlow(water, uv, texel) * causticsStrength, 1.4);

    vec3 color = base + causticsColor * glow;
    color = applyFog(color, vWorldPos);
    gl_FragColor = vec4(color, 1.0);
  }
`;

function buildTerrainMaterial(bounds, waterSimSize) {
  return new THREE.ShaderMaterial({
    uniforms: {
      water: { value: null },
      worldSize: { value: new THREE.Vector2(bounds.width, bounds.height) },
      texel: { value: new THREE.Vector2(1 / waterSimSize, 1 / waterSimSize) },
      causticsColor: { value: new THREE.Color(0.55, 0.95, 0.85) },
      causticsStrength: { value: 20 },
      sunDir: { value: new THREE.Vector3(0.4, 1, 0.25).normalize() },
      uFogColor: { value: FOG_COLOR },
      uFogDensity: { value: fogDensity(bounds) },
    },
    vertexShader: TERRAIN_VERTEX_SHADER,
    fragmentShader: TERRAIN_FRAGMENT_SHADER,
  });
}

// Feeds the terrain material the water sim's current height/normal texture
// (its ping-pong target swaps every frame, so this needs to run every frame
// — see main.js's loop). No light camera, no separate caustics render pass:
// the glow is sampled straight from the water texture (see causticsChunk.js).
export function setTerrainWaterTexture(terrainMesh, waterTexture) {
  terrainMesh.material.uniforms.water.value = waterTexture;
}

// Ties the riverbed's caustic glow (and sun direction) to the same season
// driving the sky/sun, water surface, and fish (see sceneSetup.js/
// water.js/fishMesh.js) — called from main.js whenever the displayed date
// changes.
export function setTerrainSeason(terrainMesh, dayOfYear) {
  const season = seasonForDay(dayOfYear);
  terrainMesh.material.uniforms.causticsColor.value.copy(
    season.causticsColor1,
  );
  terrainMesh.material.uniforms.sunDir.value.copy(season.sunDirection);
}
