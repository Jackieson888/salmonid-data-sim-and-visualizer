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
// resolution) each run through a spatial grid (see SpatialGrid) rather
// than a straight all-pairs scan — a straight O(n^2) scan is what made a
// few thousand fish visibly stall the sim; gridding keeps each fish's
// neighbor search down to roughly the fish actually near it.

const SPAWN_FADE_FRAMES = 24;

// Exported because the renderer has to size its instance capacity to cover
// fish that are still in the array mid-fade-out on top of the live
// population — see FISH_RENDER_HEADROOM in main.js.
export const REMOVE_FADE_FRAMES = 24;

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
// Exported for the fish viewer's field-guide card (src/inspect.js), which
// wants the real range rather than one jittered instance's fish.length.
export const SPECIES_LENGTH_INCHES = {
  shad: [12, 20],
  jackChinook: [12, 20],
  chinook: [30, 44],
  steelhead: [24, 32],
  // Adult Pacific lamprey (Entosphenus tridentatus) returning to spawn —
  // shorter than a steelhead on average, but a wide range since some of the
  // run is still growing toward its full anadromous size.
  lamprey: [18, 27],
};
const DEFAULT_LENGTH_INCHES = [30, 35];

// A fish's rendered nose-to-tail body length in world units is
// `fish.length * BODY_VISUAL_SCALE`. Flock.step's overlap-resolution pass uses
// this to keep the boid-space minimum distance between fish tied to how big
// they actually render, instead of an arbitrary boid-space number that has no
// relation to the mesh size.
//
// Exported (and imported by fishMesh.js, which scales the mesh by it) because
// the sim and the renderer have to agree on this exactly: they used to declare
// it separately as BODY_VISUAL_SCALE and VISUAL_SCALE, two copies of 2.4 that
// nothing stopped from drifting apart. It lives here because the sim owns
// `fish.length`, which is the thing it scales.
export const BODY_VISUAL_SCALE = 2.4;

// Fraction of the world-space "how much are these two fish's bodies
// overlapping" that counts as too close and gets corrected each frame — see
// the overlap-resolution pass at the end of step(). Kept well under 1 (full
// body length) since fish are thin and mostly swim roughly nose-to-tail with
// their neighbors; a full-length clearance would read as a school too
// sparse to look like a school.
const OVERLAP_CLEARANCE = 0.4;

// Cell size for the overlap-resolution pass's spatial grid (see
// SpatialGrid/gridKey below) — must be >= the largest possible minDist
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
//
// Reuses its Map and its bucket arrays between frames rather than allocating
// fresh ones. The previous shape built `new Map()` plus one `[]` per occupied
// cell, twice per step() — several hundred short-lived arrays a frame at the
// population cap, all of them garbage a millisecond later. That is exactly the
// allocation pattern that turns into a visible periodic hitch on a phone,
// where the GC has far less headroom to hide in. The pool converges on the
// high-water mark of occupied cells within a second or two of running and
// then allocates nothing at all.
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

    // Release fish references held by buckets the pool no longer hands out.
    // Without this, a flock that shrinks leaves the tail of the pool pinning
    // Fish objects that are otherwise dead — a slow leak that only shows up
    // after a long session, which is the worst kind to go looking for.
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
    // Which of the five DART species (see data.js) this fish represents —
    // the renderer (fishMesh.js) reads this to pick the species' own model
    // (or, for jackChinook, the adult chinook model plus a tint — see
    // SPECIES_MODEL_URL/SPECIES_COLORS there).
    this.species = species;
    // Mostly rightward (downstream) with some spread, so a freshly spawned
    // fish already reads as part of the flow instead of facing any which way.
    const angle = (Math.random() - 0.5) * Math.PI * 0.5;
    const speed = 1 + Math.random() * 0.5;
    this.vx = Math.cos(angle) * speed;
    this.vy = Math.sin(angle) * speed;
    // Per-fish variation so the school doesn't look uniform/robotic, sized to
    // this species' real-world length range (see SPECIES_LENGTH_INCHES).
    const [minLength, maxLength] =
      SPECIES_LENGTH_INCHES[species] ?? DEFAULT_LENGTH_INCHES;
    this.length = minLength + Math.random() * (maxLength - minLength);
    this.wobblePhase = Math.random() * Math.PI;

    // Per-fish swim variation, read by the renderer (see fishMesh.js
    // update()). Both are fixed for the fish's whole life — this is
    // individual variation between fish, not a per-frame effect.
    //
    // swimRate multiplies the tailbeat rate the renderer derives from this
    // fish's actual speed (see STRIDE_LENGTH in fishMesh.js); swimAmplitude
    // scales how far the baked clip bends the body (aAmplitude, 1 = exactly
    // as authored). Every fish in a species otherwise plays one identical
    // clip, and a school where all of them beat at exactly the same frequency
    // reads as cloned however well their phases are spread — differing rates
    // make the relative phases drift continuously instead of holding a fixed
    // pattern. Ranges are deliberately narrow: these should read as individual
    // variation within a species, not blur the frequency gap that
    // distinguishes one species from another.
    this.swimRate = 0.88 + Math.random() * 0.24;
    this.swimAmplitude = 0.85 + Math.random() * 0.3;

    // Position within the current tailbeat cycle, in [0, 1). Advanced by the
    // renderer each frame (see fishMesh.js's update()) at a rate derived from
    // this fish's speed, and wrapped there rather than allowed to accumulate:
    // the shader only ever reads fract() of it, so an ever-growing integer
    // part is pure float32 precision loss in the aCyclePos attribute.
    //
    // Declared here rather than materialized on the fish by the renderer, so
    // every Fish has the same shape from birth. Starts at 0 for every fish —
    // the school's phase spread comes from wobblePhase above (aPhase in the
    // shader), not from where each fish starts in the cycle.
    this.swimCyclePos = 0;

    // Vertical wander: eases toward a randomly re-picked target depth,
    // occasionally retargeting, so fish drift up and down the water column
    // on their own independent timers instead of all bobbing in lockstep.
    this.depth = 0.2 + Math.random() * 0.6;
    this.depthTarget = this.depth;
    this.depthCooldown = 60 + Math.random() * 150;

    // Body pitch, in radians, maintained by the renderer (see PITCH_SMOOTHING
    // in fishMesh.js). Lives here rather than being materialized on the fish
    // by the renderer for the same reason swimCyclePos above does: every Fish
    // should have the same shape from birth, so a fish's first rendered frame
    // isn't also the frame its hidden class changes. Starts level.
    this.pitch = 0;

    // Scratch written once per frame by the renderer's partition pass
    // (fishMesh.js) — this fish's squared XZ distance from the camera, shared
    // between the back-to-front sort, the distance cull and the per-species
    // depth ranking so none of them recompute it. Declared here for the shape
    // reason above; the value is meaningless until the renderer has run.
    this._camDistSq = 0;

    // Index into Flock.fish for the current step, tagged by step()'s overlap
    // pass so a pair found from both ends is only corrected once. Same shape
    // reasoning again — this used to be assigned onto the fish mid-step, so
    // every newly spawned fish took a hidden-class transition on its first
    // one, which is precisely the population that is largest on a busy day.
    this.__gridIdx = 0;

    // This step's accumulated overlap correction, summed across every
    // overlapping neighbour and applied (clamped) at the end of step(). See
    // the overlap-resolution pass for why it accumulates rather than moving
    // the fish on the spot.
    this._corrX = 0;
    this._corrY = 0;

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

    // Fish that crossed the exit line on the most recent step(). Read by
    // main.js's population pacing, which spawns replacements upstream at the
    // rate fish are leaving downstream so the run always has something
    // swimming in — see the replacement term there for why that matters.
    this.exitedLastStep = 0;

    // The two grids step() rebuilds each frame, held across frames so their
    // bucket pools survive (see SpatialGrid). Separate instances because they
    // use different cell sizes and are both live at once.
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

  // Doesn't delete the fish immediately — flags it to fade out over
  // REMOVE_FADE_FRAMES (see Fish.opacity); step() drops it from the array
  // once that fade finishes. Safe to call more than once on the same fish.
  remove(fish) {
    if (fish.removing) return;
    fish.removing = true;
    fish.removeAge = 0;
    this._activeCount--;
  }

  // Count of fish that are logically still part of the run — excludes ones
  // already fading out after remove(). Population-target math (main.js)
  // uses this instead of fish.length so a pending fade-out doesn't get
  // double-counted or cause a removal loop to spin forever waiting for
  // fish that are already flagged to disappear.
  //
  // Maintained incrementally rather than recounted. It is read every frame by
  // the population pacing (and again by the debug panel when it is open), and
  // an O(n) walk of the whole flock to answer a question that only changes by
  // one at a time is a scan the frame does not need. spawn() and remove() are
  // the only two things that can move it — the array filters in step() and
  // finalizeRemovals() drop only fish already flagged `removing`, which by
  // definition are not counted here.
  activeCount() {
    return this._activeCount;
  }

  // Flags up to `n` not-yet-removing fish to fade out, in array order.
  //
  // Exists so a caller draining the population to a target (main.js's
  // jumpToDay) can do it in one pass. The obvious loop —
  // `while (activeCount() > target) remove(fish.find(f => !f.removing))` —
  // is quadratic twice over: activeCount() rescans the whole array per
  // iteration, and find() restarts from index 0 each time, so every removal
  // re-walks the run of already-flagged fish ahead of it. This walks the
  // array once with a cursor instead.
  //
  // Measured on the worst case (one jump from empty straight to the cap and
  // back down, i.e. clicking the slider onto the Chinook peak): 8.0ms before,
  // 0.37ms after. Half a frame is a hitch rather than a stall at today's
  // MAX_POPULATION — but the old shape degrades quadratically, so the same
  // jump at 5000 fish was 148ms, and that is what this keeps off the table if
  // the cap ever rises.
  removeActive(n) {
    for (let i = 0; i < this.fish.length && n > 0; i++) {
      const fish = this.fish[i];
      if (fish.removing) continue;
      this.remove(fish);
      n--;
    }
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
    // SpatialGrid). Rebuilt fresh each step since fish move every
    // frame; building it is itself only O(n), so this is still a huge win
    // over the O(n^2) full-flock scan it replaces once fish counts climb
    // into the thousands.
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
      // Math.sqrt(x*x + y*y) rather than Math.hypot(x, y), here and in the two
      // speed clamps below. hypot() is specified to avoid intermediate
      // overflow/underflow, which it pays for with a scaling pass that makes it
      // several times slower in V8 — and these are plain screen-space
      // magnitudes in the low hundreds, nowhere near the range that protection
      // exists for. Three of these run per fish per frame.
      const forceMag = Math.sqrt(ax * ax + ay * ay);
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

      // Track the low-passed speed the renderer drives tailbeat rate from
      // (see Fish.smoothSpeed). Done here, after both speed clamps above, so
      // it reflects the speed actually applied to position below rather than
      // the pre-clamp value.
      fish.smoothSpeed +=
        (Math.sqrt(fish.vx * fish.vx + fish.vy * fish.vy) - fish.smoothSpeed) *
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
    // Own spatial grid (see SpatialGrid), built fresh here rather than
    // reused from above — positions just moved during the flocking pass
    // above, and this pass needs a smaller cell size anyway (see
    // OVERLAP_GRID_CELL_SIZE) since it only cares about actual near-touching
    // pairs, not the whole flocking-force neighborhood.
    //
    // __gridIdx tags each fish with its index in this.fish for this pass
    // only, so a pair found while scanning fish A's cells and again while
    // scanning fish B's is only corrected once (mirrors the old i/j<i+1
    // O(n^2) loop this replaces) instead of twice as hard.
    //
    // Scaled by dt, like every other rate in this function. Without it the
    // correction moved a fixed fraction of the overlap per rendered FRAME
    // rather than per unit of simulated time, so its strength — and with it
    // how hard a crowded school jitters — depended on the display's refresh
    // rate. Clamped at 1 because this is a fraction of the remaining overlap:
    // past 1 a long step would overshoot and push the pair apart through each
    // other rather than merely resolving the overlap.
    const CORRECTION_FRACTION = Math.min(1, 0.5 * dt);

    // Ceiling on how far this pass may move one fish in a single step, as a
    // fraction of how far it swims in that step.
    //
    // The corrections below are applied to POSITION and not to velocity, so
    // they are the one thing in the sim that can move a fish in a direction it
    // isn't facing — the rendered heading comes from atan2(vx, vy), which
    // doesn't follow. A little of that is invisible and is the point. But a
    // fish in a dense knot accumulates a push from every overlapping neighbour
    // within the same step, each using the position the last one just wrote,
    // and the sum could exceed its actual swimming motion and reverse
    // direction between frames — which read as fish twitching sideways in
    // place rather than swimming. Capping the total keeps the correction a
    // nudge on top of the motion instead of a substitute for it.
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
            // Accumulated rather than applied straight to the position.
            //
            // Two reasons, both about jitter. It lets the per-fish total be
            // capped below (see maxCorrection). And it makes the pass
            // simultaneous: every pair is now measured against the positions
            // the flocking step left, instead of each correction being applied
            // on top of whatever the previous pair just did to the same fish.
            // The sequential version made a fish's displacement depend on the
            // arbitrary order its neighbours happened to sit in the grid
            // buckets, which changes frame to frame — so a stable knot of fish
            // got a different shove every step for no reason the eye could
            // attribute to anything.
            const push = ((minDist - dist) / dist) * CORRECTION_FRACTION * 0.5;
            a._corrX -= dx * push;
            a._corrY -= dy * push;
            b._corrX += dx * push;
            b._corrY += dy * push;
          }
        }
      }
    }

    // Apply the accumulated corrections, each clamped to maxCorrection so a
    // fish deep in a crowd is nudged rather than thrown.
    for (const f of this.fish) {
      let cx = f._corrX;
      let cy = f._corrY;
      if (cx === 0 && cy === 0) continue;
      const magSq = cx * cx + cy * cy;
      if (magSq > maxCorrectionSq) {
        const scale = maxCorrection / Math.sqrt(magSq);
        cx *= scale;
        cy *= scale;
      }
      f.x += cx;
      f.y += cy;
    }

    // River flow-through: fish that cross the right edge have finished
    // their run — flag them to fade out (see remove()) rather than
    // wrapping back to the start or vanishing outright. The same pass notes
    // whether anything has finished fading, so the filter below can be
    // skipped entirely on the (common) frames where nothing has.
    const exitX = this.bounds.width + 40;
    let anyFaded = false;
    this.exitedLastStep = 0;
    for (const fish of this.fish) {
      // The `!removing` guard is what makes the tally a count of *this*
      // step's departures rather than of everything still mid-fade: a fish
      // sits past exitX for the whole REMOVE_FADE_FRAMES of its fade-out, so
      // without it the same departure would be counted ~24 times over.
      if (fish.x > exitX && !fish.removing) {
        this.remove(fish);
        this.exitedLastStep++;
      }
      if (fish.removing && fish.removeAge >= REMOVE_FADE_FRAMES) anyFaded = true;
    }

    // Finalize: drop any fish whose fade-out has fully played out. Guarded
    // because an unconditional filter() rebuilds the whole (up to ~1200
    // entry) array every single frame just to hand back the same contents —
    // same reason finalizeRemovals() guards its own filter.
    if (anyFaded) {
      this.fish = this.fish.filter(
        (f) => !(f.removing && f.removeAge >= REMOVE_FADE_FRAMES),
      );
    }
  }
}
