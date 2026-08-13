import { chromium } from "playwright";

const url = process.argv[2] || "http://localhost:5185";
const browser = await chromium.launch({ args: ["--no-sandbox"] });
const page = await browser.newPage({
  viewport: { width: 1600, height: 1000 },
  deviceScaleFactor: 1.5,
});

await page.goto(url, { waitUntil: "load" });
await page.waitForTimeout(3000);

const slider = page.locator("#timeline");
await slider.evaluate((el, v) => {
  el.value = String(v);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}, 63);

await page.waitForTimeout(4000);

// Zoom in hard by scrolling over the canvas, centered where the school
// clusters (roughly upper-middle of frame based on prior screenshots).
const canvas = page.locator("#river-canvas");
const box = await canvas.boundingBox();
const cx = box.x + box.width * 0.82;
const cy = box.y + box.height * 0.32;
await page.mouse.move(cx, cy);
for (let i = 0; i < 25; i++) {
  await page.mouse.wheel(0, -120);
  await page.waitForTimeout(30);
}
await page.waitForTimeout(1500);

await page.evaluate(() => {
  document.body.style.filter = "brightness(2.4) contrast(1.15)";
});

const screenshotDir =
  "C:\\Users\\jscha\\AppData\\Local\\Temp\\claude\\c--Users-jscha-salmon-population-visualizer\\7fbab047-cd6f-41b2-aa1a-d88270a0c6a8\\scratchpad";
await page.screenshot({ path: `${screenshotDir}\\chinook-orient.png` });

await browser.close();
