import { chromium } from "playwright";

const url = process.argv[2] || "http://localhost:5181";
const browser = await chromium.launch({ args: ["--no-sandbox"] });
const page = await browser.newPage({
  viewport: { width: 1600, height: 1000 },
  deviceScaleFactor: 1.5,
});

const errors = [];
page.on("console", (msg) => {
  if (msg.type() === "error") errors.push(msg.text());
});
page.on("pageerror", (err) => errors.push("pageerror: " + err.message));

await page.goto(url, { waitUntil: "load" });
await page.waitForTimeout(9000);

await page.evaluate(() => {
  document.body.style.filter = "brightness(2.2) contrast(1.15)";
});

const screenshotDir = "C:\\Users\\jscha\\AppData\\Local\\Temp\\claude\\c--Users-jscha-salmon-population-visualizer\\10369c79-e817-43cf-926c-500d3c673bc3\\scratchpad";
await page.screenshot({ path: `${screenshotDir}\\depthfog-check.png` });

console.log("CONSOLE_ERRORS:", JSON.stringify(errors, null, 2));
await browser.close();
