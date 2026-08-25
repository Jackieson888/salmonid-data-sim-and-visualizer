// causticsGenerator.js — real-time caustics: env map of the riverbed + a
// refraction ray-march, run every frame after the water sim steps.
// Design rationale, invariants, gotchas: .claude/context/scene/water-and-caustics.md
import * as THREE from "three";
import { waterWorldSize, WATER_HEIGHT_SCALE } from "./water.js";
import { riverDepth } from "./terrain.js";
import { WATER_NORMAL_GLSL } from "./glsl.js";
import { QUALITY } from "../quality.js";

// Cost knobs, all device-tier scaled (quality.js) — this pass is the most
// expensive thing in the frame (vertex count O(segments^2), each running up
// to maxIterations texture fetches), so it's also the one tiers give back
// first. The low tier skips constructing this generator entirely (see
// createWorld in main.js) in favor of glsl.js's procedural stand-in.
const causticsMeshSegments = () => QUALITY.causticsSegments;
const envMapSize = () => QUALITY.causticsEnvSize;

// Read by main.js to size water.js's causticGlow() blur texel to this
// texture's actual resolution.
export const causticsTargetSize = () => QUALITY.causticsTargetSize;

// Ray-march step count, as env-map texels — must be compile-time (WebGL
// forbids while-loops). Renou's demo uses 50 at his 1024 env map size.
const maxIterations = () => QUALITY.causticsIterations;

// Air -> water refractive index ratio (1 / 1.333), same as Renou's shader.
const ETA = 0.7504;

// Scales the RATIO_CAP-bounded area-ratio into brightness. Renou hardcodes 0.15.
const CAUSTICS_FACTOR = 0.15;

const ENV_VERTEX_SHADER = /* glsl */ `
  varying vec3 vWorldPosition;
  varying float vDepth;

  void main() {
    vec4 worldPosition = modelMatrix * vec4(position, 1.0);
    vWorldPosition = worldPosition.xyz;

    vec4 projected = projectionMatrix * viewMatrix * worldPosition;
    vDepth = projected.z;

    gl_Position = projected;
  }
`;

const ENV_FRAGMENT_SHADER = /* glsl */ `
  varying vec3 vWorldPosition;
  varying float vDepth;

  void main() {
    gl_FragColor = vec4(vWorldPosition, vDepth);
  }
`;

// Ported from shaders/caustics/water_vertex.glsl. `position.xy` holds this
// vertex's rest-position world (x, z) directly (see buildCausticsGeometry).
// A function, not a module-level string: the march length is a tier setting
// (quality.js) interpolated in at material build time.
const causticsVertexShader = () => /* glsl */ `
  ${WATER_NORMAL_GLSL}

  uniform vec3 light;
  uniform sampler2D water;
  uniform sampler2D env;
  uniform float deltaEnvTexture;
  uniform vec2 worldSize;
  uniform vec2 margin;

  varying vec3 vOldPosition;
  varying vec3 vNewPosition;
  varying float vWaterDepth;
  varying float vDepth;

  void main() {
    vec2 worldXZ = position.xy;
    vec2 uv = (worldXZ + margin) / worldSize;
    vec4 waterInfo = texture2D(water, uv);

    vec3 waterPosition = vec3(worldXZ.x, waterInfo.r * ${WATER_HEIGHT_SCALE.toFixed(1)}, worldXZ.y);
    // Same normal reconstruction water.js lights the surface with — refracted through here.
    vec3 waterNormal = waterSurfaceNormal(waterInfo);

    vOldPosition = waterPosition;

    vec4 projectedWaterPosition = projectionMatrix * viewMatrix * vec4(waterPosition, 1.0);

    vec2 currentPosition = projectedWaterPosition.xy;
    vec2 coords = 0.5 + 0.5 * currentPosition;

    vec3 refracted = refract(light, waterNormal, ${ETA.toFixed(4)});
    // w=0 (direction transform), not w=1 like the reference source — our
    // light camera sits hundreds of world units up, where w=1's translation
    // bake-in would drown out the refraction. See context doc.
    vec4 projectedRefractionVector = projectionMatrix * viewMatrix * vec4(refracted, 0.0);

    vWaterDepth = 0.5 + 0.5 * projectedWaterPosition.z / projectedWaterPosition.w;
    float currentDepth = projectedWaterPosition.z;
    vec4 environment = texture2D(env, coords);

    float factor = deltaEnvTexture / length(projectedRefractionVector.xy);
    vec2 deltaDirection = projectedRefractionVector.xy * factor;
    float deltaDepth = projectedRefractionVector.z * factor;

    for (int i = 0; i < ${maxIterations()}; i++) {
      currentPosition += deltaDirection;
      currentDepth += deltaDepth;

      if (environment.w <= currentDepth) {
        break;
      }

      environment = texture2D(env, 0.5 + 0.5 * currentPosition);
    }

    vNewPosition = environment.xyz;

    vec4 projectedEnvPosition = projectionMatrix * viewMatrix * vec4(vNewPosition, 1.0);
    vDepth = 0.5 + 0.5 * projectedEnvPosition.z / projectedEnvPosition.w;

    gl_Position = projectedEnvPosition;
  }
`;

// Ported from shaders/caustics/water_fragment.glsl, but RATIO_CAP replaces
// the reference's unbounded 2e20 sentinel — see context doc for why (a plain
// box blur plus additive accumulation would let that sentinel swamp the output).
const RATIO_CAP = 400.0;

const CAUSTICS_FRAGMENT_SHADER = /* glsl */ `
  varying vec3 vOldPosition;
  varying vec3 vNewPosition;
  varying float vWaterDepth;
  varying float vDepth;

  void main() {
    float causticsIntensity = 0.0;

    if (vDepth >= vWaterDepth) {
      float oldArea = length(dFdx(vOldPosition)) * length(dFdy(vOldPosition));
      float newArea = length(dFdx(vNewPosition)) * length(dFdy(vNewPosition));

      float ratio;
      if (newArea < oldArea / ${RATIO_CAP.toFixed(1)}) {
        ratio = ${RATIO_CAP.toFixed(1)};
      } else {
        ratio = oldArea / newArea;
      }

      causticsIntensity = ${CAUSTICS_FACTOR.toFixed(3)} * ratio;
    }

    gl_FragColor = vec4(causticsIntensity, 0.0, 0.0, vDepth);
  }
`;

// Straight-down orthographic camera over the same oversized, bounds-centered
// area water.js/terrain.js render into — see context doc for why
// straight-down rather than along the real sun direction.
function buildLightCamera(bounds, coverage) {
  const { width: planeWidth, height: planeHeight } = coverage;
  const centerX = coverage.centerX;
  const centerZ = coverage.centerZ;
  const depth = riverDepth(bounds);

  const camHeight = depth + 600;
  const camera = new THREE.OrthographicCamera(
    -planeWidth / 2,
    planeWidth / 2,
    planeHeight / 2,
    -planeHeight / 2,
    camHeight - 400,
    camHeight + depth + 200,
  );
  camera.position.set(centerX, camHeight, centerZ);
  camera.up.set(0, 0, -1);
  camera.lookAt(centerX, 0, centerZ);
  camera.updateMatrixWorld(true);
  camera.updateProjectionMatrix();
  return camera;
}

// Flat (unrotated) plane whose position.xy holds rest-position world (x, z)
// directly — unlike buildWaterMesh/buildTerrainMesh, never rotated into the
// real 3D XZ plane since it's only ever rasterized through the light camera.
function buildCausticsGeometry(coverage) {
  const { width: planeWidth, height: planeHeight } = coverage;
  const centerX = coverage.centerX;
  const centerZ = coverage.centerZ;
  const segments = causticsMeshSegments();

  const geometry = new THREE.PlaneGeometry(
    planeWidth,
    planeHeight,
    segments,
    segments,
  );
  geometry.translate(centerX, centerZ, 0);
  return geometry;
}

function makeTarget(size) {
  return new THREE.WebGLRenderTarget(size, size, {
    type: THREE.HalfFloatType,
    depthBuffer: false,
    stencilBuffer: false,
  });
}

export function createCausticsGenerator(renderer, bounds, terrainMesh, coverage) {
  // `coverage` is the caustics pass's own, shorter reach (causticsWorldSize
  // in water.js) — sets the light camera's frustum and the refraction grid's
  // extent.
  const lightCamera = buildLightCamera(bounds, coverage);

  // The water SIM's (larger) coverage — the vertex shader must sample the
  // height field through this mapping, not `coverage`, or it refracts
  // against the wrong part of the surface. See context doc.
  const { width: planeWidth, height: planeHeight, marginX, marginZ } =
    waterWorldSize(bounds);

  const envMapTarget = makeTarget(envMapSize());
  const causticsTarget = makeTarget(causticsTargetSize());

  // Shares terrainMesh's (already world-baked) geometry rather than cloning
  // it, so this pass tracks whatever shape the riverbed has. A separate Mesh
  // since adding the riverbed itself here would reparent it out of the main scene.
  const envMaterial = new THREE.ShaderMaterial({
    vertexShader: ENV_VERTEX_SHADER,
    fragmentShader: ENV_FRAGMENT_SHADER,
  });
  const envMesh = new THREE.Mesh(terrainMesh.geometry, envMaterial);

  const causticsMaterial = new THREE.ShaderMaterial({
    uniforms: {
      light: { value: new THREE.Vector3(0, -1, 0) },
      water: { value: null },
      env: { value: envMapTarget.texture },
      deltaEnvTexture: { value: 1 / envMapSize() },
      worldSize: { value: new THREE.Vector2(planeWidth, planeHeight) },
      margin: { value: new THREE.Vector2(marginX, marginZ) },
    },
    vertexShader: causticsVertexShader(),
    fragmentShader: CAUSTICS_FRAGMENT_SHADER,
    transparent: true,
    side: THREE.DoubleSide,
  });
  // Additive accumulation: overlapping refracted triangles sum brightness.
  // Depth (alpha) is just the latest write, not summed.
  causticsMaterial.blending = THREE.CustomBlending;
  causticsMaterial.blendEquation = THREE.AddEquation;
  causticsMaterial.blendSrc = THREE.OneFactor;
  causticsMaterial.blendDst = THREE.OneFactor;
  causticsMaterial.blendEquationAlpha = THREE.AddEquation;
  causticsMaterial.blendSrcAlpha = THREE.OneFactor;
  causticsMaterial.blendDstAlpha = THREE.ZeroFactor;

  const causticsGeometry = buildCausticsGeometry(coverage);
  const causticsMesh = new THREE.Mesh(causticsGeometry, causticsMaterial);

  const black = new THREE.Color(0, 0, 0);
  // Hoisted out of render() (which runs every frame) to avoid GC pressure.
  const previousClearColor = new THREE.Color();

  // Renders `mesh` into `target` through the light camera, leaving the
  // renderer's target and clear color exactly as it found them.
  function renderToTarget(mesh, target) {
    const previousTarget = renderer.getRenderTarget();
    renderer.getClearColor(previousClearColor);
    const previousClearAlpha = renderer.getClearAlpha();

    renderer.setRenderTarget(target);
    renderer.setClearColor(black, 0);
    renderer.clear();
    renderer.render(mesh, lightCamera);

    renderer.setRenderTarget(previousTarget);
    renderer.setClearColor(previousClearColor, previousClearAlpha);
  }

  // Only the caustics accumulation pass runs per frame — see renderEnvMap().
  function render(waterTexture) {
    causticsMaterial.uniforms.water.value = waterTexture;
    renderToTarget(causticsMesh, causticsTarget);
  }

  // The environment map is rendered ONCE, here, not every frame.
  //
  // It stores the receiver geometry's world position + depth per texel, and
  // every input to that is static. Re-rendering it per frame (as this used
  // to do) re-rasterized a byte-identical texture 60 times a second. A resize
  // disposes this whole generator and rebuilds it, which re-runs this once.
  function renderEnvMap() {
    renderToTarget(envMesh, envMapTarget);
  }

  renderEnvMap();

  // Pushed every frame from main.js's loop (the sun moves within the day too
  // — sweptSunDirection in season.js), which is what slides the light net
  // across the bed. Negated: refract()'s `I` wants travel direction, while
  // season.sunDirection points toward the sun.
  function setSunDirection(direction) {
    causticsMaterial.uniforms.light.value.copy(direction).multiplyScalar(-1);
  }

  function dispose() {
    envMapTarget.dispose();
    causticsTarget.dispose();
    causticsGeometry.dispose();
    envMaterial.dispose();
    causticsMaterial.dispose();
  }

  return {
    render,
    renderEnvMap,
    setSunDirection,
    dispose,
    get texture() {
      return causticsTarget.texture;
    },
  };
}
