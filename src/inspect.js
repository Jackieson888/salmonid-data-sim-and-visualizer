// inspect.js — standalone single-fish viewer: species picker, turntable, anatomy-label overlay.
// Design rationale, invariants, gotchas: .claude/context/inspect.md

import { QUALITY } from "./quality.js";

// Only one instance is ever drawn here, so (unlike the river) this always
// renders at the richest settings. realCaustics is forced off because this
// page has no real accumulation texture for it to sample.
QUALITY.realCaustics = false;
QUALITY.fishHighlights = true;

import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import {
  loadFishAssets,
  createFishInstancedMesh,
  SPECIES_MODEL_URL,
  PHASE_TO_CYCLE,
} from "./scene/fishMesh.js";
import {
  resolveAnatomy,
  animatedLocalPosition,
  animatedBonePosition,
} from "./scene/fishAnatomy.js";
import { FOG_GLSL } from "./scene/fog.js";
import { Fish, BODY_VISUAL_SCALE, SPECIES_LENGTH_INCHES } from "./boids.js";
import { runData, runYear } from "./data.js";
import { seasonFraction } from "./seasonScale.js";
import { initInsightToast, createInfoButton } from "./insights.js";
import { createDrawer } from "./drawer.js";

const canvas = document.getElementById("fish-canvas");
const fishLoadingEl = document.getElementById("fish-loading");
const speciesListEl = document.getElementById("species-list");
const playingToggle = document.getElementById("playing-toggle");
const rotateToggle = document.getElementById("rotate-toggle");
const labelsToggle = document.getElementById("labels-toggle");
const resetViewBtn = document.getElementById("reset-view");
const turbiditySlider = document.getElementById("turbidity-slider");
const turbidityValueEl = document.getElementById("turbidity-value");
const constructionToggle = document.getElementById("construction-toggle");
const constructionStageEl = document.getElementById("construction-stage");
const lengthScaleEl = document.getElementById("length-scale");
const seasonCardEl = document.getElementById("season-card");
const fieldGuideEl = document.getElementById("field-guide");
const overlaySvg = document.getElementById("anatomy-overlay");
const inspectPanel = document.getElementById("inspect-panel");
const inspectBar = document.getElementById("inspect-bar");
const fieldNotesToggle = document.getElementById("field-notes-toggle");
const fieldNotesClose = document.getElementById("field-notes-close");
const fieldNotesSpeciesNameEl = document.getElementById("field-notes-species-name");
const inspectBarToggle = document.getElementById("inspect-bar-toggle");

// The species on show, in the order the panel lists them — largest salmonid
// first, then down the run to the one that isn't a bony fish at all. The
// river's own tables key off the same five (see SPECIES_KEYS in main.js).
const SPECIES = [
  "chinook",
  "jackChinook",
  "steelhead",
  "shad",
  "lamprey",
];

// Replaces the old `speciesSelect.value` reads. The picker is a list of
// buttons now, so there is no control holding the current value — this is it.
let currentSpecies = "steelhead";

// The view toggles (playing/rotate/labels) are buttons with aria-pressed
// rather than checkboxes — these two helpers are the `.checked` read/write
// every other line in this file used to reach for directly.
function isPressed(btn) {
  return btn.getAttribute("aria-pressed") === "true";
}
function setPressed(btn, value) {
  btn.setAttribute("aria-pressed", String(value));
}

const PREFERS_REDUCED_MOTION = window.matchMedia(
  "(prefers-reduced-motion: reduce)",
).matches;
// A default, not a lock — turning swimming/rotate back on works normally.
if (PREFERS_REDUCED_MOTION) {
  setPressed(playingToggle, false);
  setPressed(rotateToggle, false);
}

// Plain neutral backdrop, no THREE lights (fish material is self-lit — see fishMesh.js).
const scene = new THREE.Scene();
const BACKDROP_COLOR = 0x0b0f13;
scene.background = new THREE.Color(BACKDROP_COLOR);

const camera = new THREE.PerspectiveCamera(45, 1, 1, 5000);

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, QUALITY.pixelRatio));
// Matches sceneSetup.js's grading so the model reads the same as in the river.
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.55;

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.minDistance = 10;
controls.maxDistance = 4000;
controls.autoRotateSpeed = 6;
controls.autoRotate = isPressed(rotateToggle);

let grid = null;

// Points the camera/grid at the fish. Called on load/species-change/reset, never per frame.
function frameCamera(bodyLength) {
  // bbox center sits half a body length behind the nose (noseOffsetLocal in
  // fishMesh.js); previewFish is nose-anchored at the origin heading +Z.
  const target = new THREE.Vector3(0, 0, -bodyLength / 2);
  controls.target.copy(target);
  // Backed off ~20% from the original 1.1/0.45/1.3 multipliers, same
  // direction/framing — a portrait aspect narrows the horizontal FOV more
  // than the vertical one (fov is vertical, see the camera constructor
  // above), which clipped a wide-bodied species like steelhead at the
  // original, tighter distance.
  camera.position.set(
    target.x + bodyLength * 1.3,
    target.y + bodyLength * 0.55,
    target.z + bodyLength * 1.55,
  );
  camera.near = Math.max(1, bodyLength * 0.02);
  camera.far = bodyLength * 40;
  camera.updateProjectionMatrix();

  if (grid) {
    scene.remove(grid);
    grid.geometry.dispose();
    grid.material.dispose();
  }
  // Colors matched to style.css's --line/--line-soft so the grid reads as
  // this page's own chrome rather than an arbitrary three.js default.
  grid = new THREE.GridHelper(bodyLength * 5, 20, 0x2c3841, 0x1b242a);
  grid.position.y = target.y - bodyLength * 0.35;
  scene.add(grid);
}

let lastBodyLength = 0;

resetViewBtn.addEventListener("click", () => {
  if (lastBodyLength > 0) frameCamera(lastBodyLength);
  // Camera jumps instantly, so labels must too — see snapLabelLayout.
  snapLabelLayout();
});

function resize() {
  const width = window.innerWidth;
  const height = window.innerHeight;
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
  renderer.setSize(width, height);
  overlaySvg.setAttribute("viewBox", `0 0 ${width} ${height}`);
}
window.addEventListener("resize", resize);

// #inspect-panel's height is pinned to #inspect-bar's real box via --bar-h
// (inspect.css) rather than a resize listener, since the bar's own height
// depends on content this script fills in after first paint.
new ResizeObserver(([entry]) => {
  document.documentElement.style.setProperty(
    "--bar-h",
    `${entry.borderBoxSize?.[0]?.blockSize ?? entry.contentRect.height}px`,
  );
}).observe(inspectBar);
resize();

// Field notes is the same drawer component as the river's own plates
// drawer (see drawer.js/plates.js) — open/close, Escape-to-close and toggle
// button state all come from there rather than a second hand-kept-in-sync
// copy. Closed by default so the fish fills more of the screen; no
// shortcutKey, unlike Plates' "p" — createDrawer() takes that as opt-in.
// fieldNotesToggle stays a plain "Field Notes" open button always (static
// markup, not JS-driven); fieldNotesClose is the dedicated icon inside the
// panel itself.
createDrawer({
  panel: inspectPanel,
  toggle: fieldNotesToggle,
  closeButton: fieldNotesClose,
});

// The bottom bar collapses to just species selection (see
// #inspect-bar.collapsed, inspect.css). Defaults compact on a small/short
// viewport (read once at boot, not watched — same one-time-read convention
// PREFERS_REDUCED_MOTION above uses) so the model reads larger on a phone
// without an extra tap; desktop opens full.
// inspectBarToggle carries a static chevron icon (inspect.html), not text —
// its accessible name comes from aria-label, not textContent.
function setBarCollapsed(collapsed) {
  inspectBar.classList.toggle("collapsed", collapsed);
  inspectBarToggle.setAttribute("aria-pressed", String(collapsed));
  inspectBarToggle.setAttribute("aria-label", collapsed ? "Expand panel" : "Collapse panel");
}
inspectBarToggle.addEventListener("click", () =>
  setBarCollapsed(!inspectBar.classList.contains("collapsed")),
);
setBarCollapsed(
  typeof matchMedia === "function" &&
    matchMedia("(max-width: 700px), (max-height: 560px)").matches,
);

// The one fish — built from boids.js's real Fish class, then overridden below
// for a fish that isn't part of a running simulation.
let previewFish = null;

function makePreviewFish(species) {
  const fish = new Fish(0, 0, species);
  // Forces past the spawn-fade window (Fish.opacity ramps via age; nothing here steps a Flock).
  fish.age = 999;
  // Depth wander is a flocking concern; pin flat instead of a random depth.
  fish.depth = 0;
  fish.depthTarget = 0;
  // Heading fixed to +Z (matches frameCamera) so a species change doesn't spin the fish.
  fish.vx = 0;
  fish.vy = 1;
  // Natural cruise speed/full stroke, not a tunable (1.2 matches BASE_MAX_SPEED in main.js).
  fish.smoothSpeed = 1.2;
  fish.swimAmplitude = 1;
  return fish;
}

let fishRenderer = null;
// assetsByUrlRef is the full Map loadFishAssets() resolves to; fishAssets is
// the current species' own entry (resolveAnatomy wants the Map, swim-bend
// sampling wants one entry directly).
let assetsByUrlRef = null;
let fishAssets = null;
let anatomyParts = [];

const SCIENTIFIC_NAMES = {
  chinook: "Oncorhynchus tshawytscha",
  jackChinook: "Oncorhynchus tshawytscha",
  steelhead: "Oncorhynchus mykiss",
  shad: "Alosa sapidissima",
  lamprey: "Entosphenus tridentatus",
};
const COMMON_NAMES = {
  chinook: "Chinook Salmon",
  jackChinook: "Jack Chinook Salmon",
  steelhead: "Steelhead",
  shad: "American Shad",
  lamprey: "Pacific Lamprey",
};
// Field notes for the panel's "Field notes" section, paraphrased from
// public/*-field-notes.md (`source`). Grouped by category (FIELD_NOTE_CATEGORIES)
// rather than one flat list; a species missing a category simply omits it.
const SPECIES_FIELD_NOTES = {
  chinook: {
    intro: "The largest Pacific salmon, and the species this counting season is named for.",
    facts: [
      {
        category: "identification",
        text: "Also known as king, quinnat, tyee, tule or blackmouth salmon — the last name from a black gumline that, together with irregular black spotting across the back, dorsal fin and both lobes of the tail, is the surest way to tell a Chinook from the other salmonids sharing this river.",
      },
      {
        category: "identification",
        text: "A ridgeback male and a blunt-nosed female look like different fish by the time they reach the spawning grounds: mature males develop a hump-backed profile and a hooked upper jaw, while females stay torpedo-shaped.",
      },
      {
        category: "range",
        text: "Chinook range the full Pacific Rim — Monterey Bay to the Chukchi Sea on the North American side, the Anadyr River to Hokkaido on the Asian side — with the Columbia and Snake system this project counts sitting on the North American edge of that range.",
      },
      {
        category: "diet",
        text: "Diet shifts hard with life stage: freshwater juveniles eat plankton and insects, then ocean adults switch to herring, pilchard, sandlance, squid and crustaceans — growing fast enough to double their body weight in a single ocean summer.",
      },
      {
        category: "migration",
        text: "Adults stop feeding entirely once they re-enter fresh water, running the whole migration on stored reserves — condition visibly deteriorates the longer a run takes, which is part of why late fish in a run tend to look rougher than early ones.",
      },
      {
        category: "migration",
        text: "The Sp / Su / Fa split reported above isn't one run stretched thin — it's three genetically and behaviorally distinct runs, built from different freshwater life histories, passing the same dam months apart.",
      },
      {
        category: "life history",
        text: "A run can include fish maturing anywhere from age 2 to age 7, so a four-pound jack and a fifty-pound adult can turn up in the same week — that spread is what keeps a single day's size distribution so wide.",
      },
    ],
    source: "/chinook-salmon-field-notes.md",
  },
  jackChinook: {
    intro: "A “jack” is a precocious male Chinook that returns to spawn a year early, at a much smaller size than a typical adult.",
    facts: [
      {
        category: "life history",
        text: "Jacks are counted separately here because they return after just one winter at sea instead of two to five — same run, same brood, just an early ticket home.",
      },
      {
        category: "conservation",
        text: "Because jacks are the fastest-maturing fish from a given brood year, fishery managers sometimes read a strong jack count as an early signal for a strong adult return two years later.",
      },
    ],
    source: "/chinook-salmon-field-notes.md",
  },
  steelhead: {
    intro: "A sea-run form of rainbow trout. Unlike Pacific salmon, some steelhead survive spawning and return to the ocean to spawn again.",
    facts: [
      {
        category: "identification",
        text: "Appearance alone isn't a reliable way to tell a steelhead from a resident rainbow trout — steelhead tend to run more silvery and larger-bodied, but the only certain ID methods are scale analysis or the chemical signature locked into the ear bones (otoliths).",
      },
      {
        category: "range",
        text: "Freshwater is really just a spawning stopover: a steelhead's year runs freshwater rivers and lakes for spawning, a brackish estuary as a transit zone, then the open ocean for the long non-spawning stretch — most of a steelhead's life is actually spent at sea.",
      },
      {
        category: "diet",
        text: "Diet scales up with age — zooplankton as a juvenile, then fish eggs, crustaceans, mollusks and small fish as an adult, with mice turning up often enough in stomach-content studies to be worth a mention.",
      },
      {
        category: "migration",
        text: "Both freshwater rearing and ocean residence are loosely timed and vary fish to fish, which is part of why the steelhead run spreads across so much of the season instead of arriving as one clean pulse.",
      },
      {
        category: "life history",
        text: "Steelhead and resident rainbow trout are the same species and the same gene pool — going migratory isn't fixed by lineage, so two steelhead parents can raise offspring that never leave the river.",
      },
      {
        category: "life history",
        text: "Unlike every other species counted here, steelhead are iteroparous: a fish passing the dam this year can pass again in a later season, so one individual can count toward more than one year's total.",
      },
      {
        category: "conservation",
        text: "The wild share reported above (an intact adipose fin) is a floor, not an exact split — some unmarked hatchery fish get counted as wild too.",
      },
      {
        category: "conservation",
        text: "NOAA/NMFS recognizes 12 Distinct Population Segments of steelhead along the West Coast — as of the source survey, 1 endangered, 10 threatened, 2 experimental populations and 1 species-of-concern segment — while the National Fish Hatchery System raises over 6 million steelhead a year to support both fishing and recovery.",
      },
    ],
    source: "/steelhead-trout-field-notes.md",
  },
  shad: {
    intro: "Not native to the Columbia Basin — introduced from the Atlantic coast in the 1870s.",
    facts: [
      {
        category: "identification",
        text: "A herring, not a trout or salmon — the largest member of the herring family found on the Atlantic coast — and a filter feeder besides, swimming with its mouth open and straining plankton out of the water through its gill rakers rather than hunting the way the salmonids here do.",
      },
      {
        category: "range",
        text: "Not native to this basin at all: shad were transplanted from the Atlantic coast to the Pacific in the 1870s and are now established from Cook Inlet, Alaska down to Baja California — the run passing Lower Granite descends from that 19th-century introduction, not a native population.",
      },
      {
        category: "range",
        text: "Outside of spawning, adults spend most of the year at sea, splitting time between summer feeding grounds in the Gulf of Maine and wintering grounds further south in the mid-Atlantic.",
      },
      {
        category: "migration",
        text: "Feeding stops entirely once shad turn upriver, the same all-in strategy Chinook use — by the time a shad reaches Lower Granite it's running on reserves alone.",
      },
      {
        category: "life history",
        text: "Shad are broadcast spawners — several males and one female release eggs and milt straight into open water at dusk, no redd, no gravel — and the whole event is keyed to water hitting about 65°F, not a calendar date.",
      },
      {
        category: "life history",
        text: "A single female can lay up to 600,000 eggs in a season. That's part of why the shad band in the composition plate can swing so much wider than the salmonids' even though shad are the smaller fish.",
      },
      {
        category: "conservation",
        text: "Shad once anchored some of the largest commercial and recreational fisheries on the Atlantic coast — that collapsed under dams, habitat loss and overfishing, closing the at-sea fishery in 2005. Recovery work since has focused on dam bypasses, habitat restoration, and fish-passage measures written into hydroelectric relicensing.",
      },
    ],
    source: "/american-shad-field-notes.md",
  },
  lamprey: {
    intro: "A jawless fish, not a true fish in the bony-fish sense at all — closer kin to hagfish than to salmon. Parasitic on other fish at sea, then dies after its one spawning run, like Pacific salmon.",
    facts: [
      {
        category: "identification",
        text: "Not a fish in the usual sense — a jawless, cartilaginous species with no paired fins, no scales and no jaw at all. Its mouth is a round, sucker-like oral disc ringed with teeth, its gills are open slits along the head rather than a single cover, and with no swim bladder it swims in a snakelike undulating motion or holds fast to a surface instead of hovering neutrally the way a bony fish does.",
      },
      {
        category: "diet",
        text: "The parasitic phase of a lamprey's life happens entirely at sea — 1 to 4 years attached to marine fish and mammals with its oral disc, feeding on them without, as far as anyone has found, seriously harming the host.",
      },
      {
        category: "migration",
        text: "Almost all lamprey migration happens at night — exactly what FIG. 6 in the data plates shows, with day and night counts typically split by close to an order of magnitude.",
      },
      {
        category: "life history",
        text: "A mating pair digs its own redd by moving individual stones with their mouths, and fecundity is wide open — a female can lay anywhere from 20,000 to 200,000 eggs depending on the individual.",
      },
      {
        category: "life history",
        text: "There's no solid evidence lamprey home to their natal stream the way salmon do, so the run passing Lower Granite isn't necessarily returning to where it hatched.",
      },
      {
        category: "life history",
        text: "Larvae spend 3 to 8 years burrowed in river-bottom silt before growing eyes or teeth — several times longer than a salmon juvenile spends in fresh water — so a strong adult count today reflects river conditions from most of a decade ago, not this year's.",
      },
      {
        category: "conservation",
        text: "Their oral disc grips like a suction cup on smooth surfaces, but fish ladders built for salmon — sharp corners, diffuser gratings, thin bar screens — often trap or block lamprey instead. That mismatch is a leading reason lamprey counts have fallen harder than the salmon sharing this river.",
      },
      {
        category: "conservation",
        text: "Status varies sharply by state — Sensitive in Oregon, Priority in Washington, Endangered in Idaho, a federal Species of Concern — with the decline hitting hardest in the upper Columbia, Snake and North Umpqua basins. Lamprey are also culturally significant, harvested for millennia by the Yurok, Karuk, Nez Perce, Yakama, Umatilla and other Northwest tribes, who now co-lead restoration planning for the species.",
      },
    ],
    source: "/pacific-lamprey-field-notes.md",
  },
};

// Fixed display order/labels for the fact categories above (same order every
// species), roughly following how a field guide itself progresses.
const FIELD_NOTE_CATEGORIES = [
  ["identification", "Identification"],
  ["range", "Range & habitat"],
  ["diet", "Diet"],
  ["migration", "Migration & timing"],
  ["life history", "Life history"],
  ["conservation", "Conservation"],
];
const MONTH_NAMES = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

// All eight DART-counted species (five modelled + three not) — denominator
// for "share of run" below, so the figure is a share of everything counted.
const ALL_COUNTED = [...SPECIES, "sockeye", "coho", "jackCoho"];

// Per-day DART counts for one species (see data.js) — everything the panel
// reports comes from this one pass.
function seasonStatsFor(species) {
  let total = 0;
  let peakValue = -1;
  let peakDate = null;
  let firstDate = null;
  let lastDate = null;
  let countedTotal = 0;

  for (const day of runData) {
    const value = day[species] ?? 0;
    total += value;
    for (const key of ALL_COUNTED) countedTotal += day[key] ?? 0;
    if (value > peakValue) {
      peakValue = value;
      peakDate = day.date;
    }
    // First/last day this species was actually SEEN, not the dam's counting window.
    if (value > 0) {
      if (firstDate === null) firstDate = day.date;
      lastDate = day.date;
    }
  }

  // Dates by which 10%/90% of the season's fish had passed — more honest than
  // first-to-last, which one stray fish in February can stretch across the year.
  let running = 0;
  let tenth = null;
  let ninetieth = null;
  if (total > 0) {
    for (const day of runData) {
      running += day[species] ?? 0;
      if (tenth === null && running >= total * 0.1) tenth = day.date;
      if (ninetieth === null && running >= total * 0.9) ninetieth = day.date;
    }
  }

  return {
    total,
    peakValue: peakValue > 0 ? peakValue : 0,
    peakDate: total > 0 ? peakDate : null,
    firstDate,
    lastDate,
    share: countedTotal > 0 ? total / countedTotal : 0,
    middleWindow: tenth && ninetieth ? [tenth, ninetieth] : null,
  };
}

// Facts DART publishes for one species only; each returns a [label, value] row or null.
function speciesExtraRows(species) {
  const rows = [];

  if (species === "steelhead") {
    let wild = 0;
    let all = 0;
    for (const day of runData) {
      wild += day.wildSteelhead ?? 0;
      all += day.steelhead ?? 0;
    }
    // A SUBSET of the steelhead count, not an addition (Stlhd already includes both).
    if (all > 0) {
      rows.push(["Wild (unclipped)", `${((wild / all) * 100).toFixed(1)}%`]);
    }
  }

  if (species === "lamprey") {
    let night = 0;
    let day = 0;
    for (const row of runData) {
      night += row.lampreyNight ?? 0;
      day += row.lampreyDay ?? 0;
    }
    // Omitted (not 0%) for seasons with no day/night split published (2006-2008).
    if (day + night > 0) {
      rows.push(["Passed at night", `${((night / (day + night)) * 100).toFixed(0)}%`]);
    }
  }

  if (species === "chinook" || species === "jackChinook") {
    // Corps run schedule per date (CHINOOK_RUN_NAMES in dart/parseAdultDaily.js), not per-fish.
    const byRun = new Map();
    for (const day of runData) {
      if (!day.chinookRun) continue;
      byRun.set(day.chinookRun, (byRun.get(day.chinookRun) ?? 0) + (day[species] ?? 0));
    }
    const total = [...byRun.values()].reduce((a, b) => a + b, 0);
    if (total > 0) {
      const share = (name) => Math.round(((byRun.get(name) ?? 0) / total) * 100);
      rows.push([
        "Sp / Su / Fa",
        `${share("Spring")} / ${share("Summer")} / ${share("Fall")}%`,
      ]);
    }
  }

  return rows;
}

function formatDate(dateStr) {
  const [, month, day] = dateStr.split("-").map(Number);
  return `${MONTH_NAMES[month - 1]} ${day}`;
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function labelledRow(label, value) {
  const row = el("p", "fg-row");
  row.appendChild(el("span", "label", label));
  row.appendChild(el("b", null, value));
  return row;
}

// ---------------------------------------------------------------------
// The species picker.
// ---------------------------------------------------------------------
const speciesButtons = new Map();

function buildSpeciesList() {
  for (const species of SPECIES) {
    const btn = el("button", "species-option");
    btn.type = "button";
    btn.setAttribute("role", "radio");
    btn.dataset.species = species;

    // The key square carries the species' water tint, so the panel and the
    // fish in the river are keyed the same colour.
    btn.appendChild(el("i", "species-key"));
    const names = el("span", "species-names");
    names.appendChild(el("span", "species-common", COMMON_NAMES[species]));
    names.appendChild(el("i", "species-scientific", SCIENTIFIC_NAMES[species]));
    btn.appendChild(names);

    btn.addEventListener("click", () => setSpecies(species));
    speciesListEl.appendChild(btn);
    speciesButtons.set(species, btn);
  }

  // Roving focus: the group is one tab stop and the arrows move within it,
  // which is what a radiogroup is expected to do.
  speciesListEl.addEventListener("keydown", (e) => {
    const step = e.key === "ArrowDown" || e.key === "ArrowRight" ? 1
      : e.key === "ArrowUp" || e.key === "ArrowLeft" ? -1
      : 0;
    if (step === 0) return;
    e.preventDefault();
    const i = SPECIES.indexOf(currentSpecies);
    const next = SPECIES[(i + step + SPECIES.length) % SPECIES.length];
    setSpecies(next);
    speciesButtons.get(next).focus();
  });
}

function markSpeciesSelection() {
  for (const [species, btn] of speciesButtons) {
    const selected = species === currentSpecies;
    btn.setAttribute("aria-checked", String(selected));
    btn.classList.toggle("selected", selected);
    // Only the selected option is in the tab order — the rest are reached
    // with the arrows.
    btn.tabIndex = selected ? 0 : -1;
  }
}

// Fish silhouettes for the length scale, traced from the real GLB models
// (scripts/render-fish-silhouettes.mjs) into public/silhouettes/*.png, applied
// as a CSS mask (.len-fish in inspect.css). jackChinook rides chinook's PNG,
// same as it rides chinook's GLB in the river (SPECIES_MODEL_URL, fishMesh.js).
const SILHOUETTE_IMAGE_KEY = {
  chinook: "chinook",
  jackChinook: "chinook",
  steelhead: "steelhead",
  shad: "shad",
  lamprey: "lamprey",
};

function buildFishSilhouette(species) {
  const fish = el("span", "len-fish");
  fish.dataset.species = SILHOUETTE_IMAGE_KEY[species];
  return fish;
}

// Adult length, all five species on one scale — built once, only re-marked on
// species change (the silhouettes themselves never change).
const LENGTH_AXIS_MAX = 48; // inches; clears the longest Chinook
const LENGTH_AXIS_TICKS = [0, 12, 24, 36, 48];
const lengthRows = new Map();

// Short row labels — full common names don't fit this column (picker above has the full names).
const SHORT_NAMES = {
  chinook: "Chinook",
  jackChinook: "Jack",
  steelhead: "Steelhead",
  shad: "Shad",
  lamprey: "Lamprey",
};

// Scales all silhouettes down together (aspect-ratio ties height to width in
// inspect.css); the real min-max span underneath is unaffected.
const LENGTH_FISH_SCALE = 0.5;

function buildLengthScale() {
  const head = el("p", "field-head");
  const label = el("span", "label", "Adult length");
  label.appendChild(
    createInfoButton(
      "length-scale",
      "Each silhouette spans that species' full adult size range, traced " +
        "from this app's own 3D fish models rather than drawn by hand — " +
        "the comparison you're looking at is the real model geometry, not " +
        "an illustration of it.",
      "Adult length",
    ),
  );
  head.appendChild(label);
  lengthScaleEl.appendChild(head);

  for (const species of SPECIES) {
    const [min, max] = SPECIES_LENGTH_INCHES[species];
    const row = el("div", "len-row");
    row.dataset.species = species;
    row.appendChild(el("span", "len-name", SHORT_NAMES[species]));

    // The silhouette spans the real min-max range, not a single figure.
    const track = el("span", "len-track");
    const fish = buildFishSilhouette(species);
    // margin-left (not absolute left) keeps .len-fish in normal flow so its
    // aspect-ratio height sizes .len-track (see .len-fish in inspect.css).
    fish.style.marginLeft = `${(min / LENGTH_AXIS_MAX) * 100}%`;
    fish.style.width = `${((max - min) / LENGTH_AXIS_MAX) * 100 * LENGTH_FISH_SCALE}%`;
    track.appendChild(fish);
    row.appendChild(track);

    row.appendChild(el("span", "len-figure", `${min}–${max}`));
    lengthScaleEl.appendChild(row);
    lengthRows.set(species, row);
  }

  // Axis reuses the row layout (blank cells + a real track) so ticks land
  // exactly on their inch marks instead of using hand-guessed margins.
  const axisRow = el("div", "len-row len-axis-row");
  axisRow.appendChild(el("span", "len-name"));
  const axisTrack = el("span", "len-track len-axis-track");
  for (const tick of LENGTH_AXIS_TICKS) {
    const mark = el("span", "len-tick", String(tick));
    mark.style.left = `${(tick / LENGTH_AXIS_MAX) * 100}%`;
    axisTrack.appendChild(mark);
  }
  axisRow.appendChild(axisTrack);
  axisRow.appendChild(el("span", "len-figure", "in"));
  lengthScaleEl.appendChild(axisRow);
}

function markLengthSelection() {
  for (const [species, row] of lengthRows) {
    row.classList.toggle("current", species === currentSpecies);
  }
}

// This species' season at the dam. The sparkline shares seasonScale.js's
// x-axis and √ scale with the river chart and every plate in the drawer.
const SPARK_W = 300;
const SPARK_H = 46;
const SVG_NS = "http://www.w3.org/2000/svg";
// Quarter-year rules, looked up per season (not every season reaches all three).
const SPARK_AXIS_MONTHS = [4, 7, 10];

function buildSparkline(species, stats) {
  const last = runData.length - 1;
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", `0 0 ${SPARK_W} ${SPARK_H}`);
  svg.setAttribute("preserveAspectRatio", "none");
  svg.setAttribute("class", "spark");
  svg.setAttribute("aria-hidden", "true");

  const peak = Math.max(stats.peakValue, 1);
  const x = (i) => (seasonFraction(i, last) * SPARK_W).toFixed(2);
  const y = (v) => (SPARK_H - Math.sqrt(v / peak) * SPARK_H).toFixed(2);

  // Rule indices are handed back so axis labels below land at the same fractions.
  const rules = [];
  for (const target of SPARK_AXIS_MONTHS) {
    const i = runData.findIndex((day) => Number(day.date.slice(5, 7)) === target);
    if (i === -1) continue;
    rules.push({ index: i, month: target });
    const rule = document.createElementNS(SVG_NS, "line");
    rule.setAttribute("class", "spark-rule");
    rule.setAttribute("x1", x(i));
    rule.setAttribute("x2", x(i));
    rule.setAttribute("y1", 0);
    rule.setAttribute("y2", SPARK_H);
    svg.appendChild(rule);
  }

  const d = [`M 0 ${SPARK_H}`];
  for (let i = 0; i <= last; i++) d.push(`L ${x(i)} ${y(runData[i][species] ?? 0)}`);
  d.push(`L ${SPARK_W} ${SPARK_H} Z`);
  const area = document.createElementNS(SVG_NS, "path");
  area.setAttribute("class", "spark-area");
  area.setAttribute("data-species", species);
  area.setAttribute("d", d.join(" "));
  svg.appendChild(area);

  // Peak day marked in the accent color.
  if (stats.peakDate) {
    const peakIndex = runData.findIndex((day) => day.date === stats.peakDate);
    if (peakIndex >= 0) {
      const mark = document.createElementNS(SVG_NS, "line");
      mark.setAttribute("class", "spark-peak");
      mark.setAttribute("x1", x(peakIndex));
      mark.setAttribute("x2", x(peakIndex));
      mark.setAttribute("y1", 0);
      mark.setAttribute("y2", SPARK_H);
      svg.appendChild(mark);
    }
  }
  return { svg, rules };
}

// Positioned at the same seasonFraction as their rules, not evenly spaced.
function buildSparkAxis(rules) {
  const last = runData.length - 1;
  const axis = el("div", "spark-axis");
  for (const { index, month } of rules) {
    const mark = el("span", null, MONTH_NAMES[month - 1]);
    mark.style.left = `${(seasonFraction(index, last) * 100).toFixed(2)}%`;
    axis.appendChild(mark);
  }
  return axis;
}

function updateSeasonCard(species) {
  const stats = seasonStatsFor(species);
  seasonCardEl.replaceChildren();

  const head = el("p", "field-head");
  const headLabel = el("span", "label", `At Lower Granite, ${runYear}`);
  head.appendChild(headLabel);
  seasonCardEl.appendChild(head);

  if (stats.total === 0) {
    // A real outcome (some seasons counted ~0 of a species), not an error.
    seasonCardEl.appendChild(
      el("p", "fg-note", `None counted at this project in ${runYear}.`),
    );
    return;
  }

  // Only makes sense once there's a real middle-80% window to point at.
  headLabel.appendChild(
    createInfoButton(
      `season-card:${species}:${runYear}`,
      stats.middleWindow
        ? `"Middle 80%" is the window by which the 10th and 90th percentile ` +
          `of this season's total had passed — a more honest answer to ` +
          `"when does this run happen" than first-to-last sighting, since ` +
          `one stray fish in an off month can otherwise stretch the whole ` +
          `season. For ${COMMON_NAMES[species]} in ${runYear}, that's ` +
          `${formatDate(stats.middleWindow[0])} to ${formatDate(stats.middleWindow[1])}.`
        : `"Middle 80%" is the window by which the 10th and 90th percentile ` +
          `of a season's total have passed — a more honest answer to ` +
          `"when does this run happen" than first-to-last sighting, since ` +
          `one stray fish in an off month can otherwise stretch the whole ` +
          `season.`,
      "This season",
    ),
  );

  const { svg, rules } = buildSparkline(species, stats);
  seasonCardEl.appendChild(svg);
  seasonCardEl.appendChild(buildSparkAxis(rules));

  const rows = [
    ["Season total", stats.total.toLocaleString()],
    ["Share of run", `${(stats.share * 100).toFixed(1)}%`],
    ["Peak day", `${stats.peakValue.toLocaleString()} · ${formatDate(stats.peakDate)}`],
    [
      "First / last",
      stats.firstDate
        ? `${formatDate(stats.firstDate)} · ${formatDate(stats.lastDate)}`
        : "—",
    ],
    [
      "Middle 80%",
      stats.middleWindow
        ? `${formatDate(stats.middleWindow[0])} – ${formatDate(stats.middleWindow[1])}`
        : "—",
    ],
    ...speciesExtraRows(species),
  ];
  for (const [label, value] of rows) {
    seasonCardEl.appendChild(labelledRow(label, value));
  }
}

function updateFieldGuide(species) {
  fieldGuideEl.replaceChildren();

  // Names the species explicitly since the bar may be scrolled out of view.
  // #field-notes-head lives outside #field-guide now (inspect.html), sharing
  // the panel's top row with .drawer-close — it doesn't get replaceChildren'd
  // or fadeContent'd along with the rest, just a plain text swap, same as
  // #masthead's identity block not fading through the river's own
  // season-switch dim (ui.md).
  fieldNotesSpeciesNameEl.textContent = COMMON_NAMES[species];

  const notes = SPECIES_FIELD_NOTES[species];
  fieldGuideEl.appendChild(el("p", "fg-note", notes.intro));

  // One block per category, in FIELD_NOTE_CATEGORIES' fixed order; empty categories are skipped.
  for (const [key, label] of FIELD_NOTE_CATEGORIES) {
    const facts = notes.facts.filter((fact) => fact.category === key);
    if (facts.length === 0) continue;

    const section = el("div", "fg-category");
    section.appendChild(el("p", "fg-cat-label", label));
    const list = el("ul", "fg-list");
    for (const fact of facts) list.appendChild(el("li", null, fact.text));
    section.appendChild(list);
    fieldGuideEl.appendChild(section);
  }

  const link = el("a", "fg-source", "Full field notes ↗");
  link.href = notes.source;
  link.target = "_blank";
  link.rel = "noopener";
  fieldGuideEl.appendChild(link);
}

// Dips an element's own content to opacity 0 (.content-fading in
// inspect.css), swaps it while invisible, then lets it fade back in — used
// below for the two panels that replaceChildren() wholesale on a species
// switch (the length scale and species list only ever toggle a class, so a
// plain CSS transition already covers them). Keyed by element in case a
// fast arrow-key rove through the species list calls this again before a
// pending swap has landed: the stale timeout is cancelled so only the
// last-requested species ever actually applies, and the panel stays dimmed
// through the rove instead of flickering up and down each step.
const CONTENT_FADE_MS = 120; // matches --dur-fast in style.css
const pendingContentFade = new WeakMap();

function fadeContent(el, apply) {
  const existing = pendingContentFade.get(el);
  if (existing) clearTimeout(existing);
  el.classList.add("content-fading");
  const timeoutId = setTimeout(() => {
    apply();
    el.classList.remove("content-fading");
    pendingContentFade.delete(el);
  }, CONTENT_FADE_MS);
  pendingContentFade.set(el, timeoutId);
}

function setSpecies(species) {
  currentSpecies = species;
  previewFish = makePreviewFish(species);
  lastBodyLength = previewFish.length * BODY_VISUAL_SCALE;

  markSpeciesSelection();
  frameCamera(lastBodyLength);
  markLengthSelection();
  fadeContent(seasonCardEl, () => updateSeasonCard(species));
  fadeContent(fieldGuideEl, () => updateFieldGuide(species));

  // Different species = different part list, so old label state must not carry over.
  resetLabelLayout();

  if (assetsByUrlRef) {
    fishAssets = assetsByUrlRef.get(SPECIES_MODEL_URL[species]);
    anatomyParts = resolveAnatomy(species, assetsByUrlRef);
    // Rebuild construction assets only if Construction is actually active/exiting.
    if (constructionActive || constructionExiting) ensureConstructionAssets(species);
  }
  // Re-push turbidity — its density scales by body length, which just changed.
  applyTurbidity();
}

rotateToggle.addEventListener("click", () => {
  setPressed(rotateToggle, !isPressed(rotateToggle));
  controls.autoRotate = isPressed(rotateToggle);
});

// Read fresh each frame (render loop / renderAnatomyOverlay), so toggling aria-pressed is enough.
playingToggle.addEventListener("click", () => {
  setPressed(playingToggle, !isPressed(playingToggle));
});
labelsToggle.addEventListener("click", () => {
  setPressed(labelsToggle, !isPressed(labelsToggle));
});

// Turbidity — pushes the fish material's own uFogDensity/uFogColor (see
// setBounds in scene/fishMesh.js for what normally drives those on the river).
const BACKDROP_THREE = new THREE.Color(BACKDROP_COLOR);
// Deliberately its own muddy tone, not a reuse of the river's blue-green FOG_COLOR.
const TURBID_COLOR = new THREE.Color(0x332c1e);
const inspectFogColor = new THREE.Color();

// Scales by body length so falloff isn't tuned in raw world units (lamprey vs. Chinook).
const TURBIDITY_DENSITY_K = 0.85;

const TURBIDITY_LABELS = [
  [0, "Clear"],
  [30, "Hazy"],
  [65, "Silty"],
  [90, "Murky"],
];

function turbidityLabel(value) {
  let label = TURBIDITY_LABELS[0][1];
  for (const [threshold, text] of TURBIDITY_LABELS) {
    if (value >= threshold) label = text;
  }
  return label;
}

// Silt — a small particle field parallel to scene/particles.js's river field,
// but purpose-built (no `bounds`/caustics texture on this page). Origins live
// in a unit cube ([-0.5, 0.5]^3), scaled by uVolumeMin/uVolumeSize each frame,
// so updateParticleVolume() can resize for a new species via four uniforms
// rather than rebuilding the instance buffers.
const PARTICLE_COUNT = 240;
const PARTICLE_COLOR = new THREE.Color(0x9c8a63);
// Full-turbidity ceiling — silt should read as texture, not individual specks.
const PARTICLE_MAX_OPACITY = 0.5;
// Field reach and mote size as fractions of referenceLength (applyTurbidity),
// so scale matches whichever fish is on screen.
const PARTICLE_VOLUME_SPAN_FRAC = 2.6;
const PARTICLE_VOLUME_HEIGHT_FRAC = 1.6;
const PARTICLE_MIN_SIZE_FRAC = 0.012;
const PARTICLE_MAX_SIZE_FRAC = 0.03;

let inspectParticles = null;

const particleVertexShader = () => /* glsl */ `
  attribute vec3 aOrigin;
  attribute float aSizeSeed;
  attribute float aPhase;
  uniform float uTime;
  uniform vec3 uVolumeMin;
  uniform vec3 uVolumeSize;
  uniform float uMinSize;
  uniform float uMaxSize;
  varying vec2 vQuad;
  varying vec3 vWorldPos;

  void main() {
    vec3 drifted = uVolumeMin + (aOrigin + 0.5) * uVolumeSize;
    // Gentle drift/churn in absolute world units (not scaled by volume) —
    // see scene/particles.js's DRIFT_X/BOB_AMPLITUDE for the fuller version.
    drifted.x += uTime * 6.0;
    drifted.y += sin(uTime * 0.3 + aPhase) * 2.5;
    drifted = mod(drifted - uVolumeMin, uVolumeSize) + uVolumeMin;

    // Biased toward small motes, same reasoning as scene/particles.js.
    float size = mix(uMinSize, uMaxSize, aSizeSeed * aSizeSeed);

    // Billboard toward the camera — corners offset along the view matrix's
    // own right/up axes, same technique scene/particles.js uses.
    vec3 right = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
    vec3 up = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
    vec3 worldPos = drifted + (right * position.x + up * position.y) * size;

    vWorldPos = worldPos;
    vQuad = position.xy;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(worldPos, 1.0);
  }
`;

const particleFragmentShader = /* glsl */ `
  ${FOG_GLSL}
  uniform vec3 uColor;
  uniform float uOpacity;
  varying vec2 vQuad;
  varying vec3 vWorldPos;

  void main() {
    // Soft round mote — a hard-edged quad reads as a square this close to
    // the camera.
    float r = length(vQuad) * 2.0;
    float alpha = (1.0 - smoothstep(0.35, 1.0, r)) * uOpacity;
    alpha *= 1.0 - fogAmount(vWorldPos);
    if (alpha < 0.004) discard;
    gl_FragColor = vec4(uColor, alpha);
  }
`;

// Built once at boot; resized per species by updateParticleVolume, never rebuilt.
function buildInspectParticles() {
  const geometry = new THREE.InstancedBufferGeometry();
  const quad = new THREE.PlaneGeometry(1, 1);
  geometry.index = quad.index;
  geometry.attributes.position = quad.attributes.position;

  const origins = new Float32Array(PARTICLE_COUNT * 3);
  const sizeSeeds = new Float32Array(PARTICLE_COUNT);
  const phases = new Float32Array(PARTICLE_COUNT);
  for (let i = 0; i < PARTICLE_COUNT; i++) {
    origins[i * 3] = Math.random() - 0.5;
    origins[i * 3 + 1] = Math.random() - 0.5;
    origins[i * 3 + 2] = Math.random() - 0.5;
    sizeSeeds[i] = Math.random();
    phases[i] = Math.random() * Math.PI * 2;
  }
  geometry.setAttribute("aOrigin", new THREE.InstancedBufferAttribute(origins, 3));
  geometry.setAttribute("aSizeSeed", new THREE.InstancedBufferAttribute(sizeSeeds, 1));
  geometry.setAttribute("aPhase", new THREE.InstancedBufferAttribute(phases, 1));
  geometry.instanceCount = PARTICLE_COUNT;

  const material = new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uVolumeMin: { value: new THREE.Vector3() },
      uVolumeSize: { value: new THREE.Vector3(1, 1, 1) },
      uMinSize: { value: 1 },
      uMaxSize: { value: 2 },
      uColor: { value: PARTICLE_COLOR },
      uOpacity: { value: 0 },
      uFogColor: { value: inspectFogColor },
      uFogDensity: { value: 0 },
      uFogDepthRate: { value: 0 },
    },
    vertexShader: particleVertexShader(),
    fragmentShader: particleFragmentShader,
    transparent: true,
    depthWrite: false,
  });

  inspectParticles = new THREE.Mesh(geometry, material);
  inspectParticles.name = "inspect-particles";
  inspectParticles.frustumCulled = false;
  scene.add(inspectParticles);
}

// Resizes the field around the current fish via uniforms, not a rebuild.
function updateParticleVolume(referenceLength) {
  if (!inspectParticles) return;
  const u = inspectParticles.material.uniforms;
  const spanXZ = referenceLength * PARTICLE_VOLUME_SPAN_FRAC;
  const spanY = referenceLength * PARTICLE_VOLUME_HEIGHT_FRAC;
  u.uVolumeMin.value.set(-spanXZ / 2, -spanY / 2, -spanXZ / 2);
  u.uVolumeSize.value.set(spanXZ, spanY, spanXZ);
  u.uMinSize.value = referenceLength * PARTICLE_MIN_SIZE_FRAC;
  u.uMaxSize.value = referenceLength * PARTICLE_MAX_SIZE_FRAC;
}

function applyTurbidity() {
  const value = Number(turbiditySlider.value);
  const t = value / 100;
  turbiditySlider.style.setProperty("--fill", `${value}%`);
  turbidityValueEl.textContent = turbidityLabel(value);

  scene.background.copy(BACKDROP_THREE).lerp(TURBID_COLOR, t);
  inspectFogColor.copy(BACKDROP_THREE).lerp(TURBID_COLOR, t);

  const referenceLength = lastBodyLength || 1;
  const density = (t * TURBIDITY_DENSITY_K) / referenceLength;

  if (inspectParticles) {
    updateParticleVolume(referenceLength);
    inspectParticles.material.uniforms.uOpacity.value = t * PARTICLE_MAX_OPACITY;
    inspectParticles.material.uniforms.uFogDensity.value = density;
  }

  if (!fishRenderer) return;
  fishRenderer.mesh.traverse((child) => {
    const uniforms = child.material?.uniforms;
    if (!uniforms?.uFogDensity) return;
    uniforms.uFogDensity.value = density;
    // Shared across every species' material (see FOG_COLOR's own note in
    // scene/fog.js) — mutating it via any one of them reaches all of them.
    uniforms.uFogColor.value.copy(inspectFogColor);
  });
}

turbiditySlider.addEventListener("input", applyTurbidity);

// Construction — loops the fish through five build stages (Skeleton →
// Wireframe → Polygons → Texture → Final) by crossfading three objects: the
// armature, a dedicated wireframe mesh, and fishRenderer's own instanced mesh
// (see applyConstructionWeights for how one weight set drives all three).
const CONSTRUCTION_STAGE_NAMES = ["Skeleton", "Wireframe", "Polygons", "Texture", "Final"];
const CONSTRUCTION_STAGE_WEIGHTS = [
  { wArmature: 1, wWireframe: 0, wReal: 0, textureMix: 0, highlightsMix: 0 }, // Skeleton
  { wArmature: 0, wWireframe: 1, wReal: 0, textureMix: 0, highlightsMix: 0 }, // Wireframe
  { wArmature: 0, wWireframe: 0, wReal: 1, textureMix: 0, highlightsMix: 0 }, // Polygons
  { wArmature: 0, wWireframe: 0, wReal: 1, textureMix: 1, highlightsMix: 0 }, // Texture
  { wArmature: 0, wWireframe: 0, wReal: 1, textureMix: 1, highlightsMix: 1 }, // Final
];
// Transition doubled from an original 650ms, which (lerped linearly) read as
// a pop rather than a fade — see easeConstructionP. Full loop ≈ 10.75s.
const CONSTRUCTION_HOLD_MS = 850;
const CONSTRUCTION_TRANSITION_MS = 1300;
// Fade back to Final when Construction is turned off mid-loop.
const CONSTRUCTION_EXIT_MS = 450;

// Smoothstep, not linear — linear opacity looks front-loaded (each layer "popping in").
function easeConstructionP(p) {
  return p * p * (3 - 2 * p);
}

function lerpConstructionWeights(a, b, p) {
  const eased = easeConstructionP(p);
  return {
    wArmature: a.wArmature + (b.wArmature - a.wArmature) * eased,
    wWireframe: a.wWireframe + (b.wWireframe - a.wWireframe) * eased,
    wReal: a.wReal + (b.wReal - a.wReal) * eased,
    textureMix: a.textureMix + (b.textureMix - a.textureMix) * eased,
    highlightsMix: a.highlightsMix + (b.highlightsMix - a.highlightsMix) * eased,
  };
}

let constructionActive = false;
let constructionExiting = false;
let constructionExitFrom = CONSTRUCTION_STAGE_WEIGHTS[4];
let constructionExitElapsed = 0;
let constructionElapsed = 0;
// The weights applyConstructionWeights last actually set (needed to fade FROM
// when Construction is turned off mid-loop).
let lastConstructionWeights = CONSTRUCTION_STAGE_WEIGHTS[4];
let constructionArmature = null;
let constructionArmatureEdges = null;
let wireframeMesh = null;
// Species the armature/wireframe are currently built for; rebuilt on mismatch.
let constructionAssetSpecies = null;

const armVecA = new THREE.Vector3();
const armVecB = new THREE.Vector3();
const armMatrix = new THREE.Matrix4();
const wireframeMatrix = new THREE.Matrix4();

// A function for the same reason fishMesh.js's own shaders are — see there.
const wireframeVertexShader = () => /* glsl */ `
  attribute float aVertexIndex;
  uniform sampler2D uVat;
  uniform float uVatFrameCount;
  uniform float uVatVertexCount;
  uniform float uCyclePos;
  uniform float uPhase;
  varying vec3 vNormal;
  varying float vReveal;

  vec3 sampleVatOffset(float frame) {
    vec2 uv = vec2(
      (aVertexIndex + 0.5) / uVatVertexCount,
      (mod(frame, uVatFrameCount) + 0.5) / uVatFrameCount
    );
    return texture2D(uVat, uv).xyz;
  }

  // Stable per-vertex pseudo-random value, off the REST position (not
  // animated, or the reveal pattern itself would swim).
  float hash(vec3 p) {
    return fract(sin(dot(p, vec3(12.9898, 78.233, 45.164))) * 43758.5453);
  }

  void main() {
    vReveal = hash(position);
    float cycles = uCyclePos + uPhase * ${PHASE_TO_CYCLE};
    float frameF = fract(cycles) * uVatFrameCount;
    float frame0 = floor(frameF);
    vec3 swim = mix(
      sampleVatOffset(frame0),
      sampleVatOffset(frame0 + 1.0),
      frameF - frame0
    );
    vec3 bent = position + swim;
    vNormal = normalize((modelMatrix * vec4(normal, 0.0)).xyz);
    gl_Position = projectionMatrix * viewMatrix * modelMatrix * vec4(bent, 1.0);
  }
`;

const wireframeFragmentShader = /* glsl */ `
  uniform vec3 uLightDir;
  // Fraction of edges revealed (0-1), NOT a plain opacity — alpha blending
  // compounds across overlapping edges (measured: ~4% opacity already reads
  // as ~85%+ coverage), so each edge is fully drawn or not, decided by its
  // own vReveal against this fraction with a narrow soft band at the threshold.
  uniform float uRevealFraction;
  varying vec3 vNormal;
  varying float vReveal;

  void main() {
    float band = 0.06;
    float alpha = 1.0 - smoothstep(uRevealFraction - band, uRevealFraction + band, vReveal);
    if (alpha < 0.02) discard;
    vec3 normal = normalize(vNormal);
    float ndl = dot(normal, normalize(uLightDir)) * 0.5 + 0.5;
    float lit = mix(0.35, 0.85, ndl * ndl * (3.0 - 2.0 * ndl));
    gl_FragColor = vec4(vec3(lit), alpha);
  }
`;

function disposeConstructionAssets() {
  if (constructionArmature) {
    scene.remove(constructionArmature);
    constructionArmature.geometry.dispose();
    constructionArmature.material.dispose();
    constructionArmature = null;
    constructionArmatureEdges = null;
  }
  if (wireframeMesh) {
    scene.remove(wireframeMesh);
    // Not the geometry — that's the shared asset loadFishAssets() owns.
    wireframeMesh.material.dispose();
    wireframeMesh = null;
  }
  constructionAssetSpecies = null;
}

// Builds the armature + wireframe mesh for `species`, on demand (when
// Construction is switched on, or on a species change while it's running)
// rather than kept alive the whole time Construction is off.
function ensureConstructionAssets(species) {
  if (!assetsByUrlRef || constructionAssetSpecies === species) return;
  disposeConstructionAssets();
  const assets = assetsByUrlRef.get(SPECIES_MODEL_URL[species]);

  const { parentIndex, count } = assets.vat.bones;
  const edges = [];
  for (let b = 0; b < count; b++) {
    if (parentIndex[b] >= 0) edges.push([parentIndex[b], b]);
  }
  const armGeometry = new THREE.BufferGeometry();
  armGeometry.setAttribute(
    "position",
    new THREE.BufferAttribute(new Float32Array(edges.length * 2 * 3), 3),
  );
  // Matches style.css's --accent (repeated here — no way to read a CSS var from JS).
  const armMaterial = new THREE.LineBasicMaterial({
    color: 0xc1272d,
    transparent: true,
    opacity: 0,
    depthTest: true,
  });
  constructionArmature = new THREE.LineSegments(armGeometry, armMaterial);
  constructionArmature.name = "construction-armature";
  constructionArmature.frustumCulled = false;
  constructionArmature.visible = false;
  scene.add(constructionArmature);
  constructionArmatureEdges = edges;

  const wireMaterial = new THREE.ShaderMaterial({
    uniforms: {
      uVat: { value: assets.vat.texture },
      uVatFrameCount: { value: assets.vat.frameCount },
      uVatVertexCount: { value: assets.vat.vertexCount },
      uCyclePos: { value: 0 },
      uPhase: { value: 0 },
      uLightDir: { value: new THREE.Vector3(0.4, 1, 0.25).normalize() },
      uRevealFraction: { value: 0 },
    },
    vertexShader: wireframeVertexShader(),
    fragmentShader: wireframeFragmentShader,
    wireframe: true,
    transparent: true,
    depthWrite: false,
    depthTest: true,
  });
  wireframeMesh = new THREE.Mesh(assets.geometry, wireMaterial);
  wireframeMesh.name = "construction-wireframe";
  wireframeMesh.matrixAutoUpdate = false;
  wireframeMesh.frustumCulled = false;
  wireframeMesh.visible = false;
  scene.add(wireframeMesh);

  constructionAssetSpecies = species;
}

// Re-samples the armature/wireframe off the current swim pose — rides
// fishRenderer's own computed transform rather than re-deriving the
// tailbeat/roll physics (same approach as updateGhostOverlay in fishMesh.js).
function updateConstructionPose() {
  if (!fishAssets || !fishRenderer) return;
  const instanceMesh = fishRenderer.meshForSpecies(currentSpecies);
  if (!instanceMesh) return;

  if (constructionArmature && constructionArmatureEdges) {
    instanceMesh.getMatrixAt(0, armMatrix);
    const positionAttr = constructionArmature.geometry.attributes.position;
    let o = 0;
    for (const [i, j] of constructionArmatureEdges) {
      animatedBonePosition(
        fishAssets, i, previewFish.swimCyclePos, previewFish.wobblePhase, armVecA,
      );
      armVecA.applyMatrix4(armMatrix);
      animatedBonePosition(
        fishAssets, j, previewFish.swimCyclePos, previewFish.wobblePhase, armVecB,
      );
      armVecB.applyMatrix4(armMatrix);
      positionAttr.setXYZ(o++, armVecA.x, armVecA.y, armVecA.z);
      positionAttr.setXYZ(o++, armVecB.x, armVecB.y, armVecB.z);
    }
    positionAttr.needsUpdate = true;
  }

  if (wireframeMesh) {
    instanceMesh.getMatrixAt(0, wireframeMatrix);
    wireframeMesh.matrix.copy(wireframeMatrix);
    wireframeMesh.matrixWorldNeedsUpdate = true;
    wireframeMesh.material.uniforms.uCyclePos.value = previewFish.swimCyclePos;
    wireframeMesh.material.uniforms.uPhase.value = previewFish.wobblePhase;
  }
}

// Applies one weight set to all three participants; fishRenderer's mesh is
// transparent only mid-crossfade, opaque/depth-writing at the ends.
function applyConstructionWeights(w) {
  // Recorded so turning Construction off mid-loop has a real starting point to fade from.
  lastConstructionWeights = w;
  if (constructionArmature) {
    constructionArmature.visible = w.wArmature > 0.001;
    constructionArmature.material.opacity = w.wArmature;
  }
  if (wireframeMesh) {
    // Drives uRevealFraction (see the note on that uniform above). Squashed
    // further by this power curve — a connected mesh fills in faster than
    // the raw fraction suggests, since any edge with either endpoint below
    // threshold shows at least partially.
    const reveal = Math.pow(w.wWireframe, 1.8);
    wireframeMesh.visible = reveal > 0.001;
    wireframeMesh.material.uniforms.uRevealFraction.value = reveal;
  }
  const mesh = fishRenderer?.meshForSpecies(currentSpecies);
  const material = mesh?.material;
  if (!material) return;
  material.uniforms.uTextureMix.value = w.textureMix;
  material.uniforms.uHighlightsMix.value = w.highlightsMix;
  if (w.wReal >= 0.999) {
    material.transparent = false;
    material.depthWrite = true;
    material.opacity = 1;
  } else {
    material.transparent = true;
    material.depthWrite = false;
    material.opacity = w.wReal;
  }
  mesh.visible = w.wReal > 0.001;
}

// Advances the loop by dtMs — a pure function of accumulated elapsed time, so
// it can't drift out of sync the way a hand-rolled phase/countdown could.
function tickConstruction(dtMs) {
  constructionElapsed += dtMs;
  const slotMs = CONSTRUCTION_HOLD_MS + CONSTRUCTION_TRANSITION_MS;
  const cycleMs = slotMs * CONSTRUCTION_STAGE_WEIGHTS.length;
  const t = constructionElapsed % cycleMs;
  const stage = Math.floor(t / slotMs);
  const withinSlot = t - stage * slotMs;

  if (withinSlot < CONSTRUCTION_HOLD_MS) {
    applyConstructionWeights(CONSTRUCTION_STAGE_WEIGHTS[stage]);
    constructionStageEl.textContent = CONSTRUCTION_STAGE_NAMES[stage];
  } else {
    const next = (stage + 1) % CONSTRUCTION_STAGE_WEIGHTS.length;
    const p = (withinSlot - CONSTRUCTION_HOLD_MS) / CONSTRUCTION_TRANSITION_MS;
    applyConstructionWeights(
      lerpConstructionWeights(CONSTRUCTION_STAGE_WEIGHTS[stage], CONSTRUCTION_STAGE_WEIGHTS[next], p),
    );
    // Name by whichever stage the fade is more than halfway toward.
    constructionStageEl.textContent = CONSTRUCTION_STAGE_NAMES[p < 0.5 ? stage : next];
  }
  updateConstructionPose();
}

constructionToggle.addEventListener("click", () => {
  const next = !isPressed(constructionToggle);
  setPressed(constructionToggle, next);

  if (next) {
    constructionActive = true;
    constructionExiting = false;
    constructionElapsed = 0; // always starts the loop fresh, at Skeleton
    ensureConstructionAssets(currentSpecies);
  } else {
    constructionActive = false;
    constructionExiting = true;
    constructionExitFrom = lastConstructionWeights;
    constructionExitElapsed = 0;
  }
});

// Called every frame Construction is either running or still fading out.
function tickConstructionLifecycle(dtMs) {
  if (constructionActive) {
    tickConstruction(dtMs);
    return;
  }
  if (!constructionExiting) return;

  constructionExitElapsed += dtMs;
  const p = Math.min(1, constructionExitElapsed / CONSTRUCTION_EXIT_MS);
  applyConstructionWeights(
    lerpConstructionWeights(constructionExitFrom, CONSTRUCTION_STAGE_WEIGHTS[4], p),
  );
  updateConstructionPose();
  constructionStageEl.textContent = "";
  if (p >= 1) {
    constructionExiting = false;
    disposeConstructionAssets();
  }
}

// Anatomy overlay — leader lines from the projected screen position of the
// resolved anchors (scene/fishAnatomy.js). Held still against the tailbeat by
// fixed gutters, y-damping, column hysteresis, and a two-pass vertical settle.

// Gutter distance is deliberately modest — pushing columns further out makes
// leaders long and flat, which lies across the body worse than a close label would.
const LABEL_GUTTER_FRACTION = 0.22;
const LABEL_GUTTER_MAX = 230;
// Wider than needed for text alone — spreads the column enough for steep leader angles.
const LABEL_MIN_GAP = 26;

// Fan factor: 0 = level with anchor (horizontal leaders), 1 = evenly spaced (reads as a list).
const LABEL_VERTICAL_SPREAD = 0.62;
// The band the fan is distributed across, as a fraction of viewport height.
const LABEL_BAND_TOP = 0.1;
const LABEL_BAND_BOTTOM = 0.9;
// Room for the longest label text ("Second Dorsal Fin") between the column and the edge.
const LABEL_EDGE_MARGIN = 130;
// Fraction of remaining distance closed per frame — swallows the tailbeat without visibly crawling.
const LABEL_DAMPING = 0.18;

// Leader endpoint = ANIMATED vertex (must be exact); layout input = REST
// vertex under the same transform (tracks camera/body, not the tailbeat).
// Distance past midline before a label changes sides — prevents tailbeat-driven flicker.
const COLUMN_HYSTERESIS_PX = 40;

const tmpVec = new THREE.Vector3();
const tmpRest = new THREE.Vector3();
const tmpNormal = new THREE.Vector3();
const tmpMatrix = new THREE.Matrix4();
const viewDir = new THREE.Vector3();

// Per-part render state: SVG nodes (built once, updated in place), last y, and column.
const labelState = new Map();

// True while dragging the camera — damping is skipped, or it reads as unresponsive.
let orbiting = false;
controls.addEventListener("start", () => { orbiting = true; });
controls.addEventListener("end", () => { orbiting = false; });

function setAttrIfMoved(node, name, value) {
  // Sub-pixel writes are invisible and still dirty the SVG's layout, and
  // there are ~33 of them a frame.
  const next = value.toFixed(1);
  if (node.getAttribute(name) !== next) node.setAttribute(name, next);
}

// The nodes for one part, created on first sight and reused thereafter.
function nodesFor(part) {
  let state = labelState.get(part.id);
  if (state) return state;

  const svgNs = "http://www.w3.org/2000/svg";
  const leader = document.createElementNS(svgNs, "line");
  leader.setAttribute("class", "anatomy-leader");
  const tick = document.createElementNS(svgNs, "circle");
  tick.setAttribute("class", "anatomy-tick");
  tick.setAttribute("r", 2.5);
  const text = document.createElementNS(svgNs, "text");
  text.setAttribute("class", "anatomy-label");
  const title = document.createElementNS(svgNs, "title");
  text.appendChild(title);

  state = {
    leader,
    tick,
    text,
    title,
    labelY: null,
    onLeft: null,
    // Layout anchor position (rest-pose screen coords) the fan positions run against.
    layoutX: null,
    layoutY: null,
  };
  labelState.set(part.id, state);
  overlaySvg.append(leader, tick, text);
  return state;
}

function hideAllLabels() {
  for (const state of labelState.values()) {
    state.leader.style.display = "none";
    state.tick.style.display = "none";
    state.text.style.display = "none";
  }
}

// Species change — the new species' parts are a different set entirely.
function resetLabelLayout() {
  overlaySvg.replaceChildren();
  labelState.clear();
}

// Drops remembered positions so the next frame snaps instead of easing
// (needed after an instant camera jump like Reset view).
function snapLabelLayout() {
  for (const state of labelState.values()) {
    state.labelY = null;
    state.layoutX = null;
    state.layoutY = null;
  }
}

function renderAnatomyOverlay() {
  if (!isPressed(labelsToggle) || !fishRenderer || anatomyParts.length === 0) {
    hideAllLabels();
    return;
  }

  const instanceMesh = fishRenderer.meshForSpecies(currentSpecies);
  if (!instanceMesh) {
    hideAllLabels();
    return;
  }
  const width = window.innerWidth;
  const height = window.innerHeight;
  // Computed here because shiftPx needs it first; reused below for the bandBottom/ceiling clamps.
  const barRect = inspectBar.getBoundingClientRect();
  // #fish-canvas is shifted up by this amount (inspect.css); the un-shifted
  // overlay subtracts it from every fish-tracking coordinate, but not label
  // text positions (already bounded by the fan below).
  const shiftPx = barRect.height / 2;
  instanceMesh.getMatrixAt(0, tmpMatrix);

  const visible = [];
  for (const part of anatomyParts) {
    animatedLocalPosition(
      fishAssets,
      part,
      previewFish.swimCyclePos,
      previewFish.wobblePhase,
      tmpVec,
    );
    tmpVec.applyMatrix4(tmpMatrix);

    // Facing test only for paired lateral features (|part.side| > 0.5) — a
    // midline fin's face normal points sideways even on the midline, so this
    // test would make it blink out for half of every rotation.
    const screen = tmpVec.clone().project(camera);
    if (Math.abs(part.side) > 0.5) {
      tmpNormal.copy(part.restNormal).transformDirection(tmpMatrix);
      viewDir.copy(tmpVec).sub(camera.position);
      if (tmpNormal.dot(viewDir) > 0) continue;
    }
    if (screen.z > 1) continue; // behind the camera

    // Same vertex in its REST pose — what the layout runs against.
    const restScreen = tmpRest
      .copy(part.restPosition)
      .applyMatrix4(tmpMatrix)
      .project(camera);

    visible.push({
      part,
      // Leader endpoint: the real, animated vertex (shifted by shiftPx).
      x: (screen.x * 0.5 + 0.5) * width,
      y: (-screen.y * 0.5 + 0.5) * height - shiftPx,
      // Layout input: the same feature at rest, not mid-stroke (shifted the same way).
      layoutX: (restScreen.x * 0.5 + 0.5) * width,
      layoutY: (-restScreen.y * 0.5 + 0.5) * height - shiftPx,
    });
  }

  // The panel used to be avoided with a per-anchor test; that broke once the
  // panel grew to nearly full height (it captured the whole right half). Now
  // the right column's x is just clamped clear of the panel once, below.
  const panelRect = inspectPanel.getBoundingClientRect();
  // barRect (measured above) clips the bottom the same way panelRect clips
  // the right — see bandBottom/ceiling below.

  // The two columns, fixed for the frame and derived from the viewport, not any anchor.
  const gutter = Math.min(width * LABEL_GUTTER_FRACTION, LABEL_GUTTER_MAX);
  const leftX = Math.max(width / 2 - gutter, LABEL_EDGE_MARGIN);
  const rightX = Math.min(
    width / 2 + gutter,
    width - LABEL_EDGE_MARGIN,
    // Never under the panel — rightX is where text STARTS, so it needs the
    // full LABEL_EDGE_MARGIN, not a hairline gap (a smaller gap once let
    // "Second Dorsal Fin" render on top of the panel).
    panelRect.left - LABEL_EDGE_MARGIN,
  );

  // Falls back to one column below 120px between the two, or (second clause)
  // when the panel has pulled rightX in far enough to sit too close to center
  // even though it technically still fits two columns.
  const singleColumn = rightX - leftX < 120 || width - leftX - rightX > 80;

  // Column assignment, with hysteresis against whichever side each part was
  // on last frame. A part with no history takes the plain midline test.
  for (const v of visible) {
    const previous = labelState.get(v.part.id);
    const wasLeft = previous?.onLeft;
    if (singleColumn) {
      v.onLeft = true;
    } else if (wasLeft === true) {
      v.onLeft = v.layoutX < width / 2 + COLUMN_HYSTERESIS_PX;
    } else if (wasLeft === false) {
      v.onLeft = v.layoutX < width / 2 - COLUMN_HYSTERESIS_PX;
    } else {
      v.onLeft = v.layoutX < width / 2;
    }
  }

  // Sorted on the smoothed height, so the running order of a column does not
  // reshuffle every time two features cross during a stroke.
  const left = visible.filter((v) => v.onLeft).sort((a, b) => a.layoutY - b.layoutY);
  const right = visible.filter((v) => !v.onLeft).sort((a, b) => a.layoutY - b.layoutY);

  const bandTop = height * LABEL_BAND_TOP;
  // Never under the bar (same reasoning as rightX); floored so a very short
  // viewport can't invert the band.
  const bandBottom = Math.max(
    bandTop + 60,
    Math.min(height * LABEL_BAND_BOTTOM, barRect.top - 12),
  );

  for (const column of [left, right]) {
    if (column.length === 0) continue;

    // Fan: pulls each label from its anchor height toward an even share of
    // the band, keeping higher features above lower ones so leaders never cross.
    const span = bandBottom - bandTop;
    column.forEach((v, i) => {
      const slot =
        column.length === 1
          ? (bandTop + bandBottom) / 2
          : bandTop + (span * i) / (column.length - 1);
      v.labelY = v.layoutY + (slot - v.layoutY) * LABEL_VERTICAL_SPREAD;
    });

    // Down-pass: separates anything still closer than the minimum gap.
    let previousY = -Infinity;
    for (const v of column) {
      v.labelY = Math.max(v.labelY, previousY + LABEL_MIN_GAP);
      previousY = v.labelY;
    }
    // Up-pass: undoes the down-pass's one-way drift, which would otherwise
    // walk a crowded column off the bottom.
    let ceiling = Math.min(height - LABEL_EDGE_MARGIN / 4, barRect.top - 12);
    for (let i = column.length - 1; i >= 0; i--) {
      column[i].labelY = Math.min(column[i].labelY, ceiling);
      ceiling = column[i].labelY - LABEL_MIN_GAP;
    }
  }

  const drawn = new Set();
  for (const v of visible) {
    const state = nodesFor(v.part);
    drawn.add(v.part.id);

    const labelX = v.onLeft ? leftX : rightX;

    // Damped unless the label just appeared, changed sides, or the camera is being dragged.
    let labelY = v.labelY;
    if (state.labelY !== null && !orbiting && state.onLeft === v.onLeft) {
      labelY = state.labelY + (labelY - state.labelY) * LABEL_DAMPING;
    }
    state.labelY = labelY;
    state.onLeft = v.onLeft;
    state.layoutX = v.layoutX;
    state.layoutY = v.layoutY;

    state.leader.style.display = "";
    state.tick.style.display = "";
    state.text.style.display = "";

    setAttrIfMoved(state.leader, "x1", v.x);
    setAttrIfMoved(state.leader, "y1", v.y);
    setAttrIfMoved(state.leader, "x2", labelX);
    setAttrIfMoved(state.leader, "y2", labelY);

    setAttrIfMoved(state.tick, "cx", v.x);
    setAttrIfMoved(state.tick, "cy", v.y);

    setAttrIfMoved(state.text, "x", labelX);
    setAttrIfMoved(state.text, "y", labelY);
    const anchor = v.onLeft ? "end" : "start";
    if (state.text.getAttribute("text-anchor") !== anchor) {
      state.text.setAttribute("text-anchor", anchor);
    }
    if (state.text.firstChild !== state.title || state.label !== v.part.label) {
      state.label = v.part.label;
      state.text.replaceChildren(state.title, document.createTextNode(v.part.label));
      state.title.textContent = v.part.note;
    }
  }

  // Culled this frame — hidden, not removed; remembered position dropped so
  // they ease in fresh if they return.
  for (const [id, state] of labelState) {
    if (drawn.has(id)) continue;
    state.leader.style.display = "none";
    state.tick.style.display = "none";
    state.text.style.display = "none";
    state.labelY = null;
    state.layoutX = null;
    state.layoutY = null;
  }
}

// Boot the panel — placed here (not beside its functions) because setSpecies()
// touches labelState, declared just above; earlier placement hit the TDZ.
initInsightToast();
buildInspectParticles();
buildSpeciesList();
buildLengthScale();
setSpecies(currentSpecies);

// ---------------------------------------------------------------------
// Animation loop
// ---------------------------------------------------------------------
let simTime = 0;
let lastFrameTime = null;

// One frame at 60fps, the unit fishMesh.js's update() expects its dt in.
const REFERENCE_FRAME_MS = 1000 / 60;

function loop(t) {
  const dt = lastFrameTime === null ? 0 : t - lastFrameTime;
  lastFrameTime = t;
  simTime += dt;
  if (inspectParticles) inspectParticles.material.uniforms.uTime.value = simTime * 0.001;

  controls.update();

  if (fishRenderer && previewFish) {
    // dt in 60fps-frame units (matches main.js) — fishMesh.js accumulates the
    // tailbeat per call, so an unconverted dt would make stroke rate
    // refresh-rate dependent. Clamped against a backgrounded tab's huge delta.
    fishRenderer.update(
      [previewFish],
      simTime,
      isPressed(playingToggle),
      Math.min(4, dt / REFERENCE_FRAME_MS),
    );
    renderAnatomyOverlay();
    tickConstructionLifecycle(dt);
  }

  renderer.render(scene, camera);
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);

loadFishAssets()
  .then((assetsByUrl) => {
    assetsByUrlRef = assetsByUrl;
    fishAssets = assetsByUrl.get(SPECIES_MODEL_URL[currentSpecies]);
    // Only one instance is ever drawn here, so capacity 1 covers it.
    fishRenderer = createFishInstancedMesh(assetsByUrl, 1);
    scene.add(fishRenderer.mesh);

    // River's uCausticsStrength assumes depth/fog dimming this page doesn't
    // have, so it'd read as flat green blotches — overridden directly rather
    // than adding a new buildSpeciesRenderer param.
    fishRenderer.mesh.traverse((child) => {
      if (child.material?.uniforms?.uCausticsStrength) {
        child.material.uniforms.uCausticsStrength.value = 3;
      }
    });

    anatomyParts = resolveAnatomy(currentSpecies, assetsByUrl);
    applyTurbidity();

    fishLoadingEl.classList.add("hidden");
    fishLoadingEl.addEventListener(
      "transitionend",
      () => fishLoadingEl.remove(),
      { once: true },
    );
  })
  .catch((err) => console.error("Failed to load fish model:", err));
