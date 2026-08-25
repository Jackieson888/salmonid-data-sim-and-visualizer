# UI shell — agent context

Covers `style.css`, `inspect.css`, `index.html`, `inspect.html`. These four
files carry a deliberate "Corps-of-Engineers fish-passage report" visual
language rather than a consumer overlay — the numbers in the HUD are real
published DART counts, and the interface is styled to be read as an
instrument reading them, not a game UI floating over the scene.

## Design system (`style.css` — `:root` and shared rules)

Four rules carry the whole look, and every rule in the file is an
application of one of them:

1. Hard corners — no `border-radius` anywhere except the species keys, which
   are squares too.
2. Hairline rules and 1px borders instead of shadows, glows, or blur.
3. Uppercase Helvetica/Arial at small sizes with wide letter-spacing for
   every label; tabular monospace for every number, so digits hold their
   column as counts change day to day.
4. One accent color, used only to mark the current reading — the timeline
   cursor and the playing state. Everything else is neutral ink.

The whole HUD is one bar across the bottom of the frame, divided into
fields by vertical hairlines. It used to be a floating masthead plus a tall
panel, which cost roughly a third of the frame's height and left the
identity type sitting over open water where its small sizes were barely
readable.

Token notes:

- `--bg` — page background, visible only for the instant before the canvas
  paints its first frame.
- `--ink` — panel ink, deliberately neutral slate rather than a tint of the
  scene. The water is green (`RIVER_TINT` in `season.js`), and a
  green-cast panel would read as part of the render instead of as chrome
  laid over it.
- `--text-dimmer` — one step down from `--text-faint`, needed because the
  "Also counted" label prefix in the footnote strip has to sit visibly
  behind the figures next to it.
- `--accent` ("Engineer red") — the one saturated color in the interface,
  reserved for the current reading, never decorative.
- `--chinook`/`--jack-chinook`/`--steelhead`/`--shad` — per-species keys,
  matched to `SPECIES_COLORS` in `scene/fishMesh.js` so the table key and
  the fish in the water read as the same color.
- `--sockeye`/`--coho`/`--jack-coho`/`--lamprey` — counted at the dam but
  (mostly) not drawn in the water, in the same muted/desaturated register
  as the swum species but distinct from each other, so the composition
  plate can give them real weight without implying they're rendered.
  `--lamprey` lives in this block despite lamprey now being a swum species
  — purely historical: it was picked back when lamprey was only reported,
  and its muted brown still reads as the right color for a jawless,
  unscaled fish now that it swims too. It's still the var the key color and
  the composition/history plates read from.
- Type scale (`--t-1`..`--t-6`) — every HUD font-size maps to one of these
  six steps. Raises the floor from ~7px (0.46rem) to 10px, since the
  smallest labels were sub-legible at native size on anything but a hi-DPI
  display.
- Spacing scale (`--s1`..`--s6`) — `--s5` is the pre-existing field gutter,
  kept at its old value so nothing in the bar shifts from adding the
  others; `--field-gap` stays as an alias since it's referenced elsewhere
  and the name still says what it's for.
- `--rule`/`--rule-heavy` — rule weights shared by the plates drawer's
  figures and the bar's own accent rules, so a "heavy" line is the same
  weight everywhere it appears.
- `--dur-fast`/`--dur-med`/`--ease` — the app's whole motion vocabulary: two
  durations (120ms for a hover/focus color change or a class-toggled
  highlight, 220ms for anything that swaps content or moves a panel) and one
  plain easing, so a transition anywhere in the app reads as the same system
  rather than a pile of hand-tuned numbers. The line for a
  `prefers-reduced-motion` guard is **transform vs. not**: a pure
  color/opacity transition (every hover state, `#season-delta`'s color flip,
  the `.field-loading` dim during a season switch, the `fadeContent` dip in
  `inspect.js`) is left unguarded, matching `#fish-loading`'s own
  pre-existing unguarded opacity fade below; anything that also moves
  something in space (the plates drawer's own slide, the plates-reveal
  stagger, `#notice`'s entrance) gets an explicit `transition: none`
  override, matching `#plates`'s own pre-existing guard.

Shared cross-cutting rules: the `.label`/`.station`/`.reach`/... selector
group is every piece of non-numeric HUD text, and is most of what makes the
whole thing read as one document rather than a set of widgets. The
tabular-numeral group (`#fish-loading p`, `.readout`, etc.) is every number
in the interface, kept tabular so digits hold their column as counts tick
between days (see `updateFishCountDisplay` in `main.js`).

`#report` and `#inspect-bar` share one rule (byte-for-byte the same
treatment) rather than `inspect.css` repeating it — same reasoning as the
`#fish-viewer-link`/`#back-link` rule.

## The report bar (`#report` / `#hud`, `index.html`)

**Field 1 — identity.** `#masthead` was `max-width: 30ch`, which fit the
reach line exactly until the season became a control at the end of it — at
30ch, "2015" wrapped alone onto a second line as an orphan under "Counting
Season"; widened to 34ch. `#masthead .reach` is deliberately **not** a flex
row: the reach text wraps to two lines in this field, and as a flex
container the `<select>` becomes a sibling item of the whole wrapped block,
so it sat baseline-aligned to the *first* line while the text's second line
ran on underneath it. Left as normal inline flow, the select is just
another word in the sentence and wraps with it. `#year-select` is
deliberately quiet — no background, no chevron beyond the platform's, a
hairline that only resolves on hover/focus — since a full-weight control in
the identity block would read as the loudest thing there despite being the
least-used; `color-scheme: dark` stops the platform dropdown rendering as a
white list over a dark page.

**Field 2 — the day's counts.** `#species-breakdown` is a `<table>` rather
than a flex row of chips so counts sit in fixed columns and stop shifting
sideways as they gain/lose digits — this matters more now that they tick
continuously between days rather than changing once. `table-layout: fixed`
is what makes the four columns set by the cell widths below rather than by
whichever species has the longest name today; `width: auto` is
**deliberate** — under `fixed` the used width is the sum of the column
widths (what's wanted), whereas `width: 100%` inside a shrink-to-fit flex
item is circular, and Chromium resolves it to a literal million pixels,
silently shoving every field to the right of this one off-screen. Key
colors are keyed off each cell's own `data-species` attribute rather than
row position — they used to be positional
(`[data-species=chinook] .key:nth-child(3)` meaning "steelhead"), which
worked only as long as nothing was ever added to or reordered in the table,
and adding the three reported species broke every one of them. The
`.key.reported` treatment (dimmed label, but the key square keeps the real
species color) exists so the table never silently implies eight species are
swimming past — the distinction has to be visible without reading the
footnote. The chinook/steelhead/etc. mapping itself now lives in exactly one
place — a `[data-species="x"] { --species-color: var(--x) }` block near the
top of this file, applying globally rather than scoped to one table or
drawer — and every consumer (this table, `#plates`, and `inspect.css`'s
species picker and season sparkline) reads `var(--species-color)` instead of
re-deriving the mapping. It used to be redeclared by hand in four separate
places, which is exactly the drift risk described above; the `--species-key`
custom property this table's reported-key squares briefly read is gone
too — it was never actually set anywhere, so its fallback color always won
silently.

**Fields 3 & 4 — conditions and run status.** One treatment for both: both
are label/value pairs off the same feed (one measured at the project, one
counted at it), and giving them different looks would say they were
different kinds of reading. Row padding is tighter than an earlier 2px
because conditions grew from three rows to five (outflow, spill, dissolved
gas), and the field has to stay level with the four-row species table
beside it. `#season-delta` is the one judgement (not measurement) reading
in the bar, and one of only two other places (with the timeline cursor)
the accent appears — "below average" is styled neutral/dimmed rather than
alarmed, since a below-average run is the ordinary state of affairs, not an
error.

**Field 5 — the season chart and controls.** The only field that grows.
Laid out as a **column** — transport row, then chart/slider/axis stack —
not `[button | stack]`, because the stack's three parts must be the same
width and start at the same x (the red cursor reads against the curve
above it), and a control column beside them would indent one and not the
others. Speed controls are pushed to the far end of the transport row via
`margin-left: auto` so the row reads as two groups (state vs. pace) rather
than one undivided strip of five buttons. `.speed-btn` is tabular so ½× and
8× occupy the same width and the group doesn't reflow as the selection
moves. `#timeline` is fully custom (not the default pill-track/round-thumb
control, the single most consumer-looking element a page can have) — it's
a gauge: a hairline track with a red cursor bar standing on it. `#timeline`
axis month ticks are positioned absolutely from percentages written by
`buildTimelineAxis()` in `main.js`; their labels are real `<button>`s now
(clicking jumps to the first counted day of that month, via a delegated
handler in `main.js`), styled as the label they already were — no border,
no background, full ink only on hover. The chart's `svg` height was
trimmed from 38px when the transport row was added above it, since the bar
had to absorb that row's height somewhere. The `viewBox` is stretched to
the field's width via `preserveAspectRatio="none"`, which is what keeps
the chart's x-axis identical to the slider's below it (stroke widths
stretch too, hence `non-scaling-stroke` on the temperature path). The chart
and month axis are both inset by half the slider cursor's width
(`margin: 0 1.5px`) — the cursor's travel is inset by that much from the
input's own box, and this is what puts a given date at the same x in all
three elements.

**Season-switch dimming (`.field-loading`).** `setYear()` (`main.js`) adds
this to `#passage`/`#conditions`/`#run-status`/`#controls` for the duration
of the year fetch — the only acknowledgment (opacity only, via the shared
`.field` transition) that the figures on screen belong to the season about
to be replaced, not the one just selected. `#masthead` is deliberately left
out: `#year-select`'s own `:disabled` styling already marks it, and dimming
the whole identity block underneath it too would be the same acknowledgment
said twice.

**Footnote strip.** Provenance. Used to also carry the reported-but-unswum
species as a row of figures ("Also counted"); that moved to the plates
drawer's FIG. 2/3, where it gets a real chart instead of an 8px aside.

**Loading overlay (`#fish-loading`).** Shown while `loadFishAssets()`
(`main.js`) loads and bakes the per-species GLBs — real async work the
canvas otherwise gives no sign of (just empty water), since the fish
`InstancedMesh` doesn't exist yet. Faded out, not removed, once the fish
renderer is ready. A determinate-looking sweep bar rather than a spinner,
since a rotating circle is the one shape this interface has otherwise
ruled out. Under `prefers-reduced-motion: reduce` the sweep animation is
suppressed (bar holds a third of the way across, still marking the page as
busy) — the 3D scene itself is handled separately, booted paused in
`main.js`, since no CSS rule can stop a WebGL render loop.

**Corner nav link (`#fish-viewer-link`/`#back-link`).** Byte-for-byte the
same treatment on both pages, one shared rule.

**Failure notice (`#notice`).** Top-center rather than in the report bar:
it isn't a reading, and has to be legible in the one case where the report
bar itself may never have been populated. `.warn` (muted rule, no accent)
is for an interruption the scene expects to recover from on its own
(WebGL context loss), distinct from something the viewer has to act on.
Shows/hides via a `.shown` class rather than animating `[hidden]` directly
(a `display: none` boundary can't transition across): `showNotice()`
(`main.js`) unhides first, forces a reflow, then adds `.shown` — adding it in
the same tick as the unhide would let the browser coalesce the two and skip
the entrance transition entirely. `index.html`'s inline boot-failure
script — the one other path that can show this element, for a failure
`main.js` never got far enough to report itself — repeats the same
three-step sequence for the same reason. `hideNotice()` (`main.js`) is the
reverse: removes `.shown`, then defers the actual re-hide by a fixed timeout
rather than trusting `transitionend`, the same guarantee-over-elegance
reasoning as `dismissLoadingOverlay` (see `.claude/context/main.md`) — a
backgrounded tab or reduced motion can mean that event never fires.

**Insight toast (`#insight-toast`, `.info-btn`).** Same top-center slot and
entrance/exit convention as `#notice` just above (unhide → forced reflow →
`.shown`; hide removes `.shown` then defers `hidden = true` on a timeout, not
`transitionend`) — full rationale, including why it's built once in
`src/insights.js` and shared by both pages rather than duplicated, lives in
`.claude/context/insights.md`. `.info-btn` is a 14px hairline **square**
carrying "i", not a rounded badge — the species-key swatches are this app's
only round-corner exception, and they're squares too.

**Debug panel (`D` key).** Shifted to `top: 56px` (down from the corner) to
clear `#plates-toggle`, which took the primary top-right spot — this is a
hidden-by-default dev readout, the toggle is a real control.

**Plates drawer (`#plates`, see `src/plates.js`).** Overlays the canvas
rather than resizing it, since the underwater vignette in
`scene/sceneSetup.js` is tuned to the canvas's current on-screen size, and
shrinking it to make room would need a shader retune this pass doesn't do.
`#plates-toggle` needs its own `z-index: 2` because it's also the drawer's
close control (becomes "Plates ✕", see `setOpen` in `plates.js`) and
`#plates` comes after it in the DOM — without an explicit stacking order,
the open drawer painted straight over the only way to shut it.

**Plate reveal stagger (`#plates-scroll > *`, `.plate-enter`).** Every direct
child of the scroll region — the six figures, `#plates-titleblock`, and
whichever placeholder or real plate currently occupies FIG. 4/5's slot —
fades and settles in on arrival rather than popping in at full opacity the
instant it lands in the DOM. `plates.js`'s `revealPlate()`/`appendPlate()`
stagger the initial batch (`build()`'s six synchronous appends) by ~28ms per
plate via an inline `transition-delay`, so opening the drawer reads as one
cascade; the two async replacements (FIG. 4/5, whichever of their real or
"unavailable" plate eventually lands) fade in unstaggered, since each arrives
independently over the network rather than as part of one coordinated batch.
Scoped to `#plates-scroll`'s direct children rather than a `.plate-reveal`
class added to each plate, since every one of those children already *is* a
direct child in build order — no separate class taxonomy needed just to say
"everything in this container, in the order it arrived."

**Scrollbars.** Thin, square-cornered, drawn from this file's own tokens
rather than a light platform-default bar inside a dark panel. Shared (not
duplicated) between `#plates-scroll` and `#inspect-panel` since it applies
to scrollable chrome on both pages. Firefox reads `scrollbar-color`;
Chromium/WebKit reads the `::-webkit-scrollbar*` pseudo-elements.

**Responsive breakpoints.**
- `1280px` — one row of five fields needs real width (moved up from 1100px
  once the run-to-date comparison became its own field). Below it the bar
  wraps to two rows rather than crushing the chart, the field that
  degrades worst when squeezed. The four text fields stay side by side with
  their dividers; only the chart drops to its own row, so it's the only
  field whose divider moves from left edge to top.
- `900px` — four text fields in one row is too many (the species table
  alone is ~36ch). Conditions and run-status drop to their own paired row.
- `640px` — stacked, the five fields ate 744px of an 812px phone screen: the
  bar became the page. Below this width the layout switches to a
  **two-column grid** instead of a column, which roughly halves the height
  while the chart keeps full width. Grid items are `min-width: auto` by
  default, so the fixed-width species table (`table-layout: fixed` with
  `ch`-sized cells) refused to shrink and pushed its track wider than `1fr`
  said — this blew both columns past the viewport (conditions ran off the
  right edge and took the chart with it) until `.report-body > .field {
  min-width: 0 }` was added. The vertical hairlines that divide fields in a
  row would draw down the middle of the left grid column only, so they're
  turned off here and the grid's own gaps do the dividing. Month labels are
  thinned by measurement (`thinMonthLabels` in `main.js`) rather than a CSS
  rule hiding every other one — an earlier `display: none` rule fought that
  pass, since a hidden label has a zero-width rect the measurement can't
  reason about.

## Fish viewer chrome (`inspect.css`)

Layered on top of `style.css`'s shared tokens/reset rather than redefining
them, so `inspect.html` reads as the same interface as the river view. Two
pieces of chrome, split the way the river view is split: `#inspect-bar`
along the bottom holds everything that isn't reading-one-species'-notes
(species, view state, adult length, this species' season — this page's
transport row plus its passage/conditions fields, all in one bar), and
`#inspect-panel` on the right holds *just* the field notes for whatever's
selected. Length and season used to live in the panel too; they moved to
the bar because a fixed 300px column squeezed the length silhouettes
narrower than they read well at, and the bar has width the panel doesn't.

**`#fish-canvas`/`#fish-loading` vertical shift.** `frameCamera()`
(`src/inspect.js`) centers the fish in the *full* canvas — the whole
viewport, including the region `#inspect-bar` now sits over — so at rest
the fish reads as sitting too low, off-center in the space that's actually
visible above the bar. Shifting the rendered image up by half the bar's
measured height (`translateY(calc(var(--bar-h, 170px) * -0.5))`, `--bar-h`
written by the `ResizeObserver` in `resize()`, `src/inspect.js`) recenters
it in the visible region without touching the 3D camera/target math at
all — a pure compositing-layer transform, free to paint and correct at any
viewport width the bar reflows to. `#anatomy-overlay` deliberately does
**not** get this transform, even though its leader lines track the same
shifted fish: its label positions are already independently clamped to the
true visible band (`bandTop`/`bandBottom` vs. `barRect.top`, in
`renderAnatomyOverlay`, `src/inspect.js`), and at a squeezed viewport
height that band can already reach close to y=0 — a blind CSS shift of the
whole overlay pushed those already-correctly-bounded labels up off the top
of the screen. Only the leader-line's fish-anchored endpoint needed to
move, via the `shiftPx` offset baked into the overlay's own pixel math.
`#fish-loading` keeps the shift purely so the loading indicator doesn't sit
at a different height than the fish it's covering for.

**`#inspect-panel` anchoring.** `bottom: calc(var(--bar-h, 170px) + 14px)`
— anchored above `#inspect-bar` rather than a fixed distance from the
viewport bottom, tracking the bar's own measured height (written in
`resize()`, same as above) at every breakpoint the bar reflows to. The
170px fallback only matters for the instant before that first measurement
lands.

**`#inspect-bar .report-body { display: flex; flex-wrap: wrap; }`.**
`display: flex` has to be reasserted, not just `flex-wrap`, because
`style.css`'s own `@media (max-width: 640px)` switches the bare
`.report-body` class to a 2-column grid for the river's bar — a rule this
page would otherwise inherit too. This selector's extra `#inspect-bar`
specificity wins at every width, which is wanted here: the grid was tuned
for the river's five fields (with `#masthead`/`#passage`/`#controls`
grid-column overrides that don't exist on this page), and plain wrapping
suits four fields of very different natural widths better than forcing
them into two rigid columns. An earlier version left `display` out and the
grid's stray 2nd field silently overflowed the viewport at ≤640px.
`#length-field` is the one field that grows (`flex: 1 1 320px`) — same
reasoning as `#controls` in the river bar — since it's the field a
silhouette actually benefits from extra width.

**Species picker.** A list, not a `<select>`: the whole roster is readable
at rest, each row keyed with that species' own water tint. `.species-key`
reserves a 2px left border on every row (not just the selected one) so
selecting a species doesn't shift the other four rows' text sideways.

**View controls.** `.toggle-btn` is styled after `.transport-btn`/
`.speed-btn` in `style.css` — a hairline border that lights to accent when
pressed, rather than a native checkbox, which would read as a browser form
control dropped into an otherwise fully custom instrument panel.
`#construction-toggle b` (the live stage name while the construction loop
runs, see `tickConstruction` in `inspect.js`) is pushed to the row's
trailing edge like a value readout, and is empty (invisible) whenever
construction is off.

**Turbidity slider (`.range-field`, generic name).** Thin hairline track,
square thumb matching `.toggle-mark`/`.species-key`'s state-marker device,
filled to the current value via a layered `background-image` gradient
rather than the unstyleable-cross-browser
`::-webkit-slider-runnable-track` fill — one gradient rule works in every
engine instead of three vendor-prefixed ones drifting out of sync. `--fill`
is written per-input by `inspect.js` on every `input` event (min/max/value
aren't visible to CSS on their own), as a percentage. The class is generic
(`.range-field`, not `#turbidity-field`) because "Construction" used to be
a slider styled the same way before it became a toggle button — kept
general in case a future control wants a slider again.

**Adult length scale.** All five species on one scale so the comparison is
something you *see* rather than compute from two numbers. Each row's
indicator is a real fish silhouette spanning the species' min–max range,
not a plain rectangle — traced from the actual GLB models
(`scripts/render-fish-silhouettes.mjs` rasterizes each one's bind pose from
a true orthographic side view to `public/silhouettes/*.png`) rather than
hand-drawn, so the shape is this project's own fish. Applied as a CSS
`mask` over a solid fill (`.len-fish`) rather than an `<img>`, which is
what lets it recolor the same way a plain bar did (line color at rest,
accent when current). `.len-name` is `11ch` wide — `ch` measures the width
of "0" in the current font, which under-measures spaced uppercase capitals
badly; at 8.5ch every row but "Shad"/"Jack" ellipsised into
"CHINO…"/"LAMP…", which names nothing. `.len-track` no longer has a fixed
height: a fish's height now follows from its width via its real
`aspect-ratio` (see below), so `min-height: 8px` is just a floor stopping
the thinnest species (lamprey, ~10:1, scaled further by
`LENGTH_FISH_SCALE`) from collapsing to a sliver. It's `display: flex;
align-items: flex-end` rather than plain block flow, because when that
floor is what's actually setting a track's height (lamprey), a shorter
fish would otherwise sit flush at the *top* of the extra space in normal
block flow instead of resting on the hairline the way every taller
species' fish fills its track completely. `.len-fish` is in normal flow,
not `position: absolute` — an absolutely positioned child is taken out of
the flow that would otherwise size `.len-track` to match it, so the track
collapsed to `min-height` while the fish rendered taller/shorter and
overflowed or left a gap; horizontal placement moved to inline
`margin-left` (set per-row in `buildLengthScale`) since that resolves
against the track's width the same way `left` did. The mask is stretched
to exactly fill the element's box (`mask-size: 100% 100%`) — safe
specifically because the box's aspect ratio is locked to the source PNG's
real aspect ratio via the per-species `aspect-ratio` rules, so "stretch to
fill" and "preserve proportions" are the same operation there; width is set
inline per row to the species' min–max span, height falls out of that
width via `aspect-ratio` rather than being set independently (the fix for
silhouettes that used to render visibly stretched/squashed depending on a
given species' span width). The per-species `aspect-ratio` values are each
PNG's own real pixel dimensions as logged by
`render-fish-silhouettes.mjs`, not rounded guesses — update them if that
script's numbers ever change. Jack Chinook has no model of its own (see
`SPECIES_MODEL_URL` in `scene/fishMesh.js`); `buildFishSilhouette` gives
its element `data-species="chinook"` outright rather than a second
selector here.

**Season card (`.spark`).** This species' own daily passage, on the same
x-axis and √ scale as the river's chart and every plate. `.spark-axis`
labels are absolutely positioned from the same `seasonFraction` the axis
rules are drawn at (`buildSparkAxis`), not spaced evenly, since the
counting season starts partway through March and months aren't equal
fractions of the track — same arrangement the river's own month axis uses.

**Field notes (`.fg-*`, see `SPECIES_FIELD_NOTES` in `src/inspect.js`).**
Facts are grouped under small category labels (Migration, Life history,
Conservation) rather than run together as one flat list, so a visitor
curious about one thing can find it without reading every fact. Only
categories with something to say for a given species render at all (see
`updateFieldGuide`). `.fg-list` uses a hairline-ruled tick (`::before`)
instead of a bullet glyph, matching the anatomy overlay's own tick marks
rather than a browser-default disc.

**Anatomy overlay (`#anatomy-overlay`).** Leader lines projected from the
fish's actual animated vertices each frame (see
`.claude/context/scene/fishAnatomy.md` and `renderAnatomyOverlay` in
`src/inspect.js`). Positioned in pixel space via its `viewBox`, not CSS
layout, so it can sit exactly on top of the WebGL canvas.

## HTML shell (`index.html`, `inspect.html`)

- **Favicon.** An explicit `<link rel="icon">` on both pages, not just for
  the tab — without one the browser requests `/favicon.ico` on every load
  and the resulting 404 lands in the console, which
  `scripts/screenshot.mjs` treats as a build failure (its only signal for
  a GLSL compile error, since a broken shader doesn't throw — it just stops
  drawing).
- **Social card (`index.html`).** `og-image.png` is a real capture of the
  running scene at day 118 (peak shad), generated with
  `scripts/screenshot.mjs` — regenerate it from there rather than
  hand-making one, so the preview can't drift from what the page actually
  looks like. `og:image:alt`/`twitter:image:alt` aren't decorative: they're
  what a screen reader announces in a timeline, where the image is the
  card's only content.
- **Boot-failure classic script (`index.html`).** `main.js` is a module, so
  if it — or anything it imports, `data.js` especially — throws while
  evaluating, *nothing* in it runs, including its own error handling. The
  inline classic `<script>` is the only thing that can still report that,
  since it has already executed by the time the module fails. Without it, a
  boot failure is a permanently dimmed canvas under "Loading fish assets"
  and one console line the viewer will never open. It self-disables once
  `main.js` sets `window.__riverBooted`, since errors after that point are
  runtime problems `main.js` can report itself, and aren't necessarily
  fatal.
- **HUD field comments (`index.html`).** The five `.field`s are numbered
  1–5 in the markup comments (identity/reading, day's counts, conditions,
  run-to-date, season+controls) — see the "The report bar" section above
  for the reasoning behind each; the HTML comments are intentionally now
  just a field-by-field map, not a restatement of the CSS rationale.
- **`inspect.html` turntable/construction/turbidity.** Turntable defaults
  off (see "View controls" above). The construction toggle loops the fish
  continuously through five build stages — the real armature (`vat.bones`
  in `scene/fishMesh.js`), a wireframe pass, flat unpainted polygons, the
  real texture under plain diffuse light, and finally the full
  caustics/specular/rim treatment every other view already shows —
  crossfading stage to stage rather than cutting (see
  `applyConstruction`/`tickConstruction` in `src/inspect.js`). Turbidity
  pushes this material's own `uFogDensity`/`uFogColor` (normally unset on
  this page — see `setBounds`' notes in `.claude/context/scene/fishMesh.md`)
  plus a small drifting-silt field (`buildInspectParticles` in
  `src/inspect.js`); left at 0 it changes nothing about the default view.
  The page was previously a shader-tuning rig (nine material sliders, speed
  and amplitude) — all removed, since the shipped tuning now lives in
  `MATERIAL_OVERRIDES` in `fishMesh.js` and re-tuning means editing that
  directly (the old rig is recoverable from git history).

## See also

- `.claude/context/main.md` — the river page this HUD belongs to.
- `.claude/context/inspect.md` — the fish-viewer page logic
  (`buildFishSilhouette`, `renderAnatomyOverlay`, `buildLengthScale`, etc.)
  that this CSS renders.
- `.claude/context/plates.md` — the plates drawer markup this CSS styles.
- `.claude/context/scene/fishMesh.md` — `SPECIES_COLORS`/
  `MATERIAL_OVERRIDES` the species key colors and turbidity fields key off.
- `.claude/context/scene/fishAnatomy.md` — the anatomy anchors
  `#anatomy-overlay` renders.
- `.claude/context/insights.md` — `.info-btn`/`#insight-toast`, styled from
  this file's tokens and following `#notice`'s own entrance/exit and
  top-center placement conventions.
