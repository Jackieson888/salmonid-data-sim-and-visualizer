# fishAnatomy.js — design rationale, invariants, gotchas

Anatomy anchors for the fish viewer's labeled plate (`src/inspect.js`). The GLBs carry no anatomical structure to key off — every model is one mesh, one material, a bare 16-bone spine (see `.claude/context/scene/fishMesh.md`) — so each part below is a hand-placed target point in the model's own local space, snapped to the nearest real vertex rather than left floating. That keeps a label glued to the actual surface without pretending the mesh has geometry it doesn't.

## Coordinate convention

Coordinates are fractions of the model's own extent, in the local space `loadSpeciesModel` leaves geometry in (`fishMesh.js`): body along Z with the nose at +Z, lateral axis X, vertical axis Y, everything recentered on the bounding-box center.

- `t` — nose (0) to tail (1) fraction along Z.
- `x` — fraction of half-width along X. Positive picks the +X flank; since the model is bilaterally symmetric, this is "a side," not "the correct side" — whichever way the turntable currently has the fish facing decides whether that flank is toward the camera or not (see the facing-normal cull in `inspect.js`), so paired features are expected to appear and disappear as the fish rotates.
- `y` — fraction of half-height along Y. Positive is dorsal, negative ventral.

## Species part lists

Three separate lists exist because the three anatomies genuinely differ, not as a stylistic choice — reusing one list across species would put labels on parts that species doesn't have.

**`SALMONID_PARTS`** — chinook, jack chinook (same mesh as chinook), steelhead. Real fins and a real adipose fin: the small, rayless fin unique to this family, and the one a hatchery clips before release (see FIG. 3 in the plates drawer). The `adiposeFin` anchor's `t` was originally 0.68 — barely past the midpoint between the dorsal fin (~0.46) and the caudal peduncle (~0.91), forward of where a salmonid's adipose fin actually sits, and forward enough on these meshes that the authored `y` of 0.9 had no vertex anywhere near it: the point snapped down to ~0.26 of half-height, onto the upper flank rather than the dorsal ridge, and the label pointed at bare side. `t: 0.79` puts it just ahead of the peduncle where the fin belongs, with `y` staying at the ridge.

**`SHAD_PARTS`** — a clupeid, not a salmonid: no adipose fin, a deeply forked tail, and a keel of ventral scutes (modified, sharp-edged scales) along the belly that salmon and trout don't have. Sharing the salmonid list here would put a fin label on a fish that doesn't have that fin.

**`LAMPREY_PARTS`** — Pacific lamprey, not a bony fish at all: a jawless fish (Agnatha), the most anatomically distinct thing in the run by far. No jaws (an oral sucker disc instead), no paired fins (no pectorals, no pelvics — the dorsal fin(s) and tail finfold are all it has), no scales, no gill cover, no adipose fin. Reusing either list above would put labels on parts a lamprey doesn't have at all, so it gets its own list, including biology-specific notes: the oral disc is a jawless, cartilage-ringed sucker mouth used to latch onto a host and rasp through skin, not to bite; the single nasohypophyseal opening (vs. paired nostrils on a bony fish) is shared with the pineal organ beneath it; the eye is small and lidless, degenerate in the juvenile filter-feeding stage and only fully developed in the eyed, parasitic adult; the seven gill pores are each their own pouch rather than one hinged operculum; adults carry two dorsal fins rather than a bony fish's one, neither paired with anything else since no pectoral or pelvic fins exist anywhere on the body; and the caudal fin is a continuous fold wrapping the tail with no narrow caudal peduncle — the body just tapers straight into it.

## `nearestVertex` — why the Z axis is weighted

Finds the nearest actual vertex to a target point, weighting the nose-tail axis (`dz`) by a factor of 2 relative to `dx`/`dy` before squaring. `t` is the primary thing each part's author reasoned about, so it should stay authoritative even where the surface curves away in x/y near a target that sits just off the mesh — the weighting keeps a snap from sliding a label up or down the body's length just because the nearest raw vertex happened to be a little off in width or height instead.

## `resolveAnatomy` — caching and per-part resolution

Resolves a species' part list to real vertex indices in `assets` (one entry of the `assetsByUrl` Map `loadFishAssets()` resolves to — see `SPECIES_MODEL_URL` in `fishMesh.js`). Cached per species in `resolvedCache`, since the geometry never changes after load, so this only has to run once per species per page load rather than once per species change.

Each resolved part carries the authored `x` fraction as `side`, kept on the resolved anchor so the overlay (`inspect.js`) can tell a genuinely paired lateral feature (`|side|` large — eye, pectoral fin, ...) from a midline one (`side` ≈ 0 — the dorsal fin, ...) and only run the near/far-side facing test on the former.

## `animatedLocalPosition` — tracking the shader's own bend on the CPU

Replicates the vertex shader's swim-bend sampling on the CPU for one vertex, so a label can track the exact same animated surface the shader draws (see `sampleVatOffset`/`bent` in `fishMesh.js`). `NearestFilter` plus texel-center UVs in the shader mean it never interpolates spatially, so reading the raw baked array directly here (rather than going through a real texture sample) gives an identical result — there's no approximation gap to account for.

## `animatedBonePosition` — bones are absolute, not offsets

Same idea as `animatedLocalPosition`, for one bone of the GLB's real armature — baked alongside the vertex VAT (see `vat.bones` in `bakeVertexAnimationTexture`, `fishMesh.js`) so the fish viewer's construction reveal can draw the actual rig instead of an invented stand-in. Bone positions are stored ABSOLUTE per baked frame rather than as an offset from a rest pose the way vertices are — there are only a couple-dozen of them, nowhere near enough to justify a texture and the rest-pose indirection that buys — so this interpolates between two frames directly instead of adding onto `part.restPosition`.

## See also

- `.claude/context/scene/fishMesh.md` — the VAT bake, bone bake, and per-model rotation fixup this module's coordinate convention and animation sampling depend on.
- `.claude/context/inspect.md` — the fish viewer page that calls `resolveAnatomy`/`animatedLocalPosition`/`animatedBonePosition`, drives the turntable, and implements the facing-normal cull that decides which paired features are currently visible.
- `.claude/context/plates.md` — FIG. 3 (Wild vs. Hatchery Steelhead), referenced from the adipose-fin note as the place the hatchery clip is explained.
