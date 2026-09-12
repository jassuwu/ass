import { chromium } from "@playwright/test";
const browser = await chromium.launch({ channel: "chromium", args: ["--enable-unsafe-webgpu", "--autoplay-policy=no-user-gesture-required"] });
const errors = [];
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
  page.on("console", (m) => { if (m.type() === "error") errors.push("console: " + m.text()); });
  await page.goto("http://127.0.0.1:5173/");
  await page.waitForTimeout(3500);
  const cheek = { x: 500, y: 330 };
  await page.mouse.move(cheek.x, cheek.y); await page.waitForTimeout(200);
  await page.mouse.down(); await page.waitForTimeout(40); await page.mouse.up();
  await page.waitForTimeout(600);
  await page.mouse.down(); await page.waitForTimeout(700); await page.mouse.up();
  await page.waitForTimeout(800);
  await page.mouse.move(380, 360); await page.mouse.move(900, 340, { steps: 25 });
  await page.waitForTimeout(400);
  await page.mouse.move(cheek.x, cheek.y + 30); await page.waitForTimeout(200);
  await page.mouse.down(); await page.waitForTimeout(250);
  await page.mouse.move(cheek.x + 90, cheek.y + 60, { steps: 6 });
  await page.mouse.move(cheek.x - 60, cheek.y - 20, { steps: 3 }); await page.mouse.up();
  await page.waitForTimeout(600);
  // void drag orbit + wheel
  await page.mouse.move(60, 400); await page.mouse.down(); await page.mouse.move(200, 380, { steps: 8 }); await page.mouse.up();
  await page.mouse.wheel(0, 300); await page.waitForTimeout(400);
  // hidden tab cycle
  await page.evaluate(() => { Object.defineProperty(document, "hidden", { configurable: true, value: true }); document.dispatchEvent(new Event("visibilitychange")); });
  await page.waitForTimeout(500);
  await page.evaluate(() => { delete document.hidden; document.dispatchEvent(new Event("visibilitychange")); });
  await page.waitForTimeout(500);
  await page.mouse.move(780, 330); await page.waitForTimeout(200);
  await page.mouse.down(); await page.waitForTimeout(1300); await page.mouse.up();
  await page.waitForTimeout(4500);
  await page.screenshot({ path: "/tmp/ass-print/life-end.jpg", quality: 85 });
} finally { await browser.close(); console.log(JSON.stringify({ errors })); }
