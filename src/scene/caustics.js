// caustics.js
// Real caustics pass, adapted from martinRenou/threejs-caustics
// (shaders/environment_mapping + shaders/caustics) to this project's
// Y-up world instead of the source demo's Z-up unit cube.
//
// Two render passes feed the terrain's causticsTexture:
//  1. TerrainDepthMap: an orthographic "light camera" looking straight down
//     renders the (static) terrain mesh's world position + clip-space depth
//     into a float target. Rendered once at startup/resize, not per frame,
//     since the terrain never moves.
//  2. CausticsPass: a flat grid mesh spanning the water's footprint is
//     displaced per-vertex by the live water-sim heightfield, then for each
//     vertex the light ray is refracted through the water normal and
//     ray-marched against the terrain depth map to find where it lands.
//     Triangle area distortion between the flat and ray-marched grids
//     (via dFdx/dFdy) gives the classic focused/spread caustic brightness,
//     accumulated additively into the caustics texture every frame.

import * as THREE from "three";

const ENV_VERTEX_SHADER = /* glsl */ `
  varying vec4 worldPosition;
  varying float depth;
  void main() {
    worldPosition = modelMatrix * vec4(position, 1.0);
    vec4 projected = projectionMatrix * viewMatrix * worldPosition;
    depth = projected.z;
    gl_Position = projected;
  }
`;

const ENV_FRAGMENT_SHADER = /* glsl */ `
  varying vec4 worldPosition;
  varying float depth;
  void main() {
    gl_FragColor = vec4(worldPosition.xyz, depth);
  }
`;

const CAUSTICS_VERTEX_SHADER = /* glsl */ `
  uniform sampler2D water;
  uniform sampler2D env;
  uniform vec3 lightDir;
  uniform float deltaEnv;
  uniform float waterAmplitude;
  uniform vec2 worldSize;

  varying vec3 oldPosition;
  varying vec3 newPosition;
  varying float waterDepth;
  varying float depth;
  varying vec2 finalNdc;

  const float eta = 0.7504;
  const int MAX_ITERATIONS = 40;

  void main() {
    // position is already baked into world XZ by the caller (flat plane,
    // rotated + translated at geometry-build time, matching terrain.js/water.js).
    vec4 waterInfo = texture2D(water, position.xz / worldSize);

    vec3 waterPos = vec3(position.x, waterInfo.r * waterAmplitude, position.z);
    vec3 waterNormal = normalize(vec3(waterInfo.b, sqrt(max(0.0, 1.0 - dot(waterInfo.ba, waterInfo.ba))), waterInfo.a));

    oldPosition = waterPos;

    vec4 projectedWaterPosition = projectionMatrix * viewMatrix * vec4(waterPos, 1.0);
    vec2 currentPosition = projectedWaterPosition.xy;
    waterDepth = 0.5 + 0.5 * projectedWaterPosition.z / projectedWaterPosition.w;
    float currentDepth = projectedWaterPosition.z;

    vec3 refracted = refract(lightDir, waterNormal, eta);
    vec4 projectedRefractionVector = projectionMatrix * viewMatrix * vec4(refracted, 0.0);
    vec3 refractedDirection = projectedRefractionVector.xyz;

    vec2 coords = 0.5 + 0.5 * currentPosition;
    vec4 environment = texture2D(env, coords);

    float factor = deltaEnv / max(length(refractedDirection.xy), 1e-6);
    vec2 deltaDirection = refractedDirection.xy * factor;
    float deltaDepth = refractedDirection.z * factor;

    // March the refracted ray forward in fixed steps until it reaches (or
    // passes) the terrain's stored depth at that point — that's where the
    // light ray actually lands on the riverbed.
    for (int i = 0; i < MAX_ITERATIONS; i++) {
      currentPosition += deltaDirection;
      currentDepth += deltaDepth;
      if (environment.w <= currentDepth) break;
      environment = texture2D(env, 0.5 + 0.5 * currentPosition);
    }

    newPosition = environment.xyz;
    finalNdc = currentPosition;

    vec4 projectedEnvPosition = projectionMatrix * viewMatrix * vec4(newPosition, 1.0);
    depth = 0.5 + 0.5 * projectedEnvPosition.z / projectedEnvPosition.w;

    gl_Position = projectedEnvPosition;
  }
`;

const CAUSTICS_FRAGMENT_SHADER = /* glsl */ `
  const float causticsFactor = 0.045;

  varying vec3 oldPosition;
  varying vec3 newPosition;
  varying float waterDepth;
  varying float depth;
  varying vec2 finalNdc;

  // The light frustum is sized with a 10% margin around the terrain
  // (see createCausticsPipeline), so the terrain itself only covers NDC
  // [-0.833, 0.833]. Rays that refract past that edge never find real
  // terrain to land on and must not contribute — otherwise the whole
  // unresolved margin collapses to a degenerate zero-area triangle and
  // blows out as a false bright patch.
  const float terrainNdcExtent = 0.85;

  void main() {
    float causticsIntensity = 0.0;

    bool withinTerrain = abs(finalNdc.x) < terrainNdcExtent && abs(finalNdc.y) < terrainNdcExtent;

    if (withinTerrain && depth >= waterDepth) {
      float oldArea = length(dFdx(oldPosition)) * length(dFdy(oldPosition));
      float newArea = length(dFdx(newPosition)) * length(dFdy(newPosition));

      // A genuinely converging ray bundle (a real caustic focus) can send
      // newArea to ~0 legitimately — clamp rather than let it blow out.
      float ratio = newArea < 1.0e-7 ? 18.0 : min(oldArea / newArea, 18.0);
      causticsIntensity = causticsFactor * ratio;
    }

    gl_FragColor = vec4(causticsIntensity, 0.0, 0.0, depth);
  }
`;

export function createCausticsPipeline({ bounds, terrainMesh, causticsSegments = 128, envMapSize = 512, causticsTargetSize = 512 }) {
  const rtOptions = { type: THREE.HalfFloatType, depthBuffer: false, stencilBuffer: false };

  // The light camera sits at the world's XZ center (see `center` below), so
  // its orthographic frustum must be centered on 0, not on [0, bounds.*] —
  // 0.6 = 0.5 half-extent + 0.1 margin.
  const maxSpan = Math.max(bounds.width, bounds.height);
  const lightCamera = new THREE.OrthographicCamera(
    -bounds.width * 0.6,
    bounds.width * 0.6,
    bounds.height * 0.6,
    -bounds.height * 0.6,
    1,
    maxSpan,
  );
  const lightHeight = maxSpan * 0.6;
  const center = new THREE.Vector3(bounds.width / 2, 0, bounds.height / 2);
  lightCamera.position.set(center.x, lightHeight, center.z);
  lightCamera.up.set(0, 0, -1);
  lightCamera.lookAt(center);
  lightCamera.updateMatrixWorld(true);
  lightCamera.updateProjectionMatrix();

  // Roughly straight down, with a slight tilt matching the scene's sun.
  const lightDir = new THREE.Vector3(0.25, -1, 0.15).normalize();

  const envMaterial = new THREE.ShaderMaterial({
    vertexShader: ENV_VERTEX_SHADER,
    fragmentShader: ENV_FRAGMENT_SHADER,
  });
  const envTarget = new THREE.WebGLRenderTarget(envMapSize, envMapSize, rtOptions);
  const envMesh = new THREE.Mesh(terrainMesh.geometry, envMaterial);

  // Renders the (static) terrain's world position + depth from the light
  // camera's point of view into envTarget. Only needs to run once at
  // startup/resize since the terrain geometry never changes.
  function renderTerrainDepthMap(renderer) {
    const previousTarget = renderer.getRenderTarget();
    const previousClear = renderer.getClearColor(new THREE.Color());
    const previousAlpha = renderer.getClearAlpha();

    renderer.setRenderTarget(envTarget);
    renderer.setClearColor(0x000000, 0);
    renderer.clear();
    renderer.render(envMesh, lightCamera);

    renderer.setRenderTarget(previousTarget);
    renderer.setClearColor(previousClear, previousAlpha);
  }

  const causticsGeometry = new THREE.PlaneGeometry(bounds.width, bounds.height, causticsSegments, causticsSegments);
  causticsGeometry.rotateX(-Math.PI / 2);
  causticsGeometry.translate(bounds.width / 2, 0, bounds.height / 2);

  const causticsMaterial = new THREE.ShaderMaterial({
    uniforms: {
      water: { value: null },
      env: { value: envTarget.texture },
      lightDir: { value: lightDir },
      deltaEnv: { value: 1 / envMapSize },
      waterAmplitude: { value: 1 },
      worldSize: { value: new THREE.Vector2(bounds.width, bounds.height) },
    },
    vertexShader: CAUSTICS_VERTEX_SHADER,
    fragmentShader: CAUSTICS_FRAGMENT_SHADER,
    transparent: true,
    side: THREE.DoubleSide,
  });
  causticsMaterial.extensions = { derivatives: true };
  causticsMaterial.blending = THREE.CustomBlending;
  causticsMaterial.blendEquation = THREE.AddEquation;
  causticsMaterial.blendSrc = THREE.OneFactor;
  causticsMaterial.blendDst = THREE.OneFactor;
  causticsMaterial.blendEquationAlpha = THREE.AddEquation;
  causticsMaterial.blendSrcAlpha = THREE.OneFactor;
  causticsMaterial.blendDstAlpha = THREE.ZeroFactor;

  const causticsMesh = new THREE.Mesh(causticsGeometry, causticsMaterial);
  const causticsTarget = new THREE.WebGLRenderTarget(causticsTargetSize, causticsTargetSize, rtOptions);

  // Runs the per-frame caustics pass: displaces the flat causticsMesh grid
  // by the live water heightfield, refracts each vertex's light ray through
  // it, and ray-marches against the terrain depth map — accumulating the
  // resulting brightness into causticsTarget (see CAUSTICS_*_SHADER above).
  function renderCaustics(renderer, waterTexture, waterAmplitude) {
    causticsMaterial.uniforms.water.value = waterTexture;
    causticsMaterial.uniforms.waterAmplitude.value = waterAmplitude;

    const previousTarget = renderer.getRenderTarget();
    renderer.setRenderTarget(causticsTarget);
    renderer.setClearColor(0x000000, 0);
    renderer.clear();
    renderer.render(causticsMesh, lightCamera);
    renderer.setRenderTarget(previousTarget);
  }

  function dispose() {
    envTarget.dispose();
    envMaterial.dispose();
    causticsGeometry.dispose();
    causticsMaterial.dispose();
    causticsTarget.dispose();
  }

  return {
    lightCamera,
    size: causticsTargetSize,
    renderTerrainDepthMap,
    renderCaustics,
    dispose,
    get texture() {
      return causticsTarget.texture;
    },
  };
}
