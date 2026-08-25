// render-fish-silhouettes.mjs
// Rasterizes each species' real GLB into a flat, transparent-background PNG
// silhouette from a true orthographic side view — what the fish viewer's
// adult-length chart masks its fish shapes from (see buildFishSilhouette in
// src/inspect.js) instead of a hand-drawn approximation. Pre-generated and
// committed to public/silhouettes/, same "fetch once, vendor the result"
// philosophy as scripts/fetch-dart.mjs — nothing in the running app loads
// three.js/GLTFLoader just to draw a length-scale row.
//
// Usage (needs the Vite dev server running — the harness page is served
// through it so it can resolve the "three" import the same way inspect.js
// does):
//   node scripts/render-fish-silhouettes.mjs           # writes the 4 PNGs
//   node scripts/render-fish-silhouettes.mjs --preview  # writes unflipped
//     previews to scripts/_silhouette-preview/ instead, for eyeballing
//     orientation before filling in CORRECTIONS below.

import { chromium } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const SPECIES_MODEL_URL = {
  chinook: "/chinook-final.glb",
  steelhead: "/steelhead-final.glb",
  shad: "/shad-final.glb",
  lamprey: "/lamprey-final.glb",
};

// Per-species orientation fix so every silhouette faces the same way (nose
// right, dorsal up) despite each GLB being authored in whatever local
// orientation it happened to be modeled in. Filled in by rendering with
// --preview first and looking at the result — axis-picking alone can't
// resolve the sign ambiguity (nose could land on either side; dorsal could
// land up or down).
const CORRECTIONS = {
  chinook: { flipX: false, flipY: false },
  steelhead: { flipX: false, flipY: false },
  shad: { flipX: false, flipY: false },
  // lamprey-final.glb's local axes ran the opposite way from the other three
  // GLBs — axis-picking alone can't resolve that sign ambiguity (nothing in
  // the mesh says which end is the head), and it wasn't obvious from a
  // single unflipped preview at a glance either since an eel-shaped
  // silhouette tapers to a point at both ends. Confirmed by comparing the
  // oral disc's more complex geometry (visible as extra facets near the tip)
  // against where the other three species' equally complex mouth/head
  // geometry landed — that end needed to be on the same side as theirs.
  lamprey: { flipX: true, flipY: false },
};

const preview = process.argv.includes("--preview");
const url = "http://localhost:5173/scripts/silhouette-harness.html";
const outDir = preview
  ? path.resolve("scripts/_silhouette-preview")
  : path.resolve("public/silhouettes");
mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
page.on("pageerror", (err) => console.error("pageerror:", err.message));
page.on("console", (msg) => {
  if (msg.type() === "error") console.error("console error:", msg.text());
});

await page.goto(url, { waitUntil: "load" });
await page.waitForFunction(() => window.__harnessReady === true, { timeout: 15000 });

for (const [species, glbUrl] of Object.entries(SPECIES_MODEL_URL)) {
  const opts = preview ? {} : CORRECTIONS[species];
  const result = await page.evaluate(
    ([glbUrl, opts]) => window.renderSilhouette(glbUrl, opts),
    [glbUrl, opts],
  );
  const base64 = result.dataUrl.replace(/^data:image\/png;base64,/, "");
  const outPath = path.join(outDir, `${species}.png`);
  writeFileSync(outPath, Buffer.from(base64, "base64"));
  console.log(
    `${species}: ${result.width}x${result.height} ` +
      `(view=${result.axes.viewAxis} height=${result.axes.heightAxis} length=${result.axes.lengthAxis}, ` +
      `size=${result.size.x.toFixed(2)},${result.size.y.toFixed(2)},${result.size.z.toFixed(2)}) -> ${outPath}`,
  );
}

await browser.close();
