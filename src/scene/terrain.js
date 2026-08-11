// terrain.js
// Flat riverbed floor, in the spirit of martinRenou/threejs-caustics' pool
// floor: a simple plane sitting below the water surface that exists mainly
// to catch the caustics pass (see scene/caustics.js). No banks or island —
// fish swim through the open water column above it.

import * as THREE from "three";

export const RIVER_DEPTH_FRAC = 0.1; // floor depth below the water surface, as a fraction of bounds.height

const GRID_STEP = 40; // world units per floor vertex — just enough for gentle per-vertex color noise

const FLOOR_COLOR = new THREE.Color("#16394a");
const COLOR_NOISE = 0.05; // per-vertex brightness jitter, keeps the floor from reading as flat-shaded

export function riverDepth(bounds) {
  return bounds.height * RIVER_DEPTH_FRAC;
}

export function buildTerrainMesh(bounds) {
  // A flat, subdivided plane sitting `depth` world units below the water
  // surface, rotated to lie horizontal (X/Z) and translated so it spans
  // [0, bounds.width] x [0, bounds.height] instead of being centered on origin.
  const depth = riverDepth(bounds);
  const cols = Math.max(2, Math.round(bounds.width / GRID_STEP));
  const rows = Math.max(2, Math.round(bounds.height / GRID_STEP));
  const geometry = new THREE.PlaneGeometry(bounds.width, bounds.height, cols, rows);
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

  const material = buildTerrainMaterial();

  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = "terrain";
  return mesh;
}

const TERRAIN_VERTEX_SHADER = /* glsl */ `
  attribute vec3 color;

  uniform mat4 lightProjectionMatrix;
  uniform mat4 lightViewMatrix;
  uniform vec3 sunDir;

  varying vec3 vColor;
  varying float vLightIntensity;
  varying vec3 vLightSpacePos;

  void main() {
    vColor = color;

    // Standard Lambertian term against the scene sun, for the toon-banded diffuse below.
    vec3 worldNormal = normalize(mat3(modelMatrix) * normal);
    vLightIntensity = max(dot(worldNormal, sunDir), 0.0);

    // Project this vertex into the caustics light camera's clip space so the
    // fragment shader can sample the caustics texture at the matching texel.
    vec4 lightSpace = lightProjectionMatrix * lightViewMatrix * modelMatrix * vec4(position, 1.0);
    vLightSpacePos = vec3(0.5) + 0.5 * lightSpace.xyz / lightSpace.w;

    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const TERRAIN_FRAGMENT_SHADER = /* glsl */ `
  uniform sampler2D caustics;
  uniform vec3 causticsColor;
  uniform vec2 causticsResolution;

  varying vec3 vColor;
  varying float vLightIntensity;
  varying vec3 vLightSpacePos;

  const float bias = 0.02;

  float blur(vec2 uv, vec2 direction) {
    vec2 off1 = vec2(1.3846153846) * direction;
    vec2 off2 = vec2(3.2307692308) * direction;
    float intensity = texture2D(caustics, uv).x * 0.2270270270;
    intensity += texture2D(caustics, uv + off1 / causticsResolution).x * 0.3162162162;
    intensity += texture2D(caustics, uv - off1 / causticsResolution).x * 0.3162162162;
    intensity += texture2D(caustics, uv + off2 / causticsResolution).x * 0.0702702703;
    intensity += texture2D(caustics, uv - off2 / causticsResolution).x * 0.0702702703;
    return intensity;
  }

  void main() {
    // Toon-ish quantized diffuse, three bands.
    float band = vLightIntensity > 0.72 ? 1.0 : (vLightIntensity > 0.4 ? 0.78 : 0.6);
    vec3 base = vColor * (0.45 + 0.55 * band);

    // Only add the caustics glow where this fragment is actually the
    // closest surface to the light (depth test against the stored terrain
    // depth map), so the net of light doesn't bleed through occluded areas.
    float causticsDepth = texture2D(caustics, vLightSpacePos.xy).w;
    float glow = 0.0;
    if (causticsDepth > vLightSpacePos.z - bias) {
      // Soften the accumulated caustics texture with a small 2-tap blur
      // (horizontal + vertical) so individual triangle-scale hotspots merge
      // into a smoother net-of-light look.
      glow = 0.5 * (blur(vLightSpacePos.xy, vec2(0.0, 0.5)) + blur(vLightSpacePos.xy, vec2(0.5, 0.0)));
    }
    glow = min(glow, 1.4);

    vec3 color = base + causticsColor * glow;
    gl_FragColor = vec4(color, 1.0);
  }
`;

function buildTerrainMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: {
      caustics: { value: null },
      causticsColor: { value: new THREE.Color(0.55, 0.85, 0.95) },
      causticsResolution: { value: new THREE.Vector2(512, 512) },
      lightProjectionMatrix: { value: new THREE.Matrix4() },
      lightViewMatrix: { value: new THREE.Matrix4() },
      sunDir: { value: new THREE.Vector3(0.4, 1, 0.25).normalize() },
    },
    vertexShader: TERRAIN_VERTEX_SHADER,
    fragmentShader: TERRAIN_FRAGMENT_SHADER,
  });
}

// Wires the caustics render target + light camera produced by
// scene/caustics.js into an already-built terrain mesh's material.
export function applyCaustics(terrainMesh, causticsPipeline) {
  const uniforms = terrainMesh.material.uniforms;
  uniforms.caustics.value = causticsPipeline.texture;
  uniforms.causticsResolution.value.set(causticsPipeline.size, causticsPipeline.size);
  uniforms.lightProjectionMatrix.value.copy(causticsPipeline.lightCamera.projectionMatrix);
  uniforms.lightViewMatrix.value.copy(causticsPipeline.lightCamera.matrixWorldInverse);
}
