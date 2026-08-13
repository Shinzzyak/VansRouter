import { chromium } from "playwright-core";
const TOKEN = process.env.VR_JWT || "";
const ctx = await chromium.launch({ executablePath: "/home/ubuntu/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome" }).then(b => b.newContext());
const page = await ctx.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push("PAGEERROR: " + e.message));
page.on("console", (m) => { if (m.type() === "error") errors.push("CONSOLE: " + m.text()); });
// login
await page.goto("http://127.0.0.1:20128/dashboard/login");
await page.waitForTimeout(1500);
// use password from .env
const fs = await import("fs");
const env = fs.readFileSync("/home/ubuntu/VansRouter/.env", "utf8");
const pw = env.match(/INITIAL_PASSWORD=(.+)/)?.[1]?.trim();
if (pw) {
  await page.fill('input[type="password"]', pw);
  await page.click('button[type="submit"], button:has-text("Login"), button:has-text("Masuk")');
  await page.waitForTimeout(2000);
}
await page.goto("http://127.0.0.1:20128/dashboard/combos");
await page.waitForTimeout(3000);
const body = await page.textContent("body");
console.log("BOUNDARY:", body.includes("failed to render") ? "YES (CRASH)" : "no");
// find first adapter card, click its expand chevron
const expandBtn = page.locator('button[aria-label*="Expand"]').first();
if (await expandBtn.count()) {
  await expandBtn.click();
  await page.waitForTimeout(800);
  const sortableCount = await page.locator('[data-sortable-index]').count();
  const modelRows = await page.locator('text=/No models yet|font-mono/').count();
  console.log("EXPAND_OK, data-sortable-index rows:", sortableCount);
  console.log("MODEL_ROWS:", modelRows);
} else {
  console.log("NO_EXPAND_BTN — adapter section not rendered?");
  console.log("BODY_SNIPPET:", body.slice(0, 300));
}
console.log("JS_ERRORS:", errors.length ? errors.slice(0, 5) : "none");
await ctx.close();
