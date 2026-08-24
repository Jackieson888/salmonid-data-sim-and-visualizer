// data.js
// Real Lower Granite Dam (LWG) daily adult passage counts, read at module load
// from a snapshot vendored into this repo (public/lwg-adult-daily-2015.csv).
//
// Four species drive the simulation — Chinook, Jack Chinook, Steelhead and
// Shad — and `count` (the number behind the whole population, spawn rate and
// swim speed; see main.js) is their sum per day. Those are the four the
// renderer has meshes and tints for.
//
// The rest of what DART publishes per day is parsed too, and reported in the
// HUD without being simulated: wild steelhead (a subset of the steelhead
// count), sockeye, coho, jack coho, Pacific lamprey, the water temperature at
// the project, and which Chinook run the date falls in. None of it reaches
// the flock — see the note on `count` in parseDartCsv.
//
// DART_YEAR = 2015: picked over more recent years (2023 in particular) after
// spot-checking a few — 2015 has substantial counts across all four species
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

// DART marks some days with a negative value (e.g. "-1") — a correction/
// adjustment to a prior count, not a literal negative number of fish — so
// those are floored to 0 rather than subtracted from the day's total.
function parseCount(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

// For columns where "not published" has to stay distinguishable from "zero".
// Temperature is the reason: DART leaves the cell blank on days the gauge was
// down, and running that through parseCount would report those days as 0 °C —
// a real reading, and a wrong one. Returns null instead so the HUD can show
// nothing at all.
function parseMeasurement(value) {
  if (value === undefined) return null;
  const trimmed = value.trim();
  if (trimmed === "") return null;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : null;
}

// DART's abbreviations for the Chinook run a given day falls in. These are
// run *schedules* set by the Corps per project, not a determination about the
// individual fish counted — see the "Chinook Run Dates" note in the CSV's own
// footer.
const CHINOOK_RUN_NAMES = { Sp: "Spring", Su: "Summer", Fa: "Fall" };

// Parses the DART CSV by header name rather than fixed column indices —
// which columns DART includes (e.g. lamprey day/night splits) has changed
// between years, so a hardcoded index for "Shad" in one year's export can
// silently point at the wrong column in another's. Trailing lines are plain-
// text footnotes (data citation, species-definition notes), not data rows —
// filtered out by requiring the project-name prefix every real row has.
function parseDartCsv(csvText) {
  const lines = csvText.split("\n");
  const header = lines[0].split(",").map((name) => name.trim());

  // The four the simulation is actually built on. A missing one here is a
  // real breakage — the population, spawn mix and swim speed all derive from
  // them — so this throws rather than quietly reporting a season of zeros.
  const col = (name) => {
    const i = header.indexOf(name);
    if (i === -1) throw new Error(`DART CSV missing expected column "${name}"`);
    return i;
  };
  // Everything else is enrichment for the HUD. DART's column set genuinely
  // does change between years (the lamprey day/night split is the documented
  // case), so these resolve to -1 when absent, which reads back as undefined
  // and parses to 0/null — the readout goes quiet instead of the app failing.
  const optionalCol = (name) => header.indexOf(name);

  const dateCol = col("Date");
  const chinookCol = col("Chin");
  const jackChinookCol = col("JChin");
  const steelheadCol = col("Stlhd");
  const shadCol = col("Shad");

  const runCol = optionalCol("Chinook Run");
  const wildSteelheadCol = optionalCol("WStlhd");
  const sockeyeCol = optionalCol("Sock");
  const cohoCol = optionalCol("Coho");
  const jackCohoCol = optionalCol("JCoho");
  const lampreyCombinedCol = optionalCol("LmpryCombined");
  const lampreyDayCol = optionalCol("LmpryDay");
  const lampreyNightCol = optionalCol("LmpryNight");
  const tempCol = optionalCol("TempC");

  const data = [];
  for (const line of lines) {
    if (!line.startsWith("Lower Granite,")) continue;
    const fields = line.split(",");
    const chinook = parseCount(fields[chinookCol]);
    const jackChinook = parseCount(fields[jackChinookCol]);
    const steelhead = parseCount(fields[steelheadCol]);
    const shad = parseCount(fields[shadCol]);

    // DART reports lamprey as a combined figure in recent exports and as
    // separate day/night columns in older ones; take the combined column when
    // it is there and reconstruct it otherwise.
    const lamprey =
      lampreyCombinedCol !== -1
        ? parseCount(fields[lampreyCombinedCol])
        : parseCount(fields[lampreyDayCol]) +
          parseCount(fields[lampreyNightCol]);

    data.push({
      date: fields[dateCol],

      // DELIBERATELY still only those four. `count` drives the simulated
      // population, the spawn ramp and the swim speed (see main.js), and the
      // renderer has exactly four species to draw with — folding sockeye,
      // coho and lamprey in here would rebalance the whole run to show fish
      // that aren't modelled. They are reported in the HUD instead.
      count: chinook + jackChinook + steelhead + shad,
      chinook,
      jackChinook,
      steelhead,
      shad,

      // A SUBSET of `steelhead`, not an addition to it — DART's Stlhd column
      // already includes both hatchery and wild fish, and the CSV's own notes
      // say so explicitly. Adding it to any total would double-count.
      wildSteelhead: parseCount(fields[wildSteelheadCol]),

      // Counted at the dam but not modelled in the water. Small numbers next
      // to the four above (a few hundred each across a whole season) and
      // worth reporting for exactly that reason: a passage report that showed
      // only the abundant species would hide the ones anyone is actually
      // worried about.
      sockeye: parseCount(fields[sockeyeCol]),
      coho: parseCount(fields[cohoCol]),
      jackCoho: parseCount(fields[jackCohoCol]),
      lamprey,

      // Water temperature at the project, degrees Celsius. Null on days DART
      // published none — see parseMeasurement.
      tempC: parseMeasurement(fields[tempCol]),

      // Null outside the runs' scheduled windows, which is most of the winter.
      chinookRun: CHINOOK_RUN_NAMES[(fields[runCol] ?? "").trim()] ?? null,
    });
  }
  if (data.length === 0) throw new Error("DART CSV had no data rows");
  return data;
}

// fetch() has no timeout of its own — a connection that opens and then stalls
// hangs the promise forever, which is exactly the failure this module used to
// sit on. AbortController is the only way to bound it.
async function fetchCsv(url, timeoutMs, label) {
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
  const snapshot = parseDartCsv(
    await fetchCsv(SNAPSHOT_URL, SNAPSHOT_TIMEOUT_MS, "Run data snapshot"),
  );

  if (!liveRefreshRequested()) return snapshot;

  try {
    const live = parseDartCsv(
      await fetchCsv(
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
