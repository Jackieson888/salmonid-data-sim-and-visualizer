// water.js
// Water surface: a flat plane at world Y=0, fragment-shaded from the live
// GPU height-field simulation in waterSim.js (real ripples, not a canned
// texture) and lit by the same causticGlow() helper terrain.js uses (see
// glsl.js), so the sparkle on the surface and the light net on the riverbed
// come from one consistent read of the same water texture.
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
// The plane itself is drawn larger than the river bounds (waterSizeMultiplier())
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
// into this sim's uv space (main.js's ripple placement, fishMesh.js's caustic
// sampling) must use the same waterWorldSize() to stay in registration.

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

// How much bigger than the river bounds the water sim/plane covers — the
// entire added margin (from the real edge out to the plane's own edge) is
// both the caustics fade zone and the region the sim can propagate ripples
// into, so a bigger multiplier reads as a longer, softer dissolve.
//
// Scaled by device tier (see quality.js), because this number is squared into
// fill cost: the water surface and the riverbed are each one big fragment-heavy
// quad covering this area, so 2.4 draws 5.8x the bounds while 1.7 draws 2.9x —
// a little over half the fragments for both surfaces. The fog closes in well
// before the plane's edge at the low tier's shorter view anyway, so the
// dissolve it is shortening was mostly already invisible.
//
// A function rather than the `const` this used to be: the performance governor
// can change tiers mid-session (see quality.js), and a const would have frozen
// whatever value happened to be current when this module was first imported.
// Every caller reads it while building bounds-shaped resources, which is
// exactly the work a tier change re-runs.
export const waterSizeMultiplier = () => QUALITY.waterSizeMultiplier;

// World-Y scale for the sim's raw height (.r channel) — the sim itself is
// unitless (see waterSim.js). This mesh no longer displaces its own
// geometry with it (see file header) but causticsGenerator.js's refraction
// ray-march still needs a world-unit calibration for the sim height, and
// imports this constant to stay consistent with whatever this file settles
// on rather than guessing its own independent number.
export const WATER_HEIGHT_SCALE = 150;

// ---------------------------------------------------------------------
// Snell's window
// ---------------------------------------------------------------------
// Seen from underneath, the surface is not a window everywhere. Refraction
// squeezes the entire 180-degree world above into a cone about the vertical
// — Snell's window — and outside that cone the interface is a perfect
// mirror by total internal reflection, showing the water column and bed
// below rather than anything above. So the ceiling reads as a bright disc
// of sky ringed by dark mirrored murk, with the ripples wobbling the
// boundary between them, which is the single most recognizable thing about
// looking up from underwater.
//
// cos of the critical angle, water -> air: sin(t) = 1 / 1.333 gives
// t = 48.6 degrees, so the window closes where the view ray is that far off
// the surface normal. Compared against |dot(normal, viewDir)|, which is 1
// looking straight up the normal and 0 at grazing.
//
// The real transition is abrupt — reflectance hits 100% exactly at the
// critical angle — but a hard step aliases badly against a rippling normal
// at this plane's grazing screen angles, so it gets a narrow smoothstep
// either side rather than a clean edge.
const COS_CRITICAL_MIN = 0.6;
const COS_CRITICAL_MAX = 0.73;

// How much sky the window shows, against the water body's own color. Not
// 1.0: the ray still crossed the water between the surface and the eye, and
// the plane is drawn over a sky sphere that is itself already showing a
// (fogged) sky through the same window (see sceneSetup.js), so a fully
// sky-colored plane double-counts it.
const WINDOW_SKY_MIX = 0.8;

// The surface glint (see the fragment shader) is refracted sunlight, so
// strictly it belongs inside the window and not to the mirror outside it.
// Killing it out there entirely costs the whole upper frame its sparkle,
// though — the window is a small part of what is on screen — so the mirror
// keeps this fraction of it, read as the same light net glimpsed in
// reflection.
const MIRROR_GLINT = 0.5;

// {width, height} = the sim/plane's actual world coverage, oversized by
// waterSizeMultiplier(); {marginX, marginZ} = how far that coverage extends
// past bounds on each side (the plane is centered on bounds, not corner
// anchored, so this offset is what keeps world->uv math consistent).
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

const VERTEX_SHADER = /* glsl */ `
  varying vec3 vWorldPos;
  void main() {
    vWorldPos = position;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const FRAGMENT_SHADER = /* glsl */ `
  ${causticGlowChunk({ taps: 5 })}
  ${waterInfoChunk()}
  ${CAUSTIC_SATURATE_GLSL}
  ${EDGE_FADE_GLSL}
  ${WATER_NORMAL_GLSL}
  ${FOG_GLSL}

  uniform sampler2D uWater;
  uniform sampler2D uCaustics;
  uniform vec2 uWorldSize;
  uniform vec2 uMargin;
  uniform vec2 uTexel;
  // Drives the procedural surface/caustics at the low tier, where there is no
  // simulation to read (see quality.js). Unused — and compiled out — on the
  // tiers that run the real pipeline, but pushed unconditionally so the
  // per-frame call has no branch in it.
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
    // Sample the live height-field sim for this point's surface normal
    // (stored in the .ba channels — see waterSim.js's UPDATE_FRAGMENT_SHADER).
    // uWorldSize/uMargin match waterWorldSize() below — the sim covers this
    // whole oversized area, centered on bounds rather than corner-anchored,
    // hence the margin shift before normalizing into [0, 1] uv space.
    vec2 uv = (vWorldPos.xz + uMargin) / uWorldSize;
    vec3 normal = waterSurfaceNormal(waterInfoAt(uWater, uv, vWorldPos.xz, uTime));

    // Snell's window (see the note above): sky inside the cone, mirrored
    // water column outside it.
    //
    // This replaces a fresnel term that could not run. It was
    // pow(1 - clamp(dot(normal, viewDir), 0, 1), 3), and waterSurfaceNormal()
    // builds its Y out of a sqrt so the normal always points up, while the
    // camera is always under the plane so viewDir always points down — that
    // dot product was negative on every fragment of every frame, clamped to
    // 0, and left fresnel pinned at exactly 1.0. The ceiling was a flat
    // mix(uBaseColor, uSkyColor, 0.6) with only the glint varying across it.
    //
    // abs() rather than a clamp, because that sign is the whole problem:
    // what matters is the angle between the ray and the surface, not which
    // side of it the eye is on.
    vec3 viewDir = normalize(cameraPosition - vWorldPos);
    float cosView = abs(dot(normal, viewDir));
    float window = smoothstep(
      ${f(COS_CRITICAL_MIN)}, ${f(COS_CRITICAL_MAX)}, cosView
    );

    // What the mirror shows: the murk the reflected ray descends into.
    // reflect() takes the incident direction (-viewDir, the ray traveling
    // from the eye up to the surface), so this points back down into the
    // column, and one fog length along it is where that reflection stops
    // resolving anything — the same probe the sky sphere's background uses
    // (see sceneSetup.js). It lands at the right brightness on its own:
    // just outside the window the ray dives steeply into the dark deep,
    // while at grazing angles it stays shallow and the surface dissolves
    // into the same haze as the water behind it instead of ending on a
    // hard line.
    vec3 mirrorDir = reflect(-viewDir, normal);
    vec3 mirrored = fogColorAt(vWorldPos + mirrorDir / uFogDensity);

    vec3 color = mix(
      mirrored, mix(uBaseColor, uSkyColor, ${f(WINDOW_SKY_MIX)}), window
    );

    // Same causticGlow() read terrain.js uses, at this same point — the
    // surface glints with the same light pattern that lands underwater
    // instead of an unrelated procedural shimmer, through the same
    // softSaturate() curve (see glsl.js).
    float glint = softSaturate(
      causticGlowAt(uCaustics, uv, uTexel, vWorldPos.xz, uTime) * uCausticsStrength
    );
    color +=
      uCausticsColor * glint * 0.35 * mix(${f(MIRROR_GLINT)}, 1.0, window);

    // Fully opaque out to uCoreFrac (exactly where the real river bounds end
    // — see buildWaterMesh), then a smooth dissolve across the rest of the
    // oversized plane out to its own edge; the riverbed does the same at the
    // same edge (see planeEdgeFade in glsl.js).
    float edgeFade =
      planeEdgeFade(vWorldPos.xz, uCenter, uPlaneHalfSize, uCoreFrac);

    color = applyFog(color, vWorldPos);

    // Semi-transparent: fish swim below the surface (world Y < 0), and the
    // caustics-lit riverbed sits further below still — both need to show
    // through, so this can't be an opaque sheet the way a pool's water
    // surface is in the source demo.
    gl_FragColor = vec4(color, 0.8 * edgeFade);
  }
`;

export function buildWaterMesh(bounds, causticsTextureSize) {
  // Drawn waterSizeMultiplier() bigger than the river bounds, but
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
    uTime: { value: 0 },
    uWorldSize: { value: new THREE.Vector2(planeWidth, planeHeight) },
    uMargin: { value: new THREE.Vector2(marginX, marginZ) },
    uTexel: {
      value: new THREE.Vector2(1 / causticsTextureSize, 1 / causticsTextureSize),
    },
    // The water body's own color, which is what the window shows before
    // the sky is mixed into it — overwritten by setSeason() to track
    // season.waterColor, which is derived from the same sky/depths pair as
    // the fog and riverbed (see season.js). This starting value only shows
    // before the first setSeason() call, as do the two below.
    uBaseColor: { value: new THREE.Color("#09223f") },
    // The sky seen through Snell's window (see the fragment shader) —
    // overwritten by setSeason() to track the sky sphere's own skyColor
    // (see sceneSetup.js/season.js) so the surface shows the same sky
    // overhead rather than a fixed, season-blind tone.
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
    // exactly 1/waterSizeMultiplier(), since the plane is that much bigger.
    uCoreFrac: { value: 1 / waterSizeMultiplier() },
    uFogColor: { value: FOG_COLOR },
    uFogDensity: { value: fogDensity(bounds) },
    // Sits at world Y = 0, so this surface's own fog is the top (undarkened)
    // end of the depth ramp — it is passed for the fish and riverbed below
    // it to be graded consistently against, not because the plane itself
    // moves down the ramp. See fog.js.
    uFogDepthRate: { value: fogDepthRate(bounds) },
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

  // The water sim alternates between two ping-pong render targets, so the
  // texture driving this surface's normals is a different object from
  // one frame to the next — hence a per-frame setter (see main.js's loop).
  function setWaterTexture(waterTexture) {
    uniforms.uWater.value = waterTexture;
  }

  // The caustics glint overlay, by contrast, comes from a single accumulation
  // target that is cleared and re-rendered in place (see
  // causticsGenerator.js), so its texture object never changes identity.
  // Bound once when the world is built rather than re-assigned every frame.
  function setCausticsTexture(causticsTexture) {
    uniforms.uCaustics.value = causticsTexture;
  }

  // Ties this surface's body color, the sky its window shows, and its
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

  // Drives the procedural surface and glint at the low tier, where there is no
  // simulation to sample (see quality.js). Takes the same simulation clock
  // every other animated thing in the scene reads, so the surface freezes on
  // pause along with the rest of it.
  function setTime(seconds) {
    uniforms.uTime.value = seconds;
  }

  return { mesh, setWaterTexture, setCausticsTexture, setSeason, setTime };
}
