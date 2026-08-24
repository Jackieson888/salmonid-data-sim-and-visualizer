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
// Scope: the only receiver is the flat riverbed. It is in here purely as the
// surface the refracted rays terminate against — it does not draw caustics on
// itself (see terrain.js). Without something for the march to land on, the
// accumulated light net loses its structure, and that net is what the water
// surface and the fish read.
//
// Fish are excluded. They move every frame and are already this scene's most
// expensive draw (VAT skinning, per-instance caustics/fog/specular — see
// fishMesh.js's file header), so adding a full MAX_POPULATION of them to a
// second camera-rendered pass each frame isn't worth it for an occlusion
// effect that would be subtle on an otherwise-open water column anyway. Fish
// still *receive* the caustics glow (see glsl.js), same as before.
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
import { WATER_NORMAL_GLSL } from "./glsl.js";
import { QUALITY } from "../quality.js";

// Segment count for the dense grid the caustics pass refracts/marches per
// vertex. A deliberate step down from the water sim's own resolution
// (WATER_SIM_SIZE, 600 — see main.js) since this mesh is a real draw call
// every frame, not just a texture lookup, and its vertex count is O(n^2).
// All four numbers below now come from the device tier (see quality.js) rather
// than being fixed. This pass is the most expensive thing in the frame by a
// wide margin — its vertex count is O(segments^2) and each of those vertices
// runs a loop of up to MAX_ITERATIONS texture fetches — so it is also the one
// with the most to give back. The low tier does not run it at all: createWorld
// in main.js skips constructing this generator entirely and every consumer
// switches to the procedural stand-in in glsl.js.
const causticsMeshSegments = () => QUALITY.causticsSegments;
const envMapSize = () => QUALITY.causticsEnvSize;

// Read by main.js to size water.js's causticGlow() blur texel to this
// texture's actual resolution (it used to be sized to the water sim's
// resolution, back when the surface sampled the sim texture directly).
export const causticsTargetSize = () => QUALITY.causticsTargetSize;

// How many environment-map texels the ray-march advances per step, as a
// fraction of the env map (see deltaEnvTexture below) — must be a
// compile-time constant, WebGL forbids while-loops. Renou's demo uses 50 at
// his 1024 env map size; kept proportionate here, and scaled down with the
// rest at lower tiers since a shorter march against a smaller env map covers
// the same fraction of the scene.
const maxIterations = () => QUALITY.causticsIterations;

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
// A function rather than a module-level string: the march length is now a
// tier setting (see quality.js) and has to be interpolated in when the
// material is actually built, not when this module is first imported — the
// governor can change the tier mid-session, and the world rebuild that
// follows re-runs this.
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
    // The same normal reconstruction water.js's own fragment shader lights
    // the surface with (see glsl.js) — this pass refracts through it.
    vec3 waterNormal = waterSurfaceNormal(waterInfo);

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

// Ported from shaders/caustics/water_fragment.glsl — the dFdx/dFdy
// triangle-area ratio itself is coordinate-system agnostic, but the
// reference's "arbitrary large value" sentinel (2e20) for the newArea==0
// degenerate case is NOT reused here: his demo relies on a depth-tested PCF
// receiver blur to keep that sentinel from ever really showing (rare,
// isolated texels smoothed away). We sample this texture directly with a
// plain box blur (see glsl.js) and additively accumulate hundreds of
// thousands of triangles into it — a single 2e20 texel survives both of
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

// Flat (unrotated) plane whose position.xy directly holds this vertex's
// rest-position world (x, z) — CAUSTICS_VERTEX_SHADER reads it as such
// directly, so unlike buildWaterMesh/buildTerrainMesh this is never rotated
// into the actual 3D XZ plane (it's only ever rasterized through the light
// camera's projection, never drawn as real 3D geometry).
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
  // `coverage` is the caustics pass's own, shorter reach (see
  // causticsWorldSize in water.js). It sets what this pass RASTERIZES: the
  // light camera's frustum and the refraction grid's extent, which together
  // define the accumulation texture's world->uv mapping.
  const lightCamera = buildLightCamera(bounds, coverage);

  // The water SIM's coverage, which is a different and larger area. This pair
  // is what the vertex shader samples the height field with, so it must stay
  // on waterWorldSize even though everything else here moved: the sim texture
  // is laid out over the plane, not over the caustics coverage, and reading it
  // through the wrong mapping would refract against the wrong part of the
  // surface. The two used to be the same call, which is exactly why splitting
  // them needs this said out loud.
  const { width: planeWidth, height: planeHeight, marginX, marginZ } =
    waterWorldSize(bounds);

  const envMapTarget = makeTarget(envMapSize());
  const causticsTarget = makeTarget(causticsTargetSize());

  // Shares terrainMesh's geometry (already baked to world-space positions —
  // see terrain.js) rather than cloning it, so this pass automatically tracks
  // whatever shape the riverbed actually has. A separate Mesh rather than the
  // riverbed itself, because adding an object to a second scene would reparent
  // it out of the one the camera renders.
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

  const causticsGeometry = buildCausticsGeometry(coverage);
  const causticsMesh = new THREE.Mesh(causticsGeometry, causticsMaterial);

  const black = new THREE.Color(0, 0, 0);
  // Scratch for saving/restoring the renderer's clear color around the passes
  // below. Hoisted out of render() because that runs every frame, and
  // allocating a Color per frame to hold a value that is immediately thrown
  // away is pure garbage-collector pressure.
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

  // Only the caustics accumulation pass runs per frame — see renderEnvMap()
  // below for why its input doesn't.
  function render(waterTexture) {
    causticsMaterial.uniforms.water.value = waterTexture;
    renderToTarget(causticsMesh, causticsTarget);
  }

  // The environment map is rendered ONCE, here, not every frame.
  //
  // It stores the receiver geometry's world position + depth per texel, and
  // every input to that is static: envMaterial declares no uniforms at all,
  // the light camera never moves, and the riverbed is built once and never
  // animates. Re-rendering it per frame — which this used to do —
  // re-rasterized the receiver 60 times a second to produce a byte-identical
  // texture.
  //
  // Anything that changes the receiver therefore has to call this again.
  // Today nothing does: a resize disposes this whole generator and builds a
  // fresh one (see createWorld in main.js), which runs the line below.
  function renderEnvMap() {
    renderToTarget(envMesh, envMapTarget);
  }

  renderEnvMap();

  // The sun this pass refracts. Pushed every frame from main.js's loop rather
  // than per season, because the sun also moves within the day (see
  // sweptSunDirection in season.js) — and moving it here is what makes the
  // whole light net slide across the bed, which is the entire mechanism
  // behind the sweeping shafts, glints and fish highlights. It is the only
  // per-frame input this generator has other than the water surface itself.
  //
  // Negated because GLSL refract()'s `I` param wants the incident light's
  // *travel* direction, while season.sunDirection points *toward* the sun.
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
