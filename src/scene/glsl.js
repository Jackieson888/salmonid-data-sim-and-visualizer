// glsl.js
// Design rationale, invariants, gotchas: .claude/context/scene/glsl.md
// Shader code shared between the scene's hand-written materials (the
// caustics read, the saturation curve, the edge fade, water-normal
// reconstruction), plus the JS helper that interpolates numbers into them
// safely. One definition each, rather than copy-pasted blocks that drift.

import { QUALITY } from "../quality.js";

// ---------------------------------------------------------------------
// Interpolating numbers into GLSL
// ---------------------------------------------------------------------

// GLSL types a bare literal ("350") as an int, which fails to compile against
// float builtins like pow() with no exception thrown — the surface just
// renders as nothing. This forces a fractional part so it's always a float.
export const glslFloat = (n) => (Number.isInteger(n) ? n.toFixed(1) : String(n));

// ---------------------------------------------------------------------
// Caustics
// ---------------------------------------------------------------------

// Reads the texture causticsGenerator.js renders each frame (light camera +
// refraction ray-march against the riverbed, ported from
// martinRenou/threejs-caustics). 4-tap box blur softens the texel grid — see
// glsl.md. Used by terrain.js and water.js.
export const CAUSTIC_GLOW_GLSL = /* glsl */ `
  float causticGlow(sampler2D caustics, vec2 uv, vec2 texel) {
    float center = texture2D(caustics, uv).r;
    float sum = texture2D(caustics, uv + vec2(texel.x, 0.0)).r
      + texture2D(caustics, uv - vec2(texel.x, 0.0)).r
      + texture2D(caustics, uv + vec2(0.0, texel.y)).r
      + texture2D(caustics, uv - vec2(0.0, texel.y)).r;
    return (center + sum) / 5.0;
  }
`;

// Single-tap variant, used only by fishMesh.js's *vertex* shader — the 5-tap
// blur's vertex-texture-fetch cost isn't worth it there. See glsl.md; to A/B
// it, swap fishMesh.js's import back to CAUSTIC_GLOW_GLSL and restore its
// uTexel uniform.
export const CAUSTIC_GLOW_POINT_GLSL = /* glsl */ `
  float causticGlowPoint(sampler2D caustics, vec2 uv) {
    return texture2D(caustics, uv).r;
  }
`;

// ---------------------------------------------------------------------
// Caustics, faked — the low tier's stand-in for the whole real-caustics
// pipeline (see createWorld in main.js and glsl.md for why it's cut, and why
// crossed sine waves are what replace it).
// ---------------------------------------------------------------------
//
// Wavenumber: cell spacing is 2*PI / PROC_CAUSTIC_SCALE ≈ 70 world units,
// about one fish length (72-84, see boids.js) — see glsl.md.
const PROC_CAUSTIC_SCALE = 0.09;

export const CAUSTIC_GLOW_PROC_GLSL = /* glsl */ `
  float causticGlowProc(vec2 worldXZ, float time) {
    vec2 p = worldXZ * ${glslFloat(PROC_CAUSTIC_SCALE)};

    // Domain warp — why this reads as caustics rather than a regular
    // lattice/wallpaper pattern. See glsl.md.
    p += vec2(
      sin(p.y * 0.5 + time * 0.30),
      cos(p.x * 0.45 - time * 0.25)
    ) * 0.85;

    // Two crossed wave pairs, at deliberately non-harmonic frequencies and
    // drift rates so the pattern never repeats or pulses in step with itself.
    float a = sin(p.x + time * 0.9) + sin(p.y * 1.17 - time * 0.7);
    float b = sin((p.x + p.y) * 0.73 + time * 1.1)
            + sin((p.x - p.y) * 0.91 - time * 0.5);

    // Distance-to-the-web term, inverted and sharpened into thin filaments.
    // Output scale matched to the real pass's range — see glsl.md.
    float web = 1.0 - clamp((abs(a) + abs(b)) * 0.42, 0.0, 1.0);
    return pow(web, 2.6) * 0.42;
  }
`;

// Procedural stand-in for one sample of the water sim's height field, in the
// same RGBA convention waterSim.js writes and WATER_NORMAL_GLSL reads:
// (height, velocity, normal.x, normal.z). Only water.js needs this. Normal
// comes from the analytic derivative, not neighbor differencing — cheaper
// and exact. `velocity` is always 0: nothing downstream reads .g.
//
// Wavenumber: wavelength is 2*PI / PROC_WAVE_SCALE ≈ 300 world units, the
// broad slow swell the real sim is tuned for (see glsl.md).
const PROC_WAVE_SCALE = 0.021;

// World-Y amplitude, matching WATER_HEIGHT_SCALE's role for the real sim.
const PROC_WAVE_HEIGHT = 0.35;

// How far the ripples tilt the surface normal, as a slope. The single most
// sensitive number in the procedural path — see glsl.md (Snell's window is
// only an ~8-degree band; swing further and it reads as lobes, not ripples).
const PROC_NORMAL_SLOPE = 0.09;

export const WATER_INFO_PROC_GLSL = /* glsl */ `
  vec4 proceduralWaterInfo(vec2 worldXZ, float time) {
    const float s = ${glslFloat(PROC_WAVE_SCALE)};
    vec2 p = worldXZ * s;

    // Three travelling waves at non-harmonic frequencies, so the surface
    // never visibly repeats or beats against itself.
    float h = sin(p.x + time * 0.6) * 0.55
            + sin(p.y * 1.31 - time * 0.8) * 0.32
            + sin((p.x + p.y) * 0.67 + time * 1.2) * 0.22;

    // d/dworldXZ of that sum, with the common scale factor s left off so the
    // result is a *normalized* slope in [-1, 1], not a true derivative — see
    // glsl.md for why that's what keeps PROC_NORMAL_SLOPE meaningful.
    float dhdx = cos(p.x + time * 0.6) * 0.55
               + cos((p.x + p.y) * 0.67 + time * 1.2) * 0.22 * 0.67;
    float dhdz = cos(p.y * 1.31 - time * 0.8) * 0.32 * 1.31
               + cos((p.x + p.y) * 0.67 + time * 1.2) * 0.22 * 0.67;

    // A height field's normal is (-dh/dx, 1, -dh/dz), normalized.
    const float k = ${glslFloat(PROC_NORMAL_SLOPE)};
    vec3 n = normalize(vec3(-dhdx * k, 1.0, -dhdz * k));
    return vec4(h * ${glslFloat(PROC_WAVE_HEIGHT)}, 0.0, n.x, n.z);
  }
`;

// ---------------------------------------------------------------------
// Picking between them
// ---------------------------------------------------------------------

// The one entry point every caustics consumer calls, resolved at material
// build time from the current tier. Returns GLSL defining:
//
//   float causticGlowAt(sampler2D caustics, vec2 uv, vec2 texel,
//                       vec2 worldXZ, float time)
//
// Signature carries the inputs BOTH paths could want, so this stays a pure
// drop-in — see glsl.md. `taps` (5-tap blur vs. single tap) is ignored on
// the procedural path, which has no texels to blur.
//
// Per-side band of caustics coverage spent dissolving the net to nothing, in
// uv units (0.08 = outer 8% of each edge).
const CAUSTICS_EDGE_FADE = 0.08;

export function causticGlowChunk({ taps = 1 } = {}) {
  if (!QUALITY.realCaustics) {
    return /* glsl */ `
      ${CAUSTIC_GLOW_PROC_GLSL}
      float causticGlowAt(sampler2D caustics, vec2 uv, vec2 texel,
                          vec2 worldXZ, float time) {
        return causticGlowProc(worldXZ, time);
      }
    `;
  }

  const read =
    taps >= 5 ? "causticGlow(caustics, uv, texel)" : "causticGlowPoint(caustics, uv)";

  return /* glsl */ `
    ${taps >= 5 ? CAUSTIC_GLOW_GLSL : CAUSTIC_GLOW_POINT_GLSL}

    // Fades the net out across the outer band of uv (CAUSTICS_EDGE_FADE) and
    // kills it outside [0, 1]. Not optional — the CLAMP-sampled accumulation
    // target smears the edge texel infinitely past its coverage otherwise.
    // See glsl.md.
    float causticGlowAt(sampler2D caustics, vec2 uv, vec2 texel,
                        vec2 worldXZ, float time) {
      vec2 d = min(uv, 1.0 - uv);
      float edge = smoothstep(0.0, ${CAUSTICS_EDGE_FADE.toFixed(3)}, min(d.x, d.y));
      if (edge <= 0.0) return 0.0;
      return ${read} * edge;
    }
  `;
}

// Same idea for the water surface's own height/normal sample. Only water.js
// calls this. Returns waterSim.js's (height, velocity, normal.x, normal.z)
// either way, so WATER_NORMAL_GLSL's waterSurfaceNormal() consumes both
// identically.
//
//   vec4 waterInfoAt(sampler2D water, vec2 uv, vec2 worldXZ, float time)
export function waterInfoChunk() {
  if (!QUALITY.realCaustics) {
    return /* glsl */ `
      ${WATER_INFO_PROC_GLSL}
      vec4 waterInfoAt(sampler2D water, vec2 uv, vec2 worldXZ, float time) {
        return proceduralWaterInfo(worldXZ, time);
      }
    `;
  }

  return /* glsl */ `
    vec4 waterInfoAt(sampler2D water, vec2 uv, vec2 worldXZ, float time) {
      return texture2D(water, uv);
    }
  `;
}

// Soft (Reinhard-style) saturation, applied to the raw caustic intensity by
// terrain.js, water.js and fishMesh.js alike — avoids both the clipped
// "invisible or maxed-out" look and the frame-to-frame flicker a hard min()
// clamp gives against the live water sim's curvature spikes. See glsl.md.
// The ceiling is exposed because fishMesh.js also divides by it.
export const CAUSTIC_SATURATE_GLSL = /* glsl */ `
  const float CAUSTIC_GLOW_CEILING = 1.4;

  float softSaturate(float x) {
    return CAUSTIC_GLOW_CEILING * x / (x + CAUSTIC_GLOW_CEILING);
  }
`;

// ---------------------------------------------------------------------
// Surfaces
// ---------------------------------------------------------------------

// The water surface and riverbed are both drawn oversized (see water.js),
// opaque out to `coreFrac`, then dissolving to nothing at the plane's edge.
// max() of the two axes, not length(), wraps the fade evenly around all four
// sides/corners instead of rounding it into a circle.
export const EDGE_FADE_GLSL = /* glsl */ `
  float planeEdgeFade(vec2 worldXZ, vec2 center, vec2 halfSize, float coreFrac) {
    vec2 t = abs(worldXZ - center) / halfSize;
    return 1.0 - smoothstep(coreFrac, 1.0, max(t.x, t.y));
  }
`;

// Rebuilds the water surface normal from one sim-texture sample: (height,
// velocity, normal.x, normal.z) — see waterSim.js. Only the two tangential
// components are stored; the vertical one is recovered assuming a unit
// normal. Shared by water.js and causticsGenerator.js. No axis swizzle: our
// Y-up world already matches this convention (Renou's Z-up source needs .xzy).
export const WATER_NORMAL_GLSL = /* glsl */ `
  vec3 waterSurfaceNormal(vec4 info) {
    return normalize(vec3(
      info.b,
      sqrt(max(0.0, 1.0 - dot(info.ba, info.ba))),
      info.a
    ));
  }
`;
