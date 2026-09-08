// Pure parser for DART's adult_daily.php CSV export; shared by data.js (browser) and scripts/fetch-dart.mjs (Node).

// DART's negative values are corrections, not real counts — floored to 0.
function parseCount(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

// Keeps "not published" distinguishable from "zero".
function parseMeasurement(value) {
  if (value === undefined) return null;
  const trimmed = value.trim();
  if (trimmed === "") return null;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : null;
}

// DART's Chinook-run-schedule abbreviations, not a per-fish determination.
const CHINOOK_RUN_NAMES = { Sp: "Spring", Su: "Summer", Fa: "Fall" };

// Parses by header name, not column index, so column order/additions don't break it.
export function parseAdultDailyCsv(csvText, project = "Lower Granite") {
  const lines = csvText.split("\n");
  const header = lines[0].split(",").map((name) => name.trim());

  // Always-present columns — a missing one throws rather than quietly reporting zeros.
  const col = (name) => {
    const i = header.indexOf(name);
    if (i === -1) throw new Error(`DART CSV missing expected column "${name}"`);
    return i;
  };
  // Enrichment columns — resolve to -1 when absent rather than throwing.
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

    // Combined column when present (recent exports); reconstructed from day+night otherwise.
    const lamprey =
      lampreyCombinedCol !== -1
        ? parseCount(fields[lampreyCombinedCol])
        : lampreyDay + lampreyNight;

    data.push({
      date: fields[dateCol],

      // Deliberately still only these five species.
      count: chinook + jackChinook + steelhead + shad + lamprey,
      chinook,
      jackChinook,
      steelhead,
      shad,
      lamprey,
      lampreyDay,
      lampreyNight,

      // A SUBSET of `steelhead`, not an addition to it.
      wildSteelhead: parseCount(fields[wildSteelheadCol]),

      // Counted at the dam but not modelled in the water.
      sockeye: parseCount(fields[sockeyeCol]),
      coho: parseCount(fields[cohoCol]),
      jackCoho: parseCount(fields[jackCohoCol]),

      // Not modelled anywhere at LWG but real elsewhere in the DART schema.
      bullTrout: parseCount(fields[bullTroutCol]),
      chum: parseCount(fields[chumCol]),
      pink: parseCount(fields[pinkCol]),

      // Degrees Celsius; null on days DART published none.
      tempC: parseMeasurement(fields[tempCol]),

      // Null outside the runs' scheduled windows (most of the winter).
      chinookRun: CHINOOK_RUN_NAMES[(fields[runCol] ?? "").trim()] ?? null,
    });
  }
  if (data.length === 0) throw new Error("DART CSV had no data rows");
  return data;
}
