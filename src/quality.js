// Device-tier detection, the settings each tier implies, and the frame-time governor that corrects a wrong guess.

// Ordered weakest to strongest; indices are used for stepping.
const TIERS = ["low", "medium", "high"];

const SETTINGS = {
  low: {
    // Highest-leverage number in the table — fragment cost scales with its square.
    pixelRatio: 1,

    // Both top two GPU costs, gone.
    realCaustics: false,
    waterSimSize: 0,
    causticsSegments: 0,
    causticsTargetSize: 0,
    causticsEnvSize: 0,
    causticsIterations: 0,
    causticsInterval: 0,
    causticTaps: 1,

    population: 220,
    particleCount: 0,
    shaftCount: 0,
    bloom: "off",
    waterSizeMultiplier: 1.7,
    fishHighlights: false,
  },

  medium: {
    pixelRatio: 1.5,
    realCaustics: true,
    waterSimSize: 256,
    causticsSegments: 68,
    causticsTargetSize: 512,
    causticsEnvSize: 256,
    causticsIterations: 20,
    causticsInterval: 3,
    causticTaps: 1,
    population: 460,
    particleCount: 1400,
    shaftCount: 8,
    bloom: "half",
    waterSizeMultiplier: 2.1,
    fishHighlights: true,
  },

  high: {
    pixelRatio: 2,
    realCaustics: true,
    waterSimSize: 512,
    causticsSegments: 120,
    // Deliberately not cut to match causticsSegments — free resolution at identical fill cost.
    causticsTargetSize: 1024,
    causticsEnvSize: 512,
    causticsIterations: 40,
    causticsInterval: 2,
    causticTaps: 5,
    population: 850,
    particleCount: 4200,
    shaftCount: 18,
    bloom: "full",
    waterSizeMultiplier: 2.4,
    fishHighlights: true,
  },
};

// GPU strings meaning "do not attempt the real caustics pass" — software rasterizers and old mobile parts.
const WEAK_GPU =
  /SwiftShader|llvmpipe|Software|Microsoft Basic Render|PowerVR|VideoCore|Mali-[T4]|Mali-G[1-5][0-9](\D|$)|Adreno \(TM\) [1-5][0-9][0-9]/i;

// Throws the WebGL context away immediately rather than waiting for GC; returns null if the debug extension is unavailable.
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

// Picks the starting tier from hints, not facts, erring toward low on mobile; the governor corrects the rest.
export function detectTier() {
  const forced = new URLSearchParams(window.location.search).get("quality");
  if (forced && TIERS.includes(forced)) {
    return { tier: forced, reason: `forced by ?quality=${forced}` };
  }

  const gpu = probeGpu();
  if (gpu && WEAK_GPU.test(gpu)) {
    return { tier: "low", reason: `known-weak GPU: ${gpu}` };
  }

  // Input device, not a parsed user-agent string — the most reliable mobile/tablet signal.
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

const detected = detectTier();

// Mutated in place by applyTier(), not reassigned, so `import { QUALITY }` consumers always see current values.
export const QUALITY = { ...SETTINGS[detected.tier] };

let currentTier = detected.tier;

export const qualityTier = () => currentTier;
export const qualityReason = () => detected.reason;
export const qualityForced = () => /[?&]quality=/.test(window.location.search);

function applyTier(tier) {
  currentTier = tier;
  Object.assign(QUALITY, SETTINGS[tier]);
}

// Ignore the first second or so — shader compile/texture upload/GLB parsing, not steady-state cost.
const WARMUP_FRAMES = 60;

// Decision every ~2s at 60fps — slow enough one bad frame can't trigger it, fast enough not to stall.
const WINDOW_FRAMES = 120;

// A tier change is itself a multi-frame stall — don't measure through it.
const COOLDOWN_FRAMES = 300;

// ≈48fps, the "clearly not coping" line.
const DOWNGRADE_MS = 20.8;

// Copies before sorting so sorting in place doesn't scramble the ring buffer's write order.
function median(values, count) {
  const sorted = values.slice(0, count).sort((a, b) => a - b);
  return sorted[sorted.length >> 1];
}

// Watches frame times and steps the tier down when the device isn't coping; never auto-upgrades.
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

      // Excludes the delta a backgrounded tab produces on return.
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
