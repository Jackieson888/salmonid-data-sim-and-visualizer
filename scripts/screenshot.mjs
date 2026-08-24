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
//     [--burst N] [--headless]
//
// --day scrubs the timeline slider to that index before capturing (the run's
// interesting days are well past 0); --brighten applies a CSS filter, since
// the scene is deliberately dark and detail is hard to compare at true
// exposure. --burst N writes N frames spaced across the settle window as
// out.0.png, out.1.png, … instead of one file, which is how you catch the
// defects that only exist in MOTION — a species' paint order flipping, a fish
// popping at the cull band, a tailbeat desyncing from travel. A still frame
// of any of those looks perfectly fine.
//
// Runs HEADED by default, which is not a preference. Headless Chromium decides
// the page isn't visible and throttles requestAnimationFrame to about 1Hz, so
// the settle window below bought roughly nine simulation frames rather than
// nine seconds' worth — captures were of a scene that had never actually
// filled in or settled, and nothing said so. --headless is kept for CI, where
// a still of an unsettled scene is still enough to catch a shader that has
// stopped drawing.

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
const burst = Number(flag("burst", 0));

const browser = await chromium.launch({
  headless: has("headless"),
  args: [
    "--no-sandbox",
    "--disable-background-timer-throttling",
    "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding",
  ],
});
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

  // Scrubbing the timeline pauses playback (see the input handler in main.js),
  // and a paused scene advances nothing: the water sim stops stepping, the
  // caustics pass is gated on isPlaying, and the flock holds the formation it
  // was dropped into. So the settle window below was waiting out a freeze
  // frame. Resume, and let it actually settle.
  const label = (await page.locator("#play-pause").textContent()).trim();
  if (label === "Play") await page.locator("#play-pause").click();
}

const brighten = async () => {
  if (!has("brighten")) return;
  await page.evaluate(() => {
    document.body.style.filter = "brightness(2.2) contrast(1.15)";
  });
};

if (burst > 0) {
  // Spread the captures across the same settle window a single shot would
  // have waited out, so the series covers real elapsed motion rather than N
  // frames from one instant.
  await page.waitForTimeout(settleMs);
  await brighten();
  const gap = Math.max(100, Math.round(settleMs / burst));
  const ext = outPath.match(/\.[a-z]+$/i)?.[0] ?? ".png";
  const stem = outPath.slice(0, outPath.length - ext.length);
  for (let i = 0; i < burst; i++) {
    await page.screenshot({ path: `${stem}.${i}${ext}` });
    if (i < burst - 1) await page.waitForTimeout(gap);
  }
  console.log(`wrote ${burst} frames: ${stem}.0${ext} … ${stem}.${burst - 1}${ext}`);
} else {
  // Let the flock settle into the day's population and the water sim build up
  // some ripple history before capturing.
  await page.waitForTimeout(settleMs);
  await brighten();
  await page.screenshot({ path: outPath });
  console.log(`wrote ${outPath}`);
}
console.log("CONSOLE_ERRORS:", JSON.stringify(errors, null, 2));

await browser.close();
process.exit(errors.length > 0 ? 1 : 0);
