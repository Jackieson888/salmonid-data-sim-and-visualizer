// Shader code shared between the scene's hand-written materials, plus the JS helper that interpolates numbers into them.
import { QUALITY } from "../quality.js";

// GLSL types a bare literal as an int, which silently fails to compile against float builtins like pow().
export const glslFloat = (n) => (Number.isInteger(n) ? n.toFixed(1) : String(n));

// Reads the texture causticsGenerator.js renders each frame; 4-tap box blur softens the texel grid. Used by terrain.js and water.js.
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

// Single-tap variant for fishMesh.js's vertex shader, where the 5-tap blur's vertex-texture-fetch cost isn't worth it.
export const CAUSTIC_GLOW_POINT_GLSL = /* glsl */ `
  float causticGlowPoint(sampler2D caustics, vec2 uv) {
    return texture2D(caustics, uv).r;
  }
`;

// Low tier's stand-in for the real-caustics pipeline: crossed sine waves instead of a ray-march.
// Cell spacing is 2*PI / PROC_CAUSTIC_SCALE ≈ 70 world units, about one fish length.
const PROC_CAUSTIC_SCALE = 0.09;

export const CAUSTIC_GLOW_PROC_GLSL = /* glsl */ `
  float causticGlowProc(vec2 worldXZ, float time) {
    vec2 p = worldXZ * ${glslFloat(PROC_CAUSTIC_SCALE)};

    // Domain warp — why this reads as caustics rather than a regular lattice pattern.
    p += vec2(
      sin(p.y * 0.5 + time * 0.30),
      cos(p.x * 0.45 - time * 0.25)
    ) * 0.85;

    // Two crossed wave pairs at non-harmonic frequencies so the pattern never repeats or pulses in step.
    float a = sin(p.x + time * 0.9) + sin(p.y * 1.17 - time * 0.7);
    float b = sin((p.x + p.y) * 0.73 + time * 1.1)
            + sin((p.x - p.y) * 0.91 - time * 0.5);

    // Distance-to-the-web term, inverted and sharpened into thin filaments.
    float web = 1.0 - clamp((abs(a) + abs(b)) * 0.42, 0.0, 1.0);
    return pow(web, 2.6) * 0.42;
  }
`;

// Procedural stand-in for one sample of the water sim's height field, in waterSim.js's RGBA convention.
// Normal comes from the analytic derivative, not neighbor differencing; `velocity` (.g) is always 0.
// Wavelength is 2*PI / PROC_WAVE_SCALE ≈ 300 world units.
const PROC_WAVE_SCALE = 0.021;

// World-Y amplitude, matching WATER_HEIGHT_SCALE's role for the real sim.
const PROC_WAVE_HEIGHT = 0.35;

// How far ripples tilt the surface normal; the most sensitive number in the procedural path.
const PROC_NORMAL_SLOPE = 0.09;

export const WATER_INFO_PROC_GLSL = /* glsl */ `
  vec4 proceduralWaterInfo(vec2 worldXZ, float time) {
    const float s = ${glslFloat(PROC_WAVE_SCALE)};
    vec2 p = worldXZ * s;

    // Three travelling waves at non-harmonic frequencies, so the surface never visibly repeats.
    float h = sin(p.x + time * 0.6) * 0.55
            + sin(p.y * 1.31 - time * 0.8) * 0.32
            + sin((p.x + p.y) * 0.67 + time * 1.2) * 0.22;

    // d/dworldXZ of that sum, scale factor s left off so this is a normalized slope, not a true derivative.
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

// The one entry point every caustics consumer calls, resolved at material build time from the current tier.
// `taps` (5-tap blur vs. single tap) is ignored on the procedural path, which has no texels to blur.
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

    // Fades the net out across the outer band of uv and kills it outside [0, 1] — the CLAMP-sampled
    // accumulation target would otherwise smear the edge texel infinitely past its coverage.
    float causticGlowAt(sampler2D caustics, vec2 uv, vec2 texel,
                        vec2 worldXZ, float time) {
      vec2 d = min(uv, 1.0 - uv);
      float edge = smoothstep(0.0, ${CAUSTICS_EDGE_FADE.toFixed(3)}, min(d.x, d.y));
      if (edge <= 0.0) return 0.0;
      return ${read} * edge;
    }
  `;
}

// Same idea for the water surface's height/normal sample; only water.js calls this.
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

// Soft (Reinhard-style) saturation applied to the raw caustic intensity, avoiding both clipping and flicker.
export const CAUSTIC_SATURATE_GLSL = /* glsl */ `
  const float CAUSTIC_GLOW_CEILING = 1.4;

  float softSaturate(float x) {
    return CAUSTIC_GLOW_CEILING * x / (x + CAUSTIC_GLOW_CEILING);
  }
`;

// Water surface and riverbed both drawn oversized, opaque out to coreFrac, dissolving at the plane's edge.
// max() of the two axes, not length(), wraps the fade around all four sides/corners rather than a circle.
export const EDGE_FADE_GLSL = /* glsl */ `
  float planeEdgeFade(vec2 worldXZ, vec2 center, vec2 halfSize, float coreFrac) {
    vec2 t = abs(worldXZ - center) / halfSize;
    return 1.0 - smoothstep(coreFrac, 1.0, max(t.x, t.y));
  }
`;

// Rebuilds the water surface normal from one sim-texture sample; only the two tangential components are stored.
export const WATER_NORMAL_GLSL = /* glsl */ `
  vec3 waterSurfaceNormal(vec4 info) {
    return normalize(vec3(
      info.b,
      sqrt(max(0.0, 1.0 - dot(info.ba, info.ba))),
      info.a
    ));
  }
`;
