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
container the year control becomes a sibling item of the whole wrapped
block, so it sat baseline-aligned to the *first* line while the text's
second line ran on underneath it. Left as normal inline flow, the control is
just another word in the sentence and wraps with it — `display: inline-flex`
on `#year-select` (below) still participates in that flow as one atomic
inline box, the same as the `<select>` it replaced.

`#year-select`/`#year-listbox` — a hand-built listbox, not a native
`<select>`. `color-scheme: dark` was tried first (the platform popup's own
attempt at theming), but Chromium's select dropdown on Windows ignores it in
practice and rendered as a stock white listbox with a blue selection color
sitting over this page's otherwise entirely dark chrome — the one element in
the app not drawn from its own tokens, because it wasn't actually drawn by
the app at all. It also had no chevron by design ("deliberately quiet"), and
that quietness read as broken rather than restrained: a plain underlined
word in the identity block gave no signal it was a control at all. Both
problems needed the same fix — draw the whole thing, closed and open state
both, from `style.css`'s own tokens — so the native element is gone.

`#year-select` is now a `<button>`: the same quiet hairline-underline
register as before (transparent background, border only resolving on
hover/focus/open), but with a small `.chevron-icon` (shared with
`#report-toggle`/`#inspect-bar-toggle`, rotating 180° via
`[aria-expanded="true"]` the same way theirs rotates via
`[aria-pressed="true"]`) as the explicit "this opens something" affordance
the old control lacked. `#year-listbox` is a real `<ul role="listbox">` of
`<li role="option">`s, populated from `AVAILABLE_YEARS` in `main.js`, styled
like every other panel in the app (hard corners, hairline border, `--ink`
background) rather than inheriting a platform popup's own chrome. The
currently-loaded season gets `--accent` text (`aria-selected`, the same
current-reading convention as `.speed-btn[aria-pressed="true"]`/
`#season-delta.above`); the keyboard/mouse-highlighted row gets a neutral
`--line-soft` background (`.active`, mirrored by a plain `:hover` rule) —
kept as two distinct signals so browsing the list with arrow keys never
reads as if it had already changed the season.

`#year-listbox` is a **fixed-position sibling of `#report`**, not a
descendant — `#report` carries `max-height: 70vh; overflow-y: auto` (see
"Height safety net" below), which would otherwise clip a 21-item popup the
instant it grew taller than whatever sliver of `#report` was visible, in
either direction. This is the same reason `#report-toggle` sits outside
`#report` rather than inside it. Because it's `position: fixed` rather than
positioned against an ancestor's box, `main.js`'s `positionYearListbox()`
computes its `left`/`bottom` directly from `#year-select`'s own
`getBoundingClientRect()` on every open — anchored **above** the button
(`bottom`, not `top`) since the trigger sits near the bottom of the screen
inside the HUD bar, where opening downward would run the list straight off
the viewport edge. `max-height` is clamped to the room actually above the
button (`rect.top - gap - 8`, capped at 260px) rather than a flat guess, so
a short or landscape viewport gets an internally-scrolling list instead of
one silently clipped by the browser's own edge — the same measured-not-
guessed instinct as `#report`'s own 70vh cap and `thinMonthLabels`.
`main.js` closes the list outright on `resize` rather than repositioning it
live, since nothing else in this control needs to track a moving anchor
continuously and a stale fixed position from before the resize would be a
worse bug than a closed dropdown.

Keyboard handling lives on `#year-listbox` itself (Arrow Up/Down, Home/End,
Enter/Space, Escape) and every one of those handlers calls
`e.stopPropagation()` — not just `preventDefault()`. The page's own global
`keydown` listener further down `main.js` binds several of the same keys
(Home/End/arrows) to the timeline transport, and already knows to skip a
focused `INPUT`/`SELECT` — but `#year-listbox` is neither; it's a `<ul
tabindex="-1">`, focused programmatically rather than by Tab. Without the
`stopPropagation()`, arrowing through years would also step the timeline
underneath the open list. Closing is on `pointerdown`, not `click`, so a
drag that ends outside the list still dismisses it, matching how native
`<select>`/menu popups behave.

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

**Collapsed report (`#report.collapsed`).** Shows identity (`#masthead` in
full — station, `h1`, reach/year-select, readout) and just the daily-total
line of field 2 (`#passage .field-head`, not `#species-breakdown`), plus the
transport row. Everything else (species table, conditions, run-status,
chart/axis, footnote) is hidden. Used to hide `#masthead`'s station/h1/reach
too, leaving only the readout row — widened to the full identity block since
a collapsed HUD with no station/title read as anonymous.

**Collapsed-on-mobile drops to just the three things a phone viewer needs
while the sim runs** (inside the `640px`/`500px` narrow-viewport breakpoint
below, scoped to `#report.collapsed` there — same class the manual toggle
uses, just an additional rule set that only binds at that width/height).
Where the desktop collapsed view keeps the full identity block +
daily-total line + transport row stacked (above), a phone instead shows
only `#date-label`, `#fish-count`, and `#play-pause` — plus the dam code as
a free bonus, since it rides along on the date line at no extra height cost.
Everything else this scope hides (the season/year picker, the day-ordinal,
the Peak-seek button, the dam's full name) stays reachable by expanding the
bar (the chevron tab) into the full mobile view, which is unaffected by any
of this.

- `.report-body` becomes a single flex row instead of the wrapped flex row
  the desktop collapsed view uses. `#masthead` grows (`flex: 1 1 auto`) to
  fill the leading space; `#passage` and `#controls` sit at the trailing
  edge sized to their own content, so the date, the count, and Pause read
  as one inline instrument line — `#fish-count` lives in `#passage`, a
  different field (different DOM parent) than `#masthead`, so this is a
  layout placement, not a markup move.
- `#masthead` itself becomes a `flex-wrap: wrap` row for its own children.
  `.station` and `.reach` (the year-select row) are hidden outright. `h1`
  shrinks from the title-sized `"LWG · Lower Granite Lock & Dam"` lead down
  to just the dam code — the split lives in markup (`h1` wraps `"LWG"` in
  `.dam-code` and the rest in `.dam-name`), and this scope hides
  `.dam-name` so only the code remains, sharing a row with `.readout`
  (which drops `#day-ordinal`, keeping only `#date-label`). A
  `.readout::before` supplies the `·` divider that used to just be the line
  break between the dam name and the reach text below it.
- `#passage`'s field-head uses the same full/short label pair as the
  desktop collapsed view already needed elsewhere: `.label-full`
  (`"Daily adult passage"`) hidden, `.label-short` (`"Count"`) shown, so
  the label + `#fish-count` fit inline without widening the row.
- `#timeline-block` (chart, slider, and axis together) is hidden outright
  here — a phone viewer who wants to scrub dates has already expanded the
  bar to reach it, so it isn't worth the row this compact view is built to
  avoid. That leaves `#controls` down to `#transport` with `#to-peak`
  hidden too, i.e. just the Pause button — which needs its own override
  here, since `#controls`'s base rule (`flex: 1 1 auto; min-width: 240px`)
  is sized for holding the whole transport-row-plus-timeline-stack it
  normally does; without the override that 240px floor would force this row
  to wrap or overflow at phone width.
- `.report-body`'s `gap` (`--field-gap`, 22px — a between-fields gutter
  sized for a desktop row) is replaced outright with a `column-gap` of a
  few px plus a small `row-gap` as a wrap fallback, since 22px between
  three items on one row would blow past this view's width budget.

Measured at 393×852: the collapsed bar comes in around 53px, under the
~80px target — cutting the timeline bought back more room than expected,
since Pause no longer needs a row of its own either.

**Collapse animates, not toggles.** Every element the collapsed state hides
transitions out instead of snapping to `display:none`, via
`transition-behavior: allow-discrete` + `@starting-style` (the modern way to
run a transition across a `display:none` boundary at all — a transitioning
property still jumps instantly at that boundary without it; unsupported
browsers just get today's instant toggle, no breakage). Two techniques,
picked by shape, not one applied everywhere:
- **Self-contained pieces with a known, bounded height**
  (`.report-foot`, `#species-breakdown`, `#season-chart`, `#timeline-axis`)
  get a real `max-height` transition. The cap on each is picked *close to*
  its real content height (measured across breakpoints, not a big round
  number) — `#timeline-axis`'s 13px is literally its own fixed `height`
  elsewhere in this file; `#season-chart`'s 90px and `#species-breakdown`'s
  96px are generous-but-tight estimates with real headroom (measured real
  heights top out around 63px/80px in practice). A cap much larger than the
  content would reach its true height early and then visibly "keep
  animating" doing nothing for the rest of the duration — the failure mode
  that ruled out one blanket cap for all four.
- **Whole fields leaving the flex row** (`#conditions`, `#run-status`) fade +
  scale (`opacity`/`transform: scale`) instead of animating width. This is a
  deliberate scope cut, not an oversight: `.field + .field`'s hairline-border
  divider system and the breakpoint-specific `flex-basis` rules further down
  this file would both need re-deriving to animate a field's own width to 0
  safely, and that risk wasn't worth it for two fields. They keep their
  layout width for the fade's duration and only reflow the row at the very
  end when `display:none` lands — a smaller, later snap than today's instant
  pop, not a fully width-animated one. `#passage .field-head`'s own
  divider (margin/padding/border-color) rides the same duration so it
  collapses in sync with `#species-breakdown` rather than snapping the
  instant that table's `display` flips; `.field`'s own `border-left-color`/
  `padding-left` do the same for the collapsed row's other dividers.
  `border-*-color: transparent` is used throughout instead of `border: none`
  for exactly this reason — a color can transition, removing a border
  outright can't.
All of it is guarded under `prefers-reduced-motion: reduce` (max-height/
transform both move something in space, so they get the explicit
`transition: none` this file's four-rule motion system reserves for that
case — plain `opacity` alone wouldn't need it).

**Collapse/expand handle, redesigned as an icon tab.** `#report-toggle` used
to be a right-aligned "Collapse"/"Expand" text button floating above the bar
with a gap. It's now a small tab **centered** on the bar's own top edge
(`align-self: center`, not `flex-end`), with no bottom border and
`margin-bottom: 0` so it sits flush against `#report`'s own accent top
border — reads as a handle welded onto the panel, the same idea as a bottom
sheet's own drag handle, rather than an unrelated floating control. The
label is a `.chevron-icon` SVG (shared with `#inspect-bar-toggle`, inspect.css)
instead of text: down at rest ("tap to collapse, push this down"), rotated
180° once collapsed ("tap to expand, pull this up") — the accessible name
moved from `textContent` (there's no text node left) to a JS-written
`aria-label` (`setReportCollapsed()`, `main.js`), toggled the same way the
text used to be.

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
close control (becomes "Plates ✕", see `createDrawer()` in `drawer.js`) and
`#plates` sits at `z-index: 1` — without that ordering, the open drawer
would paint straight over the only way to shut it. `#plates`'s own
`z-index: 1` is also what puts it in front of `#hud` (the river's bottom
bar, `z-index: auto`) when open, rather than stopping above it — the same
rule (`#plates, #inspect-panel`, just below) drives the fish viewer's
field-notes drawer identically, and both pages' open/close/Escape behavior
comes from the one `createDrawer()` implementation in `drawer.js` rather
than two hand-kept-in-sync copies (see `.claude/context/drawer.md`).

**Shared drawer chrome (`#plates, #inspect-panel`).** Position, `z-index:
1`, background, border, the slide `transform`, and the reduced-motion guard
are one rule (`style.css`) rather than `inspect.css` repeating it — same
`#report`/`#inspect-bar`-style reasoning as everywhere else this file shares
a treatment across pages. Each page still sets its own `width` (`#plates`:
400px; `#inspect-panel`: 320px, narrower since a phone viewport has less
room to spare against the fish behind it) and its own top clearance for its
own toggle button (`#plates-scroll`'s `padding-top: 52px` vs.
`#inspect-panel`'s own `padding-top: 52px`, `inspect.css`) — real
content-driven sizing, not chrome, so it stays out of the shared rule.
`#inspect-bar-toggle` (the fish viewer's bar collapse handle) deliberately
carries no explicit `z-index` any more (was `1`, tied with `#inspect-panel`
and — later in the DOM — winning that tie, which kept the collapse button
clickable on top of an open field-notes drawer): at the implicit
`z-index: auto` it still paints above `#inspect-bar`/`#fish-canvas` from DOM
order alone, but now the open drawer covers it, the same way `#plates`
covers the river's `#report-toggle` (a plain `#hud` child, no `z-index` of
its own) when open.

**Dedicated close control (`.drawer-close`, `#plates-close`/
`#field-notes-close`).** `#plates-toggle`/`#field-notes-toggle` used to do
double duty — open the drawer, and (once open) close it too, its own label
flipping to "Plates ✕"/"Field Notes ✕" to say so. They're now
**open-only**: static markup, no more JS-written label (see `drawer.js` —
`label` was dropped from `createDrawer()`'s options entirely once nothing
read it), reading "Plates"/"Field Notes" whenever visible. Closing is a real
icon button (`.close-icon`, an SVG ×), and a genuine DOM **child** of
`#plates`/`#inspect-panel` — unlike the toggle (a page-level sibling kept
that way deliberately, see "The report bar"/"Fish viewer chrome" above),
this one has nowhere else it needs to be measured from, so it can just be
part of the panel. Positioned **top-left**, not top-right: top-right is
already the toggle's own corner, and stacking a second control there would
overlap it. Goes off-screen for free whenever its panel is closed, riding
the parent's own `transform: translateX(100%)` — no separate visibility
rule needed. Wired up in `drawer.js`'s `createDrawer()` (`closeButton`
option): clicking it closes the drawer and returns focus to `toggle`,
identical to what Escape already does, so keyboard/focus behavior doesn't
depend on which of the three ways of closing (toggle, close icon, Escape)
was used.

**The toggle hides itself once open** (`#plates-toggle[aria-pressed="true"],
#field-notes-toggle[aria-pressed="true"] { display: none }`, `style.css`) —
a second "open" control sitting right next to the new close icon read as
clutter now that closing has its own dedicated affordance, and hiding it
also frees the top-right corner it used to occupy. `createDrawer()`
(`drawer.js`) moves focus to `closeButton` on open specifically so this
doesn't strand keyboard focus on an element that just vanished; every
existing close path (`closeButton`'s own click handler, Escape, or clicking
`toggle` itself — still a genuine toggle under the hood, just with nothing
visible to click once open) sets `aria-pressed` back to `false` *before*
refocusing `toggle`, so it's visible again by the time focus actually lands
there.

That `closeButton.focus()` shipped with a real bug the first time: without
`{ preventScroll: true }`, focusing an element still mid `transform:
translateX(...)` (the drawer's own slide-in, just started) reads as
off-screen to the browser's implicit scroll-into-view, and it scrolled
`document.body.scrollLeft` to "reveal" it — visibly dragging the whole
page, canvas included, left for the ~300ms the slide-in transition took to
catch up. This is a different mechanism than the overlay-not-resize
decision this section documents elsewhere (nothing here was ever laying
the canvas out narrower — it's a scroll offset applied to the whole
document, not a box resize) but the *symptom* reads the same to a viewer:
the canvas appearing to shift when a drawer opens. See
`.claude/context/drawer.md` for the fix and the measured before/after.

**`#field-notes-head` fills the freed corner.** The fish viewer took this
one step further: `.field-head` (the "FIELD NOTES / Steelhead" line) used
to be the first thing `updateFieldGuide()` built inside `#field-guide`,
starting well below the fold once `#inspect-panel`'s `padding-top` cleared
`#field-notes-toggle`. It's pulled out into its own stable element,
`#field-notes-head` (`inspect.html`), sharing the panel's top row with
`.drawer-close` instead — `position: absolute`, `left` clearing the close
button (12px offset + 28px width + a gap), `right` matching the panel's own
right padding. `#inspect-panel`'s `padding-top` drops from 52px (sized for
the old corner *button*) to 46px (sized for `.drawer-close` alone, the
taller of the two things it now needs to clear). `updateFieldGuide()`
(`inspect.js`) no longer builds a `.field-head` as part of what it
`replaceChildren()`s — it just writes the species name into
`#field-notes-species-name`'s `textContent` directly (see
`.claude/context/inspect.md`, "Species-switch content fade," for why that's
not part of the fade either). A stacked (2-line) version of this header was
tried first and rejected: it grew taller than `.drawer-close`, so
`padding-top` couldn't actually shrink — the whole point. It stayed the
base rule's single-line flex row instead, with the name's own font-size
brought down from the base rule's `--t-5` (sized for a much wider
`.field-head` elsewhere in the app) plus `white-space: nowrap` +
`text-overflow: ellipsis` (and the `min-width: 0` a flex item needs for
that ellipsis to actually engage) as a backstop against the one common name
long enough to threaten it, "Jack Chinook Salmon" — measured to fit without
truncating in practice, but the row is only 255px wide here (`#plates`' own
copy of this idea, `.plate-caption`/`.plate-title`, has the full width of a
400px drawer to work with and doesn't need this).

**`#plates` didn't get the same treatment** — `.plate-caption`
("FIG. 1 SEASON PASSAGE") already sits close to the top of each figure by
its own nature (a compact caption row, not a page-title-sized `.field-head`
line), so there wasn't the same empty band to reclaim once `#plates-toggle`
started hiding itself. This is a fish-viewer-specific refinement, not
something the drawers disagree on.

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

**`#inspect-panel` anchoring.** Full height (`inset: 0 0 0 auto`, from the
shared `#plates, #inspect-panel` rule above), not anchored above
`#inspect-bar` — that was tried first (`bottom: calc(var(--bar-h) + 14px)`),
but a viewport short enough to push the bar toward its own 70vh cap left
almost no room for the panel above it, squeezing "Field notes" down to an
unreadable sliver whenever both were open together. Running the panel the
rest of the way to the true bottom — same full-bleed idiom `#plates` uses on
the river page, `z-index: 1` and all — costs nothing, since the drawer now
paints in front of `#inspect-bar` rather than needing to stop above it.

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

**Collapsed bar (`#inspect-bar.collapsed`).** Shows just the species picker —
`#view-field` (swim/turntable/reset and the rest) is hidden entirely, not
just its secondary toggles, so a small/short viewport's one tap opens
straight onto species selection. `#species-list` switches from a stacked
column to a CSS grid (`repeat(auto-fit, minmax(150px, 1fr))`) rather than
plain `flex-wrap: wrap` — the list's own width was `auto` inside a flex
parent, so with nothing constraining it the browser gave it its full
unwrapped content width and the row overflowed the bar instead of wrapping;
a grid picks its own column count from the available width and always wraps
the remainder to new rows.

**Collapse animates here too**, mirroring `#report.collapsed` byte-for-byte
in technique (see the river's own writeup above): `#view-field`/
`#length-field`/`#season-field` (whole fields leaving the row) fade+scale
rather than animate width, for the identical divider/flex-basis-risk reason;
`#species-field .field-head` and `.species-scientific` (self-contained,
bounded content — one label line, one small caption line each) get a real
`max-height` transition with a tight cap (30px/14px). `#labels-toggle`/
`#construction-toggle`/`.range-field` no longer have their own `display:none`
rules — they're nested inside `#view-field`, so hiding that field already
hides them; the old parallel rules were dead once `#view-field` itself
joined the hidden list in an earlier pass.

**Collapse/expand handle, redesigned as an icon tab** — the fish viewer's
`#inspect-bar-toggle` gets the exact same treatment as `#report-toggle`
(shared `.chevron-icon`, `style.css`): a tab centered on the bar's top edge,
no bottom border, chevron flips 180° on collapse. `left: 50%` +
`transform: translateX(-50%)` is this page's version of the river's
`align-self: center` — this button is `position:absolute` (no `#hud`-style
flex column to center it in), so it needs an explicit centering transform
instead. `bottom: var(--bar-h, 170px)` (no added gap, was `+ 10px`) welds it
to the bar the same way the river's `margin-bottom: 0` does.

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
- `.claude/context/drawer.md` — `createDrawer()`, the open/close/Escape/
  shortcut-key state machine behind the `.open` class this file's shared
  `#plates, #inspect-panel` rule renders.
