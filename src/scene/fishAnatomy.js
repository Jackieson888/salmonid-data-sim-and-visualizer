// fishAnatomy.js
// Hand-placed anatomy anchors for the fish viewer's labeled plate (src/inspect.js), snapped to the nearest real vertex per species/model.
// Design rationale, invariants, gotchas: .claude/context/scene/fishAnatomy.md
//
// Part coordinates are fractions of the model's local-space extent (body along Z, nose at +Z; x lateral, y vertical):
// t = nose(0)..tail(1), x = fraction of half-width, y = fraction of half-height.
import * as THREE from "three";
import { SPECIES_MODEL_URL, PHASE_TO_CYCLE } from "./fishMesh.js";

// Salmonids: chinook, jack chinook (same mesh as chinook), steelhead — has an adipose fin, unlike shad/lamprey below.
const SALMONID_PARTS = [
  { id: "snout", label: "Snout", t: 0.02, x: 0, y: 0.05, note: "The pointed front of the head." },
  { id: "eye", label: "Eye", t: 0.1, x: 0.85, y: 0.35, note: "Set high and to the side for a wide field of view." },
  { id: "operculum", label: "Operculum", t: 0.18, x: 0.95, y: 0, note: "The bony gill cover — flares open and shut as the fish breathes." },
  { id: "pectoralFin", label: "Pectoral Fin", t: 0.24, x: 0.9, y: -0.5, note: "Paired fin just behind the gills. Steers and brakes." },
  { id: "dorsalFin", label: "Dorsal Fin", t: 0.45, x: 0, y: 1, note: "The fin along the back. Keeps the fish from rolling." },
  { id: "pelvicFin", label: "Pelvic Fin", t: 0.55, x: 0.6, y: -0.9, note: "Paired fin on the belly. Fine steering and stability." },
  { id: "adiposeFin", label: "Adipose Fin", t: 0.79, x: 0, y: 1, note: "A small, rayless fin found only on salmon and trout. Hatchery fish usually have it clipped before release — that clip is how wild and hatchery fish are told apart at the dam (see FIG. 3, Wild vs. Hatchery Steelhead)." },
  { id: "analFin", label: "Anal Fin", t: 0.74, x: 0, y: -0.9, note: "Behind the vent. Stabilizes against side-to-side yaw." },
  { id: "lateralLine", label: "Lateral Line", t: 0.5, x: 0.95, y: 0, note: "A row of sensory pores along the flank, sensing vibration and pressure change in the water." },
  { id: "caudalPeduncle", label: "Caudal Peduncle", t: 0.9, x: 0.3, y: 0, note: "The narrow “wrist” joining body to tail, where swimming power concentrates." },
  { id: "caudalFin", label: "Caudal Fin", t: 0.98, x: 0, y: 0.55, note: "The tail fin — the main source of forward thrust." },
];

// Shad: a clupeid, not a salmonid — no adipose fin, forked tail, ventral scutes salmonids lack.
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

// Pacific lamprey: a jawless fish (Agnatha), the most anatomically distinct thing in the run — its own list entirely.
const LAMPREY_PARTS = [
  { id: "oralDisc", label: "Oral Disc", t: 0.01, x: 0, y: -0.05, note: "A jawless, cartilage-ringed sucker mouth lined with keratinized teeth — used to latch onto a host fish and rasp through skin to feed on blood and tissue, not to bite." },
  { id: "nostril", label: "Nostril", t: 0.05, x: 0, y: 0.35, note: "A single nasohypophyseal opening on top of the head. Bony fish have paired nostrils; a lamprey has only this one, shared with the pineal (light-sensing) organ beneath it." },
  { id: "eye", label: "Eye", t: 0.09, x: 0.75, y: 0.2, note: "Small and lidless — degenerate in the juvenile filter-feeding stage and only fully developed once it transforms into the eyed, parasitic adult." },
  { id: "gillPores", label: "Gill Pores", t: 0.17, x: 0.9, y: -0.1, note: "Seven round external openings in a row behind the eye, each its own pouch — not a single hinged gill cover (operculum) like a jawed fish has." },
  { id: "dorsalFin", label: "Dorsal Fin", t: 0.55, x: 0, y: 1, note: "Adult Pacific lamprey carry two dorsal fins rather than a bony fish's one. Neither is paired with anything else — no pectoral or pelvic fins exist anywhere on this body." },
  { id: "secondDorsalFin", label: "Second Dorsal Fin", t: 0.78, x: 0, y: 1, note: "The second of the pair, set back toward the tail and, in a mature adult, sometimes close enough to the first to look nearly continuous." },
  { id: "lateralLine", label: "Lateral Line", t: 0.45, x: 0.95, y: 0, note: "A row of sensory pores along the flank sensing vibration and pressure change — the same job a bony fish's lateral line does, in an animal not otherwise built like one." },
  { id: "caudalFin", label: "Caudal Fin", t: 0.98, x: 0, y: 0, note: "A continuous fin fold wrapping the tail rather than a forked or paired-lobe fin — there is no narrow caudal peduncle either; the body simply tapers straight into it." },
];

const PARTS_BY_SPECIES = {
  chinook: SALMONID_PARTS,
  jackChinook: SALMONID_PARTS,
  steelhead: SALMONID_PARTS,
  shad: SHAD_PARTS,
  lamprey: LAMPREY_PARTS,
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

// Nearest actual vertex to a target point, weighting the nose-tail axis heavier than x/y.
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

// Resolves this species' part list to real vertex indices in `assets`; cached per species.
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
      // Authored x fraction — lets inspect.js tell paired features (|side| large) from midline ones.
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

// Replicates the vertex shader's swim-bend sampling on the CPU for one vertex, so a label tracks the same animated surface.
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

// Same idea as animatedLocalPosition, for one bone of the GLB's real armature — stored as absolute positions, not offsets.
export function animatedBonePosition(assets, boneIndex, cyclePos, wobblePhase, out) {
  const { vat } = assets;
  const { positions, count } = vat.bones;
  const frameCount = vat.frameCount;

  const cycles = cyclePos + wobblePhase * PHASE_TO_CYCLE;
  const frameF = (((cycles % 1) + 1) % 1) * frameCount;
  const frame0 = Math.floor(frameF);
  const t = frameF - frame0;

  const row0 = frame0 % frameCount;
  const row1 = (frame0 + 1) % frameCount;
  const o0 = (row0 * count + boneIndex) * 3;
  const o1 = (row1 * count + boneIndex) * 3;

  out.set(
    positions[o0] + (positions[o1] - positions[o0]) * t,
    positions[o0 + 1] + (positions[o1 + 1] - positions[o0 + 1]) * t,
    positions[o0 + 2] + (positions[o1 + 2] - positions[o0 + 2]) * t,
  );
  return out;
}
