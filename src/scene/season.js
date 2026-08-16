// season.js
// Maps a calendar date to a blended "seasonal look" for the whole scene —
// sky, sun, fog, water body, riverbed, and caustics — the visible stand-in
// for a year passing as the timeline advances. Four keyframes anchored on
// the equinoxes/solstice, smoothstep-interpolated between whichever two
// bracket the current day so the look drifts continuously instead of
// snapping at season boundaries.
//
// Palette basis — real seasonal sky observations, rather than the
// teal/green register this file used to invent:
//   Winter & Autumn — deep, vivid blue. Low humidity and a long
//     atmospheric path for the low sun leave the shorter wavelengths
//     dominant and the color heavily saturated.
//   Spring & Summer — lighter, hazier blue. Higher humidity and more
//     aerosols scatter light more evenly across wavelengths, which washes
//     the blue out toward white.
//   All seasons — warm red/orange/pink near the horizon, where sunlight
//     travels through the most atmosphere and the short wavelengths have
//     scattered out entirely. See horizonColor below, and horizonStrength()
//     for why the effect is strongest in the low-sun seasons.
//
// COHESION: only three colors per season are hand-picked — skyColor,
// horizonColor, depthsColor. Everything the viewer actually sees underwater
// (fog, the water body's own color, the riverbed) is *derived* from the
// sky/depths pair by deriveSeason() below, then pulled toward the river's
// own green (see RIVER_TINT), so it is impossible for the fog to drift into
// a different color family than the sky the way a separately hand-tuned
// constant did. Add a new underwater surface by giving it a depth stop
// here, not its own color.
//
// causticsColor1/2 (the light net on the riverbed/fish/water surface — see
// causticsChunk.js) stay hand-picked and in the cyan-green "light net"
// family across all four seasons rather than following the sky, since real
// underwater caustics read as refracted sunlight, not a sky reflection —
// only their warmth/saturation/value shift with the season.
import * as THREE from "three";

// ---------------------------------------------------------------------
// Derivation: where each underwater surface sits along the skyColor ->
// depthsColor ramp. Bigger = deeper = darker and further from the sky.
// Ordered the way the eye reads them from a camera in the water column:
// the riverbed catches the most light, distance fog sits mid-column, and
// the water body's own base color (what the surface shows when viewed
// head-on, before fresnel mixes the sky back in — see water.js) is the
// darkest of the three.
// ---------------------------------------------------------------------
// The shallowest stop of the three, which reads as counter-intuitive until
// you remember the riverbed is the one surface here that is *lit* — it
// catches the sun's caustics directly, so it has to be bright enough to
// hold its own color underneath them rather than being a dark base the
// caustic glow simply overwrites (see terrain.js's causticsStrength).
const FLOOR_DEPTH = 0.42;
// Kept nearer the sky end than the riverbed is. Fog is what the whole
// scene converges to at the eye-level horizon, and pushing it deeper than
// this turns that convergence into a near-black stripe across the middle of
// frame that the fish (which fade toward this same color with depth — see
// fishMesh.js's DEPTH_FOG_FACTOR) then read as cutouts against.
const FOG_DEPTH = 0.52;
const WATER_DEPTH = 0.86;

// The riverbed is sediment, not water — nudging the derived floor color a
// little toward silt keeps it from reading as one more sheet of glass while
// still leaving it unmistakably part of the season's family.
const SILT_COLOR = new THREE.Color("#6b5c44");
const SILT_MIX = 0.3;

// The Snake River's own color. This is the correction that keeps the
// underwater half of the scene honest: the sky over the river is blue, but
// the water is not a darker copy of that sky the way clear open ocean is —
// it's green, from the suspended sediment and algae a shallow inland river
// carries. Every derived underwater color is pulled toward this tint after
// the sky->depths ramp, so the palette reads as a blue sky over a green
// river rather than blue sky over blue water.
//
// The seasons still differentiate underneath it: the mix is well under 1,
// so a winter fog stays colder and darker than a summer one.
const RIVER_TINT = new THREE.Color("#4e7361");
const RIVER_TINT_MIX = 0.45;

// THREE.Color holds linear-sRGB values (ColorManagement is on by default in
// r152+), and lerping there drives midpoints noticeably darker than the eye
// expects. The depth stops above were chosen by eye against sRGB blends, so
// derivation rounds through sRGB to match. Only runs at module load, once
// per keyframe — seasonForDay()'s per-frame keyframe-to-keyframe lerps stay
// in linear space, where the two endpoints are close enough that the
// difference doesn't show.
const _mixA = new THREE.Color();
const _mixB = new THREE.Color();
function mixSRGB(a, b, t) {
  _mixA.copy(a).convertLinearToSRGB();
  _mixB.copy(b).convertLinearToSRGB();
  return _mixA.lerp(_mixB, t).convertSRGBToLinear().clone();
}

// How strongly the warm horizon band shows, from the sun's elevation: the
// lower the sun sits, the longer the atmospheric path at the horizon and
// the more completely the short wavelengths scatter out. The 0.3 floor is
// deliberate — warm horizon tones appear in every season, just faintly when
// the sun is near-overhead, so this never falls all the way to zero.
function horizonStrength(sunDirection) {
  const elevation = sunDirection.clone().normalize().y;
  return 0.3 + 0.55 * (1 - Math.max(0, elevation));
}

// One underwater surface: descend the season's sky->depths ramp to `depth`,
// then pull the result toward the river's own green (see RIVER_TINT).
function underwater(def, depth) {
  return mixSRGB(
    mixSRGB(def.skyColor, def.depthsColor, depth),
    RIVER_TINT,
    RIVER_TINT_MIX,
  );
}

// Fills in every derived value from the three hand-picked colors, so a
// keyframe below only has to declare the look, not restate the family.
function deriveSeason(def) {
  return {
    ...def,
    fogColor: underwater(def, FOG_DEPTH),
    waterColor: underwater(def, WATER_DEPTH),
    floorColor: mixSRGB(underwater(def, FLOOR_DEPTH), SILT_COLOR, SILT_MIX),
    horizonStrength: horizonStrength(def.sunDirection),
  };
}

// Deep, vivid blue at its most extreme: the lowest sun of the year through
// the driest air, and the coldest, dimmest water derived from it.
const WINTER = deriveSeason({
  skyColor: new THREE.Color("#1a56a8"),
  horizonColor: new THREE.Color("#e8896b"),
  depthsColor: new THREE.Color("#0a2028"),
  sunColor: new THREE.Color("#dce9ff"),
  sunIntensity: 1.5,
  sunDirection: new THREE.Vector3(0.65, 0.34, 0.35),
  causticsColor1: new THREE.Color("#9fc6d6"),
  causticsColor2: new THREE.Color("#20343f"),
});

// Humidity climbing off the winter low: the blue lightens and starts to
// wash toward white, and the sun climbs enough to pull the warm horizon
// band down toward subtle.
const SPRING = deriveSeason({
  skyColor: new THREE.Color("#4f8fd0"),
  horizonColor: new THREE.Color("#e6c9a8"),
  depthsColor: new THREE.Color("#0f2a20"),
  sunColor: new THREE.Color("#eef6ff"),
  sunIntensity: 2.1,
  sunDirection: new THREE.Vector3(0.45, 0.78, 0.3),
  causticsColor1: new THREE.Color("#7fe0c0"),
  causticsColor2: new THREE.Color("#123b30"),
});

// The haziest sky of the year and the highest sun — lightest blue, weakest
// horizon warmth, and the brightest riverbed, since a near-overhead sun
// puts the most light down through the water column.
const SUMMER = deriveSeason({
  skyColor: new THREE.Color("#6aa8d8"),
  horizonColor: new THREE.Color("#f0dcbc"),
  depthsColor: new THREE.Color("#14301c"),
  sunColor: new THREE.Color("#fff4dc"),
  sunIntensity: 2.5,
  sunDirection: new THREE.Vector3(0.15, 1, 0.1),
  causticsColor1: new THREE.Color("#6ef0d0"),
  causticsColor2: new THREE.Color("#0d3a34"),
});

// Back to a deep, vivid blue as the humidity drops, but with the year's
// most golden low sun — the strongly warm horizon against a saturated blue
// zenith is the most complementary the palette ever gets, and the golden
// caustics carry that warmth down onto the riverbed and the fish.
const AUTUMN = deriveSeason({
  skyColor: new THREE.Color("#1c5eb0"),
  horizonColor: new THREE.Color("#e8964e"),
  depthsColor: new THREE.Color("#12291e"),
  sunColor: new THREE.Color("#ffd9a0"),
  sunIntensity: 1.9,
  sunDirection: new THREE.Vector3(0.55, 0.5, 0.35),
  causticsColor1: new THREE.Color("#d9c98a"),
  causticsColor2: new THREE.Color("#33301c"),
});

// Approximate equinox/solstice days-of-year. WINTER is repeated at day 365
// to close the loop, so every day falls between two real keyframes with no
// separate wraparound case.
const KEYFRAMES = [
  { day: 0, ...WINTER },
  { day: 80, ...SPRING },
  { day: 172, ...SUMMER },
  { day: 264, ...AUTUMN },
  { day: 365, ...WINTER },
];

function smoothstep(t) {
  return t * t * (3 - 2 * t);
}

// Every THREE.Color on a keyframe, so seasonForDay() can lerp them all in
// one loop instead of naming each one twice (once here, once in scratch).
const COLOR_KEYS = [
  "skyColor",
  "horizonColor",
  "depthsColor",
  "fogColor",
  "waterColor",
  "floorColor",
  "sunColor",
  "causticsColor1",
  "causticsColor2",
];

// Reused across calls — copy values out (e.g. Color.copy(), Vector3.copy())
// if you need to hold onto them past the next seasonForDay() call.
const scratch = {
  sunDirection: new THREE.Vector3(),
  sunIntensity: 0,
  horizonStrength: 0,
};
for (const key of COLOR_KEYS) scratch[key] = new THREE.Color();

export function seasonForDay(dayOfYear) {
  const d = ((dayOfYear % 365) + 365) % 365;
  let i = 0;
  while (KEYFRAMES[i + 1].day <= d) i++;
  const a = KEYFRAMES[i];
  const b = KEYFRAMES[i + 1];
  const t = smoothstep((d - a.day) / (b.day - a.day));

  for (const key of COLOR_KEYS) scratch[key].lerpColors(a[key], b[key], t);
  scratch.sunDirection
    .lerpVectors(a.sunDirection, b.sunDirection, t)
    .normalize();
  scratch.sunIntensity = THREE.MathUtils.lerp(
    a.sunIntensity,
    b.sunIntensity,
    t,
  );
  scratch.horizonStrength = THREE.MathUtils.lerp(
    a.horizonStrength,
    b.horizonStrength,
    t,
  );

  return scratch;
}

// `dateStr` is "YYYY-MM-DD" (see data.js) — parsed as UTC midnight so the
// result doesn't shift with the browser's local timezone.
export function dayOfYear(dateStr) {
  const date = new Date(dateStr + "T00:00:00Z");
  const yearStart = Date.UTC(date.getUTCFullYear(), 0, 1);
  return Math.floor((date.getTime() - yearStart) / 86400000);
}
