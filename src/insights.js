// insights.js
// One shared "insight" toast, the small info buttons that open it, and the
// localStorage-backed cache that keeps each one from being recomputed.
// Design rationale, invariants, gotchas: .claude/context/insights.md
let toastEl = null;
let bodyEl = null;
let activeBtn = null;
let hideTimer = null;

const AUTO_HIDE_MS = 20000;

// Builds the toast once and appends it to <body> (not #app) so it paints
// above both pages' chrome regardless of which one calls this — see the doc.
export function initInsightToast() {
  if (toastEl) return;

  toastEl = document.createElement("div");
  toastEl.id = "insight-toast";
  toastEl.setAttribute("role", "status");
  toastEl.hidden = true;

  bodyEl = document.createElement("p");
  toastEl.appendChild(bodyEl);

  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "insight-toast-close";
  closeBtn.textContent = "✕";
  closeBtn.setAttribute("aria-label", "Dismiss");
  closeBtn.addEventListener("click", hideInsight);
  toastEl.appendChild(closeBtn);

  document.body.appendChild(toastEl);

  // Hovering (or focusing into) the toast holds the auto-hide off entirely —
  // a viewer who's still reading, or has tabbed onto the close button,
  // shouldn't have it vanish under them mid-sentence. Leaving restarts the
  // full countdown rather than resuming a partial one; simpler, and a viewer
  // who just moved their mouse off it is still mid-read either way.
  toastEl.addEventListener("pointerenter", () => clearTimeout(hideTimer));
  toastEl.addEventListener("pointerleave", () => {
    if (activeBtn) hideTimer = setTimeout(hideInsight, AUTO_HIDE_MS);
  });
  toastEl.addEventListener("focusin", () => clearTimeout(hideTimer));
  toastEl.addEventListener("focusout", () => {
    if (activeBtn) hideTimer = setTimeout(hideInsight, AUTO_HIDE_MS);
  });

  // Escape and a click outside both dismiss, same convention the plates
  // drawer's own toggle uses (see .claude/context/plates.md). A click on
  // any .info-btn is excluded here since that button's own handler already
  // decides what happens next (reopen with new content, or close) —
  // without the exclusion, switching between two open insights would
  // close-then-reopen across two events instead of just updating in place.
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && activeBtn) hideInsight();
  });
  document.addEventListener(
    "pointerdown",
    (e) => {
      if (!activeBtn) return;
      if (toastEl.contains(e.target)) return;
      if (e.target.closest && e.target.closest(".info-btn")) return;
      hideInsight();
    },
    true,
  );
}

function showInsight(text, btn) {
  clearTimeout(hideTimer);
  if (activeBtn === btn) {
    hideInsight();
    return;
  }
  if (activeBtn) activeBtn.setAttribute("aria-pressed", "false");
  activeBtn = btn;
  btn.setAttribute("aria-pressed", "true");
  bodyEl.textContent = text;
  toastEl.hidden = false;
  // Forces a reflow so the entrance transition runs even when the toast was
  // already hidden a moment ago — same trick showNotice() uses in main.js.
  void toastEl.offsetWidth;
  toastEl.classList.add("shown");
  hideTimer = setTimeout(hideInsight, AUTO_HIDE_MS);
}

function hideInsight() {
  clearTimeout(hideTimer);
  toastEl.classList.remove("shown");
  if (activeBtn) {
    activeBtn.setAttribute("aria-pressed", "false");
    activeBtn = null;
  }
  // Deferred re-hide, not transitionend — a backgrounded tab or reduced
  // motion can mean that event never fires (same reasoning as hideNotice()
  // in main.js).
  setTimeout(() => {
    if (!toastEl.classList.contains("shown")) toastEl.hidden = true;
  }, 260);
}

// ---------------------------------------------------------------------
// Insight cache — a growing "database" of already-written insights, keyed
// by the section and timeframe they describe (e.g. "passage:2015:2015-03-06"
// or "season-card:steelhead:2015"). There's no backend to hold this (see the
// root CLAUDE.md), so the document is a single JSON blob in localStorage:
// generated once per key, on demand, the first time a viewer actually asks
// for it, then reused forever after instead of recomputed. See the doc for
// why this is safe — every key names a fact about a finished day, which
// never changes once counted.
// ---------------------------------------------------------------------
const STORE_KEY = "salmon-insights-v1";
let store = null;

function loadStore() {
  if (store) return store;
  store = new Map();
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) {
      for (const [key, text] of Object.entries(JSON.parse(raw))) {
        store.set(key, text);
      }
    }
  } catch {
    // Private browsing, a full quota, or corrupt JSON — start empty rather
    // than fail. This is a cache, not a data source; every entry is always
    // regenerable from the getText that would have supplied it.
  }
  return store;
}

function persistStore() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(Object.fromEntries(store)));
  } catch {
    // Storage unavailable or full — the cache still works for the rest of
    // this session (the in-memory Map is untouched), it just won't survive
    // a reload.
  }
}

function resolveInsight(key, getText) {
  const cache = loadStore();
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  const text = typeof getText === "function" ? getText() : getText;
  cache.set(key, text);
  persistStore();
  return text;
}

// key may be a string or a function returning one, evaluated at click time
// just like getText — most call sites need a fresh key (today's date, the
// selected species) rather than whatever was current when the button was
// built. getText only ever runs on a cache miss; a hit skips it entirely.
export function createInfoButton(key, getText, label) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "info-btn";
  btn.textContent = "i";
  btn.setAttribute("aria-pressed", "false");
  btn.setAttribute(
    "aria-label",
    label ? `What does ${label} mean?` : "What does this mean?",
  );
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    const resolvedKey = typeof key === "function" ? key() : key;
    const text = resolveInsight(resolvedKey, getText);
    showInsight(text, btn);
  });
  return btn;
}
