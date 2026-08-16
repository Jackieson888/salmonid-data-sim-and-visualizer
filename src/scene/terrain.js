// terrain.js
// Flat riverbed floor: a simple plane sitting below the water surface that
// exists mainly to catch the real-time caustic glow (see causticsChunk.js/
// causticsGenerator.js). No banks or island — fish swim through the open
// water column above it.

import * as THREE from "three";
import { CAUSTIC_GLOW_GLSL } from "./causticsChunk.js";
import { FOG_GLSL, FOG_COLOR, fogDensity } from "./fog.js";
import { seasonForDay } from "./season.js";
import { waterWorldSize, WATER_SIZE_MULTIPLIER } from "./water.js";

// Floor depth below the water surface, as a fraction of bounds.height.
// Was 0.5, which put the bed far enough under the camera that the heavy
// river fog (see fog.js) erased it everywhere except a thin strip along the
// bottom of frame — all the gravel detail below was invisible. A salmon run
// is shallow water anyway: dropping this brings the bed and the surface
// both inside the near field, which is what lets a single shot hold lit
// gravel below and the bright surface above, the way the real thing reads.
export const RIVER_DEPTH_FRAC = 0.34;

const GRID_STEP = 20; // world units per floor vertex — just enough for gentle per-vertex shade noise

const SHADE_NOISE = 0.05; // per-vertex brightness jitter, keeps the floor from reading as flat-shaded

// Average world-unit width of one stone, for the two Voronoi layers in the
// fragment shader: rounded cobbles with finer gravel packed between them.
// Scaled against a fish, which renders 72-84 world units nose-to-tail (see
// fishMesh.js's VISUAL_SCALE) — so a COBBLE_SIZE of 9 is roughly a fist-
// sized rock next to a three-foot Chinook, which is what the Snake's bed
// actually looks like.
const COBBLE_SIZE = 9;
const GRAVEL_SIZE = 3.2;

// ---------------------------------------------------------------------
// Restraint dials.
//
// The riverbed is set dressing. It exists to give the fish somewhere to be
// and to catch the caustics; it is not the subject, and a fully resolved
// procedural gravel bed actively fights the fish for attention — crisp
// Voronoi cells with hard seams and high per-stone contrast read as an
// obvious generated pattern sitting in front of the viewer rather than as a
// riverbed implied through several feet of silty water.
//
// The three constants below pull it back toward "implied": stones dissolve
// at closer range (DETAIL_SOFTNESS), what survives has roughly half the
// local contrast it used to (the RELIEF/tint/seam values here and in the
// fragment shader), and the whole surface sits permanently a little into the
// murk (TERRAIN_HAZE). Raise any of them to bring the bed back forward.
// ---------------------------------------------------------------------

// Multiplies the per-fragment world footprint used to fade the stone layers
// out (see the fragment shader). At 1.0 the fade is purely the anti-aliasing
// guard it started as — layers vanish exactly when their stones get too
// small to sample cleanly. Above 1.0 it doubles as a depth-of-field dial:
// every layer dissolves while its stones are still comfortably resolvable,
// so the bed softens with distance instead of holding crisp detail right out
// to where the fog takes it. This is the "blur," and it costs nothing —
// there is no post-process pass, the detail simply is not generated.
const DETAIL_SOFTNESS = 6;

// Constant blend toward the fog color, applied after everything else. Unlike
// applyFog's distance falloff this never resolves, even directly under the
// camera, so the bed reads as something glimpsed through silt rather than a
// surface the viewer is standing on.
const TERRAIN_HAZE = 0.75;

// How far the fake per-stone normal tilts away from straight up at a
// stone's rim. This is what gives each stone a lit cap and a shaded flank
// instead of the whole bed sharing one flat lighting value. Halved from
// 1.5/0.7 — at full strength every stone carried a hard terminator that read
// as embossed plastic up close.
const COBBLE_RELIEF = 1.75;
const GRAVEL_RELIEF = 0.8;

// How far a stone's crown stands above the surrounding bed, as a fraction of
// that stone's own width — so a fist-sized cobble stands proud of the bed by
// a few world units and the gravel between barely at all.
//
// The rock relief is otherwise normals-only: nothing is actually displaced,
// so this height never moved anything and didn't need to exist. It does now
// because the caustics parallax-shift across it (see the fragment shader) —
// which is the difference between light *landing on* the stones and a light
// pattern printed flat across them.
const STONE_HEIGHT_FRAC = 0.35;

// Scales that parallax shift. 1.0 is the physically honest amount for
// STONE_HEIGHT_FRAC above; raising it exaggerates how much the caustic net
// breaks up over the gravel, which is a legitimate stylistic dial given the
// relief it is shifting across is itself faked.
const CAUSTIC_PARALLAX = 1.0;

// How much a stone face angled away from the sun still catches caustic
// light. Caustics underwater are not a clean directional beam — the water
// column scatters them — so a flank facing away goes dim rather than black.
// 0 would be a hard dot(N,L) with fully unlit flanks; 1 would be no
// directionality at all, which is what the riverbed had before.
const CAUSTIC_LIGHT_WRAP = 0.3;

// GLSL types a literal without a decimal point as an int, which finds no
// matching overload on float builtins and fails the whole shader compile —
// so every interpolated number below goes through toFixed().
const f = (n) => n.toFixed(4);

export function riverDepth(bounds) {
  return bounds.height * RIVER_DEPTH_FRAC;
}

export function buildTerrainMesh(bounds, causticsTextureSize) {
  // Drawn oversized and re-centered on bounds, exactly like buildWaterMesh
  // (see water.js) — sharing its waterWorldSize() keeps the floor's caustics
  // UV in registration with the water sim texture (both now sample the same
  // margin-shifted region instead of the floor assuming the sim starts at
  // the origin), and the extra size pushes the plane's rectangular edge out
  // past where fog has already saturated to uFogColor, so the edge dissolves
  // into the fog instead of showing up as a hard silhouette line.
  const depth = riverDepth(bounds);
  const {
    width: planeWidth,
    height: planeHeight,
    marginX,
    marginZ,
  } = waterWorldSize(bounds);
  const centerX = bounds.width / 2;
  const centerZ = bounds.height / 2;
  const cols = Math.max(2, Math.round(planeWidth / GRID_STEP));
  const rows = Math.max(2, Math.round(planeHeight / GRID_STEP));
  const geometry = new THREE.PlaneGeometry(planeWidth, planeHeight, cols, rows);
  geometry.rotateX(-Math.PI / 2);
  geometry.translate(centerX, -depth, centerZ);

  // Per-vertex brightness jitter, so the floor reads as a textured surface
  // rather than one flat-shaded polygon. Stores the jitter *multiplier*
  // only, not a finished color: the floor's actual color is a uniform that
  // changes with the season (see setTerrainSeason), and baking it into the
  // vertex buffer the way this used to would mean rebuilding the whole
  // geometry on every date change to recolor the riverbed.
  const position = geometry.attributes.position;
  const shades = new Float32Array(position.count);
  for (let i = 0; i < position.count; i++) {
    shades[i] = 1 + (Math.random() * 2 - 1) * SHADE_NOISE;
  }
  geometry.setAttribute("shade", new THREE.BufferAttribute(shades, 1));
  geometry.computeVertexNormals();

  const material = buildTerrainMaterial(bounds, causticsTextureSize, {
    planeWidth,
    planeHeight,
    marginX,
    marginZ,
    centerX,
    centerZ,
  });

  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = "terrain";
  return mesh;
}

const TERRAIN_VERTEX_SHADER = /* glsl */ `
  attribute float shade;

  varying float vShade;
  varying vec3 vWorldPos;

  void main() {
    vShade = shade;

    // The sun term used to be computed here, per vertex, against this
    // plane's own geometric normal — which on a flat plane is (0, 1, 0)
    // everywhere, so it evaluated to the same constant across the entire
    // riverbed and the toon banding below it never varied by a single
    // pixel. Lighting now happens per fragment against the per-stone
    // normals the rock layers synthesize (see the fragment shader), which
    // is what actually makes sunDir visible on this surface.

    // Geometry is already translated into world space at build time (see
    // buildTerrainMesh) and this mesh never itself moves, so the raw
    // position IS the world position the caustic glow/fog need.
    vWorldPos = position;

    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const TERRAIN_FRAGMENT_SHADER = /* glsl */ `
  ${CAUSTIC_GLOW_GLSL}
  ${FOG_GLSL}

  uniform sampler2D caustics;
  uniform vec2 worldSize;
  uniform vec2 margin;
  uniform vec2 texel;
  uniform vec3 floorColor;
  uniform vec3 causticsColor;
  uniform float causticsStrength;
  uniform vec2 center;
  uniform vec2 planeHalfSize;
  uniform float coreFrac;
  uniform vec3 sunDir;

  varying float vShade;
  varying vec3 vWorldPos;

  // Cheap hash-based value noise for fine silt/rock detail, evaluated per
  // fragment so it isn't capped by the mesh's actual vertex density
  // (GRID_STEP, see buildTerrainMesh) the way the per-vertex SHADE_NOISE
  // jitter (vShade) is — that jitter reads as blocky up close since it's
  // one flat value per ~20-unit triangle; this adds continuous detail on
  // top of it at any zoom level.
  float terrainHash(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
  }
  float terrainNoise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    float a = terrainHash(i);
    float b = terrainHash(i + vec2(1.0, 0.0));
    float c = terrainHash(i + vec2(0.0, 1.0));
    float d = terrainHash(i + vec2(1.0, 1.0));
    return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
  }

  // --- River rock -----------------------------------------------------
  // A riverbed reads as gravel because of *discrete* stones: individual
  // boundaries, a lit cap and a shaded flank on each one, and a different
  // color per stone. Value noise (terrainNoise above) is continuous and
  // can't produce any of those no matter how far its contrast is pushed —
  // it only ever gets blotchier. So the stones come from a Voronoi/cellular
  // pattern instead, where every cell simply *is* one stone.

  vec2 rockHash2(vec2 p) {
    return fract(
      sin(vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3))))
        * 43758.5453123
    );
  }

  // Nearest scattered site to p, in cell units. Returns:
  //   .x  distance to that site
  //   .yz vector from this fragment TO the site (used for the fake normal)
  //   .w  a stable per-cell random, for per-stone color/height variation
  // Only the 3x3 cells around p need checking: each cell holds exactly one
  // site somewhere inside it, so nothing outside that ring can be nearer
  // than something inside it.
  vec4 rockCells(vec2 p) {
    vec2 cell = floor(p);
    vec2 frac = fract(p);
    float bestDistSq = 8.0;
    vec2 bestToSite = vec2(0.0);
    vec2 bestCell = vec2(0.0);

    for (int j = -1; j <= 1; j++) {
      for (int i = -1; i <= 1; i++) {
        vec2 neighbor = vec2(float(i), float(j));
        vec2 toSite = neighbor + rockHash2(cell + neighbor) - frac;
        float distSq = dot(toSite, toSite);
        if (distSq < bestDistSq) {
          bestDistSq = distSq;
          bestToSite = toSite;
          bestCell = cell + neighbor;
        }
      }
    }
    return vec4(
      sqrt(bestDistSq),
      bestToSite,
      terrainHash(bestCell + 0.5)
    );
  }

  // Accumulates one layer of stones into the running normal/tint/crease.
  // Each stone is treated as a shallow dome: height peaks at the site and
  // falls off toward
  // the cell border, so the surface gradient points at the site and the
  // normal tilts away from it — a lit cap on top, a shaded flank at the rim.
  // The seam between stones is darkened separately, since that gap is where
  // silt collects and light doesn't reach.
  // The strength argument fades the whole layer out (see the footprint test
  // in main) — at 0 this leaves normal/tint/crease exactly as it found them.
  void addRockLayer(
    vec2 worldXZ, float stoneSize, float relief, float strength,
    inout vec3 normal, inout vec3 tint, inout float crease, inout float height
  ) {
    vec4 cells = rockCells(worldXZ / stoneSize);
    float dist = cells.x;
    vec2 toSite = cells.yz;

    // Flatten the dome as it approaches the cell border so neighboring
    // stones meet in a valley rather than a ridge.
    float dome = 1.0 - smoothstep(0.15, 0.62, dist);
    normal.xz -= toSite * relief * dome * strength;

    // The same dome as an actual height above the bed, in world units. Only
    // the caustics read this (see main) — nothing is displaced — and it
    // scales with stoneSize so each layer stands proud in proportion to how
    // big its stones are, cobbles well above the gravel packed around them.
    height += dome * stoneSize * ${f(STONE_HEIGHT_FRAC)} * strength;

    // Per-stone color. Real gravel is a mix of pale quartz, dark basalt and
    // iron-stained browns, so this varies both brightness and warmth. The
    // brightness spread is deliberately narrow (was 0.72-1.28, i.e. +/-28%
    // per stone): at that width every individual pebble was legible from
    // across the river, which is what made the bed read as a printed pattern
    // rather than as gravel seen through silt. Warmth stays where it was —
    // it was never the loud part, and dropping it too would flatten the bed
    // to a single grey.
    float value = 0.86 + 0.28 * cells.w;
    float warmth = fract(cells.w * 37.0) - 0.5;
    vec3 stone = value * vec3(
      1.0 + 0.16 * warmth,
      1.0,
      1.0 - 0.13 * warmth
    );
    tint *= mix(vec3(1.0), stone, strength);

    // The seam between stones is where silt settles and light doesn't
    // reach, so it reads darker than either stone beside it. Softened from
    // 0.45 — the hard dark outline around every cell was the single clearest
    // "this is a Voronoi diagram" tell on the whole surface.
    float seam = 1.0 - 0.22 * smoothstep(0.34, 0.60, dist);
    crease *= mix(1.0, seam, strength);
  }

  void main() {
    // How much world space this one fragment covers, scaled up by
    // DETAIL_SOFTNESS. A stone layer whose stones are smaller than this can
    // only alias into shimmer, so it gets faded out before it gets there —
    // which is why the fine gravel can be detailed up close without crawling
    // in the distance, and why it stays correct at any resolution or zoom
    // rather than being tuned to one. Overstating the footprint makes each
    // layer bow out while its stones are still perfectly resolvable, which
    // is the softening dial (see DETAIL_SOFTNESS) — same mechanism, used
    // deliberately rather than only as an aliasing guard.
    float footprint =
      max(fwidth(vWorldPos.x), fwidth(vWorldPos.z)) * ${f(DETAIL_SOFTNESS)};

    // The bed itself: cobbles, with finer gravel packed into the gaps.
    vec3 rockNormal = vec3(0.0, 1.0, 0.0);
    vec3 rockTint = vec3(1.0);
    float crease = 1.0;
    float rockHeight = 0.0;
    addRockLayer(
      vWorldPos.xz, ${f(COBBLE_SIZE)}, ${f(COBBLE_RELIEF)},
      1.0 - smoothstep(${f(COBBLE_SIZE * 0.35)}, ${f(COBBLE_SIZE * 1.2)}, footprint),
      rockNormal, rockTint, crease, rockHeight
    );
    addRockLayer(
      vWorldPos.xz, ${f(GRAVEL_SIZE)}, ${f(GRAVEL_RELIEF)},
      1.0 - smoothstep(${f(GRAVEL_SIZE * 0.35)}, ${f(GRAVEL_SIZE * 1.2)}, footprint),
      rockNormal, rockTint, crease, rockHeight
    );
    rockNormal = normalize(rockNormal);

    // A real per-fragment sun term at last — on the flat plane this used to
    // be computed against, it was one constant for the whole riverbed.
    float lightIntensity = max(dot(rockNormal, sunDir), 0.0);

    // Toon-ish quantized diffuse, three bands — kept for continuity with the
    // rest of the scene's look, but only mixed slightly in. At full strength
    // the bands wrap every rounded stone in hard terraced rings; even at the
    // half it used to sit at, those rings were a second hard edge per stone
    // on top of the seam. A quarter keeps the stylized flavor without
    // contouring the gravel.
    float band = lightIntensity > 0.72 ? 1.0 : (lightIntensity > 0.4 ? 0.78 : 0.6);
    float diffuse = mix(lightIntensity, band, 0.25);

    // Two octaves (a finer, higher-weight one plus a broader one) so it
    // doesn't read as one small repeating tile — broad silt mottling across
    // the stones, on a scale larger than any individual one.
    float detail = terrainNoise(vWorldPos.xz * 0.15) * 0.6
      + terrainNoise(vWorldPos.xz * 0.045) * 0.4;
    float detailShade = 0.92 + 0.16 * detail;

    // vShade is the per-vertex jitter multiplier (see buildTerrainMesh);
    // floorColor is the season's, so the riverbed shifts with the sky
    // instead of staying a fixed color the fog no longer matches.
    //
    // The diffuse range is narrowed from 0.45-1.0 to 0.62-1.0 for the same
    // reason as the constants above: a riverbed lit through several feet of
    // silty water has most of its light arriving scattered from every
    // direction, so the gap between a stone's lit face and its shaded one is
    // far smaller than the near-2x this had.
    vec3 base = floorColor * vShade * rockTint * crease
      * (0.62 + 0.38 * diffuse) * detailShade;

    // Matches water.js's fragment shader — the caustics texture covers this
    // same oversized, margin-shifted area (see buildTerrainMesh/
    // waterWorldSize/causticsGenerator.js), so both need the same margin
    // offset to sample the same point instead of drifting apart as bounds
    // gets bigger.
    // Soft (Reinhard-style) saturation instead of a hard min() clamp — real
    // caustics are an extremely peaky signal (a few tiny, very bright focal
    // points against a mostly-dim field), and a hard clamp made "dim" and
    // "very bright" both read as either invisible or maxed-out with no
    // gradation between — see fishMesh.js's identical curve, which this
    // matches so terrain/water/fish stay visually consistent.
    //
    // The caustic net is sampled and lit as light *arriving on the stones*
    // rather than as a flat overlay printed across them. Four separate
    // things the rock does to it, all of which this surface already had the
    // ingredients for and none of which it was using:
    //
    // 1. PARALLAX. The caustics texture is a pattern projected down onto a
    //    flat bed, so sampling it at vWorldPos.xz assumes every fragment
    //    sits at exactly that plane. A stone crown standing rockHeight above
    //    it catches the ray that would otherwise have continued on to a
    //    point further along the light's travel direction, so the pattern
    //    shifts across the relief instead of sticking to it like a decal.
    //    sunDir points toward the sun, so light travels along -sunDir and
    //    the shift is back along sunDir.xz, scaled by how oblique the sun
    //    is. The max() keeps a low seasonal sun from divergently smearing
    //    the sample halfway across the riverbed.
    // 2. FACING. A face angled away from the sun intercepts less of the
    //    beam. Wrapped rather than a hard dot(N,L) — see
    //    CAUSTIC_LIGHT_WRAP, the water column scatters this light so flanks
    //    go dim rather than black.
    // 3. OCCLUSION. crease is already the silt seam between stones, where
    //    light doesn't reach; caustics are blocked from those gaps for the
    //    same reason the ambient light is.
    // 4. ALBEDO. Caustic light still has to bounce off the stone to be
    //    seen, so it picks up that stone's own color — a bright focal point
    //    on dark basalt reads dimmer than the same one on pale quartz
    //    beside it, which is a strong cue that the light is on the rock
    //    rather than over it.
    //
    // 1-3 are applied BEFORE the saturation curve (they change how much
    // light arrives, so they should be able to keep a dim flank down on the
    // curve's slope while a lit crown saturates), 4 after (it changes how
    // much of the arrived light comes back out).
    vec2 parallax = -sunDir.xz * (rockHeight / max(sunDir.y, 0.25))
      * ${f(CAUSTIC_PARALLAX)};
    vec2 uv = (vWorldPos.xz + parallax + margin) / worldSize;

    float facing = mix(
      max(dot(rockNormal, sunDir), 0.0), 1.0, ${f(CAUSTIC_LIGHT_WRAP)}
    );
    float glowStrength =
      causticGlow(caustics, uv, texel) * causticsStrength * facing * crease;
    float glow = 1.4 * glowStrength / (glowStrength + 1.4);

    vec3 color = base + causticsColor * glow * rockTint;
    color = applyFog(color, vWorldPos);

    // A floor of murk that applyFog's distance falloff can't provide,
    // because that term correctly goes to zero as the surface approaches the
    // camera — which left the nearest strip of bed as the sharpest, highest
    // contrast thing in frame, directly competing with the fish swimming
    // over it. Blending a constant amount of fog color in regardless of
    // distance keeps the bed sitting behind the fish at every range: even
    // the gravel right under the camera is being seen through silt.
    color = mix(color, uFogColor, ${f(TERRAIN_HAZE)});

    // Edge fade: same treatment as buildWaterMesh's edgeFade (see water.js)
    // — fully opaque out to coreFrac (exactly where the real river bounds
    // end), then a smooth dissolve across the rest of the oversized plane
    // out to its own edge, so the plane's rectangular boundary disappears
    // into the fog instead of cutting off as a visible hard edge.
    vec2 t = abs(vWorldPos.xz - center) / planeHalfSize;
    float edgeT = max(t.x, t.y);
    float edgeFade = 1.0 - smoothstep(coreFrac, 1.0, edgeT);

    gl_FragColor = vec4(color, edgeFade);
  }
`;

function buildTerrainMaterial(
  bounds,
  causticsTextureSize,
  { planeWidth, planeHeight, marginX, marginZ, centerX, centerZ },
) {
  return new THREE.ShaderMaterial({
    uniforms: {
      caustics: { value: null },
      worldSize: { value: new THREE.Vector2(planeWidth, planeHeight) },
      margin: { value: new THREE.Vector2(marginX, marginZ) },
      texel: {
        value: new THREE.Vector2(
          1 / causticsTextureSize,
          1 / causticsTextureSize,
        ),
      },
      // Both overwritten by setTerrainSeason() — these starting values only
      // show before the first call.
      floorColor: { value: new THREE.Color("#213751") },
      causticsColor: { value: new THREE.Color(0.55, 0.95, 0.85) },
      // Was 12 — far enough past the knee of the fragment shader's
      // saturation curve that essentially every lit texel pinned to the
      // asymptote, so the riverbed rendered as one flat sheet of caustics
      // color with no net structure in it and no floorColor showing through
      // at all. Low enough now to sit on the curve's slope instead of its
      // ceiling, which is what makes the light net actually read as a net.
      // The heavy river fog (see fog.js) already erases this everywhere but
      // the near field, so it only has to be tuned for the lit gravel right
      // in front of the camera.
      //
      // Raised from 5 alongside the per-stone facing/occlusion terms in the
      // fragment shader: those multiply the arriving light by roughly 0.6 on
      // average across the bed, so holding 5 would have read as the caustics
      // simply getting dimmer rather than getting *shaped*. This restores
      // the lit crowns to about their previous brightness and lets the whole
      // reduction land where it should — on the flanks and seams.
      causticsStrength: { value: 8 },
      sunDir: { value: new THREE.Vector3(0.4, 1, 0.25).normalize() },
      uFogColor: { value: FOG_COLOR },
      uFogDensity: { value: fogDensity(bounds) },
      center: { value: new THREE.Vector2(centerX, centerZ) },
      planeHalfSize: {
        value: new THREE.Vector2(planeWidth / 2, planeHeight / 2),
      },
      // t-value (see fragment shader) where the real river bounds end —
      // exactly 1/WATER_SIZE_MULTIPLIER, since the plane is that much
      // bigger. Matches buildWaterMesh's uCoreFrac (see water.js) so both
      // surfaces start fading at the same real-world edge.
      coreFrac: { value: 1 / WATER_SIZE_MULTIPLIER },
    },
    vertexShader: TERRAIN_VERTEX_SHADER,
    fragmentShader: TERRAIN_FRAGMENT_SHADER,
    transparent: true,
    depthWrite: false,
  });
}

// Feeds the terrain material the current caustics texture (causticsGenerator.js
// recomputes it every frame from the live water sim — see main.js's loop).
export function setTerrainCausticsTexture(terrainMesh, causticsTexture) {
  terrainMesh.material.uniforms.caustics.value = causticsTexture;
}

// Ties the riverbed's own color, its caustic glow, and its sun direction to
// the same season driving the sky/sun, water surface, and fish (see
// sceneSetup.js/water.js/fishMesh.js) — called from main.js whenever the
// displayed date changes. season.floorColor comes off the same sky/depths
// derivation as the fog and the water body (see season.js), which is what
// keeps the riverbed from sitting in a different color family than the haze
// it fades into at distance.
export function setTerrainSeason(terrainMesh, dayOfYear) {
  const season = seasonForDay(dayOfYear);
  const { uniforms } = terrainMesh.material;
  uniforms.floorColor.value.copy(season.floorColor);
  uniforms.causticsColor.value.copy(season.causticsColor1);
  uniforms.sunDir.value.copy(season.sunDirection);
}
