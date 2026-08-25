// plates.js
// The slide-in drawer of data plates the bar itself has no room for. Built
// lazily on first open, not at boot.
// Design rationale, invariants, gotchas: .claude/context/plates.md
import {
  runData,
  runYear,
  runDataSource,
  loadRiverConditions,
  loadRunHistory,
} from "./data.js";
import { seasonFraction } from "./seasonScale.js";
import { dayOfYear } from "./scene/season.js";

const SVG_NS = "http://www.w3.org/2000/svg";
const VIEW_W = 1000;

// Last record index of the CURRENT season — a `let` because runData swaps underneath this module (see plates.md).
let LAST = runData.length - 1;

function syncYear() {
  LAST = runData.length - 1;
}

// The eight DART counts at LWG that have a color; shared order everywhere a plate stacks or lists them.
const ALL_SPECIES = [
  { key: "chinook", label: "Chinook", swum: true },
  { key: "jackChinook", label: "Jack Chinook", swum: true },
  { key: "steelhead", label: "Steelhead", swum: true },
  { key: "shad", label: "Shad", swum: true },
  { key: "lamprey", label: "Lamprey", swum: true },
  { key: "sockeye", label: "Sockeye", swum: false },
  { key: "coho", label: "Coho", swum: false },
  { key: "jackCoho", label: "Jack Coho", swum: false },
];

function svgEl(tag, attrs = {}) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const key in attrs) node.setAttribute(key, attrs[key]);
  return node;
}

function el(tag, attrs = {}) {
  const node = document.createElement(tag);
  for (const key in attrs) {
    if (key === "text") node.textContent = attrs[key];
    else node.setAttribute(key, attrs[key]);
  }
  return node;
}

function x(i) {
  return (seasonFraction(i, LAST) * VIEW_W).toFixed(2);
}

// Filled area under a per-day curve. `hasValue` (default: always) lets a gappy series (e.g.
// temperature) break the line instead of bridging it — see buildSeasonChart in main.js.
function areaPath(height, yFor, hasValue = () => true) {
  const d = [];
  let pen = false;
  for (let i = 0; i <= LAST; i++) {
    if (!hasValue(i)) {
      if (pen) d.push(`L ${x(i - 1)} ${height} Z`);
      pen = false;
      continue;
    }
    if (!pen) d.push(`M ${x(i)} ${height}`);
    d.push(`L ${x(i)} ${yFor(i).toFixed(2)}`);
    pen = true;
  }
  if (pen) d.push(`L ${x(LAST)} ${height} Z`);
  return d.join(" ");
}

function linePath(yFor, hasValue = () => true) {
  const d = [];
  let pen = false;
  for (let i = 0; i <= LAST; i++) {
    if (!hasValue(i)) {
      pen = false;
      continue;
    }
    d.push(`${pen ? "L" : "M"} ${x(i)} ${yFor(i).toFixed(2)}`);
    pen = true;
  }
  return d.join(" ");
}

// One filled band per series, stacked bottom to top. `totalFor(i)` is the denominator each day
// scales against — a fixed peak or that day's own sum — so this draws both modes of FIG. 2.
function stackedAreaPaths(height, series, totalFor) {
  const below = new Float64Array(LAST + 1);
  return series.map(({ getValue }) => {
    const top = [];
    const bottom = [];
    for (let i = 0; i <= LAST; i++) {
      const total = totalFor(i) || 1;
      const yBelow = height - (below[i] / total) * height;
      const value = getValue(i);
      const yAbove = height - ((below[i] + value) / total) * height;
      top.push(`${i === 0 ? "M" : "L"} ${x(i)} ${yAbove.toFixed(2)}`);
      bottom.push(`L ${x(i)} ${yBelow.toFixed(2)}`);
      below[i] += value;
    }
    bottom.reverse();
    return `${top.join(" ")} ${bottom.join(" ")} Z`;
  });
}

function dayCursor(svg, cursorSetters) {
  const line = svgEl("line", {
    class: "plate-cursor",
    x1: 0,
    x2: 0,
    y1: 0,
    y2: "100%",
  });
  svg.appendChild(line);
  cursorSetters.push((idx) => {
    const cx = x(idx);
    line.setAttribute("x1", cx);
    line.setAttribute("x2", cx);
  });
}

function figureShell(num, title) {
  const figure = el("figure", { class: "plate" });
  const caption = el("figcaption", { class: "plate-caption" });
  caption.appendChild(el("span", { class: "plate-num", text: num }));
  caption.appendChild(el("span", { class: "plate-title", text: title }));
  figure.appendChild(caption);
  return figure;
}

function plateSvg(extraClass = "") {
  return svgEl("svg", {
    viewBox: `0 0 ${VIEW_W} 200`,
    preserveAspectRatio: "none",
    class: `plate-svg ${extraClass}`.trim(),
  });
}

function note(text) {
  return el("p", { class: "plate-note", text });
}

// FIG. 1 — Season passage, with the 2006-2015 daily mean as a ghost line (see plates.md).
// Returns an `addGhost(history)` hook since run history arrives later than the plate itself.
function buildPassagePlate(cursorSetters) {
  const figure = figureShell("FIG. 1", "Season Passage");
  const svg = plateSvg();

  const counts = runData.map((d) => d.count ?? 0);
  const peak = Math.max(...counts, 1);
  const scaleY = (v) => 200 - Math.sqrt(v / peak) * 200;

  const area = svgEl("path", {
    class: "plate-area",
    "data-series": "passage",
    d: areaPath(200, (i) => scaleY(counts[i])),
  });
  svg.appendChild(area);
  const ghost = svgEl("path", { class: "plate-line plate-line-ghost" });
  svg.appendChild(ghost);
  dayCursor(svg, cursorSetters);

  figure.appendChild(svg);
  const noteEl = note(
    `Daily passage, ${runYear} · √ scale · peak ${peak.toLocaleString()}/day`,
  );
  figure.appendChild(noteEl);

  function addGhost(history) {
    const doyToMean = new Map(history.dailyEnvelope.map((d) => [d.doy, d.mean]));
    // Rescale against whichever peak is larger so the mean line never clips.
    const ghostPeak = Math.max(...doyToMean.values(), 0);
    const combinedPeak = Math.max(peak, ghostPeak, 1);
    const rescale = (v) => 200 - Math.sqrt(v / combinedPeak) * 200;
    area.setAttribute("d", areaPath(200, (i) => rescale(counts[i])));
    ghost.setAttribute(
      "d",
      linePath(
        (i) => rescale(doyToMean.get(dayOfYear(runData[i].date)) ?? 0),
        (i) => doyToMean.has(dayOfYear(runData[i].date)),
      ),
    );
    noteEl.textContent += " · ghost line is the 2006–2015 daily mean";
  }

  return { figure, svg, addGhost };
}

// FIG. 2 — Species composition: all eight DART counts stacked, absolute or 100%, plus today's split.
function buildCompositionPlate(cursorSetters, todayUpdaters) {
  const figure = figureShell("FIG. 2", "Species Composition");
  const svg = plateSvg();

  const series = ALL_SPECIES.map((s) => ({
    ...s,
    getValue: (i) => runData[i][s.key] ?? 0,
  }));

  const dailyTotal = (i) => series.reduce((sum, s) => sum + s.getValue(i), 0);
  const peak = Math.max(...runData.map((_, i) => dailyTotal(i)), 1);

  const paths = series.map((s) =>
    svgEl("path", { class: "plate-area", "data-species": s.key }),
  );
  paths.forEach((p) => svg.appendChild(p));

  let percentMode = false;
  function redraw() {
    const totalFor = percentMode ? dailyTotal : () => peak;
    const d = stackedAreaPaths(200, series, totalFor);
    paths.forEach((p, i) => p.setAttribute("d", d[i]));
  }
  redraw();

  dayCursor(svg, cursorSetters);
  figure.appendChild(svg);

  const toggle = el("button", {
    type: "button",
    class: "plate-toggle",
    text: "100%",
  });
  toggle.addEventListener("click", () => {
    percentMode = !percentMode;
    toggle.classList.toggle("active", percentMode);
    redraw();
  });
  figure.querySelector(".plate-caption").appendChild(toggle);

  // Today's split — a single wide bar, one segment per species, updated
  // every HUD tick the same way the old #secondary-counts rows were.
  const barSvg = svgEl("svg", {
    viewBox: `0 0 ${VIEW_W} 28`,
    preserveAspectRatio: "none",
    class: "plate-svg plate-today-bar",
  });
  const rects = series.map((s) =>
    svgEl("rect", { "data-species": s.key, y: 0, height: 28 }),
  );
  rects.forEach((r) => barSvg.appendChild(r));
  figure.appendChild(barSvg);

  const legend = el("ul", { class: "plate-legend" });
  const legendValues = new Map();
  for (const s of series) {
    const item = el("li", { "data-species": s.key });
    item.appendChild(el("i"));
    item.appendChild(el("span", { class: "plate-legend-label", text: s.label }));
    const value = el("b", { text: "0" });
    item.appendChild(value);
    legend.appendChild(item);
    legendValues.set(s.key, value);
  }
  figure.appendChild(legend);

  todayUpdaters.push((at) => {
    const values = series.map((s) => Math.max(0, at(s.key)));
    const total = values.reduce((a, b) => a + b, 0) || 1;
    let cursor = 0;
    rects.forEach((r, i) => {
      const w = (values[i] / total) * VIEW_W;
      r.setAttribute("x", cursor.toFixed(2));
      r.setAttribute("width", Math.max(0, w).toFixed(2));
      cursor += w;
      legendValues.get(series[i].key).textContent = values[i].toLocaleString();
    });
  });

  figure.appendChild(
    note("Five species swim in the water above; sockeye, coho and jack coho are counted at the dam but not rendered."),
  );
  return figure;
}

// FIG. 3 — Wild vs. hatchery steelhead. wildSteelhead is a subset of steelhead, not an addition (see data.js).
function buildSteelheadPlate(cursorSetters, todayUpdaters) {
  const figure = figureShell("FIG. 3", "Wild vs. Hatchery Steelhead");
  const svg = plateSvg();

  const hasSteelhead = (i) => (runData[i].steelhead ?? 0) > 0;
  const wildShare = (i) =>
    Math.max(0, Math.min(1, (runData[i].wildSteelhead ?? 0) / runData[i].steelhead));

  const area = svgEl("path", {
    class: "plate-area",
    "data-species": "steelhead",
    d: areaPath(200, (i) => 200 - wildShare(i) * 200, hasSteelhead),
  });
  svg.appendChild(area);
  dayCursor(svg, cursorSetters);
  figure.appendChild(svg);

  const readout = el("p", { class: "plate-fact" });
  const wildEl = el("b", { text: "—" });
  const hatcheryEl = el("b", { text: "—" });
  readout.appendChild(el("span", { class: "label", text: "Today, wild" }));
  readout.appendChild(wildEl);
  readout.appendChild(el("span", { class: "label", text: "Hatchery (est.)" }));
  readout.appendChild(hatcheryEl);
  figure.appendChild(readout);

  todayUpdaters.push((at) => {
    const total = Math.max(0, at("steelhead"));
    const wild = Math.max(0, Math.min(total, at("wildSteelhead")));
    wildEl.textContent = wild.toLocaleString();
    hatcheryEl.textContent = (total - wild).toLocaleString();
  });

  figure.appendChild(
    note(
      "Wild fish carry an intact adipose fin; hatchery fish have it clipped before release " +
        "— the same fin marked on the anatomy plate in the fish viewer.",
    ),
  );
  return figure;
}

// FIG. 4 — River conditions. Needs a network round trip; caller shows a placeholder until it resolves.
function buildConditionsPlate(cursorSetters, rows) {
  const figure = figureShell("FIG. 4", "River Conditions");
  const svg = plateSvg();

  const byDate = new Map(rows.map((r) => [r.date, r]));
  const at = (i, field) => byDate.get(runData[i].date)?.[field] ?? null;
  const has = (i, field) => at(i, field) !== null;

  const outflows = runData.map((_, i) => at(i, "outflowKcfs")).filter((v) => v !== null);
  const spills = runData.map((_, i) => at(i, "spillKcfs")).filter((v) => v !== null);
  const flowPeak = Math.max(...outflows, ...spills, 1);
  const flowY = (v) => 200 - (v / flowPeak) * 200;

  const outflowPath = svgEl("path", {
    class: "plate-line",
    "data-field": "outflow",
    d: linePath((i) => flowY(at(i, "outflowKcfs")), (i) => has(i, "outflowKcfs")),
  });
  const spillPath = svgEl("path", {
    class: "plate-line",
    "data-field": "spill",
    d: linePath((i) => flowY(at(i, "spillKcfs")), (i) => has(i, "spillKcfs")),
  });
  svg.appendChild(outflowPath);
  svg.appendChild(spillPath);
  dayCursor(svg, cursorSetters);
  figure.appendChild(svg);

  const legend = el("p", { class: "plate-chart-legend" });
  legend.appendChild(el("span", { class: "key-outflow", text: "Outflow" }));
  legend.appendChild(el("span", { class: "key-spill", text: "Spill" }));
  legend.appendChild(el("span", { text: `0–${flowPeak.toFixed(0)} kcfs` }));
  figure.appendChild(legend);

  // Daily water temperature vs. daily Chinook passage (only when >2 readings exist).
  const points = runData
    .map((d) => ({ temp: d.tempC, chinook: d.chinook ?? 0 }))
    .filter((p) => typeof p.temp === "number");
  if (points.length > 2) {
    const scatter = svgEl("svg", {
      viewBox: "0 0 300 150",
      preserveAspectRatio: "none",
      class: "plate-svg plate-scatter",
    });
    const temps = points.map((p) => p.temp);
    const minT = Math.min(...temps);
    const maxT = Math.max(...temps) || minT + 1;
    const chinookPeak = Math.max(...points.map((p) => p.chinook), 1);
    for (const p of points) {
      const cx = ((p.temp - minT) / (maxT - minT || 1)) * 300;
      const cy = 150 - Math.sqrt(p.chinook / chinookPeak) * 150;
      scatter.appendChild(
        svgEl("circle", { cx: cx.toFixed(1), cy: cy.toFixed(1), r: 2, class: "plate-scatter-dot" }),
      );
    }
    figure.appendChild(scatter);
    figure.appendChild(
      note(`Water temperature vs. daily Chinook count, ${minT.toFixed(1)}–${maxT.toFixed(1)} °C.`),
    );
  }

  figure.appendChild(
    note(
      `Outflow and spill at Lower Granite, ${runYear} (Columbia River DART river environment feed). ` +
        "Dissolved gas and scroll-case temperature are not published for this project.",
    ),
  );
  return figure;
}

// FIG. 5 — Run history, 2006-2015: per-year totals, plus a day-of-year envelope (see plates.md).
function buildHistoryPlate(cursorSetters, history) {
  const figure = figureShell("FIG. 5", "Run History, 2006–2015");

  // (a) Per-year stacked totals — the season on screen gets the accent border, others the neutral hairline.
  const barSvg = svgEl("svg", {
    viewBox: `0 0 ${VIEW_W} 160`,
    preserveAspectRatio: "none",
    class: "plate-svg plate-history-bars",
  });
  const years = history.seasonTotals;
  const yearPeak = Math.max(...years.map((y) => y.count), 1);
  const slot = VIEW_W / years.length;
  const barW = slot * 0.62;
  years.forEach((y, idx) => {
    const cx = idx * slot + (slot - barW) / 2;
    let below = 0;
    for (const s of ALL_SPECIES) {
      const value = y[s.key] ?? 0;
      const h = (value / yearPeak) * 160;
      const rect = svgEl("rect", {
        "data-species": s.key,
        x: cx.toFixed(2),
        y: (160 - below - h).toFixed(2),
        width: barW.toFixed(2),
        height: Math.max(0, h).toFixed(2),
      });
      if (y.year === runYear) rect.setAttribute("class", "plate-history-current");
      barSvg.appendChild(rect);
      below += h;
    }
    barSvg.appendChild(
      svgEl("text", {
        x: (cx + barW / 2).toFixed(2),
        y: 172,
        class:
          y.year === runYear
            ? "plate-history-year plate-history-year-current"
            : "plate-history-year",
        "text-anchor": "middle",
      }),
    );
  });
  // Year labels as text nodes (createElementNS text content isn't set by attrs above).
  [...barSvg.querySelectorAll("text")].forEach((t, i) => {
    t.textContent = String(years[i].year).slice(2);
  });
  figure.appendChild(barSvg);
  figure.appendChild(
    note(`Season totals by species. ${runYear} outlined in red.`),
  );

  // (b) Day-of-year envelope — its x-axis is day-of-year, not record index (see plates.md), so it
  // gets its own cursor setter rather than sharing the seasonFraction() one the rest of the drawer uses.
  const envelope = history.dailyEnvelope;
  const doyMin = envelope[0].doy;
  const doyMax = envelope[envelope.length - 1].doy;
  const doySpan = Math.max(1, doyMax - doyMin);
  const envPeak = Math.max(...envelope.map((d) => d.max), 1);
  const ex = (doy) => (((doy - doyMin) / doySpan) * VIEW_W).toFixed(2);
  const ey = (v) => (200 - Math.sqrt(v / envPeak) * 200).toFixed(2);

  const envSvg = plateSvg("plate-envelope");
  const band = [`M ${ex(envelope[0].doy)} ${ey(envelope[0].max)}`];
  for (const d of envelope) band.push(`L ${ex(d.doy)} ${ey(d.max)}`);
  for (let i = envelope.length - 1; i >= 0; i--) band.push(`L ${ex(envelope[i].doy)} ${ey(envelope[i].min)}`);
  band.push("Z");
  envSvg.appendChild(svgEl("path", { class: "plate-envelope-band", d: band.join(" ") }));

  // Built by hand rather than via linePath() — that helper's x-positions are record-index, not day-of-year.
  const doyToCount = new Map(runData.map((d) => [dayOfYear(d.date), d.count ?? 0]));
  const trace = [];
  let pen = false;
  for (let i = 0; i <= LAST; i++) {
    const doy = dayOfYear(runData[i].date);
    if (!doyToCount.has(doy)) {
      pen = false;
      continue;
    }
    trace.push(`${pen ? "L" : "M"} ${ex(doy)} ${ey(doyToCount.get(doy))}`);
    pen = true;
  }
  envSvg.appendChild(svgEl("path", { class: "plate-line plate-envelope-trace", d: trace.join(" ") }));

  const envCursor = svgEl("line", { class: "plate-cursor", x1: 0, x2: 0, y1: 0, y2: "100%" });
  envSvg.appendChild(envCursor);
  cursorSetters.push((idx) => {
    const doy = dayOfYear(runData[idx].date);
    const cx = ex(doy);
    envCursor.setAttribute("x1", cx);
    envCursor.setAttribute("x2", cx);
  });

  figure.appendChild(envSvg);
  figure.appendChild(
    note(
      `Day-of-year range across all ten years (min–max band), ${runYear}'s own daily count traced through it. √ scale, peak ${envPeak.toLocaleString()}/day.`,
    ),
  );

  return figure;
}

// FIG. 6 — Lamprey, day vs. night: lamprey pass mostly after dark, salmonids don't (see data.md).
function buildLampreyPlate(cursorSetters) {
  const figure = figureShell("FIG. 6", "Lamprey, Day vs. Night");
  const svg = svgEl("svg", {
    viewBox: `0 0 ${VIEW_W} 90`,
    preserveAspectRatio: "none",
    class: "plate-svg plate-svg-compact",
  });

  const peak = Math.max(...runData.map((d) => Math.max(d.lampreyDay ?? 0, d.lampreyNight ?? 0)), 1);
  const y = (v) => 90 - (v / peak) * 90;
  const hasAny = (i) => (runData[i].lampreyDay ?? 0) + (runData[i].lampreyNight ?? 0) > 0;

  svg.appendChild(
    svgEl("path", {
      class: "plate-line plate-lamprey-day",
      d: linePath((i) => y(runData[i].lampreyDay ?? 0), hasAny),
    }),
  );
  svg.appendChild(
    svgEl("path", {
      class: "plate-line plate-lamprey-night",
      d: linePath((i) => y(runData[i].lampreyNight ?? 0), hasAny),
    }),
  );
  dayCursor(svg, cursorSetters);
  figure.appendChild(svg);

  const totalDay = runData.reduce((sum, d) => sum + (d.lampreyDay ?? 0), 0);
  const totalNight = runData.reduce((sum, d) => sum + (d.lampreyNight ?? 0), 0);
  const ratio = totalDay > 0 ? (totalNight / totalDay).toFixed(1) : "—";
  figure.appendChild(
    note(`Season totals: ${totalDay.toLocaleString()} day, ${totalNight.toLocaleString()} night — roughly ${ratio}:1.`),
  );
  return figure;
}

function buildTitleBlock() {
  const block = el("div", { id: "plates-titleblock" });
  const rows = [
    ["Project", "Lower Granite Lock & Dam"],
    ["Season", `${runYear} · ${runData.length} days counted`],
    ["Source", runDataSource === "live" ? "Live DART query" : "Vendored snapshot"],
    ["Retrieved", "2026-08-24"],
    ["Scale", "√ passage · linear conditions"],
  ];
  for (const [label, value] of rows) {
    const row = el("p");
    row.appendChild(el("span", { class: "label", text: label }));
    row.appendChild(el("b", { text: value }));
    block.appendChild(row);
  }
  return block;
}

function loadingPlate(num, title) {
  const figure = figureShell(num, title);
  figure.appendChild(note("Loading…"));
  return figure;
}

function unavailablePlate(num, title) {
  const figure = figureShell(num, title);
  figure.appendChild(note("Data unavailable."));
  return figure;
}

// ---------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------
let toggleBtn = null;
let asideEl = null;
let scrollEl = null;
let isOpen = false;
let built = false;

let cursorSetters = [];
let todayUpdaters = [];
let lastDayIndex = 0;
let lastAt = null;

export function initPlates() {
  toggleBtn = document.getElementById("plates-toggle");
  asideEl = document.getElementById("plates");
  scrollEl = document.getElementById("plates-scroll");
  if (!toggleBtn || !asideEl || !scrollEl) return;

  toggleBtn.addEventListener("click", () => setOpen(!isOpen));

  window.addEventListener("keydown", (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;

    // Escape is checked BEFORE the focused-control guard, deliberately — see plates.md.
    if (e.key === "Escape" && isOpen) {
      e.preventDefault();
      setOpen(false);
      toggleBtn.focus();
      return;
    }

    const tag = e.target.tagName;
    if (tag === "INPUT" || tag === "SELECT") return;

    if (e.key.toLowerCase() !== "p") return;
    e.preventDefault();
    setOpen(!isOpen);
  });
}

function setOpen(next) {
  isOpen = next;
  asideEl.classList.toggle("open", isOpen);
  toggleBtn.setAttribute("aria-pressed", String(isOpen));
  toggleBtn.textContent = isOpen ? "Plates ✕" : "Plates";
  if (isOpen && !built) build();
}

// Incremented on every build; the two async plates below drop their result if it has moved on (see plates.md).
let buildToken = 0;

function build() {
  built = true;
  const token = ++buildToken;
  const year = runYear;
  cursorSetters = [];
  todayUpdaters = [];
  scrollEl.innerHTML = "";

  const passage = buildPassagePlate(cursorSetters);
  scrollEl.appendChild(passage.figure);
  scrollEl.appendChild(buildCompositionPlate(cursorSetters, todayUpdaters));
  scrollEl.appendChild(buildSteelheadPlate(cursorSetters, todayUpdaters));

  const conditionsPlaceholder = loadingPlate("FIG. 4", "River Conditions");
  scrollEl.appendChild(conditionsPlaceholder);
  const historyPlaceholder = loadingPlate("FIG. 5", "Run History, 2006–2015");
  scrollEl.appendChild(historyPlaceholder);

  scrollEl.appendChild(buildLampreyPlate(cursorSetters));
  scrollEl.appendChild(buildTitleBlock());

  loadRiverConditions(year)
    .then((rows) => {
      if (token !== buildToken) return;
      conditionsPlaceholder.replaceWith(buildConditionsPlate(cursorSetters, rows));
      setPlatesDay(lastDayIndex);
    })
    .catch((err) => {
      if (token !== buildToken) return;
      console.warn(`River conditions plate unavailable for ${year}:`, err);
      // Names the missing year rather than a bare "unavailable" (see plates.md).
      const missing = unavailablePlate("FIG. 4", "River Conditions");
      missing.querySelector(".plate-note").textContent =
        `No river-environment record vendored for ${year}. ` +
        `Outflow, spill and dissolved gas are available for 2015.`;
      conditionsPlaceholder.replaceWith(missing);
    });

  loadRunHistory()
    .then((history) => {
      if (token !== buildToken) return;
      passage.addGhost(history);
      historyPlaceholder.replaceWith(buildHistoryPlate(cursorSetters, history));
      setPlatesDay(lastDayIndex);
    })
    .catch((err) => {
      if (token !== buildToken) return;
      console.warn("Run history plate unavailable:", err);
      historyPlaceholder.replaceWith(unavailablePlate("FIG. 5", "Run History, 2006–2015"));
    });

  setPlatesDay(lastDayIndex);
  if (lastAt) updatePlatesToday(lastAt);
}

// Called from main.js's setYear(). Rebuilds immediately if open; deferred (lazy) if closed — see plates.md.
export function rebuildPlatesForYear() {
  syncYear();
  if (!scrollEl) return;
  if (isOpen) build();
  else built = false;
}

export function setPlatesDay(idx) {
  lastDayIndex = idx;
  for (const setter of cursorSetters) setter(idx);
}

export function updatePlatesToday(at) {
  lastAt = at;
  for (const updater of todayUpdaters) updater(at);
}
