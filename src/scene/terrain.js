// terrain.js
// Design rationale, invariants, gotchas: .claude/context/scene/environment.md
// The riverbed: a flat plane below the water surface, drawing a color, a
// little mottling, and a fog falloff. Still the caustics *receiver* — see
// environment.md before deleting it from the environment map.

import * as THREE from "three";
import { EDGE_FADE_GLSL, glslFloat as f } from "./glsl.js";
import { FOG_GLSL, FOG_COLOR, fogDensity, fogDepthRate } from "./fog.js";
import { seasonForDay } from "./season.js";
import { waterWorldSize, waterSizeMultiplier } from "./water.js";

// Floor depth below the water surface, as a fraction of bounds.height. Was
// 0.5; see environment.md for why the bed was brought into the near field.
export const RIVER_DEPTH_FRAC = 0.34;

// Constant blend toward the fog color, applied after the distance falloff —
// unlike applyFog this never fully resolves, even under the camera.
const TERRAIN_HAZE = 0.86;

// Fine per-fragment mottling, deliberately near-invisible.
const SILT_NOISE_SCALE = 0.03;
const SILT_NOISE_STRENGTH = 0.1;

export function riverDepth(bounds) {
  return bounds.height * RIVER_DEPTH_FRAC;
}

const TERRAIN_VERTEX_SHADER = /* glsl */ `
  varying vec3 vWorldPos;

  void main() {
    // Geometry is already translated into world space at build time (see
    // buildTerrainMesh) and this mesh never itself moves, so the raw position
    // IS the world position the fog and edge fade need.
    vWorldPos = position;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const TERRAIN_FRAGMENT_SHADER = /* glsl */ `
  ${EDGE_FADE_GLSL}
  ${FOG_GLSL}

  uniform vec3 floorColor;
  uniform vec2 center;
  uniform vec2 planeHalfSize;
  uniform float coreFrac;

  varying vec3 vWorldPos;

  float siltHash(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
  }

  float siltNoise(vec2 p) {
    vec2 i = floor(p);
    vec2 fr = fract(p);
    vec2 u = fr * fr * (3.0 - 2.0 * fr);
    return mix(
      mix(siltHash(i), siltHash(i + vec2(1.0, 0.0)), u.x),
      mix(siltHash(i + vec2(0.0, 1.0)), siltHash(i + vec2(1.0, 1.0)), u.x),
      u.y
    );
  }

  void main() {
    float silt = siltNoise(vWorldPos.xz * ${f(SILT_NOISE_SCALE)});
    vec3 color = floorColor * (1.0 - ${f(SILT_NOISE_STRENGTH)} * 0.5
      + ${f(SILT_NOISE_STRENGTH)} * silt);

    color = applyFog(color, vWorldPos);
    // fogColorAt(), not uFogColor: the bed is the deepest surface in the
    // scene, so it never resolves out of the depth ramp's dark end.
    color = mix(color, fogColorAt(vWorldPos), ${f(TERRAIN_HAZE)});

    // Alpha fade, not opaque — kept in the transparent queue. See
    // environment.md for why an opaque bed was tried and reverted.
    float edgeFade =
      planeEdgeFade(vWorldPos.xz, center, planeHalfSize, coreFrac);

    gl_FragColor = vec4(color, edgeFade);
  }
`;

export function buildTerrainMesh(bounds) {
  // Oversized and re-centered on bounds, like buildWaterMesh (see water.js),
  // so the edge dissolves into fog instead of cutting off as a hard line.
  const depth = riverDepth(bounds);
  const { width: planeWidth, height: planeHeight } = waterWorldSize(bounds);
  const centerX = bounds.width / 2;
  const centerZ = bounds.height / 2;

  // Two triangles — see environment.md for why this used to be ~23,000
  // vertices and no longer needs to be.
  const geometry = new THREE.PlaneGeometry(planeWidth, planeHeight, 1, 1);
  geometry.rotateX(-Math.PI / 2);
  geometry.translate(centerX, -depth, centerZ);
  // Nothing samples a texture here; the caustics environment pass reads
  // position only.
  geometry.deleteAttribute("uv");
  geometry.deleteAttribute("normal");

  const material = new THREE.ShaderMaterial({
    uniforms: {
      // Overwritten by setTerrainSeason(); this only shows before that runs.
      floorColor: { value: new THREE.Color("#213751") },
      uFogColor: { value: FOG_COLOR },
      uFogDensity: { value: fogDensity(bounds) },
      uFogDepthRate: { value: fogDepthRate(bounds) },
      center: { value: new THREE.Vector2(centerX, centerZ) },
      planeHalfSize: {
        value: new THREE.Vector2(planeWidth / 2, planeHeight / 2),
      },
      // t-value where the real river bounds end; matches buildWaterMesh's
      // uCoreFrac so both surfaces fade at the same real-world edge.
      coreFrac: { value: 1 / waterSizeMultiplier() },
    },
    vertexShader: TERRAIN_VERTEX_SHADER,
    fragmentShader: TERRAIN_FRAGMENT_SHADER,
    transparent: true,
    depthWrite: false,
  });

  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = "terrain";
  return mesh;
}

// Ties the riverbed's color to the same season driving the sky, water, and
// fish (see season.js's floorColor derivation).
export function setTerrainSeason(terrainMesh, dayOfYear) {
  const season = seasonForDay(dayOfYear);
  terrainMesh.material.uniforms.floorColor.value.copy(season.floorColor);
}
