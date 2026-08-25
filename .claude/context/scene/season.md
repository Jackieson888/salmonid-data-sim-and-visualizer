# season.js — seasonal palette, sun, and diurnal sweep

Maps a calendar date to a blended "seasonal look" for the whole scene — sky, sun, fog, water body, riverbed, and caustics — the visible stand-in for a year passing as the timeline advances. Four keyframes anchored on the equinoxes/solstice, smoothstep-interpolated between whichever two bracket the current day so the look drifts continuously instead of snapping at season boundaries. This file is heavily cross-referenced: `fog.js`, `terrain.js`, `water.js`, `causticsGenerator.js`, `godRays.js`, `particles.js`, and `fishMesh.js` all pull a season-derived value or the sun direction from here.

## Palette basis

Real seasonal sky observations, rather than the teal/green register this file used to invent:

- **Winter & Autumn** — deep, vivid blue. Low humidity and a long atmospheric path for the low sun leave the shorter wavelengths dominant and the color heavily saturated.
- **Spring & Summer** — lighter, hazier blue. Higher humidity and more aerosols scatter light more evenly across wavelengths, which washes the blue out toward white.
- **All seasons** — warm red/orange/pink near the horizon, where sunlight travels through the most atmosphere and the short wavelengths have scattered out entirely. See `horizonColor` on each keyframe, and `horizonStrength()` below for why the effect is strongest in the low-sun seasons.

## Derivation: COHESION

Only three colors per season are hand-picked — `skyColor`, `horizonColor`, `depthsColor`. Everything the viewer actually sees underwater (fog, the water body's own color, the riverbed) is *derived* from the sky/depths pair by `deriveSeason()`, then pulled toward the river's own green (see River tint below), so it is impossible for the fog to drift into a different color family than the sky the way a separately hand-tuned constant did. **Add a new underwater surface by giving it a depth stop here, not its own color.**

`causticsColor1`/`causticsColor2` (the light net on the riverbed/fish/water surface — see `glsl.js`) stay hand-picked and in the cyan-green "light net" family across all four seasons rather than following the sky, since real underwater caustics read as refracted sunlight, not a sky reflection — only their warmth/saturation/value shift with the season.

### Depth stops

Where each underwater surface sits along the `skyColor -> depthsColor` ramp. Bigger = deeper = darker and further from the sky. Ordered the way the eye reads them from a camera in the water column: the riverbed catches the most light, distance fog sits mid-column, and the water body's own base color (what the surface shows before the sky is mixed into it through Snell's window — see `water.js`) is the darkest of the three.

- `FLOOR_DEPTH = 0.42` — the shallowest stop of the three, which reads as counter-intuitive until you remember the riverbed is the one surface here that is *lit* — it catches the sun's caustics directly, so it has to be bright enough to hold its own color underneath them rather than being a dark base the caustic glow simply overwrites (see `terrain.js`'s `TERRAIN_HAZE`).
- `FOG_DEPTH = 0.52` — kept nearer the sky end than the riverbed is. Fog is what the whole scene converges to at eye-level horizon, and pushing it deeper than this turns that convergence into a near-black stripe across the middle of frame that the fish (which fade toward this same color with depth — see `fishMesh.js`'s `DEPTH_FOG_FACTOR`) then read as cutouts against.
- `WATER_DEPTH = 0.86`.

### Silt tint

The riverbed is sediment, not water — nudging the derived floor color a little toward silt (`SILT_COLOR = #6b5c44`, `SILT_MIX = 0.3`) keeps it from reading as one more sheet of glass while still leaving it unmistakably part of the season's family.

### River tint

The Snake River's own color (`RIVER_TINT = #3f9068`, `RIVER_TINT_MIX = 0.55`). This is the correction that keeps the underwater half of the scene honest: the sky over the river is blue, but the water is not a darker copy of that sky the way clear open ocean is — it's green, from the suspended sediment and algae a shallow inland river carries. Every derived underwater color is pulled toward this tint after the sky→depths ramp, so the palette reads as a blue sky over a green river rather than blue sky over blue water.

The seasons still differentiate underneath it: the mix is well under 1, so a winter fog stays colder and darker than a summer one.

Tuned against underwater footage of shallow freshwater runs, where the water column is a saturated green-teal and the blue only survives up near the surface where the sky is refracting through. The previous values (`#4e7361` at 0.45) were too weak and too cyan to overcome the blue sky at the top of the ramp: the derived summer fog landed at hue 178° / 23% saturation, which reads as grey-blue haze rather than river water. These put it at hue 165° / 34%.

The tint is deliberately **lighter** than the color it is correcting, not just greener. Mixing toward a darker green gets the hue but drags the whole underwater half down with it, and the result is a murky bottle-green that buries the fish — the reference look is saturated green *and* luminous. Holding lightness while the saturation climbs is what separates the two.

0.55 is near the top of the mix's useful range. Push much past 0.6 and every season converges on the same color: the tint starts dominating the sky/depths ramp instead of correcting it, and winter stops reading any colder than summer.

### sRGB mixing (`mixSRGB`)

`THREE.Color` holds linear-sRGB values (`ColorManagement` is on by default in r152+), and lerping there drives midpoints noticeably darker than the eye expects. The depth stops above were chosen by eye against sRGB blends, so derivation rounds through sRGB to match. This only runs at module load, once per keyframe — `seasonForDay()`'s per-frame keyframe-to-keyframe lerps stay in linear space, where the two endpoints are close enough that the difference doesn't show.

### horizonStrength()

How strongly the warm horizon band shows, driven by the sun's elevation: the lower the sun sits, the longer the atmospheric path at the horizon and the more completely the short wavelengths scatter out. `0.3 + 0.55 * (1 - max(0, elevation))` — the 0.3 floor is deliberate: warm horizon tones appear in every season, just faintly when the sun is near-overhead, so this never falls all the way to zero.

## Keyframes

- **WINTER** — deep, vivid blue at its most extreme: the lowest sun of the year through the driest air, and the coldest, dimmest water derived from it.
- **SPRING** — humidity climbing off the winter low: the blue lightens and starts to wash toward white, and the sun climbs enough to pull the warm horizon band down toward subtle.
- **SUMMER** — the haziest sky of the year and the highest sun — lightest blue, weakest horizon warmth, and the brightest riverbed, since a near-overhead sun puts the most light down through the water column.
- **AUTUMN** — back to a deep, vivid blue as the humidity drops, but with the year's most golden low sun — the strongly warm horizon against a saturated blue zenith is the most complementary the palette ever gets, and the golden caustics carry that warmth down onto the riverbed and the fish.

`KEYFRAMES` uses approximate equinox/solstice days-of-year (0, 80, 172, 264). WINTER is repeated at day 365 to close the loop, so every day falls between two real keyframes with no separate wraparound case.

## seasonForDay()

`COLOR_KEYS` lists every `THREE.Color` on a keyframe so the function can lerp them all in one loop instead of naming each one twice (once in the keyframe, once in scratch). The returned object (`scratch`) is **reused across calls** — copy values out (`Color.copy()`, `Vector3.copy()`) if you need to hold onto them past the next `seasonForDay()` call.

## Diurnal sweep

`seasonForDay()` gives the season's sun at its daily high point. `sweptSunDirection()` walks it either side of that along an arc, so the sun rises, peaks, and sets rather than hanging at one fixed spot forever.

The point of it is the light net. `causticsGenerator.js` refracts this exact direction through the water surface and ray-marches it down to the bed, so moving the sun slides the whole caustic pattern across the riverbed — and the sun shafts (`godRays.js`), the surface glints (`water.js`), and the glow on the fish (`fishMesh.js`) all read that same texture, so every one of them sweeps together, for free, off one uniform. Faking the motion in the shafts alone would have slid them out of step with the net they are supposed to be beneath.

**Elevation is the term that does the work.** The net's offset from a point on the surface is `depth * tan(refracted angle)`, which is nearly zero for a sun overhead and grows fast as it drops — so a sun changing height translates the net a long way, while one merely changing compass bearing at high summer barely moves it at all. Azimuth is the smaller, perpendicular term that turns the straight slide into an arc.

- `SUN_SWEEP_ELEVATION_ARC = 0.34`, `SUN_SWEEP_AZIMUTH_ARC = 0.38`.
- `SUN_SWEEP_PERIOD = 120` seconds for one full rise-peak-set-return. Deliberately **not** tied to the timeline's day rate (`FRAMES_PER_DAY` in `main.js`): at peak run the timeline crosses a calendar day every couple of seconds, and a sun keeping literal time with that would strobe. This is set by what reads as a calm, noticeable drift instead.
- `MIN_SUN_ELEVATION = 0.3` rad (~17°) — floor on how low the sun may get. Below this the refracted ray runs so flat that the net smears off the far side of the river, and `godRays.js`'s own `max(uSunDir.y, 0.3)` guard starts clamping — so the shafts would stop tracking the sun they are supposed to be coming from.
- The sweep uses `(1 - cos)` rather than `sin`, so phase 0 is the peak and the sun only ever descends from the season's own elevation — never climbs above it, which would undo the whole point of hand-picking it per season.

`azimuth`/`elevation` are decomposed once per day in `setSunSeason()` rather than once per frame — the sweep runs every frame and only ever needs these two angles. Held here rather than in `main.js` for the same reason `fog.js` holds `FOG_COLOR`: the base is a pure function of the day, the sweep is a pure function of the base and the clock, and nothing outside this file has any business recombining them. `setSunSeason()` is called from `applySeason()`, exactly alongside `setFogSeason()`.

## refractedSunDirection() — the sun as seen from under the surface

Refraction at the air/water boundary bends every incoming ray toward the vertical, and Snell's law caps how far off vertical it can land: with water at `n = 1.333` (`WATER_IOR`), a ray arriving along the horizon still refracts to 48.6° from straight down. That cone is Snell's window, and it is why a sun low enough to graze the hills is still nearly overhead once you look at it from a fish's depth.

Anything lit underwater wants this rather than the raw `sweptSunDirection()`. Across the year it maps a 17–75° above-water arc onto 44–79° below it: the low end compresses hard, the high end barely moves.

What that buys is the top-lit read the whole scene depends on. At the bottom of the winter arc the raw sun sits at 17°, and handed straight to the fish shader it flattens exactly the contrast that says "the light is up there" — the dorsal surface falls to 0.88 of the diffuse ramp while the belly climbs to 0.71, and the rim gate loosens from 1.00 to 0.70 along the back. Refracted, the back returns to full and the belly drops to 0.55.

The specular does not care either way: it is a half-vector term and stays at zero on downward normals for any sun above the horizon, refracted or not.

Implementation notes: the cosine/sine of the angle from straight up are clamped at 0 because a sun at or below the horizon transmits nothing to refract — `MIN_SUN_ELEVATION` keeps the sweep well clear of that, the clamp is just so the math can't produce a direction pointing into the riverbed. The horizontal component is rescaled to the new (refracted) sine while the vertical is set to the new cosine, which keeps the result unit length at the same azimuth.

## dayOfYear()

`dateStr` is `"YYYY-MM-DD"` (see `data.js`) — parsed as UTC midnight so the result doesn't shift with the browser's local timezone.

Guarded because the failure is otherwise silent and total: an unparseable date yields `NaN`, `seasonForDay()` then lerps every color in the palette by `NaN`, and the whole scene renders as garbage with nothing thrown and nothing logged. The only thing keeping that from firing is DART returning the date format we expect (see `parseDartCsv` in `data.js`), which is not something this end can guarantee.

## See also

- `.claude/context/scene/environment.md` — terrain, fog, god rays, and particles all consume `seasonForDay()`'s derived colors and/or `refractedSunDirection()`.
- `.claude/context/scene/water-and-caustics.md` — the water surface's Snell's window shading and the caustics generator that refracts `sweptSunDirection()` down to the bed.
- `.claude/context/scene/fishMesh.md` — fish shading uses `refractedSunDirection()` and fades toward the fog color with depth.
- `.claude/context/scene/glsl.md` — the caustics/saturation GLSL that every season-driven color eventually feeds into.
