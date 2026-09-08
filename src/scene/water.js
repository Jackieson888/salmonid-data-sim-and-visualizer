// Surface plane, fragment-shaded from waterSim.js's live height field; vertex displacement was tried and reverted.
import * as THREE from "three";
import {
  causticGlowChunk,
  waterInfoChunk,
  CAUSTIC_SATURATE_GLSL,
  EDGE_FADE_GLSL,
  WATER_NORMAL_GLSL,
  glslFloat as f,
} from "./glsl.js";
import { FOG_GLSL, FOG_COLOR, fogDensity, fogDepthRate } from "./fog.js";
import { seasonForDay } from "./season.js";
import { QUALITY } from "../quality.js";

// Device-tier-scaled multiplier for how much bigger than the river bounds the water sim/plane covers.
export const waterSizeMultiplier = () => QUALITY.waterSizeMultiplier;

// World-Y scale for the sim's raw height, also used by causticsGenerator.js's refraction ray-march.
export const WATER_HEIGHT_SCALE = 150;

// Snell's window critical-angle bounds, as cosines.
const COS_CRITICAL_MIN = 0.6;
const COS_CRITICAL_MAX = 0.73;

// How much sky the window shows against the water's own color; not 1.0, since the sky sphere behind already shows through it.
const WINDOW_SKY_MIX = 0.8;

// Fraction of the surface glint the mirror (outside the window) still shows.
const MIRROR_GLINT = 0.5;

// width/height = the sim/plane's oversized world coverage; marginX/marginZ = how far it extends past bounds on each side.
export function waterWorldSize(bounds) {
  const multiplier = waterSizeMultiplier();
  const width = bounds.width * multiplier;
  const height = bounds.height * multiplier;
  return {
    width,
    height,
    marginX: (width - bounds.width) / 2,
    marginZ: (height - bounds.height) / 2,
  };
}

// How far out the caustic net is worth computing, as a multiple of the fog's own saturation distance.
const CAUSTICS_FOG_REACH = 2.0;

// The caustics pass's own world coverage, deliberately not waterWorldSize() — the frame's most expensive pass, sized independently for cost.
// Centered on the eye->target midpoint, like particles.js's silt volume, so a box centered on the eye alone doesn't starve far water in frame.
export function causticsWorldSize(bounds, cameraPosition, cameraTarget) {
  const span = Math.max(bounds.width, bounds.height);
  const reach = CAUSTICS_FOG_REACH / fogDensity(bounds);

  const centerX = (cameraPosition.x + cameraTarget.x) * 0.5;
  const centerZ = (cameraPosition.z + cameraTarget.z) * 0.5;

  // Never larger than the water coverage — past that edge the surface and bed have already faded out.
  const water = waterWorldSize(bounds);
  const width = Math.min(reach * 2, water.width);
  const height = Math.min(reach * 2, water.height);

  return {
    width,
    height,
    marginX: width / 2 - centerX,
    marginZ: height / 2 - centerZ,
    centerX,
    centerZ,
    span,
  };
}

const VERTEX_SHADER = /* glsl */ `
  varying vec3 vWorldPos;
  void main() {
    vWorldPos = position;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

// A function so the spliced-in chunks resolve against the current quality tier at build time.
const fragmentShader = () => /* glsl */ `
  ${causticGlowChunk({ taps: QUALITY.causticTaps })}
  ${waterInfoChunk()}
  ${CAUSTIC_SATURATE_GLSL}
  ${EDGE_FADE_GLSL}
  ${WATER_NORMAL_GLSL}
  ${FOG_GLSL}

  uniform sampler2D uWater;
  uniform sampler2D uCaustics;
  uniform vec2 uWorldSize;
  uniform vec2 uMargin;
  // Separate world->uv mapping, since the caustics pass covers a shorter reach than the water sim.
  uniform vec2 uCausticsWorldSize;
  uniform vec2 uCausticsMargin;
  uniform vec2 uTexel;
  // Drives the procedural stand-in at the low tier; pushed unconditionally so the per-frame call has no branch.
  uniform float uTime;
  uniform vec3 uBaseColor;
  uniform vec3 uSkyColor;
  uniform vec3 uCausticsColor;
  uniform float uCausticsStrength;
  uniform vec2 uCenter;
  uniform vec2 uPlaneHalfSize;
  uniform float uCoreFrac;

  varying vec3 vWorldPos;

  void main() {
    // Sample the live height-field sim for this point's surface normal (.ba channels).
    vec2 uv = (vWorldPos.xz + uMargin) / uWorldSize;
    vec3 normal = waterSurfaceNormal(waterInfoAt(uWater, uv, vWorldPos.xz, uTime));

    // Snell's window: sky inside the cone, mirrored water column outside it.
    // abs(), not clamp, since normal always points up and viewDir always points down here.
    vec3 viewDir = normalize(cameraPosition - vWorldPos);
    float cosView = abs(dot(normal, viewDir));
    float window = smoothstep(
      ${f(COS_CRITICAL_MIN)}, ${f(COS_CRITICAL_MAX)}, cosView
    );

    // What the mirror shows: the murk one fog length along the reflected ray.
    vec3 mirrorDir = reflect(-viewDir, normal);
    vec3 mirrored = fogColorAt(vWorldPos + mirrorDir / uFogDensity);

    vec3 color = mix(
      mirrored, mix(uBaseColor, uSkyColor, ${f(WINDOW_SKY_MIX)}), window
    );

    // Same causticGlow() read terrain.js uses, so the surface glints with the light pattern that lands underwater.
    vec2 causticsUv = (vWorldPos.xz + uCausticsMargin) / uCausticsWorldSize;
    float glint = softSaturate(
      causticGlowAt(uCaustics, causticsUv, uTexel, vWorldPos.xz, uTime)
        * uCausticsStrength
    );
    color +=
      uCausticsColor * glint * 0.35 * mix(${f(MIRROR_GLINT)}, 1.0, window);

    // Opaque out to uCoreFrac (real river bounds), dissolving beyond it, same edge as the riverbed.
    float edgeFade =
      planeEdgeFade(vWorldPos.xz, uCenter, uPlaneHalfSize, uCoreFrac);

    color = applyFog(color, vWorldPos);

    // Semi-transparent, not opaque: fish and the caustics-lit riverbed below the surface both show through.
    gl_FragColor = vec4(color, 0.8 * edgeFade);
  }
`;

export function buildWaterMesh(bounds, causticsTextureSize, causticsCoverage) {
  // Drawn waterSizeMultiplier() bigger than the river bounds, re-centered so the extra size grows evenly past the edges.
  const {
    width: planeWidth,
    height: planeHeight,
    marginX,
    marginZ,
  } = waterWorldSize(bounds);
  const centerX = bounds.width / 2;
  const centerZ = bounds.height / 2;

  const geometry = new THREE.PlaneGeometry(planeWidth, planeHeight, 1, 1);
  geometry.rotateX(-Math.PI / 2);
  geometry.translate(centerX, 0, centerZ);

  const uniforms = {
    uWater: { value: null },
    uCaustics: { value: null },
    uTime: { value: 0 },
    uWorldSize: { value: new THREE.Vector2(planeWidth, planeHeight) },
    uMargin: { value: new THREE.Vector2(marginX, marginZ) },
    uCausticsWorldSize: {
      value: new THREE.Vector2(
        causticsCoverage.width,
        causticsCoverage.height,
      ),
    },
    uCausticsMargin: {
      value: new THREE.Vector2(
        causticsCoverage.marginX,
        causticsCoverage.marginZ,
      ),
    },
    uTexel: {
      value: new THREE.Vector2(1 / causticsTextureSize, 1 / causticsTextureSize),
    },
    // Overwritten by setSeason(); these starting values only show before the first call.
    uBaseColor: { value: new THREE.Color("#09223f") },
    // Sky seen through Snell's window — tracks the sky sphere's skyColor.
    uSkyColor: { value: new THREE.Color("#1a56a8") },
    // Surface glint tint — tracks fishMesh.js's causticsColor1.
    uCausticsColor: { value: new THREE.Color(0.75, 0.92, 0.98) },
    uCausticsStrength: { value: 8 },
    uCenter: { value: new THREE.Vector2(centerX, centerZ) },
    uPlaneHalfSize: {
      value: new THREE.Vector2(planeWidth / 2, planeHeight / 2),
    },
    // Where the real river bounds end, as a t-value.
    uCoreFrac: { value: 1 / waterSizeMultiplier() },
    uFogColor: { value: FOG_COLOR },
    uFogDensity: { value: fogDensity(bounds) },
    // Y=0, the top end of the depth ramp, so fish/riverbed below grade consistently against it.
    uFogDepthRate: { value: fogDepthRate(bounds) },
  };

  const material = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: VERTEX_SHADER,
    fragmentShader: fragmentShader(),
    transparent: true,
    depthWrite: false,
    // Double-sided: culling saves nothing measurable on this two-triangle quad, and avoids the surface vanishing on a vantage change.
    side: THREE.DoubleSide,
  });

  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = "water";

  // Per-frame setter: the water sim's ping-pong targets swap identity every frame.
  function setWaterTexture(waterTexture) {
    uniforms.uWater.value = waterTexture;
  }

  // Bound once, not per frame — the caustics accumulation target is cleared and re-rendered in place, its identity never changes.
  function setCausticsTexture(causticsTexture) {
    uniforms.uCaustics.value = causticsTexture;
  }

  // Called whenever the displayed date changes, and again after any resize rebuilds this mesh.
  function setSeason(dayOfYear) {
    const season = seasonForDay(dayOfYear);
    uniforms.uBaseColor.value.copy(season.waterColor);
    uniforms.uSkyColor.value.copy(season.skyColor);
    uniforms.uCausticsColor.value.copy(season.causticsColor1);
  }

  // Drives the procedural stand-in at the low tier; same clock every other animated thing reads.
  function setTime(seconds) {
    uniforms.uTime.value = seconds;
  }

  return { mesh, setWaterTexture, setCausticsTexture, setSeason, setTime };
}
