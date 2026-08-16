// water.js
// Water surface: a flat plane at world Y=0, fragment-shaded from the live
// GPU height-field simulation in waterSim.js (real ripples, not a canned
// texture) and lit by the same causticGlow() helper terrain.js uses (see
// causticsChunk.js), so the sparkle on the surface and the light net on
// the riverbed come from one consistent read of the same water texture.
//
// Vertex displacement (actually bumping this mesh's geometry from the sim's
// height field, not just shading it) was attempted and reverted: sampling
// the sim texture from this material's vertex shader reliably read back 0
// no matter what (hardcoded UVs, a dedicated uniform not shared
// with the fragment stage, bypassing the post-processing composer, removing
// the fragment stage's own sample of the same texture — none of it changed
// the result), despite the identical texture sampling fine in both this
// material's own fragment shader and in causticsGenerator.js's vertex
// shader. Root cause not identified; not worth blocking on further.
//
// The plane itself is drawn larger than the river bounds (WATER_SIZE_MULTIPLIER)
// and the entire margin beyond the real bounds fades to 0 opacity — full
// opacity right up to where the simulation actually is, then a gradual
// dissolve into the scene background across the added margin, rather than
// ending in a visible rectangle.
//
// The water sim itself (see waterWorldSize() below) is mapped to cover this
// same oversized area, not just the literal play-field bounds — so ripples
// genuinely propagate out into the fade margin via the sim's own wave
// diffusion, instead of the margin just clamping to (and stretching) the
// sim texture's edge texel. Anything else that converts a world position
// into this sim's uv space (main.js's worldToSim, fishMesh.js's caustic
// sampling) must use the same waterWorldSize() to stay in registration.

import * as THREE from "three";
import { CAUSTIC_GLOW_GLSL } from "./causticsChunk.js";
import { FOG_GLSL, FOG_COLOR, fogDensity } from "./fog.js";
import { seasonForDay } from "./season.js";

// How much bigger than the river bounds the water sim/plane covers — the
// entire added margin (from the real edge out to the plane's own edge) is
// both the caustics fade zone and the region the sim can propagate ripples
// into, so a bigger multiplier reads as a longer, softer dissolve.
export const WATER_SIZE_MULTIPLIER = 2.4;

// World-Y scale for the sim's raw height (.r channel) — the sim itself is
// unitless (see waterSim.js). This mesh no longer displaces its own
// geometry with it (see file header) but causticsGenerator.js's refraction
// ray-march still needs a world-unit calibration for the sim height, and
// imports this constant to stay consistent with whatever this file settles
// on rather than guessing its own independent number.
export const WATER_HEIGHT_SCALE = 150;

// {width, height} = the sim/plane's actual world coverage, oversized by
// WATER_SIZE_MULTIPLIER; {marginX, marginZ} = how far that coverage extends
// past bounds on each side (the plane is centered on bounds, not corner
// anchored, so this offset is what keeps world->uv math consistent).
export function waterWorldSize(bounds) {
  const width = bounds.width * WATER_SIZE_MULTIPLIER;
  const height = bounds.height * WATER_SIZE_MULTIPLIER;
  return {
    width,
    height,
    marginX: (width - bounds.width) / 2,
    marginZ: (height - bounds.height) / 2,
  };
}

const VERTEX_SHADER = /* glsl */ `
  varying vec3 vWorldPos;
  void main() {
    vWorldPos = position;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const FRAGMENT_SHADER = /* glsl */ `
  ${CAUSTIC_GLOW_GLSL}
  ${FOG_GLSL}

  uniform sampler2D uWater;
  uniform sampler2D uCaustics;
  uniform vec2 uWorldSize;
  uniform vec2 uMargin;
  uniform vec2 uTexel;
  uniform vec3 uBaseColor;
  uniform vec3 uSkyColor;
  uniform vec3 uCausticsColor;
  uniform float uCausticsStrength;
  uniform vec2 uCenter;
  uniform vec2 uPlaneHalfSize;
  uniform float uCoreFrac;

  varying vec3 vWorldPos;

  void main() {
    // Sample the live height-field sim for this point's surface normal
    // (stored in the .ba channels — see waterSim.js's UPDATE_FRAGMENT_SHADER).
    // uWorldSize/uMargin match waterWorldSize() below — the sim covers this
    // whole oversized area, centered on bounds rather than corner-anchored,
    // hence the margin shift before normalizing into [0, 1] uv space.
    vec2 uv = (vWorldPos.xz + uMargin) / uWorldSize;
    vec4 info = texture2D(uWater, uv);
    vec3 normal = normalize(vec3(info.b, sqrt(max(0.0, 1.0 - dot(info.ba, info.ba))), info.a));

    // Fresnel: water looks more like a mirror (sky-colored) at grazing
    // angles and more like its base color when viewed head-on.
    vec3 viewDir = normalize(cameraPosition - vWorldPos);
    float fresnel = pow(1.0 - clamp(dot(normal, viewDir), 0.0, 1.0), 3.0);
    vec3 color = mix(uBaseColor, uSkyColor, fresnel * 0.6);

    // Same causticGlow() read terrain.js uses, at this same point — the
    // surface glints with the same light pattern that lands underwater
    // instead of an unrelated procedural shimmer. Soft saturation instead
    // of a hard clamp — see terrain.js's identical curve for why.
    float glintStrength = causticGlow(uCaustics, uv, uTexel) * uCausticsStrength;
    float glint = 1.4 * glintStrength / (glintStrength + 1.4);
    color += uCausticsColor * glint * 0.35;

    // Edge fade: fully opaque out to uCoreFrac (exactly where the real
    // river bounds end — see buildWaterMesh), then a smooth dissolve across
    // the rest of the oversized plane out to its own edge. max() so the
    // fade wraps all four sides/corners of the rectangle evenly instead of
    // rounding it off into a circle.
    vec2 t = abs(vWorldPos.xz - uCenter) / uPlaneHalfSize;
    float edgeT = max(t.x, t.y);
    float edgeFade = 1.0 - smoothstep(uCoreFrac, 1.0, edgeT);

    color = applyFog(color, vWorldPos);

    // Semi-transparent: fish swim below the surface (world Y < 0), and the
    // caustics-lit riverbed sits further below still — both need to show
    // through, so this can't be an opaque sheet the way a pool's water
    // surface is in the source demo.
    gl_FragColor = vec4(color, 0.8 * edgeFade);
  }
`;

export function buildWaterMesh(bounds, causticsTextureSize) {
  // Drawn WATER_SIZE_MULTIPLIER bigger than the river bounds, but
  // re-centered on the same center point, so the extra size grows evenly
  // past the edges rather than shifting the visible area.
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
    uWorldSize: { value: new THREE.Vector2(planeWidth, planeHeight) },
    uMargin: { value: new THREE.Vector2(marginX, marginZ) },
    uTexel: {
      value: new THREE.Vector2(1 / causticsTextureSize, 1 / causticsTextureSize),
    },
    // The water body's own color, seen when looking straight down into it
    // before fresnel mixes any sky back in — overwritten by setSeason() to
    // track season.waterColor, which is derived from the same sky/depths
    // pair as the fog and riverbed (see season.js). This starting value
    // only shows before the first setSeason() call, as do the two below.
    uBaseColor: { value: new THREE.Color("#09223f") },
    // Reflected-sky tint the fresnel term (below) mixes in at grazing
    // angles — overwritten by setSeason() to track the sky sphere's own
    // skyColor (see sceneSetup.js/season.js) so the water reads as
    // reflecting the same sky rather than a fixed, season-blind tone.
    uSkyColor: { value: new THREE.Color("#1a56a8") },
    // Surface glint tint — overwritten by setSeason() to track the same
    // causticsColor1 fishMesh.js's two-tone glow uses.
    uCausticsColor: { value: new THREE.Color(0.75, 0.92, 0.98) },
    uCausticsStrength: { value: 8 },
    uCenter: { value: new THREE.Vector2(centerX, centerZ) },
    uPlaneHalfSize: {
      value: new THREE.Vector2(planeWidth / 2, planeHeight / 2),
    },
    // t-value (see fragment shader) where the real river bounds end —
    // exactly 1/WATER_SIZE_MULTIPLIER, since the plane is that much bigger.
    uCoreFrac: { value: 1 / WATER_SIZE_MULTIPLIER },
    uFogColor: { value: FOG_COLOR },
    uFogDensity: { value: fogDensity(bounds) },
  };

  const material = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: VERTEX_SHADER,
    fragmentShader: FRAGMENT_SHADER,
    transparent: true,
    depthWrite: false,
    // The fixed camera (see sceneSetup.js) only ever views this plane from
    // below, so single-sided would do — but the plane is a two-triangle
    // quad that writes no depth, so culling saves nothing measurable here,
    // and staying double-sided means moving the camera vantage can't make
    // the surface silently vanish.
    side: THREE.DoubleSide,
  });

  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = "water";

  // The water sim's ping-pong texture and the caustics accumulation target
  // (see causticsGenerator.js) both swap/update every frame — refresh both
  // uniforms each frame (see main.js's loop). uWater still drives this
  // surface's own normal/fresnel; uCaustics is only the glint overlay.
  function setSources(waterTexture, causticsTexture) {
    uniforms.uWater.value = waterTexture;
    uniforms.uCaustics.value = causticsTexture;
  }

  // Ties this surface's body color, its fresnel reflection tint, and its
  // glint to the same season driving the sky sphere/sun (see sceneSetup.js)
  // — called from main.js whenever the displayed date changes, and again
  // after any resize rebuilds this mesh (a fresh buildWaterMesh() call
  // otherwise resets these to the pre-season defaults above).
  function setSeason(dayOfYear) {
    const season = seasonForDay(dayOfYear);
    uniforms.uBaseColor.value.copy(season.waterColor);
    uniforms.uSkyColor.value.copy(season.skyColor);
    uniforms.uCausticsColor.value.copy(season.causticsColor1);
  }

  return { mesh, setSources, setSeason };
}
