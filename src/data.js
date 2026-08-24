// data.js
import { parseAdultDailyCsv } from "./dart/parseAdultDaily.js";

// Real Lower Granite Dam (LWG) daily adult passage counts, read at module load
// from a snapshot vendored into this repo (public/lwg-adult-daily-2015.csv).
//
// Five species drive the simulation — Chinook, Jack Chinook, Steelhead, Shad
// and Pacific Lamprey — and `count` (the number behind the whole population,
// spawn rate and swim speed; see main.js) is their sum per day. Those are the
// five the renderer has meshes and tints for.
//
// The rest of what DART publishes per day is parsed too, and reported in the
// HUD without being simulated: wild steelhead (a subset of the steelhead
// count), sockeye, coho, jack coho, the water temperature at the project, and
// which Chinook run the date falls in. None of it reaches the flock — see the
// note on `count` in parseAdultDailyCsv (src/dart/).
//
// The parser itself lives in src/dart/parseAdultDaily.js rather than here: it
// has no fetch and no browser globals, so scripts/fetch-dart.mjs imports the
// same function under Node to build the multi-year history file below rather
// than re-implementing the column-mapping logic a second time.
//
// DART_YEAR = 2015: picked over more recent years (2023 in particular) after
// spot-checking a few — 2015 has substantial counts across all five species
// all year, where some other years have long stretches of near-zero Chinook.
// The dam's counting season runs roughly March-December, not the full
// calendar year, so runData is shorter than 365 entries; nothing here
// assumes otherwise (see dayOfYear() in scene/season.js, which derives the
// day-of-year straight from each entry's own date string).
//
// WHY A SNAPSHOT RATHER THAN A LIVE FETCH.
//
// DART_YEAR is a fixed historical year, so the live query returns the same 302
// rows on every load, forever — there is nothing to be fresh about. What
// fetching it at boot did buy was a hard dependency on a third-party host
// being up and fast, on the critical path of a module-level `await`: nothing
// in the app can evaluate until it settles, and it had no timeout, so a
// hanging connection left a blank canvas indefinitely rather than failing.
//
// The snapshot is served from our own origin instead, and the live path below
// is opt-in (see liveRefreshRequested). It stays in the file because the year
// will not be hardcoded forever — the moment DART_YEAR becomes a control, the
// live query is what backs it.
const DART_YEAR = 2015;

// Retrieved 2026-08-24 from the DART URL below, byte-for-byte as served.
//
// Deliberately unmodified — no header comment marking the retrieval, which is
// what a vendored data file usually gets. Two reasons: parseDartCsv reads
// lines[0] as the column header, so a leading comment would have to be parsed
// around; and DART's export already carries its own provenance in its footer
// (generation timestamp, the USACE disclaimer, and the full DART data
// citation), which is better evidence of where this came from than a line we
// wrote ourselves. The footnote lines are skipped by the project-name prefix
// test in parseDartCsv, same as they are in a live response.
const SNAPSHOT_URL = "/lwg-adult-daily-2015.csv";

const COLUMBIA_BASIN_RESEARCH_DART_URL =
  `https://www.cbr.washington.edu/dart/cs/php/rpt/adult_daily.php?sc=1&outputFormat=csv&year=${DART_YEAR}&proj=LWG&span=no&startdate=1%2F1&enddate=12%2F31&run=&syear=2026&eyear=2026`;

// Same-origin static asset, so this is generous rather than tight — it exists
// to bound a wedged connection, not to police a slow one.
const SNAPSHOT_TIMEOUT_MS = 15000;
// Third-party host on the boot path, so this one is the real guard.
const DART_TIMEOUT_MS = 5000;

// fetch() has no timeout of its own — a connection that opens and then stalls
// hangs the promise forever, which is exactly the failure this module used to
// sit on. AbortController is the only way to bound it. Returns raw text
// rather than parsing — every caller below (CSV or JSON) does that itself, so
// this stays the one place the timeout/error handling lives.
async function fetchText(url, timeoutMs, label) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`${label} request failed: HTTP ${response.status}`);
    }
    return await response.text();
  } catch (err) {
    // An abort surfaces as a bare "AbortError"/"The operation was aborted",
    // which says nothing about what was being fetched or for how long.
    if (err.name === "AbortError") {
      throw new Error(`${label} request timed out after ${timeoutMs}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// Opt-in live refresh: `?live` or `?live=1` on the URL. Off by default, and
// the default is the honest one — see the note on SNAPSHOT_URL above. Guarded
// for a non-browser context (a test harness importing this module) rather than
// assuming `location` exists.
function liveRefreshRequested() {
  if (typeof location === "undefined") return false;
  return new URLSearchParams(location.search).has("live");
}

// Which of the two the data below actually came from. Exported so the HUD can
// be honest about its own provenance instead of asserting a source it has no
// way to check — see the masthead in index.html.
export let runDataSource = "snapshot";

async function loadRunData() {
  // The snapshot first and unconditionally: it is the baseline, and it is also
  // what the live path falls back to, so there is no ordering where we want to
  // be holding a live response and no snapshot.
  const snapshot = parseAdultDailyCsv(
    await fetchText(SNAPSHOT_URL, SNAPSHOT_TIMEOUT_MS, "Run data snapshot"),
  );

  if (!liveRefreshRequested()) return snapshot;

  try {
    const live = parseAdultDailyCsv(
      await fetchText(
        COLUMBIA_BASIN_RESEARCH_DART_URL,
        DART_TIMEOUT_MS,
        "DART live",
      ),
    );
    runDataSource = "live";
    return live;
  } catch (err) {
    // Non-fatal by construction: the snapshot is already parsed and correct,
    // so a failed refresh costs nothing but the freshness nobody asked for.
    console.warn("Live DART refresh failed, using the vendored snapshot:", err);
    return snapshot;
  }
}

// There is no synthetic fallback any more, and that is the point. The old one
// generated a bell curve of made-up 2023 counts and handed them to a HUD whose
// masthead reads "COUNTING SEASON 2015 · DATA COURTESY OF THE U.S. ARMY CORPS
// OF ENGINEERS" — so the one situation it existed to cover was the one where
// the app confidently presented invented numbers as a federal measurement
// record. With the data vendored into the bundle there is no offline case left
// for it to cover, and failing loudly beats lying quietly.
export const runData = await loadRunData();

// ---------------------------------------------------------------------------
// River conditions and multi-year history.
//
// Both are lazy and memoized, unlike runData above: nothing about the flock,
// the spawn mix or the timeline depends on either one, so there is no reason
// to put a second and third network round-trip on the boot path. Each is
// fetched once, on first call, from a file scripts/fetch-dart.mjs builds
// ahead of time — see that script for the DART queries and the derivation.
//
// A failure here must never take the river down. It degrades one plate in
// the drawer to "data unavailable" and nothing else.

const RIVER_CONDITIONS_URL = "/lwg-river-2015.csv";
const RUN_HISTORY_URL = "/lwg-history-2006-2015.json";
// Same-origin static assets, opened well after boot — generous like
// SNAPSHOT_TIMEOUT_MS, for the same reason.
const ENRICHMENT_TIMEOUT_MS = 15000;

function csvNumber(value) {
  if (value === undefined) return null;
  const trimmed = value.trim();
  if (trimmed === "") return null;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : null;
}

// Wide-format daily river conditions at LWG for 2015 — outflow, spill and
// dissolved gas, pivoted from DART's long-format river_graph_text export at
// fetch time (see scripts/fetch-dart.mjs). Any of the three can be null on a
// day the gauge published nothing, same convention as tempC above.
function parseRiverConditionsCsv(csvText) {
  const lines = csvText.split("\n").filter((line) => line.trim() !== "");
  const header = lines[0].split(",").map((name) => name.trim());
  const col = (name) => header.indexOf(name);
  const dateCol = col("Date");
  const outflowCol = col("OutflowKcfs");
  const spillCol = col("SpillKcfs");
  const gasCol = col("DissolvedGasMmHg");

  return lines.slice(1).map((line) => {
    const fields = line.split(",");
    return {
      date: fields[dateCol],
      outflowKcfs: csvNumber(fields[outflowCol]),
      spillKcfs: csvNumber(fields[spillCol]),
      dissolvedGasMmHg: csvNumber(fields[gasCol]),
    };
  });
}

let riverConditionsPromise = null;

export function loadRiverConditions() {
  if (!riverConditionsPromise) {
    riverConditionsPromise = fetchText(
      RIVER_CONDITIONS_URL,
      ENRICHMENT_TIMEOUT_MS,
      "River conditions",
    ).then(parseRiverConditionsCsv);
  }
  return riverConditionsPromise;
}

let runHistoryPromise = null;

// Per-year season totals by species and a day-of-year min/mean/max envelope
// across 2006-2015, precomputed by scripts/fetch-dart.mjs so the browser
// never parses ten years of CSV itself. Shape:
//   { years, seasonTotals: [{year, chinook, ..., count}],
//     dailyEnvelope: [{doy, n, min, mean, max}] }
export function loadRunHistory() {
  if (!runHistoryPromise) {
    runHistoryPromise = fetchText(
      RUN_HISTORY_URL,
      ENRICHMENT_TIMEOUT_MS,
      "Run history",
    ).then((text) => JSON.parse(text));
  }
  return runHistoryPromise;
}
