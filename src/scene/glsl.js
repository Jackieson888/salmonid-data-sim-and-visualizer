// glsl.js
// Shader code shared between the scene's hand-written materials, plus the one
// JS helper needed to interpolate numbers into them safely.
//
// These all started life as copy-pasted blocks — the caustics read in three
// files, the saturation curve in three, the edge fade in two, the water-normal
// reconstruction in two — each carrying a comment saying it matched the
// others. Keeping one definition is the only way that stays true.

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
// texture fetches per vertex; at ~1300 verts per fish and up to
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

// The water surface and the riverbed are both drawn WATER_SIZE_MULTIPLIER
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
