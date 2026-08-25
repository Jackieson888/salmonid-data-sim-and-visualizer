// season.js
// Design rationale, invariants, gotchas: .claude/context/scene/season.md
// Maps a calendar date to a blended seasonal palette (sky, sun, fog, water,
// riverbed, caustics) plus the sun's position and daily arc.
import * as THREE from "three";

// Depth stops along the skyColor -> depthsColor ramp for each derived
// underwater surface. Bigger = deeper = darker and further from the sky.
const FLOOR_DEPTH = 0.42;
const FOG_DEPTH = 0.52;
const WATER_DEPTH = 0.86;

// Nudges the derived floor color toward silt so it reads as sediment, not glass.
const SILT_COLOR = new THREE.Color("#6b5c44");
const SILT_MIX = 0.3;

// The Snake River's own green — pulls every derived underwater color off
// the sky's blue and onto the river's actual color family. See season.md
// for the tuning history behind these two values.
const RIVER_TINT = new THREE.Color("#3f9068");
const RIVER_TINT_MIX = 0.55;

// Lerping THREE.Color's linear-sRGB values drives midpoints darker than the
// eye expects; the depth stops above were chosen by eye against sRGB blends,
// so derivation rounds through sRGB to match (see season.md).
const _mixA = new THREE.Color();
const _mixB = new THREE.Color();
function mixSRGB(a, b, t) {
  _mixA.copy(a).convertLinearToSRGB();
  _mixB.copy(b).convertLinearToSRGB();
  return _mixA.lerp(_mixB, t).convertSRGBToLinear().clone();
}

// Warm horizon band strength from the sun's elevation; 0.3 floor keeps it
// from vanishing entirely when the sun is near-overhead.
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

// Deep, vivid blue at its most extreme: lowest sun, driest air, coldest water.
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

// Humidity climbing off the winter low: blue washes toward white, horizon warmth fades.
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

// Haziest sky, highest sun: lightest blue, weakest horizon warmth, brightest riverbed.
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

// Deep blue again as humidity drops, but with the year's most golden low sun —
// the most complementary the palette gets, sky against horizon.
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

// Approximate equinox/solstice days-of-year. WINTER repeats at day 365 to
// close the loop, so every day falls between two real keyframes.
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

// ---------------------------------------------------------------------
// Diurnal sweep — walks the season's peak sun through a rise/peak/set arc
// each day. Drives the caustics net (causticsGenerator.js) and everything
// that reads it (godRays.js, water.js, fishMesh.js); see season.md for why
// elevation (not azimuth) does most of the work here.
// ---------------------------------------------------------------------
const SUN_SWEEP_ELEVATION_ARC = 0.34;
const SUN_SWEEP_AZIMUTH_ARC = 0.38;

// Seconds for one full rise-peak-set-return. Deliberately not tied to the
// timeline's day rate (FRAMES_PER_DAY in main.js) — see season.md.
const SUN_SWEEP_PERIOD = 120;

// Floor on how low the sun may get, in radians (~17 degrees) — below this
// the net smears off the far side of the river; see season.md.
const MIN_SUN_ELEVATION = 0.3;

// Base (season's peak) and swept sun. Held here rather than in main.js for
// the same reason fog.js holds FOG_COLOR — see season.md.
const _sweptSun = new THREE.Vector3(0, 1, 0);
let azimuth = 0;
let elevation = Math.PI / 2;

export function setSunSeason(dayOfYear) {
  const sun = seasonForDay(dayOfYear).sunDirection;
  azimuth = Math.atan2(sun.z, sun.x);
  elevation = Math.atan2(sun.y, Math.hypot(sun.x, sun.z));
}

// The current sun, `seconds` into the day's arc. Returns a shared vector —
// copy out of it if you need to keep the value.
export function sweptSunDirection(seconds) {
  const phase = (seconds / SUN_SWEEP_PERIOD) * Math.PI * 2;
  // (1 - cos), not sin: phase 0 is the peak, and the sun only ever descends
  // from the season's own elevation, never climbs above it.
  const sweptElevation = Math.max(
    MIN_SUN_ELEVATION,
    elevation - SUN_SWEEP_ELEVATION_ARC * (1 - Math.cos(phase)),
  );
  const sweptAzimuth = azimuth + SUN_SWEEP_AZIMUTH_ARC * Math.sin(phase);

  const cosE = Math.cos(sweptElevation);
  return _sweptSun.set(
    Math.cos(sweptAzimuth) * cosE,
    Math.sin(sweptElevation),
    Math.sin(sweptAzimuth) * cosE,
  );
}

// The sun direction as seen from under the surface (Snell's window) — the
// top-lit read the whole underwater scene depends on. See season.md.
const WATER_IOR = 1.333;

export function refractedSunDirection(sun, target = new THREE.Vector3()) {
  const out = target.copy(sun).normalize();

  // Angle from straight up, as cosine/sine. Clamped at 0 because a sun at or
  // below the horizon transmits nothing to refract.
  const cosAir = Math.min(1, Math.max(0, out.y));
  const sinAir = Math.sqrt(Math.max(0, 1 - cosAir * cosAir));
  const sinWater = Math.min(1, sinAir / WATER_IOR);
  const cosWater = Math.sqrt(Math.max(0, 1 - sinWater * sinWater));

  // Same azimuth, steeper descent: rescale the horizontal part to the new
  // sine, set the vertical part to the new cosine. Stays unit length.
  const horizontal = Math.hypot(out.x, out.z);
  if (horizontal > 1e-6) {
    const scale = sinWater / horizontal;
    out.x *= scale;
    out.z *= scale;
  }
  out.y = cosWater;
  return out;
}

// `dateStr` is "YYYY-MM-DD" (see data.js), parsed as UTC midnight. Guarded
// against NaN dates, whose failure otherwise is silent and total — see
// season.md.
export function dayOfYear(dateStr) {
  const date = new Date(dateStr + "T00:00:00Z");
  const time = date.getTime();
  if (!Number.isFinite(time)) {
    console.warn(`Unparseable date "${dateStr}", falling back to day 0`);
    return 0;
  }
  const yearStart = Date.UTC(date.getUTCFullYear(), 0, 1);
  return Math.floor((time - yearStart) / 86400000);
}
