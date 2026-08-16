// boids.js
// Classic Reynolds flocking (separation, alignment, cohesion) with a few
// fish-specific additions: a gentle downstream drift, current drag, and
// edge steering so the school stays inside the open rectangular channel.
// The run flows left to right: fish are spawned near the left edge (see
// main.js) and exit once they cross the right edge (see Flock.step).
//
// Depth (fish.depth, 0 = surface .. 1 = riverbed) is a second, independent
// wandering process — cosmetic only, never read by the horizontal flocking
// forces — that drives the 3D renderer's vertical swim position (see
// scene/fishMesh.js) so fish visibly cruise up and down through the water
// column instead of skimming a fixed depth.
//
// Fish don't pop in/out: `opacity` ramps 0->1 over their first
// SPAWN_FADE_FRAMES frames of life, and Flock.remove() doesn't delete a
// fish immediately — it flags it `removing` and Flock.step() fades its
// opacity 1->0 over REMOVE_FADE_FRAMES before actually dropping it from
// the array. The renderer (fishMesh.js) reads `fish.opacity` each frame.
//
// Flock.step()'s two neighbor searches (flocking forces, then overlap
// resolution) each run through a spatial grid (see buildSpatialGrid) rather
// than a straight all-pairs scan — a straight O(n^2) scan is what made a
// few thousand fish visibly stall the sim; gridding keeps each fish's
// neighbor search down to roughly the fish actually near it.

const SPAWN_FADE_FRAMES = 24;
const REMOVE_FADE_FRAMES = 24;

// Per-frame blend factor for Fish.smoothSpeed's exponential moving average
// (see the constructor). ~0.03 gives a time constant of roughly 33 frames,
// about half a second at 60fps — long enough to swallow per-frame steering
// jitter, short enough that a fish visibly picks up its tailbeat within a
// stroke or two of actually accelerating.
const SPEED_SMOOTHING = 0.03;

// Real-world nose-to-tail length range per species, in inches (DART species —
// see data.js/fishMesh.js SPECIES_MODEL_URL). fish.length uses these values
// directly as sim units: the sim's pre-existing flat default (30 + rand*5)
// already sat almost exactly inside the Steelhead range below, so 1 sim unit
// == 1 inch rather than needing its own separate scale factor.
const SPECIES_LENGTH_INCHES = {
  shad: [12, 20],
  jackChinook: [12, 20],
  chinook: [30, 44],
  steelhead: [24, 32],
};
const DEFAULT_LENGTH_INCHES = [30, 35];

// Matches fishMesh.js's VISUAL_SCALE: a fish's rendered nose-to-tail body
// length in world units is `fish.length * BODY_VISUAL_SCALE`. Flock.step's
// overlap-resolution pass uses this to keep the boid-space minimum distance
// between fish tied to how big they actually render, instead of an
// arbitrary boid-space number that has no relation to the mesh size.
const BODY_VISUAL_SCALE = 2.4;

// Fraction of the world-space "how much are these two fish's bodies
// overlapping" that counts as too close and gets corrected each frame — see
// the overlap-resolution pass at the end of step(). Kept well under 1 (full
// body length) since fish are thin and mostly swim roughly nose-to-tail with
// their neighbors; a full-length clearance would read as a school too
// sparse to look like a school.
const OVERLAP_CLEARANCE = 0.4;

// Cell size for the overlap-resolution pass's spatial grid (see
// buildSpatialGrid/gridKey below) — must be >= the largest possible minDist
// between two fish, (44 + 44) * 0.5 * BODY_VISUAL_SCALE * OVERLAP_CLEARANCE
// ≈ 42.2 at the top of the largest species' range (Chinook, see
// SPECIES_LENGTH_INCHES), so 48 leaves comfortable headroom without making
// cells so large that too many irrelevant fish share one. Deliberately
// smaller than perceptionRadius (the flocking pass's grid cell size, set
// per-Flock in the constructor below) since it only needs to catch actual
// near-touching pairs, not the whole flocking neighborhood.
const OVERLAP_GRID_CELL_SIZE = 48;

// Packs a grid cell's (cx, cy) into a single Map key without allocating a
// string per lookup. Safe as long as cy always fits in [0, GRID_KEY_SCALE) —
// true here because fish.y is always clamped to [0, bounds.height] by the
// end of step() (see the hard clamp below), so cy = floor(y / cellSize) is
// always small and non-negative; cx may be negative (fish spawn slightly
// left of x=0) and that's fine, this is just a mixed-radix encoding.
const GRID_KEY_SCALE = 1 << 20;

function gridKey(cx, cy) {
  return cx * GRID_KEY_SCALE + cy;
}

// Buckets `fish` by which cellSize x cellSize cell they fall in. Callers
// then only need to scan a fish's own cell plus its 8 neighbors (see
// step()) instead of the whole flock — the difference between O(n^2) and
// roughly O(n) per frame once fish counts climb into the thousands, since a
// cell's bucket only holds the handful of fish actually near it rather than
// every fish in the sim. Requires cellSize >= the largest radius any caller
// will query with with this grid, so that neighborhood is guaranteed to be
// found within one cell step in either axis.
function buildSpatialGrid(fish, cellSize) {
  const grid = new Map();
  for (const f of fish) {
    const key = gridKey(Math.floor(f.x / cellSize), Math.floor(f.y / cellSize));
    let bucket = grid.get(key);
    if (bucket === undefined) grid.set(key, (bucket = []));
    bucket.push(f);
  }
  return grid;
}

export class Fish {
  constructor(x, y, bounds, species = "steelhead") {
    this.x = x;
    this.y = y;
    // Which of the four DART species (see data.js) this fish represents —
    // the renderer (fishMesh.js) reads this to tint the shared steelhead
    // mesh per species until species-specific models exist.
    this.species = species;
    // Mostly rightward (downstream) with some spread, so a freshly spawned
    // fish already reads as part of the flow instead of facing any which way.
    const angle = (Math.random() - 0.5) * Math.PI * 0.5;
    const speed = 1 + Math.random() * 0.5;
    this.vx = Math.cos(angle) * speed;
    this.vy = Math.sin(angle) * speed;
    this.bounds = bounds;
    // Per-fish variation so the school doesn't look uniform/robotic, sized to
    // this species' real-world length range (see SPECIES_LENGTH_INCHES).
    const [minLength, maxLength] =
      SPECIES_LENGTH_INCHES[species] ?? DEFAULT_LENGTH_INCHES;
    this.length = minLength + Math.random() * (maxLength - minLength);
    this.wobblePhase = Math.random() * Math.PI * 1;

    // Per-fish swim variation, read by the renderer (see fishMesh.js
    // update()). Both are fixed for the fish's whole life — this is
    // individual variation between fish, not a per-frame effect.
    //
    // swimRate multiplies this species' tailbeat frequency
    // (SPECIES_SWIM_HZ); swimAmplitude scales how far the baked clip bends
    // the body (aAmplitude, 1 = exactly as authored). Every fish in a
    // species otherwise plays one identical clip, and a school where all of
    // them beat at exactly the same frequency reads as cloned however well
    // their phases are spread — differing rates make the relative phases
    // drift continuously instead of holding a fixed pattern. Ranges are
    // deliberately narrow: these should read as individual variation within
    // a species, not blur the frequency gap that distinguishes one species
    // from another.
    this.swimRate = 0.88 + Math.random() * 0.24;
    this.swimAmplitude = 0.85 + Math.random() * 0.3;

    // Vertical wander: eases toward a randomly re-picked target depth,
    // occasionally retargeting, so fish drift up and down the water column
    // on their own independent timers instead of all bobbing in lockstep.
    this.depth = 0.2 + Math.random() * 0.6;
    this.depthTarget = this.depth;
    this.depthCooldown = 60 + Math.random() * 150;

    // Fade in/out lifecycle — see file header. `age` drives the fade-in;
    // `removing`/`removeAge` drive the fade-out once Flock.remove() flags it.
    this.age = 0;
    this.removing = false;
    this.removeAge = 0;

    // Low-passed swim speed, maintained in Flock.step() below and read by
    // the renderer to set this fish's tailbeat rate (see fishMesh.js).
    //
    // Deliberately NOT the raw `speed` getter. Flocking forces change a
    // fish's velocity abruptly frame to frame — a neighbor crossing its
    // separation radius can swing it noticeably in one step — and driving a
    // tailbeat straight off that reads as a rigid, hitching fish rather than
    // a swimming one. A real fish's tailbeat doesn't stutter every time it
    // adjusts course. Averaging over roughly half a second of frames keeps
    // the genuine accelerations (a day's speed multiplier changing, a fish
    // working out of a crowd) while discarding the steering noise on top.
    this.smoothSpeed = Math.hypot(this.vx, this.vy);
  }

  get speed() {
    return Math.hypot(this.vx, this.vy);
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
    const fish = new Fish(x, y, this.bounds, species);
    this.fish.push(fish);
    return fish;
  }

  // Doesn't delete the fish immediately — flags it to fade out over
  // REMOVE_FADE_FRAMES (see Fish.opacity); step() drops it from the array
  // once that fade finishes. Safe to call more than once on the same fish.
  remove(fish) {
    if (fish.removing) return;
    fish.removing = true;
    fish.removeAge = 0;
  }

  // Count of fish that are logically still part of the run — excludes ones
  // already fading out after remove(). Population-target math (main.js)
  // uses this instead of fish.length so a pending fade-out doesn't get
  // double-counted or cause a removal loop to spin forever waiting for
  // fish that are already flagged to disappear.
  activeCount() {
    let n = 0;
    for (const fish of this.fish) if (!fish.removing) n++;
    return n;
  }

  // Immediately drops any fish still mid-fade-out from a previous remove(),
  // skipping the rest of their fade. Without this, a hard resync (see
  // main.js's jumpToDay) that fires faster than step() can finish fading
  // fish out — e.g. a fast timeline-scrub drag — would let already-flagged
  // fish pile up in the array on every call instead of ever finishing,
  // growing step()'s per-frame cost with them until the whole page stalls.
  // Called at the start of a fresh jump so at most one jump's worth of
  // fades is ever pending, no matter how fast jumps arrive.
  finalizeRemovals() {
    if (this.fish.some((f) => f.removing)) {
      this.fish = this.fish.filter((f) => !f.removing);
    }
  }

  setBounds(bounds) {
    this.bounds = bounds;
  }

  step(dt = 1) {
    const { perceptionRadius, separationRadius } = this.options;
    const perceptionSq = perceptionRadius * perceptionRadius;
    const separationSq = separationRadius * separationRadius;

    // Spatial grid sized to perceptionRadius — the largest radius queried
    // below — so the 3x3-cell neighborhood scanned per fish is guaranteed to
    // contain every other fish within perceptionRadius (see
    // buildSpatialGrid). Rebuilt fresh each step since fish move every
    // frame; building it is itself only O(n), so this is still a huge win
    // over the O(n^2) full-flock scan it replaces once fish counts climb
    // into the thousands.
    const grid = buildSpatialGrid(this.fish, perceptionRadius);

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
        ax += (avgVx - fish.vx) * 0.05 * this.options.alignmentWeight;
        ay += (avgVy - fish.vy) * 0.05 * this.options.alignmentWeight;
      }
      // Cohesion: steer toward the neighborhood's average position, so the
      // school stays loosely grouped instead of drifting apart.
      if (cohCount > 0) {
        const cx = cohX / cohCount,
          cy = cohY / cohCount;
        ax += (cx - fish.x) * 0.0005 * this.options.cohesionWeight;
        ay += (cy - fish.y) * 0.0005 * this.options.cohesionWeight;
      }

      // Gentle downstream bias — the run flows left (spawn) to right (exit).
      ax += this.options.flowWeight * 0.01;

      // Current drag: a slow lateral drift, like river current pushing back
      ay += Math.sin(fish.x * 0.002) * this.options.currentWeight * 0.01;

      // Clamp steering force so no single frame can yank a fish's heading
      // around too sharply, regardless of how strong the combined flocking
      // forces are.
      const forceMag = Math.hypot(ax, ay);
      const maxForce = this.options.maxForce;
      if (forceMag > maxForce) {
        ax = (ax / forceMag) * maxForce;
        ay = (ay / forceMag) * maxForce;
      }

      // Steer away from the top/bottom edges and the left spawn edge. The
      // right edge is intentionally left open so fish can exit downstream.
      // Applied *after* the flocking clamp above (with its own separate
      // headroom) rather than folded into it — otherwise a fish whose
      // maxForce budget is already spent on separation/cohesion has nothing
      // left to steer away from a wall with, doesn't turn in time, and hits
      // the hard clamp below hard enough to visibly snap. Scaled by how far
      // into the margin the fish has drifted (0 at the margin line, full
      // strength at the wall) so the push ramps up smoothly instead of
      // switching on at a fixed strength the instant the fish crosses the
      // margin.
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
      const speed = Math.hypot(fish.vx, fish.vy);
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

      // Track the low-passed speed the renderer drives tailbeat rate from
      // (see Fish.smoothSpeed). Done here, after both speed clamps above, so
      // it reflects the speed actually applied to position below rather than
      // the pre-clamp value.
      fish.smoothSpeed +=
        (Math.hypot(fish.vx, fish.vy) - fish.smoothSpeed) *
        Math.min(1, SPEED_SMOOTHING * dt);

      // Integrate: apply velocity to position.
      fish.x += fish.vx * dt;
      fish.y += fish.vy * dt;

      // Hard clamp: even though the steering above discourages it, flocking
      // forces can still push a fish past the top/bottom edge. Stops the
      // outward velocity component rather than reversing it — a full bounce
      // flips fish.vy's sign, which flips the rendered heading
      // (atan2(vx, vy) in fishMesh.js) almost instantly and reads as the
      // fish snapping/jumping in place. Zeroing it just holds the fish at
      // the wall for a frame while the edge steering above (recomputed
      // fresh next frame, now at maximum strength right at the boundary)
      // eases it back in.
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

    // Overlap resolution: a hard guarantee that fish bodies stay apart,
    // independent of however the separation/cohesion forces above happen to
    // balance out. Those forces are a soft preference — cohesion pulling a
    // crowded school inward can settle into a steady state where separation
    // just isn't winning by enough, and the two fish's meshes visibly clip.
    // Only a fraction of each pair's overlap is corrected per frame (not all
    // of it at once) so a pair that ends up overlapping eases apart smoothly
    // over a few frames instead of visibly popping to new positions.
    //
    // Own spatial grid (see buildSpatialGrid), built fresh here rather than
    // reused from above — positions just moved during the flocking pass
    // above, and this pass needs a smaller cell size anyway (see
    // OVERLAP_GRID_CELL_SIZE) since it only cares about actual near-touching
    // pairs, not the whole flocking-force neighborhood.
    //
    // __gridIdx tags each fish with its index in this.fish for this pass
    // only, so a pair found while scanning fish A's cells and again while
    // scanning fish B's is only corrected once (mirrors the old i/j<i+1
    // O(n^2) loop this replaces) instead of twice as hard.
    const CORRECTION_FRACTION = 0.5;
    for (let i = 0; i < this.fish.length; i++) this.fish[i].__gridIdx = i;
    const overlapGrid = buildSpatialGrid(this.fish, OVERLAP_GRID_CELL_SIZE);

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
            // Compare squared distance first so the (much pricier) sqrt
            // below only runs for pairs that actually overlap — the common
            // case even within the 3x3-cell neighborhood, since
            // OVERLAP_GRID_CELL_SIZE is deliberately a bit larger than any
            // real minDist.
            const distSq = dx * dx + dy * dy;
            if (distSq >= minDist * minDist) continue;
            let dist = Math.sqrt(distSq);
            if (dist === 0) {
              // Exactly coincident (e.g. two fish spawned on the same frame
              // at the same point) — nudge along an arbitrary axis so
              // there's a direction to push apart along.
              dx = 0.01;
              dy = 0;
              dist = 0.01;
            }
            const push = ((minDist - dist) / dist) * CORRECTION_FRACTION * 0.5;
            a.x -= dx * push;
            a.y -= dy * push;
            b.x += dx * push;
            b.y += dy * push;
          }
        }
      }
    }

    // River flow-through: fish that cross the right edge have finished
    // their run — flag them to fade out (see remove()) rather than
    // wrapping back to the start or vanishing outright.
    const exitX = this.bounds.width + 40;
    for (const fish of this.fish) {
      if (fish.x > exitX) this.remove(fish);
    }

    // Finalize: drop any fish whose fade-out has fully played out.
    this.fish = this.fish.filter((f) => !(f.removing && f.removeAge >= REMOVE_FADE_FRAMES));
  }
}
