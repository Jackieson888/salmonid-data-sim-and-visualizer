// fetch-dart.mjs
// Pulls the DART data the app ships beyond the single-year snapshot already
// vendored at public/lwg-adult-daily-2015.csv, and derives the two files the
// plates drawer reads at runtime. Nothing here runs in the browser — it is a
// build-time script, run by hand when the data needs refreshing:
//
//   node scripts/fetch-dart.mjs
//
// What it writes:
//   data/dart/lwg-adult-daily-{VENDOR_YEARS}.csv  raw, byte-for-byte per year
//   public/lwg-adult-daily-{VENDOR_YEARS}.csv     the same, shipped
//   data/dart/lwg-river-{HISTORY_YEARS}.csv       raw river-environment exports
//   public/lwg-river-{HISTORY_YEARS}.csv          the above, pivoted to wide
//   public/lwg-history-2006-2015.json             derived: season totals +
//                                                  day-of-year envelope
//
// Two different year ranges drive two different things, deliberately kept
// separate: VENDOR_YEARS is every season the app offers in its year picker
// (see AVAILABLE_YEARS in src/data.js) and grows every time a new counting
// season is added. HISTORY_YEARS feeds the run-history JSON and the river
// exports — the frozen 2006-2015 baseline that FIG. 5 and the FIG. 1 ghost
// line compare every season against regardless of which one is on screen
// (see .claude/context/plates.md) — and does not grow with VENDOR_YEARS.
//
// The adult-daily CSVs are written to BOTH trees, and the two copies are
// byte-identical on purpose: every VENDOR_YEARS season has to be under
// public/ to be fetchable at runtime, while data/dart/ stays the auditable
// archive the history derivation below reads (that derivation only reads the
// HISTORY_YEARS subset of it). The river exports are raw under data/dart/ and
// pivoted under public/, so those two genuinely differ.
//
// 2015 is the one year this script does NOT re-fetch: it copies
// public/lwg-adult-daily-2015.csv instead, which src/data.js's own comment
// describes as frozen at its retrieval date on purpose. Re-fetching it here
// would let the archive drift from what the boot path actually serves.
//
// A year at the trailing edge of VENDOR_YEARS may be a season still in
// progress — DART simply answers with however many rows it has counted so
// far. See the season-completeness note in .claude/context/main.md for how
// the app itself detects and displays that.

import { writeFile, readFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { parseAdultDailyCsv } from "../src/dart/parseAdultDaily.js";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DART_DIR = path.join(ROOT, "data", "dart");
const PUBLIC_DIR = path.join(ROOT, "public");

const PROJECT = "LWG";
const FROZEN_YEAR = 2015;
// Every season the app offers in its year picker (AVAILABLE_YEARS in
// src/data.js) — bump the end when a new counting season should become
// selectable, provided this script has actually fetched it.
const VENDOR_YEARS = Array.from({ length: 2026 - 2006 + 1 }, (_, i) => 2006 + i); // 2006-2026
// The frozen ten-year baseline FIG. 5 and the FIG. 1 ghost line compare every
// season against — intentionally NOT tied to VENDOR_YEARS (see the header
// comment and .claude/context/plates.md).
const HISTORY_YEARS = Array.from({ length: 10 }, (_, i) => 2006 + i); // 2006-2015

const FETCH_TIMEOUT_MS = 20000;
// Sequential with a gap rather than parallel — this is a shared research
// server, not a CDN, and there is no rush: the script runs by hand, rarely.
const REQUEST_GAP_MS = 400;

function adultDailyUrl(year) {
  const params = new URLSearchParams({
    sc: "1",
    outputFormat: "csv",
    year: String(year),
    proj: PROJECT,
    span: "no",
    startdate: "1/1",
    enddate: "12/31",
    run: "",
  });
  return `https://www.cbr.washington.edu/dart/cs/php/rpt/adult_daily.php?${params}`;
}

// Long-format river-environment export. Confirmed by hand against the query
// form at https://www.cbr.washington.edu/dart/query/river_graph_text — the
// data[] values are DART's internal parameter keys, not always the same
// string as the form's display label (e.g. temperature is "Temp (Scroll
// Case)", not "Temperature (Scroll Case)"; sending the display label 302s to
// an "invalid submission" page instead of erroring). Scroll-case temperature
// and dissolved-gas-percent were both tried for LWG 2015 and came back
// unavailable/all-NA at this project, which is why they aren't requested
// here — TempC already reaches the app from the adult-passage CSV, and raw
// Dissolved Gas (mmHg, not the percent) is the one that actually has data.
function riverEnvironmentUrl(year) {
  const params = new URLSearchParams();
  params.set("mgconfig", "river");
  params.set("outputFormat", "csvSingle");
  params.append("year[]", String(year));
  params.append("loc[]", PROJECT);
  params.append("data[]", "Outflow");
  params.append("data[]", "Spill");
  params.append("data[]", "Dissolved Gas");
  params.set("avgyear", "0");
  params.set("consolidate", "1");
  params.set("zeros", "0");
  params.set("grid", "1");
  params.set("size", "medium");
  return `https://www.cbr.washington.edu/dart/cs/php/rpt/mg.php?${params}`;
}

async function fetchText(url, label) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`${label} failed: HTTP ${response.status}`);
    }
    return await response.text();
  } finally {
    clearTimeout(timer);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// --- 1. Per-year adult passage CSVs -----------------------------------------

async function fetchAdultDailyYear(year) {
  const archivePath = path.join(DART_DIR, `lwg-adult-daily-${year}.csv`);
  const shippedPath = path.join(PUBLIC_DIR, `lwg-adult-daily-${year}.csv`);

  if (year === FROZEN_YEAR) {
    // Already under public/ and frozen there on purpose — read it back rather
    // than re-fetching, so the archive can never drift from what the app
    // actually serves. Nothing is written to public/ in this branch for the
    // same reason.
    const frozen = await readFile(shippedPath, "utf8");
    await writeFile(archivePath, frozen, "utf8");
    console.log(`  ${year}: copied from the vendored public/ snapshot`);
    return frozen;
  }

  const text = await fetchText(adultDailyUrl(year), `Adult daily ${year}`);
  await writeFile(archivePath, text, "utf8");
  await writeFile(shippedPath, text, "utf8");
  const rows = text.split("\n").filter((l) => l.startsWith(`Lower Granite,`)).length;
  console.log(`  ${year}: fetched, ${rows} data rows -> data/dart/ + public/`);
  return text;
}

// --- 2. River environment, long -> wide -------------------------------------

// DART's csvSingle export concatenates one mini-CSV per requested parameter
// when consolidate=1 doesn't fully merge them — each carries its own repeated
// header row, and the whole thing ends in a blank line and a Notes/citation
// footer. Filtering to lines that start with a 4-digit year is simpler and
// more robust than trying to track section boundaries.
function parseRiverEnvironmentLong(csvText) {
  const rows = [];
  for (const line of csvText.split("\n")) {
    if (!/^\d{4},/.test(line)) continue;
    const [year, mmdd, , parameter, , , value] = line.split(",");
    rows.push({ year, mmdd, parameter, value });
  }
  return rows;
}

const RIVER_PARAM_TO_FIELD = {
  outflow: "outflowKcfs",
  spill: "spillKcfs",
  disgas: "dissolvedGasMmHg",
};

function pivotRiverEnvironmentToWide(rows, year) {
  const byDate = new Map();
  for (const row of rows) {
    const field = RIVER_PARAM_TO_FIELD[row.parameter];
    if (!field) continue; // an average/percent variant we didn't request, or unrecognized
    const [month, day] = row.mmdd.split("-").map((n) => n.padStart(2, "0"));
    const date = `${year}-${month}-${day}`;
    if (!byDate.has(date)) byDate.set(date, { date });
    const value = row.value === "NA" || row.value === "" ? "" : row.value;
    byDate.get(date)[field] = value;
  }

  const dates = [...byDate.keys()].sort();
  const header = "Date,OutflowKcfs,SpillKcfs,DissolvedGasMmHg";
  const lines = dates.map((date) => {
    const r = byDate.get(date);
    return [date, r.outflowKcfs ?? "", r.spillKcfs ?? "", r.dissolvedGasMmHg ?? ""].join(",");
  });
  return [header, ...lines].join("\n") + "\n";
}

// --- 3. Multi-year history: season totals + day-of-year envelope -----------

const HISTORY_SPECIES = [
  "chinook",
  "jackChinook",
  "steelhead",
  "shad",
  "sockeye",
  "coho",
  "jackCoho",
  "lamprey",
];

// Same calculation as dayOfYear() in src/scene/season.js, duplicated rather
// than imported: that module pulls in three.js for its color/vector work,
// which this plain-data script has no reason to load.
function dayOfYear(dateStr) {
  const date = new Date(dateStr + "T00:00:00Z");
  const yearStart = Date.UTC(date.getUTCFullYear(), 0, 1);
  return Math.floor((date.getTime() - yearStart) / 86400000);
}

function buildRunHistory(rowsByYear) {
  const seasonTotals = HISTORY_YEARS.map((year) => {
    const rows = rowsByYear.get(year) ?? [];
    const totals = { year, count: 0 };
    for (const key of HISTORY_SPECIES) totals[key] = 0;
    for (const row of rows) {
      for (const key of HISTORY_SPECIES) totals[key] += row[key];
      totals.count += row.count;
    }
    return totals;
  });

  // For every day-of-year that appears in ANY of the HISTORY_YEARS (not all
  // of rowsByYear — that map now also holds every VENDOR_YEARS season, and
  // this envelope is the frozen ten-year baseline, not a growing one), the
  // min/mean/max of that day's `count` (see parseAdultDailyCsv — currently
  // the five simulated species) across whichever of those years actually
  // have a record for it — the counting season's start/end drifts a little
  // year to year, so not every day has all ten years behind it.
  const byDoy = new Map();
  for (const year of HISTORY_YEARS) {
    for (const row of rowsByYear.get(year) ?? []) {
      const doy = dayOfYear(row.date);
      if (!byDoy.has(doy)) byDoy.set(doy, []);
      byDoy.get(doy).push(row.count);
    }
  }
  const dailyEnvelope = [...byDoy.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([doy, values]) => ({
      doy,
      n: values.length,
      min: Math.min(...values),
      mean: Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 10) / 10,
      max: Math.max(...values),
    }));

  return {
    generatedAt: new Date().toISOString(),
    project: "Lower Granite",
    years: HISTORY_YEARS,
    seasonTotals,
    dailyEnvelope,
  };
}

// --- main --------------------------------------------------------------

async function main() {
  await mkdir(DART_DIR, { recursive: true });

  console.log(`Adult daily passage, ${VENDOR_YEARS[0]}-${VENDOR_YEARS.at(-1)}:`);
  const rowsByYear = new Map();
  for (const year of VENDOR_YEARS) {
    const text = await fetchAdultDailyYear(year);
    rowsByYear.set(year, parseAdultDailyCsv(text, "Lower Granite"));
    if (year !== FROZEN_YEAR) await sleep(REQUEST_GAP_MS);
  }

  // One per year, not just the frozen one: the conditions field in the report
  // bar and FIG. 4 in the plates drawer both follow the year control now, and
  // a season with no river file degrades to "unavailable" (see
  // loadRiverConditions in src/data.js). A single year failing here is not
  // fatal to the run — the other nine are still worth writing.
  console.log(`River environment, ${HISTORY_YEARS[0]}-${HISTORY_YEARS.at(-1)}:`);
  for (const year of HISTORY_YEARS) {
    try {
      const riverRaw = await fetchText(
        riverEnvironmentUrl(year),
        `River environment ${year}`,
      );
      await writeFile(path.join(DART_DIR, `lwg-river-${year}.csv`), riverRaw, "utf8");
      const riverRows = parseRiverEnvironmentLong(riverRaw);
      const riverWide = pivotRiverEnvironmentToWide(riverRows, year);
      await writeFile(path.join(PUBLIC_DIR, `lwg-river-${year}.csv`), riverWide, "utf8");
      console.log(`  ${year}: ${riverRows.length} long-format rows -> public/lwg-river-${year}.csv`);
    } catch (err) {
      console.warn(`  ${year}: river environment unavailable — ${err.message}`);
    }
    await sleep(REQUEST_GAP_MS);
  }

  console.log("Deriving run history...");
  const history = buildRunHistory(rowsByYear);
  await writeFile(
    path.join(PUBLIC_DIR, "lwg-history-2006-2015.json"),
    JSON.stringify(history),
    "utf8",
  );
  console.log(
    `  ${history.seasonTotals.length} years, ${history.dailyEnvelope.length} days-of-year -> public/lwg-history-2006-2015.json`,
  );

  console.log("Done.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
