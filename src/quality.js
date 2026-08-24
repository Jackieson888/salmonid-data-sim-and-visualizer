// quality.js
// Device-tier detection, the settings each tier implies, and the frame-time
// governor that corrects a wrong guess.
//
// Every cost in this scene used to be fixed at author time, tuned against a
// desktop GPU. This module is the single place those numbers live now, so a
// phone gets a scene it can actually draw. Nothing here decides *how* to spend
// the budget — the scene modules read these knobs and build themselves
// accordingly (see createWorld in main.js, which is also the rebuild path a
// tier change runs through).
//
// Two things pick the tier, in this order:
//
//  1. detectTier(), once at boot. Cheap, synchronous, and — being a guess off
//     user-agent-adjacent signals — frequently wrong at the margins.
//  2. createPerfGovernor(), continuously. Measures what the device actually
//     achieves and steps down when the guess was too optimistic. This is the
//     authority; detection only picks a starting point so the first few
//     seconds aren't a slideshow on a device that was never going to hold it.
//
// There is deliberately no user-facing quality control. `?quality=low` forces
// a tier for development and A/B testing (see the debug panel in main.js), but
// it is not a feature — a viewer should never have to know this module exists.

// Ordered weakest to strongest. Indices are used for stepping, so the order
// matters more than the names.
const TIERS = ["low", "medium", "high"];

// ---------------------------------------------------------------------
// The tier table
// ---------------------------------------------------------------------
//
// A note on what got cut where, because the ordering is not obvious from the
// numbers alone. Measured by hand, this scene's cost is dominated by the
// caustics pass (a 256x256 grid whose *vertex* shader ray-marches an
// environment map up to 40 steps, each step a texture fetch) and the 600^2
// water simulation feeding it. Vertex texture fetch inside a loop is close to
// the worst case for older Mali/Adreno parts, so the low tier drops both
// outright and fakes the result procedurally (see causticsProcedural in
// glsl.js) rather than trying to run a cheaper version of them. Everything
// else — particle count, shaft count, bloom — is scaled rather than removed.
//
// The fish are NOT the expensive thing, despite what the comments in
// fishMesh.js/main.js long claimed: the mesh is 435 vertices, not the ~1300
// those comments assert, so the flock costs ~522K vertex invocations rather
// than the ~2M that justified the population cap. MAX_POPULATION still scales
// here, but it is a fill-rate and CPU-sim lever, not the vertex lever it was
// documented as.
const SETTINGS = {
  low: {
    // 1.0 even on a 3x-DPI phone. This is the single highest-leverage number
    // in the table: every fragment cost in the scene scales with its square.
    pixelRatio: 1,

    // Both of the top two GPU costs, gone. createWorld() skips constructing
    // the simulation and the generator entirely when this is false — no
    // ping-pong targets, no 1024^2 accumulation target, no 131K-triangle
    // ray-marched draw. Consumers switch to the procedural caustic/normal
    // path behind a compile-time define, so there is no runtime branch left
    // in any shader either.
    realCaustics: false,
    waterSimSize: 0,
    causticsSegments: 0,
    causticsTargetSize: 0,
    causticsEnvSize: 0,
    causticsIterations: 0,
    causticsInterval: 0,

    // One tap instead of the 5-tap box blur. Moot while realCaustics is off
    // (the procedural path is evaluated, not sampled) but kept defined so the
    // knob means the same thing at every tier.
    causticTaps: 1,

    population: 300,
    particleCount: 0,
    shaftCount: 0,

    // Bloom is ~13 fullscreen passes with 6-22-tap separable blurs. The whole
    // chain collapses to a single combined pass here — see createSceneSetup.
    bloom: "off",

    // The water and riverbed planes are drawn oversized so their edges can
    // dissolve into fog rather than ending on a hard silhouette. 1.7x is
    // 2.9x the area against high's 5.8x, and the fog closes in well before
    // the edge at this tier anyway.
    waterSizeMultiplier: 1.7,


    // Blinn-Phong specular and the rim term are two pow() calls per fragment
    // across the whole flock. Legible on a 27" display, invisible on a phone.
    fishHighlights: false,

    // Halves the VAT texture and its per-vertex fetch cost. The tailbeat is a
    // smooth loop, so 15 poses interpolate to something very close to 30.
    vatFrames: 15,
  },

  medium: {
    pixelRatio: 1.5,
    realCaustics: true,
    waterSimSize: 256,
    causticsSegments: 128,
    causticsTargetSize: 512,
    causticsEnvSize: 256,
    causticsIterations: 20,
    causticsInterval: 3,
    causticTaps: 1,
    population: 650,
    particleCount: 1400,
    shaftCount: 8,
    bloom: "half",
    waterSizeMultiplier: 2.1,
    fishHighlights: true,
    vatFrames: 30,
  },

  high: {
    pixelRatio: 2,
    realCaustics: true,
    // 512 rather than the 600 this shipped with. Not a power of two, 27%
    // fewer texels, and no visible difference in the height field.
    waterSimSize: 512,
    causticsSegments: 256,
    causticsTargetSize: 1024,
    causticsEnvSize: 512,
    causticsIterations: 40,
    causticsInterval: 2,
    causticTaps: 5,
    population: 1200,
    particleCount: 4200,
    shaftCount: 18,
    bloom: "full",
    waterSizeMultiplier: 2.4,
    fishHighlights: true,
    vatFrames: 30,
  },
};

// ---------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------

// GPU strings that mean "do not attempt the real caustics pass". Software
// rasterizers first (SwiftShader is what Chrome falls back to when hardware
// acceleration is off — it will not hold 60fps at any tier, but low at least
// stays interactive), then the mobile parts old enough to make vertex texture
// fetch in a loop genuinely painful.
//
// Mali-G57 and Adreno 6xx and up are deliberately NOT here: they handle the
// medium tier fine, and the governor will catch the ones that don't.
const WEAK_GPU =
  /SwiftShader|llvmpipe|Software|Microsoft Basic Render|PowerVR|VideoCore|Mali-[T4]|Mali-G[1-5][0-9](\D|$)|Adreno \(TM\) [1-5][0-9][0-9]/i;

// Reads the GPU string through WEBGL_debug_renderer_info, then throws the
// context away.
//
// The throwaway context matters: mobile browsers cap how many live WebGL
// contexts a page may hold (often single digits) and silently kill the oldest
// when the cap is hit — which would be the scene's own. loseContext() releases
// it immediately rather than waiting for GC to get around to it.
//
// Returns null when the extension is unavailable, which is increasingly
// common: Firefox's resistFingerprinting and Safari's privacy modes both mask
// it. That is a supported outcome, not a failure — the checks below stand on
// their own and the governor backstops all of it.
function probeGpu() {
  try {
    const canvas = document.createElement("canvas");
    const gl =
      canvas.getContext("webgl2") ||
      canvas.getContext("webgl") ||
      canvas.getContext("experimental-webgl");
    if (!gl) return null;

    const debugInfo = gl.getExtension("WEBGL_debug_renderer_info");
    const name = debugInfo
      ? gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL)
      : gl.getParameter(gl.RENDERER);

    gl.getExtension("WEBGL_lose_context")?.loseContext();
    return typeof name === "string" ? name : null;
  } catch {
    // A context probe should never be able to stop the page from loading.
    return null;
  }
}

// Picks the starting tier. Every signal here is a hint rather than a fact —
// hardwareConcurrency is clamped by some browsers, deviceMemory doesn't exist
// on Safari at all, and the GPU string is maskable — so this errs toward
// guessing low on mobile and lets the governor decide the rest. Guessing low
// and being wrong costs some visual richness for a few seconds; guessing high
// and being wrong costs a device that never renders a usable frame.
//
// Returns { tier, reason } — the reason string is surfaced in the debug panel,
// because "why did this device land on medium" is otherwise unanswerable.
export function detectTier() {
  const forced = new URLSearchParams(window.location.search).get("quality");
  if (forced && TIERS.includes(forced)) {
    return { tier: forced, reason: `forced by ?quality=${forced}` };
  }

  const gpu = probeGpu();
  if (gpu && WEAK_GPU.test(gpu)) {
    return { tier: "low", reason: `known-weak GPU: ${gpu}` };
  }

  // `(pointer: coarse)` is the most reliable mobile/tablet signal available —
  // it describes the input device rather than parsing a user-agent string, and
  // unlike screen size it doesn't misfire on a small desktop window.
  const coarse =
    window.matchMedia?.("(pointer: coarse)").matches ?? false;
  const cores = navigator.hardwareConcurrency || 4;
  const memory = navigator.deviceMemory || 4;

  if (coarse && cores <= 4) {
    return { tier: "low", reason: `touch device, ${cores} cores` };
  }
  if (memory <= 2) {
    return { tier: "low", reason: `${memory}GB device memory` };
  }
  if (coarse) {
    return {
      tier: "medium",
      reason: `touch device, ${cores} cores${gpu ? `, ${gpu}` : ""}`,
    };
  }
  return { tier: "high", reason: gpu ? `desktop, ${gpu}` : "desktop" };
}

// ---------------------------------------------------------------------
// Live state
// ---------------------------------------------------------------------

const detected = detectTier();

// Mutated in place by applyTier() rather than reassigned, so modules can hold
// a reference to it (`import { QUALITY }`) and always see current values
// without a subscription. The scene reads it at build time, and a tier change
// goes through a full world rebuild anyway (see main.js), so there is no
// need for anything more elaborate than this.
export const QUALITY = { ...SETTINGS[detected.tier] };

let currentTier = detected.tier;

export const qualityTier = () => currentTier;
export const qualityReason = () => detected.reason;
export const qualityForced = () => /[?&]quality=/.test(window.location.search);

function applyTier(tier) {
  currentTier = tier;
  Object.assign(QUALITY, SETTINGS[tier]);
}

// ---------------------------------------------------------------------
// The frame-time governor
// ---------------------------------------------------------------------

// Frames to ignore at startup. The first second or so of any WebGL page is
// shader compilation, texture upload and GLB parsing, none of which reflects
// the steady-state cost this is trying to measure. Sampling through it would
// downgrade every device on the planet.
const WARMUP_FRAMES = 60;

// Frames per measurement window. At 60fps this is a decision every two
// seconds — slow enough that one bad frame can't trigger it, fast enough that
// a viewer on a struggling device isn't watching a slideshow for long.
const WINDOW_FRAMES = 120;

// Frames to ignore after a downgrade. A tier change tears down and rebuilds
// every GPU resource in the scene (see rebuildWorld in main.js), which is
// itself a multi-frame stall — measuring through it would immediately trigger
// another downgrade off the cost of the last one.
const COOLDOWN_FRAMES = 300;

// 20.8ms ≈ 48fps. Deliberately below 60: a device holding a steady 55fps is
// doing fine, and rebuilding the world to claw back 5fps would cost more in
// hitching than it returns. This is the "clearly not coping" line, not the
// "not perfect" line.
const DOWNGRADE_MS = 20.8;

// Returns the median of a ring buffer, which is why the buffer is copied
// before sorting — sorting in place would scramble the ring's write order.
//
// Median rather than mean, deliberately. Frame times are a spiky signal: a
// GC pause, a texture upload, or the browser doing layout on another tab all
// show up as single frames of 100ms+. A mean lets any one of those drag a
// perfectly healthy window over the threshold; a median ignores them, which
// is exactly the behaviour wanted from something whose response is a
// full world rebuild.
function median(values, count) {
  const sorted = values.slice(0, count).sort((a, b) => a - b);
  return sorted[sorted.length >> 1];
}

// Watches frame times and steps the tier down when the device clearly isn't
// coping. `onChange(tier)` fires after QUALITY has been updated, and is
// expected to rebuild whatever reads it.
//
// There is deliberately no auto-*upgrade*. The measurement that would justify
// one — "we have headroom now" — is only observable at the lower tier, where
// the scene is cheaper by construction, so a device sitting right at the
// boundary would upgrade, miss the threshold, downgrade, and repeat. Each
// round trip is two full world rebuilds. Sitting one tier lower than
// strictly necessary is a much better failure than oscillating between them.
// `onChange` is null when the tier was forced via ?quality=. The governor
// still measures in that case — the debug panel's frame time is the whole
// point of forcing a tier to A/B it — it just never acts on what it measures.
export function createPerfGovernor(onChange) {
  const samples = new Float32Array(WINDOW_FRAMES);
  let count = 0;
  let skip = WARMUP_FRAMES;
  let lastMedian = 0;

  return {
    // Called once per frame with the raw frame delta in milliseconds.
    sample(deltaMs) {
      if (skip > 0) {
        skip--;
        return;
      }

      // Guard against the delta a backgrounded tab produces on return:
      // rAF stops firing entirely, so the first frame back can be minutes
      // long. That is not a performance signal.
      if (deltaMs > 0 && deltaMs < 1000) samples[count++] = deltaMs;
      if (count < WINDOW_FRAMES) return;

      lastMedian = median(samples, count);
      count = 0;

      if (onChange === null) return;

      const index = TIERS.indexOf(currentTier);
      if (lastMedian > DOWNGRADE_MS && index > 0) {
        applyTier(TIERS[index - 1]);
        skip = COOLDOWN_FRAMES;
        onChange(currentTier);
      }
    },

    // Surfaced in the debug panel. 0 until the first window completes.
    get medianMs() {
      return lastMedian;
    },
  };
}
