// screenshot.mjs
// Drives the running dev server in headless Chromium and captures one frame,
// reporting any console errors / uncaught exceptions along the way.
//
// This scene has no test suite, and its failure mode is quiet: a GLSL compile
// error doesn't throw, it just makes one surface stop drawing. So the console
// check below matters as much as the image — THREE logs shader compile
// failures as console errors, which is the only automatic signal we get.
//
// Usage:
//   node scripts/screenshot.mjs <out.png> [--url http://localhost:5173]
//     [--day 63] [--width 1600] [--height 1000] [--wait 9000] [--brighten]
//
// --day scrubs the timeline slider to that index before capturing (the run's
// interesting days are well past 0); --brighten applies a CSS filter, since
// the scene is deliberately dark and detail is hard to compare at true
// exposure.

import { chromium } from "playwright";

const args = process.argv.slice(2);
const outPath = args.find((a) => !a.startsWith("--"));
if (!outPath) {
  console.error("usage: node scripts/screenshot.mjs <out.png> [--url ...]");
  process.exit(1);
}

const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : args[i + 1];
};
const has = (name) => args.includes(`--${name}`);

const url = flag("url", "http://localhost:5173");
const width = Number(flag("width", 1600));
const height = Number(flag("height", 1000));
const settleMs = Number(flag("wait", 9000));
const day = flag("day", null);

const browser = await chromium.launch({ args: ["--no-sandbox"] });
const page = await browser.newPage({
  viewport: { width, height },
  deviceScaleFactor: 1.5,
});

const errors = [];
page.on("console", (msg) => {
  if (msg.type() === "error") errors.push(msg.text());
});
page.on("pageerror", (err) => errors.push("pageerror: " + err.message));

await page.goto(url, { waitUntil: "load" });

// The fish overlay fades out once loadFishAssets() resolves (see main.js), so
// this is the real "scene is populated" signal rather than a fixed sleep.
await page
  .waitForSelector("#fish-loading", { state: "detached", timeout: 30000 })
  .catch(() => console.warn("WARN: fish-loading overlay never went away"));

if (day !== null) {
  await page.locator("#timeline").evaluate((el, v) => {
    el.value = String(v);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }, Number(day));
}

// Let the flock settle into the day's population and the water sim build up
// some ripple history before capturing.
await page.waitForTimeout(settleMs);

if (has("brighten")) {
  await page.evaluate(() => {
    document.body.style.filter = "brightness(2.2) contrast(1.15)";
  });
}

await page.screenshot({ path: outPath });
console.log(`wrote ${outPath}`);
console.log("CONSOLE_ERRORS:", JSON.stringify(errors, null, 2));

await browser.close();
process.exit(errors.length > 0 ? 1 : 0);
