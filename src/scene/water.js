// water.js
// Water surface: a flat plane at world Y=0 spanning the river bounds,
// fragment-shaded from the live GPU height-field simulation in waterSim.js
// (real ripples, not a canned texture) and lit by the same causticsTexture
// the terrain reads in terrain.js, so the sparkle on the surface and the
// light net on the riverbed come from one consistent simulation.

import * as THREE from "three";

const VERTEX_SHADER = /* glsl */ `
  varying vec3 vWorldPos;
  void main() {
    vWorldPos = position;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const FRAGMENT_SHADER = /* glsl */ `
  uniform sampler2D uWater;
  uniform sampler2D uCaustics;
  uniform vec2 uWorldSize;
  uniform vec3 uBaseColor;
  uniform vec3 uSkyColor;
  uniform mat4 uLightProjectionMatrix;
  uniform mat4 uLightViewMatrix;

  varying vec3 vWorldPos;

  void main() {
    // Sample the live height-field sim for this point's surface normal
    // (stored in the .ba channels — see waterSim.js's UPDATE_FRAGMENT_SHADER).
    vec2 uv = vWorldPos.xz / uWorldSize;
    vec4 info = texture2D(uWater, uv);
    vec3 normal = normalize(vec3(info.b, sqrt(max(0.0, 1.0 - dot(info.ba, info.ba))), info.a));

    // Fresnel: water looks more like a mirror (sky-colored) at grazing
    // angles and more like its base color when viewed head-on.
    vec3 viewDir = normalize(cameraPosition - vWorldPos);
    float fresnel = pow(1.0 - clamp(dot(normal, viewDir), 0.0, 1.0), 3.0);
    vec3 color = mix(uBaseColor, uSkyColor, fresnel * 0.6);

    // Sample the same caustics texture the riverbed uses, offset by the
    // surface normal, so the surface glints with the same light pattern
    // that lands underwater instead of an unrelated procedural shimmer.
    vec3 samplePos = vWorldPos + vec3(normal.x, 0.0, normal.z) * 6.0;
    vec4 lightSpace = uLightProjectionMatrix * uLightViewMatrix * vec4(samplePos, 1.0);
    vec2 causticUv = vec2(0.5) + 0.5 * lightSpace.xy / lightSpace.w;
    float glint = min(texture2D(uCaustics, causticUv).x, 1.4);

    color += vec3(0.75, 0.92, 0.98) * glint * 0.35;

    // Semi-transparent: fish swim below the surface (world Y < 0), and the
    // caustics-lit riverbed sits further below still — both need to show
    // through, so this can't be an opaque sheet the way a pool's water
    // surface is in the source demo.
    gl_FragColor = vec4(color, 0.8);
  }
`;

export function buildWaterMesh(bounds) {
  const geometry = new THREE.PlaneGeometry(bounds.width, bounds.height, 1, 1);
  geometry.rotateX(-Math.PI / 2);
  geometry.translate(bounds.width / 2, 0, bounds.height / 2);

  const uniforms = {
    uWater: { value: null },
    uCaustics: { value: null },
    uWorldSize: { value: new THREE.Vector2(bounds.width, bounds.height) },
    uBaseColor: { value: new THREE.Color("#0c2836") },
    uSkyColor: { value: new THREE.Color("#5fa9c4") },
    uLightProjectionMatrix: { value: new THREE.Matrix4() },
    uLightViewMatrix: { value: new THREE.Matrix4() },
  };

  const material = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: VERTEX_SHADER,
    fragmentShader: FRAGMENT_SHADER,
    transparent: true,
    depthWrite: false,
  });

  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = "water";

  // Wires the same water-height texture and caustics pipeline the terrain
  // uses into this mesh's material.
  function setSources(waterTexture, causticsPipeline) {
    uniforms.uWater.value = waterTexture;
    uniforms.uCaustics.value = causticsPipeline.texture;
    uniforms.uLightProjectionMatrix.value.copy(causticsPipeline.lightCamera.projectionMatrix);
    uniforms.uLightViewMatrix.value.copy(causticsPipeline.lightCamera.matrixWorldInverse);
  }

  return { mesh, setSources };
}
