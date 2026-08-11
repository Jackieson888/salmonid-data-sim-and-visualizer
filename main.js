import {
  Flock,
  clusterFish,
  BANK_DEPTH,
  bankTopY,
  bankBottomY,
  ISLAND,
  islandSpace,
  isOverBank,
} from "./boids.js";
import { runData } from "./data.js";

const canvas = document.getElementById("river-canvas");
const ctx = canvas.getContext("2d");

// ---------------------------------------------------------------------
// Fish sprite + baked swim-cycle flipbook
// ---------------------------------------------------------------------
// Bird's-eye steelhead sprite — drawn nose-up in the source image, so
// drawFish() rotates it +90° to align "up" with the fish's +x heading.
// We only have one static illustration, so instead of hand-drawn frames
// we bake a flipbook ourselves: slice it into thin head-to-tail bands and
// shear each band sideways along a traveling sine wave (amplitude growing
// toward the tail, like a real swim stroke). Baking happens once at load,
// so playback is just picking a frame — no per-frame distortion cost.
const SWIM_FRAME_COUNT = 24;
const SWIM_BANDS = 80;

const fishSprite = new Image();
let fishSpriteLoaded = false;
let swimFrames = [];

fishSprite.onload = () => {
  fishSpriteLoaded = true;
  swimFrames = buildSwimFrames(fishSprite, SWIM_FRAME_COUNT, SWIM_BANDS);
};
fishSprite.src = encodeURI("birds eye view of a steelhead .png");

function buildSwimFrames(img, frameCount, bands) {
  const w = img.naturalWidth;
  const h = img.naturalHeight;
  const bandHeight = h / bands;
  const frames = [];

  for (let f = 0; f < frameCount; f++) {
    const frameCanvas = document.createElement("canvas");
    frameCanvas.width = w;
    frameCanvas.height = h;
    const fctx = frameCanvas.getContext("2d");
    const phase = (f / frameCount) * Math.PI * 2;

    for (let b = 0; b < bands; b++) {
      const sy = b * bandHeight;
      const along = b / (bands - 1); // 0 at head, 1 at tail
      const amplitude = w * 0.09 * along * along;
      const xOffset = Math.sin(phase - along * Math.PI * 1.6) * amplitude;
      fctx.drawImage(img, 0, sy, w, bandHeight, xOffset, sy, w, bandHeight);
    }
    frames.push(frameCanvas);
  }
  return frames;
}

// ---------------------------------------------------------------------
// Procedural tileable caustic texture (scrolling light-through-water effect)
// ---------------------------------------------------------------------
const CAUSTIC_TILE = 320;
const causticTexture = buildCausticTexture(CAUSTIC_TILE);
const causticPatternA = ctx.createPattern(causticTexture, "repeat");
const causticPatternB = ctx.createPattern(causticTexture, "repeat");

function buildCausticTexture(size) {
  const c = document.createElement("canvas");
  c.width = size;
  c.height = size;
  const cctx = c.getContext("2d");
  const imageData = cctx.createImageData(size, size);
  const data = imageData.data;

  // Real caustics are a connected net of bright curved threads where
  // refracted light rays converge, not soft glow blobs or scattered dots.
  // The cheap fake for that: sum a few sine waves at different spatial
  // frequencies/directions, then light up the *zero-crossing lines* of
  // that sum (sin(sum) ≈ 0) rather than its peaks. Zero-crossings of a
  // sum of plane waves form a flowing, connected mesh across the whole
  // field — that's what actually reads as a caustic net instead of a
  // starfield. Wavenumbers are integers so each term's period divides
  // the tile size evenly, which is what makes the tile repeat seamlessly.
  const terms = [
    { kx: 3, ky: 1, phase: 0.4, amp: 1 },
    { kx: -2, ky: 4, phase: 2.1, amp: 1 },
    { kx: 1, ky: -3, phase: 4.7, amp: 0.8 },
  ];

  for (let y = 0; y < size; y++) {
    const v = (y / size) * Math.PI * 2;
    for (let x = 0; x < size; x++) {
      const u = (x / size) * Math.PI * 2;

      let field = 0;
      for (const term of terms) {
        field += term.amp * Math.sin(term.kx * u + term.ky * v + term.phase);
      }
      const ridge = 1 - Math.min(1, Math.abs(Math.sin(field)));
      const bright = Math.pow(ridge, 4);

      const idx = (y * size + x) * 4;
      data[idx] = 255;
      data[idx + 1] = 255;
      data[idx + 2] = 255;
      data[idx + 3] = Math.round(bright * 255);
    }
  }

  cctx.putImageData(imageData, 0, 0);
  return c;
}

function drawCaustics(t) {
  const m1 = new DOMMatrix()
    .translate((t * 0.015) % CAUSTIC_TILE, (t * 0.008) % CAUSTIC_TILE)
    .scale(1.4);
  causticPatternA.setTransform(m1);

  const m2 = new DOMMatrix()
    .translate((-t * 0.011) % CAUSTIC_TILE, (t * 0.019) % CAUSTIC_TILE)
    .rotate(35)
    .scale(1.9);
  causticPatternB.setTransform(m2);

  ctx.save();
  ctx.globalCompositeOperation = "lighter";
  ctx.globalAlpha = 0.14;
  ctx.fillStyle = causticPatternA;
  ctx.fillRect(0, 0, bounds.width, bounds.height);
  ctx.globalAlpha = 0.1;
  ctx.fillStyle = causticPatternB;
  ctx.fillRect(0, 0, bounds.width, bounds.height);
  ctx.restore();
}

const dateLabel = document.getElementById("date-label");
const playPauseBtn = document.getElementById("play-pause");
const timelineInput = document.getElementById("timeline");
const fishCountLabel = document.getElementById("fish-count");

let bounds = { width: 0, height: 0 };

function resize() {
  const dpr = window.devicePixelRatio || 1;
  bounds = { width: window.innerWidth, height: window.innerHeight };
  canvas.width = bounds.width * dpr;
  canvas.height = bounds.height * dpr;
  canvas.style.width = `${bounds.width}px`;
  canvas.style.height = `${bounds.height}px`;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  flock.setBounds(bounds);
}

const BASE_MAX_SPEED = 2.4;

const flock = new Flock(bounds, {
  maxSpeed: BASE_MAX_SPEED,
  perceptionRadius: 60,
  separationRadius: 20,
});

window.addEventListener("resize", resize);
resize();

// ---------------------------------------------------------------------
// Run timeline
// ---------------------------------------------------------------------
// `runData` is a placeholder array of { date, count } daily passage counts.
// TODO: replace src/data.js with real Lower Granite Dam counts pulled from
// DART (https://www.cbr.washington.edu/dart/query/adult_daily) — export a
// CSV for the season you want, parse into the same { date, count } shape.

let dayIndex = 0;
let isPlaying = true;
let frameCounter = 0;
const FRAMES_PER_DAY = 40; // how fast the timeline advances when playing

timelineInput.max = String(runData.length - 1);

function targetFishForDay(idx) {
  // Scale real daily counts down to a renderable agent count.
  // Tune SCALE once real DART data is in — placeholder data is already
  // in a reasonable range for on-screen rendering.
  const SCALE = 1;
  return Math.round(runData[idx].count * SCALE);
}

// Day-over-day change in passage count, precomputed once. Used to pick a
// swim speed (see speedMultiplierForRate) — separate from, and in addition
// to, the spawn-rate control below that keeps the standing population
// tracking each day's actual count.
const dailyRateOfChange = runData.map((_, i) =>
  i === 0 ? 0 : targetFishForDay(i) - targetFishForDay(i - 1),
);

// Population target at a given point *within* a day, linearly interpolated
// toward the next day's count so the on-screen total climbs or drains
// smoothly across the day instead of jumping at the boundary.
function desiredPopulation(idx, progress) {
  const today = targetFishForDay(idx);
  const tomorrow = targetFishForDay((idx + 1) % runData.length);
  return today + (tomorrow - today) * progress;
}

function speedMultiplierForRate(rate) {
  // Climbing run (higher rate of change) -> swim slower -> fish linger and
  // the screen fills up. Tapering run (lower/negative rate) -> swim faster
  // -> the screen drains faster than it's being replenished. ±40/day is
  // roughly the typical day-to-day swing in the placeholder data.
  const normalized = Math.max(-1, Math.min(1, rate / 40));
  return 1 - normalized * 0.45; // roughly [0.55x, 1.45x] of BASE_MAX_SPEED
}

function applyDaySpeed(idx) {
  flock.options.maxSpeed =
    BASE_MAX_SPEED * speedMultiplierForRate(dailyRateOfChange[idx]);
}

// Fractional fish-per-frame spawn budget. Accumulating a fraction each
// frame (rather than spawning whole fish) is what makes arrivals during
// playback smooth instead of landing in a lump.
let spawnAccumulator = 0;

// How much of the gap between the actual population and the interpolated
// daily target gets closed per frame. Only ever adds fish (see loop()) —
// when the target is falling, this contributes nothing and the existing
// downstream exit in Flock.step drains the surplus on its own, so the
// population never gets popped up or down to match a day.
const POPULATION_CORRECTION_GAIN = 0.15;

function spawnAtLeftEdge() {
  const x = -Math.random() * 40;
  const top = bankTopY(0, bounds) + 15;
  const bottom = bankBottomY(0, bounds) - 15;
  const y = top + Math.random() * (bottom - top);
  flock.spawn(x, y);
}

// A random point in open channel water — off both banks and clear of the
// island — for scattering the initial/scrubbed-to population across the
// river instead of just the left edge.
function randomOpenWaterPoint() {
  for (let attempt = 0; attempt < 20; attempt++) {
    const x = Math.random() * bounds.width;
    const y = Math.random() * bounds.height;
    if (isOverBank(x, y, bounds)) continue;
    if (islandSpace(x, y, bounds).dist < 1.15) continue;
    return { x, y };
  }
  // Fallback: the open channel at the vertical center, which is never land.
  return { x: Math.random() * bounds.width, y: bounds.height / 2 };
}

// Instantly (re)populates the river to roughly match a given day. Used
// only for the initial load and manual timeline scrubbing, where the user
// expects to see that day's population right away — normal playback never
// calls this, so it never pops fish in or out on its own.
function jumpToDay(idx) {
  const target = targetFishForDay(idx);
  while (flock.fish.length < target) {
    const { x, y } = randomOpenWaterPoint();
    flock.spawn(x, y);
  }
  while (flock.fish.length > target) {
    flock.remove(flock.fish[flock.fish.length - 1]);
  }
  dayIndex = idx;
  frameCounter = 0;
  spawnAccumulator = 0;
  applyDaySpeed(idx);
  dateLabel.textContent = runData[idx].date;
  fishCountLabel.textContent = `${flock.fish.length} fish`;
  timelineInput.value = String(idx);
}

jumpToDay(0);

playPauseBtn.addEventListener("click", () => {
  isPlaying = !isPlaying;
  playPauseBtn.textContent = isPlaying ? "Pause" : "Play";
});

timelineInput.addEventListener("input", (e) => {
  isPlaying = false;
  playPauseBtn.textContent = "Play";
  jumpToDay(Number(e.target.value));
});

// ---------------------------------------------------------------------
// Pod ripples — a water-lens distortion over each school instead of a
// drawn outline. This is a direct port of the classic Godot CanvasItem
// "magnifying glass" shader: for a destination pixel at normalized
// distance d from the lens center, sample the source pattern from radius
// r = atan(d, sqrt(1 - d²)) / π (a compressed radius, since r only ever
// reaches 0.5 as d reaches 1). That compression is what gives a bulging
// water-droplet look — the lens center shows a zoomed-in view of the
// caustic net, while the rim compresses/smears it — instead of a flat
// copy-and-shift. We apply it only to the caustic texture (sampled
// straight from its static tile, not the live canvas) so it reads as the
// ripple specifically bending the water's light, not the fish or the
// background.
// ---------------------------------------------------------------------
const POD_THRESHOLD = 40; // fish within this distance (transitively) join the same pod
const LENS_DISTORTION = 1.0; // shader's `distortion` uniform — bulge strength

// The caustic tile is static once baked, so grab its pixels once instead
// of reading back from the live (scrolling) canvas every frame.
const causticSampleData = causticTexture
  .getContext("2d")
  .getImageData(0, 0, CAUSTIC_TILE, CAUSTIC_TILE).data;

function sampleCausticAlpha(worldX, worldY) {
  const tx = (((worldX | 0) % CAUSTIC_TILE) + CAUSTIC_TILE) % CAUSTIC_TILE;
  const ty = (((worldY | 0) % CAUSTIC_TILE) + CAUSTIC_TILE) % CAUSTIC_TILE;
  return causticSampleData[(ty * CAUSTIC_TILE + tx) * 4 + 3];
}

function drawPodLensRipples(pods, t) {
  ctx.save();
  ctx.globalCompositeOperation = "lighter";

  for (const pod of pods) {
    if (pod.length < 2) continue; // lone fish don't generate a pod ripple

    let cx = 0,
      cy = 0,
      hx = 0,
      hy = 0;
    for (const f of pod) {
      cx += f.x;
      cy += f.y;
      const speed = Math.hypot(f.vx, f.vy) || 1;
      hx += f.vx / speed;
      hy += f.vy / speed;
    }
    cx /= pod.length;
    cy /= pod.length;
    const headingLen = Math.hypot(hx, hy) || 1;
    hx /= headingLen;
    hy /= headingLen;

    // Bigger schools push a bigger lens. Each pod's own gentle breathing
    // pulse (seeded from a member fish, so pods don't all pulse in sync)
    // keeps the bulge feeling alive rather than a static magnifying glass.
    const baseRadius = 18 + Math.min(pod.length * 1.6, 46);
    const seed = pod[0].wobblePhase;
    const pulse = 0.85 + 0.15 * Math.sin(t * 0.0012 + seed);
    const radius = baseRadius * pulse;
    // Nudge the lens slightly ahead of the school's heading, like a bow wave.
    const lensX = cx + hx * radius * 0.25;
    const lensY = cy + hy * radius * 0.25;

    const minX = Math.max(0, Math.floor(lensX - radius));
    const minY = Math.max(0, Math.floor(lensY - radius));
    const maxX = Math.min(bounds.width, Math.ceil(lensX + radius));
    const maxY = Math.min(bounds.height, Math.ceil(lensY + radius));
    const w = maxX - minX;
    const h = maxY - minY;
    if (w <= 0 || h <= 0) continue;

    const patch = document.createElement("canvas");
    patch.width = w;
    patch.height = h;
    const pctx = patch.getContext("2d");
    const patchData = pctx.createImageData(w, h);
    const pdata = patchData.data;

    for (let py = 0; py < h; py++) {
      const ny = (minY + py - lensY) / radius;
      for (let px = 0; px < w; px++) {
        const nx = (minX + px - lensX) / radius;
        const d = Math.hypot(nx, ny);
        if (d > 1) continue; // outside the lens, leave transparent

        const z = Math.sqrt(
          Math.max(0, LENS_DISTORTION - d * d * LENS_DISTORTION),
        );
        const r = Math.atan2(d, z) / Math.PI;
        const phi = Math.atan2(ny, nx);
        const srcX = lensX + Math.cos(phi) * r * radius;
        const srcY = lensY + Math.sin(phi) * r * radius;

        const alpha = sampleCausticAlpha(srcX, srcY);
        if (alpha === 0) continue;

        // Fade toward the rim so the lens blends into the surrounding
        // water instead of showing a hard circular edge.
        const edgeFade = 1 - d * d;
        const idx = (py * w + px) * 4;
        pdata[idx] = 210;
        pdata[idx + 1] = 235;
        pdata[idx + 2] = 245;
        pdata[idx + 3] = Math.round(alpha * edgeFade * 0.85);
      }
    }

    pctx.putImageData(patchData, 0, 0);
    ctx.drawImage(patch, minX, minY);
  }

  ctx.restore();
}

// ---------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------
function drawBackground() {
  const g = ctx.createLinearGradient(0, 0, 0, bounds.height);
  g.addColorStop(0, "#0d2b3a");
  g.addColorStop(1, "#04121a");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, bounds.width, bounds.height);

  drawBank("top");
  drawBank("bottom");
  drawIsland();
}

// Traces the same wavy curve fish collide against (see bankTopY/
// bankBottomY in boids.js) so the drawn shoreline always matches where
// the flock actually stops.
function drawBank(side) {
  const step = 24;
  const isTop = side === "top";
  ctx.beginPath();
  ctx.moveTo(0, isTop ? 0 : bounds.height);
  for (let x = 0; x <= bounds.width; x += step) {
    ctx.lineTo(x, isTop ? bankTopY(x, bounds) : bankBottomY(x, bounds));
  }
  ctx.lineTo(bounds.width, isTop ? 0 : bounds.height);
  ctx.closePath();

  const g = ctx.createLinearGradient(
    0,
    isTop ? bounds.height * BANK_DEPTH : bounds.height * (1 - BANK_DEPTH),
    0,
    isTop ? 0 : bounds.height,
  );
  g.addColorStop(0, "#6f6a48"); // wet sand right at the waterline
  g.addColorStop(1, "#9c9270"); // dry, sun-bleached ground further inland
  ctx.fillStyle = g;
  ctx.fill();
}

// Deterministic vegetation speckles on the island, positioned once (as
// fractions of the island's own radii) so they stay put across resizes
// and frames instead of re-rolling every draw.
const ISLAND_SPECKLES = Array.from({ length: 14 }, () => ({
  u: (Math.random() - 0.5) * 1.7,
  v: (Math.random() - 0.5) * 1.7,
  r: 0.08 + Math.random() * 0.1,
}));

function drawIsland() {
  const cx = ISLAND.cx * bounds.width;
  const cy = ISLAND.cy * bounds.height;
  const rx = ISLAND.rx * bounds.width;
  const ry = ISLAND.ry * bounds.height;

  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(ISLAND.angle);

  const g = ctx.createRadialGradient(0, 0, 0, 0, 0, Math.max(rx, ry));
  g.addColorStop(0, "#a89670");
  g.addColorStop(1, "#7a7250");
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.ellipse(0, 0, rx, ry, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = "#5f5a3c";
  ctx.lineWidth = 1.5;
  ctx.stroke();

  ctx.fillStyle = "#5c6b41";
  for (const speckle of ISLAND_SPECKLES) {
    const px = speckle.u * rx;
    const py = speckle.v * ry;
    if ((px * px) / (rx * rx) + (py * py) / (ry * ry) > 0.85) continue; // keep clear of the shoreline
    ctx.beginPath();
    ctx.ellipse(px, py, speckle.r * rx, speckle.r * ry, 0, 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.restore();
}

function drawFish(fish, t) {
  const angle = Math.atan2(fish.vy, fish.vx);
  const speedRatio = Math.min(fish.speed / 2.6, 1);

  ctx.save();
  ctx.translate(fish.x, fish.y);

  if (fishSpriteLoaded && swimFrames.length) {
    // Faster-swimming fish beat their tail quicker; wobblePhase keeps
    // each fish's cycle out of sync with its neighbors.
    const cycleRate = fish.wobbleSpeed * (0.6 + speedRatio * 0.8);
    const swimPhase = t * 0.001 * cycleRate + fish.wobblePhase;
    const normalized =
      ((swimPhase % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
    const frameIndex = Math.floor(
      (normalized / (Math.PI * 2)) * SWIM_FRAME_COUNT,
    );
    const frame = swimFrames[frameIndex];

    ctx.rotate(angle + Math.PI / 2);
    const h = fish.length * 2.8;
    const w = h * (frame.width / frame.height);
    ctx.globalAlpha = 0.75 + speedRatio * 0.25;
    ctx.drawImage(frame, -w / 2, -h / 2, w, h);
    ctx.globalAlpha = 1;
  } else {
    const wobble =
      Math.sin(t * 0.001 * fish.wobbleSpeed + fish.wobblePhase) * 0.25;
    ctx.rotate(angle + wobble);
    const len = fish.length;
    ctx.beginPath();
    ctx.moveTo(len, 0);
    ctx.quadraticCurveTo(0, len * 0.45, -len, 0);
    ctx.quadraticCurveTo(0, -len * 0.45, len, 0);
    ctx.closePath();
    ctx.fillStyle = `rgba(180, 210, 220, ${0.55 + speedRatio * 0.3})`;
    ctx.fill();
  }

  ctx.restore();
}

// Confines subsequent drawing to open channel water — the wavy strip
// between the two banks, minus the island — so light effects like the
// caustics don't shimmer across dry land.
function clipToWater() {
  ctx.beginPath();
  ctx.moveTo(0, bankTopY(0, bounds));
  for (let x = 0; x <= bounds.width; x += 24) ctx.lineTo(x, bankTopY(x, bounds));
  for (let x = bounds.width; x >= 0; x -= 24) {
    ctx.lineTo(x, bankBottomY(x, bounds));
  }
  ctx.closePath();
  ctx.ellipse(
    ISLAND.cx * bounds.width,
    ISLAND.cy * bounds.height,
    ISLAND.rx * bounds.width,
    ISLAND.ry * bounds.height,
    ISLAND.angle,
    0,
    Math.PI * 2,
  );
  ctx.clip("evenodd");
}

function render(t) {
  drawBackground();
  const pods = clusterFish(flock.fish, POD_THRESHOLD);
  for (const fish of flock.fish) drawFish(fish, t);
  ctx.save();
  clipToWater();
  drawCaustics(t);
  ctx.restore();
  drawPodLensRipples(pods, t);
}

// ---------------------------------------------------------------------
// Animation loop
// ---------------------------------------------------------------------
function loop(t) {
  flock.step(1);
  // Population drifts continuously as fish arrive (spawnAccumulator below)
  // and exit downstream (Flock.step), so keep the HUD count live rather
  // than only updating it on a day tick.
  fishCountLabel.textContent = `${flock.fish.length} fish`;
  render(t);

  if (isPlaying) {
    // Only spawn enough to close the gap toward the day's (interpolated)
    // target population. When the target is climbing, this stays positive
    // and fish arrive faster than they exit, growing the count. When the
    // target is falling, the actual population is already above target,
    // the error goes negative, and Math.max clamps spawning to zero —
    // fish keep exiting via Flock.step but nothing new replaces them, so
    // the count drains down to match without ever being popped out.
    const progress = frameCounter / FRAMES_PER_DAY;
    const target = desiredPopulation(dayIndex, progress);
    const error = target - flock.fish.length;
    spawnAccumulator += Math.max(0, error) * POPULATION_CORRECTION_GAIN;
    while (spawnAccumulator >= 1) {
      spawnAtLeftEdge();
      spawnAccumulator -= 1;
    }

    frameCounter++;
    if (frameCounter >= FRAMES_PER_DAY) {
      frameCounter = 0;
      dayIndex = (dayIndex + 1) % runData.length;
      applyDaySpeed(dayIndex);
      dateLabel.textContent = runData[dayIndex].date;
      timelineInput.value = String(dayIndex);
    }
  }

  requestAnimationFrame(loop);
}

requestAnimationFrame(loop);
