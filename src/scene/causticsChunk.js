// causticsChunk.js
// Real caustics, read straight off the texture causticsGenerator.js renders
// each frame (see that file for how it's produced — a light camera + a
// refraction ray-march against the riverbed, ported from
// martinRenou/threejs-caustics). This function is just the shared read: a
// light 4-tap box blur (softens CAUSTICS_TARGET_SIZE's texel grid — the
// same role Renou's own PCF blur plays in his environment fragment shader,
// simplified since we don't need his depth-tested receiver logic — see
// call sites in terrain.js/water.js/fishMesh.js) around the accumulated
// intensity (.r channel). Shared by terrain.js, water.js, and fishMesh.js.
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
