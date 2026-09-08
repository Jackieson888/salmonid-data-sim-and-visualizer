// One shared "insight" toast, its info-button triggers, and a localStorage cache so each is computed once.
let toastEl = null;
let titleEl = null;
let bodyEl = null;
let activeBtn = null;
let hideTimer = null;

const AUTO_HIDE_MS = 20000;

// Appended to <body>, not #app, so it paints above either page's chrome.
export function initInsightToast() {
  if (toastEl) return;

  toastEl = document.createElement("div");
  toastEl.id = "insight-toast";
  toastEl.setAttribute("role", "status");
  toastEl.hidden = true;

  titleEl = document.createElement("p");
  titleEl.className = "insight-toast-title";
  toastEl.appendChild(titleEl);

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

  // Hovering or focusing the toast holds the auto-hide off; leaving restarts the full countdown.
  toastEl.addEventListener("pointerenter", () => clearTimeout(hideTimer));
  toastEl.addEventListener("pointerleave", () => {
    if (activeBtn) hideTimer = setTimeout(hideInsight, AUTO_HIDE_MS);
  });
  toastEl.addEventListener("focusin", () => clearTimeout(hideTimer));
  toastEl.addEventListener("focusout", () => {
    if (activeBtn) hideTimer = setTimeout(hideInsight, AUTO_HIDE_MS);
  });

  // Escape or a click outside dismisses; a click on .info-btn is excluded since its own handler decides.
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

function showInsight(title, text, btn) {
  clearTimeout(hideTimer);
  if (activeBtn === btn) {
    hideInsight();
    return;
  }
  if (activeBtn) activeBtn.setAttribute("aria-pressed", "false");
  activeBtn = btn;
  btn.setAttribute("aria-pressed", "true");
  titleEl.textContent = title || "";
  titleEl.hidden = !title;
  bodyEl.textContent = text;
  toastEl.hidden = false;
  // Forces a reflow so the entrance transition runs even if the toast was just hidden.
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
  // Deferred re-hide, not transitionend — a backgrounded tab or reduced motion can skip that event.
  setTimeout(() => {
    if (!toastEl.classList.contains("shown")) toastEl.hidden = true;
  }, 260);
}

// Insight cache: JSON blob in localStorage, keyed by section+timeframe, generated once per key on first ask.
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
    // Private browsing, a full quota, or corrupt JSON — start empty; every entry is regenerable anyway.
  }
  return store;
}

function persistStore() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(Object.fromEntries(store)));
  } catch {
    // Storage unavailable or full — the in-memory cache still works, it just won't survive a reload.
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

// key/getText may be functions, evaluated at click time so they can depend on then-current state.
export function createInfoButton(key, getText, title) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "btn info-btn";
  btn.textContent = "i";
  btn.setAttribute("aria-pressed", "false");
  btn.setAttribute(
    "aria-label",
    title ? `What does ${title} mean?` : "What does this mean?",
  );
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    const resolvedKey = typeof key === "function" ? key() : key;
    const text = resolveInsight(resolvedKey, getText);
    showInsight(title, text, btn);
  });
  return btn;
}
