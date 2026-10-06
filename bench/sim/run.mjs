// Drives headless Chromium through the simulation for one network profile.
// The profile itself (bandwidth, latency, loss) is applied outside the browser with Linux
// tc-netem on a veth pair (see netem.sh), so TCP really sees the delay and the loss.
// Usage (inside the shaped network namespace):
//   node bench/sim/run.mjs <profile> <serverUrl> <out.csv> [refreshes=40] [uploads=30]
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { chromium } from "playwright-core";

const [profile, server, out, refreshesArg, uploadsArg] = process.argv.slice(2);
const REFRESHES = Number(refreshesArg ?? 40);
const UPLOADS = Number(uploadsArg ?? 30);
const COUNTS = [10, 50, 150, 300];
const FORMATS = ["json", "bin"];
const CPU_THROTTLE = 4; // a mid-range phone, roughly (Lighthouse's mobile default)

const header = "profile,kind,vehicles,format,run,ttu_ms,network_ms,decode_ms,render_ms,task_ms,script_ms,req_bytes,res_bytes,body_bytes,form,status,count";
if (!existsSync(out)) writeFileSync(out, header + "\n");

const browser = await chromium.launch({ headless: true });
const version = browser.version();
const rows = [];
const metric = async (cdp) => Object.fromEntries((await cdp.send("Performance.getMetrics")).metrics.map((m) => [m.name, m.value]));

async function openPage() {
  const context = await browser.newContext({ viewport: { width: 360, height: 640 }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send("Performance.enable");
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: CPU_THROTTLE });
  await page.goto(server + "/", { waitUntil: "load", timeout: 120_000 });
  await page.waitForFunction(() => window.simReady === true, null, { timeout: 120_000 });
  return { context, page, cdp };
}

let ridSeq = 0;
const rid = () => `${profile}-${process.pid}-${++ridSeq}`;

for (const n of COUNTS) {
  for (const fmt of FORMATS) {
    const { context, page, cdp } = await openPage();
    const r0 = rid();
    const first = await page.evaluate(([n, fmt, r]) => window.sim.first(n, fmt, r), [n, fmt, r0]);
    rows.push({ kind: "first", n, fmt, run: 0, rid: r0, ...first, task: NaN, script: NaN });
    for (let i = 1; i <= REFRESHES; i++) {
      const r = rid();
      const m0 = await metric(cdp);
      const res = await page.evaluate(([n, fmt, r]) => window.sim.refresh(n, fmt, r), [n, fmt, r]);
      const m1 = await metric(cdp);
      rows.push({ kind: "refresh", n, fmt, run: i, rid: r, ...res, task: (m1.TaskDuration - m0.TaskDuration) * 1000, script: (m1.ScriptDuration - m0.ScriptDuration) * 1000 });
      await page.waitForTimeout(250);
    }
    await context.close();
    console.log(`${profile} n=${n} ${fmt} done`);
  }
}

for (const fmt of FORMATS) {
  const { context, page } = await openPage();
  for (let i = 1; i <= UPLOADS; i++) {
    const r = rid();
    const res = await page.evaluate(([fmt, r]) => window.sim.upload(fmt, r), [fmt, r]);
    rows.push({ kind: "upload", n: 0, fmt, run: i, rid: r, ...res, network: NaN, decode: NaN, render: NaN, task: NaN, script: NaN, count: 0 });
    await page.waitForTimeout(250);
  }
  await context.close();
  console.log(`${profile} uploads ${fmt} done`);
}
await browser.close();

const stats = await (await fetch(server + "/stats")).json();
for (const row of rows) {
  const s = stats[row.rid] ?? {};
  const f = (x) => (Number.isFinite(x) ? x.toFixed(3) : "");
  appendFileSync(out, [profile, row.kind, row.n, row.fmt, row.run, f(row.ttu), f(row.network), f(row.decode), f(row.render), f(row.task), f(row.script), s.reqBytes ?? "", s.resBytes ?? "", s.bodyBytes ?? "", s.form ?? "", s.status ?? row.status ?? "", row.count ?? ""].join(",") + "\n");
}
console.log(`chromium ${version}; ${rows.length} rows → ${out}`);
