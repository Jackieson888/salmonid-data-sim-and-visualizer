// causticsGenerator.js
// Real-time water caustics, ported from martinRenou/threejs-caustics
// (shaders/environment_mapping/*.glsl, shaders/caustics/water_*.glsl) — the
// same repo waterSim.js's height-field simulation was already ported from,
// so the RGBA convention this pass reads (R=height, G=velocity, B/A=
// normal.xz) already matches with no adaptation needed.
//
// Two passes, run every frame right after the water sim steps:
//
//  1. Environment map: render the riverbed (this scene's only caustics
//     receiver/occluder — see the scope note below) from directly above
//     into a texture storing world position (rgb) + depth (a) per texel.
//     Same idea as a shadow map, just storing position instead of only
//     depth.
//  2. Caustics accumulation: render a dense grid matching the water
//     surface's extent, refracting each vertex's position through the
//     water's live height-field normal toward the real sun direction, then
//     marching against the environment map (stepping one env-map texel at a
//     time — GLSL forbids while-loops, hence the fixed-iteration for-loop)
//     to find where that refracted ray lands. Brightness at the landing
//     point comes from how much the triangle's world-space area shrank or
//     grew under refraction (via dFdx/dFdy) — converging rays = shrinking
//     area = bright; diverging = dim — additively splatted (custom
//     ONE,ONE blending) so overlapping rays accumulate.
//
// Scope: only the flat terrain floor is a receiver/occluder. Fish are
// excluded — they move every frame and are already this scene's most
// expensive draw (VAT skinning, per-instance caustics/fog/specular — see
// fishMesh.js's file header), so adding up to 1600 of them to a second
// camera-rendered pass each frame isn't worth it for an occlusion effect
// that would be subtle on an otherwise-open water column anyway. Fish still
// *receive* the caustics glow (see causticsChunk.js), same as before.
//
// Light camera: rather than aiming it along the real (slightly tilted, see
// season.js's sunDirection) sun direction the way Renou's demo does, it
// looks straight down world -Y. That keeps its projected space exactly
// aligned with the world-XZ UV convention `(worldPos.xz + margin) /
// worldSize` every caustics consumer (terrain.js/water.js/fishMesh.js)
// already shares — so the output texture is a drop-in sample for all three
// with zero UV math changes. The *actual* refraction inside the shader
// still uses the real per-season sun direction; only the rasterization/
// marching camera is simplified. Given our modest sun tilt (further reduced
// once refract() bends the ray toward the normal entering water), this
// keeps the ray-march numerically well-behaved.
import * as THREE from "three";
import { waterWorldSize, WATER_HEIGHT_SCALE } from "./water.js";
import { riverDepth } from "./terrain.js";
import { seasonForDay } from "./season.js";

// Segment count for the dense grid the caustics pass refracts/marches per
// vertex. A deliberate step down from the water sim's own resolution
// (WATER_SIM_SIZE, 600 — see main.js) since this mesh is a real draw call
// every frame, not just a texture lookup, and its vertex count is O(n^2).
const CAUSTICS_MESH_SEGMENTS = 256;

// Render target resolutions. Renou's original demo uses waterSize*3 for its
// caustics target; kept flat and smaller here to bound cost, since this
// project's water sim is already higher-res (600) than his (512).
const ENV_MAP_SIZE = 512;
// Exported so terrain.js/water.js/fishMesh.js can size causticGlow()'s blur
// texel to this texture's actual resolution (they used to size it to the
// water sim's resolution, back when they sampled the sim texture directly).
export const CAUSTICS_TARGET_SIZE = 1024;

// How many environment-map texels the ray-march advances per step, as a
// fraction of the env map (see deltaEnvTexture below) — must be a
// compile-time constant, WebGL forbids while-loops. Renou's demo uses 50 at
// his 1024 env map size; kept proportionate here.
const MAX_ITERATIONS = 40;

// Air -> water refractive index ratio (1 / 1.333), same constant Renou's
// shader uses.
const ETA = 0.7504;

// Scales the raw (now RATIO_CAP-bounded — see below) area-ratio into a
// usable brightness range. Renou's demo hardcodes 0.15.
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

// Ported from shaders/caustics/water_vertex.glsl. `position.xy` (see
// buildCausticsGeometry below) holds this vertex's rest-position world
// (x, z) directly — not rotated into 3D, since this mesh is only ever
// rasterized through the light camera's own projection, never drawn as
// real geometry.
const CAUSTICS_VERTEX_SHADER = /* glsl */ `
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
    // Same normal reconstruction water.js's own fragment shader uses — no
    // axis swizzle needed, our Y-up world already matches this convention
    // (Renou's Z-up demo needs a .xzy swizzle here; we don't).
    vec3 waterNormal = normalize(vec3(waterInfo.b, sqrt(max(0.0, 1.0 - dot(waterInfo.ba, waterInfo.ba))), waterInfo.a));

    vOldPosition = waterPosition;

    vec4 projectedWaterPosition = projectionMatrix * viewMatrix * vec4(waterPosition, 1.0);

    vec2 currentPosition = projectedWaterPosition.xy;
    vec2 coords = 0.5 + 0.5 * currentPosition;

    vec3 refracted = refract(light, waterNormal, ${ETA.toFixed(4)});
    // Deliberately w=0 here (a direction transform), NOT w=1 like the
    // reference source. Renou's light camera sits ~1.5 world units from the
    // origin, so projecting a unit direction with w=1 (which bakes in the
    // view matrix's translation) only mixes in a small, mostly-harmless
    // constant offset. Our light camera sits hundreds of world units above
    // the scene (see buildLightCamera) — the same w=1 quirk there would bake
    // in an offset far larger than the refracted direction itself, drowning
    // out the actual per-vertex refraction. w=0 gives the mathematically
    // correct (translation-free) projected direction instead.
    vec4 projectedRefractionVector = projectionMatrix * viewMatrix * vec4(refracted, 0.0);

    vWaterDepth = 0.5 + 0.5 * projectedWaterPosition.z / projectedWaterPosition.w;
    float currentDepth = projectedWaterPosition.z;
    vec4 environment = texture2D(env, coords);

    float factor = deltaEnvTexture / length(projectedRefractionVector.xy);
    vec2 deltaDirection = projectedRefractionVector.xy * factor;
    float deltaDepth = projectedRefractionVector.z * factor;

    for (int i = 0; i < ${MAX_ITERATIONS}; i++) {
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

// Ported from shaders/caustics/water_fragment.glsl — the dFdx/dFdy
// triangle-area ratio itself is coordinate-system agnostic, but the
// reference's "arbitrary large value" sentinel (2e20) for the newArea==0
// degenerate case is NOT reused here: his demo relies on a depth-tested PCF
// receiver blur to keep that sentinel from ever really showing (rare,
// isolated texels smoothed away). We sample this texture directly with a
// plain box blur (see causticsChunk.js) and additively accumulate hundreds
// of thousands of triangles into it — a single 2e20 texel survives both of
// those and swamps the entire output regardless of any downstream strength
// constant. RATIO_CAP keeps a genuinely bright focal point very bright
// without that unbounded blowout.
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

// Straight-down orthographic camera covering the same oversized,
// bounds-centered area water.js/terrain.js render into (see
// waterWorldSize()) — see file header for why straight-down rather than
// along the real sun direction. Positioned high enough above the water
// surface (y=0) and with a far plane deep enough below the terrain floor
// that a reasonable range of WATER_HEIGHT_SCALE-driven start heights can't
// clip out either end.
function buildLightCamera(bounds) {
  const { width: planeWidth, height: planeHeight } = waterWorldSize(bounds);
  const centerX = bounds.width / 2;
  const centerZ = bounds.height / 2;
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

// Flat (unrotated) plane whose position.xy directly holds this vertex's
// rest-position world (x, z) — CAUSTICS_VERTEX_SHADER reads it as such
// directly, so unlike buildWaterMesh/buildTerrainMesh this is never rotated
// into the actual 3D XZ plane (it's only ever rasterized through the light
// camera's projection, never drawn as real 3D geometry).
function buildCausticsGeometry(bounds) {
  const { width: planeWidth, height: planeHeight } = waterWorldSize(bounds);
  const centerX = bounds.width / 2;
  const centerZ = bounds.height / 2;

  const geometry = new THREE.PlaneGeometry(
    planeWidth,
    planeHeight,
    CAUSTICS_MESH_SEGMENTS,
    CAUSTICS_MESH_SEGMENTS,
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

export function createCausticsGenerator(renderer, bounds, terrainMesh) {
  const lightCamera = buildLightCamera(bounds);
  const { width: planeWidth, height: planeHeight, marginX, marginZ } =
    waterWorldSize(bounds);

  const envMapTarget = makeTarget(ENV_MAP_SIZE);
  const causticsTarget = makeTarget(CAUSTICS_TARGET_SIZE);

  // Shares terrainMesh's geometry (already baked to world-space positions —
  // see terrain.js) rather than cloning it, so this pass automatically
  // tracks whatever shape the riverbed actually has.
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
      deltaEnvTexture: { value: 1 / ENV_MAP_SIZE },
      worldSize: { value: new THREE.Vector2(planeWidth, planeHeight) },
      margin: { value: new THREE.Vector2(marginX, marginZ) },
    },
    vertexShader: CAUSTICS_VERTEX_SHADER,
    fragmentShader: CAUSTICS_FRAGMENT_SHADER,
    transparent: true,
    side: THREE.DoubleSide,
  });
  // Additive accumulation: overlapping refracted triangles should sum their
  // brightness, not blend/overwrite it — see file header. Depth (alpha) is
  // just the latest write, not summed (SrcAlpha=ONE, DstAlpha=ZERO).
  causticsMaterial.blending = THREE.CustomBlending;
  causticsMaterial.blendEquation = THREE.AddEquation;
  causticsMaterial.blendSrc = THREE.OneFactor;
  causticsMaterial.blendDst = THREE.OneFactor;
  causticsMaterial.blendEquationAlpha = THREE.AddEquation;
  causticsMaterial.blendSrcAlpha = THREE.OneFactor;
  causticsMaterial.blendDstAlpha = THREE.ZeroFactor;

  const causticsGeometry = buildCausticsGeometry(bounds);
  const causticsMesh = new THREE.Mesh(causticsGeometry, causticsMaterial);

  const black = new THREE.Color(0, 0, 0);

  function render(waterTexture) {
    causticsMaterial.uniforms.water.value = waterTexture;

    const previousTarget = renderer.getRenderTarget();
    const previousClearColor = new THREE.Color();
    renderer.getClearColor(previousClearColor);
    const previousClearAlpha = renderer.getClearAlpha();

    renderer.setRenderTarget(envMapTarget);
    renderer.setClearColor(black, 0);
    renderer.clear();
    renderer.render(envMesh, lightCamera);

    renderer.setRenderTarget(causticsTarget);
    renderer.setClearColor(black, 0);
    renderer.clear();
    renderer.render(causticsMesh, lightCamera);

    renderer.setRenderTarget(previousTarget);
    renderer.setClearColor(previousClearColor, previousClearAlpha);
  }

  // Mirrors setTerrainSeason/water.setSeason (see terrain.js/water.js) —
  // called from main.js's applySeason() with the same dayOfYear. GLSL
  // refract()'s `I` param wants the incident light *travel* direction, but
  // season.sunDirection (like terrain.js's own sunDir uniform) is the
  // direction *to* the light — see terrain.js's `dot(worldNormal, sunDir)`
  // Lambertian usage — hence the negation.
  function setSeason(dayOfYear) {
    const season = seasonForDay(dayOfYear);
    causticsMaterial.uniforms.light.value
      .copy(season.sunDirection)
      .multiplyScalar(-1);
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
    setSeason,
    dispose,
    get texture() {
      return causticsTarget.texture;
    },
  };
}
