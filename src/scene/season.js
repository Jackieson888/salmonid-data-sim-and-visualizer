// season.js
// Maps a calendar date to a blended "seasonal look" for the sky sphere and
// sun (see sceneSetup.js) — the visible stand-in for a year passing as the
// timeline advances. Four keyframes anchored on the equinoxes/solstice,
// smoothstep-interpolated between whichever two bracket the current day so
// the look drifts continuously instead of snapping at season boundaries.
//
// Palette reasoning per season (kept in this app's existing teal/blue
// underwater register rather than literal daytime sky colors):
//   Summer — deep, vivid blue: sun near-overhead, light passes through
//     less atmosphere, so color stays saturated and bright.
//   Spring — bright turquoise/cerulean: sun angle lower than summer's,
//     plus a slight green cast (ground reflection).
//   Autumn — pale-to-vibrant aqua with a warm undertone: golden foliage
//     reflecting up, and lower humidity that can intensify the color.
//   Winter — pale, washed-out blue: low sun angle and snow reflection
//     flatten contrast, sun itself dims as if hazier.
//
// causticsColor1/2 (the light net on the riverbed/fish/water surface — see
// causticsChunk.js) stay in the same cyan-green "light net" family across
// all four seasons rather than following the sky to literal blue, since
// real underwater caustics read as refracted sunlight, not a sky
// reflection — only their warmth/saturation/value shifts with the season
// (pale in winter, vivid in summer, fresh in spring, golden in autumn).
import * as THREE from "three";

const WINTER = {
  atmosphereColor: new THREE.Color("#4d6570"),
  depthsColor: new THREE.Color("#172a2e"),
  hemisphereSky: new THREE.Color("#b8ccd2"),
  sunColor: new THREE.Color("#d7e6ea"),
  sunIntensity: 1.6,
  sunDirection: new THREE.Vector3(0.65, 0.5, 0.35),
  causticsColor1: new THREE.Color("#a9c9c2"),
  causticsColor2: new THREE.Color("#243a38"),
};
const SPRING = {
  atmosphereColor: new THREE.Color("#1f7a72"),
  depthsColor: new THREE.Color("#06231c"),
  hemisphereSky: new THREE.Color("#7fe0d8"),
  sunColor: new THREE.Color("#eaf7ff"),
  sunIntensity: 2.1,
  sunDirection: new THREE.Vector3(0.45, 0.85, 0.3),
  causticsColor1: new THREE.Color("#6be0a8"),
  causticsColor2: new THREE.Color("#123b28"),
};
const SUMMER = {
  atmosphereColor: new THREE.Color("#123c66"),
  depthsColor: new THREE.Color("#04141f"),
  hemisphereSky: new THREE.Color("#8fd0ff"),
  sunColor: new THREE.Color("#fff6e0"),
  sunIntensity: 2.4,
  sunDirection: new THREE.Vector3(0.15, 1, 0.1),
  causticsColor1: new THREE.Color("#5cf0c8"),
  causticsColor2: new THREE.Color("#0d3a30"),
};
const AUTUMN = {
  atmosphereColor: new THREE.Color("#3a8a7c"),
  depthsColor: new THREE.Color("#0a251e"),
  hemisphereSky: new THREE.Color("#9fd6b0"),
  sunColor: new THREE.Color("#ffd9a0"),
  sunIntensity: 2.0,
  sunDirection: new THREE.Vector3(0.55, 0.7, 0.35),
  causticsColor1: new THREE.Color("#d9c97a"),
  causticsColor2: new THREE.Color("#332d18"),
};

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

// Reused across calls — copy values out (e.g. Color.copy(), Vector3.copy())
// if you need to hold onto them past the next seasonForDay() call.
const scratch = {
  atmosphereColor: new THREE.Color(),
  depthsColor: new THREE.Color(),
  hemisphereSky: new THREE.Color(),
  sunColor: new THREE.Color(),
  sunDirection: new THREE.Vector3(),
  sunIntensity: 0,
  causticsColor1: new THREE.Color(),
  causticsColor2: new THREE.Color(),
};

export function seasonForDay(dayOfYear) {
  const d = ((dayOfYear % 365) + 365) % 365;
  let i = 0;
  while (KEYFRAMES[i + 1].day <= d) i++;
  const a = KEYFRAMES[i];
  const b = KEYFRAMES[i + 1];
  const t = smoothstep((d - a.day) / (b.day - a.day));

  scratch.atmosphereColor.lerpColors(a.atmosphereColor, b.atmosphereColor, t);
  scratch.depthsColor.lerpColors(a.depthsColor, b.depthsColor, t);
  scratch.hemisphereSky.lerpColors(a.hemisphereSky, b.hemisphereSky, t);
  scratch.sunColor.lerpColors(a.sunColor, b.sunColor, t);
  scratch.sunDirection
    .lerpVectors(a.sunDirection, b.sunDirection, t)
    .normalize();
  scratch.sunIntensity = THREE.MathUtils.lerp(
    a.sunIntensity,
    b.sunIntensity,
    t,
  );
  scratch.causticsColor1.lerpColors(a.causticsColor1, b.causticsColor1, t);
  scratch.causticsColor2.lerpColors(a.causticsColor2, b.causticsColor2, t);

  return scratch;
}

// `dateStr` is "YYYY-MM-DD" (see data.js) — parsed as UTC midnight so the
// result doesn't shift with the browser's local timezone.
export function dayOfYear(dateStr) {
  const date = new Date(dateStr + "T00:00:00Z");
  const yearStart = Date.UTC(date.getUTCFullYear(), 0, 1);
  return Math.floor((date.getTime() - yearStart) / 86400000);
}
