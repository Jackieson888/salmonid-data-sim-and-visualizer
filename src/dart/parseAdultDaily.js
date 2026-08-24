// parseAdultDaily.js
// Pure parser for DART's adult_daily.php CSV export. No fetch, no browser
// globals — this is the part of the old data.js that scripts/fetch-dart.mjs
// needs too (to build the multi-year history file under Node), so it lives
// on its own rather than being duplicated.

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
//
// `project` defaults to "Lower Granite" — the only project this app has ever
// queried — but is a parameter rather than baked into the row filter, so a
// second dam is a data change (fetch its CSV, parse with its name) rather
// than a code change.
export function parseAdultDailyCsv(csvText, project = "Lower Granite") {
  const lines = csvText.split("\n");
  const header = lines[0].split(",").map((name) => name.trim());

  // The four that always appear as their own DART columns. A missing one here
  // is a real breakage — the population, spawn mix and swim speed all derive
  // from these plus lamprey (see `count` below) — so this throws rather than
  // quietly reporting a season of zeros. Lamprey isn't in this group: its own
  // column is looked up as `optionalCol` below (its name has changed between
  // years — see the note on lampreyCombinedCol/lampreyDayCol/lampreyNightCol),
  // but it still feeds `count` unconditionally, via the always-defined
  // `lamprey` local a few lines down.
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
  const bullTroutCol = optionalCol("BTrout");
  const chumCol = optionalCol("Chum");
  const pinkCol = optionalCol("Pink");
  const tempCol = optionalCol("TempC");

  const prefix = `${project},`;
  const data = [];
  for (const line of lines) {
    if (!line.startsWith(prefix)) continue;
    const fields = line.split(",");
    const chinook = parseCount(fields[chinookCol]);
    const jackChinook = parseCount(fields[jackChinookCol]);
    const steelhead = parseCount(fields[steelheadCol]);
    const shad = parseCount(fields[shadCol]);
    const lampreyDay = parseCount(fields[lampreyDayCol]);
    const lampreyNight = parseCount(fields[lampreyNightCol]);

    // DART reports lamprey as a combined figure in recent exports and as
    // separate day/night columns in older ones; take the combined column when
    // it is there and reconstruct it otherwise.
    const lamprey =
      lampreyCombinedCol !== -1
        ? parseCount(fields[lampreyCombinedCol])
        : lampreyDay + lampreyNight;

    data.push({
      date: fields[dateCol],

      // DELIBERATELY still only these five. `count` drives the simulated
      // population, the spawn ramp and the swim speed (see main.js), and the
      // renderer has exactly five species to draw with (see SPECIES_MODEL_URL
      // in fishMesh.js) — folding sockeye, coho and jack coho in here would
      // rebalance the whole run to show fish that aren't modelled. They are
      // reported in the HUD instead. `lamprey` is defined just above
      // (unconditionally 0 on a CSV that published neither the combined nor
      // the day/night columns), so this sum is always safe to take.
      count: chinook + jackChinook + steelhead + shad + lamprey,
      chinook,
      jackChinook,
      steelhead,
      shad,
      lamprey,
      // Kept alongside the combined figure above rather than instead of it:
      // the split itself is the interesting fact (lamprey pass mostly at
      // night, salmonids don't — see FIG. 6 in the plates drawer) and the
      // combined total is what the rest of the app wants. Both are 0 on a
      // year that never published the split, same as every other optional
      // column.
      lampreyDay,
      lampreyNight,

      // A SUBSET of `steelhead`, not an addition to it — DART's Stlhd column
      // already includes both hatchery and wild fish, and the CSV's own notes
      // say so explicitly. Adding it to any total would double-count.
      wildSteelhead: parseCount(fields[wildSteelheadCol]),

      // Counted at the dam but not modelled in the water. Small numbers next
      // to the five above (a few hundred each across a whole season) and
      // worth reporting for exactly that reason: a passage report that showed
      // only the abundant species would hide the ones anyone is actually
      // worried about.
      sockeye: parseCount(fields[sockeyeCol]),
      coho: parseCount(fields[cohoCol]),
      jackCoho: parseCount(fields[jackCohoCol]),

      // Not modelled anywhere at LWG (always 0 there) but real elsewhere in
      // the DART schema — parsed so a different project doesn't silently
      // drop them.
      bullTrout: parseCount(fields[bullTroutCol]),
      chum: parseCount(fields[chumCol]),
      pink: parseCount(fields[pinkCol]),

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
