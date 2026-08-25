# glsl.js — shared GLSL chunks

Shader code shared between the scene's hand-written materials, plus the one JS helper needed to interpolate numbers into them safely. These all started life as copy-pasted blocks — the caustics read in three files, the saturation curve in three, the edge fade in two, the water-normal reconstruction in two — each carrying a comment saying it matched the others. Keeping one definition is the only way that stays true.

## glslFloat() — interpolating numbers into GLSL

GLSL types a literal without a decimal point as an int (`"350"`), and an int argument finds no matching overload on float builtins like `pow()` — the shader then **fails to compile and the surface renders as nothing at all, with no exception thrown.** `glslFloat` forces a fractional part on so the literal is always a float.

Non-integers pass through at full double precision rather than being rounded to a fixed number of decimals (`terrain.js` used to round to 4). That is not a behavior change: GLSL parses these to float32, whose ~7 significant digits round both spellings to the identical value.

## Caustics read

Reads the texture `causticsGenerator.js` renders each frame (a light camera + a refraction ray-march against the riverbed, ported from martinRenou/threejs-caustics). A light 4-tap box blur (`CAUSTIC_GLOW_GLSL` / `causticGlow()`) softens `CAUSTICS_TARGET_SIZE`'s texel grid — the same role Renou's own PCF blur plays in his environment fragment shader, simplified since this scene doesn't need his depth-tested receiver logic. Used by `terrain.js` and `water.js`.

**Why a 1-tap variant exists (`CAUSTIC_GLOW_POINT_GLSL` / `causticGlowPoint()`), used only by `fishMesh.js`'s *vertex* shader:**

`terrain.js`/`water.js` read caustics per fragment across large, close-up surfaces where the 4-tap blur is what hides the texel grid. Fish are a different case on both counts: the read happens once per vertex (not per fragment) and the result is then interpolated across the triangle anyway, which is itself a blur — and a fish is small enough on screen that the grid was never resolvable there to begin with.

The cost side is what makes this worth splitting out. The fish vertex shader also does 2 VAT samples, so a 5-tap blur would put it at 7 vertex texture fetches per vertex; at 435 verts per fish and up to `MAX_POPULATION` instances (see `main.js`) that is the single largest term in the frame's vertex cost. Dropping to 1 tap takes it to 3.

To A/B it, swap `fishMesh.js`'s import back to `CAUSTIC_GLOW_GLSL` and restore its `uTexel` uniform.

## Caustics, faked — the procedural fallback

The low tier does not run the caustics pipeline at all — no water simulation, no environment map, no ray-marched accumulation target (see `createWorld` in `main.js`, which skips constructing both). `CAUSTIC_GLOW_PROC_GLSL`/`causticGlowProc()` is what every consumer reads instead.

**Why the real one goes first on a weak device:** `causticsGenerator.js` rasterizes a 257×257 grid whose *vertex* shader runs a 40-iteration loop with a texture fetch per iteration, and the height field feeding it is a 600² ping-pong relax pass doing seven fetches per texel per frame. Vertex texture fetch inside a loop is close to the worst case for older mobile GPUs. Between them they were the two most expensive things in the frame by a wide margin — far more than the fish, despite what this file used to say about vertex counts.

**What replaces them is not a cheaper simulation, it is a drawing of one.** Real caustics are the bright network of lines where a rippled surface focuses sunlight, so what actually has to survive is a moving net of bright filaments with dark cells between them, at roughly the right scale. Two pairs of crossed travelling sine waves interfere into exactly that: the zero crossings of the sum form a shifting web, and raising the inverted distance-from-a-crossing to a power turns that web into thin bright lines with a soft falloff. Four `sin()` calls and a `pow()`, evaluated in-place, against five dependent reads from a half-float render target that something else had to fill first.

It will not match the real light net and is not trying to. It preserves the presence of moving caustics everywhere the scene currently reads them — the water, the shafts, the silt, and the fish are all lit by it.

**PROC_CAUSTIC_SCALE = 0.09** — wavenumber, in radians per world unit, so the web's cell spacing is `2π / PROC_CAUSTIC_SCALE ≈ 70` world units — about one fish length (72–84, see `boids.js`), roughly the spacing the real pass produces at this scene's depth. Coarser than this and the net stops reading as caustics and starts reading as large blobs drifting over everything.

**Domain warp — the reason this reads as caustics rather than wallpaper.** Crossed sine pairs alone interfere into a *regular* lattice — visibly a grid of identical cells, which is the one thing real caustics never look like. Displacing the sample point by a slower, differently-scaled wave before evaluating the pattern stretches and pinches those cells unevenly and animates that distortion, which is what the real thing does as the swell moves under it.

Two crossed wave pairs run at deliberately non-harmonic frequencies and drift rates so the pattern never repeats or pulses in step with itself. `|a| + |b|` is near zero along the crossings and rises away from them — a distance-to-the-web term, inverted and sharpened into thin filaments; the exponent (2.6) is what separates "bright web on dark water" from "generally mottled."

The output scale (`* 0.42` at the end) is set against what the real pass actually produces — `causticsGenerator.js`'s `CAUSTICS_FACTOR * area` ratio, blurred, lands mostly in the low tenths — because every consumer multiplies this by its own strength constant (8 on the surface, 18 on the fish, 30 on the shafts) that was tuned against that range.

## Procedural water info (`WATER_INFO_PROC_GLSL` / `proceduralWaterInfo()`)

Procedural stand-in for one sample of the water simulation's height field, in the same RGBA convention `waterSim.js` writes and `WATER_NORMAL_GLSL` reads: `(height, velocity, normal.x, normal.z)`.

Only `water.js` needs this — it is the one surface that lights itself from the surface normal (Snell's window, the mirror, the glint) rather than just reading the caustic net. The normal comes from the analytic derivative of the height sum rather than from differencing neighbouring samples, which is both cheaper and exact. `velocity` is always returned as 0: nothing downstream reads `.g`.

**PROC_WAVE_SCALE = 0.021** — wavenumber, in radians per world unit: the base term's wavelength is `2π / PROC_WAVE_SCALE ≈ 300` world units, against a fish that renders 72–84 nose to tail. That is the broad, slow swell the real simulation is tuned for (see the propagation/damping notes in `waterSim.js`), not pond chop.

**PROC_WAVE_HEIGHT = 0.35** — world-Y amplitude of the height sum, matching `WATER_HEIGHT_SCALE`'s role for the real sim.

**PROC_NORMAL_SLOPE = 0.09** — how far the ripples are allowed to tilt the surface normal, as a slope. This is the single most sensitive number in the procedural path. `water.js` lights the surface through Snell's window, whose entire behaviour is a `smoothstep` across `|dot(normal, viewDir)|` between 0.6 and 0.73 — a band about 8° wide. A normal that swings further than that sweeps the whole window from fully open to fully mirrored and back, which does not read as ripples at all: it reads as huge organic lobes crawling across the ceiling. Real ripples perturb the normal by a couple of degrees, so the tilt has to stay well inside the window's own band.

The derivative implementation is a *normalized* slope in [-1, 1] rather than a true derivative: the chain rule brings the inner scale factor `s` back out of `d/dworldXZ`, but since it's divided straight back out again below, it's left off in the shader. That is what makes `PROC_NORMAL_SLOPE` a plain slope in world units instead of a number that would silently change meaning every time the wavelength was retuned.

## Picking between them (`causticGlowChunk()` / `waterInfoChunk()`)

The one entry point every caustics consumer calls, resolved at material build time from the current quality tier. `causticGlowChunk()` returns GLSL defining:

```glsl
float causticGlowAt(sampler2D caustics, vec2 uv, vec2 texel, vec2 worldXZ, float time)
```

The signature deliberately carries the inputs *both* paths could want, and each implementation ignores the ones it doesn't — the texture path never looks at `worldXZ` or `time`, the procedural path never looks at the sampler or `uv`. Passing the sampler as a parameter (which GLSL permits, and which the two functions above already did) is what keeps this a pure drop-in: a consumer's uniform block, its declaration order, and the chunk's position at the top of the shader all stay exactly as they were. In procedural mode the unused sampler is dead code and the compiler drops it, so nothing has to bind a texture that no longer exists.

`taps` selects the 5-tap box blur (large close-up surfaces, where the accumulation target's texel grid would otherwise be visible) or a single tap (per-vertex reads, and anything small enough on screen that the grid never resolved). It is ignored entirely on the procedural path, which has no texels to blur.

**Edge fade (`CAUSTICS_EDGE_FADE = 0.08`, in uv units — the outer 8% of each edge).** Fades the net out across the outermost band of uv on each side, and kills it entirely outside [0, 1]. This lives inside the shared entry point, rather than in each consumer, so all four inherit it from one place (see `causticsWorldSize` in `water.js` for what the coverage now is).

It is **not optional**. The accumulation target is CLAMP-sampled, so a uv outside its coverage does not read black: it reads the edge texel and holds it, which smears whatever bright knot happens to sit on the boundary in an infinite streak across everything beyond it. And now that the coverage is sized to the fog's own reach rather than to the whole water plane, there is real geometry out there to smear it onto.

The fade band is generous because the boundary is invisible *only* if nothing crosses it abruptly. At the coverage edge a surface is ~98% fog, so this is dissolving something already almost gone — which is exactly why it can afford to be soft rather than tight.

`waterInfoChunk()` is the same idea for the water surface's own height/normal sample — only `water.js` calls it, since it is the one surface lit from the surface normal itself (Snell's window, the mirror outside it, the glint) rather than just reading the caustic net. Returns `waterSim.js`'s `(height, velocity, normal.x, normal.z)` either way, so `WATER_NORMAL_GLSL`'s `waterSurfaceNormal()` consumes both identically.

## Soft saturation (`CAUSTIC_SATURATE_GLSL` / `softSaturate()`)

Applied to the raw caustic intensity by `terrain.js`, `water.js`, and `fishMesh.js` alike.

Real caustics are an extremely peaky signal — a few tiny, very bright focal points against a mostly-dim field — so a hard `min()` clamp made "dim" and "very bright" read as either invisible or maxed-out with no gradation in between. It also popped: the live water sim's curvature spikes frame to frame, and a hard clamp turns "just under the cap" and "just over it" into a visible on/off flicker every time a spike crosses that line. This curve's slope shrinks as it approaches the ceiling (Reinhard-style), so the same spike lands as a much smaller, smoother change in brightness.

`CAUSTIC_GLOW_CEILING = 1.4` is exposed as a constant because `fishMesh.js` also divides by it, to normalize the saturated value back into [0, 1] for its two-tone caustic color mix.

## Surface helpers

**Edge fade (`EDGE_FADE_GLSL` / `planeEdgeFade()`).** The water surface and the riverbed are both drawn `waterSizeMultiplier()` bigger than the real river bounds (see `water.js`), fully opaque out to `coreFrac` — exactly where those bounds end — and then dissolving across the added margin to nothing at the plane's own edge, so the rectangle disappears into the fog instead of cutting off as a hard silhouette line. Uses `max()` of the two axes rather than `length()`, so the fade wraps all four sides and corners of the rectangle evenly instead of rounding it into a circle.

**Water normal reconstruction (`WATER_NORMAL_GLSL` / `waterSurfaceNormal()`).** Rebuilds the water surface normal from one sample of the sim texture, whose RGBA is `(height, velocity, normal.x, normal.z)` — see `waterSim.js`'s update fragment shader. Only the two tangential components are stored, so the vertical one is recovered on the assumption of a unit normal. Shared by `water.js` (which lights the surface with it) and `causticsGenerator.js` (which refracts through it). No axis swizzle needed: this scene's Y-up world already matches this convention, where Renou's Z-up source needs a `.xzy`.

## See also

- `.claude/context/scene/season.md` — the sun direction and caustics colors that flow into everything reading this file's caustics chunks.
- `.claude/context/scene/environment.md` — `terrain.js`, `godRays.js`, and `particles.js` are the main consumers of `causticGlowChunk()`/`causticGlowAt()` and the edge-fade helper.
- `.claude/context/scene/water-and-caustics.md` — `water.js` and `causticsGenerator.js` are the other consumers (`waterInfoChunk()`, `WATER_NORMAL_GLSL`, the real caustics pipeline this file's procedural path stands in for at low quality).
- `.claude/context/scene/fishMesh.md` — uses the 1-tap caustics read and the soft-saturation ceiling.
- `.claude/context/quality.md` — `QUALITY.realCaustics` is the switch between the real and procedural paths in this file.
