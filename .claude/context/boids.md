# boids.js — flocking engine

Classic Reynolds flocking (separation, alignment, cohesion) plus fish-specific
additions: downstream drift, current drag, edge steering, a fade in/out
lifecycle, and an independent vertical "depth" wander. Physics is fully 2D
(`x`, `y`); only the renderer (`scene/fishMesh.js`) reinterprets those as
`worldX`/`worldZ`. The run flows left (spawn, see `main.js`) to right (exit,
see `Flock.step`).

## Depth is a second, independent process

`fish.depth` (0 = surface, 1 = riverbed) is cosmetic only — it is never read
by the horizontal flocking forces. It exists purely to drive the 3D
renderer's vertical swim position (`scene/fishMesh.js`) so fish visibly
cruise up and down the water column instead of skimming a fixed depth. It
eases toward a randomly re-picked target on its own independent timer
(`depthCooldown`), decoupled from everything else in `step()`, so fish don't
bob in lockstep.

## Fade lifecycle

Fish don't pop in or out. `opacity` ramps 0→1 over a fish's first
`SPAWN_FADE_FRAMES` frames of life. `Flock.remove()` doesn't delete a fish
immediately — it flags it `removing`, and `step()` fades its opacity 1→0
over `REMOVE_FADE_FRAMES` before actually dropping it from the array. The
renderer reads `fish.opacity` every frame. `REMOVE_FADE_FRAMES` is exported
because the renderer has to size its instance capacity to cover fish still
mid-fade-out on top of the live population (see `FISH_RENDER_HEADROOM` in
`main.js`).

## Why a spatial grid, not an all-pairs scan

`Flock.step()`'s two neighbor searches — flocking forces, then overlap
resolution — each run through a `SpatialGrid` rather than a straight O(n²)
scan. A straight all-pairs scan is what made a few thousand fish visibly
stall the sim; gridding keeps each fish's neighbor search down to roughly
the fish actually near it (close to O(n) once building the grid is counted).

**Two separate grid instances** (`flockGrid`, `overlapGrid`), held across
frames on the `Flock` so their bucket pools survive. They can't share one
grid: they use different cell sizes and are both live within the same
`step()` call.

- `flockGrid` is sized to `perceptionRadius` (55 by default) — the largest
  radius queried in the flocking pass — so the 3×3-cell neighborhood scanned
  per fish is guaranteed to contain every other fish within that radius.
- `overlapGrid` uses `OVERLAP_GRID_CELL_SIZE = 48`, deliberately smaller,
  since the overlap pass only needs to catch actual near-touching pairs, not
  the whole flocking neighborhood. 48 was chosen as the largest possible
  `minDist` between two fish — `(44 + 44) * 0.5 * BODY_VISUAL_SCALE *
  OVERLAP_CLEARANCE ≈ 42.2` at the top of the largest species' range
  (Chinook, see `SPECIES_LENGTH_INCHES`) — with comfortable headroom, without
  making cells so large that too many irrelevant fish share one.

Both grids require `cellSize >= the largest radius any caller queries with`,
so the queried neighborhood is guaranteed to be found within one cell step
in either axis.

**Key packing**: `gridKey(cx, cy)` packs a cell's coordinates into a single
`Map` key (`cx * GRID_KEY_SCALE + cy`) instead of allocating a string per
lookup. Safe because `cy` is always clamped into `[0, bounds.height]` by the
end of `step()` (the hard clamp), so `cy` is always small and non-negative;
`cx` may be negative (fish spawn slightly left of x=0), which the mixed-radix
encoding tolerates fine.

**Pooling**: `SpatialGrid` reuses its `Map` and its bucket arrays between
frames rather than allocating fresh ones. The previous shape built a new
`Map` plus one `[]` per occupied cell, twice per `step()` — several hundred
short-lived arrays a frame at the population cap, all garbage a millisecond
later. That's exactly the allocation pattern that turns into a visible
periodic hitch on a phone, where the GC has far less headroom to hide in.
The pool converges on the high-water mark of occupied cells within a second
or two and then allocates nothing at all. `build()` also releases fish
references held by buckets the pool no longer hands out — without that, a
flock that shrinks leaves the tail of the pool pinning dead `Fish` objects,
a slow leak that only shows up after a long session (the worst kind to find).

## Constants

- `SPEED_SMOOTHING = 0.03` — per-frame EMA blend factor for
  `Fish.smoothSpeed`. Gives a time constant of roughly 33 frames, about half
  a second at 60fps: long enough to swallow per-frame steering jitter, short
  enough that a fish visibly picks up its tailbeat within a stroke or two of
  actually accelerating.
- `SPECIES_LENGTH_INCHES` — real-world nose-to-tail length range per DART
  species (see `data.js`/`fishMesh.js`'s `SPECIES_MODEL_URL`), in inches.
  `fish.length` uses these values directly as sim units: the sim's
  pre-existing flat default (`30 + rand*5`) already sat almost exactly
  inside the Steelhead range, so 1 sim unit == 1 inch rather than needing a
  separate scale factor. Exported for the fish viewer's field-guide card
  (`src/inspect.js`), which wants the real range rather than one jittered
  instance's `fish.length`.
- `BODY_VISUAL_SCALE = 2.4` — a fish's rendered nose-to-tail length in world
  units is `fish.length * BODY_VISUAL_SCALE`. Exported and imported by
  `fishMesh.js` (which scales the mesh by it) because the sim and renderer
  must agree on this exactly: they used to declare it separately as
  `BODY_VISUAL_SCALE` and `VISUAL_SCALE`, two copies of 2.4 nothing stopped
  from drifting apart. It lives here because the sim owns `fish.length`.
- `OVERLAP_CLEARANCE = 0.4` — fraction of two fish's body-length sum that
  counts as "too close." Kept well under 1 (full body length) since fish are
  thin and mostly swim roughly nose-to-tail with neighbors; a full-length
  clearance would read as a school too sparse to look like a school.

## Fish constructor — field notes

Most fields not used until a later frame are still declared in the
constructor, so every `Fish` has the same shape from birth (V8 hidden-class
stability). Several of these used to be assigned mid-step or by the
renderer on first use instead, which meant every newly spawned fish took a
hidden-class transition on its first touch — precisely the population
that's largest on a busy day. This applies to `swimCyclePos`, `pitch`,
`_camDistSq`, `__gridIdx`, and `_corrX`/`_corrY`.

- Initial heading is mostly rightward (downstream) with some spread, so a
  freshly spawned fish already reads as part of the flow instead of facing
  any which way.
- `swimRate` / `swimAmplitude` — per-fish, fixed for life, read by the
  renderer (`fishMesh.js`'s `update()`). Every fish in a species plays one
  identical baked clip; a school where all of them beat at exactly the same
  frequency reads as cloned however well their phases are spread. Differing
  rates make relative phases drift continuously instead of holding a fixed
  pattern. Ranges are deliberately narrow — individual variation within a
  species, not enough to blur the frequency gap that distinguishes species.
- `swimCyclePos` starts at 0 for every fish — the school's phase spread
  comes from `wobblePhase` (the shader's `aPhase`), not from where each fish
  starts in its cycle. Advanced and wrapped by the renderer each frame
  rather than left to accumulate, since the shader only reads `fract()` of
  it — an ever-growing integer part would be pure float32 precision loss in
  the `aCyclePos` attribute.
- `smoothSpeed` (low-passed swim speed, maintained in `Flock.step()`) is
  deliberately **not** the raw `speed` getter. Flocking forces change a
  fish's velocity abruptly frame to frame — a neighbor crossing its
  separation radius can swing it noticeably in one step — and driving a
  tailbeat straight off that reads as a rigid, hitching fish rather than a
  swimming one. Averaging over roughly half a second keeps genuine
  accelerations while discarding steering noise.

## Flock — population accounting

- `activeCount()` is maintained incrementally by `spawn()`/`remove()` rather
  than recounted, because it's read every frame by population pacing (and
  the debug panel). It excludes fish already fading out after `remove()`, so
  population-target math in `main.js` doesn't double-count a pending
  fade-out or spin a removal loop waiting on fish already flagged to
  disappear.
- `removeActive(n)` flags up to `n` not-yet-removing fish to fade out, in
  array order, in one pass. It exists because the obvious loop —
  `while (activeCount() > target) remove(fish.find(f => !f.removing))` — is
  quadratic twice over: `activeCount()` rescans the whole array per
  iteration, and `find()` restarts from index 0 each time, re-walking the
  run of already-flagged fish ahead of it on every removal. Measured on the
  worst case (one jump from empty straight to the cap and back down, i.e.
  clicking the timeline slider onto the Chinook peak): **8.0ms before, 0.37ms
  after**. The old shape degrades quadratically — the same jump at 5000 fish
  was 148ms — so this is what keeps that off the table if the population cap
  ever rises.
- `finalizeRemovals()` immediately drops any fish still mid-fade-out from a
  previous `remove()`, skipping the rest of their fade. Without this, a hard
  resync (`main.js`'s `jumpToDay`) firing faster than `step()` can finish
  fading fish out — e.g. a fast timeline-scrub drag — would let
  already-flagged fish pile up in the array on every call instead of ever
  finishing, growing `step()`'s per-frame cost until the page stalls. Called
  at the start of a fresh jump so at most one jump's worth of fades is ever
  pending, no matter how fast jumps arrive.
- Both `finalizeRemovals()` and the end-of-`step()` cleanup filter are
  guarded (`if (this.fish.some(...))` / `if (anyFaded)`) because an
  unconditional `filter()` rebuilds the whole (up to ~1200-entry) array
  every frame just to hand back the same contents.

## step() — forces and integration

- Separation steers away from the inverse-distance-weighted average
  direction to nearby neighbors; alignment steers velocity toward the
  neighborhood's average velocity; cohesion steers toward the
  neighborhood's average position. Standard Reynolds terms, weighted by
  `options.separationWeight`/`alignmentWeight`/`cohesionWeight`.
- Steering force is clamped with `Math.sqrt(x*x + y*y)` rather than
  `Math.hypot(x, y)` — here and at both speed clamps below. `hypot()` is
  specified to avoid intermediate overflow/underflow, which it pays for with
  a scaling pass that makes it several times slower in V8. These are plain
  screen-space magnitudes in the low hundreds, nowhere near the range that
  protection exists for, and this runs three times per fish per frame.
- **Edge steering** (top/bottom margins, left spawn edge; the right edge is
  intentionally open so fish can exit downstream) is applied *after* the
  flocking force clamp, with its own separate headroom, rather than folded
  into it. Otherwise a fish whose `maxForce` budget is already spent on
  separation/cohesion has nothing left to steer away from a wall with,
  doesn't turn in time, and hits the hard clamp hard enough to visibly snap.
  It's scaled by how far into the margin the fish has drifted (0 at the
  margin line, full strength at the wall) so the push ramps up smoothly.
- **Hard clamp** at the actual top/bottom edge stops the outward velocity
  component rather than reversing it. A full bounce flips `fish.vy`'s sign,
  which flips the rendered heading (`atan2(vx, vy)` in `fishMesh.js`) almost
  instantly and reads as the fish snapping/jumping in place. Zeroing it just
  holds the fish at the wall for a frame while edge steering (recomputed
  fresh next frame, now at maximum strength right at the boundary) eases it
  back in.
- A minimum cruising speed (`maxSpeed * 0.4`) keeps fish from stalling.

## Overlap resolution

A hard guarantee that fish bodies stay apart, independent of however the
separation/cohesion forces happen to balance out — those are a soft
preference, and cohesion pulling a crowded school inward can settle into a
steady state where separation just isn't winning by enough, visibly clipping
two fish's meshes. Runs after the flocking pass, on its own grid (see
above), since positions just moved and this pass needs a smaller cell size.

- `__gridIdx` tags each fish with its index in `this.fish` for this pass
  only, so a pair found while scanning fish A's cells and again while
  scanning fish B's is corrected once, mirroring the old `i, j < i+1` O(n²)
  loop this replaces instead of doing the work twice.
- Corrections **accumulate** into `_corrX`/`_corrY` rather than applying
  straight to position, for two reasons: it lets the per-fish total be
  capped (`maxCorrection`), and it makes the pass simultaneous — every pair
  is measured against the positions the flocking step left, instead of each
  correction landing on top of whatever the previous pair just did to the
  same fish. The sequential version made a fish's displacement depend on the
  arbitrary order its neighbors happened to sit in the grid buckets, which
  changes frame to frame — a stable knot of fish got a different shove every
  step for no reason the eye could attribute to anything.
- `CORRECTION_FRACTION = Math.min(1, 0.5 * dt)` is scaled by `dt` like every
  other rate in `step()` — otherwise the correction moves a fixed fraction
  of the overlap per rendered *frame* rather than per unit of simulated
  time, so how hard a crowded school jitters would depend on display refresh
  rate. Clamped at 1 because this is a fraction of the *remaining* overlap:
  past 1, a long step would overshoot and push the pair through each other
  rather than resolving the overlap.
- `maxCorrection` caps how far this pass may move one fish in a single step,
  as a fraction of how far it swims in that step. These corrections are
  applied to *position*, not velocity, so they're the one thing in the sim
  that can move a fish in a direction it isn't facing (the rendered heading,
  `atan2(vx, vy)`, doesn't follow). A little of that is invisible and is the
  point, but a fish in a dense knot accumulates a push from every
  overlapping neighbor within the same step — each using the position the
  last one just wrote — and the sum could exceed its actual swimming motion
  and reverse direction between frames, reading as twitching in place rather
  than swimming. The cap keeps the correction a nudge on top of the motion
  instead of a substitute for it.
- Squared distance is compared before the (much pricier) `Math.sqrt` — the
  common case even within the 3×3-cell neighborhood, since
  `OVERLAP_GRID_CELL_SIZE` is deliberately a bit larger than any real
  `minDist`.
- Exactly-coincident fish (e.g. two spawned on the same frame at the same
  point) are nudged along an arbitrary axis (`dx = 0.01`) so there's a
  direction to push apart along.

## River flow-through

Fish that cross the right edge (`bounds.width + 40`) have finished their
run and are flagged to fade out via `remove()` rather than wrapping back to
the start or vanishing outright. The `!fish.removing` guard on the exit
check is what makes `exitedLastStep` a count of *that step's* departures
rather than of everything still mid-fade — a fish sits past `exitX` for the
whole `REMOVE_FADE_FRAMES` of its fade-out, so without the guard the same
departure would be counted roughly 24 times over. `exitedLastStep` is read
by `main.js`'s population pacing, which spawns replacements upstream at the
rate fish are leaving downstream so the run always has something swimming
in.

## See also

- `.claude/context/scene/fishMesh.md` — how the renderer consumes
  `fish.opacity`, `depth`, `smoothSpeed`, `swimCyclePos`, `pitch`, and
  `BODY_VISUAL_SCALE`.
- Root `CLAUDE.md` — "Rules that hold everywhere" restates the 2D-physics
  boundary between this file and the renderer.
