# Water and caustics — one coupled GPU system across three files

`waterSim.js`'s GPU height-field simulation feeds both `water.js` (surface
shading) and `causticsGenerator.js` (real-time caustics), and the caustics
output in turn feeds back into `water.js`'s surface glint — so despite being
three separate modules, changes to one routinely require checking the other
two. All three are ported from martinRenou/threejs-caustics.

## `water.js`

### File overview

Water surface: a flat plane at world Y=0, fragment-shaded from the live GPU
height-field simulation in `waterSim.js` (real ripples, not a canned
texture) and lit by the same `causticGlow()` helper `terrain.js` uses (see
`glsl.js`), so the sparkle on the surface and the light net on the riverbed
come from one consistent read of the same water texture.

**Vertex displacement was attempted and reverted.** Actually bumping this
mesh's geometry from the sim's height field (not just shading it) reliably
read back 0 no matter what was tried: hardcoded UVs, a dedicated uniform not
shared with the fragment stage, bypassing the post-processing composer,
removing the fragment stage's own sample of the same texture — none of it
changed the result — despite the identical texture sampling working fine in
both this material's own fragment shader and in `causticsGenerator.js`'s
vertex shader. Root cause not identified; not worth blocking on further. If
you're tempted to retry this, know that the failure mode is specifically
"reads back 0," not a crash or a visibly-wrong value, which made it hard to
diagnose the first time.

The plane itself is drawn larger than the river bounds
(`waterSizeMultiplier()`) and the entire margin beyond the real bounds fades
to 0 opacity — full opacity right up to where the simulation actually is,
then a gradual dissolve into the scene background across the added margin,
rather than ending in a visible rectangle. The water sim itself
(`waterWorldSize()`) is mapped to cover this same oversized area, not just
the literal play-field bounds — so ripples genuinely propagate out into the
fade margin via the sim's own wave diffusion, instead of the margin just
clamping to (and stretching) the sim texture's edge texel. Anything else
that converts a world position into this sim's uv space (`main.js`'s ripple
placement, `fishMesh.js`'s caustic sampling) must use the same
`waterWorldSize()` to stay in registration.

### `waterSizeMultiplier()`

How much bigger than the river bounds the water sim/plane covers — the
entire added margin (from the real edge out to the plane's own edge) is
both the caustics fade zone and the region the sim can propagate ripples
into, so a bigger multiplier reads as a longer, softer dissolve.

Scaled by device tier (`quality.js`), because this number is squared into
fill cost: the water surface and the riverbed are each one big
fragment-heavy quad covering this area, so 2.4 draws 5.8x the bounds while
1.7 draws 2.9x — a little over half the fragments for both surfaces. The fog
closes in well before the plane's edge at the low tier's shorter view
anyway, so the dissolve it is shortening was mostly already invisible.

It's a function rather than the `const` it used to be: the performance
governor can change tiers mid-session (`quality.js`), and a `const` would
have frozen whatever value happened to be current when this module was
first imported. Every caller reads it while building bounds-shaped
resources, which is exactly the work a tier change re-runs.

### `WATER_HEIGHT_SCALE = 150`

World-Y scale for the sim's raw height (`.r` channel) — the sim itself is
unitless (see `waterSim.js`). This mesh no longer displaces its own geometry
with it (see the vertex-displacement note above), but
`causticsGenerator.js`'s refraction ray-march still needs a world-unit
calibration for the sim height, and imports this constant to stay
consistent with whatever this file settles on rather than guessing its own
independent number.

### Snell's window

Seen from underneath, the surface is not a window everywhere. Refraction
squeezes the entire 180-degree world above into a cone about the vertical —
Snell's window — and outside that cone the interface is a perfect mirror by
total internal reflection, showing the water column and bed below rather
than anything above. So the ceiling reads as a bright disc of sky ringed by
dark mirrored murk, with the ripples wobbling the boundary between them,
which is the single most recognizable thing about looking up from
underwater.

`COS_CRITICAL_MIN = 0.6`, `COS_CRITICAL_MAX = 0.73`: cos of the critical
angle, water → air is `sin(t) = 1/1.333` giving `t = 48.6°`, so the window
closes where the view ray is that far off the surface normal — compared
against `|dot(normal, viewDir)|`, which is 1 looking straight up the normal
and 0 at grazing. The real transition is abrupt (reflectance hits 100%
exactly at the critical angle), but a hard step aliases badly against a
rippling normal at this plane's grazing screen angles, so it gets a narrow
smoothstep either side rather than a clean edge.

`WINDOW_SKY_MIX = 0.8`: how much sky the window shows, against the water
body's own color. Not 1.0 — the ray still crossed the water between the
surface and the eye, and the plane is drawn over a sky sphere that is itself
already showing a (fogged) sky through the same window (see
`sceneSetup.md`), so a fully sky-colored plane would double-count it.

`MIRROR_GLINT = 0.5`: the surface glint is refracted sunlight, so strictly
it belongs inside the window and not to the mirror outside it. Killing it
out there entirely costs the whole upper frame its sparkle, though — the
window is a small part of what is on screen — so the mirror keeps this
fraction of it, read as the same light net glimpsed in reflection.

**The replaced fresnel term.** The current Snell's-window mix replaces a
fresnel term that could not run: it was `pow(1 - clamp(dot(normal, viewDir),
0, 1), 3)`, but `waterSurfaceNormal()` builds its Y out of a `sqrt` so the
normal always points up, while the camera is always under the plane so
`viewDir` always points down — that dot product was negative on every
fragment of every frame, clamped to 0, and left fresnel pinned at exactly
1.0. The ceiling was a flat `mix(uBaseColor, uSkyColor, 0.6)` with only the
glint varying across it. The fix uses `abs()` rather than a clamp, because
that sign is the whole problem: what matters is the angle between the ray
and the surface, not which side of it the eye is on.

**What the mirror shows**: the murk the reflected ray descends into.
`reflect()` takes the incident direction (`-viewDir`, the ray traveling from
the eye up to the surface), so `mirrorDir` points back down into the column,
and one fog length along it (`vWorldPos + mirrorDir / uFogDensity`) is where
that reflection stops resolving anything — the same probe the sky sphere's
background uses (see `sceneSetup.md`). It lands at the right brightness on
its own: just outside the window the ray dives steeply into the dark deep,
while at grazing angles it stays shallow and the surface dissolves into the
same haze as the water behind it instead of ending on a hard line.

### `causticsWorldSize()` vs `waterWorldSize()`

The caustics pass's own world coverage is deliberately **not**
`waterWorldSize()`. The two used to be the same function, which is why they
drifted into being treated as the same idea — they are not. The water sim's
coverage is set by how much *plane* has to be drawn: the surface and
riverbed extend `waterSizeMultiplier()` (2.4 at the high tier, so 5.76x the
bounds area) past the river so their edges dissolve into fog instead of
ending on a visible line. The caustics coverage is set by something
completely different — how far light is still legible — and that is a much
shorter distance.

It matters because the caustics pass is the frame's most expensive item: a
`segments²` grid whose **vertex** shader runs a `causticsIterations`-deep
texture-fetch loop. Its cost is proportional to the area covered at constant
world-space vertex density, so covering 5.76x the bounds when ~1.2x is
legible was most of the pass being spent below the fog's noise floor.

`CAUSTICS_FOG_REACH = 2.0`: how far out the caustic net is worth computing,
as a multiple of the fog's own saturation distance. At `fogDensity * dist =
2.0` a surface is `1 - exp(-4) = 98.2%` fog, so added caustic light there is
~2% visible; past that the pass is rasterizing a light net into haze.
`causticsWorldSize()` resolves the reach to `CAUSTICS_FOG_REACH /
fogDensity(bounds)` — since `fogDensity()` is `3.6 / span` (`fog.js`), this
is about `0.56 * span` at the default. The box is never larger than the
water coverage: past that edge the surface and bed have already faded out,
so there is nothing left to light.

It's centered on the eye→target midpoint for the same reason `particles.js`
sizes its silt volume that way: the camera sits at the edge of the channel
looking across it, so a box centered on the eye hangs half its area off the
bank behind the viewer and starves the far water actually in frame. The
`{marginX, marginZ}` returned carries that recentering — the box is centered
on `(centerX, centerZ)` rather than on bounds — so every consumer's uv math
stays the identical `(worldPos.xz + margin) / worldSize` line it already
had.

### Fragment shader notes

- The caustics pass covers a **shorter** reach than the water sim does, so
  the shader needs two separate world→uv mappings (`uWorldSize`/`uMargin`
  for the sim texture, `uCausticsWorldSize`/`uCausticsMargin` for the
  caustics texture). This shader used to compute one uv and use it for
  both, which was correct only for as long as the two coverages were the
  same call.
- `uTime` drives the procedural surface/caustics stand-in at the low
  tier, where there is no simulation to read (`quality.js`). It's unused —
  and compiled out — on the tiers that run the real pipeline, but pushed
  unconditionally so the per-frame call has no branch in it.
- The glint reuses the exact `causticGlow()` read `terrain.js` uses, at
  this same point — the surface glints with the same light pattern that
  lands underwater instead of an unrelated procedural shimmer, through the
  same `softSaturate()` curve (`glsl.js`).
- Fully opaque out to `uCoreFrac` (exactly where the real river bounds end
  — see `buildWaterMesh`), then a smooth dissolve across the rest of the
  oversized plane out to its own edge; the riverbed does the same at the
  same edge (`planeEdgeFade` in `glsl.js`).
- The surface is semi-transparent (`0.8 * edgeFade` alpha), not an opaque
  sheet the way a pool's water surface is in the source demo: fish swim
  below the surface (world Y < 0), and the caustics-lit riverbed sits
  further below still — both need to show through.

### `setWaterTexture()` vs `setCausticsTexture()`

The water sim alternates between two ping-pong render targets, so the
texture driving the surface's normals is a different object from one frame
to the next — hence `setWaterTexture()` is a per-frame setter (see
`main.js`'s loop). The caustics glint overlay, by contrast, comes from a
single accumulation target that is cleared and re-rendered in place (see
`causticsGenerator.js` below), so its texture object never changes identity
— `setCausticsTexture()` is bound once when the world is built.

### `setSeason()`

Ties this surface's body color, the sky its window shows, and its glint
color to the same season driving the sky sphere/sun (`sceneSetup.js`) —
called from `main.js` whenever the displayed date changes, and again after
any resize rebuilds this mesh (a fresh `buildWaterMesh()` call otherwise
resets these to the pre-season defaults). `uCausticsColor` tracks the same
`causticsColor1` `fishMesh.js`'s two-tone glow uses, for consistency across
every caustics-lit surface.

---

## `waterSim.js`

### Port provenance and data layout

GPU height-field water simulation, ported from martinRenou/threejs-caustics
(`shaders/simulation/*.glsl`). A ping-pong pair of render targets holds
`RGBA = (height, velocity, normal.x, normal.z)` for a square sim grid;
dropping "rain" onto it and relaxing it each frame via a discrete wave
equation is what gives the caustics pass real ripples to refract through,
instead of a canned procedural texture. The module is coordinate-system
agnostic: the caller maps its own world `(x, z)` into the sim's `[-1, 1]` uv
space.

### Render target setup

Render targets start with undefined GPU memory, not zeros — both targets
are cleared explicitly at construction so the first few frames don't
refract/ray-march against garbage height/normal data.

The clear color used for that initial clear is saved and restored
afterward. It is renderer-global state, and leaving it on transparent black
leaked out of this constructor into every later `renderer.clear()` call in
the app — including the composer's — for the rest of the session, purely
because this ran once at construction.

### Ping-pong `render()` helper

Renders the given mesh (either the drop or the relax pass), reading from the
current target's texture and writing into the other one, then swaps which
target is "current" for the next call. `addDrop()` writes its
center/radius/strength into the existing uniform `Vector2` rather than
swapping in a fresh array, so a drop allocates nothing per call.

### Drop shader

Raises the height (`.r`) at every texel by a smooth (cosine-eased) falloff
from center, scaled by strength — a single ripple impulse:
`drop = 0.5 - cos(drop * PI) * 0.5`.

### Update shader (discrete wave equation)

Pulls height toward the 4-neighbor average (that's the propagation),
accumulates that pull into velocity (`.g`) with a touch of damping so
ripples fade out, then integrates height:

```
info.g += (average - info.r) * 0.9;   // propagation factor
info.g *= 0.9975;                      // damping
info.r += info.g;
```

Both constants are tuned for a calm stretch of river: a lower propagation
factor (0.9) spreads ripples out more slowly (sluggish, heavy water rather
than a jittery pond-drop), and lighter damping (0.9975, i.e. very little
loss per step) lets a ripple travel further — grow into a broad, slow swell
— before it dies out instead of staying small and local.

The surface normal (`.ba`) is recomputed each step from the local height
gradient — `cross(ddy, ddx)` of the finite-difference tangent vectors,
normalized — for the water/caustics shaders to light and refract against.

---

## `causticsGenerator.js`

### Port provenance and two-pass overview

Real-time water caustics, ported from martinRenou/threejs-caustics
(`shaders/environment_mapping/*.glsl`, `shaders/caustics/water_*.glsl`) —
the same repo `waterSim.js`'s height-field simulation was already ported
from, so the RGBA convention this pass reads (`R=height, G=velocity, B/A=
normal.xz`) already matches with no adaptation needed.

Two passes, run every frame right after the water sim steps:

1. **Environment map**: render the riverbed (this scene's only caustics
   receiver/occluder — see Scope below) from directly above into a texture
   storing world position (rgb) + depth (a) per texel. Same idea as a
   shadow map, just storing position instead of only depth.
2. **Caustics accumulation**: render a dense grid matching the water
   surface's extent, refracting each vertex's position through the water's
   live height-field normal toward the real sun direction, then marching
   against the environment map (stepping one env-map texel at a time — GLSL
   forbids while-loops, hence the fixed-iteration for-loop) to find where
   that refracted ray lands. Brightness at the landing point comes from how
   much the triangle's world-space area shrank or grew under refraction
   (via `dFdx`/`dFdy`) — converging rays = shrinking area = bright;
   diverging = dim — additively splatted (custom `ONE, ONE` blending) so
   overlapping rays accumulate.

### Scope: riverbed-only, fish excluded

The only receiver is the flat riverbed. It's in here purely as the surface
the refracted rays terminate against — it does not draw caustics on itself
(see `environment.md`/`terrain.js`). Without something for the march to
land on, the accumulated light net loses its structure, and that net is
what the water surface and the fish read.

Fish are excluded from the environment map. They move every frame and are
already this scene's most expensive draw (VAT skinning, per-instance
caustics/fog/specular — see `fishMesh.md`), so adding a full
`MAX_POPULATION` of them to a second camera-rendered pass each frame isn't
worth it for an occlusion effect that would be subtle on an otherwise-open
water column anyway. Fish still *receive* the caustics glow (see
`glsl.md`), same as before.

### Straight-down light camera

Rather than aiming the light camera along the real (slightly tilted, see
`season.js`'s `sunDirection`) sun direction the way Renou's demo does, it
looks straight down world `-Y`. That keeps its projected space exactly
aligned with the world-XZ UV convention `(worldPos.xz + margin) /
worldSize` every caustics consumer (`terrain.js`/`water.js`/`fishMesh.js`)
already shares — so the output texture is a drop-in sample for all three
with zero UV math changes. The *actual* refraction inside the shader still
uses the real per-season sun direction; only the rasterization/marching
camera is simplified. Given the modest sun tilt in this scene (further
reduced once `refract()` bends the ray toward the normal entering water),
this keeps the ray-march numerically well-behaved.

### Tier-scaled cost knobs

`causticsMeshSegments()`, `envMapSize()`, `causticsTargetSize()`, and
`maxIterations()` all come from the device tier (`quality.js`) rather than
being fixed. This pass is the most expensive thing in the frame by a wide
margin — its vertex count is `O(segments²)` and each of those vertices runs
a loop of up to `MAX_ITERATIONS` texture fetches — so it's also the one with
the most to give back. The low tier does not run it at all: `createWorld`
in `main.js` skips constructing this generator entirely and every consumer
switches to the procedural stand-in in `glsl.js`.

`causticsMeshSegments()` is a deliberate step down from the water sim's own
resolution (`WATER_SIM_SIZE`, 600 — see `main.js`) since this mesh is a real
draw call every frame, not just a texture lookup.

`maxIterations()` (the ray-march step count) must be a compile-time
constant since WebGL forbids while-loops. Renou's demo uses 50 at his 1024
env map size; kept proportionate here, and scaled down with the rest at
lower tiers since a shorter march against a smaller env map covers the same
fraction of the scene.

`causticsTargetSize()` is read by `main.js` to size `water.js`'s
`causticGlow()` blur texel to this texture's actual resolution — it used to
be sized to the water sim's resolution, back when the surface sampled the
sim texture directly.

### Constants ported from Renou

`ETA = 0.7504` — air→water refractive index ratio (`1/1.333`), same
constant Renou's shader uses. `CAUSTICS_FACTOR = 0.15` — scales the raw
(`RATIO_CAP`-bounded) area-ratio into a usable brightness range; Renou's
demo hardcodes the same 0.15.

### Vertex shader: the `w=0` vs `w=1` projection fix

`position.xy` (see `buildCausticsGeometry`) holds this vertex's
rest-position world `(x, z)` directly — not rotated into 3D, since this mesh
is only ever rasterized through the light camera's own projection, never
drawn as real geometry.

The refraction direction is projected with **`w=0`** deliberately, not
`w=1` like the reference source: `projectionMatrix * viewMatrix *
vec4(refracted, 0.0)`. Renou's light camera sits ~1.5 world units from the
origin, so projecting a unit direction with `w=1` (which bakes in the view
matrix's translation) only mixes in a small, mostly-harmless constant
offset. This scene's light camera sits hundreds of world units above the
scene (`buildLightCamera`) — the same `w=1` quirk there would bake in an
offset far larger than the refracted direction itself, drowning out the
actual per-vertex refraction. `w=0` gives the mathematically correct
(translation-free) projected direction instead.

The march loop is a fixed-count `for` loop (bounded by `maxIterations()`)
that breaks early once `environment.w <= currentDepth` — GLSL has no
while-loop, so the iteration cap has to be a compile-time constant baked
into the shader source per tier.

### Fragment shader: `RATIO_CAP` vs Renou's sentinel

Ported from `shaders/caustics/water_fragment.glsl` — the `dFdx`/`dFdy`
triangle-area ratio itself is coordinate-system agnostic, but the
reference's "arbitrary large value" sentinel (`2e20`) for the
`newArea == 0` degenerate case is **not** reused here. Renou's demo relies
on a depth-tested PCF receiver blur to keep that sentinel from ever really
showing (rare, isolated texels smoothed away). This scene samples the
texture directly with a plain box blur (`glsl.js`) and additively
accumulates hundreds of thousands of triangles into it — a single `2e20`
texel would survive both of those and swamp the entire output regardless of
any downstream strength constant. `RATIO_CAP = 400.0` keeps a genuinely
bright focal point very bright without that unbounded blowout.

### Light camera framing (`buildLightCamera`)

Straight-down orthographic camera covering the same oversized,
bounds-centered area `water.js`/`terrain.js` render into
(`waterWorldSize()`) — see the Scope/straight-down note above for why
straight-down rather than along the real sun direction. Positioned high
enough above the water surface (`y=0`) and with a far plane deep enough
below the terrain floor (`camHeight = depth + 600`, near/far spanning
`camHeight - 400` to `camHeight + depth + 200`) that a reasonable range of
`WATER_HEIGHT_SCALE`-driven start heights can't clip out either end.

### Caustics geometry (`buildCausticsGeometry`)

Flat (unrotated) plane whose `position.xy` directly holds this vertex's
rest-position world `(x, z)` — the caustics vertex shader reads it as such
directly. Unlike `buildWaterMesh`/`buildTerrainMesh` this is never rotated
into the actual 3D XZ plane, since it's only ever rasterized through the
light camera's projection, never drawn as real 3D geometry.

### Additive blending config

`CustomBlending` with `AddEquation`/`OneFactor`/`OneFactor` on RGB:
overlapping refracted triangles should sum their brightness, not
blend/overwrite it (see the two-pass overview above). Depth (alpha) is just
the latest write, not summed (`SrcAlpha=ONE, DstAlpha=ZERO`).

### `renderEnvMap()` runs once, not per frame

The environment map is rendered **once**, at construction, not every frame.
It stores the receiver geometry's world position + depth per texel, and
every input to that is static: `envMaterial` declares no uniforms at all,
the light camera never moves, and the riverbed is built once and never
animates. Re-rendering it per frame — which this used to do — re-rasterized
the receiver 60 times a second to produce a byte-identical texture.

Anything that changes the receiver therefore has to call `renderEnvMap()`
again. Today nothing does mid-session: a resize disposes this whole
generator and builds a fresh one (`createWorld` in `main.js`), which runs it
once as part of construction.

### `setSunDirection()`

The sun this pass refracts is pushed every frame from `main.js`'s loop
rather than per season, because the sun also moves within the day
(`sweptSunDirection` in `season.js`) — and moving it here is what makes the
whole light net slide across the bed, which is the entire mechanism behind
the sweeping shafts, glints, and fish highlights. It's the only per-frame
input this generator has other than the water surface itself.

The direction is negated before being stored (`.multiplyScalar(-1)`)
because GLSL `refract()`'s `I` param wants the incident light's *travel*
direction, while `season.sunDirection` points *toward* the sun.

### `renderToTarget()` / render target hygiene

Both the env-map and caustics passes render through a shared helper that
saves and restores the renderer's target and clear color around the draw,
following the same pattern `waterSim.js` uses for its own initial clear —
so this pass, like that one, doesn't leak renderer-global clear-color state
into whatever renders next.

## See also

- `.claude/context/scene/sceneSetup.md` — the sky sphere's own Snell's
  window (seen from *inside* the water looking up vs. this file's
  looking-down mirror math), and why no `THREE` lights exist for this
  system's sun uniforms to come from instead.
- `.claude/context/scene/season.md` — where `sunDirection` and the swept
  daily arc (`sweptSunDirection`) actually come from; both `water.js`'s
  season-tied colors and `causticsGenerator.js`'s per-frame
  `setSunDirection()` depend on it.
- `.claude/context/scene/environment.md` — `terrain.js`'s riverbed geometry
  (the caustics receiver and `riverDepth()` used by `buildLightCamera`),
  and `fog.js`'s `fogDensity`/`fogColorAt`/`FOG_GLSL` that both `water.js`
  and the sky/mirror math build on.
- `.claude/context/scene/fishMesh.md` — how fish receive (but don't cast)
  the caustics glow, and why they're excluded from the environment map.
- `.claude/context/scene/glsl.md` — the shared chunks these files splice
  in: `causticGlowChunk`, `waterInfoChunk`, `WATER_NORMAL_GLSL`,
  `CAUSTIC_SATURATE_GLSL`/`softSaturate`, `EDGE_FADE_GLSL`/
  `planeEdgeFade`, and `glslFloat()`.
