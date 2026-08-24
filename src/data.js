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
// The ten counting seasons vendored under public/, oldest first. Every one is
// a DART adult_daily.php export for Lower Granite, retrieved by
// scripts/fetch-dart.mjs, and every one parses under the same header-name
// lookup — 2006-2008 publish only `LmpryDay` where later years also carry
// `LmpryNight`/`LmpryCombined`, which parseAdultDailyCsv already handles by
// resolving an absent column to -1.
//
// The dam's counting season runs roughly March-December, not the full calendar
// year, so a season is 290-306 entries rather than 365, and the exact length
// differs year to year. NOTHING may cache runData.length across a year change
// — see the rebuild hooks in main.js and plates.js.
export const AVAILABLE_YEARS = [
  2006, 2007, 2008, 2009, 2010, 2011, 2012, 2013, 2014, 2015,
];

// The season the app opens on. Picked over more recent years (2023 in
// particular) after spot-checking a few — 2015 has substantial counts across
// all five simulated species all year, where some other years have long
// stretches of near-zero Chinook. It is also the only year with a vendored
// river-conditions file (see RIVER_CONDITIONS_URL below).
const DEFAULT_YEAR = 2015;

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
const snapshotUrl = (year) => `/lwg-adult-daily-${year}.csv`;

// WHY SNAPSHOTS RATHER THAN LIVE FETCHES.
//
// Every year the app offers is a fixed historical one, so the live query
// returns the same rows on every load, forever — there is nothing to be fresh
// about. What fetching at boot did buy was a hard dependency on a third-party
// host being up and fast, on the critical path of a module-level `await`:
// nothing in the app can evaluate until it settles, and it had no timeout, so
// a hanging connection left a blank canvas indefinitely rather than failing.
//
// The snapshots are served from our own origin instead, and the live path
// below is opt-in (see liveRefreshRequested). It stays in the file because it
// is what a year outside the vendored range would have to be backed by.
const liveDartUrl = (year) =>
  `https://www.cbr.washington.edu/dart/cs/php/rpt/adult_daily.php?sc=1&outputFormat=csv&year=${year}&proj=LWG&span=no&startdate=1%2F1&enddate=12%2F31&run=&syear=2026&eyear=2026`;

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

async function loadRunDataFor(year) {
  // The snapshot first and unconditionally: it is the baseline, and it is also
  // what the live path falls back to, so there is no ordering where we want to
  // be holding a live response and no snapshot.
  const snapshot = parseAdultDailyCsv(
    await fetchText(snapshotUrl(year), SNAPSHOT_TIMEOUT_MS, `Run data ${year}`),
  );

  if (!liveRefreshRequested()) return { rows: snapshot, source: "snapshot" };

  try {
    const live = parseAdultDailyCsv(
      await fetchText(liveDartUrl(year), DART_TIMEOUT_MS, `DART live ${year}`),
    );
    return { rows: live, source: "live" };
  } catch (err) {
    // Non-fatal by construction: the snapshot is already parsed and correct,
    // so a failed refresh costs nothing but the freshness nobody asked for.
    console.warn("Live DART refresh failed, using the vendored snapshot:", err);
    return { rows: snapshot, source: "snapshot" };
  }
}

// There is no synthetic fallback any more, and that is the point. The old one
// generated a bell curve of made-up 2023 counts and handed them to a HUD whose
// masthead reads "COUNTING SEASON 2015 · DATA COURTESY OF THE U.S. ARMY CORPS
// OF ENGINEERS" — so the one situation it existed to cover was the one where
// the app confidently presented invented numbers as a federal measurement
// record. With the data vendored into the bundle there is no offline case left
// for it to cover, and failing loudly beats lying quietly.

// The season currently loaded, and its rows.
//
// Both are `let` rather than `const`, and that is load-bearing: ES module live
// bindings mean every `import { runData }` consumer sees the new array the
// instant loadYear() reassigns it, with no import churn and no event bus. What
// live bindings do NOT do is notify anyone, so any consumer that DERIVES
// something from the record — a typed array sized off runData.length, an SVG
// path, a cumulative total — has to be told to rebuild. Those hooks are
// rebuildForYear() in main.js and rebuildPlatesForYear() in plates.js, and
// they are the whole cost of this design.
export let runData = [];
export let runYear = DEFAULT_YEAR;

// Parsed rows per year, so switching back to a season already visited is
// instant and costs no second round-trip. The rows are never mutated by
// anything downstream, so handing the same array out twice is safe.
const rowsByYear = new Map();

// `?year=2011` on the URL, clamped to what is actually vendored. Guarded for a
// non-browser context (a test harness importing this module) the same way
// liveRefreshRequested() is.
function initialYear() {
  if (typeof location === "undefined") return DEFAULT_YEAR;
  const requested = Number(new URLSearchParams(location.search).get("year"));
  return AVAILABLE_YEARS.includes(requested) ? requested : DEFAULT_YEAR;
}

// Loads a season and makes it current. Throws on failure WITHOUT touching
// runData/runYear, so a switch that fails leaves the app on the season it was
// already showing rather than on nothing at all — see setYear() in main.js,
// which reverts its control and warns.
export async function loadYear(year) {
  if (!rowsByYear.has(year)) {
    const { rows, source } = await loadRunDataFor(year);
    rowsByYear.set(year, rows);
    runDataSource = source;
  }
  runData = rowsByYear.get(year);
  runYear = year;
  return runData;
}

await loadYear(initialYear());

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

// Only 2015 is vendored today — scripts/fetch-dart.mjs now writes one of these
// per year, but re-running it needs the network, and until someone does the
// other nine 404. That is handled rather than avoided: loadRiverConditions()
// rejects, and both callers (FIG. 4 in plates.js, the conditions field in
// main.js) degrade to "unavailable" instead of failing. Adding the remaining
// years is a data change, not a code change.
const riverConditionsUrl = (year) => `/lwg-river-${year}.csv`;
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

// Wide-format daily river conditions at LWG — outflow, spill and dissolved
// gas, pivoted from DART's long-format river_graph_text export at fetch time
// (see scripts/fetch-dart.mjs). Any of the three can be null on a day the
// gauge published nothing, same convention as tempC above.
//
// THROWS on a body that isn't this file, and that is not defensive
// programming for its own sake — it is the only thing standing between a
// missing year and a fabricated one. A dev server's SPA fallback answers a
// request for a file it does not have with index.html and HTTP 200, so the
// fetch succeeds and hands this function a page of HTML. Without the check
// below, `indexOf` returns -1 for every column, every field parses to
// null/undefined, and the caller gets a long list of well-formed rows holding
// nothing — which the conditions field and FIG. 4 would then present as
// readings from a river gauge. Failing here is what routes those to their
// "unavailable" states instead.
function parseRiverConditionsCsv(csvText) {
  const lines = csvText.split("\n").filter((line) => line.trim() !== "");
  const header = lines[0].split(",").map((name) => name.trim());
  const col = (name) => header.indexOf(name);
  const dateCol = col("Date");
  const outflowCol = col("OutflowKcfs");
  const spillCol = col("SpillKcfs");
  const gasCol = col("DissolvedGasMmHg");

  if (dateCol === -1 || (outflowCol === -1 && spillCol === -1 && gasCol === -1)) {
    throw new Error(
      "River conditions CSV missing its expected columns — " +
        "the response was not a river-environment export",
    );
  }

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

// Memoized per year rather than once, for the same reason rowsByYear is: the
// file for a season already visited is already parsed. A REJECTED promise is
// deliberately left in the map — the nine unvendored years would otherwise
// re-request a known 404 on every year switch back to them.
const riverConditionsByYear = new Map();

export function loadRiverConditions(year = runYear) {
  if (!riverConditionsByYear.has(year)) {
    riverConditionsByYear.set(
      year,
      fetchText(
        riverConditionsUrl(year),
        ENRICHMENT_TIMEOUT_MS,
        `River conditions ${year}`,
      ).then(parseRiverConditionsCsv),
    );
  }
  return riverConditionsByYear.get(year);
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
