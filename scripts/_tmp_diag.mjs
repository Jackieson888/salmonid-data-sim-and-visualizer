import { chromium } from "playwright";
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 393, height: 852 }, deviceScaleFactor: 2 });
await page.goto("http://localhost:5175", { waitUntil: "load" });
await page.waitForSelector("#fish-loading", { state: "detached", timeout: 30000 }).catch(() => {});
await page.locator("#timeline").evaluate((el, v) => { el.value = String(v); el.dispatchEvent(new Event("input", { bubbles: true })); }, 63);
const label = (await page.locator("#play-pause").textContent()).trim();
if (label === "Play") await page.locator("#play-pause").click();
const collapsed = await page.locator("#report").evaluate((el) => el.classList.contains("collapsed"));
if (collapsed) await page.locator("#report-toggle").click();
await page.waitForTimeout(1500);

const info = await page.evaluate(() => {
  const rectOf = (sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { w: Math.round(r.width), left: Math.round(r.left), right: Math.round(r.right) };
  };
  const monthButtons = Array.from(document.querySelectorAll("#timeline-axis button")).map((b) => ({
    text: b.textContent,
    visible: getComputedStyle(b).visibility,
  }));
  const source = document.querySelector(".source");
  const sourceRect = source ? source.getBoundingClientRect() : null;
  const sourceLineHeight = source ? parseFloat(getComputedStyle(source).lineHeight) : null;
  return {
    reportBody: rectOf(".report-body"),
    masthead: rectOf("#masthead"),
    passage: rectOf("#passage"),
    conditions: rectOf("#conditions"),
    timelineAxis: rectOf("#timeline-axis"),
    monthButtons,
    sourceHeight: sourceRect ? Math.round(sourceRect.height) : null,
    sourceLineHeight,
    sourceLines: sourceRect && sourceLineHeight ? sourceRect.height / sourceLineHeight : null,
  };
});
console.log(JSON.stringify(info, null, 2));
await browser.close();
