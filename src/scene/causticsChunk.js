// causticsChunk.js
// Minimal, stylized stand-in for real caustics: brightness comes from how
// much the water surface curves at a point (concave/converging = bright
// "light net", convex/diverging = dark), read straight off the water sim's
// height channel via a 4-tap Laplacian. No light camera, no ray-marching,
// no separate accumulation pass — just one texture sample pattern.
// Not physically accurate, but this project's look is watercolor-stylized
// rather than photoreal, so the soft blobby glow this produces is the goal,
// not a compromise. Shared by terrain.js and water.js today; the same
// function (water texture + a world-space uv) is the extension point for
// eventually tinting the fish as they pass under bright patches.
export const CAUSTIC_GLOW_GLSL = /* glsl */ `
  float causticGlow(sampler2D water, vec2 uv, vec2 texel) {
    float h = texture2D(water, uv).r;
    float sum = texture2D(water, uv + vec2(texel.x, 0.0)).r
      + texture2D(water, uv - vec2(texel.x, 0.0)).r
      + texture2D(water, uv + vec2(0.0, texel.y)).r
      + texture2D(water, uv - vec2(0.0, texel.y)).r;
    float curvature = sum - 4.0 * h;
    return max(0.0, -curvature);
  }
`;
