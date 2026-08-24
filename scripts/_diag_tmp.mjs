import { chromium } from "playwright";

const outDir = process.argv[2];
const browser = await chromium.launch({ args: ["--no-sandbox"] });
const page = await browser.newPage({
  viewport: { width: 1600, height: 1000 },
  deviceScaleFactor: 1.5,
});
const errors = [];
page.on("console", (msg) => { if (msg.type() === "error") errors.push(msg.text()); });
page.on("pageerror", (err) => errors.push("pageerror: " + err.message));

await page.goto("http://localhost:5175/?quality=high", { waitUntil: "load" });
await page.waitForSelector("#fish-loading", { state: "detached", timeout: 30000 }).catch(() => {});

await page.locator("#timeline").evaluate((el, v) => {
  el.value = String(v);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}, 250);

await page.waitForTimeout(3000);
await page.locator("#play-pause").click();

for (let i = 0; i < 6; i++) {
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${outDir}/burst_${i}.png` });
}

console.log("CONSOLE_ERRORS:", JSON.stringify(errors, null, 2));

await page.close();
await browser.close();
