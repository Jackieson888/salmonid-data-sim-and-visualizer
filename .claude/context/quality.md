# quality.js — device-tier detection and the frame-time governor

Every rendering cost in the scene used to be fixed at author time, tuned
against a desktop GPU. This module is the single place those numbers live
now, so a phone gets a scene it can actually draw. It doesn't decide *how*
to spend the budget — the scene modules (see `createWorld` in `main.js`,
also the rebuild path a tier change runs through) read `QUALITY` and build
themselves accordingly.

Two things pick the tier, in this order:

1. `detectTier()`, once at boot. Cheap, synchronous, and — being a guess off
   user-agent-adjacent signals — frequently wrong at the margins.
2. `createPerfGovernor()`, continuously. Measures what the device actually
   achieves and steps down when the guess was too optimistic. This is the
   authority; detection only picks a starting point so the first few seconds
   aren't a slideshow on a device that was never going to hold it.

There is deliberately no user-facing quality control. `?quality=low` forces
a tier for development and A/B testing (see the debug panel in `main.js`),
but it is not a feature — a viewer should never have to know this module
exists.

## The tier table

What got cut where isn't obvious from the numbers alone. Measured by hand,
this scene's cost is dominated by the caustics pass — a 256×256 grid whose
**vertex** shader ray-marches an environment map up to 40 steps, each step a
texture fetch — and the 600² water simulation feeding it. Vertex texture
fetch inside a loop is close to the worst case for older Mali/Adreno parts,
so the low tier drops both outright and fakes the result procedurally
(`causticsProcedural` in `glsl.js`) rather than running a cheaper version of
them. Everything else — particle count, shaft count, bloom — is scaled
rather than removed.

The fish are **not** the expensive thing, despite what comments in
`fishMesh.js`/`main.js` long claimed: the mesh is 435 vertices, not the
~1300 those comments asserted, so the flock costs ~522K vertex invocations
rather than the ~2M that justified the population cap. `population` still
scales per tier, but it's a fill-rate and CPU-sim lever now, not the vertex
lever it was documented as.

### low

- `pixelRatio: 1` even on a 3×-DPI phone — the single highest-leverage
  number in the table, since every fragment cost in the scene scales with
  its square.
- `realCaustics: false`, and every caustics/water-sim knob zeroed — both of
  the top two GPU costs, gone. `createWorld()` skips constructing the
  simulation and the generator entirely when this is false: no ping-pong
  targets, no 1024² accumulation target, no 131K-triangle ray-marched draw.
  Consumers switch to the procedural caustic/normal path behind a
  compile-time define, so there's no runtime branch left in any shader.
- `causticTaps: 1` — one tap instead of the 5-tap box blur. Moot while
  `realCaustics` is off (the procedural path is evaluated, not sampled) but
  kept defined so the knob means the same thing at every tier.
- `population: 220` (was 300) — cut alongside the other tiers' population
  when the river itself (`main.js`'s `WORLD_SCALE`) shrank to 55% of its
  former size. A fish's own rendered size didn't change, so relative to the
  smaller channel it now covers roughly `(1/0.55)² ≈ 3.3x` the screen area
  it used to — holding the population at its old count would have been
  simulating/shading a school far denser than the shot needs to read as
  full.
- `bloom: "off"` — bloom is ~13 fullscreen passes with 6-22-tap separable
  blurs; the whole chain collapses to a single combined pass here (see
  `createSceneSetup`).
- `waterSizeMultiplier: 1.7` — the water/riverbed planes are drawn oversized
  so their edges dissolve into fog rather than ending on a hard silhouette.
  1.7x is 2.9x the area against high's 5.8x, and the fog closes in well
  before the edge at this tier anyway.
- `fishHighlights: false` — Blinn-Phong specular and the rim term are two
  `pow()` calls per fragment across the whole flock; legible on a 27"
  display, invisible on a phone.

### medium

- `population: 460` (was 650) — not cut by the same ~3x screen-area math as
  low, because a mid-density day was already the tier most likely to look
  sparse rather than crowded.
- `causticsSegments: 68` (down from an old 128) — scaled with the caustics
  coverage restructure (see `causticsWorldSize` in `water.js`): holds
  world-space vertex density constant against a coverage that went from a
  2.1-span-per-side footprint to ~1.11.

### high

- `waterSimSize: 512` rather than the 600 this shipped with — not a power of
  two, 27% fewer texels, and no visible difference in the height field.
- `causticsSegments: 120` (256 → 120). The caustics pass is the frame's
  dominant cost — a `segments²` grid whose **vertex** shader runs a
  `causticsIterations`-deep texture-fetch loop — and it used to cover
  `waterWorldSize()`, i.e. a 2.4 span per side. It now covers only the
  distance light is still legible through the fog, ~1.11 span (see
  `causticsWorldSize` in `water.js`), so this holds the same world-space
  vertex density over a smaller area: 257² = 66k vertices down to 121² =
  15k.
- `causticsTargetSize: 1024` — deliberately **not** cut to match the
  segments drop. Holding 1024 over a smaller area is a free resolution
  increase in the accumulation texture, at identical fill cost: the pass got
  cheaper on its expensive axis and sharper on its cheap one.
- `causticsInterval: 2` — left alone rather than dropped to 1. The pass is
  now several times cheaper, so there is likely room to buy back temporal
  smoothness, but that's a real-hardware measurement rather than an
  arithmetic one — noted, not acted on.
- `population: 850` (was 1200) — same shrink-driven cut as low/medium.

## Detection

`WEAK_GPU` matches GPU strings that mean "do not attempt the real caustics
pass" — software rasterizers first (SwiftShader is what Chrome falls back
to when hardware acceleration is off; it won't hold 60fps at any tier, but
low at least stays interactive), then mobile parts old enough to make
vertex texture fetch in a loop genuinely painful. Mali-G57 and Adreno 6xx
and up are deliberately **not** in the pattern — they handle the medium
tier fine, and the governor catches the ones that don't.

`probeGpu()` reads the GPU string through `WEBGL_debug_renderer_info`, then
throws the WebGL context away immediately via `loseContext()` rather than
waiting for GC — mobile browsers cap how many live WebGL contexts a page
may hold (often single digits) and silently kill the oldest when the cap is
hit, which would be the scene's own context. Returning `null` when the
extension is unavailable (Firefox's `resistFingerprinting`, Safari's
privacy modes both mask it) is a supported outcome, not a failure — the
checks in `detectTier()` stand on their own and the governor backstops all
of it.

`detectTier()` treats every signal as a hint rather than a fact —
`hardwareConcurrency` is clamped by some browsers, `deviceMemory` doesn't
exist on Safari at all, and the GPU string is maskable — so it errs toward
guessing low on mobile and lets the governor decide the rest. Guessing low
and being wrong costs some visual richness for a few seconds; guessing high
and being wrong costs a device that never renders a usable frame.
`(pointer: coarse)` is used as the primary mobile/tablet signal because it
describes the input device rather than parsing a user-agent string, and
unlike screen size it doesn't misfire on a small desktop window. The
returned `{ tier, reason }` — `reason` is surfaced in the debug panel,
because "why did this device land on medium" is otherwise unanswerable.

## Live state

`QUALITY` is a single object, **mutated in place** by `applyTier()` rather
than reassigned, so modules can hold a reference (`import { QUALITY }`) and
always see current values without a subscription. The scene reads it at
build time, and a tier change goes through a full world rebuild anyway (see
`main.js`), so nothing more elaborate than mutation is needed.

## The frame-time governor

- `WARMUP_FRAMES = 60` — the first second or so of any WebGL page is shader
  compilation, texture upload and GLB parsing, none of which reflects the
  steady-state cost this is trying to measure. Sampling through it would
  downgrade every device on the planet.
- `WINDOW_FRAMES = 120` — at 60fps this is a decision every two seconds:
  slow enough that one bad frame can't trigger it, fast enough that a
  viewer on a struggling device isn't watching a slideshow for long.
- `COOLDOWN_FRAMES = 300` — a tier change tears down and rebuilds every GPU
  resource in the scene (`rebuildWorld` in `main.js`), itself a multi-frame
  stall; measuring through it would immediately trigger another downgrade
  off the cost of the last one.
- `DOWNGRADE_MS = 20.8` (≈48fps), deliberately below 60: a device holding a
  steady 55fps is doing fine, and rebuilding the world to claw back 5fps
  would cost more in hitching than it returns. This is the "clearly not
  coping" line, not the "not perfect" line.
- `median()`, not mean: frame times are a spiky signal — a GC pause, a
  texture upload, or the browser doing layout on another tab all show up as
  single frames of 100ms+. A mean lets any one of those drag a healthy
  window over the threshold; a median ignores them, which is the behavior
  wanted from something whose response is a full world rebuild. The ring
  buffer is copied before sorting so sorting in place doesn't scramble the
  ring's write order.
- **No auto-upgrade, deliberately.** The measurement that would justify one
  — "we have headroom now" — is only observable at the lower tier, where the
  scene is cheaper by construction, so a device sitting right at the
  boundary would upgrade, miss the threshold, downgrade, and repeat. Each
  round trip is two full world rebuilds. Sitting one tier lower than
  strictly necessary is a much better failure than oscillating between
  tiers.
- `onChange` is `null` when the tier was forced via `?quality=`. The
  governor still measures in that case — the debug panel's frame time is
  the whole point of forcing a tier to A/B it — it just never acts on what
  it measures.
- `deltaMs > 0 && deltaMs < 1000` guards against the delta a backgrounded
  tab produces on return: `requestAnimationFrame` stops firing entirely
  while backgrounded, so the first frame back can be minutes long — not a
  performance signal.

## See also

- Root `CLAUDE.md` — "Rules that hold everywhere" and the doc-path table for
  `main.js` (`createWorld`/`rebuildWorld`, the consumer of `QUALITY`).
- `.claude/context/scene/water-and-caustics.md` — `causticsWorldSize`, the
  water sim, and the shading these tiers are budgeting for.
