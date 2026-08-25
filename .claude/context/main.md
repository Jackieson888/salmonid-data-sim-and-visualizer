# main.js — orchestration, timeline, boot/lifecycle

`src/main.js` wires the whole river scene together: HUD readouts, the season
timeline and transport, the bounds-shaped 3D world (terrain/water/particles/
fish), the spawn-pacing simulation that keeps the flock's population honest
against real DART counts, and the boot/resize/context-loss lifecycle. Nothing
here is dimension-agnostic Canvas2D holdover except the timeline math, which
still only touches `flock.fish.length`/`bounds` and never rendering.

## Species keys (`SIMULATED_COUNT_KEYS` / `REPORTED_COUNT_KEYS`)

Five species actually swim: Chinook, Jack Chinook, Steelhead, Shad, Pacific
Lamprey (`SIMULATED_COUNT_KEYS`). These and only these sum to `#fish-count`,
matching `count` in `dart/parseAdultDaily.js` and the population the day
tables are built from.

Three more — sockeye, coho, jack coho — are counted at the dam and reported
in the HUD/plates but never swum (`REPORTED_COUNT_KEYS`). This is kept as a
**separate list rather than folded into one flat map**, and the separation is
load-bearing: the headline total is derived by summing the displayed species,
so merging all eight into one map would have silently started reporting
sockeye and coho as fish the simulation was showing.

## `showNotice` / `dismissLoadingOverlay`

`showNotice` surfaces a real failure to the viewer instead of only the
console. Kept deliberately small: this scene has exactly two things that can
fail in a way someone watching would notice and could act on — the fish
assets not loading, and an opted-in live data refresh not arriving — and both
are recoverable enough that "reload" is genuine advice rather than a shrug.

`dismissLoadingOverlay` fades the loading overlay out and removes it, but the
removal is **not** left to `transitionend` alone: that event does not fire at
all if the element is already at its target opacity, if the tab is
backgrounded when the class lands, or if a user agent honoring
`prefers-reduced-motion` zeroed the duration — and in every one of those cases
the overlay would sit there dimming the finished scene forever. The
`setTimeout(remove, 1200)` is the actual guarantee; the transition event just
makes it prompt.

`hideNotice()` mirrors that same guarantee-over-elegance choice for
`#notice`'s own exit (removes the `.shown` class, then defers the actual
`hidden = true` by a fixed timeout rather than trusting `transitionend`), and
`showNotice()`'s entrance is the reverse of the CSS gotcha `dismissLoadingOverlay`
sidesteps by never having to *un*hide from `display: none` in the first
place: unhiding and adding `.shown` in the same tick would let the browser
coalesce the two and skip the fade, so `showNotice()` unhides, forces a
reflow (`void noticeEl.offsetWidth`), then adds `.shown`. See
`.claude/context/ui.md` for the CSS side of both.

## HUD readouts (`setReadout`, `updateFishCountDisplay`, `writeMeasurement`)

`setReadout` guards the DOM write on the **rendered string**, not the value:
while playing, these are re-derived every frame, but the interpolation below
only crosses an integer every few frames, and an unchanged `textContent`
assignment still dirties layout.

`updateFishCountDisplay(idx, progress)` renders the HUD's counts "partway
through day `idx`", `progress` running 0 (start of day) to 1 (end of day).
Several things about it are load-bearing:

- These are the real per-day DART numbers, not `flock.activeCount()`: the
  simulated population is capped well below them for performance (see
  `maxPopulation()`), so the raw flock size is not what a viewer wants to
  read as "how many fish passed today."
- Figures tick between one day and the next **across** the day rather than
  snapping at the boundary, using the same linear interpolation
  `desiredPopulation()` uses to spawn fish in smoothly (including wrapping
  onto day 0 the same way), so the readout never disagrees with the school it
  describes. At progress 1 it is already showing tomorrow's figure, so when
  the day actually advances there is nothing left to jump.
- The total is **summed from the five displayed species** rather than
  interpolated on its own, so the column always adds up: `count` is exactly
  that sum in the source data (`parseDartCsv` in `data.js`), but rounding five
  interpolated values independently and a sixth separately would let them
  disagree by a digit or two mid-day. The `?? 0` guards keep this honest
  against a row missing a column — DART's column set has changed between
  years, so a future year could legitimately arrive without one of these.
- Only the simulated five are summed into the headline total; the three
  reported species are written to their own cells and deliberately left out
  of the total, so the headline keeps meaning "the run this scene is
  showing."
- `chinookRunLabel` snaps at the day boundary rather than interpolating —
  it's a label ("spring/summer/fall"), not a measurement.
- Outflow, spill and dissolved gas ride in on a separate river-environment
  file loaded after boot and are missing entirely for nine of the ten
  seasons — `riverConditionsByDate` stays empty until (and unless) it
  resolves, so those fields show "—" rather than reading zero.

`writeMeasurement(el, today, tomorrow, progress, digits, unit)` interpolates
one gauge reading across the day with strict null discipline: a blank cell in
the source means the gauge published nothing, and it has to stay visibly
different from a measured zero. Dissolved gas in particular is blank for long
stretches of the 2015 file, and spill is legitimately `0.000` on most days —
printing "0 mmHg" for the first would be a fabricated reading.

## Enrichment loaded after boot (river conditions, ten-year comparison)

River-environment gauges (`loadConditionsForYear`) and the ten-year daily mean
(`loadHistoryComparison`) are both loaded after boot and neither is on the
critical path — the bar is complete and correct without them, showing "—" —
so neither is awaited at boot, and a failure in either costs one field, never
the river. Both are memoized per fetch in `data.js`, so calling them again on
a year change is cheap for a season already seen.

`riverConditionsByDate` (date → `{ outflowKcfs, spillKcfs,
dissolvedGasMmHg }`) is **replaced wholesale, never mutated**, so a stale
year's readings can never be half-mixed with a new year's. Its loader checks
`if (year !== runYear) return` after the fetch resolves — a slow fetch can
land after the viewer has moved on to another season, and dropping it is the
only correct option: those are readings for a year no longer on screen.

`historyEnvelope`/`meanToDate` hold the 2006–2015 day-of-year envelope and the
cumulative mean derived from it for the *current* season. `meanToDate` is
indexed the same way `seasonToDate` is so the two are directly comparable.
`rebuildMeanToDate()` walks the season's own dates against the day-of-year
envelope — it is rebuilt **per season**, not once, because the envelope is
keyed by day-of-year and every season starts/ends on a different one, so the
running total through "record 40" is not the same figure in 2006 as in 2015.

`updateRunComparison` guards `average <= 0` rather than assuming it can't
happen: the first counted day of a season can fall on a day-of-year no other
year in the envelope reached, making the running mean genuinely 0 and the
percentage genuinely undefined. The one saturated color in the whole bar
(`seasonDeltaLabel.className = "above"`) is reserved for the one reading that
is a judgment rather than a measurement, and only when the run is running
*ahead* — behind average is the neutral case, not an alarm.

## Date readout, month ticks

`setDateReadout`'s ordinal counts position in the *record*, not day-of-year:
DART only publishes rows for the dam's counting season, so this reads "day
172 of the 275 counted" — which is what the timeline is actually indexing.

Month ticks (`buildTimelineAxis`) are positioned from real dates in `runData`
rather than spaced evenly, for the same reason: the season starts partway
through March and the months are not equal fractions of the track.

`seasonComplete` (set in `rebuildSeasonTotals()`, read by `setDateReadout()`)
flags a season whose last record's month isn't December — every one of the
ten historical seasons on file ends in December, so a season that doesn't is
still being counted by DART, not a genuinely short year (see the 290–306-day
note in `.claude/context/data.md`). This is deliberately data-driven, not
`new Date()`-driven: keying it off the wall clock would mean it silently
stops applying to a season that's still actually incomplete the moment the
calendar year rolls over, even though nothing about the vendored file
changed. Checking the record's own last date instead needs no maintenance
and no clock — it flips itself off the next time `scripts/fetch-dart.mjs` is
rerun after the real season finishes in December.

## Season totals (`rebuildSeasonTotals`, `peakDayIndex`)

`seasonToDate` is the running total of the five simulated species from the
first counted day through day `i` — the figure a passage report actually
leads with, since a single day's count says nothing about whether the run is
large or small. It is **not** a `const` filled once at module scope: the year
control swaps `runData` underneath this module (`loadYear` in `data.js`), and
seasons differ in length, so it's reallocated per season by
`rebuildForYear()`. `dayTargets` and friends further down follow the same
rule.

`peakDayIndex` (the heaviest day of the season, for the transport's "peak"
jump) is derived here rather than searched on click, so the button stays O(1)
and the figure is available to anything else that wants it.

## Season chart (`buildSeasonChart`)

Drawn once at boot into the HUD's SVG: daily passage as a filled area, water
temperature as a line over it, both on the timeline's own x-axis so the
scrubber's cursor reads against them.

The two share an x-axis but **not** a y-axis — they're different quantities
in different units, and forcing them onto one scale would be a lie. Each is
normalized to its own range, and the ranges are printed in the caption
instead of drawn as axes, which at this size would cost more room than they
return.

Passage uses a **square-root scale**. Linear was tried first and is the
honest default, but the run is far too spiky for it: one 7,500-fish September
day flattens the other three hundred into a line along the floor, so the
chart shows a single spike and hides the shape of the season. The root keeps
the peak where it belongs while leaving the shoulders legible — and the
caption says "√ scale" rather than passing it off as linear.

The temperature line breaks rather than bridges across days with no reading
(`penDown = false` on a gap, `M` restarts a subpath): a straight segment
across a gauge outage would invent a trend that was never measured.

## Timeline axis & month label thinning (`thinMonthLabels`)

Hides any month label that would overlap the one before it, **measured**
rather than guessed. The ticks are positioned from real dates, so their
spacing is uneven by construction — a season starting March 5 puts "Mar" and
"Apr" about nine percent of the track apart, which collides at any bar width
— and the field they sit in is fluid, so there's no fixed width at which a
static rule would be right. This replaced a media query that hid every other
label below 640px, which both under- and over-corrected, and it mattered more
once the labels became click targets: two overlapping labels means one of
them jumps to the wrong month.

The measurement is checked once on the **container**, not per label: a
per-label zero-width test that bailed out of the whole pass was a bug, since
it would stop at the first unmeasurable label and leave every label after it
visible and overlapping. Visibility is cleared first on every pass, because a
hidden label has a zero-width rect and would be invisible to the collision
test forever, unable to come back on a widened window.

The ticks themselves are never hidden — only the labels — so the axis still
reads as a full season. `requestAnimationFrame(thinMonthLabels)` runs once
after `buildTimelineAxis()`'s synchronous, pre-layout call, since that
function runs during module evaluation, before the bar has been laid out and
before the measurement above has anything to work with.

The click listener on `timelineAxis` is delegated **once, at module scope**,
rather than re-bound inside `buildTimelineAxis()` — that function re-runs on
every year change, and per-build listeners on a container being replaced
wholesale is how a jump ends up firing ten times.

## Scene bounds and `WORLD_SCALE`

`bounds` (the simulated world) and `pixelBounds` (the actual browser
viewport) used to be the same object — every world unit was exactly one CSS
pixel. They're split now so the river can be smaller than the window:
`WORLD_SCALE = 0.55` shrinks `bounds` on both axes; camera framing, fog,
terrain, water and the flock all read the smaller `bounds` and are none the
wiser; `pixelBounds` alone reaches `sceneSetup`'s renderer/composer sizing, so
the canvas still fills the real viewport at full resolution.

Fish are the one thing whose absolute size (`BODY_VISUAL_SCALE`, in
`boids.js`) does **not** scale down with `bounds` — that's deliberate, and
it's the entire effect: relative to a smaller river, a fish of the same
real-world size reads as bigger and the channel reads as more full, so a
smaller simulated population still holds the shot. That's the performance win
(fewer flocked, shaded, VAT-sampled instances) and the visual one (a tighter,
more intimate river) both at once. Since both axes scale by the same factor,
`bounds`' aspect ratio always matches `pixelBounds`', so nothing about the
framing distorts.

## Camera debug readout ("D")

The camera is fixed (see `scene/sceneSetup.md`), so the debug panel's numbers
no longer change frame to frame — it's still the way to read off a new
`EYE_FRAC`/`TARGET_FRAC` by eye if the framing ever needs re-tuning.

## Water simulation size (`waterSimSize`)

Read from the device tier (`quality.js`). The relax pass does seven texture
fetches per texel every frame, so cost is quadratic in the grid size: 600²
was ~2.5M fetches a frame, and 600 isn't even a power of two — the high
tier's 512 drops 27% of them for no visible change in the height field. At
the low tier the size is 0 and the simulation isn't constructed at all; the
surface and caustics both switch to the procedural stand-ins in `glsl.js`.

## The simulation clock (`simTime`)

Pause used to stop only the timeline: the flock kept swimming, the water kept
rippling and the sun kept crossing the sky, so the one thing that didn't
advance was the date. `simTime` is the clock everything time-driven now reads
instead of the rAF timestamp — fish bob, tailbeats, silt drift, shaft sway,
the sun's daily arc — and it only accumulates while `isPlaying`. Pause is a
genuine freeze-frame.

It has to be a **separate accumulator**, not an offset subtracted from `t`,
because the render loop keeps running while paused (the canvas still has to
repaint, resize still has to work) and would otherwise resume having skipped
however long the pause lasted.

## Bounds-shaped world (`createWorld`, `destroyWorld`, `rebuildWorld`, `applyTier`)

Every bounds-shaped resource (`waterSize`, `causticsSize`, `terrainMesh`,
`particles`, `godRays`, `depthRange`, `waterSim`, `causticsGenerator`,
`water`) is sized directly off `bounds` rather than resizable in place, so a
resize disposes and rebuilds the whole set. Construction lives in exactly one
place (`createWorld()`) rather than once at module top level and again inside
a rebuild function — the old duplication is precisely where a new
bounds-dependent resource gets added to one copy and forgotten in the other.

Notable specifics inside `createWorld()`:

- The water sim covers a bigger area than the river bounds
  (`waterWorldSize()` in `water.js`) so ripples can propagate out to the water
  plane's faded edges instead of the edge texel just clamping/stretching
  across the whole margin.
- `causticsSize` depends on the camera as well as `bounds` — it's centered on
  what the eye is actually looking through, not the river's geometric middle.
- `depthRange` (`surfaceY: -8`, `floorY: -riverDepth(bounds) + 6`) is the band
  fish swim within: a little below the surface down to just above the
  riverbed floor.
- At the low tier, `waterSim`/`causticsGenerator` are **nulled**, not
  stubbed — unlike `particles`/`godRays`, they aren't scene objects with a
  uniform interface, and the loop has to skip stepping/rendering them
  entirely, which is a real difference in what the frame does, not a no-op
  call. Everything downstream switches to the procedural caustics path chosen
  once at material-compile time, so there's no per-frame branch anywhere,
  only these two nulls.
- The caustics render target's texture is bound **once** here rather than
  reassigned every frame — its identity never changes. The water sim's own
  texture genuinely does alternate between two ping-pong targets, so that one
  still has to be handed over per frame in the render loop.
- `causticsGenerator.render()` is called once directly in `createWorld()`,
  not left to the loop, because the loop's own caustics pass is gated on
  `isPlaying` — resizing the window while paused would otherwise leave a
  brand-new target empty, and the water surface and fish would lose their
  glints until playback resumed.
- Explicit `renderOrder` (terrain 0, water 1, fish 2 — set in `fishMesh.js`,
  since this function only touches the other four, silt/shafts 3) replaces
  THREE's automatic transparency sort (see the matching note in
  `fishMesh.js`): terrain (farthest, since the camera sits well up off the
  bottom) behind water (the Y=0 ceiling, usually farther than the fish
  beneath it) behind fish behind the silt/shafts, which drift through the
  whole column and read best as a hazy overlay on top of everything solid.

`destroyWorld()` disposes old GPU resources before `createWorld()` builds
their replacements, to avoid leaking memory across a resize.

`rebuildWorld()` is deliberately **not** called straight off the resize
event — see the debounce section below.

`applyTier()` re-applies the whole scene at a new device tier after the perf
governor decides the current one isn't holding frame rate. Everything scaled
by the tier — render-target sizes, geometry segment counts, instance
capacity, which caustics path is compiled into each material, whether bloom
exists at all — is fixed when a resource is constructed, so the only way to
change it is to build it again: a real stall of a few frames, which is why
the governor is deliberately slow to trigger and never reverses itself. Order
matters: renderer pixel ratio/composer first (`sceneSetup` owns those), then
the bounds-shaped world, then the fish (which read the freshly-built caustics
texture). `rebuildDayTables()` is called **before** trimming the live flock —
without that ordering the trim was cosmetic: it cut the live flock, and the
pacing loop refilled it moments later against targets still scaled to the
tier the page booted at (see "Day tables" below for the full shape of that
bug — it made the governor's single biggest lever a no-op). The excess is
then removed immediately (`flock.removeActive(excess)`) rather than waiting
for fish to drain out through the exit line, since the pacing loop only ever
*adds* fish and a downgrade would otherwise sit above its new ceiling for as
long as the run took to turn over.

The governor itself (`createPerfGovernor`) is always created, so the debug
panel has a frame time to show. When a tier is forced via `?quality=`, it's
handed a `null` callback: it keeps measuring but never acts, so A/B testing a
tier on desktop isn't immediately overridden by the governor deciding
otherwise.

## `maxPopulation` and `FISH_RENDER_HEADROOM`

`maxPopulation()` caps how many fish are simulated/rendered at once, **across
all species as a single pooled total** — deliberately, because the
per-species clamp it replaced was distorting exactly the days that matter
most. Clamping each species independently at 400 turned 2015's Chinook peak
(~7,500 chinook against a few hundred steelhead, a genuinely ~94% chinook
day) into 400 of each — a 50/50 split on screen. The mix a viewer reads was
an artifact of the cap, not the data. The day tables (`rebuildDayTables`)
scale the whole day proportionally instead, so percentages survive and only
the absolute number is capped.

The ceiling used to be documented here as vertex-bound, on the claim that the
mesh is ~1,300 vertices and 1,200 fish therefore cost ~2M vertex shader
invocations a frame. **That figure was wrong.** `steelhead-final.glb`'s
POSITION accessor holds **435 vertices (654 triangles)**, so the flock is
~522K invocations — a quarter of what the old note claimed, and comfortably
not the most expensive thing in the frame (the caustics pass and water
simulation each cost far more — see `quality.js`), which is why those are
what the tiers cut first, and why the fish LOD the README lists as a next
step is not the win it looks like. What `maxPopulation()` actually bounds is
**fill rate and CPU**: every fish is a transparent, blended, sorted draw, and
the flocking simulation walks the whole array four times a step. Both scale
with the tier, hence the table in `quality.js` rather than a constant here.

`FISH_RENDER_HEADROOM = 8 * REMOVE_FADE_FRAMES` gives each species renderer
extra instance slots on top of `maxPopulation()`. `maxPopulation()` bounds
only the *active* fish, but `flock.fish` also holds fish that have crossed
the exit line and are still fading out over `REMOVE_FADE_FRAMES` (see
`boids.js`). Sizing renderer capacity to `maxPopulation()` alone meant those
pushed the array past capacity and the overflow was silently dropped from the
draw — and since fading fish are the oldest and sit at the front of the
array, the fish actually dropped were the *newest spawns*, which then popped
in a beat late. The number of fish fading at once is roughly (exit rate) ×
`REMOVE_FADE_FRAMES`; at the cap, exit rate ≈ population / crossing time, and
a fish crosses in `bounds.width / maxSpeed` frames, so a narrow window (the
worst case — it shortens the crossing without shrinking the population) lands
around 5 exits/frame, i.e. ~120 fading. 192 leaves margin on top of that at a
cost of ~17KB of unused instance data per renderer.

## Fish renderer lifecycle (`fishRenderer`, `fishAssets`, `buildFishRenderer`)

`loadFishAssets()` loads and bakes every distinct per-species GLB (see
`SPECIES_MODEL_URL` in `fishMesh.js`) — real async work, unlike a placeholder
shape — so `fishRenderer` stays `null` until it resolves, and every reader
(`createWorld`, `applySeason`, the render loop) guards for that. `fishAssets`
is stashed from that one load so `buildFishRenderer()` can rebuild the
renderers on a tier change without re-fetching or re-baking.

`buildFishRenderer()` has to be a full rebuild rather than an in-place
adjustment because the caustics path (real texture sample vs. procedural
stand-in, see `causticGlowChunk` in `glsl.js`) is compiled into the material,
and instance capacity is fixed when the `InstancedMesh` is allocated — both
change with the tier. It's safe to call before assets resolve; it's a no-op
until then.

## `applySeason`

Drives the sky/sun, the distance fog every surface fades into, the water
surface's body/reflection colors, the riverbed's color and sun direction, and
the caustic glow on fish/riverbed — all from the same date, so the whole
scene reads as one consistent season instead of drifting independently.
`setFogSeason()` is the odd one out: it takes no target, because it mutates
the single shared `FOG_COLOR` that every `ShaderMaterial`'s `uFogColor`
uniform already points at (see `fog.js`). `setSunSeason()` similarly takes no
target — it fixes where the sun sits at its daily high point, and the render
loop sweeps it either side of that via `sweptSunDirection()`.

## Resize handling (debounce + mobile chrome-bar guard)

A dragged window edge fires `resize` on nearly every frame of the drag, and
`rebuildWorld()` is expensive enough — disposing/reallocating the water sim's
ping-pong targets, the two 1024×1024 caustics targets, and two full plane
meshes — that running it at that rate visibly hitches and churns GPU memory
for the whole drag. So the work is split by cost: the cheap half
(renderer/composer buffers, camera aspect, fog density) runs immediately on
every event so the canvas never looks stretched mid-drag, and the expensive
rebuild waits until the drag has been still for `REBUILD_DEBOUNCE_MS = 150`.
In between, terrain/water/sim are simply still at their previous size,
visible only as the water plane not yet reaching a freshly-widened viewport
edge — softened by the plane's own fade margin.

Mobile browsers also fire `resize` when their own chrome slides in or out
(address bar collapsing on scroll, toolbar reappearing on a tap). Those
events change height by roughly one chrome bar and width by nothing, and
treating them as real viewport changes would mean a full world rebuild every
time a finger moves. `CHROME_BAR_THRESHOLD_PX = 120` (above a typical mobile
address bar of ~56–100 CSS px, well below any deliberate resize) absorbs a
height-only change smaller than that: the canvas is still resized to fill the
new viewport, but `bounds` is left alone and nothing downstream of it
rebuilds.

## Flock construction (`BASE_MAX_SPEED`, `separationRadius`)

`BASE_MAX_SPEED = 1.2 * WORLD_SCALE`. The `1.2` base was `2.4`, halved so a
fish's spawn-to-exit crossing takes roughly twice as long (`BASE_FRAMES_PER_DAY`
was doubled to match), giving more time to actually watch individual fish
swim through the scene instead of them blowing past in a couple seconds. The
extra `* WORLD_SCALE` factor is needed on top of that halving because
crossing distance (`bounds.width`) shrank by `WORLD_SCALE` too, and a fish's
absolute swim speed didn't previously depend on river size — left alone, a
fish would now cross in `WORLD_SCALE` as many frames, reintroducing the
"blowing past" problem. This keeps crossing *time* where it was tuned, at the
cost of a slower raw world-units/frame speed, which is invisible on its own
since nothing else reads an absolute speed independent of the bounds it's
crossing.

`separationRadius: 65` has a documented tuning history. It was `20`, well
under a fish's actual rendered body length (~72–105 world units, `fish.length
* BODY_VISUAL_SCALE` in `boids.js`), so the separation force's steady state
let meshes clip well before the force pushed back hard. It became `45`,
chosen to sit "close to" `Flock.step`'s overlap-resolution clearance — which
turned out to be exactly wrong, because that clearance is at most `(44 + 44)
* 0.5 * BODY_VISUAL_SCALE * OVERLAP_CLEARANCE ≈ 42.2` for two large Chinook,
so a separation radius of 45 gave the soft force a working band under three
units wide before the hard positional correction took over — the opposite of
the intent (soft force does most of the work, hard correction is a rare
safety net), since only the soft force actually turns a fish to face where
it's going. `65` gives the force ~23 units of approach to work with instead
of 3. It must stay **just under** `perceptionRadius` (`70`): `Flock.step`
only examines neighbors inside `perceptionRadius` (the spatial grid is sized
to exactly that), so a `separationRadius` above it would silently clamp while
reading as though it were doing something more.

## Run timeline: reduced motion, `framesPerDay`

`PREFERS_REDUCED_MOTION` is read **once at boot**, not watched, because
flipping the OS setting mid-session shouldn't yank a running simulation out
from under someone. A full-screen animated scene is the clearest case there
is for honoring the preference: the whole page is motion, with no way to opt
out once it starts — so the scene boots **held**, not running. The first
frame is rendered and the river is fully composed, it simply isn't advancing;
Play (or Space) starts it. Nobody who wants the animation is prevented from
having it; nobody who asked not to be moved is moved without asking.

`BASE_FRAMES_PER_DAY = 240` came from a progression: 40 → 80 → 240. At 60fps
that's four seconds a day, and a little over twenty minutes for a whole
counting season. The last tripling (80 → 240) was for the HUD specifically:
once the day's figures started counting toward tomorrow's across the day
(see `updateFishCountDisplay`) rather than snapping at midnight, the readout
became something to actually watch, and at 80 frames the numbers moved too
fast to follow. It also stretches the spawn ramp sharing this progress value,
so the school fills in and thins out more gradually. `framesPerDay` (not
`BASE_FRAMES_PER_DAY` directly) is what the loop reads, since the transport's
speed selector divides the base figure — see "Playback speed" below.

## Day tables (`rebuildDayTables`, `dayTargets`, `dayWeights`, `dailyRateOfChange`)

These are pure functions of `runData` that used to be recomputed on demand,
each computation allocating a fresh counts object — `desiredPopulation()`
alone called it twice per frame, and every spawn called it again to pick a
species, so a busy day allocated dozens of throwaway objects per frame for
numbers that were identical every time. They're precomputed instead:

- `dayTargets[i]` — how many fish day `i` should have on screen.
- `dayWeights[]` — flat, `SPECIES_KEYS.length` entries per day, holding the
  running cumulative species counts for that day, so a weighted-random pick
  is a walk over a slice rather than a rebuild of the whole table.
- `dailyRateOfChange[]` — day-over-day change in target population, used by
  `applyDaySpeed` to make the school swim faster/slower as the run ramps up
  or tapers off.

The scaling preserves each day's real species percentages (see
`maxPopulation()` above): a day over the cap has every species multiplied by
one shared factor, so each keeps its exact share and only the absolute number
shrinks; a day already under the cap passes through untouched. Counts stay
**fractional after scaling**, deliberately, since they're only ever used as
weights or summed before rounding.

`rebuildDayTables()` has to be re-runnable, and for a long time it wasn't —
it was straight-line code at module scope, evaluated once against whatever
tier detection guessed at boot. The performance governor's whole job is to
correct that guess, and `population` is its biggest lever, but a downgrade
only ever trimmed the *live* flock: `applyTier()` cut the excess, and the
pacing loop immediately refilled it against these stale, higher targets.
Within a second or two the flock was back over the new cap and the downgrade
had bought nothing. Worse, it was quietly destructive: the fish renderers are
rebuilt at the new tier during the same `applyTier()`, so their instance
capacity became `maxPopulation() + FISH_RENDER_HEADROOM` at the **low**
figure while the flock refilled to the high one, and the overflow was
silently dropped from the draw.

The arrays are sized off `runData.length`, which the year control *does*
change (seasons run 290–306 days), so they're reallocated rather than filled
in place — module-level `let`s, never held by long-lived references across a
year switch; every reader goes through the binding.

## Diurnal arrival shape (`DIURNAL_BASELINE`, `diurnalRate`, `diurnalProgress`)

Fish don't pass a dam evenly around the clock: ladder passage is a daytime
affair, thin around first light, heaviest through the middle of the day,
tapering off toward dusk. Arrivals used to ignore that — `desiredPopulation()`
interpolated linearly, so a whole day's change came in at one flat rate — and
since the scene already sweeps the sun across each simulated day
(`sweptSunDirection` in `season.js`), a flat arrival rate was visibly at odds
with the light.

`DIURNAL_BASELINE = 0.3` is what keeps the shape a hump rather than an on/off
switch. A bare raised cosine falls to zero at both ends of the day, which
would empty the upstream edge for the first and last stretch of every day.
So the rate is a blend: a flat baseline running all day, plus a mid-day hump
on top. At `0.3`, the middle of the day runs **~5.7×** the rate of the edges
— an unmistakable mid-day peak that still has fish swimming in early and
late.

`diurnalRate(progress)` is the relative arrival rate at a point in the day,
normalized to average exactly 1.0 across the day — it redistributes *when* a
day's fish arrive without changing *how many* do. `diurnalProgress(progress)`
is its closed-form integral from 0 to `progress` (rising 0 → 1 across the
day): the easing curve the population ramp runs on, turning a day's growth
from a straight line into ease-in / rush-through-midday / ease-out. It's
closed-form rather than numerically integrated because the only term with any
shape to it is a cosine.

## `desiredPopulation`, `pickSpeciesForDay`

`desiredPopulation(idx, progress)` interpolates between today's and
tomorrow's `dayTargets`, eased along `diurnalProgress` so the bulk of a day's
change lands around midday. It is still exactly today's count at progress 0
and exactly tomorrow's at progress 1 — the easing changes the path between
endpoints, never the endpoints themselves, so the curve stays continuous
across the day rollover.

`pickSpeciesForDay(idx)` does a weighted-random species pick matching that
day's real percentages, drawn from the same `dayWeights` table `dayTargets`
was summed from, so the mix new spawns come from always agrees with the
population they're filling. Falls back to all-steelhead when a day has no
species breakdown at all.

## Speed multiplier, `applyDaySpeed`

`speedMultiplierForRate(rate)` maps a day's rate-of-change in population to a
swim-speed multiplier: a fast-rising run swims slower (more fish arriving
reads as denser/slower), a fast-falling run swims faster. It's clamped
(`normalized` to [-1, 1] against a rate of 40) so extreme days don't blow the
multiplier out of a sane range; it spans **0.55 to 1.45**.

`applyDaySpeed(idx, progress)` interpolates this multiplier across the day
rather than stepping it at the boundary. It used to be set once per day
rollover, so at `FRAMES_PER_DAY` the shared speed clamp could jump by up to
45% in a single frame, every four seconds, applied to every fish at once —
the whole school surged or braked together on a schedule, exactly the kind of
periodic hitch the eye reads as the simulation stuttering rather than the run
speeding up. `smoothSpeed` in `boids.js` does **not** help here: it low-passes
what the renderer drives the *tailbeat* from, well downstream of the velocity
clamp doing the jumping, so the tail stayed smooth while the fish underneath
it lurched. Interpolating toward tomorrow's multiplier on the same `progress`
the population ramp runs on spreads the same total change across the day's
240 frames — endpoints unchanged, only the path between them now continuous.

## Spawn pacing: correction gain, replacement fraction

`POPULATION_CORRECTION_GAIN = 0.15` is the fraction of the remaining gap to
the day's target closed per frame, so a gap takes roughly `1/GAIN` frames to
close (~15 at this value). That's comfortable at 240 frames/day and useless
at 30: run the transport at 8× and the school spends every day chasing a
target that's already moved on, visibly lagging the readout beside it. So the
gain follows playback speed via `correctionGain() = min(MAX_CORRECTION_GAIN,
POPULATION_CORRECTION_GAIN * speedMultiple)` — the ramp is defined as a
fraction of a *day*, not a fraction of a second. `MAX_CORRECTION_GAIN = 0.6`
caps it because past about 0.6 the "ramp" is really a step and the school
pops into existence at each day boundary instead of filling in; at 8× this
clamp is what binds, so the very top speed does lag slightly — the honest
trade, since the alternative is a visible pop.

`REPLACEMENT_FLOOR = 0.4` is the floor on how much of the outgoing flow gets
replaced by `replacementFraction(target, active)`. This exists because
population and target move on completely different clocks: a fish takes
thousands of frames to cross the scene (the best part of ten simulated days
at `FRAMES_PER_DAY`), while the target it's chasing is a real daily count
that can halve overnight. The old pacing spawned on `Math.max(0, error)`
alone, so the day after any drop the school was already over target and
**nothing at all** entered from upstream — and with a residence time that
long it stayed over target for days. `replacementFraction` instead replaces
one-for-one when the school is at or under target, tapering off as it runs
over, but never below the floor, because a school draining back toward a
quiet day is exactly when the river would otherwise go silent for a long
time (the taper still drains: below 1.0, fewer fish enter than leave).

The `0.4` figure was picked by replaying 2015's real DART series through this
pacing loop offline against a range of assumed crossing times (fish don't
swim straight downstream at `maxSpeed`, so the real crossing time can only be
bracketed, not derived — 1,600–2,700 frames was the bracket used). Higher
keeps the upstream edge busier but holds the school further above the day
it's meant to be showing. Across that bracket, `0.4` took the share of frames
sitting in a stretch with nothing arriving — longer than a whole simulated
day — from **56–64% down to 18–26%**, and the worst such stretch from
**26–44s down to ~17s**, for a median population error moving from
**18–21% up to 28–35%**. In the same offline replay, the old `Math.max(0,
error)`-only pacing left 120–136 of 2015's 302 counted days with *zero* fish
entering, in runs of six to ten days at a stretch — that's the empty upstream
edge this fixes.

`spawnAtLeftEdge()` enters new fish at a random point along the river's
width (not one fixed spot), so the run reads as continuously arriving.

## `jumpToDay`

Scrubbing the timeline jumps straight to a day: spawn/remove fish until the
population matches that day's target, then reset the per-day animation state
(frame counter, spawn accumulator, speed, HUD). It calls
`flock.finalizeRemovals()` first as a **hard resync point**, flushing any
fade-out still pending from a previous jump rather than layering more on top
— this is what keeps a fast slider drag from growing the fish array without
bound.

`activeCount()` is read once and the difference acted on directly, rather
than re-counting the whole flock as a loop condition — spawning ~1,200 fish
one `activeCount()` call at a time was quadratic, and it ran on every `input`
event of a slider drag. When removing excess fish, `removeActive()` only
*flags* them — `Flock.step()` is what fades and drops them — but scrubbing
pauses playback, so `step()` won't run; without an explicit
`flock.finalizeRemovals()` here (only when `!isPlaying`), the flagged fish
would hang at full opacity forever and the school would visibly disagree with
the count the HUD just wrote. A hard cut is appropriate here anyway: nothing
else in the frame is animating for a fade to be visible against.

## `setPlaying`

The one place that writes play state, so the button's label and its
`aria-pressed` can never drift apart — they used to, because the timeline
handler set state and label by hand separately. `aria-pressed` replaces a
static `aria-label="Play or pause"`, which overrode the button's visible text
so a screen reader announced the same "Play or pause" regardless of state —
it named the control but never reported it. With that label gone, the
visible word *is* the accessible name, and `aria-pressed` carries the state.

## Season switching (`rebuildForYear`, `setYear`)

`data.js` exports `runData` as a **live binding**, so the swap itself is
free — every reader in this file sees the new array the moment `loadYear()`
assigns it. What is *not* free is everything derived from the record: three
typed arrays sized off its length, cumulative season totals, two SVG paths,
and the month axis. `rebuildForYear()` is the one place that knows the full
list of things to rebuild, called both at boot and on every year change so
the two paths can't drift. On a switch, `dayIndex` is **clamped**, not reset
to 0 — landing on a new season mid-run should keep roughly the same point in
the season, not throw the viewer back to March.

`setYear(year)` guards against a second switch landing while the first is
still fetching (`yearSwitchInFlight`) — the control is disabled for the
duration, but a keyboard repeat can still outrun a slow network. It also adds
`.field-loading` to `seasonSwitchFields` (passage/conditions/run-status/
controls, cached once at module scope) for the same duration, removed in the
`finally` alongside `yearSelect.disabled` — the only visible acknowledgment
that those four fields' figures still belong to the outgoing season until
the fetch resolves. `#masthead` is left out of that list deliberately: the
year select's own `:disabled` state already marks it. Playback is
held for the duration and restored after: a season change reallocates the
day tables the pacing loop reads every frame, and letting the loop run
through that risks a frame indexing a half-built table. On failure,
`runData`/`runYear` are left untouched by `loadYear()`, so the app is still
showing a complete, correct season — the failure path is a warning
(`showNotice(..., "warn")`), not the app's error state.

## Transport (`stepDay`, peak button)

Both route through `jumpToDay()`, which already holds playback and re-seeds
the flock, HUD, season and plates cursor — so they add reach, not a second
code path for "the day changed." `stepDay` wraps at both ends, matching the
loop's own `(dayIndex + 1) % length`. The peak button is the one jump not
reachable by dragging or stepping: finding the heaviest day by hand means
scrubbing until the curve peaks, and it's the day most worth looking at.

## Playback speed (`SPEEDS`, `setSpeed`)

Speed divides `BASE_FRAMES_PER_DAY`, so 8× is 30 frames/day and a whole
season takes about two and a half minutes rather than twenty.
`setSpeed()` rescales `frameCounter` (`Math.min(frameCounter, framesPerDay)`)
rather than resetting it, since the budget it's measured against just
changed underneath it — changing speed mid-day holds the day's progress
instead of jumping the readout and spawn ramp back to dawn.

## Keyboard controls

Space/arrows/Home/End/±: the first keyboard binding beyond the debug panel's
"D". `BUTTON_OWN_KEYS` (Space, Enter) are left to a focused `BUTTON` rather
than intercepted — skipping buttons outright (the first approach) was a real
trap, since clicking any transport button leaves focus on it, and every
binding on the page went dead until the user happened to click elsewhere
(pressing Peak, then finding Home/arrows/speed keys do nothing, reads as the
page being broken). `INPUT`/`SELECT` are skipped outright, since the timeline
slider's own arrow keys and a select's type-ahead need those keys. Space
calls `preventDefault()` because the browser default both scrolls the page
(nothing here scrolls) and fires the focused button, which would
double-toggle play. `=`/`+`/`-`/`_` are all accepted for speed so it works
without Shift while still tolerating anyone who holds it.

## Water ripples (`emitRipples`)

No mouse interactivity, no per-fish disturbance either: an earlier version
also dropped a ripple per clustered "pod" of nearby fish (see git history /
former `scene/pods.js`), but finding those pods meant clustering the entire
flock — an O(n²) union-find pass — every 20 frames, real money at thousands
of fish for a purely decorative effect. A slow ambient "rain," independent of
the fish sim entirely, reads almost as well and costs nothing per fish.

`AMBIENT_DROP_INTERVAL_FRAMES = 30`, each drop bigger and gentler than a
sharp poke, reads as slow, broad swells rather than busy chop (paired with
matching propagation/damping tuning in `waterSim.js`). The drop radius
(`0.05–0.08` sim-space, tuned when the sim's [-1, 1] space mapped 1:1 onto
`bounds`) is scaled by `bounds.width / waterSize.width` now that the sim maps
onto the bigger `waterSize` instead, so the same sim-space radius doesn't
read as a bigger real-world ripple than intended. `rippleFrame` advances by
`dt` (not by 1), so the cadence stays tied to wall-clock time rather than
display refresh rate, and is wrapped via modulo rather than left to climb so
it keeps working after a long session.

## Animation loop (`loop`)

`REFERENCE_FRAME_MS = 1000/60` is the frame duration every constant in the
sim was tuned against, so `dt = 1` is the reference and nothing needed
retuning to decouple from display rate. `MAX_STEP_FRAMES = 3` bounds a single
step: a backgrounded tab stops receiving rAF entirely, so the first frame
back can be minutes long, and a tier change stalls for a beat rebuilding
every GPU resource — both would otherwise teleport the whole flock
downstream in one step. Three frames is enough headroom to stay smooth
through an ordinary hitch and low enough that a big one just drops motion
instead of exploding the sim.

`dt` itself used to be the constant `1`, which coupled the whole scene to
display refresh rate: a phone holding 30fps ran the river at half speed, a
120Hz display ran it at double. Now both are the same river at the same
speed, **dropping motion rather than slowing down** — which matters most on
exactly the low-end devices this scene is scaled for, since a slideshow that
is also in slow motion reads as broken rather than merely coarse.

The caustics accumulation pass is throttled (`causticsFrame++ %
QUALITY.causticsInterval`) and is, despite an outdated note that used to
claim otherwise, **the most expensive thing in the frame by a wide margin** —
ahead of the fish. It's a grid of up to 257×257 vertices, each running a loop
of up to 40 texture fetches in the *vertex* shader, splatted additively into
a 1024² half-float target. It runs at a fraction of frame rate because the
thing it tracks barely moves: the water sim damps at 0.9975 and gets a drop
every 30 frames, so the light net is a slow swell with no per-frame detail to
lose. The throttle is deliberately **not** applied to `waterSim.step()` — that's
a discrete wave equation stepped once per frame, so halving its rate would
halve the propagation speed of every ripple, a change to how the water
behaves rather than just how often it's sampled.

### Population pacing (spawn/turnover math, and a fixed dt-scaling bug)

Each frame while playing:

1. **Growth** — `arrivals = max(0, target - active) * correctionGain()`,
   scaled by `dt`. This is a per-frame *rate*, not shaped by `diurnalRate`
   again: `target` (`desiredPopulation`) is already the eased ramp, so the
   midday hump is baked into this term's own slope, and reapplying
   `diurnalRate` would square it.
2. **Turnover** — `flock.exitedLastStep * replacementFraction(target, active)
   * diurnalRate(progress)`, added to `spawnAccumulator` **after** the `dt`
   scaling above. This is the term that keeps the run continuous through the
   long flat/falling stretches the growth term sits out entirely, and it *is*
   shaped by `diurnalRate` so the steady stream thickens toward midday and
   thins at either end rather than running at one rate around the clock.

   The ordering here — turnover added after the growth term's `dt` multiply,
   rather than folded in before it — is a **fix, not a stylistic choice**.
   `exitedLastStep` is a *count* of departures from a step of size `dt`, and
   already scales with `dt` (since `step(dt)` advances positions by `vx *
   dt`), so folding it into the pre-multiply term scaled it a second time.
   That wasn't a mild over-spawn: replacement only balances where
   `replacementFraction * diurnalRate * dt ≈ 1`, and with `REPLACEMENT_FLOOR`
   at 0.4, any `dt >= 2` through a midday `diurnalRate` above 1.25 leaves that
   product permanently over 1 — no equilibrium at all, so a device running at
   30fps grew its flock without bound through every simulated midday. On
   exactly the hardware least able to carry it.
3. **Hard ceiling** — the `while (spawnAccumulator >= 1)` spawn loop checks
   `flock.activeCount() >= ceiling` and bails, independent of the day tables.
   This is a no-op in normal operation (`dayTargets` is already capped at
   `maxPopulation()`), but it makes the cap **structural**: before this, every
   path to an over-target population depended on the day tables being correct
   and current, so a future bug in those tables would have meant an unbounded
   flock instead of just some inaccuracy in the run's shape.

`HUD_UPDATE_INTERVAL_FRAMES = 8` throttles `updateFishCountDisplay` during
playback. A day takes `FRAMES_PER_DAY` frames to cross, so the figures move
by well under one displayed digit per frame, but the call isn't cheap (ten
`toLocaleString()` allocations, a `querySelector` per secondary row, several
layout-dirtying `textContent` writes) — at this interval it's still smooth to
the eye and costs an eighth as much.

## Lifecycle: visibility and WebGL context loss

Browsers already throttle rAF in a hidden tab but don't stop it, and what
keeps running is not cheap — the water sim's ping-pong step and the caustics
pass both advance on frames nobody is looking at. `stopLoop()`/`startLoop()`
on `visibilitychange` stop it outright, cheaper and kinder to battery.
`startLoop()` re-seeds `lastFrameTime = null` before requesting the next
frame — after minutes in a background tab, `t - lastFrameTime` would
otherwise be enormous; `MAX_STEP_FRAMES` caps how far the *sim* jumps, but the
frame-time governor would still read the gap as a catastrophically slow frame
and downgrade the tier for something that never actually rendered.

Context loss is a **normal** event on mobile — the OS reclaims the GPU when
the browser is backgrounded, another tab allocates heavily, the device
sleeps. It wasn't handled before, so the routine outcome was a permanently
black canvas with no indication why. On `webglcontextlost`,
`event.preventDefault()` is the one line that makes the context
restorable at all — without it, `webglcontextrestored` can never fire. On
restore, every GPU resource is gone (textures, buffers, programs, render
targets); three.js re-uploads what it still holds JS-side on the next render,
but the world's *own* targets (the water sim's ping-pong pair, the caustics
accumulation target) belong to this module and have to be rebuilt explicitly
via `rebuildWorld()`.

## Boot sequence

Ordered so every `let` above is initialized before anything reads it: build
the bounds-shaped world (`createWorld()`), seed the timeline at day 0 and
build everything derived from the season (`rebuildForYear()` — the same
function the year control calls, so boot and a switch can't drift), start
enrichment loads and the render loop, then let fish models finish loading in
the background. `window.__riverBooted = true` is set only after everything
above has evaluated, telling the boot handler in `index.html` to stop
treating a later runtime failure as a fatal startup failure — from this point
on, a failure is something this module can report through `showNotice()`
itself.

The fish-load failure path dismisses the loading overlay either way: it used
to be console-only, leaving the scene dimmed under "Loading fish assets"
permanently even though the river, water and HUD all work without the fish —
a working scene the viewer can't see is worse than one that tells them what's
missing.

## See also

- `.claude/context/boids.md` — the flocking engine `main.js` drives
  (`Flock`, `REMOVE_FADE_FRAMES`, `BODY_VISUAL_SCALE`, `OVERLAP_CLEARANCE`,
  `smoothSpeed`).
- `.claude/context/data.md` — `runData`/`runYear` as a live binding,
  `loadYear`, DART parsing, and the `count` field the species split is
  checked against.
- `.claude/context/quality.md` — `QUALITY`, tier selection, and the perf
  governor `applyTier()` responds to.
- `.claude/context/plates.md` — the data-plates drawer `main.js` feeds via
  `setPlatesDay`/`updatePlatesToday`/`rebuildPlatesForYear`.
- `.claude/context/insights.md` — the `.info-btn`/insight-toast pair
  `initInsights()` wires into the HUD's passage/conditions/run-status
  fields and the season chart.
- `.claude/context/scene/sceneSetup.md` — the fixed camera and composer
  `main.js` resizes and reads `cameraTarget` from.
- `.claude/context/scene/water-and-caustics.md` — the water sim and caustics
  generator `createWorld()`/the render loop drive.
- `.claude/context/scene/fishMesh.md` — `fishRenderer`, VAT instancing, and
  the render-order note `createWorld()` cross-references.
- `.claude/context/scene/season.md` — `dayOfYear`, `setSunSeason`,
  `sweptSunDirection`, which `applySeason()` and the render loop call into.
