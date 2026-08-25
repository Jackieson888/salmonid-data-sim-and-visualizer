# Data layer — data.js, dart/parseAdultDaily.js, seasonScale.js

The DART daily-passage record: how it's fetched (or not), parsed, cached
per-year, and mapped onto the x-axis every chart in the app shares. Three
files, one concern.

## data.js

### Why snapshots, not live fetches

Every year the app offers is a fixed historical season, so a live DART query
returns the same rows on every load, forever — there is nothing to be fresh
about. What fetching at boot used to buy was a hard dependency on a
third-party host being up and fast, on the critical path of a module-level
`await`: nothing in the app could evaluate until it settled, and it had no
timeout, so a hanging connection left a blank canvas indefinitely. The
snapshots (`public/lwg-adult-daily-<year>.csv`) are served from the app's
own origin instead. The live path (`liveDartUrl`) stays in the file, opt-in
via `?live`/`?live=1` on the URL (see `liveRefreshRequested`) — it's what a
year outside the vendored range would have to be backed by, and it's used
to A/B against the snapshot rather than depended on. The snapshot is always
fetched first and unconditionally, since it's both the baseline and the
live path's own fallback — there is no ordering where the app wants to be
holding a live response with no snapshot underneath it. A failed live
refresh is non-fatal: the snapshot is already parsed and correct, so it
just costs the freshness nobody asked for (`console.warn`, not throw).

The 2015 snapshot itself is retrieved byte-for-byte as served, deliberately
without a header comment marking the retrieval (the usual mark of a
vendored file). Two reasons: `parseAdultDailyCsv` reads `lines[0]` as the
column header, so a leading comment would have to be parsed around; and
DART's export already carries its own provenance in its footer (generation
timestamp, USACE disclaimer, full DART data citation) — better evidence of
where this came from than a line the app wrote itself. Those footnote lines
are skipped by the project-name-prefix filter in `parseAdultDailyCsv`, same
as in a live response.

### fetchText and timeouts

`fetch()` has no timeout of its own — a connection that opens and then
stalls hangs the promise forever, which is exactly the failure this module
used to sit on. `AbortController` is the only way to bound it.
`SNAPSHOT_TIMEOUT_MS` (15s) is generous because it's a same-origin static
asset — it exists to bound a wedged connection, not to police a slow one.
`DART_TIMEOUT_MS` (5s) is the real guard, since the live DART host is a
third-party dependency that used to sit on the boot path. `fetchText`
returns raw text rather than parsing, so it stays the one place the
timeout/error handling lives; every caller (CSV or JSON) parses it
separately. An `AbortError` surfaces from the browser as a bare
"AbortError"/"The operation was aborted", which says nothing about what was
being fetched or for how long — `fetchText` rewrites it with the label and
timeout.

### No synthetic data fallback

There is no synthetic fallback anywhere in this file, and that's
deliberate. The old one generated a bell curve of made-up 2023 counts and
handed them to a HUD whose masthead reads "COUNTING SEASON 2015 · DATA
COURTESY OF THE U.S. ARMY CORPS OF ENGINEERS" — so the one situation it
existed to cover was the one where the app confidently presented invented
numbers as a federal measurement record. With the data vendored into the
bundle there is no offline case left for it to cover, and failing loudly
beats lying quietly.

### Live bindings and rebuild hooks

`runData`/`runYear` are `export let`, not `const`, and that's load-bearing:
ES module live bindings mean every `import { runData }` consumer sees the
new array the instant `loadYear()` reassigns it, with no import churn and
no event bus. What live bindings do **not** do is notify anyone — so any
consumer that *derives* something from the record (a typed array sized off
`runData.length`, an SVG path, a cumulative total) has to be told to
rebuild. Those hooks are `rebuildForYear()` in `main.js` and
`rebuildPlatesForYear()` in `plates.js`, and they are the whole cost of
this design. `loadYear()` throws on failure *without* touching
`runData`/`runYear`, so a switch that fails leaves the app on the season it
was already showing rather than on nothing — `main.js`'s `setYear()` reverts
its control and warns on that throw.

Parsed rows are cached per year in `rowsByYear` so revisiting a season
already loaded is instant and costs no second round-trip; the rows are
never mutated downstream, so handing the same array out twice is safe.

**The counting season is 290–306 days, never 365** — Lower Granite's
counting season runs roughly March–December, not the full calendar year,
and the exact length differs year to year. Nothing may cache
`runData.length` across a year change. The one exception to the 290–306
range is the trailing entry in `AVAILABLE_YEARS` when it names a season
that hasn't finished yet — DART just answers with however many rows it's
counted so far (176 for 2026 as of this writing), and the app shows that
honestly rather than padding it out. See the season-completeness note in
`.claude/context/main.md` for how that's detected and surfaced.

### AVAILABLE_YEARS and scripts/fetch-dart.mjs's two year ranges

`AVAILABLE_YEARS` must exactly match what `scripts/fetch-dart.mjs` has
actually vendored under `public/` — it's a literal list, not a computed
range, on purpose: a formula (e.g. "2006 through this year") would drift
from what's really on disk the moment a season goes un-fetched, and a
year offered in the picker with no snapshot behind it fails at `loadYear()`
time instead of at review time. Bump both together.

That script itself now tracks two *different* year ranges, and it matters
that they stay separate: `VENDOR_YEARS` is every season this file's
`AVAILABLE_YEARS` offers, and grows every time a new counting season is
added. `HISTORY_YEARS` is the frozen 2006–2015 baseline `loadRunHistory()`
serves — fixed regardless of how far `VENDOR_YEARS` grows, because FIG. 5
and the FIG. 1 ghost line in `plates.js` are explicitly a ten-year
comparison, not a growing one (see `.claude/context/plates.md`). Folding
new seasons into that baseline — especially a partial, in-progress one,
which would drag its day-of-year envelope toward artificially low
min/mean values for no reason other than the season not being over yet —
is a distinct decision for a future pass, not a side effect of vendoring
more years.

### River conditions and run history — lazy and memoized, unlike runData

Neither `loadRiverConditions()` nor `loadRunHistory()` is on the boot path:
nothing about the flock, the spawn mix, or the timeline depends on either
one, so there's no reason to put a second and third network round trip on
first paint. Each is fetched once, on first call, from a file
`scripts/fetch-dart.mjs` builds ahead of time. A failure here must never
take the river down — it degrades one plate in the drawer to "data
unavailable" and nothing else.

Only 2015 has a vendored river-conditions file today (`lwg-river-2015.csv`);
`scripts/fetch-dart.mjs` can write one per year, but that needs the network
to run, and until someone does, the other nine years 404. That's handled
rather than avoided: `loadRiverConditions()` rejects for those years, and
both callers (FIG. 4 in `plates.js`, the conditions field in `main.js`)
degrade to "unavailable." Adding the remaining years is a data change, not
a code change. `riverConditionsByYear` deliberately keeps a **rejected**
promise cached for a 404'd year — otherwise every switch back to an
unvendored year would re-request a known 404.

`parseRiverConditionsCsv` **throws** on a body that isn't this file — not
defensive programming for its own sake, but the only thing standing between
a missing year and a fabricated one. A dev server's SPA fallback answers a
request for a file it doesn't have with `index.html` and HTTP 200, so the
fetch "succeeds" and hands this function a page of HTML. Without the
column-presence check, `indexOf` returns -1 for every column, every field
parses to null/undefined, and the caller gets a long list of well-formed
rows holding nothing — which the conditions field and FIG. 4 would then
present as real gauge readings. The throw is what routes those to their
"unavailable" states instead.

## dart/parseAdultDaily.js

Pure parser for DART's `adult_daily.php` CSV export — no fetch, no browser
globals. It lives on its own (not folded into `data.js`) because
`scripts/fetch-dart.mjs` needs the exact same column-mapping logic under
Node to build the multi-year history file, and this way there's one
implementation instead of two that can drift apart.

### Why parse by header name, not column index

Which columns DART includes has changed between years — the lamprey
day/night split is the documented case, present in some years' exports and
absent (replaced by a single combined column) in others. A hardcoded index
for e.g. "Shad" in one year's export can silently point at the wrong column
in a different year's. `col(name)` looks up by header name and **throws**
if one of the four always-expected columns (`Date`, `Chin`, `JChin`,
`Stlhd`, `Shad`) is missing — a real breakage, since population, spawn mix
and swim speed all derive from these plus lamprey. `optionalCol(name)`
resolves to -1 when a column is absent, which reads back as `undefined` and
parses to 0/null — the readout goes quiet instead of the app failing.

### parseCount vs. parseMeasurement

DART marks some days with a negative value (e.g. "-1") — a
correction/adjustment to a prior count, not a literal negative number of
fish — so `parseCount` floors those to 0 rather than subtracting them from
the day's total. `parseMeasurement` is separate because for some columns
(temperature is the reason) "not published" has to stay distinguishable
from "zero": DART leaves the cell blank on days the gauge was down, and
running that through `parseCount` would report those days as 0°C — a real
reading, and a wrong one. `parseMeasurement` returns `null` instead, so the
HUD can show nothing at all rather than a false zero.

### count — deliberately still only five species

`count` (chinook + jackChinook + steelhead + shad + lamprey) drives the
simulated population, spawn ramp and swim speed (`main.js`), and the
renderer has exactly five species' worth of models/tints
(`SPECIES_MODEL_URL` in `fishMesh.js`). Folding sockeye, coho or jack coho
into this sum would rebalance the whole run to show fish that aren't
modeled — they're reported in the HUD instead, parsed but never summed into
`count`. `lamprey` is always defined (0 on a CSV that published neither the
combined nor the day/night columns), so this sum is always safe to take.

### Row fields worth knowing

- `lamprey` — DART reports lamprey as a single combined figure in recent
  exports and as separate day/night columns in older ones; the combined
  column is taken when present, otherwise reconstructed as
  `lampreyDay + lampreyNight`.
- `lampreyDay`/`lampreyNight` — kept alongside the combined figure rather
  than instead of it, because the split itself is the interesting fact
  (lamprey pass mostly at night, salmonids don't — see FIG. 6 in
  `plates.js`) and the combined total is what the rest of the app wants.
- `wildSteelhead` — a **subset** of `steelhead`, not an addition to it.
  DART's `Stlhd` column already includes both hatchery and wild fish (the
  CSV's own notes say so explicitly); adding `wildSteelhead` to any total
  would double-count.
- `sockeye`/`coho`/`jackCoho` — counted at the dam but not modeled in the
  water. Small numbers next to the five simulated species (a few hundred
  each across a whole season), worth reporting for exactly that reason: a
  passage report showing only the abundant species would hide the ones
  anyone is actually worried about.
- `bullTrout`/`chum`/`pink` — always 0 at Lower Granite but real elsewhere
  in the DART schema; parsed anyway so a different project's export
  wouldn't silently drop them.
- `chinookRun` — DART's abbreviations for the Chinook run a given day falls
  in (`Sp`/`Su`/`Fa` → Spring/Summer/Fall). These are run *schedules* the
  Corps sets per project, not a determination about the individual fish
  counted (see the CSV's own "Chinook Run Dates" footer note). `null`
  outside the runs' scheduled windows, which is most of the winter.

`project` defaults to `"Lower Granite"` — the only project this app has
ever queried — but is a parameter rather than baked into the row filter, so
supporting a second dam is a data change (fetch its CSV, parse with its
name), not a code change.

## seasonScale.js

`seasonFraction(i, last)` is the **one** date→x-position mapping in the
whole app. The bar's own season chart and month axis (`main.js`) and every
figure in the plates drawer (`plates.js`) all have to agree on where a
given record index sits along the x-axis, or the timeline's cursor reads
against one curve and lies about the rest (see the alignment note in
`index.html` and `style.css`'s `#season-chart`/`#timeline-axis` margin
rule). This function is the single source of truth for that — everything
else just picks its own output width. Anything that draws against the
season's x-axis must compute through it rather than deriving its own
`i / last`.

## See also

- Root `CLAUDE.md` — "Rules that hold everywhere" restates the
  `seasonFraction`/live-binding/species-split rules that cut across every
  file in this doc.
- `.claude/context/plates.md` — the drawer that is the single biggest
  consumer of `seasonFraction`, `loadRiverConditions`, and `loadRunHistory`.
- `.claude/context/main.md` — `rebuildForYear()`, the other rebuild hook
  `loadYear()`'s live bindings depend on.
