# `src/drawer.js` — shared slide-in drawer

`createDrawer({ panel, toggle, closeButton, shortcutKey, onOpen })` is the
open/close/keyboard-state machine behind two visually-identical but
content-unrelated panels: the river's `#plates` (`plates.js`, six data
figures) and the fish viewer's `#inspect-panel` (`inspect.js`, one species'
field notes). Their *content* has nothing in common — this module exists
because their *chrome and behavior* used to be two independent, near-
identical copies of the same dozen lines (toggle a class, flip
`aria-pressed`, swap the button label, close on Escape, focus the toggle
back). They hadn't actually drifted yet, but there was nothing stopping the
next edit to one from missing the other; one implementation now backs both,
so there's only one place left to get it right.

## What it owns vs. what it doesn't

`createDrawer` owns exactly the open/close state machine: the `.open` class
on `panel`, `aria-pressed` on `toggle`, the click listener(s), and the
`keydown` listener (Escape-to-close, plus an opt-in letter shortcut). It
does **not** own layout — that's the shared `#plates, #inspect-panel` CSS
rule in `style.css` (position, z-index, slide transform; see `ui.md`) — and
it does not own content — `plates.js`'s `build()` and `inspect.js`'s
`setSpecies()`/`updateFieldGuide()` fill the panel independently, however
and whenever their own page needs to. It doesn't own `toggle`'s label
either any more: `toggle` is a static "open" button now (plain markup in
`index.html`/`inspect.html`, e.g. "Plates", never "Plates ✕") — closing
moved to `closeButton`, so there's no longer a label to flip between two
states, and the earlier `label` option that built that text is gone from
the signature.

## `closeButton`

Optional — a real DOM child of `panel` (`.drawer-close`, `ui.md`), distinct
from `toggle`. Wired with its own click listener that closes the drawer and
refocuses `toggle`, the same outcome Escape produces. `toggle` itself is
*also* still a genuine toggle under the hood (clicking it while open still
closes — `setOpen(!isOpen)` never changed), so `closeButton` is an
additional, more discoverable way to close, not a replacement for the
toggle's own click handler.

**Every `.focus()` call in this file passes `{ preventScroll: true }`** —
not optional polish. `panel` is mid `transform: translateX(...)` at the
exact moment any of these run (the `.open` class/`aria-pressed` just
changed in the same synchronous tick; the transition hasn't animated
anywhere yet), so a plain `.focus()`'s implicit scroll-into-view sees the
target sitting at the transition's *starting* position — off-screen, for
`closeButton` on open — and shifts `document.body.scrollLeft` to "reveal"
it. Since `#app`'s layout is built to fill the viewport exactly, that
scroll doesn't just move an invisible overflow region — it visibly drags
the whole page (canvas included) left for the ~300ms until the transition
catches up and the browser's own scroll settles back to 0. Caught after
the fact, not designed in from the start: the first version of the
`closeButton`-focus-on-open behavior shipped without it and reproduced
exactly this, `document.body.scrollLeft` measured at 104-170px mid-transition
on the two pages before the fix.

Once a caller passes `closeButton`, opening moves focus to it rather than
leaving focus on `toggle` (also in `setOpen()`) — this module's own half of
a pairing with `style.css`, which hides `#plates-toggle`/`#field-notes-toggle`
once `aria-pressed="true"` (see `ui.md`, "The toggle hides itself once
open"), since a second "open" control sitting right next to a dedicated
close icon just reads as clutter. `createDrawer()` doesn't know that CSS
rule exists — the two ID selectors it's keyed to are specific to today's
two toggles, not a generic class every `createDrawer()` caller gets for
free — so the focus-move here is what actually matters for correctness: a
future caller whose own CSS hides its toggle the same way needs this same
`closeButton`-driven refocus to avoid stranding keyboard focus on an
element that just vanished; one that doesn't hide its toggle just gets a
harmless extra `.focus()` call that moves focus into the panel a beat
earlier than it otherwise would have.

## `onOpen`

The one piece of per-drawer behavior `createDrawer` does thread through:
called every time the drawer transitions to open (not on every render, and
not on close). `plates.js` uses it for lazy-build-on-first-open (`if
(!built) build()`); `inspect.js` doesn't pass one, since field notes are
already current by the time the drawer opens (`setSpecies()` keeps them so
regardless of whether the panel is visible).

## `shortcutKey`

Optional letter shortcut to toggle the drawer from anywhere on the page
(guarded against firing while an `<input>`/`<select>` has focus, and against
any modifier key). Only `plates.js` passes one (`"p"`) — the fish viewer's
field-notes drawer has no keyboard shortcut, so `inspect.js` simply omits
the option rather than the module needing a "disabled" sentinel.

## Escape-key ordering

The `Escape` branch is checked **before** the focused-control guard
(`tag === "INPUT" || tag === "SELECT"`), deliberately: right after opening,
focus sits on `closeButton` (or `toggle`, if no `closeButton` was passed) —
either way a button, same as the guard would otherwise skip — and that's
the single moment a visitor is most likely to reach for Escape.

## Return value

`{ open, close, toggle, isOpen }` — `plates.js`'s `rebuildPlatesForYear()`
reads `drawer.isOpen()` to decide whether a season switch should rebuild the
drawer immediately (open) or just mark it stale for the next open
(`built = false`, closed). `inspect.js` doesn't currently need the returned
handle at all; `createDrawer()`'s own click/keydown wiring is enough.

## See also

- `.claude/context/ui.md` — the shared `#plates`/`#inspect-panel` CSS rule
  in `style.css` (position, z-index-in-front-of-the-bar, slide transform)
  this module's `.open` class drives, and the `#plates-toggle`/
  `#field-notes-toggle` shared button treatment.
- `.claude/context/plates.md` — `plates.js`'s own lazy-build/rebuild
  lifecycle built on top of `onOpen`/`isOpen()`.
- `.claude/context/inspect.md` — where the field-notes drawer's content
  (`updateFieldGuide`) is filled in, independently of open/close state.
