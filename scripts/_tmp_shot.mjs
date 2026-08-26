import { chromium } from "playwright";
const mode = process.argv[2]; // "mobile" or "desktop"
const outPath = process.argv[3];
const width = mode === "mobile" ? 393 : 1600;
const height = mode === "mobile" ? 852 : 1000;
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 2 });
const errors = [];
page.on("console", (msg) => { if (msg.type() === "error") errors.push(msg.text()); });
page.on("pageerror", (err) => errors.push("pageerror: " + err.message));
await page.goto("http://localhost:5175", { waitUntil: "load" });
await page.waitForSelector("#fish-loading", { state: "detached", timeout: 30000 }).catch(() => {});
await page.locator("#timeline").evaluate((el, v) => { el.value = String(v); el.dispatchEvent(new Event("input", { bubbles: true })); }, 63);
const label = (await page.locator("#play-pause").textContent()).trim();
if (label === "Play") await page.locator("#play-pause").click();
if (mode === "mobile") {
  const collapsed = await page.locator("#report").evaluate((el) => el.classList.contains("collapsed"));
  if (collapsed) await page.locator("#report-toggle").click();
}
await page.waitForTimeout(2500);
await page.screenshot({ path: outPath });
console.log("CONSOLE_ERRORS:", JSON.stringify(errors, null, 2));
await browser.close();
