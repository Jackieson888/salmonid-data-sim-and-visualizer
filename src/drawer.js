// drawer.js — shared slide-in drawer mechanics (open/close, Escape-to-close,
// optional keyboard shortcut, toggle button state) used identically by the
// river's #plates and the fish viewer's #inspect-panel.
// Design rationale, invariants, gotchas: .claude/context/drawer.md
export function createDrawer({ panel, toggle, shortcutKey = null, onOpen = null, closeButton = null }) {
  let isOpen = false;

  function setOpen(next) {
    isOpen = next;
    panel.classList.toggle("open", isOpen);
    // toggle hides itself once this flips true (CSS, keyed off
    // aria-pressed — see ui.md): closeButton now owns closing, and a
    // second "open" control sitting right next to it just reads as
    // clutter. Every caller today passes a closeButton, which is what
    // makes that safe — the focus() below is what stops the CSS-only hide
    // from stranding keyboard focus on an element that just vanished; a
    // future closeButton-less caller would need its own answer to that.
    toggle.setAttribute("aria-pressed", String(isOpen));
    // preventScroll:true on every focus() call in this module — panel is
    // mid-`transform: translateX(...)` at the exact moment this runs (the
    // class just toggled; the transition hasn't animated anywhere yet), so
    // an ordinary focus()'s implicit scroll-into-view sees closeButton
    // sitting off-screen at the transition's *starting* position and
    // shifts document.body.scrollLeft to "reveal" it — the whole page
    // (canvas included) visibly sliding left for the ~300ms until the
    // transition catches up and the browser's own scroll settles back.
    // See .claude/context/ui.md.
    if (isOpen && closeButton) closeButton.focus({ preventScroll: true });
    if (isOpen && onOpen) onOpen();
  }

  toggle.addEventListener("click", () => setOpen(!isOpen));

  // A dedicated icon button living inside the panel itself, distinct from
  // `toggle` (which stays a plain, always-visible "open" trigger — see
  // .claude/context/drawer.md). Closing through it still returns focus to
  // `toggle`, same as Escape does, so keyboard/focus behavior is identical
  // no matter which control closed the drawer.
  if (closeButton) {
    closeButton.addEventListener("click", () => {
      setOpen(false);
      toggle.focus({ preventScroll: true });
    });
  }

  window.addEventListener("keydown", (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;

    // Escape is checked BEFORE the focused-control guard below, deliberately:
    // right after opening, focus sits on closeButton (setOpen(), above) — a
    // button, same as the guard would otherwise skip — and that's the one
    // moment Escape is most likely to be pressed.
    if (e.key === "Escape" && isOpen) {
      e.preventDefault();
      setOpen(false);
      toggle.focus({ preventScroll: true });
      return;
    }

    if (!shortcutKey) return;
    const tag = e.target.tagName;
    if (tag === "INPUT" || tag === "SELECT") return;
    if (e.key.toLowerCase() !== shortcutKey) return;
    e.preventDefault();
    setOpen(!isOpen);
  });

  return {
    open: () => setOpen(true),
    close: () => setOpen(false),
    toggle: () => setOpen(!isOpen),
    isOpen: () => isOpen,
  };
}
