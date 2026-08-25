# Environment: terrain, fog, god rays, particles

Together these four files form the "look" layer around the fish: the riverbed underneath, the fog that swallows distance, the light shafts standing in the water column, and the silt drifting through it. All four are driven by the same season (`season.js`) and the same shared fog model (`fog.js`), and three of them (terrain, god rays, particles) read the caustics texture so the whole environment sweeps together as the sun moves.

## terrain.js — the riverbed

A flat plane below the water surface that falls away into the murk. It is silt, not scenery — deliberately the least interesting surface in the scene, there to close off the bottom of the frame and give fish silhouettes something to read against rather than an empty gradient.

**History.** It used to be a great deal more: a tessellated plane carrying per-vertex shade jitter, with a fragment shader that built two Voronoi layers of cobble and gravel, synthesized per-stone normals, and applied three hand-tuned corrections (parallax, light wrap, seam occlusion) to fake what caustics do when they land on real relief. Roughly 400 lines, essentially all of it erased by a third of the way across the channel — the fog (see below) is tuned to a shallow inland river where visibility is a few body lengths — and where it did survive, in the near field, a fully resolved gravel bed pulled attention off the fish, which are the subject. What's left is a color, a little mottling, and a fog falloff.

**Still the caustics receiver.** This plane draws no caustics itself but stays in the environment map (`causticsGenerator.js`) as the surface the refracted rays terminate against — delete it from that pass and the accumulated light net loses its structure, which would break the glint on the water surface and on the fish. The caustics you can actually see are on those two things only.

**Geometry.** Two triangles (`PlaneGeometry(planeWidth, planeHeight, 1, 1)`). The old mesh was tessellated to roughly 23,000 vertices, and the only thing that needed them was a per-vertex brightness jitter that read as blocky up close anyway — nothing else in either shader that touches this geometry (here, or the caustics environment pass) varies non-linearly across it, and a flat plane interpolates world position exactly from its corners. The `uv` and `normal` attributes are deleted: nothing samples a texture on this surface, and the caustics environment pass reads position only.

**RIVER_DEPTH_FRAC = 0.34** — floor depth below the water surface, as a fraction of `bounds.height`. Was 0.5, which put the bed far enough under the camera that the heavy river fog erased it everywhere except a thin strip along the bottom of frame. A salmon run is shallow water anyway: this brings the bed and the surface both inside the near field, which is what lets a single shot hold a lit riverbed below and the bright surface above.

**TERRAIN_HAZE = 0.86** — constant blend toward the fog color, applied after the distance falloff. Unlike `applyFog` this never resolves, even directly under the camera, so the bed reads as something glimpsed through silt rather than a surface the viewer is standing on. Raised from 0.75 now that there is no gravel detail to preserve: the bed's job is to recede. Note it blends toward `fogColorAt()`, not the flat `uFogColor`: the bed is the deepest surface in the scene, so the haze it never resolves out of is the dark end of the depth ramp rather than the mid-column color the water surface overhead fades into.

**SILT_NOISE_SCALE / SILT_NOISE_STRENGTH (0.03 / 0.1)** — fine per-fragment mottling, the only surface detail left, deliberately near-invisible — just enough that the bed isn't a dead flat wash of one color under the boulders.

**Edge fade stays alpha, not opaque.** The bed dissolves via `planeEdgeFade` at `coreFrac` (matching `buildWaterMesh`'s `uCoreFrac`, so both surfaces fade at the same real-world edge) and remains in the transparent queue with `depthWrite: false`. Making it opaque was tried, to put one depth-writing surface ahead of the transparent stack and give the god rays and silt behind it some early-Z to reject against — this scene otherwise has no opaque pass at all. It was reverted on both halves of the trade:
- The win is small: almost all of the shaft and silt geometry stands in the water column *above* the bed, not behind it, so there is very little for the bed to reject.
- The cost is visible: an opaque bed hides the sky sphere completely below the horizon, and the color it has to dissolve into instead — `fogColorAt()` at the bed's own depth — is darker than the sky it used to blend against, which puts a tonal step across the far edge of the plane exactly where the fade exists to avoid one.

**Oversized plane.** Drawn oversized and re-centered on bounds, exactly like `buildWaterMesh` (see `water.js`): the extra size pushes the plane's rectangular edge out past where fog has already saturated to `uFogColor`, so the edge dissolves into the murk instead of showing up as a hard silhouette line.

**setTerrainSeason()** ties the riverbed's color to the same season driving the sky, water surface, rocks, and fish. `season.floorColor` comes off the same sky/depths derivation as the fog (see `season.js`), which is what keeps the bed from sitting in a different color family than the haze it dissolves into.

## fog.js — shared distance fog

Shared source of truth for the scene's distance fog: the color and density, the depth ramp that darkens that color down the water column, plus an exponential-squared falloff implemented as GLSL.

THREE's own `scene.fog` only reaches materials that pull in its fog shader chunks, and every material in this scene is a hand-written `ShaderMaterial` (`terrain.js`, `water.js`, `fishMesh.js`, and the sky in `sceneSetup.js`) — so each one includes `FOG_GLSL` and calls `applyFog()` itself. **This is the whole fog implementation; there is no `scene.fog` to keep in step with it.**

**FOG_COLOR — one shared, mutated-in-place instance.** Fog is what every distant surface in the scene saturates into, which makes it the single strongest color in frame — so it can't be a fixed constant while the sky moves through the year, or the whole river reads as hazing into a color the sky never contains. It's derived per season from the same sky/depths pair everything else is (see `season.js`). It is deliberately one shared object rather than a value copied out at build time: `terrain.js`, `water.js`, `fishMesh.js` and the sky (`sceneSetup.js`) all pass this exact object into their `uFogColor` uniform, so `setFogSeason()` updating it here reaches every shader in the scene with no per-material plumbing. Anything that needs its own copy must `.clone()` it — a consumer that copies the color at construction instead of holding the reference would silently stay stuck on the startup season.

**FOG_DENSITY_FACTOR = 3.6.** Divided by the world's largest dimension so the falloff distance scales with world size instead of being tuned in raw world units (bounds track window size in this app — see `main.js`). Was 1.2, which left the far bank of the channel plainly legible. A shallow inland river carries enough suspended sediment that visibility underwater is only a few body lengths — fish a short distance off dissolve into the murk entirely, and there is no visible "far side" at all. 3.6 puts the falloff roughly there: mostly saturated by a third of the way across the channel.

### The depth ramp

`FOG_COLOR` alone is one flat color that every surface hazes into no matter where in the water column it sits — which is exactly what makes a river read as a shallow pane of water however dense the fog over it is. There is no vertical light gradient, so the eye has nothing to measure depth against: the bed under the camera saturates to the same tone as the surface above it.

So the fog color is graded by depth instead (`fogColorAt()` in `FOG_GLSL`). Sunlight is absorbed on the way down, so the murk is brightest just under the surface and falls away toward the bed, and each surface dissolves into whichever shade belongs to its own depth.

**Value only, deliberately** — a straight multiply on the season's own fog color rather than a second hand-picked color or a deeper stop on `season.js`'s sky→depths ramp. That ramp is a poor lever here: `RIVER_TINT` dominates its deep end, so pushing `FOG_DEPTH` from 0.52 to 1.0 moves the result by about 3% lightness, nowhere near enough to read as depth. A multiply gets the full range while making it impossible for the deep end to drift out of the season's color family.

`DEEP_FOG_DARKEN = 0.42` — a bit under half the light at the bed. Lower starts crushing the bottom of the frame toward black, which costs the riverbed and the deep fish their silhouettes — the point is a legible gradient, not a dark stripe.

The ramp is measured in world Y (`fogDepthRate()`), so it scales with the depth of the water column rather than with `max(width, height)` the way the distance falloff does. `RIVERBED_DEPTH_FRAC` restates `RIVER_DEPTH_FRAC` from `terrain.js` rather than importing it: `terrain.js` pulls `FOG_GLSL` out of this module at module scope, and importing back would make the two files' evaluation order load-bearing (whichever ran second would hit the other's uninitialized `const`). One number in two places, against a cycle in the module graph.

`FOG_DEPTH_FACTOR = ln(6)` puts the fog ~83% of the way to its deep color by the time it reaches the bed, so most of the ramp is spent inside the water column that actually exists instead of trailing off below it.

**Uniform contract.** Every material that calls `applyFog()`, `fogColorAt()` or `fogAmount()` needs all three of `uFogColor`/`uFogDensity`/`uFogDepthRate`; `uFogDepthRate` defaulting to 0 in a material that forgets it is a silent no-op (a flat fog color again), not a visible break — prefer copying an existing material's uniform block over adding them by hand. `particles.js` and `godRays.js` want only the falloff, not the blend, so they call `fogAmount()` and never touch `uFogColor`/`uFogDepthRate`; the compiler strips what they don't reach, and their unset uniforms with it.

**fogAmount() split out of applyFog().** Three shaders want the falloff without the blend — `particles.js` fades a mote's alpha by it, `godRays.js` dims a shaft by it, and `fishMesh.js` fades the rim light by it — and all three used to carry their own copy of this expression with a comment saying it matched this one.

`applyFog()` grades at the shaded point's own depth rather than at the camera's: what the viewer is judging is how deep *that surface* is, and a fog color that tracked the eye instead would slide the entire gradient up and down with the framing.

## godRays.js — light shafts

Shafts of sunlight coming down through the surface.

**Why derived from caustics, not independent noise.** The scene already computes where light concentrates when it refracts through the waves — that is the caustics texture (see `causticsGenerator.js`), a top-down map of how much light reaches each point of the bed. Until god rays existed it was only ever read at the two ends of that journey: on the surface, and on whatever the light landed on. The shafts are the middle of it, the light scattering off silt on the way down, and they come from the same texture — so a bright knot in the net overhead has a shaft beneath it, and both move together as the water moves. That coherence is the reason to derive them from the caustics rather than from independent noise, which is the usual way this effect is faked and always drifts out of step with the surface.

**Implementation** is a set of vertical quads standing in the water column, turned to face the camera about the Y axis only (never pitching, unlike a particle billboard — a shaft is a column of light with a real, fixed vertical extent, and pitching it toward the camera would tilt it out of the water column), drawn additively. Each fragment traces from its own position back up along the sun direction to find where its light entered the surface, and samples the net there — so the shafts lean the way the season's sun leans, and lean further the deeper you look.

**Shaft count and cost.** `QUALITY.shaftCount` (see `quality.js`), read at build time. Each plane is large and additively blended, so this is bounded by overdraw, not by vertex count — every extra plane is close to a full-screen pass of blending in the worst case, which makes it one of the most expensive things in the frame on a phone and one of the first to cut. A dozen is enough to read as a volume because they are semi-transparent and overlap; eight still does at the medium tier. At the low tier it is zero and `buildGodRays` returns an inert stub (same reasoning/shape as the stub in `particles.js`, plus a no-op `setSunDirection`, which the render loop calls unconditionally).

**NEAR_FRAC / FAR_FRAC (0.34 / 0.82)** — where the shafts stand, as fractions of the world's largest dimension. The near bound keeps a plane from sitting on top of the lens; the far one stops before the fog has fully saturated, since a shaft out there adds nothing but blend cost.

**ABOVE_SURFACE = 30** — quads start slightly above y=0 so the top edge is hidden behind the water surface plane rather than ending in a visible horizontal cut.

**DEPTH_FALLOFF = 3.1** — how quickly a shaft dies out with depth. Light scattering down through turbid water loses intensity fast, much faster than the distance fog does, which is what keeps the shafts as a feature of the upper water column instead of a glow filling the whole frame.

**INTENSITY = 1.1**, deliberately low: these are additive **and** sit under a bloom pass (`sceneSetup.js`), so they compound twice — a value that looks reasonable on its own turns the near planes into flat glowing slabs once several overlap and the bloom picks them up.

**BEAM_STRENGTH = 30 / BEAM_CONTRAST = 3.0.** The net is a dim, broad signal at source (see `causticsGenerator.js`) — the surface reads it at strength 8 and the fish at 18 — and it has to be lifted well up the saturation curve first (`BEAM_STRENGTH`), or the power curve (`BEAM_CONTRAST`) crushes the whole range to nothing rather than separating bright from dim. Higher contrast is a harder separation between beam and dark water; below about 1.5 the shafts smear back into a general glow.

**Fragment shader detail:**
- Traces back up the sun direction to where light crossed the surface: `entry = worldPos.xz + uSunDir.xz * (below / max(uSunDir.y, 0.3))`, since `uSunDir` points toward the sun and going up along it by `depth / sunDir.y` lands on y = 0. The `max()` keeps a low winter sun from smearing the sample halfway across the river.
- Saturate then hard contrast curve: separates beams from a wash — the raw net is a broad, mostly-dim field, and scattering it evenly down the column just fogs the whole frame. The power curve keeps the bright knots and crushes everything else, so discrete shafts fall with dark water between them.
- Two vertical fades: an exponential (the physical falloff) plus a `smoothstep` on top that forces it to exactly zero at the quad's bottom edge — the exponential alone never reaches zero, and a shaft that stops at 4% of full brightness leaves a visible horizontal seam across the frame.
- `surfaceFade` ramps in below the surface over a real world distance rather than a token one, since these planes can sit close to the camera, where a short ramp in world units is a hard bright line across a large part of the screen.
- Fog applies **additively**, not by blending toward `uFogColor`: a shaft far enough away is scattering light that itself has to travel back through the murk, so it arrives dimmer rather than fog-colored. This takes `fogAmount()`'s factor (see `fog.js`) and not `applyFog` itself.

**setWorldSize(coverage, bounds)** — `coverage` is the *caustics pass's* world coverage, not the water sim's: a shaft's only texture read is the net at its surface entry point, so it maps world XZ through that pass's own extent. Those two used to be the same value; they are not any more (see `causticsWorldSize` in `water.js`).

**setSunDirection()** — pushed every frame alongside the caustics generator's own copy (see `season.js`'s `sweptSunDirection`); the two have to be the same sun or the shafts would lean one way while the net they sample slid the other.

**setSeason()** — shaft color is the sun's own color, pulled toward the light net's tone (`lerp(season.causticsColor1, 0.45)`) since this is sunlight already partway through the water, not sunlight in air. Intensity scales with `season.sunIntensity` (`0.55 + 0.45 * sunIntensity`), so a low seasonal sun puts less light down the column and winter shafts are weaker than summer ones without needing their own schedule.

## particles.js — suspended silt

Suspended silt drifting in the water column — the single strongest depth cue this scene can have.

A shallow inland river is turbid (it is why the fog is tuned as heavily as it is, see above), and what actually tells a viewer they are looking *through* water rather than at a blue-tinted void is the debris hanging in it: near specks sliding past quickly and legibly, far ones dissolving into the murk. The fog alone gives distance but no texture, so the water column between the camera and the school reads as empty.

**Entirely GPU-driven.** Each mote's start position is uploaded once as an instance attribute and never touched again; drift and wrap-around happen in the vertex shader from `uTime`, so the per-frame CPU cost is one uniform write no matter how many motes there are. That was the whole point of doing it this way — there is no per-particle JavaScript to get expensive.

**Billboarded quads, not `THREE.Points`.** `gl_PointSize` is capped by the driver and specified in pixels, so points cannot hold a consistent *world* size as they recede, which is exactly the cue this effect is here to give.

**PARTICLE_COUNT** comes from `QUALITY.particleCount` (see `quality.js`), read at build time. Every mote is a transparent, blended, camera-facing quad that also does a caustics lookup in its vertex shader, so this is a fill-rate number rather than a geometry one, which is exactly the budget a phone has least of. At the low tier it is zero and `buildParticles` returns an inert stub — an empty `Group` (so `createWorld`'s `scene.add()` / `destroyWorld`'s `scene.remove()` still have an `Object3D` to work with) and no-op methods so every caller stays unconditional. Cheaper and much less error-prone than sprinkling `particles?.` through the render loop.

**VOLUME_FRAC = 0.62** — the drift volume, as a fraction of the world's largest dimension. Sized so density lands where motes are actually resolvable — fog has anything beyond this regardless, so a bigger box would just be spending instances on invisible specks.

**Sizing history (MIN_SIZE 2.0 / MAX_SIZE 5.5).** A fish renders 72–84 units nose-to-tail (see `boids.js`), so these motes are on the order of a centimetre of real silt against a three-foot Chinook. Small enough to read as suspended matter rather than snow, which is the failure mode this effect always has — `MAX_SIZE` came down from 9.0 because the largest near-field motes were crossing into it, and again from 7.2 (`MIN_SIZE` from 2.6) once the river itself shrank to 55% of its former size (see `WORLD_SCALE` in `main.js`): the drift volume shrank along with it (`VOLUME_FRAC` is a fraction of bounds, and depth a fraction of `bounds.height`, so volume scales with `WORLD_SCALE^3`) but `PARTICLE_COUNT` didn't, so the same motes are now packed roughly 6x denser per unit volume. That reads as more field to look at, at the same size each, rather than as more silt in the same water; sizing back down doesn't undo the density but does stop the field competing with the fish for attention at any one point in frame.

**Visibility dials (OPACITY 0.46, BRIGHTNESS 1.85, GLOW_GAIN 0.35).** Silt is meant to be noticed as texture in the water, not counted as individual objects. Kept as named constants because they trade off against each other — dropping opacity while raising brightness gets you back where you started — and because this is the first thing to reach for when the effect is over- or under-stated. `OPACITY` was 0.62, brought down alongside the size cut above for the same reason. `BRIGHTNESS` exists because motes catch light from every direction rather than presenting one shaded face, so they sit brighter than the riverbed color they're derived from. `GLOW_GAIN` is how much of a caustic highlight a mote picks up when it drifts through one.

**DRIFT_X = 7** world units/second downstream. The run flows +x (see `boids.js`), so the silt goes with it — but far slower than the fish, since it is being carried by the water rather than swimming through it. Reading a mote drift past while a salmon powers by is a big part of what sells the fish as fast.

**BOB_AMPLITUDE / BOB_SPEED (5.5 / 0.22)** — gentle vertical churn, so the field isn't a rigid sheet sliding sideways.

**Vertex shader detail:**
- `mod()` wrap makes the field endless without any CPU bookkeeping: a mote leaving the downstream face reappears at the upstream one, and since every mote has a different start position they don't wrap in unison.
- Billboarding reads `right`/`up` straight out of the view matrix columns so every mote faces the viewer regardless of where it sits.
- Caustic glow is sampled per-vertex, not per-fragment — a mote is a few pixels across, so this is already far finer than it needs to be.

**Fragment shader detail:**
- Soft round mote via `smoothstep` on radius: a hard-edged quad reads as a square at close range, and these get close.
- Distance fade is applied to **alpha**, not by blending toward the fog color: tinting a mote to fog color makes it vanish against the background but still lays a visible speck over any fish in front of it; fading it out removes it from the frame entirely, which is what a mote too far away to resolve should do.
- `depthWrite: false` — motes are unlit specks in suspension, not solid objects; they should never occlude a fish behind them, and with thousands of overlapping quads the sorting to do that correctly isn't worth paying for.

**Volume centering.** The volume spans the whole water column and is centered midway between the eye and what it is looking at, rather than on the eye itself. Centering on the camera is the obvious thing and it is wrong for a broadside shot (see `EYE_FRAC` in `sceneSetup.js`): the eye sits at the edge of the channel, so half the box would hang off the bank behind it, and the far half of the water actually in frame would have no silt in it at all. The midpoint puts the density in the volume being looked through.

**setWorldSize(coverage, bounds)** — same caveat as `godRays.js`: `coverage` is the caustics pass's world coverage, not the water sim's, since the only thing this shader samples is the caustic net.

**setSeason()** — silt is lit by the same water it hangs in, so it takes the season's riverbed color (`season.floorColor`), scaled by `BRIGHTNESS`; glow color comes from `season.causticsColor1`.

**dispose()** only disposes `geometry`, not the shared `quad` — the instanced geometry shares `quad`'s attribute objects rather than copying them, so disposing both would try to release the same buffers twice.

## See also

- `.claude/context/scene/season.md` — the palette (`floorColor`, `fogColor`) and sun direction (`sweptSunDirection`, `refractedSunDirection`) all four files consume.
- `.claude/context/scene/water-and-caustics.md` — `causticsGenerator.js` produces the texture god rays, particles, and terrain's caustics receiver all read; `water.js` shares terrain's oversized-plane edge-fade trick and `causticsWorldSize`.
- `.claude/context/scene/glsl.md` — the shared `causticGlowChunk()`/`causticGlowAt()` read that terrain, god rays, and particles all call, plus the procedural caustics fallback used at lower quality tiers.
- `.claude/context/scene/fishMesh.md` — shares `fogAmount()`'s rim-light fade and the depth-fog color fade with terrain/particles.
- `.claude/context/quality.md` — `QUALITY.shaftCount`/`QUALITY.particleCount`/`QUALITY.realCaustics` gate god rays, particles, and the real-vs-procedural caustics split.
