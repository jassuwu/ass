import { chromium } from "@playwright/test";
const browser = await chromium.launch({ channel: "chromium", args: ["--enable-unsafe-webgpu"] });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.goto("http://127.0.0.1:5173/");
  await page.waitForTimeout(3500);
  await page.screenshot({ path: "/tmp/ass-print/rest-smooth.jpg", quality: 90 });
} finally { await browser.close(); }
