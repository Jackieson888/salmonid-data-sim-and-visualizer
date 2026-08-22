// data.js
// Real Lower Granite Dam (LWG) daily adult passage counts, fetched live from
// Columbia Basin Research DART at module load.
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
// Falls back to a placeholder run (bell-curve-shaped, not real data) if the
// fetch fails — offline, DART unreachable, etc. — so the app still loads.
const DART_YEAR = 2015;
const COLUMBIA_BASIN_RESEARCH_DART_URL =
  `https://www.cbr.washington.edu/dart/cs/php/rpt/adult_daily.php?sc=1&outputFormat=csv&year=${DART_YEAR}&proj=LWG&span=no&startdate=1%2F1&enddate=12%2F31&run=&syear=2026&eyear=2026`;

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

async function fetchRunData() {
  const response = await fetch(COLUMBIA_BASIN_RESEARCH_DART_URL);
  if (!response.ok) {
    throw new Error(`DART request failed: ${response.status}`);
  }
  return parseDartCsv(await response.text());
}

function generatePlaceholderRun() {
  const days = 365; // roughly Jan 1 - Dec 31
  const data = [];
  const start = new Date("2023-01-01");

  for (let i = 0; i < days; i++) {
    // Bell-curve-ish run shape peaking around day 55, plus a little noise.
    const peak = 55;
    const spread = 18;
    const base = 400 * Math.exp(-Math.pow(i - peak, 2) / (2 * spread * spread));
    const noise = Math.random() * 40;
    const count = Math.max(5, Math.round(base + noise));

    const date = new Date(start);
    date.setDate(date.getDate() + i);

    data.push({
      date: date.toISOString().slice(0, 10),
      count,
    });
  }

  return data;
}

export const runData = await fetchRunData().catch((err) => {
  console.warn(
    "DART fetch failed, falling back to placeholder run data:",
    err,
  );
  return generatePlaceholderRun();
});
