// terrain.js
// The riverbed: a flat plane below the water surface that falls away into the
// murk. It is silt, not scenery — deliberately the least interesting surface
// in the scene, there to close off the bottom of the frame and give fish
// silhouettes something to read against rather than an empty gradient.
//
// It used to be a great deal more: a tessellated plane carrying per-vertex
// shade jitter, with a fragment shader that built two Voronoi layers of cobble
// and gravel, synthesized per-stone normals, and applied three hand-tuned
// corrections (parallax, light wrap, seam occlusion) to fake what caustics do
// when they land on real relief. Roughly 400 lines, essentially all of it
// erased by a third of the way across the channel — the fog (see fog.js) is
// tuned to a shallow inland river where visibility is a few body lengths — and
// where it did survive, in the near field, a fully resolved gravel bed pulled
// attention off the fish, which are the subject.
//
// What's left is a color, a little mottling, and a fog falloff.
//
// IMPORTANT: this plane is still the caustics *receiver*, even though it draws
// no caustics itself. It stays in the environment map (see
// causticsGenerator.js) as the surface the refracted rays terminate against —
// delete it from that pass and the accumulated light net loses its structure,
// which would break the glint on the water surface and on the fish. The
// caustics you can actually see are on those two things only.

import * as THREE from "three";
import { EDGE_FADE_GLSL, glslFloat as f } from "./glsl.js";
import { FOG_GLSL, FOG_COLOR, fogDensity, fogDepthRate } from "./fog.js";
import { seasonForDay } from "./season.js";
import { waterWorldSize, waterSizeMultiplier } from "./water.js";

// Floor depth below the water surface, as a fraction of bounds.height.
// Was 0.5, which put the bed far enough under the camera that the heavy
// river fog (see fog.js) erased it everywhere except a thin strip along the
// bottom of frame. A salmon run is shallow water anyway: this brings the bed
// and the surface both inside the near field, which is what lets a single shot
// hold a lit riverbed below and the bright surface above.
export const RIVER_DEPTH_FRAC = 0.34;

// Constant blend toward the fog color, applied after the distance falloff.
// Unlike applyFog this never resolves, even directly under the camera, so the
// bed reads as something glimpsed through silt rather than a surface the
// viewer is standing on. Raised from 0.75 now that there is no gravel detail
// to preserve: the bed's job is to recede.
const TERRAIN_HAZE = 0.86;

// Fine per-fragment mottling. This is the only surface detail left, and it is
// deliberately near-invisible — just enough that the bed isn't a dead flat
// wash of one color under the boulders.
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
    // scene, so the haze it never resolves out of is the dark end of the
    // depth ramp (see fog.js) rather than the mid-column color the water
    // surface overhead fades into.
    color = mix(color, fogColorAt(vWorldPos), ${f(TERRAIN_HAZE)});

    // Fully opaque out to coreFrac (exactly where the real river bounds end),
    // then a dissolve across the rest of the oversized plane — the same fade,
    // at the same edge, that the water surface uses overhead (see
    // planeEdgeFade in glsl.js).
    //
    // This stays an ALPHA fade, and the bed stays in the transparent queue.
    // Making it opaque was tried, to put one depth-writing surface ahead of
    // the transparent stack and give the god rays and silt behind it some
    // early-Z to reject against — this scene otherwise has no opaque pass at
    // all. It was reverted on both halves of the trade:
    //
    //   - The win is small here. Almost all of the shaft and silt geometry
    //     stands in the water column ABOVE the bed, not behind it, so there is
    //     very little for the bed to reject.
    //   - The cost is visible. An opaque bed hides the sky sphere completely
    //     below the horizon, and the color it has to dissolve into instead —
    //     fogColorAt() at the bed's own depth — is darker than the sky it used
    //     to blend against, which puts a tonal step across the far edge of the
    //     plane exactly where the fade exists to avoid one.
    float edgeFade =
      planeEdgeFade(vWorldPos.xz, center, planeHalfSize, coreFrac);

    gl_FragColor = vec4(color, edgeFade);
  }
`;

export function buildTerrainMesh(bounds) {
  // Drawn oversized and re-centered on bounds, exactly like buildWaterMesh
  // (see water.js): the extra size pushes the plane's rectangular edge out
  // past where fog has already saturated to uFogColor, so the edge dissolves
  // into the murk instead of showing up as a hard silhouette line.
  const depth = riverDepth(bounds);
  const { width: planeWidth, height: planeHeight } = waterWorldSize(bounds);
  const centerX = bounds.width / 2;
  const centerZ = bounds.height / 2;

  // Two triangles. The old mesh was tessellated to roughly 23,000 vertices,
  // and the only thing that needed them was a per-vertex brightness jitter
  // that read as blocky up close anyway — nothing else in either shader that
  // touches this geometry (here, or the caustics environment pass) varies
  // non-linearly across it, and a flat plane interpolates world position
  // exactly from its corners.
  const geometry = new THREE.PlaneGeometry(planeWidth, planeHeight, 1, 1);
  geometry.rotateX(-Math.PI / 2);
  geometry.translate(centerX, -depth, centerZ);
  // Nothing samples a texture on this surface, and the caustics environment
  // pass reads position only.
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
      // t-value (see fragment shader) where the real river bounds end —
      // exactly 1/waterSizeMultiplier(), since the plane is that much bigger.
      // Matches buildWaterMesh's uCoreFrac so both surfaces start fading at
      // the same real-world edge.
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

// Ties the riverbed's color to the same season driving the sky, water surface,
// rocks, and fish. season.floorColor comes off the same sky/depths derivation
// as the fog (see season.js), which is what keeps the bed from sitting in a
// different color family than the haze it dissolves into.
export function setTerrainSeason(terrainMesh, dayOfYear) {
  const season = seasonForDay(dayOfYear);
  terrainMesh.material.uniforms.floorColor.value.copy(season.floorColor);
}
