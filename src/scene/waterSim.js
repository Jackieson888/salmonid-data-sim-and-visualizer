// GPU height-field water sim using ping-pong render targets.
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
    // Raise height (.r) by a cosine-eased falloff from center — a ripple impulse.
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

    // Discrete wave equation: pull height toward the 4-neighbor average, damp into velocity (.g), integrate height.
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

    // Recompute surface normal (.ba) from the local height gradient.
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

  // Render targets start with undefined GPU memory — clear both, saving/restoring the renderer's global clear color.
  {
    const previousTarget = renderer.getRenderTarget();
    const previousClearColor = new THREE.Color();
    renderer.getClearColor(previousClearColor);
    const previousClearAlpha = renderer.getClearAlpha();

    renderer.setRenderTarget(targetA);
    renderer.setClearColor(0x000000, 0);
    renderer.clear();
    renderer.setRenderTarget(targetB);
    renderer.clear();

    renderer.setRenderTarget(previousTarget);
    renderer.setClearColor(previousClearColor, previousClearAlpha);
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

  // Renders `mesh` reading from the current target and writing the other, then swaps.
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

  // center: {x, z} in [-1, 1] sim-space; writes into the existing Vector2 so a drop allocates nothing.
  function addDrop(center, radius, strength) {
    dropMaterial.uniforms.center.value.set(center.x, center.z);
    dropMaterial.uniforms.radius.value = radius;
    dropMaterial.uniforms.strength.value = strength;
    render(dropMesh);
  }

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
