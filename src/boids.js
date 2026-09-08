// Reynolds flocking plus fish-specific drift, drag, edge steering, and a fade in/out lifecycle. Fully 2D (x, y).

// Equal to REMOVE_FADE_FRAMES intentionally — fish fade in and out over the same duration.
const SPAWN_FADE_FRAMES = 24;

// Renderer sizes its instance capacity off this; equal to SPAWN_FADE_FRAMES intentionally.
export const REMOVE_FADE_FRAMES = 24;

// Blend factor for Fish.smoothSpeed's EMA.
const SPEED_SMOOTHING = 0.03;

// Flocking-force tuning knobs used in step().
const ALIGNMENT_GAIN = 0.05;
const COHESION_GAIN = 0.0005;
const FLOW_BIAS_SCALE = 0.01;
const CURRENT_DRAG_SCALE = 0.01;
const CURRENT_DRAG_FREQUENCY = 0.002;

// Spread of a freshly spawned fish's initial heading around straight downstream.
const SPAWN_HEADING_SPREAD = Math.PI * 0.5;

// Real-world nose-to-tail length range per DART species, in inches.
// Also used by the fish viewer's field-guide card (src/inspect.js).
export const SPECIES_LENGTH_INCHES = {
  shad: [12, 20],
  jackChinook: [12, 20],
  chinook: [30, 44],
  steelhead: [24, 32],
  lamprey: [18, 27],
};
const DEFAULT_LENGTH_INCHES = [30, 35];

// fish.length * BODY_VISUAL_SCALE = rendered body length in world units.
// Also imported by fishMesh.js — sim and renderer must agree on this exactly.
export const BODY_VISUAL_SCALE = 2.4;

// Fraction of two fish's summed body length that counts as "too close" (overlap-resolution pass).
const OVERLAP_CLEARANCE = 0.4;

// Cell size for the overlap grid; must be >= the largest possible minDist between two fish.
const OVERLAP_GRID_CELL_SIZE = 48;

// Packs a grid cell's (cx, cy) into one Map key without allocating a string per lookup.
const GRID_KEY_SCALE = 1 << 20;

function gridKey(cx, cy) {
  return cx * GRID_KEY_SCALE + cy;
}

// Buckets `fish` by cellSize x cellSize cell, so callers scan 9 cells instead of the whole flock; pools its arrays across frames.
class SpatialGrid {
  constructor() {
    this.cells = new Map();
    this.pool = [];
    this.used = 0;
  }

  build(fish, cellSize) {
    const previousUsed = this.used;
    this.cells.clear();
    this.used = 0;

    for (const f of fish) {
      const key = gridKey(
        Math.floor(f.x / cellSize),
        Math.floor(f.y / cellSize),
      );
      let bucket = this.cells.get(key);
      if (bucket === undefined) {
        bucket = this.pool[this.used];
        if (bucket === undefined) bucket = this.pool[this.used] = [];
        else bucket.length = 0;
        this.used++;
        this.cells.set(key, bucket);
      }
      bucket.push(f);
    }

    // Release fish references from buckets the pool no longer hands out, so a shrinking flock can't leak dead Fish.
    for (let i = this.used; i < previousUsed; i++) this.pool[i].length = 0;
  }

  get(key) {
    return this.cells.get(key);
  }
}

export class Fish {
  constructor(x, y, species = "steelhead") {
    this.x = x;
    this.y = y;
    // Which DART species (data.js) — renderer picks the model/tint from this.
    this.species = species;
    // Mostly rightward (downstream) with some spread.
    const angle = (Math.random() - 0.5) * SPAWN_HEADING_SPREAD;
    const speed = 1 + Math.random() * 0.5;
    this.vx = Math.cos(angle) * speed;
    this.vy = Math.sin(angle) * speed;
    // Per-fish size variation, sized to this species' real-world range (SPECIES_LENGTH_INCHES).
    const [minLength, maxLength] =
      SPECIES_LENGTH_INCHES[species] ?? DEFAULT_LENGTH_INCHES;
    this.length = minLength + Math.random() * (maxLength - minLength);
    this.wobblePhase = Math.random() * Math.PI;

    // Fixed for life; renderer reads these for tailbeat rate/amplitude (fishMesh.js).
    this.swimRate = 0.88 + Math.random() * 0.24;
    this.swimAmplitude = 0.85 + Math.random() * 0.3;

    // Position in [0, 1) within the tailbeat cycle; advanced/wrapped by the renderer each frame.
    this.swimCyclePos = 0;

    // Vertical wander: eases toward a randomly re-picked target depth on its own timer.
    this.depth = 0.2 + Math.random() * 0.6;
    this.depthTarget = this.depth;
    this.depthCooldown = 60 + Math.random() * 150;

    // Body pitch (radians), maintained by the renderer (PITCH_SMOOTHING in fishMesh.js).
    this.pitch = 0;

    // Scratch: this fish's squared XZ camera distance, written once per frame by the renderer.
    this._camDistSq = 0;

    // Index into Flock.fish for the current step's overlap pass (see step()).
    this.__gridIdx = 0;

    // This step's accumulated overlap correction, applied (clamped) at the end of step().
    this._corrX = 0;
    this._corrY = 0;

    // Fade in/out lifecycle. `age` drives fade-in; `removing`/`removeAge` drive fade-out.
    this.age = 0;
    this.removing = false;
    this.removeAge = 0;

    // Low-passed swim speed (see Flock.step()), read by the renderer for tailbeat rate.
    // Equal to `speed` above exactly — vx/vy are its cos/sin decomposition.
    this.smoothSpeed = speed;
  }

  get opacity() {
    if (this.removing) {
      return Math.max(0, 1 - this.removeAge / REMOVE_FADE_FRAMES);
    }
    return Math.min(1, this.age / SPAWN_FADE_FRAMES);
  }
}

export class Flock {
  constructor(bounds, options = {}) {
    this.bounds = bounds;
    this.fish = [];

    // Fish that crossed the exit line on the most recent step() — read by main.js's population pacing.
    this.exitedLastStep = 0;

    // Held across frames so their bucket pools survive; separate instances since cell sizes differ.
    this.flockGrid = new SpatialGrid();
    this.overlapGrid = new SpatialGrid();

    // Maintained rather than recounted — see activeCount().
    this._activeCount = 0;

    this.options = {
      perceptionRadius: options.perceptionRadius ?? 55,
      separationRadius: options.separationRadius ?? 22,
      maxSpeed: options.maxSpeed ?? 2.6,
      maxForce: options.maxForce ?? 0.05,
      separationWeight: options.separationWeight ?? 1.6,
      alignmentWeight: options.alignmentWeight ?? 1.0,
      cohesionWeight: options.cohesionWeight ?? 0.9,
      flowWeight: options.flowWeight ?? 0.35,
      currentWeight: options.currentWeight ?? 0.18,
      margin: options.margin ?? 80,
      edgeSteer: options.edgeSteer ?? 0.25,
    };
  }

  spawn(x, y, species) {
    const fish = new Fish(x, y, species);
    this.fish.push(fish);
    this._activeCount++;
    return fish;
  }

  // Flags a fade-out rather than deleting immediately; step() drops it once faded. Idempotent.
  remove(fish) {
    if (fish.removing) return;
    fish.removing = true;
    fish.removeAge = 0;
    this._activeCount--;
  }

  // Fish still logically part of the run, excluding ones fading out after remove(). Maintained incrementally.
  activeCount() {
    return this._activeCount;
  }

  // Flags up to `n` not-yet-removing fish to fade out, in one array pass.
  removeActive(n) {
    for (let i = 0; i < this.fish.length && n > 0; i++) {
      const fish = this.fish[i];
      if (fish.removing) continue;
      this.remove(fish);
      n--;
    }
  }

  // Immediately drops fish still mid-fade-out, skipping the rest of the fade.
  finalizeRemovals() {
    this._pruneFish(
      this.fish.some((f) => f.removing),
      (f) => f.removing,
    );
  }

  // Filters this.fish to drop everything matching `predicate`, but only when `shouldPrune` is already known true.
  _pruneFish(shouldPrune, predicate) {
    if (shouldPrune) {
      this.fish = this.fish.filter((f) => !predicate(f));
    }
  }

  setBounds(bounds) {
    this.bounds = bounds;
  }

  step(dt = 1) {
    const { perceptionRadius, separationRadius } = this.options;
    const perceptionSq = perceptionRadius * perceptionRadius;
    const separationSq = separationRadius * separationRadius;

    // Sized to perceptionRadius so the 3x3-cell scan below covers every fish within it. Rebuilt fresh each step.
    const grid = this.flockGrid;
    grid.build(this.fish, perceptionRadius);

    for (const fish of this.fish) {
      let sepX = 0,
        sepY = 0,
        sepCount = 0;
      let aliX = 0,
        aliY = 0,
        aliCount = 0;
      let cohX = 0,
        cohY = 0,
        cohCount = 0;

      const fcx = Math.floor(fish.x / perceptionRadius);
      const fcy = Math.floor(fish.y / perceptionRadius);
      for (let gx = fcx - 1; gx <= fcx + 1; gx++) {
        for (let gy = fcy - 1; gy <= fcy + 1; gy++) {
          const bucket = grid.get(gridKey(gx, gy));
          if (!bucket) continue;
          for (const other of bucket) {
            if (other === fish) continue;
            const dx = other.x - fish.x;
            const dy = other.y - fish.y;
            const distSq = dx * dx + dy * dy;
            if (distSq > perceptionSq || distSq === 0) continue;

            if (distSq < separationSq) {
              sepX -= dx / distSq;
              sepY -= dy / distSq;
              sepCount++;
            }
            aliX += other.vx;
            aliY += other.vy;
            aliCount++;
            cohX += other.x;
            cohY += other.y;
            cohCount++;
          }
        }
      }

      let ax = 0,
        ay = 0;

      // Separation: steer away from the (inverse-distance-weighted) average
      // direction to nearby neighbors, so fish don't pile on top of each other.
      if (sepCount > 0) {
        ax += (sepX / sepCount) * this.options.separationWeight;
        ay += (sepY / sepCount) * this.options.separationWeight;
      }
      // Alignment: steer velocity toward the neighborhood's average velocity,
      // so nearby fish gradually match heading/speed.
      if (aliCount > 0) {
        const avgVx = aliX / aliCount,
          avgVy = aliY / aliCount;
        ax += (avgVx - fish.vx) * ALIGNMENT_GAIN * this.options.alignmentWeight;
        ay += (avgVy - fish.vy) * ALIGNMENT_GAIN * this.options.alignmentWeight;
      }
      // Cohesion: steer toward the neighborhood's average position, so the
      // school stays loosely grouped instead of drifting apart.
      if (cohCount > 0) {
        const cx = cohX / cohCount,
          cy = cohY / cohCount;
        ax += (cx - fish.x) * COHESION_GAIN * this.options.cohesionWeight;
        ay += (cy - fish.y) * COHESION_GAIN * this.options.cohesionWeight;
      }

      // Gentle downstream bias — the run flows left (spawn) to right (exit).
      ax += this.options.flowWeight * FLOW_BIAS_SCALE;

      // Current drag: a slow lateral drift, like river current pushing back
      ay +=
        Math.sin(fish.x * CURRENT_DRAG_FREQUENCY) *
        this.options.currentWeight *
        CURRENT_DRAG_SCALE;

      // Math.sqrt, not Math.hypot — faster in V8, and overflow protection is unneeded at these magnitudes.
      const forceMag = Math.sqrt(ax * ax + ay * ay);
      const maxForce = this.options.maxForce;
      if (forceMag > maxForce) {
        ax = (ax / forceMag) * maxForce;
        ay = (ay / forceMag) * maxForce;
      }

      // Steer away from top/bottom/left edges (right stays open for exit), applied after the flocking clamp with its own headroom.
      const { margin, edgeSteer } = this.options;
      if (fish.y < margin) ay += edgeSteer * (1 - fish.y / margin);
      if (fish.y > this.bounds.height - margin) {
        ay -= edgeSteer * (1 - (this.bounds.height - fish.y) / margin);
      }
      if (fish.x < margin) ax += edgeSteer * (1 - fish.x / margin);

      // Integrate: apply the clamped steering force to velocity.
      fish.vx += ax * dt;
      fish.vy += ay * dt;

      // Clamp speed
      const speed = Math.sqrt(fish.vx * fish.vx + fish.vy * fish.vy);
      const maxSpeed = this.options.maxSpeed;
      if (speed > maxSpeed) {
        fish.vx = (fish.vx / speed) * maxSpeed;
        fish.vy = (fish.vy / speed) * maxSpeed;
      } else if (speed < maxSpeed * 0.4) {
        // keep a minimum cruising speed so fish don't stall
        const scale = (maxSpeed * 0.4) / (speed || 1);
        fish.vx *= scale;
        fish.vy *= scale;
      }

      // Post-clamp speed, derived from the branch just taken above instead of a third sqrt call.
      const newSpeed =
        speed > maxSpeed
          ? maxSpeed
          : speed < maxSpeed * 0.4
            ? maxSpeed * 0.4
            : speed;
      fish.smoothSpeed +=
        (newSpeed - fish.smoothSpeed) * Math.min(1, SPEED_SMOOTHING * dt);

      // Integrate: apply velocity to position.
      fish.x += fish.vx * dt;
      fish.y += fish.vy * dt;

      // Hard clamp: zeroes outward velocity rather than bouncing, so the rendered heading doesn't snap.
      if (fish.y < 0) {
        fish.y = 0;
        if (fish.vy < 0) fish.vy = 0;
      }
      if (fish.y > this.bounds.height) {
        fish.y = this.bounds.height;
        if (fish.vy > 0) fish.vy = 0;
      }

      // Vertical wander, fully decoupled from the horizontal steering above.
      fish.depthCooldown -= dt;
      if (fish.depthCooldown <= 0) {
        fish.depthTarget = 0.1 + Math.random() * 0.8;
        fish.depthCooldown = 90 + Math.random() * 150;
      }
      fish.depth += (fish.depthTarget - fish.depth) * 0.01 * dt;

      // Fade lifecycle: age drives the spawn fade-in; removing fish also
      // age their fade-out timer (see Fish.opacity).
      fish.age += dt;
      if (fish.removing) fish.removeAge += dt;
    }

    // Overlap resolution: a hard guarantee that fish bodies stay apart, on top of the soft forces above. Own grid, rebuilt since positions just moved.
    const CORRECTION_FRACTION = Math.min(1, 0.5 * dt);

    // Ceiling on how far this pass may move one fish per step — the one thing that can move a fish off its facing direction.
    const maxCorrection = this.options.maxSpeed * dt * 0.5;
    const maxCorrectionSq = maxCorrection * maxCorrection;
    for (let i = 0; i < this.fish.length; i++) {
      const f = this.fish[i];
      f.__gridIdx = i;
      f._corrX = 0;
      f._corrY = 0;
    }
    const overlapGrid = this.overlapGrid;
    overlapGrid.build(this.fish, OVERLAP_GRID_CELL_SIZE);

    for (const a of this.fish) {
      const acx = Math.floor(a.x / OVERLAP_GRID_CELL_SIZE);
      const acy = Math.floor(a.y / OVERLAP_GRID_CELL_SIZE);
      for (let gx = acx - 1; gx <= acx + 1; gx++) {
        for (let gy = acy - 1; gy <= acy + 1; gy++) {
          const bucket = overlapGrid.get(gridKey(gx, gy));
          if (!bucket) continue;
          for (const b of bucket) {
            if (b.__gridIdx <= a.__gridIdx) continue;

            const minDist =
              (a.length + b.length) * 0.5 * BODY_VISUAL_SCALE * OVERLAP_CLEARANCE;
            let dx = b.x - a.x;
            let dy = b.y - a.y;
            // Squared distance first — the pricier sqrt below only runs for pairs that actually overlap.
            const distSq = dx * dx + dy * dy;
            if (distSq >= minDist * minDist) continue;
            let dist = Math.sqrt(distSq);
            if (dist === 0) {
              // Exactly coincident — nudge along an arbitrary axis so there's a direction to push apart along.
              dx = 0.01;
              dy = 0;
              dist = 0.01;
            }
            // Accumulated, not applied immediately, so the pass is order-independent.
            const push = ((minDist - dist) / dist) * CORRECTION_FRACTION * 0.5;
            a._corrX -= dx * push;
            a._corrY -= dy * push;
            b._corrX += dx * push;
            b._corrY += dy * push;
          }
        }
      }
    }

    // Apply each fish's accumulated correction (clamped to maxCorrection so a fish deep
    // in a crowd is nudged rather than thrown), then check its finalized position against
    // the exit line — one pass, since neither step reads any other fish's state.
    const exitX = this.bounds.width + 40;
    let anyFaded = false;
    this.exitedLastStep = 0;
    for (const f of this.fish) {
      let cx = f._corrX;
      let cy = f._corrY;
      if (cx !== 0 || cy !== 0) {
        const magSq = cx * cx + cy * cy;
        if (magSq > maxCorrectionSq) {
          const scale = maxCorrection / Math.sqrt(magSq);
          cx *= scale;
          cy *= scale;
        }
        f.x += cx;
        f.y += cy;
      }

      // Fish past the right edge finished their run; `!removing` guard stops a fading fish being counted repeatedly.
      if (f.x > exitX && !f.removing) {
        this.remove(f);
        this.exitedLastStep++;
      }
      if (f.removing && f.removeAge >= REMOVE_FADE_FRAMES) anyFaded = true;
    }

    // Guarded like finalizeRemovals() — skip the rebuild on the common frame where nothing finished fading.
    this._pruneFish(
      anyFaded,
      (f) => f.removing && f.removeAge >= REMOVE_FADE_FRAMES,
    );
  }
}
