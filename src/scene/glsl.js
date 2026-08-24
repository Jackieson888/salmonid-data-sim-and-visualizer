// glsl.js
// Shader code shared between the scene's hand-written materials, plus the one
// JS helper needed to interpolate numbers into them safely.
//
// These all started life as copy-pasted blocks — the caustics read in three
// files, the saturation curve in three, the edge fade in two, the water-normal
// reconstruction in two — each carrying a comment saying it matched the
// others. Keeping one definition is the only way that stays true.

import { QUALITY } from "../quality.js";

// ---------------------------------------------------------------------
// Interpolating numbers into GLSL
// ---------------------------------------------------------------------

// GLSL types a literal without a decimal point as an int ("350"), and an int
// argument finds no matching overload on float builtins like pow() — the
// shader then fails to compile and the surface renders as nothing at all,
// with no exception thrown. This forces a fractional part on so the literal is
// always a float.
//
// Non-integers pass through at full double precision rather than being rounded
// to a fixed number of decimals (terrain.js used to round to 4). That is not a
// behavior change: GLSL parses these to float32, whose ~7 significant digits
// round both spellings to the identical value.
export const glslFloat = (n) => (Number.isInteger(n) ? n.toFixed(1) : String(n));

// ---------------------------------------------------------------------
// Caustics
// ---------------------------------------------------------------------

// Reads the texture causticsGenerator.js renders each frame (see that file for
// how it's produced — a light camera + a refraction ray-march against the
// riverbed, ported from martinRenou/threejs-caustics). A light 4-tap box blur
// softens CAUSTICS_TARGET_SIZE's texel grid — the same role Renou's own PCF
// blur plays in his environment fragment shader, simplified since we don't
// need his depth-tested receiver logic. Used by terrain.js and water.js.
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

// Single-tap variant, used only by fishMesh.js's *vertex* shader.
//
// terrain.js/water.js read caustics per fragment across large, close-up
// surfaces where the 4-tap blur above is what hides CAUSTICS_TARGET_SIZE's
// texel grid. Fish are a different case on both counts: the read happens
// once per vertex (not per fragment) and the result is then interpolated
// across the triangle anyway, which is itself a blur — and a fish is small
// enough on screen that the grid was never resolvable there to begin with.
//
// The cost side is what makes this worth splitting out. The fish vertex
// shader also does 2 VAT samples, so the 5-tap blur put it at 7 vertex
// texture fetches per vertex; at 435 verts per fish and up to
// MAX_POPULATION instances (see main.js) that is the single largest term in
// the frame's vertex cost. Dropping to 1 tap takes it to 3.
//
// To A/B it, swap fishMesh.js's import back to CAUSTIC_GLOW_GLSL and restore
// its uTexel uniform.
export const CAUSTIC_GLOW_POINT_GLSL = /* glsl */ `
  float causticGlowPoint(sampler2D caustics, vec2 uv) {
    return texture2D(caustics, uv).r;
  }
`;

// ---------------------------------------------------------------------
// Caustics, faked
// ---------------------------------------------------------------------
//
// The low tier does not run the caustics pipeline at all — no water
// simulation, no environment map, no ray-marched accumulation target (see
// createWorld in main.js, which skips constructing both). This is what every
// consumer reads instead.
//
// Why the real one goes first on a weak device: causticsGenerator.js
// rasterizes a 257x257 grid whose *vertex* shader runs a 40-iteration loop
// with a texture fetch per iteration, and the height field feeding it is a
// 600^2 ping-pong relax pass doing seven fetches per texel per frame. Vertex
// texture fetch inside a loop is close to the worst case for older mobile
// GPUs. Between them they were the two most expensive things in the frame by
// a wide margin — far more than the fish, despite what this file used to say
// about vertex counts.
//
// What replaces them is not a cheaper simulation, it is a drawing of one.
// Real caustics are the bright network of lines where a rippled surface
// focuses sunlight, so what actually has to survive is a moving net of bright
// filaments with dark cells between them, at roughly the right scale. Two
// pairs of crossed travelling sine waves interfere into exactly that: the
// zero crossings of the sum form a shifting web, and raising the inverted
// distance-from-a-crossing to a power turns that web into thin bright lines
// with a soft falloff. Four sin() calls and a pow(), evaluated in-place,
// against five dependent reads from a half-float render target that something
// else had to fill first.
//
// It will not match the real light net and is not trying to. It preserves the
// presence of moving caustics everywhere the scene currently reads them —
// which is what the water, the shafts, the silt and the fish are all lit by.
//
// Wavenumber, in radians per world unit, so the web's cell spacing is
// 2*PI / PROC_CAUSTIC_SCALE ≈ 70 world units — about one fish length (72-84,
// see boids.js), which is roughly the spacing the real pass produces at this
// scene's depth. Coarser than this and the net stops reading as caustics and
// starts reading as large blobs drifting over everything.
const PROC_CAUSTIC_SCALE = 0.09;

export const CAUSTIC_GLOW_PROC_GLSL = /* glsl */ `
  float causticGlowProc(vec2 worldXZ, float time) {
    vec2 p = worldXZ * ${glslFloat(PROC_CAUSTIC_SCALE)};

    // Domain warp, and the reason this reads as caustics rather than as
    // wallpaper. Crossed sine pairs alone interfere into a *regular* lattice
    // — visibly a grid of identical cells, which is the one thing real
    // caustics never look like. Displacing the sample point by a slower,
    // differently-scaled wave before evaluating the pattern stretches and
    // pinches those cells unevenly and animates that distortion, which is
    // what the real thing does as the swell moves under it.
    p += vec2(
      sin(p.y * 0.5 + time * 0.30),
      cos(p.x * 0.45 - time * 0.25)
    ) * 0.85;

    // Two crossed wave pairs, at deliberately non-harmonic frequencies and
    // drift rates so the pattern never repeats or pulses in step with itself.
    float a = sin(p.x + time * 0.9) + sin(p.y * 1.17 - time * 0.7);
    float b = sin((p.x + p.y) * 0.73 + time * 1.1)
            + sin((p.x - p.y) * 0.91 - time * 0.5);

    // |a| + |b| is near zero along the crossings and rises away from them,
    // so this is a distance-to-the-web term. Inverted and sharpened into
    // thin filaments; the exponent is what separates "bright web on dark
    // water" from "generally mottled".
    //
    // The output scale is set against what the real pass actually
    // produces — causticsGenerator.js's CAUSTICS_FACTOR * area ratio, blurred,
    // lands mostly in the low tenths — because every consumer multiplies this
    // by its own strength constant (8 on the surface, 18 on the fish, 30 on
    // the shafts) that was tuned against that range.
    float web = 1.0 - clamp((abs(a) + abs(b)) * 0.42, 0.0, 1.0);
    return pow(web, 2.6) * 0.42;
  }
`;

// Procedural stand-in for one sample of the water simulation's height field,
// in the same RGBA convention waterSim.js writes and WATER_NORMAL_GLSL reads:
// (height, velocity, normal.x, normal.z).
//
// Only water.js needs this — it is the one surface that lights itself from the
// surface normal (Snell's window, the mirror, the glint) rather than just
// reading the caustic net. The normal comes from the analytic derivative of
// the height sum rather than from differencing neighbouring samples, which is
// both cheaper and exact.
//
// `velocity` is returned as 0: nothing downstream reads .g.
// Wavenumber, in radians per world unit: the base term's wavelength is
// 2*PI / PROC_WAVE_SCALE ≈ 300 world units, against a fish that renders 72-84
// nose to tail (see boids.js). That is the broad, slow swell the real
// simulation is tuned for (see the propagation/damping notes in waterSim.js),
// not pond chop.
const PROC_WAVE_SCALE = 0.021;

// World-Y amplitude of the height sum, matching WATER_HEIGHT_SCALE's role for
// the real sim.
const PROC_WAVE_HEIGHT = 0.35;

// How far the ripples are allowed to tilt the surface normal, as a slope.
//
// This is the single most sensitive number in the procedural path and it is
// worth saying why. water.js lights the surface through Snell's window, whose
// entire behaviour is a smoothstep across |dot(normal, viewDir)| between 0.6
// and 0.73 — a band about 8 degrees wide. A normal that swings further than
// that sweeps the whole window from fully open to fully mirrored and back,
// which does not read as ripples at all: it reads as huge organic lobes
// crawling across the ceiling. Real ripples perturb the normal by a couple of
// degrees, so the tilt has to stay well inside the window's own band.
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

    // d/dworldXZ of that sum. The chain rule brings the inner scale factor
    // back out, and each term carries its own frequency — but the common
    // factor of s is divided straight back out below, so it is left off here
    // and the result is a *normalized* slope in [-1, 1] rather than a true
    // derivative. That is what makes PROC_NORMAL_SLOPE a plain slope in world
    // units instead of a number that would silently change meaning every time
    // the wavelength was retuned.
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
// The signature deliberately carries the inputs BOTH paths could want, and
// each implementation ignores the ones it doesn't — the texture path never
// looks at worldXZ or time, the procedural path never looks at the sampler or
// uv. Passing the sampler as a parameter (which GLSL permits, and which the
// two functions above already did) is what keeps this a pure drop-in: a
// consumer's uniform block, its declaration order, and the chunk's position at
// the top of the shader all stay exactly as they were. In procedural mode the
// unused sampler is dead code and the compiler drops it, so nothing has to
// bind a texture that no longer exists.
//
// `taps` selects the 5-tap box blur (large close-up surfaces, where the
// accumulation target's texel grid would otherwise be visible) or a single
// tap (per-vertex reads, and anything small enough on screen that the grid
// never resolved). It is ignored entirely on the procedural path, which has
// no texels to blur.
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
    float causticGlowAt(sampler2D caustics, vec2 uv, vec2 texel,
                        vec2 worldXZ, float time) {
      return ${read};
    }
  `;
}

// Same idea for the water surface's own height/normal sample. Only water.js
// calls this — it is the one surface lit from the surface normal itself
// (Snell's window, the mirror outside it, the glint) rather than just reading
// the caustic net.
//
//   vec4 waterInfoAt(sampler2D water, vec2 uv, vec2 worldXZ, float time)
//
// Returns waterSim.js's (height, velocity, normal.x, normal.z) either way, so
// WATER_NORMAL_GLSL's waterSurfaceNormal() consumes both identically.
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
// terrain.js, water.js and fishMesh.js alike.
//
// Real caustics are an extremely peaky signal — a few tiny, very bright focal
// points against a mostly-dim field — so a hard min() clamp made "dim" and
// "very bright" read as either invisible or maxed-out with no gradation in
// between. It also popped: the live water sim's curvature spikes frame to
// frame, and a hard clamp turns "just under the cap" and "just over it" into a
// visible on/off flicker every time a spike crosses that line. This curve's
// slope shrinks as it approaches the ceiling, so the same spike lands as a
// much smaller, smoother change in brightness.
//
// The ceiling is exposed as a constant because fishMesh.js also divides by it,
// to normalize the saturated value back into [0, 1] for its two-tone caustic
// color mix.
export const CAUSTIC_SATURATE_GLSL = /* glsl */ `
  const float CAUSTIC_GLOW_CEILING = 1.4;

  float softSaturate(float x) {
    return CAUSTIC_GLOW_CEILING * x / (x + CAUSTIC_GLOW_CEILING);
  }
`;

// ---------------------------------------------------------------------
// Surfaces
// ---------------------------------------------------------------------

// The water surface and the riverbed are both drawn waterSizeMultiplier()
// bigger than the real river bounds (see water.js), fully opaque out to
// `coreFrac` — exactly where those bounds end — and then dissolving across the
// added margin to nothing at the plane's own edge, so the rectangle disappears
// into the fog instead of cutting off as a hard silhouette line.
//
// max() of the two axes rather than length(), so the fade wraps all four
// sides and corners of the rectangle evenly instead of rounding it into a
// circle.
export const EDGE_FADE_GLSL = /* glsl */ `
  float planeEdgeFade(vec2 worldXZ, vec2 center, vec2 halfSize, float coreFrac) {
    vec2 t = abs(worldXZ - center) / halfSize;
    return 1.0 - smoothstep(coreFrac, 1.0, max(t.x, t.y));
  }
`;

// Rebuilds the water surface normal from one sample of the sim texture, whose
// RGBA is (height, velocity, normal.x, normal.z) — see waterSim.js's
// UPDATE_FRAGMENT_SHADER. Only the two tangential components are stored, so
// the vertical one is recovered on the assumption of a unit normal.
//
// Shared by water.js (which lights the surface with it) and
// causticsGenerator.js (which refracts through it). No axis swizzle: our Y-up
// world already matches this convention, where Renou's Z-up source needs a
// .xzy here.
export const WATER_NORMAL_GLSL = /* glsl */ `
  vec3 waterSurfaceNormal(vec4 info) {
    return normalize(vec3(
      info.b,
      sqrt(max(0.0, 1.0 - dot(info.ba, info.ba))),
      info.a
    ));
  }
`;
