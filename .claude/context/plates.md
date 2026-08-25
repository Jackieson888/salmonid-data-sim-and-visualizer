# plates.js — the data plates drawer

The slide-in drawer of everything from the DART record the bar itself has no
room for: season passage vs. the ten-year mean, species composition, the
wild/hatchery steelhead split, river conditions, run history, and the
lamprey day/night split. Built lazily on first open, not at boot, since
none of it is on the critical path the bar's own numbers are, and two of
the six figures need a network round trip that has no business delaying
first paint.

Every season-x figure here shares one rule with the bar's own chart and
timeline axis: record index `i` sits at `seasonFraction(i, last)` along the
x-axis (`seasonScale.js`). That's what lets a single moving cursor line
mean the same date on every plate at once.

## LAST and syncYear()

`LAST` (last record index of the current season) is a module-level `let`,
not `const`, because the year control swaps `runData` underneath this
module and seasons differ in length (290–306 days). Every `x()` helper and
every plate-building function reads it, so a stale value would silently
rescale every figure in the drawer. `syncYear()` is the one place it's
written, and `rebuildPlatesForYear()` is what calls it.

## ALL_SPECIES

The eight DART counts at Lower Granite that have a color: the five the
flock draws (`swum: true`) and the three it doesn't (see the `--sockeye`
etc. custom properties in `style.css`). This is the shared order everywhere
a plate stacks or lists species, so the composition plate, its legend, and
its "today" bar always agree on which band is which.

## Path-building helpers

- `x(i)` computes through `seasonFraction` — the one place record index
  becomes an x-coordinate in this file.
- `areaPath(height, yFor, hasValue)` draws a filled area under a per-day
  curve. `hasValue` defaults to "always true"; a series with real gaps
  (temperature-shaped data) passes one, matching the break-the-line
  convention `buildSeasonChart` uses in `main.js` — a gap is drawn as a gap,
  never bridged.
- `stackedAreaPaths(height, series, totalFor)` draws one filled band per
  series, stacked bottom to top in `series` order. `totalFor(i)` is the
  denominator each day scales against — a fixed peak for an absolute chart,
  or that day's own sum for a 100%-stacked one — so the same function draws
  both modes of FIG. 2 (composition).

## FIG. 1 — Season Passage

The bar's own chart, full size, with the 2006–2015 daily mean traced behind
it as a ghost line so a viewer can see at a glance whether the season on
screen ran ahead of or behind the ten-year average. `buildPassagePlate`
returns `{ figure, svg, addGhost }` rather than just the figure: run
history arrives later (a network fetch, see `build()`) than the season
passage this plate is really about, so the ghost line is added to the
already-built SVG in place via `addGhost(history)` rather than the whole
figure waiting on or being rebuilt for it. `addGhost` rescales against
whichever of the current season's peak or the historical mean's peak is
larger, so the mean line never clips against the current season's own
curve.

## FIG. 2 — Species Composition

All eight `ALL_SPECIES` counts stacked, absolute or 100% (toggle button),
plus today's split as a single stacked bar and a legend. The today-bar and
legend are updated every HUD tick the same way the old `#secondary-counts`
rows were — see `todayUpdaters`.

## FIG. 3 — Wild vs. Hatchery Steelhead

`wildSteelhead` is a subset of `steelhead`, not an addition to it (see
`data.js`) — this is the one place that subset gets its own figure instead
of a footnote. "Hatchery" is not a DART column; it's estimated as
`steelhead - wildSteelhead` (see the `hatcheryEl` update in
`todayUpdaters`). Wild fish carry an intact adipose fin; hatchery fish have
it clipped before release — the same fin marked on the anatomy plate in the
fish viewer (`src/inspect.js`).

## FIG. 4 — River Conditions

Needs `loadRiverConditions()` (`data.js`) — a network round trip. The
caller (`build()`) shows a placeholder until it resolves, and replaces the
placeholder with an "unavailable" plate that names the missing year
specifically ("No river-environment record vendored for 2011...") rather
than a bare "unavailable," since nine of the ten years genuinely have no
vendored river file — that's a fact about the archive, not a bug in the
viewer. Includes a small scatter (water temperature vs. daily Chinook
passage) built only when there are more than two temperature readings for
the season — the thermal window the run actually moves through, not just
two unrelated curves sharing an x-axis.

## FIG. 5 — Run History, 2006–2015

Needs `loadRunHistory()`. Two sub-charts:

- **(a) Per-year stacked totals.** The season on screen gets the accent
  border everywhere else in this app reserves for the current reading (see
  `style.css`'s four rules); every other year gets the neutral hairline.
- **(b) Day-of-year envelope**, with the current season's daily count traced
  through it. This sub-chart's x-axis is **day-of-year**, not record index —
  a different domain from every other plate in the drawer — so it builds
  its own `ex()`/`ey()` helpers and gets its own cursor setter rather than
  sharing the shared `seasonFraction()`-based one the rest of the drawer
  uses. The envelope itself is fixed at 2006–2015 regardless of which year
  is showing, which is why the footnote in `index.html` says the average is
  inclusive of the season shown.

## FIG. 6 — Lamprey, Day vs. Night

The single richest fact the DART feed publishes and nowhere else uses:
lamprey pass mostly after dark, salmonids don't (see `data.js` on why the
day/night split is kept alongside the combined count).

## Public surface and lifecycle

- **Escape-key ordering**: the Escape-closes handler in `initPlates()`'s
  keydown listener runs *before* the focused-control guard
  (`tag === "INPUT" || tag === "SELECT"`). That ordering is the point — the
  drawer's own toggle is a button, so right after clicking it open, focus
  sits on exactly the element the guard would otherwise skip. That's the
  one moment Escape is most likely to be pressed. No other control on this
  page uses Escape for anything else.
- **Lazy build, deferred rebuild**: `setOpen()` builds on first open only.
  `rebuildPlatesForYear()` (called from `main.js`'s `setYear()` once the
  new season is assigned) rebuilds immediately if the drawer is open, or
  just marks `built = false` if it's closed — reusing the same lazy path
  first open uses. Every figure is drawn from `runData` at build time, so
  there's nothing to update in place; the honest move is to throw them away
  and draw again, which is what `build()` already does. Rebuilding six
  figures nobody is looking at (two of which fire network requests) would
  be work for its own sake.
- **`buildToken`**: incremented on every `build()`. Both async plates (FIG.
  4, FIG. 5) capture the token when their fetch starts and drop the result
  if it has moved on by the time the fetch resolves — otherwise a
  river-conditions fetch resolving after the viewer has switched seasons
  would replace a placeholder belonging to a drawer that no longer exists,
  or worse, draw last year's gauges into this year's figure.
- **Reveal stagger (`revealPlate`, `appendPlate`)**: every plate fades and
  settles in on arrival (`.plate-enter` in `style.css`) rather than popping
  in at full opacity. `appendPlate()` (used for `build()`'s six synchronous
  appends) wraps `scrollEl.appendChild` and calls `revealPlate(el)` with
  staggering on, which spaces each plate ~28ms behind the last via
  `plateRevealIndex` (reset to 0 at the top of every `build()`) so opening
  the drawer reads as one cascade down the scroll region rather than six
  figures landing at once. The two async replacements call `revealPlate(el,
  false)` directly instead — unstaggered, since each one lands independently
  whenever its own fetch resolves, not as part of the initial batch, and
  giving it a stagger delay computed from a counter that's long since moved
  on would be meaningless. `revealPlate()` uses a **double**
  `requestAnimationFrame`, not a single one: adding `.plate-enter` happens in
  the same synchronous call as inserting the element, so without waiting a
  full extra frame the browser can coalesce the "just inserted, hidden"
  state away entirely and jump straight to revealed without ever animating
  between them.

## See also

- `.claude/context/data.md` — `data.js`'s live-binding contract for
  `runData`/`runYear`, `loadRiverConditions`/`loadRunHistory`'s
  lazy-memoization, and `seasonFraction`'s single-source-of-truth role.
- Root `CLAUDE.md` — "Rules that hold everywhere" restates the
  `seasonFraction`/rebuild-hook/species-split rules this file depends on.
- `.claude/context/main.md` — `buildSeasonChart`'s break-the-line
  convention that `areaPath`'s `hasValue` mirrors, and `setYear()`, the
  caller of `rebuildPlatesForYear()`.
