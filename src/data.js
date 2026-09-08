// Real Lower Granite Dam daily adult passage counts, loaded from vendored DART CSV snapshots in public/.
import { parseAdultDailyCsv } from "./dart/parseAdultDaily.js";

// Every counting season vendored under public/, oldest first; keep in sync with scripts/fetch-dart.mjs's VENDOR_YEARS.
export const AVAILABLE_YEARS = [
  2006, 2007, 2008, 2009, 2010, 2011, 2012, 2013, 2014, 2015, 2016, 2017,
  2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025, 2026,
];

// 2015 has substantial counts across all five simulated species and is the only year with a river-conditions file.
const DEFAULT_YEAR = 2015;

const snapshotUrl = (year) => `/lwg-adult-daily-${year}.csv`;

// Opt-in fallback (see liveRefreshRequested); snapshots are the default.
const liveDartUrl = (year) =>
  `https://www.cbr.washington.edu/dart/cs/php/rpt/adult_daily.php?sc=1&outputFormat=csv&year=${year}&proj=LWG&span=no&startdate=1%2F1&enddate=12%2F31&run=`;

const SNAPSHOT_TIMEOUT_MS = 15000;
// Third-party host, so this timeout is the real guard.
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
    // Rewrite the bare "AbortError" into a message naming what timed out.
    if (err.name === "AbortError") {
      throw new Error(`${label} request timed out after ${timeoutMs}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// `?live`/`?live=1` on the URL; off by default.
function liveRefreshRequested() {
  if (typeof location === "undefined") return false;
  return new URLSearchParams(location.search).has("live");
}

// Exported so the HUD can be honest about its own provenance.
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

// No synthetic fallback, deliberately — the HUD presents this as a federal measurement record.

// `let`, not `const`: loadYear() reassigns these, but anything that derives from them must rebuild explicitly.
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

// Throws on failure without touching runData/runYear.
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

// River conditions and multi-year history: lazy and memoized, unlike runData.
const riverConditionsUrl = (year) => `/lwg-river-${year}.csv`;
const RUN_HISTORY_URL = "/lwg-history-2006-2015.json";
const ENRICHMENT_TIMEOUT_MS = 15000;

function csvNumber(value) {
  if (value === undefined) return null;
  const trimmed = value.trim();
  if (trimmed === "") return null;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : null;
}

// Throws on a body that isn't this CSV, since a dev-server SPA fallback would otherwise return HTML as a fake 200.
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

// A rejected promise is deliberately left cached, or a 404'd year would re-request every switch back to it.
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

// Per-year season totals and a day-of-year min/mean/max envelope, precomputed by scripts/fetch-dart.mjs.
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
