// data.js
// Real Lower Granite Dam (LWG) daily adult passage counts, fetched live from
// Columbia Basin Research DART at module load. Of the many species DART
// reports, only four are pulled in: Chinook, Jack Chinook, Steelhead, and
// Shad — `count` (the number driving the whole simulation's population,
// spawn rate, and swim speed — see main.js) is their sum per day.
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

// Parses the DART CSV by header name rather than fixed column indices —
// which columns DART includes (e.g. lamprey day/night splits) has changed
// between years, so a hardcoded index for "Shad" in one year's export can
// silently point at the wrong column in another's. Trailing lines are plain-
// text footnotes (data citation, species-definition notes), not data rows —
// filtered out by requiring the project-name prefix every real row has.
function parseDartCsv(csvText) {
  const lines = csvText.split("\n");
  const header = lines[0].split(",");
  const col = (name) => {
    const i = header.indexOf(name);
    if (i === -1) throw new Error(`DART CSV missing expected column "${name}"`);
    return i;
  };
  const dateCol = col("Date");
  const chinookCol = col("Chin");
  const jackChinookCol = col("JChin");
  const steelheadCol = col("Stlhd");
  const shadCol = col("Shad");

  const data = [];
  for (const line of lines) {
    if (!line.startsWith("Lower Granite,")) continue;
    const fields = line.split(",");
    const chinook = parseCount(fields[chinookCol]);
    const jackChinook = parseCount(fields[jackChinookCol]);
    const steelhead = parseCount(fields[steelheadCol]);
    const shad = parseCount(fields[shadCol]);
    data.push({
      date: fields[dateCol],
      count: chinook + jackChinook + steelhead + shad,
      chinook,
      jackChinook,
      steelhead,
      shad,
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
