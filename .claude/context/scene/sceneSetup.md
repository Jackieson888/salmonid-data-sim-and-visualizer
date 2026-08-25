# sceneSetup.js — renderer, fixed camera, sky sphere, composer chain

Renderer, camera, and resize handling for the 3D river scene. No `THREE`
lights are used anywhere — every material in the scene is a hand-written
`ShaderMaterial` — and the camera is a single fixed, world-anchored vantage
rather than anything user-controllable.

## Why the camera is fixed

The camera is a single world-anchored vantage inside the water column,
angled up-and-across so the school's flow sweeps through the frame
left-to-right with the surface overhead and the caustic-lit riverbed below.
It is deliberately not user-controllable: this scene only holds together as
an underwater shot from a viewpoint that stays in the water and stays
pointed roughly along the run. `OrbitControls` used to own the camera here,
which let the viewer drift above the surface or below the riverbed, where
the whole depth-based color model (the sky shader's path-length murk,
`fishMesh.js`'s depth fog) reads as broken. Everything about the framing is
now a constant in this file.

## Sun disc/glow tuning

`SUN_DISC_EXPONENT = 350`, `SUN_DISC_STRENGTH = 1.2`, `SUN_HALO_EXPONENT =
6`, `SUN_HALO_STRENGTH = 0.12`. The tight exponent is the disc itself, the
loose one the halo bleeding off it; both are fed by the season's
`sunIntensity` so a low winter sun reads dimmer than a high summer one.
Strengths are set so the disc core clears `UnrealBloomPass`'s 0.94 threshold
(see Composer below) and actually blooms, while the halo stays under it and
just tints the sky.

## Sky fog scale (`SKY_FOG_SCALE = 0.62`)

Scales down the fog density used for the sky sphere's own murk path (in its
fragment shader). At the true density the water is turbid enough that
Snell's window collapses to a pinhole straight overhead and the seasonal sky
never shows at all — which is honest, and unwatchable. This widens the
window until the sky reads across the top of frame. Purely an artistic
control; it is the one place in this file that isn't trying to be physical.

It does have a lower bound, and 0.45 was under it. The water surface plane
(`water.js`) is finite, so rays angled only slightly up pass over its far
edge and hit this sphere directly, while steeper rays go through the plane
— which is fully fog-saturated at that distance. Widen the window too far
and the sky under the plane's edge angle stays visibly warmer and lighter
than the fogged plane just above it, and the edge shows up as a horizontal
seam straight across the frame. Most obvious in autumn, where the horizon
band is at its most golden and least like the water. 0.62 murks that
shallow-angle band to match without closing the window overhead, where the
seasonal sky still needs to read.

`MIN_UPWARD_COMPONENT = 0.001`: below this much upward tilt, a view ray is
treated as never reaching the surface at all (pure murk). Also keeps the
`1/dir.y` path-length division below away from zero.

## Vignette + grain

Deliberately asymmetric (`VIGNETTE_TOP = 0.25`, `VIGNETTE_BOTTOM = 1.1`). A
symmetric vignette would close down the top of frame, which is where
Snell's window sits (see `water.js`) — the brightest and most legible thing
in the shot, and the last thing that should be dimmed. So the effect is
nearly absent up there and does its work along the bottom, where the frame
has to meet the dark UI panel; without it the render ends on a visible
tonal step against the panel's top edge.

These are fractions of **linear** light, applied before the tone-mapping
curve and the sRGB encode, and that encode roughly halves them on the way to
the screen: 0.16 here is about an 8% difference to the eye, not 16%. Tuning
them as if they were display-space percentages is how this ended up
invisible the first time.

`VIGNETTE_BOTTOM_EDGE = 0.35`, `VIGNETTE_BOTTOM_FADE = 0.5`: a broad
darkening across the whole bottom edge, on top of the radial falloff above —
the corners alone don't sell the transition into the panel, since the panel
spans the full width of the frame. The fade has to reach well up the frame
rather than hugging the very bottom: the panel covers the bottom ~19% of the
canvas, so anything tucked below that is spent behind it and never seen.

`VIGNETTE_START = 0.2`, `VIGNETTE_END = 0.78`: where the radial falloff
starts and reaches full strength, as a distance in uv space from the center
of frame (the corners are at 0.707). Wide enough that the sides get some of
it — with a later start the whole effect collapses into four corners, two
of which the panel hides.

`GRAIN_AMOUNT = 0.03`: fine per-pixel grain, applied as a proportional
wobble rather than an additive one so it stays even across the frame instead
of swamping the darks. It reads as film, but it is also load-bearing: this
scene is mostly very smooth, very dark gradients (the depth ramp in
`fog.js`, the murk behind it), which is exactly what bands visibly once it
is quantized to 8 bits on the way out. A little noise before that dithers
the banding away.

## Folding the vignette into `OutputPass` (`VignetteOutputPass`)

The vignette/grain used to be its own full-screen `ShaderPass` sitting
between bloom and `OutputPass`. It is now folded **into** `OutputPass`
instead, which removes one full-screen read+write from every frame at every
tier while changing nothing about the result: the effect still lands in
linear space with the tone-mapping curve applied on top of it, because that
is exactly where in `OutputPass`'s shader it is spliced. A lens effect
belongs before the sensor response, not after it.

`VIGNETTE_GLSL` reads `texel` (which the line it replaces has just sampled)
and leaves the result back in `texel` for the tone-mapping ladder to
consume. The grain hash is the same one-liner `terrain.js` uses to hash
silt: `fract(sin(dot(gl_FragCoord.xy + uFrame, vec2(127.1, 311.7))) *
43758.5453123)`, proportional and centered on 1.0 so it darkens as often as
it brightens and overall exposure doesn't move.

`VignetteOutputPass` is subclassed rather than reimplemented so that
`OutputPass` keeps owning the fiddly part: it rebuilds the shader's defines
from `renderer.toneMapping` and `renderer.outputColorSpace` on every render,
and getting that ladder wrong silently produces a differently-graded image
rather than an error. All this class does is replace the one line that
samples the input texture with the same sample plus the vignette.

The splice is **asserted at construction** against a regex matching
`OutputShader`'s `gl_FragColor = texture2D(tDiffuse, vUv);` line. If a
future three.js reformats that line, this throws at boot with a clear
message instead of quietly dropping the vignette and leaving someone to
notice the corners got brighter. `this.uniforms` is the same object
`OutputPass` handed to its material, so adding to it reaches the material
too — done before the first render, i.e. before the shader is ever compiled.
Because `OutputPass` uses `RawShaderMaterial` (which declares every uniform
by hand), the new uniforms need declaring in the fragment source too, not
just added to the uniforms object.

`uFrame` (bumped every frame in `render()`, wrapped at 1024) decorrelates
the grain between frames — a fixed pattern reads as dirt on the lens rather
than as grain, and dithers nothing once the eye averages it out. It's
wrapped rather than left to climb because this page runs unattended for as
long as it is open, and the hash it feeds is a `sin()` of a dot product,
which stops returning anything decorrelated once the input gets large enough
to eat the float's mantissa — the grain would quietly freeze into a fixed
pattern after a long enough session. A period this long is not visible as a
repeat.

## Sky sphere

`SKY_RADIUS_FRAC = 0.9`: kept comfortably inside `camera.far` so it never
gets clipped as bounds/`camera.far` change on resize.

Background is a sky sphere rather than a flat `scene.background` color, so
it can gradient by world Y (0 = water surface, matching depthRange/terrain
elsewhere). It's re-centered on the camera every frame (`updateCamera`) but
never rotated, so its local-space position doubles as world-space view
direction with no extra transform needed.

The camera lives in the water column, so this sphere is not really "sky" —
it's what an underwater viewer sees at infinite distance in each direction,
which is almost entirely murk. The seasonal sky only survives in the cone
steep enough to exit the surface before the water swallows it (Snell's
window). The path-length fog in the fragment shader is what stops the
background from being a crisp sky pasted behind geometry that has itself
already faded to fog — which is what made the far surface/terrain junction
read as a hard, wrongly-colored band across the frame.

Sphere tessellation (`32, 16`) is deliberately **not** scaled by quality
tier, having been tried that way and reverted. This is one draw of ~500
triangles with no per-vertex work — nothing measurable on any device — but
the sphere is drawn from the inside and fills the entire frame, so
coarsening it does not read as a slightly coarser background: the fragment
shader's gradient is evaluated from the interpolated position, and at 16x8
the interpolation error across those very large triangles turns the whole
backdrop into visible angular gores. A knob that costs the frame nothing and
the image everything.

### Sky fragment shader walkthrough

- **Horizon tone**: `mix(uSkyColor, uHorizonColor, uHorizonStrength)` — the
  warm red/orange/pink the sky takes on where sunlight travels the longest
  path through atmosphere and the short wavelengths have scattered out.
  `uHorizonStrength` scales it by how low the season's sun sits (see
  `season.js`) — strongest in winter/autumn, still faintly present at the
  summer solstice.
- **Above the waterline**: horizon tone climbing to the season's full sky
  color at the zenith, via `smoothstep(0.15, 0.8, up)`. Refraction at the
  surface squeezes the entire 180-degree sky into a ~97-degree cone for an
  underwater viewer, so the true horizon — and the warm band with it —
  lands well up from `dir.y = 0` rather than at it. Without that
  compression the warm tones would sit exactly where the murk below is
  total and would never be visible at all.
- **Sun disc + halo**: faded out through the waterline (`smoothstep(0.0,
  0.06, dir.y)`) so it doesn't also appear mirrored below the horizon.
- **Below the waterline**: no sky to see at all, only the water column
  falling away — this half is the body color sinking into the depths
  (`mix(uWaterColor, uDepthsColor, smoothstep(0.0, 0.45, down))`), and the
  murk below buries nearly all of it anyway.
- **Murk / path length**: only rays angled up out of the surface (y = 0)
  ever escape at all, over a path of `cameraDepth/dir.y` — steeply up is a
  short path and near-level is an enormous one. Everything level or
  downward never exits, so it is pure murk. This is the whole point of the
  sphere being fogged: geometry in front of it already fades to
  `uFogColor` with distance, and the background sits at effectively
  infinite distance, so it has to fade at least as far or it shows through
  as a bright hole wherever the two meet.
- **Which shade of murk**: the fog darkens with depth (`fog.js`), and the
  background has to carry that ramp or it undoes it. Everything
  level-or-downward is fully saturated murk, so a flat `uFogColor` would
  paint the entire lower half of frame one constant tone — a hard ceiling
  on how deep the scene can look, however dark the geometry in front of it
  gets. A background ray has no surface to take a depth from, so it takes
  one from where the murk closes over it: roughly one fog length (`1 /
  uFogDensity`) along its own direction (`murkPoint = cameraPosition + dir
  / uFogDensity`). Rays angled down sample deep, dark water; level ones
  sample the camera's own depth, which is the vertical gradient the eye
  reads.

## No `THREE` lights

No `THREE` lights are added to this scene, deliberately. Every material here
is a hand-written `ShaderMaterial` and none of them declares `lights: true`
or includes THREE's lighting chunks, so scene lights are never read by
anything — a `DirectionalLight`/`AmbientLight`/`HemisphereLight` trio used
to sit here and contributed nothing to a single pixel. The season's sun
color/direction/intensity reach the shaders that want them as uniforms
instead (the sky material above, `terrain.js`'s `sunDir`,
`causticsGenerator.js`).

## Camera framing (`EYE_FRAC` / `TARGET_FRAC`)

`worldX = fish.x` (downstream), `worldZ = fish.y` (across-river), `worldY`
is up (0 = water surface, negative = underwater toward the riverbed). Values
were picked by eye using the D-key debug readout (`main.js`) at a
1498x1308 viewport, then expressed as fractions of bounds so the same
framing holds proportionally at other window sizes.

Unlike when `OrbitControls` owned the camera, `resize()` now re-applies
these every time: with no user drag state to preserve, the framing should
stay proportionally identical at every window size rather than being frozen
at whatever the startup dimensions happened to be.

The shot is **broadside** to the run, not down it. The camera sits just
inside the near bank (`EYE_FRAC.z` is about 1.0, i.e. the far edge of the
channel's width) and looks across and slightly upstream, so the flow
crosses the frame left to right with only a modest component swimming
toward the lens. That framing answers the question the piece is actually
about — how many fish are moving through this stretch of river. Aimed down
the run, the school arrives head-on: fish overlap along the view axis, near
ones hide far ones, and a busy day and a quiet one look much the same.
Broadside, the same fish spread across the frame and the count reads
directly. Measured against the flow direction (+x), the split is:

| | screen-right | toward lens |
|---|---|---|
| down-the-run (old) | 0.44 | 0.89 |
| broadside (now) | 0.89 | 0.45 |

The residual 0.45 toward the lens is deliberate rather than a pure side-on
view: it keeps fish growing as they cross, which reads as depth, and it
keeps the bodies at a three-quarter angle instead of showing every fish as a
flat silhouette.

Constraints these values have to keep satisfying:

- `EYE_FRAC.y` must stay comfortably negative (underwater) and above the
  riverbed at `-RIVER_DEPTH_FRAC` (`terrain.js`) — the sky shader's murk
  path length is measured from the surface down to the camera, so an eye
  above y=0 inverts it.
- `EYE_FRAC.x` must stay **below 1.0**. Fish are flagged for removal once
  they cross `exitX = bounds.width + 40` (`boids.js`) and then spend
  `REMOVE_FADE_FRAMES` fading out while still swimming downstream, and that
  dissolve should not play out in shot. Broadside this is less delicate
  than it was head-on — the exit line is off the right-hand edge, and
  anything on the far side of the channel that could still catch it is
  beyond the fish distance cull (`fishMesh.js`) and already faded — but
  keeping the eye upstream of `exitX` is what makes it true at every window
  size.

## `pixelBounds` vs `worldBounds`

`pixelBounds` is the actual on-screen size (`window.innerWidth`/
`innerHeight`, see `main.js`) and drives everything that has to match the
physical display: `renderer.setSize`, the composer's own buffers,
`camera.aspect`. `worldBounds` is the (smaller, see `WORLD_SCALE` in
`main.js`) size the scene's *content* is built against — the camera
framing, its far plane, the sky sphere's scale, and the fog falloff, all of
which are meant to track how big the river itself is, not how many physical
pixels it's rasterized into. The two used to be the same object; splitting
them is what lets the world shrink independently of the browser window.

## Renderer construction

`antialias` is deliberately **off**, and it is not a quality compromise.
MSAA applies to the default framebuffer only. Everything in this scene is
drawn through `EffectComposer`, whose internal render targets are created
without a `samples` key (i.e. `samples: 0`) — so the scene is never
multisampled no matter what this flag says. The only thing that ever reaches
the default framebuffer is the final `OutputPass` fullscreen quad, which has
no geometry edges to antialias. Leaving it on allocated and resolved a
multisampled backbuffer every frame to smooth the edges of a rectangle that
exactly covers the screen.

`depth`/`stencil` off for the same reason: the composer's targets carry
their own depth buffer, and nothing depth-tests against the default
framebuffer. `powerPreference: "high-performance"` asks a dual-GPU laptop
for the discrete part rather than the integrated one.

## ACES tone mapping

`renderer.toneMapping = THREE.ACESFilmicToneMapping`,
`renderer.toneMappingExposure = 0.55`. Every material in this scene is a
hand-written `ShaderMaterial` (no `MeshStandardMaterial`/etc.), and
`renderer.toneMapping` only has an effect on materials whose shader includes
the `<tonemapping_fragment>`/`<colorspace_fragment>` chunks, which
`ShaderMaterial` never does automatically. Rather than hand-add that chunk
to every custom fragment shader in the scene, `OutputPass` applies it once,
globally, as the last step of the composer chain. Every color in this scene
was hand-picked against a plain clamp-and-gamma-correct pipeline (no tone
mapping at all) — ACES's curve lifts shadows/midtones noticeably relative
to that, which read as a wash of the whole moody/dark look this scene relies
on rather than just fixing flat contrast. Exposure well under 1.0
compensates; still tuned by eye, not derived.

## No `scene.fog`

`THREE` only applies `scene.fog` inside materials that pull in its fog
shader chunks, and every material in this scene is a hand-written
`ShaderMaterial` — which defaults to `fog: false` and would need those
chunks added by hand anyway. A `THREE.FogExp2` used to sit here and affected
nothing; all the fog you can actually see comes from `FOG_GLSL`'s
`applyFog()`, called explicitly by `terrain.js`/`water.js`/`fishMesh.js`
(see `fog.js`).

## Composer / bloom tiers

Chain: render the scene normally (`RenderPass`) into an offscreen linear
buffer, extract+blur its bright regions and add them back
(`UnrealBloomPass` — makes the caustics/specular highlights actually glow
instead of just being bright pixels), then apply the tone-mapping curve and
convert to the display color space as the final step (`OutputPass` — "should
be included at the end of each pass chain"). Bloom's threshold/strength/
radius (`0.4` strength, `0.4` radius, `0.94` threshold — just above the
fog/base-color range so those don't bloom, below the caustics/specular
highlights so those do) are tuned by eye against this scene's caustics
highlights, not physically derived.

Bloom is the most expensive thing in the chain by a wide margin:
`UnrealBloomPass` allocates a bright-pass target plus five horizontal and
five vertical blur targets, and runs separable kernels of 6/10/14/18/22 taps
across them — roughly thirteen additional full-screen passes. Hence the
three-way tier switch rather than an on/off:

- **full** — the resolution the scene was authored against.
- **half** — every internal target is quarter-area. Bloom is a
  low-frequency effect by construction (its whole job is a wide blur), so
  the result is very close to `full` at a quarter of the fill cost.
- **off** — the pass is not constructed at all. The highlights stop
  glowing and read as merely bright, which is a real loss, but it is the
  right thing to give up first on a device that cannot hold frame rate.

`buildComposer` is a function rather than inline construction because a
tier change has to rebuild it: whether the bloom pass exists at all, and
the resolution its mip chain is allocated at, are both fixed at
construction. The vignette pass goes last, carrying the vignette with it —
so the vignette dims the bloom's glow along with everything else rather than
leaving bright halos floating in the darkened corners. Bloom's internal
targets are sized off the actual pixel resolution (`pixelBounds`) — not the
(smaller) world content those pixels happen to depict.

## `resize()` vs `resizeComposer()` split

Re-framing on every resize is safe now that the camera is static: there is
no user drag/zoom state left for it to stomp on, and since the framing is
defined as fractions of bounds, not re-applying it would leave the shot
subtly mis-composed after any window change.

`resize()` takes both bounds because they drive different halves of the
work: anything that has to match the physical screen (renderer/composer
size, aspect) reads `pixelBounds`; anything about how big the river itself
is (camera position/far-plane, sky scale, fog falloff) reads `worldBounds`.
The two share an aspect ratio — `worldBounds` is always `pixelBounds` scaled
by the same factor on both axes (`main.js`) — so `camera.aspect` is correct
off either one; `pixelBounds` is used since that's what it's actually
matching. `resize()` also re-reads `devicePixelRatio`, not just at startup:
dragging the window to a monitor with a different DPI fires resize but
leaves a pixel ratio set for the old screen, which renders soft (or
needlessly large).

`resizeComposer()` is the expensive half, split out so it can run on a
debounce while `resize()` stays on every event. `composer.setSize()`
reallocates `EffectComposer`'s two full-resolution targets **and** calls
`setSize()` on every pass, which rebuilds `UnrealBloomPass`'s ~11-target mip
chain — roughly 13 GPU allocations — and it was running on every single
event of a window drag, the exact churn `main.js`'s debounce comment claimed
to be avoiding (and on mobile it fires on every address-bar show/hide too).
Between the two calls, the composer's buffers are simply still at the
previous size and the final pass scales them to the canvas — a momentary
softness while the edge is moving, which is a much better trade than
reallocating the whole chain at drag frame rate.

Inside `resizeComposer()`: `EffectComposer` caches the renderer's pixel
ratio in its **constructor** and multiplies `setSize()` by that cached
value — so without an explicit `composer.setPixelRatio(renderer
.getPixelRatio())` call, its targets stay at whatever DPI the page booted
at. This matters on a monitor change and also on a tier change, which is
precisely a deliberate pixel-ratio change. (Assigning `bloomPass.resolution`
directly here looks like it would rebuild the mip chain but does nothing —
the pass only reads `resolution` in its constructor.)

## `render()` / `renderer.info.autoReset`

`render()` replaces a direct `renderer.render(scene, camera)` call — see
Composer above for why the bloom/tone-mapping chain needs to run instead.
`renderer.info` normally resets itself on every `renderer.render()` call,
and a composer chain makes several of those per frame — so by the time
anything could read it, it holds only the final fullscreen quad (1 draw, 1
triangle) rather than the frame. Taking manual control
(`renderer.info.autoReset = false`) and resetting once here makes it
accumulate across every pass, which is what the debug panel wants. The
grain's per-frame counter lives in `VignetteOutputPass.render()`, so
`render()` here is just the composer call.

## `applyQuality()`

Re-applies everything in this file that is fixed at construction time from
`QUALITY`, after the governor has stepped the tier down (`quality.js`).
`main.js` pairs this with a full world rebuild — between them, every
tier-dependent resource in the scene is replaced. The composer is disposed
and rebuilt rather than adjusted because the things that change — whether
`UnrealBloomPass` is in the chain at all, and the resolution its eleven
internal targets are allocated at — are only read in constructors.
`applyQuality()` re-runs both halves of resize, not just the cheap one: a
tier change has just built a brand-new composer whose targets are at the
constructor's default size, so this is one of the cases where the
reallocation is the entire point.

## See also

- `.claude/context/scene/water-and-caustics.md` — Snell's window as seen
  from *below* the surface (the water plane's own fresnel/mirror shading),
  and the sun direction this file's sky disc and the caustics net share.
- `.claude/context/scene/season.md` — where `skyColor`/`horizonColor`/
  `waterColor`/`depthsColor`/`sunColor`/`sunIntensity`/`horizonStrength` and
  the swept daily sun direction actually come from.
- `.claude/context/scene/environment.md` — `fog.js`'s `fogDensity`/
  `fogDepthRate`/`FOG_GLSL`, which this file's sky shader and vignette both
  build on.
- `.claude/context/scene/fishMesh.md` — the distance cull and exit/fade
  behavior that `EYE_FRAC.x`'s constraint is protecting against.
- `.claude/context/scene/glsl.md` — `glslFloat()`, used throughout this
  file to interpolate tuning constants into shader source.
