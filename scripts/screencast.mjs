// Records every gesture against the running dev server (bun run dev on
// :5173) through Chrome's screencast — every composited frame with a
// timestamp, ~60 fps — and lays them out as contact sheets under
// /tmp/ass-vid/<gesture>/sheet.jpg. Stills cannot resolve a 60 ms
// contact; this can. Run: node scripts/screencast.mjs
import { chromium } from "@playwright/test";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { execSync } from "node:child_process";
const root = "/tmp/ass-vid";
const browser = await chromium.launch({ channel: "chromium", args: ["--enable-unsafe-webgpu", "--autoplay-policy=no-user-gesture-required"] });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
await page.goto("http://127.0.0.1:5173/");
await page.waitForTimeout(3500);
const cdp = await page.context().newCDPSession(page);
let frames = []; let recording = false;
cdp.on("Page.screencastFrame", async (f) => {
  if (recording) frames.push({ t: f.metadata.timestamp, data: f.data });
  await cdp.send("Page.screencastFrameAck", { sessionId: f.sessionId }).catch(() => {});
});
async function record(name, action, crop) {
  frames = []; recording = true;
  await cdp.send("Page.startScreencast", { format: "jpeg", quality: 80, everyNthFrame: 1 });
  const t0 = performance.now();
  await action();
  await cdp.send("Page.stopScreencast");
  recording = false;
  const dir = `${root}/${name}`; rmSync(dir, { recursive: true, force: true }); mkdirSync(dir, { recursive: true });
  const base = frames[0]?.t ?? 0;
  frames.forEach((f, i) => writeFileSync(`${dir}/${String(i).padStart(3, "0")}.jpg`, Buffer.from(f.data, "base64")));
  const times = frames.map((f) => ((f.t - base) * 1000).toFixed(0));
  // contact sheet: 20 frames evenly spread, 5 x 4, each 320 px wide (optionally cropped)
  const n = frames.length; const pick = Array.from({ length: Math.min(20, n) }, (_, i) => Math.floor((i * n) / Math.min(20, n)));
  const list = pick.map((i) => `file '${dir}/${String(i).padStart(3, "0")}.jpg'`).join("\n");
  writeFileSync(`${dir}/list.txt`, list);
  const cropF = crop ? `crop=${crop.w}:${crop.h}:${crop.x}:${crop.y},` : "";
  execSync(`ffmpeg -v error -y -f concat -safe 0 -i ${dir}/list.txt -vf "${cropF}scale=320:-1,tile=5x4" ${dir}/sheet.jpg`);
  console.log(name, "frames", n, "over", (performance.now() - t0).toFixed(0), "ms; picked t(ms):", pick.map((i) => times[i]).join(" "));
}
const cheek = { x: 500, y: 330 };
const cropL = { x: 220, y: 100, w: 560, h: 560 };
await page.mouse.move(cheek.x, cheek.y); await page.waitForTimeout(300);
await record("tap", async () => { await page.mouse.down(); await page.waitForTimeout(40); await page.mouse.up(); await page.waitForTimeout(700); }, cropL);
await page.waitForTimeout(800);
await record("charged", async () => { await page.mouse.down(); await page.waitForTimeout(800); await page.mouse.up(); await page.waitForTimeout(900); }, cropL);
await page.waitForTimeout(800);
await record("swipe", async () => { await page.mouse.move(cheek.x - 160, cheek.y + 40); await page.waitForTimeout(150); await page.mouse.down(); await page.waitForTimeout(250); await page.mouse.move(cheek.x, cheek.y, { steps: 4 }); await page.mouse.up(); await page.waitForTimeout(800); }, cropL);
await page.waitForTimeout(800);
await record("brush", async () => { await page.mouse.move(380, 380); await page.waitForTimeout(100); await page.mouse.move(620, 300, { steps: 40 }); await page.waitForTimeout(500); }, cropL);
await page.waitForTimeout(800);
await record("grab", async () => { await page.mouse.move(cheek.x, cheek.y + 30); await page.waitForTimeout(150); await page.mouse.down(); await page.waitForTimeout(250); await page.mouse.move(cheek.x + 90, cheek.y + 60, { steps: 12 }); await page.waitForTimeout(200); await page.mouse.move(cheek.x - 60, cheek.y - 20, { steps: 3 }); await page.mouse.up(); await page.waitForTimeout(900); }, cropL);
await page.waitForTimeout(800);
// a hit near the outer silhouette, where the line of sight grazes the skin
await record("side", async () => { await page.mouse.move(255, 380); await page.waitForTimeout(150); await page.mouse.down(); await page.waitForTimeout(700); await page.mouse.up(); await page.waitForTimeout(900); }, { x: 60, y: 120, w: 560, h: 560 });
await page.waitForTimeout(800);
// orbit the camera left by dragging the void, then hit the cheek at an angle
await record("angled", async () => { await page.mouse.move(60, 400); await page.mouse.down(); await page.mouse.move(330, 390, { steps: 12 }); await page.mouse.up(); await page.waitForTimeout(700); await page.mouse.move(560, 340); await page.waitForTimeout(150); await page.mouse.down(); await page.waitForTimeout(700); await page.mouse.up(); await page.waitForTimeout(900); }, cropL);
await page.waitForTimeout(1000);
await record("killcam", async () => { await page.mouse.move(780, 330); await page.waitForTimeout(150); await page.mouse.down(); await page.waitForTimeout(1300); await page.mouse.up(); await page.waitForTimeout(4600); });
await browser.close();
console.log(JSON.stringify({ errors }));
