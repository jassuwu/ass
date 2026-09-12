import { chromium } from "@playwright/test";
const browser = await chromium.launch({ channel: "chromium", args: ["--enable-unsafe-webgpu", "--autoplay-policy=no-user-gesture-required"] });
const errors = [];
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
  page.on("console", (m) => { if (m.type() === "error") errors.push("console: " + m.text()); });
  await page.goto("http://127.0.0.1:5173/");
  await page.waitForTimeout(3500);
  await page.mouse.move(500, 330); await page.waitForTimeout(200);
  for (let i = 0; i < 3; i++) { await page.mouse.down(); await page.waitForTimeout(900); await page.mouse.up(); await page.waitForTimeout(700); }
  await page.waitForTimeout(800);
  await page.screenshot({ path: "/tmp/ass-print/print-after-3.jpg", quality: 90 });
  await page.mouse.move(780, 330); await page.waitForTimeout(200);
  await page.mouse.down(); await page.waitForTimeout(1300); await page.mouse.up();
  await page.waitForTimeout(2400);
  await page.screenshot({ path: "/tmp/ass-print/print-killcam.jpg", quality: 90 });
  await page.waitForTimeout(3000);
  await page.screenshot({ path: "/tmp/ass-print/print-after-killcam.jpg", quality: 90 });
} finally { await browser.close(); console.log(JSON.stringify({ errors })); }
