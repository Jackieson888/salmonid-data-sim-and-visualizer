// data.js
// PLACEHOLDER DATA — shaped like a real spring/summer Chinook run (slow
// build, sharp peak, gradual taper) so the simulation looks reasonable
// before real numbers are wired in.
//
// TODO: Replace this with actual Lower Granite Dam daily adult passage
// counts from Columbia Basin Research DART:
//   https://www.cbr.washington.edu/dart/query/adult_daily
// Select project = Lower Granite (LWG), species = Chinook (or Steelhead/
// Sockeye), a year, and export as CSV. Parse each row into
// { date: "YYYY-MM-DD", count: <daily count> } and drop it in below.

function generatePlaceholderRun() {
  const days = 90; // roughly April 1 - June 30
  const data = [];
  const start = new Date("2023-04-01");

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

export const runData = generatePlaceholderRun();
