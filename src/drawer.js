// Shared slide-in drawer mechanics used by #plates and #inspect-panel.
export function createDrawer({ panel, toggle, shortcutKey = null, onOpen = null, closeButton = null }) {
  let isOpen = false;

  function setOpen(next) {
    isOpen = next;
    panel.classList.toggle("open", isOpen);
    // toggle self-hides via CSS (aria-pressed) once open; closeButton owns closing.
    toggle.setAttribute("aria-pressed", String(isOpen));
    // preventScroll avoids the page jumping left when focus() scrolls to closeButton mid-transition.
    if (isOpen && closeButton) closeButton.focus({ preventScroll: true });
    if (isOpen && onOpen) onOpen();
  }

  toggle.addEventListener("click", () => setOpen(!isOpen));

  // Icon button inside the panel; closing through it still returns focus to toggle, same as Escape.
  if (closeButton) {
    closeButton.addEventListener("click", () => {
      setOpen(false);
      toggle.focus({ preventScroll: true });
    });
  }

  window.addEventListener("keydown", (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;

    // Checked before the focused-control guard since focus sits on closeButton right after opening.
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
