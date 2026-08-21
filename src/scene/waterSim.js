// waterSim.js
// GPU height-field water simulation, ported from martinRenou/threejs-caustics
// (shaders/simulation/*.glsl). A ping-pong pair of render targets holds
// RGBA = (height, velocity, normal.x, normal.z) for a square sim grid;
// dropping "rain" onto it and relaxing it each frame via a discrete wave
// equation is what gives the caustics pass real ripples to refract through,
// instead of a canned procedural texture. Coordinate-system agnostic: the
// caller maps its own world (x, z) into the sim's [-1, 1] uv space.

import * as THREE from "three";

const VERTEX_SHADER = /* glsl */ `
  attribute vec3 position;
  varying vec2 coord;
  void main() {
    coord = position.xy * 0.5 + 0.5;
    gl_Position = vec4(position.xyz, 1.0);
  }
`;

const DROP_FRAGMENT_SHADER = /* glsl */ `
  precision highp float;
  const float PI = 3.141592653589793;
  uniform sampler2D texture;
  uniform vec2 center;
  uniform float radius;
  uniform float strength;
  uniform vec2 aspect;
  varying vec2 coord;

  void main() {
    // Raise the height (.r) at every texel by a smooth (cosine-eased) falloff
    // from center, scaled by strength — a single ripple impulse.
    vec4 info = texture2D(texture, coord);
    vec2 delta = (center * 0.5 + 0.5 - coord) * aspect;
    float drop = max(0.0, 1.0 - length(delta) / radius);
    drop = 0.5 - cos(drop * PI) * 0.5;
    info.r += drop * strength;
    gl_FragColor = info;
  }
`;

const UPDATE_FRAGMENT_SHADER = /* glsl */ `
  precision highp float;
  uniform sampler2D texture;
  uniform vec2 delta;
  varying vec2 coord;

  void main() {
    vec4 info = texture2D(texture, coord);

    // Discrete wave equation: pull height toward the 4-neighbor average
    // (that's the propagation), accumulate that pull into velocity (.g)
    // with a touch of damping so ripples fade out, then integrate height.
    // Both constants are tuned for a calm stretch of river: a lower
    // propagation factor spreads ripples out more slowly (sluggish, heavy
    // water rather than a jittery pond-drop), and lighter damping lets a
    // ripple travel further — grow into a broad, slow swell — before it
    // dies out instead of staying small and local.
    vec2 dx = vec2(delta.x, 0.0);
    vec2 dy = vec2(0.0, delta.y);
    float average = (
      texture2D(texture, coord - dx).r +
      texture2D(texture, coord - dy).r +
      texture2D(texture, coord + dx).r +
      texture2D(texture, coord + dy).r
    ) * 0.25;

    info.g += (average - info.r) * 0.9;
    info.g *= 0.9975;
    info.r += info.g;

    // Recompute the surface normal (.ba) from the local height gradient,
    // for the water/caustics shaders to light and refract against.
    vec3 ddx = vec3(delta.x, texture2D(texture, vec2(coord.x + delta.x, coord.y)).r - info.r, 0.0);
    vec3 ddy = vec3(0.0, texture2D(texture, vec2(coord.x, coord.y + delta.y)).r - info.r, delta.y);
    info.ba = normalize(cross(ddy, ddx)).xz;

    gl_FragColor = info;
  }
`;

export function createWaterSimulation(renderer, size, aspect) {
  const rtOptions = {
    type: THREE.HalfFloatType,
    depthBuffer: false,
    stencilBuffer: false,
  };

  const camera = new THREE.OrthographicCamera(0, 1, 1, 0, 0, 2000);
  const geometry = new THREE.PlaneGeometry(2, 2);

  let targetA = new THREE.WebGLRenderTarget(size, size, rtOptions);
  let targetB = new THREE.WebGLRenderTarget(size, size, rtOptions);
  let target = targetA;

  // Render targets start with undefined GPU memory, not zeros — clear both
  // explicitly so the first few frames don't refract/ray-march against
  // garbage height/normal data.
  {
    const previousTarget = renderer.getRenderTarget();
    renderer.setRenderTarget(targetA);
    renderer.setClearColor(0x000000, 0);
    renderer.clear();
    renderer.setRenderTarget(targetB);
    renderer.clear();
    renderer.setRenderTarget(previousTarget);
  }

  const dropMaterial = new THREE.RawShaderMaterial({
    uniforms: {
      center: { value: new THREE.Vector2() },
      radius: { value: 0 },
      strength: { value: 0 },
      aspect: { value: new THREE.Vector2(1, 1) },
      texture: { value: null },
    },
    vertexShader: VERTEX_SHADER,
    fragmentShader: DROP_FRAGMENT_SHADER,
  });

  const updateMaterial = new THREE.RawShaderMaterial({
    uniforms: {
      delta: { value: [1 / size, 1 / size] },
      texture: { value: null },
    },
    vertexShader: VERTEX_SHADER,
    fragmentShader: UPDATE_FRAGMENT_SHADER,
  });

  dropMaterial.uniforms.aspect.value.set(1, aspect);

  const dropMesh = new THREE.Mesh(geometry, dropMaterial);
  const updateMesh = new THREE.Mesh(geometry, updateMaterial);

  // Ping-pong helper: renders `mesh` (either the drop or the relax pass)
  // reading from the current target's texture and writing into the other
  // one, then swaps which target is "current" for the next call.
  function render(mesh) {
    const oldTarget = target;
    const newTarget = target === targetA ? targetB : targetA;

    const previousTarget = renderer.getRenderTarget();
    renderer.setRenderTarget(newTarget);
    mesh.material.uniforms.texture.value = oldTarget.texture;
    renderer.render(mesh, camera);
    renderer.setRenderTarget(previousTarget);

    target = newTarget;
  }

  // Adds a single "raindrop" disturbance to the height field at `center`.
  // center: {x, z} in [-1, 1] sim-space. radius/strength: sim-space units.
  // Written into the existing Vector2 rather than swapping in a fresh array,
  // so a drop allocates nothing.
  function addDrop(center, radius, strength) {
    dropMaterial.uniforms.center.value.set(center.x, center.z);
    dropMaterial.uniforms.radius.value = radius;
    dropMaterial.uniforms.strength.value = strength;
    render(dropMesh);
  }

  // Advances the simulation by one discrete wave-equation relaxation step.
  function step() {
    render(updateMesh);
  }

  function dispose() {
    targetA.dispose();
    targetB.dispose();
    geometry.dispose();
    dropMaterial.dispose();
    updateMaterial.dispose();
  }

  return {
    addDrop,
    step,
    dispose,
    get texture() {
      return target.texture;
    },
  };
}
