// fishAnatomy.js
// Anatomy anchors for the fish viewer's labeled plate (src/inspect.js). The
// GLBs carry no anatomical structure to key off — every model is one mesh,
// one material, a bare 16-bone spine (see the NOTE at the top of
// fishMesh.js) — so each part below is a hand-placed target point in the
// model's own local space, snapped to the nearest real vertex rather than
// left floating. That keeps a label glued to the actual surface without
// pretending the mesh has geometry it doesn't.
//
// Coordinates are fractions of the model's own extent, in the local space
// loadSpeciesModel leaves geometry in (fishMesh.js): body along Z with the
// nose at +Z, lateral axis X, vertical axis Y, everything recentered on the
// bounding-box center.
//   t — nose (0) to tail (1) fraction along Z.
//   x — fraction of half-width along X. Positive picks the +X flank; since
//       the model is bilaterally symmetric, this is "a side", not "the
//       correct side" — whichever way the turntable currently has the fish
//       facing decides whether that flank is toward the camera or not (see
//       the facing-normal cull in inspect.js), so paired features are
//       expected to appear and disappear as the fish rotates.
//   y — fraction of half-height along Y. Positive is dorsal, negative
//       ventral.
import * as THREE from "three";
import { SPECIES_MODEL_URL, PHASE_TO_CYCLE } from "./fishMesh.js";

// Salmonids: chinook, jack chinook (same mesh as chinook), steelhead. Real
// fins and a real adipose fin — the small, rayless fin unique to this family,
// and the one a hatchery clips before release (see FIG. 3 in the plates
// drawer).
const SALMONID_PARTS = [
  { id: "snout", label: "Snout", t: 0.02, x: 0, y: 0.05, note: "The pointed front of the head." },
  { id: "eye", label: "Eye", t: 0.1, x: 0.85, y: 0.35, note: "Set high and to the side for a wide field of view." },
  { id: "operculum", label: "Operculum", t: 0.18, x: 0.95, y: 0, note: "The bony gill cover — flares open and shut as the fish breathes." },
  { id: "pectoralFin", label: "Pectoral Fin", t: 0.24, x: 0.9, y: -0.5, note: "Paired fin just behind the gills. Steers and brakes." },
  { id: "dorsalFin", label: "Dorsal Fin", t: 0.45, x: 0, y: 1, note: "The fin along the back. Keeps the fish from rolling." },
  { id: "pelvicFin", label: "Pelvic Fin", t: 0.55, x: 0.6, y: -0.9, note: "Paired fin on the belly. Fine steering and stability." },
  { id: "adiposeFin", label: "Adipose Fin", t: 0.68, x: 0, y: 0.9, note: "A small, rayless fin found only on salmon and trout. Hatchery fish usually have it clipped before release — that clip is how wild and hatchery fish are told apart at the dam (see FIG. 3, Wild vs. Hatchery Steelhead)." },
  { id: "analFin", label: "Anal Fin", t: 0.74, x: 0, y: -0.9, note: "Behind the vent. Stabilizes against side-to-side yaw." },
  { id: "lateralLine", label: "Lateral Line", t: 0.5, x: 0.95, y: 0, note: "A row of sensory pores along the flank, sensing vibration and pressure change in the water." },
  { id: "caudalPeduncle", label: "Caudal Peduncle", t: 0.9, x: 0.3, y: 0, note: "The narrow “wrist” joining body to tail, where swimming power concentrates." },
  { id: "caudalFin", label: "Caudal Fin", t: 0.98, x: 0, y: 0.55, note: "The tail fin — the main source of forward thrust." },
];

// Shad: a clupeid, not a salmonid — no adipose fin, a deeply forked tail,
// and a keel of ventral scutes (modified, sharp-edged scales) along the
// belly that salmon and trout don't have. Sharing the salmonid list here
// would put a fin label on a fish that doesn't have that fin.
const SHAD_PARTS = [
  { id: "snout", label: "Snout", t: 0.03, x: 0, y: 0.1, note: "The front of the head — blunter than a salmonid's." },
  { id: "eye", label: "Eye", t: 0.12, x: 0.85, y: 0.4, note: "Large relative to the head, typical of a fish that feeds on plankton by sight." },
  { id: "operculum", label: "Operculum", t: 0.2, x: 0.95, y: 0, note: "The bony gill cover." },
  { id: "pectoralFin", label: "Pectoral Fin", t: 0.25, x: 0.9, y: -0.55, note: "Paired fin just behind the gills." },
  { id: "dorsalFin", label: "Dorsal Fin", t: 0.45, x: 0, y: 1, note: "The single fin along the back." },
  { id: "pelvicFin", label: "Pelvic Fin", t: 0.55, x: 0.6, y: -0.85, note: "Paired fin on the belly." },
  { id: "ventralScutes", label: "Ventral Scutes", t: 0.65, x: 0, y: -0.95, note: "A keel of sharp, modified scales along the belly — a family trait shared with herring, and absent in salmon and trout." },
  { id: "analFin", label: "Anal Fin", t: 0.78, x: 0, y: -0.85, note: "A long fin behind the vent." },
  { id: "caudalPeduncle", label: "Caudal Peduncle", t: 0.9, x: 0.25, y: 0, note: "The narrow joint between body and tail." },
  { id: "caudalFin", label: "Caudal Fin", t: 0.98, x: 0, y: 0.5, note: "Deeply forked — more so than any salmonid's — typical of an open-water schooling fish." },
];

const PARTS_BY_SPECIES = {
  chinook: SALMONID_PARTS,
  jackChinook: SALMONID_PARTS,
  steelhead: SALMONID_PARTS,
  shad: SHAD_PARTS,
};

function computeHalfExtents(positions) {
  let halfWidth = 0;
  let halfHeight = 0;
  for (let i = 0; i < positions.count; i++) {
    halfWidth = Math.max(halfWidth, Math.abs(positions.getX(i)));
    halfHeight = Math.max(halfHeight, Math.abs(positions.getY(i)));
  }
  return { halfWidth, halfHeight };
}

// Nearest actual vertex to a target point, weighting the nose-tail axis
// heavier than the other two — `t` is the primary thing each part's author
// reasoned about, so it should stay authoritative even where the surface
// curves away in x/y near a target that sits just off the mesh.
function nearestVertex(positions, target) {
  let best = -1;
  let bestDist = Infinity;
  for (let i = 0; i < positions.count; i++) {
    const dx = positions.getX(i) - target.x;
    const dy = positions.getY(i) - target.y;
    const dz = (positions.getZ(i) - target.z) * 2;
    const dist = dx * dx + dy * dy + dz * dz;
    if (dist < bestDist) {
      bestDist = dist;
      best = i;
    }
  }
  return best;
}

const resolvedCache = new Map();

// Resolves this species' part list to real vertex indices in `assets`
// (one entry of the assetsByUrl Map loadFishAssets() resolves to — see
// SPECIES_MODEL_URL). Cached per species: the geometry never changes after
// load, so this only has to run once per species per page load, not once per
// species change.
export function resolveAnatomy(species, assetsByUrl) {
  if (resolvedCache.has(species)) return resolvedCache.get(species);

  const url = SPECIES_MODEL_URL[species];
  const assets = assetsByUrl.get(url);
  const parts = PARTS_BY_SPECIES[species] ?? SALMONID_PARTS;
  const positions = assets.geometry.attributes.position;
  const { halfWidth, halfHeight } = computeHalfExtents(positions);
  const target = new THREE.Vector3();

  const resolved = parts.map((part) => {
    target.set(
      part.x * halfWidth,
      part.y * halfHeight,
      assets.modelLength / 2 - part.t * assets.modelLength,
    );
    const vertexIndex = nearestVertex(positions, target);
    return {
      id: part.id,
      label: part.label,
      note: part.note,
      // The authored x fraction, kept on the resolved anchor so the overlay
      // (inspect.js) can tell a genuinely paired lateral feature (|side|
      // large — eye, pectoral fin, ...) from a midline one (side ≈ 0 — the
      // dorsal fin, ...) and only run the near/far-side facing test on the
      // former. See the note by that test for why.
      side: part.x,
      vertexIndex,
      restPosition: new THREE.Vector3(
        positions.getX(vertexIndex),
        positions.getY(vertexIndex),
        positions.getZ(vertexIndex),
      ),
      restNormal: assets.geometry.attributes.normal
        ? new THREE.Vector3(
            assets.geometry.attributes.normal.getX(vertexIndex),
            assets.geometry.attributes.normal.getY(vertexIndex),
            assets.geometry.attributes.normal.getZ(vertexIndex),
          )
        : new THREE.Vector3(0, 0, 1),
    };
  });

  resolvedCache.set(species, resolved);
  return resolved;
}

// Replicates VERTEX_SHADER's swim-bend sampling on the CPU for one vertex,
// so a label can track the exact same animated surface the shader draws —
// see sampleVatOffset/`bent` in fishMesh.js. NearestFilter + texel-center UVs
// mean the shader never interpolates spatially, so reading the raw baked
// array directly (rather than going through a real texture sample) gives an
// identical result.
export function animatedLocalPosition(assets, part, cyclePos, wobblePhase, out) {
  const { vat } = assets;
  const data = vat.texture.image.data;
  const frameCount = vat.frameCount;
  const vertexCount = vat.vertexCount;

  const cycles = cyclePos + wobblePhase * PHASE_TO_CYCLE;
  const frameF = (((cycles % 1) + 1) % 1) * frameCount;
  const frame0 = Math.floor(frameF);
  const t = frameF - frame0;

  const row0 = frame0 % frameCount;
  const row1 = (frame0 + 1) % frameCount;
  const o0 = (row0 * vertexCount + part.vertexIndex) * 4;
  const o1 = (row1 * vertexCount + part.vertexIndex) * 4;

  out.set(
    part.restPosition.x + (data[o0] + (data[o1] - data[o0]) * t),
    part.restPosition.y + (data[o0 + 1] + (data[o1 + 1] - data[o0 + 1]) * t),
    part.restPosition.z + (data[o0 + 2] + (data[o1 + 2] - data[o0 + 2]) * t),
  );
  return out;
}
