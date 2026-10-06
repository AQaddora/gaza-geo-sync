// Decode cost in Node (V8): JSON.parse of the gzip-free JSON text vs decodeFrame + naming.
// SYNTHETIC data. The browser numbers (with CPU throttling) are in bench/sim.
// Run: npx tsx bench/decode-cpu.ts  → bench/results/decode-node.csv
import { writeFileSync } from "node:fs";
import { GAZA, IndexTable, createCodec, frameToPayload } from "../src/index.js";
import { syntheticFleet } from "./synthetic.js";

const T = Date.parse("2026-10-06T08:00:00.000Z");
const codec = createCodec(GAZA);

function median(xs: number[]) {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
}

function time(fn: () => unknown, runs: number) {
  for (let i = 0; i < 200; i++) fn(); // warm up the JIT
  const out: number[] = [];
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    for (let k = 0; k < 20; k++) fn();
    out.push(((performance.now() - t0) / 20) * 1000);
  }
  return median(out);
}

const rows: string[] = ["vehicles,json_parse_us,binary_decode_us,binary_decode_and_name_us"];
console.log("SYNTHETIC data, Node", process.version, "— median µs per decode\n");
for (const count of [10, 50, 150, 300]) {
  const fleet = syntheticFleet(count, T, count);
  const table = new IndexTable(fleet.map((v, i) => [i + 1, v.id] as [number, string]));
  const text = JSON.stringify({ serverTime: new Date(T).toISOString(), positions: fleet.map((v) => ({ id: v.id, lat: v.lat, lon: v.lon, speed: v.speed, at: new Date(v.at).toISOString() })) });
  const frame = codec.encodeFrame(fleet.map((v) => ({ ...v, n: table.assign(v.id) })), { serverTime: T });
  const idOf = (n: number) => table.idOf(n);
  const j = time(() => JSON.parse(text), 200);
  const b = time(() => codec.decodeFrame(frame), 200);
  const bn = time(() => frameToPayload(codec.decodeFrame(frame), idOf), 200);
  rows.push(`${count},${j.toFixed(1)},${b.toFixed(1)},${bn.toFixed(1)}`);
  console.log(`${String(count).padStart(4)} vehicles  JSON.parse ${j.toFixed(1).padStart(7)} µs   decodeFrame ${b.toFixed(1).padStart(7)} µs   decode+name (ISO dates) ${bn.toFixed(1).padStart(7)} µs`);
}
writeFileSync(new URL("./results/decode-node.csv", import.meta.url), rows.join("\n") + "\n");
