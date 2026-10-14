// Drives the real app in headless Chrome: fills credentials, Start, waits for the avatar's
// first frame and at least one relayed agent reply, then Stop. Exits non-zero on failure.
import { chromium } from "playwright-core";

const need = k => { const v = process.env[k]; if (!v) { console.error(`Set ${k}`); process.exit(2); } return v; };
const creds = {
  agoraAppId: need("AGORA_APP_ID"), agoraCertificate: need("AGORA_APP_CERTIFICATE"),
  pipelineId: need("AGORA_PIPELINE_ID"), vivixApiKey: need("VIVIX_API_KEY"),
};
const url = process.env.E2E_URL || "http://localhost:8787";
const seconds = Number(process.env.E2E_SECONDS || 35);
const args = ["--autoplay-policy=no-user-gesture-required", "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"];
if (process.env.E2E_WAV) args.push(`--use-file-for-fake-audio-capture=${process.env.E2E_WAV}`);

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || "/usr/bin/google-chrome", args });
let failed = false;
try {
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 }, permissions: ["microphone"] })).newPage();
  page.on("console", m => {
    if (m.type() !== "error") return;
    const u = m.location()?.url || "";
    if (/favicon/.test(u)) return;
    console.log("[console]", m.text().slice(0, 200), u ? `(${u})` : "");
  });
  await page.goto(url);
  for (const [k, v] of Object.entries(creds)) await page.fill(`[data-field="${k}"] input`, v);
  await page.click("#start");
  await page.waitForFunction(() => /Avatar first frame/.test(document.querySelector("#timeline").textContent), null, { timeout: 30_000 });
  await page.waitForFunction(() => /turns\)/.test(document.querySelector("#latency").textContent), null, { timeout: seconds * 1000 });
  await page.waitForTimeout(2000);
  const report = await page.evaluate(() => ({
    timeline: [...document.querySelectorAll("#timeline dt")].map(dt => `${dt.textContent}: ${dt.nextElementSibling.textContent}`),
    latency: document.querySelector("#latency").textContent,
    transcript: [...document.querySelectorAll("#transcript li")].map(li => `${li.className.split(" ")[0]}: ${li.textContent}`),
  }));
  if (!report.timeline.some(l => l.startsWith("Agent audio relayed"))) throw new Error("no 'Agent audio relayed' timeline entry");
  if (!report.transcript.some(l => l.startsWith("agent:"))) throw new Error("no agent transcript line");
  console.log(report.timeline.join("\n"));
  console.log(report.latency);
  console.log(report.transcript.slice(0, 6).join("\n"));
  await page.screenshot({ path: "test-results/smoke.png" }).catch(() => {});
  await page.click("#stop");
  await page.waitForFunction(() => /^Stopped/.test(document.querySelector("#status").textContent), null, { timeout: 15_000 });
  console.log("status:", await page.textContent("#status"));
} catch (e) {
  failed = true;
  console.error("SMOKE FAILED:", e.message);
} finally {
  await browser.close();
}
process.exit(failed ? 1 : 0);
