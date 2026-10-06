// A phone's uploads: how many requests per minute, and how big the body is, for a
// SYNTHETIC driver day: 1 Hz GPS fixes for 2 hours, alternating driving (8–14 m/s) and
// waiting at a stop for passengers (2–12 min, with ±4 m GPS jitter).
// Policies: send the newest fix every 15 s (before), and the same with the standing-still
// throttle (after: only when moved ≥ 15 m, else once a minute).
// Run: npx tsx bench/uploads.ts → bench/results/uploads.csv
import { writeFileSync } from "node:fs";
import { GAZA, createCodec, worthSending } from "../src/index.js";
import { rng } from "./synthetic.js";

const codec = createCodec(GAZA);
const r = rng(99);

type Fix = { t: number; lat: number; lon: number; speed: number; parked: boolean };
const fixes: Fix[] = [];
let lat = 31.3;
let lon = 34.3;
let t = 0;
const END = 2 * 3600_000;
while (t < END) {
  const drive = (3 + r() * 9) * 60_000;
  const heading = 0.6 + (r() - 0.5) * 0.6; // mostly north-east, along the Strip
  for (const end = t + drive; t < end && t < END; t += 1000) {
    const v = 8 + r() * 6;
    lat += (v * Math.cos(heading)) / 111_320;
    lon += (v * Math.sin(heading)) / 95_000;
    fixes.push({ t, lat, lon, speed: v, parked: false });
  }
  const wait = (2 + r() * 10) * 60_000;
  for (const end = t + wait; t < end && t < END; t += 1000) {
    fixes.push({ t, lat: lat + (r() - 0.5) * 7e-5, lon: lon + (r() - 0.5) * 8e-5, speed: r() * 0.4, parked: true });
  }
  if (lat > 31.55) lat = 31.3; // loop back to the south of the Strip
}

function simulate(throttle: boolean) {
  let last: { lat: number; lon: number; sentAt: number } | null = null;
  const sent = { moving: 0, parked: 0 };
  let movingMin = 0;
  let parkedMin = 0;
  for (const f of fixes) (f.parked ? parkedMin++ : movingMin++);
  for (let tick = 0; tick < END; tick += 15_000) {
    const f = fixes[Math.min(fixes.length - 1, tick / 1000)]!;
    if (throttle && !worthSending(last, f, tick)) continue;
    last = { lat: f.lat, lon: f.lon, sentAt: tick };
    sent[f.parked ? "parked" : "moving"]++;
  }
  return { perMinMoving: sent.moving / (movingMin / 60), perMinParked: sent.parked / (parkedMin / 60), total: sent.moving + sent.parked };
}

const sample = fixes[1234]!;
const jsonBody = JSON.stringify({ lat: sample.lat, lon: sample.lon, speed: sample.speed });
const binaryBody = codec.encodePoint({ lat: sample.lat, lon: sample.lon, speed: sample.speed, ageSec: 1 });
const shareJson = JSON.stringify({ id: "00000000-0000-4000-8000-0000000000c2", lat: sample.lat, lon: sample.lon });
const shareBinary = codec.encodePoint({ lat: sample.lat, lon: sample.lon, ageSec: 1 }, "00000000-0000-4000-8000-0000000000c2");
const before = simulate(false);
const after = simulate(true);
const rows = [
  "policy,requests_per_min_moving,requests_per_min_parked,requests_2h,json_body_bytes,binary_body_bytes,share_json_body_bytes,share_binary_body_bytes",
  `every_15s,${before.perMinMoving.toFixed(2)},${before.perMinParked.toFixed(2)},${before.total},${jsonBody.length},${binaryBody.length},${shareJson.length},${shareBinary.length}`,
  `every_15s_plus_standing_still_throttle,${after.perMinMoving.toFixed(2)},${after.perMinParked.toFixed(2)},${after.total},${jsonBody.length},${binaryBody.length},${shareJson.length},${shareBinary.length}`,
];
writeFileSync(new URL("./results/uploads.csv", import.meta.url), rows.join("\n") + "\n");
console.log(`SYNTHETIC driver, 2 h (${fixes.filter((f) => f.parked).length / 60 | 0} min waiting at stops)`);
console.log(`  every 15 s:            ${before.perMinMoving.toFixed(2)} req/min moving, ${before.perMinParked.toFixed(2)} req/min parked, ${before.total} requests`);
console.log(`  + standing-still rule: ${after.perMinMoving.toFixed(2)} req/min moving, ${after.perMinParked.toFixed(2)} req/min parked, ${after.total} requests`);
console.log(`  body: JSON ${jsonBody.length} B → binary ${binaryBody.length} B; shared point with UUID: JSON ${shareJson.length} B → binary ${shareBinary.length} B`);
