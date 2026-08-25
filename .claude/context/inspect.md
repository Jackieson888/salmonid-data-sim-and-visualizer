# `src/inspect.js` — fish viewer page

Standalone single-fish viewer behind `inspect.html`. It reuses the river's
exact fish shader/animation pipeline (`scene/fishMesh.js`: one InstancedMesh,
VAT-baked swim clip, caustic glow, depth fog) with exactly one instance, an
orbit camera, and none of the river/timeline/quality-governor machinery
`main.js` builds around it — a visitor's window onto one fish: which species,
whether it swims and turns, and a labeled anatomy plate. The fish never
translates, so what's actually rendering is the same per-instance VAT
sampling loop `fishMesh.js` runs for a flock member, just driven by a
synthetic fish record instead. Species tint, depth fog, caustic glow and
highlights are all identical to the river; only the world around the fish
and the camera differ.

## Quality overrides

Only one instance is ever drawn here, so unlike the river scene — which
scales quality down per device tier to hold frame rate across a flock of
hundreds — this page always renders at the richest settings available. The
overrides (`QUALITY.realCaustics = false`, `QUALITY.fishHighlights = true`)
are set before `createFishInstancedMesh()` reads them at material-build time
(see `buildSpeciesRenderer` in `fishMesh.js`).

`realCaustics` is forced **off**, not on: "on" compiles a shader that expects
a real accumulation texture from `causticsGenerator.js`, which this page
never builds (there's no water simulation to generate one from), so that
path would just sample an unbound sampler and stay flat. "Off" compiles the
procedural stand-in (`causticGlowProc` in `scene/glsl.js`), which needs
nothing but world position and time and gives the fish a moving glint even
with no caustics pipeline behind it.

## Scene setup

A plain neutral backdrop rather than the river's underwater fog — this view
exists to see the fish clearly, not to see it in context. No THREE lights are
added, matching `sceneSetup.js`: `fishMesh.js`'s material is a hand-written
`ShaderMaterial` lit entirely by its own `uLightDir` uniform, so scene lights
would be dead weight here too. The renderer matches `sceneSetup.js`'s grading
(`ACESFilmicToneMapping`, exposure 0.55) so a model reads here the same way
it will in the river — the whole point of a mesh/texture debugging view is
that it not lie about the real look.

`PREFERS_REDUCED_MOTION` holds swimming and the turntable off by default on
load, same spirit as the river booting held under this preference rather
than autoplaying (see `PREFERS_REDUCED_MOTION` in `main.js`). It's a default,
not a lock — a visitor who explicitly turns either back on gets it.

## Camera framing (`frameCamera`)

Points the camera/orbit target at the fish and sizes the reference grid to
it. Called on load, whenever the species changes the rendered body length,
and from the reset-view button — never every frame, which would fight the
user's own zoom/drag.

The mesh's bbox center sits half a body length behind the tracked nose point
(see `noseOffsetLocal` in `fishMesh.js`). `previewFish` is nose-anchored at
the world origin heading straight down +Z, so the body itself extends back
along -Z from there — hence `target = (0, 0, -bodyLength / 2)`. The camera
sits at roughly `1.1×` body length out in X, `0.45×` up in Y, `1.3×` out in
Z from that target. The reference grid's colors are matched to style.css's
`--line`/`--line-soft` so it reads as this page's own chrome rather than an
arbitrary three.js default.

## Panel height sync

`#inspect-panel`'s bottom edge is pinned above `#inspect-bar` via a CSS
custom property (`--bar-h`, see `inspect.css`) rather than a guessed
constant or a plain `resize` listener. The bar's own height depends on
content this script fills in *after* first paint (`buildSpeciesList()` runs
well after this module's top-level code — see "Boot the panel" below) as
well as on which of its own CSS breakpoints is active, so a window `resize`
event alone would miss both the initial population and any reflow from,
say, a web font swapping in. A `ResizeObserver` reacts to the bar's actual
box regardless of what moved it.

## The preview fish (`makePreviewFish`)

Built from `boids.js`'s real `Fish` class rather than a bare object literal,
so it gets the same per-species length range, wobble phase and swim-rate
jitter a flock member would. The overrides on top are the ones that make
sense for a fish that isn't part of a running simulation:

- `fish.age = 999` — `Fish.opacity` ramps in over `SPAWN_FADE_FRAMES` of
  `Flock.step()` calls (see `boids.js`); nothing here ever steps a `Flock`,
  so age would otherwise sit at 0 forever and the fish would render fully
  transparent. `age` is a getter, so it's forced past the fade window
  directly.
- `fish.depth = 0`, `fish.depthTarget = 0` — depth wander is a
  flocking-scene concern (drifting up/down the water column); pinned flat
  so the fish sits at a predictable height instead of the constructor's
  random depth.
- `fish.vx = 0`, `fish.vy = 1` — heading fixed to +Z (matching
  `frameCamera`'s target math) rather than the constructor's random
  forward-ish angle, so re-picking a species doesn't also spin the fish to a
  new facing.
- `fish.smoothSpeed = 1.2`, `fish.swimAmplitude = 1` — no speed/amplitude
  sliders any more; this is the natural cruise a flocking fish swims at
  (1.2 matches `BASE_MAX_SPEED` in `main.js`) and the clip's full authored
  stroke, rather than a tunable.

`fishAssets`/`anatomyParts` are kept separately from the full
`assetsByUrlRef` Map that `loadFishAssets()` resolves to: `resolveAnatomy()`
wants the Map (it does its own species → url lookup) while the per-frame
swim-bend sampling wants one species' assets directly.

## Species field notes (`SPECIES_FIELD_NOTES`, `FIELD_NOTE_CATEGORIES`)

Content for the panel's "Field notes" section, which is now the panel's
*entire* content (see `inspect.html`) — this pulls far more out of the full
write-ups vendored under `public/*-field-notes.md` than the panel had room
for when it was sharing space with length and season. Each species' `intro`
is the one-line summary the panel led with before any of this was added.
Every fact is paraphrased from those source documents, not invented — a
handful (the run-timing split, FIG. 6's day/night lamprey chart, the
wild-steelhead percentage) were chosen because they explain a pattern
visible *elsewhere* in this app, but most are just the source material
itself, organized. `jackChinook` has no write-up of its own — it's a
life-history variant covered inside the Chinook piece — and its shorter fact
list is an honest reflection of that, not a gap to pad out.

`facts` is grouped under a small, fixed set of category labels
(`FIELD_NOTE_CATEGORIES`) rather than run together as one flat list, so a
visitor curious about one thing — how to tell it apart, what it eats, why
the run splits the way it does — can find it without reading past facts
about something else. Not every species has something for every category; a
category with nothing to say is simply left out of that species' array, and
`updateFieldGuide` only renders the categories present.

`FIELD_NOTE_CATEGORIES`' display order is fixed (not derived from write
order) so a visitor reading two species' notes back to back finds the same
section in the same place both times. It's ordered roughly the way a field
guide itself progresses: what it looks like, where it lives, what it eats,
then how it behaves and where it stands.

## Season stats (`seasonStatsFor`)

Real per-day DART counts for one species, off the same record the river and
the plates drawer read (`data.js`). Everything the season card reports comes
from this one pass over `runData`.

First/last date tracks the first and last day this species was actually
*seen* (`value > 0`), not the first and last day the dam was counting — the
two are months apart for a species with a short run, since the counting
window is the same length for all of them.

The "middle 80%" window is the dates by which 10% and 90% of the season's
fish had passed (a running total compared against `total * 0.1` /
`total * 0.9`). This is a far more honest answer to "when does this species
run" than first-to-last, which one stray fish in February can stretch across
the whole calendar.

## Per-species extra facts (`speciesExtraRows`)

Facts DART publishes for one species and not the others; each returns a
`[label, value]` row or nothing.

- **Steelhead**: wild (unclipped) share is a *subset* of the steelhead
  count, never an addition to it — DART's own notes say the `Stlhd` column
  already includes both, and the wild figure may itself include unmarked
  hatchery fish.
- **Lamprey**: "passed at night" is omitted entirely (not reported as 0%)
  for a season that published no day/night split at all (2006–2008), rather
  than misleadingly showing zero.
- **Chinook / Jack Chinook**: the Sp/Su/Fa run-schedule split comes from
  `day.chinookRun`, which DART labels each date with (see
  `CHINOOK_RUN_NAMES` in `dart/parseAdultDaily.js`). These are Corps run
  *schedules* for the project, not a determination about the individual fish
  counted.

## Species picker (`buildSpeciesList`)

`currentSpecies` replaces what used to be a `speciesSelect.value` read: the
picker is a list of buttons now (`role="radio"`), so there is no control
holding the current value — `currentSpecies` is it. `isPressed`/`setPressed`
similarly replace `.checked` reads/writes for the view toggles
(playing/rotate/labels), which are buttons with `aria-pressed` rather than
checkboxes.

The species order (`SPECIES` array) is the order the panel lists them in —
largest salmonid first, then down the run to the one that isn't a bony fish
at all — matching the same five keyed in `main.js`'s `SPECIES_KEYS`.

The list implements roving focus: the group is one tab stop and the arrow
keys move within it (only the selected option has `tabIndex = 0`), which is
what a radiogroup is expected to do.

## Species-switch content fade (`fadeContent`)

`setSpecies()` updates five separate pieces of chrome. Two of them —
`markSpeciesSelection()`'s `.selected` toggle and `markLengthSelection()`'s
`.current` toggle — just flip a class, so a plain CSS `transition` on the
affected color/background properties (`inspect.css`) already animates them
for free. The other two, `updateSeasonCard()` and `updateFieldGuide()`,
`replaceChildren()` their panel wholesale — there's no property to
transition, only old nodes and new ones — so `fadeContent(el, apply)` dips
the panel to opacity 0, calls `apply()` while it's invisible, then lets it
fade back in, giving those two panels the same "coordinated update" feel the
class-toggle pair gets natively instead of a hard content-pop underneath a
smoothly fading fish.

Keyed by element in a `WeakMap` (`pendingContentFade`) so a fast arrow-key
rove through the species list — which calls `setSpecies()`, and so
`fadeContent()`, on every step — cancels the previous pending swap rather
than layering timers: without that, a rapid rove could let an earlier
step's `apply()` fire *after* a later step's, briefly showing a stale
species' notes on top of the current selection. Cancelling instead keeps the
panel dimmed continuously through the rove and only ever applies the
last-requested species, which also reads better than flickering opaque
between every step.

`CONTENT_FADE_MS = 120` is a plain JS constant tracking `--dur-fast` in
`style.css` rather than something read off the CSS at runtime — same
lightweight convention `dismissLoadingOverlay`'s `setTimeout` uses in
`main.js` to shadow its own CSS transition duration.

## Fish silhouettes and length scale

Silhouettes are traced from the real GLB models
(`scripts/render-fish-silhouettes.mjs` rasterizes each one's bind pose from a
true orthographic side view to `public/silhouettes/*.png`) rather than
hand-drawn, so the shape shown is this project's own fish rather than an
artist's approximation. Applied as a CSS mask over a solid fill (`.len-fish`
in `inspect.css`, which also maps in the per-species PNG, one rule per
species, the same attribute-selector convention every other per-species
color in this file follows).

`jackChinook` has no model of its own — it rides chinook's GLB in the river
too (see `SPECIES_MODEL_URL` in `scene/fishMesh.js`) — so its silhouette
element just carries the same `data-species` value chinook's does
(`SILHOUETTE_IMAGE_KEY`).

The length rows are built once and only re-marked on a species change: the
silhouettes themselves never change, and rebuilding five rows of SVG to move
one highlight would be work for its own sake. Row labels use short names
(`SHORT_NAMES`) rather than the full common names, which don't fit the name
column at this panel width — truncating them gave five rows of "CHINO…"/
"AMERI…", which identifies nothing; the picker above already carries the
full name and the binomial. The silhouette spans the real min–max length
*range* for the species (`SPECIES_LENGTH_INCHES` in `boids.js`), not a
single figure — because that's what the underlying data is.

`LENGTH_FISH_SCALE = 0.5` shrinks every species' row together (since
`.len-fish`'s height falls out of its width via `aspect-ratio` in
`inspect.css`, shrinking a row is just shrinking its width) — this was
needed because the field-guide-sized silhouettes from the first pass read
taller than the bar's other fields (species, view) needed to be. Width still
maps to the real min–max span underneath this factor, so the *comparison*
between species is unchanged; only how big that comparison renders changes.
The axis row reuses the same row layout (blank name cell, ticks inside a
real track, blank figure cell) rather than being a separate line with
hand-guessed margins — that's what keeps "24" actually above the 24-inch
mark instead of near it.

## Season card and sparkline (`buildSparkline`, `buildSparkAxis`, `updateSeasonCard`)

The sparkline shares `seasonScale.js`'s x-axis with the river's own chart and
every plate in the drawer, and the √ scale with them too, so it reads as the
same instrument at a smaller size rather than a different one.

Quarter-year month rules (`SPARK_AXIS_MONTHS = [4, 7, 10]`) are looked up by
scanning `runData` for a matching month, not assumed to exist, because not
every season reaches all three (a run counted only through September has no
October). The rules' record indices are handed back to `buildSparkAxis` so
the month labels underneath can be positioned at the *same* fractions —
evenly spacing labels under unevenly spaced rules would point them at the
wrong months, since the rules sit wherever the season's own dates put them.

A season with zero counted fish (`stats.total === 0`) is reported as a real
outcome, not an error — shad were barely counted in some seasons, and
lamprey not at all in others — with a plain sentence rather than a flat line
and a column of zeroes.

## Turbidity (`applyTurbidity`)

Pushes the fish material's own `uFogDensity`/`uFogColor` uniforms — see
`setBounds`'s notes in `scene/fishMesh.js` for what normally drives those on
the river; nothing does on this page otherwise, which is why the fish viewer
opens on a neutral, fog-free backdrop. Lets a visitor see the same fish the
way it would actually look in water far siltier than that default.

`TURBID_COLOR` (`0x332c1e`) is deliberately its own muddy/olive tone rather
than a reuse of the river's blue-green `FOG_COLOR` (`scene/fog.js`) — this
page has no water simulation to tint that by season, and "heavy suspended
sediment" reads as brown/olive, not the river's own deep-channel color.

`TURBIDITY_DENSITY_K = 0.85` converts the slider's 0–1 turbidity into
`uFogDensity`, divided by the current fish's own body length so the falloff
scales with body length instead of being tuned in raw world units that
would read very differently on a lamprey than a Chinook. It was picked so
full turbidity noticeably hazes the fish at the default camera distance
(~1.3 body lengths out) without erasing it outright — the point is "hard to
make out", not "gone".

## Silt particles (`buildInspectParticles`, `updateParticleVolume`)

A small GPU-driven particle field standing in for suspended sediment, the
same visual job `scene/particles.js`'s own field does on the river, but not
a reuse of that module: it builds its volume from `bounds` and reads the
river's real caustics accumulation texture, neither of which exists on this
page. So this is a much smaller, purpose-built version of the same idea,
sized to whichever fish is on screen instead of to a river.

Origins are stored in a *unit* cube (`[-0.5, 0.5]³`), not world units, and
scaled into place by `uVolumeMin`/`uVolumeSize` each frame — that's what
lets `updateParticleVolume()` resize the whole field for a new species by
changing four uniforms rather than rebuilding the instance buffers.

`PARTICLE_MAX_OPACITY = 0.5` is full turbidity's ceiling — silt is meant to
be noticed as texture in the water, not counted as individual specks (same
reasoning as `OPACITY` in `scene/particles.js`). Drift (`drifted.x +=
uTime * 6.0`, plus a small vertical `sin` churn) is fixed in absolute world
units rather than scaled by the volume — small and slow enough to stay
gentle on a lamprey's small volume and still legible on a Chinook's larger
one. Particle size is biased toward small (`aSizeSeed * aSizeSeed`), same
reasoning as `scene/particles.js`: a field of uniformly-sized motes reads as
a texture, a few larger ones close by reads as a volume. Billboarding
offsets each quad's corners along the view matrix's own right/up axes, the
same technique `scene/particles.js` uses. The fragment shader's round falloff
exists because a hard-edged quad reads as a square this close to the camera.

## Construction mode

A toggle that loops the fish continuously through five build stages:
**Skeleton → Wireframe → Polygons → Texture → Final**. Skeleton is the real
armature baked alongside the vertex VAT (`vat.bones` in
`bakeVertexAnimationTexture`, `scene/fishMesh.js`); Final is the same
caustics/specular/rim treatment every other view on this page already shows
(`uTextureMix`/`uHighlightsMix` in `scene/fishMesh.js`, both defaulted to 1
there and only ever pulled below that from here).

Every stage transition is a genuine crossfade — the outgoing and incoming
stage are both on screen at once, opacities moving in opposite directions —
rather than a cut or a flicker. That needs three participants able to sit at
partial opacity simultaneously:

- **the armature** — a `THREE.LineSegments`, alpha-native.
- **a dedicated wireframe mesh** (`buildWireframeMesh`-equivalent set up in
  `ensureConstructionAssets`) — its own small `ShaderMaterial`, alpha-native,
  existing at all only because `wireframe` is a draw-*mode* flag three.js
  can't blend against a filled draw in one call, so the filled stages need a
  separate object to crossfade against while that flip happens.
- **`fishRenderer`'s own instanced mesh** — reused as-is for
  Polygons/Texture/Final (all filled triangles, no draw-mode conflict
  between them), briefly made transparent *only* while fading in from/out to
  the wireframe mesh, settling back to fully opaque/depth-writing the rest
  of the time — the state every other view on this page already expects it
  in.

`applyConstructionWeights` sets all three from one `{wArmature, wWireframe,
wReal, textureMix, highlightsMix}` object; `CONSTRUCTION_STAGE_WEIGHTS` is
that object for each of the five settled stages, and `tickConstruction`
linearly interpolates between adjacent ones while a transition is running.
Real alpha appears only on the armature/wireframe pair and on
`fishRenderer`'s mesh during its two brief crossfades — the failure mode
that's normally the reason to avoid transparency here (a *school* of
overlapping translucent fish reading as glass; see the long note on
`transparent` in `buildSpeciesRenderer`) needs more than one fish on screen
to happen, and Construction only ever runs on this one.

Timing: `CONSTRUCTION_HOLD_MS = 850`, `CONSTRUCTION_TRANSITION_MS = 1300`
(doubled from an original 650ms), `CONSTRUCTION_EXIT_MS = 450`. A full loop
is `STAGE_COUNT * (HOLD + TRANSITION) ≈ 10.75s`. At the original 650ms,
lerped linearly, a crossfade between two objects of very different visual
density (a single spine line vs. a mesh-wide wireframe) read as a pop rather
than a fade — most of a linear alpha ramp's *perceived* change happens in
its first sliver, so it needed both more time and a real easing curve
(`easeConstructionP`, a smoothstep `p*p*(3-2p)`), not just a bigger number.

The wireframe fragment shader's `uRevealFraction` is *not* a plain opacity.
A dense wireframe is hundreds of overlapping semi-transparent edges under a
lot of screen pixels, and alpha blending compounds across every edge a pixel
sits under — so at even a few percent uniform opacity, the mesh already
reads as most of the way "arrived" (measured: ~4% opacity, ~85%+ visual
coverage), and no power curve on that opacity value fixes it without either
doing nothing for most of the transition or snapping at the very end. So
instead each edge is fully drawn or not, decided by comparing its own
per-vertex hash (`vReveal`, hashed off the *rest* position so the reveal
pattern itself doesn't swim) against `uRevealFraction`, with only a narrow
soft band (`band = 0.06`) right at the threshold. That's what actually keeps
the compounding bounded, since at any instant only the edges crossing that
thin band are ever at partial alpha. Reads as the wireframe materializing
in, stroke by stroke, rather than fading up as one block.

Separately, `applyConstructionWeights` feeds `w.wWireframe` through a second
squashing curve (`reveal = Math.pow(w.wWireframe, 1.8)`) before writing it to
`uRevealFraction`, rather than using `w.wWireframe` directly. The per-edge
threshold above fixes the worst of the compounding (a discarded edge
contributes nothing, unlike a low-alpha one), but a well-connected mesh still
fills in faster than the raw fraction suggests: with most vertices touching
several edges, "25% of vertices below threshold" reveals noticeably more
than a quarter of the edge network, since any edge with *either* endpoint
below threshold shows at least partially. The power curve compensates —
same idea as `easeConstructionP`, aimed at a different cause.

`updateConstructionPose` re-samples every armature edge off the *current*
swim pose and copies `fishRenderer`'s own computed transform for this frame
onto the wireframe mesh — the same "read the real pipeline's result back
out" approach `updateGhostOverlay` uses in `fishMesh.js`, for the same
reason: the tailbeat/roll physics only exist in one place, and this rides
them rather than re-deriving them.

`ensureConstructionAssets` builds the armature/wireframe mesh on demand
(when Construction is switched on, or again from `setSpecies()` if it's
already running) rather than keeping them alive the whole time Construction
is off, since neither object is cheap to leave idle for a control most
visits never touch.

## Anatomy overlay (`renderAnatomyOverlay` and friends)

Leader lines drawn each frame from the projected screen position of the
resolved anchors (see `scene/fishAnatomy.js`). The anchors move whether or
not the camera does: they're sampled off the swimming mesh, so every one of
them is traveling through a tailbeat all the time. A layout recomputed from
scratch each frame therefore moves each frame, and the labels never settle
into something you can read. Four things hold them still, in rough order of
how much each is worth:

1. **Fixed gutters.** The label column x is a property of the viewport, not
   of the anchor, so label x does not move at all (`LABEL_GUTTER_FRACTION =
   0.22`, capped at `LABEL_GUTTER_MAX = 230`px). This is also what pushes
   the leaders further off the model. Deliberately modest — pushing the
   columns further out does get the labels off the model, but by making
   every leader longer and flatter, and a long flat leader lies straight
   across the body, which is worse than the label would have been. Distance
   isn't what keeps the plate clear; the vertical fan is.
2. **Damping.** Label y chases its target instead of snapping to it
   (`LABEL_DAMPING = 0.18` — low enough to swallow a tailbeat, high enough
   that a species change or camera move doesn't visibly crawl into place),
   so the tailbeat's residual is smoothed away rather than tracked.
3. **Column hysteresis.** A part keeps its side until its anchor is
   `COLUMN_HYSTERESIS_PX = 40`px past the midline, so a feature hovering
   near center stops ping-ponging between the two columns.
4. **A settle pass** that pushes back up as well as down, so a crowded
   column stays centered on its anchors instead of drifting off the bottom.

**Two positions are computed per part**, and keeping them apart is the
single biggest reason the plate holds still: the leader's *endpoint* is the
animated vertex, sampled out of the VAT the same way the shader does (has to
be exact, or the line stops pointing at the feature it names); the layout's
*input* is the rest vertex under the same instance transform (carries every
change that should move a label — camera, body transform — and none of the
change that shouldn't — the tailbeat). Smoothing the animated anchor was
tried first and is strictly worse: a low-pass filter slow enough to flatten
a lamprey's tail sweep is also slow enough to lag a camera move, trading one
artifact for another. The rest pose isn't an approximation of the still
position — it *is* the still position, so there's nothing left to filter and
no lag to pay for it.

**Facing test** — applied only to genuinely paired lateral features (eye,
operculum, pectoral/pelvic fin, lateral line: `|part.side| > 0.5`, see
`fishAnatomy.js`), not to midline features. A midline feature like the
dorsal or adipose fin is a thin sheet, and the sheet's face normal
(`restNormal`) points sideways even though its position is on the midline —
testing it the same way as a real paired feature made the whole fin blink
out for roughly half of every rotation, which is a property of that one
vertex's normal, not of whether the fin itself is actually facing away.

**The panel-avoidance rule changed shape** when the panel grew to fill
nearly the full viewport height. It used to be handled by routing any anchor
whose label would land inside the panel's footprint over to the left column
— a per-anchor test, which was correct back when a label's x came from its
anchor's x. It failed loudly once the panel ran nearly the full height: the
test ("x past the midline and y above the panel's bottom") then captured the
entire right half and stacked all eleven labels into one column. With the
columns now at fixed gutters, the whole question is answered once instead,
by clamping the right column clear of the panel (`rightX`, using
`LABEL_EDGE_MARGIN` — not just a hairline gap, since `rightX` is where the
right column's text *starts* — a 12px gap once let "Second Dorsal Fin"
render its text on top of the panel instead of stopping short of it).

**Single-column fallback** (`singleColumn`) triggers when `rightX - leftX <
120` (two columns need more room than a narrow phone screen has) *or* when
`width - leftX - rightX > 80`. The second clause catches a squeeze the first
misses: at some in-between viewport widths (~900px with the panel at its
usual 300px), the panel's `LABEL_EDGE_MARGIN` clearance pulls `rightX` in
far enough that it clears `leftX` by more than 120px yet still lands close
enough to center to sit on the fish instead of beside it. `width - leftX` is
where a panel-free right column would mirror `leftX`'s own distance from
center, so a `rightX` pulled more than 80px short of that mirror is "too
compressed" even though it technically still fits two columns.

**Column layout**, per side: sort by the smoothed (rest-pose) anchor height
so the running order doesn't reshuffle every time two features cross during
a stroke; fan each label from its own anchor height toward an even share of
the vertical band (`LABEL_VERTICAL_SPREAD = 0.62` — at 0 labels sit level
with their anchors, which is where they started and why the leaders ran
horizontally across the fish; at 1 they're evenly spaced regardless of what
they point at, which reads as a list rather than a plate); a down-pass
separates anything still closer than `LABEL_MIN_GAP = 26`px; an up-pass
undoes the down-pass's one-directional drift, since it can only ever push
labels lower, which would otherwise walk a crowded column off the bottom of
the viewport (or into the bar) and away from the anchors it belongs to — the
up-pass re-centers the column on its own anchors by pushing overflow back up
against whichever edge is actually closer.

`shiftPx` (half of `#inspect-bar`'s height) corrects every pixel coordinate
that has to track the fish — the leader endpoint and the rest-pose layout
anchor — because `#fish-canvas` is shifted up by that same amount via a CSS
transform (`inspect.css`) so the fish recenters in the space actually
visible above the bar, instead of in the full window behind it. The overlay
SVG itself stays un-shifted, so label *text* positions (which fall out of
the band-clamped fan, already correctly bounded to the visible region on
their own) do not need the correction — only the anchor-tracking coordinates
do.

`snapLabelLayout()` drops every remembered position (rather than resetting
to null lazily) so the next frame places labels outright instead of easing
to them. This is needed specifically because the layout runs against a
heavily smoothed anchor: an instantaneous camera move (Reset view) is a real
jump the smoothing has no way to tell apart from a very fast swim, and
without this the whole plate would crawl into its new position over a
couple of seconds. `resetLabelLayout()` (used on species change) is the
harder reset — the new species is a different part list entirely, so old
DOM nodes and state are discarded, not just their remembered positions.

## Boot ordering

The "Boot the panel" calls (`buildInspectParticles()`, `buildSpeciesList()`,
`buildLengthScale()`, `setSpecies(currentSpecies)`) are deliberately placed
near the bottom of the file rather than beside the functions they call:
`setSpecies()` calls `resetLabelLayout()`, which touches the anatomy
overlay's `labelState` — a module-scope `const` declared in the anatomy
overlay section, further down in the file. Placing the bootstrap calls up
with their own function definitions would put them before that declaration
and hit the temporal dead zone on load.

## Animation loop

`dt` is converted to 60fps-frame units (`dt / REFERENCE_FRAME_MS`, clamped
to a max of 4) before being passed to `fishRenderer.update()`, matching
`main.js`'s own loop. `fishMesh.js`'s `update()` *accumulates* the tailbeat
per call, so leaving `dt` at the parameter default of 1 would make stroke
rate a function of refresh rate — 2.4x too fast on a 144Hz display, half
speed at 30fps. The clamp exists for the same reason `main.js` clamps its
own: a backgrounded tab comes back with one enormous delta, and the tail
should drop that motion rather than snap through it.

On load completion, `uCausticsStrength` (see `buildSpeciesRenderer` in
`fishMesh.js`) is overridden to `3` by reaching directly into the material's
uniforms, rather than adding a new `buildSpeciesRenderer` parameter for a
tweak only this page wants. The river's tuned value assumes depth dimming
and distance fog both cut the glow down before it reaches the eye; neither
exists on this page, so at the river's value the procedural glow (see
`QUALITY.realCaustics` above) reads as flat green blotches sitting on the
fins instead of a glint.

## See also

- `.claude/context/scene/fishMesh.md` — the shared VAT/instancing pipeline
  this page drives with one instance: `noseOffsetLocal`, per-model rotation
  fixups, `buildSpeciesRenderer`'s material uniforms, `updateGhostOverlay`.
- `.claude/context/scene/fishAnatomy.md` — how the anchors this page draws
  leader lines to are authored and resolved (`resolveAnatomy`, `part.side`,
  `restNormal`, `animatedLocalPosition`/`animatedBonePosition`).
- `.claude/context/data.md` — `runData`/`runYear` and the DART fields this
  page reads for season stats and field notes (`chinookRun`, `wildSteelhead`,
  `lampreyNight`/`lampreyDay`).
- `.claude/context/boids.md` — the `Fish` class this page instantiates
  directly (`SPAWN_FADE_FRAMES`, per-species length ranges, wobble phase).
- `.claude/context/scene/sceneSetup.md` — the renderer/tone-mapping setup
  this page mirrors so a model reads the same here as in the river.
- `.claude/context/scene/environment.md` — `scene/particles.js`, the river
  silt field this page's own smaller particle system parallels.
- `.claude/context/main.md` — `PREFERS_REDUCED_MOTION` and the boot-time
  conventions this page's defaults echo.
- `.claude/context/ui.md` — `inspect.css`/`inspect.html` layout: the
  `--bar-h` variable, `#fish-canvas`'s shift transform, panel breakpoints.
- `.claude/context/insights.md` — the info buttons on the length scale and
  season card headers, and the shared toast they open.
