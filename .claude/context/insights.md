# `src/insights.js` — the insight toast

A small info button (`.info-btn`, a hairline square carrying "i") that any
page can drop next to a label, and one shared toast (`#insight-toast`) that
opens when it's clicked. The point is a layman's explanation of what a
figure or field actually means, sitting one click away from the number
itself rather than crowding the instrument-panel reading with prose. Used
from three call sites: `main.js` (the HUD's passage/conditions/run-status
fields and the season chart), `plates.js` (all six `FIG.` captions), and
`inspect.js` (the fish viewer's length scale and season card).

## Why a shared module, not three copies

`index.html`/`inspect.html` are two separate entry points with no shared
runtime state (see the root `CLAUDE.md`), but they already share `style.css`
and the "one instrument panel" visual language it encodes. A toast is global
UI, not a per-page concern — a viewer forms one expectation for what
clicking an ⓘ does, and that only holds if it behaves identically wherever
it appears. `initInsightToast()` is idempotent (`if (toastEl) return`)
specifically so both `main.js` and `plates.js` can call it without
coordinating: whichever module's boot sequence runs first wins, and the
other's call is a no-op. `inspect.js` calls it too, independently, for the
same reason on its own page.

## Static vs. dynamic text

`createInfoButton(key, getText, label)` accepts a plain string for content
that's always true (the adipose-fin fact in plates.js's FIG. 3, the
√-scale rationale behind the season chart) and a **function** for anything
that should read live state — today's dominant species, this season's
percent above/below the ten-year mean, whether FIG. 1's ghost line has
finished loading. `getText` runs at click time, not when the button is
built — but only on a cache miss (see below); on a hit it never runs at
all, so a button created once at boot (most of them) still reports
whatever `runData`/`dayIndex`/`lastDayIndex` were current the *first* time
a viewer opened it for that particular key. Closing over module-scope
`let`s this way is the same "read the live binding, don't cache it"
contract `plates.md` and `data.md` already document for `LAST`/`runData` —
an insight function is just another reader of that binding, not a new
exception to it.

`plates.js`'s per-figure insights close over `lastDayIndex` (the plates
drawer's own cursor position, kept in sync by `setPlatesDay()`) rather than
a fresh "today," so composition/species-mix facts describe whatever day the
timeline cursor is actually parked on — consistent with every other
"today" reading in the drawer (`todayUpdaters`), which all read off the same
cursor.

## Placement convention: inside the label, not beside it

Every call site appends the button as a **child of the field's own label
element** (`.field-head .label` in `main.js`/`inspect.js`, `.plate-title`'s
sibling inside `.plate-caption` in `plates.js`) rather than as a fresh flex
child of the row. `.field-head` is `display:flex; justify-content:
space-between`, so a button added as a direct flex child would either get
shoved to the opposite end by that rule (fighting or duplicating whatever
already occupies that slot — the count in `#passage`, `#chart-scale` in the
chart caption) or, worse, sit as its own justified item stranded between the
label and the value with unpredictable spacing. Nesting it inside the label
span keeps it glued to the text it explains regardless of what else is in
the row, and reads as "this label has a footnote," which is the intent.
`plates.js`'s `.plate-caption` doesn't use space-between (only
`.plate-toggle` opts into `margin-left: auto`), so its info button is just
appended as the next flex child after `.plate-title` — it lands immediately
after the title text either way, and doesn't fight FIG. 2's `.plate-toggle`
for the auto-margin slot since it's inserted before that button is added.

## Square, not round

`.info-btn` is a 14px square hairline button, not a circular "i" badge —
the one hard-corners exception this app allows is the species-key swatches
(themselves squares), so a round info icon would be the only rounded
control in the interface. Its `aria-pressed` state doubles as "this is the
currently open insight," styled with the same accent-on-active treatment as
`.plate-toggle.active`/`.speed-btn[aria-pressed="true"]` — the toast can
only ever show one insight at a time, so at most one button is ever lit.

## Toast placement and lifecycle

`#insight-toast` is appended to `<body>`, not `#app`, and fixed top-center —
the same slot `#notice` (`main.js`) uses for a failure message, because this
app's HUD occupies the entire bottom of the viewport on both pages
(`#hud`/`#inspect-bar`), so a bottom-anchored "snackbar" would land on top
of the very numbers it's explaining. Appending to `<body>` rather than
`#app` is what lets one toast instance serve `plates.js`'s drawer (a sibling
of `#app`'s own content, `z-index: 1`) and `inspect.js`'s panel without
worrying about which page's stacking context it needs to escape — `z-index:
3` on the toast itself is enough since `#app` never establishes its own
stacking context (`position: relative` with no `z-index`), so every
positioned element in this app already competes in one flat root-level
order.

Show/hide follows the same three-part convention `showNotice()`/
`hideNotice()` (`main.js`) already established: unhide, force a reflow
(`void toastEl.offsetWidth`) so the entrance transition doesn't get
coalesced away, then add `.shown`; hiding removes `.shown` and defers the
actual `hidden = true` by a fixed timeout rather than trusting
`transitionend`, which a backgrounded tab or `prefers-reduced-motion` can
skip entirely.

Escape and an outside click both dismiss, matching the plates drawer's own
keyboard convention (`plates.md`). The outside-click listener explicitly
excludes clicks on *any* `.info-btn`, not just the currently active one —
without that, clicking a second insight button while the first's toast is
open would fire the outside-close handler before that button's own click
handler ran, producing a visible close-then-reopen instead of the content
just swapping in place. `showInsight()` handles the actual button-to-button
handoff: a click on the already-active button toggles it closed; a click on
a different one swaps `bodyEl.textContent` and re-points `activeBtn` without
ever setting `hidden` in between.

`AUTO_HIDE_MS = 20000` auto-dismisses an unread toast rather than leaving it
open indefinitely, but a `pointerenter`/`focusin` pair on `#insight-toast`
suspends that timer entirely for as long as a viewer is actually hovering
or has focus inside it (the close button is focusable), restarting the full
20s only once they leave — so "long enough to read two or three sentences"
never has to be guessed correctly up front; a slower reader or someone who
tabbed onto the close button just keeps it open.

## The insight cache — a growing "document," not a database file

There's no backend (root `CLAUDE.md`), so "a document to hold the different
insights" can't be a server-side store a write ever reaches — it's a single
JSON blob in `localStorage` (`STORE_KEY = "salmon-insights-v1"`), built up
one entry at a time as a viewer actually opens things, never pre-populated.
`resolveInsight(key, getText)` is the whole mechanism: look the key up in
the in-memory `Map` (itself lazily hydrated from `localStorage` on first
use, see `loadStore()`); on a hit, hand back the cached string without ever
calling `getText`; on a miss, call it once, store the result both in memory
and back to `localStorage` (`persistStore()`), and hand it back. Every
`createInfoButton` caller supplies both a `key` (string or, like `getText`,
a function evaluated at click time) and a `getText` — the two are separate
parameters, not folded into one, because the key has to be computable
*before* deciding whether `getText` even needs to run.

**Why caching a fact computed from a plain JS template string is worth
doing at all:** it isn't about CPU cost — string interpolation is free.
It's the architecture the user asked for: a key scheme
(`section:year:date`, e.g. `passage:2015:2015-03-06`, or
`season-card:steelhead:2015`) that treats each insight as a fact about a
*finished* day, which — unlike the live DART feed for the current in-progress
season — never changes once counted. That's what makes caching safe rather
than a staleness bug: two visits to the same key are guaranteed to want the
same answer, so "already generated, just show it" is always correct, never
a shortcut that risks showing last visit's numbers for a day whose real
count has since updated. It also leaves the door open for a future,
genuinely expensive `getText` (a real generated-on-first-view insight)
without changing a single call site — the cache doesn't know or care
whether `getText` was cheap.

**Key granularity is deliberate per site.** FIG. 1's key is
`fig1:loaded`/`fig1:loading` — two cache entries for two genuinely
different facts, not one that would freeze on whichever text won the race
to be cached first. FIG. 3/4/5/6 have no per-day dependency at all, so
their key defaults to `figureShell`'s own `num` (`"FIG. 3"` etc.) — one
entry, ever, per figure. The HUD's passage/conditions/run-status and
plates.js's FIG. 2 key off `${runYear}:${date}` because their text quotes
that day's actual numbers. `inspect.js`'s season-card key
(`` `season-card:${species}:${runYear}` ``) is a plain string, not a
function, because `updateSeasonCard()` already rebuilds the whole card
(and this button) fresh on every species switch — there's no stale-closure
risk to guard against the way there is for a button built once at boot.

**Failure handling.** `loadStore()`/`persistStore()` both swallow
exceptions (private browsing, a full quota, corrupt JSON) and fall back to
an empty or in-memory-only store — this is explicitly *not* the "no
synthetic data fallback" rule from the root `CLAUDE.md`; that rule protects
the DART measurement record, and this cache holds none of it. Losing the
cache just means `getText` runs again next time, exactly as it did before
caching existed.

## See also

- Root `CLAUDE.md` — the two-entry-point/no-backend split this module's
  "shared but independently booted" design works within.
- `.claude/context/main.md` — `showNotice()`/`hideNotice()`, the entrance/
  exit convention this toast's show/hide mirrors; `dayIndex`/`runData` as
  the live bindings the HUD's insight functions read.
- `.claude/context/plates.md` — `LAST`/`lastDayIndex` as live bindings,
  the Escape-key convention this toast's dismissal matches, and
  `figureShell()`'s `insightText` parameter.
- `.claude/context/inspect.md` — `SPECIES_FIELD_NOTES`, the per-species
  facts this toast deliberately doesn't duplicate (species biology stays in
  the Field Notes panel; the insight toast explains the chart/scale/field
  itself).
- `.claude/context/ui.md` — `#notice`'s top-center placement and z-index
  stacking (`#plates-toggle`/`#plates`) this toast's own positioning is
  pinned against.
