// water.js
// Water surface: a flat plane at world Y=0 spanning the river bounds,
// fragment-shaded from the live GPU height-field simulation in waterSim.js
// (real ripples, not a canned texture) and lit by the same causticGlow()
// helper terrain.js uses (see causticsChunk.js), so the sparkle on the
// surface and the light net on the riverbed come from one consistent read
// of the same water texture.

import * as THREE from "three";
import { CAUSTIC_GLOW_GLSL } from "./causticsChunk.js";

const VERTEX_SHADER = /* glsl */ `
  varying vec3 vWorldPos;
  void main() {
    vWorldPos = position;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const FRAGMENT_SHADER = /* glsl */ `
  ${CAUSTIC_GLOW_GLSL}

  uniform sampler2D uWater;
  uniform vec2 uWorldSize;
  uniform vec2 uTexel;
  uniform vec3 uBaseColor;
  uniform vec3 uSkyColor;
  uniform float uCausticsStrength;

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

    // Same causticGlow() read terrain.js uses, at this same point — the
    // surface glints with the same light pattern that lands underwater
    // instead of an unrelated procedural shimmer.
    float glint = min(causticGlow(uWater, uv, uTexel) * uCausticsStrength, 1.4);
    color += vec3(0.75, 0.92, 0.98) * glint * 0.35;

    // Semi-transparent: fish swim below the surface (world Y < 0), and the
    // caustics-lit riverbed sits further below still — both need to show
    // through, so this can't be an opaque sheet the way a pool's water
    // surface is in the source demo.
    gl_FragColor = vec4(color, 0.8);
  }
`;

export function buildWaterMesh(bounds, waterSimSize) {
  const geometry = new THREE.PlaneGeometry(bounds.width, bounds.height, 1, 1);
  geometry.rotateX(-Math.PI / 2);
  geometry.translate(bounds.width / 2, 0, bounds.height / 2);

  const uniforms = {
    uWater: { value: null },
    uWorldSize: { value: new THREE.Vector2(bounds.width, bounds.height) },
    uTexel: { value: new THREE.Vector2(1 / waterSimSize, 1 / waterSimSize) },
    uBaseColor: { value: new THREE.Color("#0c3636") },
    uSkyColor: { value: new THREE.Color("#366374") },
    uCausticsStrength: { value: 60 },
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
