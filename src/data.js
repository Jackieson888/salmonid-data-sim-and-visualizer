// data.js
// Design rationale, invariants, gotchas: .claude/context/data.md
import { parseAdultDailyCsv } from "./dart/parseAdultDaily.js";

// Real Lower Granite Dam (LWG) daily adult passage counts, read at module load
// from a snapshot vendored into this repo (public/lwg-adult-daily-2015.csv).
// Five species drive the simulation; `count` is their per-day sum (see main.js).
// The rest of what DART publishes is parsed too and reported in the HUD
// without being simulated — see the note on `count` in parseAdultDailyCsv.
//
// The ten counting seasons vendored under public/, oldest first — every one a
// DART adult_daily.php export for Lower Granite (scripts/fetch-dart.mjs).
//
// NOTHING may cache runData.length across a year change — see the rebuild
// hooks in main.js and plates.js.
export const AVAILABLE_YEARS = [
  2006, 2007, 2008, 2009, 2010, 2011, 2012, 2013, 2014, 2015,
];

// The season the app opens on — 2015 has substantial counts across all five
// simulated species all year and is the only year with a vendored
// river-conditions file (see riverConditionsUrl below).
const DEFAULT_YEAR = 2015;

// Retrieved 2026-08-24, byte-for-byte as served — no added header comment (see data.md for why).
const snapshotUrl = (year) => `/lwg-adult-daily-${year}.csv`;

// Opt-in-only fallback source (see liveRefreshRequested) — snapshots are the default. See data.md.
const liveDartUrl = (year) =>
  `https://www.cbr.washington.edu/dart/cs/php/rpt/adult_daily.php?sc=1&outputFormat=csv&year=${year}&proj=LWG&span=no&startdate=1%2F1&enddate=12%2F31&run=&syear=2026&eyear=2026`;

// Same-origin static asset — generous, bounds a wedged connection rather than policing a slow one.
const SNAPSHOT_TIMEOUT_MS = 15000;
// Third-party host, so this is the real guard.
const DART_TIMEOUT_MS = 5000;

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
    // Rewrite the bare "AbortError" into something that says what was being fetched and for how long.
    if (err.name === "AbortError") {
      throw new Error(`${label} request timed out after ${timeoutMs}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// `?live`/`?live=1` on the URL; off by default (see data.md). Guarded for a non-browser context.
function liveRefreshRequested() {
  if (typeof location === "undefined") return false;
  return new URLSearchParams(location.search).has("live");
}

// Exported so the HUD can be honest about its own provenance (see the masthead in index.html).
export let runDataSource = "snapshot";

async function loadRunDataFor(year) {
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
    // Non-fatal: the snapshot is already parsed and correct.
    console.warn("Live DART refresh failed, using the vendored snapshot:", err);
    return { rows: snapshot, source: "snapshot" };
  }
}

// No synthetic fallback, deliberately — see data.md (the old one presented invented numbers as a federal record).

// `let`, not `const` — ES module live bindings notify every importer the instant loadYear()
// reassigns these, but notify nobody who *derives* something from them. See data.md for the
// rebuild hooks (rebuildForYear() in main.js, rebuildPlatesForYear() in plates.js).
export let runData = [];
export let runYear = DEFAULT_YEAR;

// Parsed rows per year, so revisiting a season is instant. Rows are never mutated downstream.
const rowsByYear = new Map();

// `?year=2011` on the URL, clamped to what is actually vendored.
function initialYear() {
  if (typeof location === "undefined") return DEFAULT_YEAR;
  const requested = Number(new URLSearchParams(location.search).get("year"));
  return AVAILABLE_YEARS.includes(requested) ? requested : DEFAULT_YEAR;
}

// Throws on failure WITHOUT touching runData/runYear — see setYear() in main.js, which
// reverts its control and warns on that throw.
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

// River conditions and multi-year history: lazy and memoized, unlike runData
// — see data.md for why, and for why only 2015 has a vendored river file.
const riverConditionsUrl = (year) => `/lwg-river-${year}.csv`;
const RUN_HISTORY_URL = "/lwg-history-2006-2015.json";
// Same-origin static assets, opened well after boot — generous like SNAPSHOT_TIMEOUT_MS.
const ENRICHMENT_TIMEOUT_MS = 15000;

function csvNumber(value) {
  if (value === undefined) return null;
  const trimmed = value.trim();
  if (trimmed === "") return null;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : null;
}

// Wide-format daily river conditions at LWG, pivoted from DART's long-format
// river_graph_text export (scripts/fetch-dart.mjs). THROWS on a body that
// isn't this file — see data.md for why that matters (an SPA dev-server
// fallback would otherwise return HTML as a 200 and parse into fake rows).
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

// A REJECTED promise is deliberately left cached — see data.md (otherwise a 404'd year re-requests every switch back to it).
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
