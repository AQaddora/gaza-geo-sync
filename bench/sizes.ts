// Payload size of one routine map refresh, on SYNTHETIC Gaza data (bench/synthetic.ts).
// Steady state: the client already knows every vehicle's number (the index was sent once).
// Run: npx tsx bench/sizes.ts   → prints a table and writes bench/results/sizes.csv
import { writeFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { encode as msgpack } from "@msgpack/msgpack";
import { encode as cbor } from "cbor-x";
import protobuf from "protobufjs";
import { GAZA, IndexTable, createCodec } from "../src/index.js";
import { syntheticFleet } from "./synthetic.js";

const T = Date.parse("2026-10-06T08:00:00.000Z");
const codec = createCodec(GAZA);
const gz = (b: Uint8Array | string) => gzipSync(typeof b === "string" ? Buffer.from(b) : b, { level: 6 }).length;

const root = protobuf.Root.fromJSON({
  nested: {
    Naive: { fields: { serverTime: { type: "string", id: 1 }, positions: { rule: "repeated", type: "NaivePos", id: 2 } } },
    NaivePos: { fields: { id: { type: "string", id: 1 }, lat: { type: "double", id: 2 }, lon: { type: "double", id: 3 }, speed: { type: "float", id: 4 }, atMs: { type: "int64", id: 5 } } },
    Tuned: { fields: { serverTimeMs: { type: "int64", id: 1 }, positions: { rule: "repeated", type: "TunedPos", id: 2 } } },
    TunedPos: { fields: { nGap: { type: "uint32", id: 1 }, dLat: { type: "uint32", id: 2 }, dLon: { type: "uint32", id: 3 }, speedQ: { type: "uint32", id: 4 }, ageSec: { type: "uint32", id: 5 } } },
  },
});
const Naive = root.lookupType("Naive");
const Tuned = root.lookupType("Tuned");

const rows: Record<string, number | string>[] = [];
for (const count of [4, 10, 50, 100, 150, 300]) {
  const fleet = syntheticFleet(count, T, count);
  const table = new IndexTable(fleet.map((v, i) => [i + 1, v.id] as [number, string]));
  // What many apps send today: raw GPS floats, full ids, ISO times.
  const naive = { serverTime: new Date(T).toISOString(), positions: fleet.map((v) => ({ id: v.id, lat: v.lat, lon: v.lon, speed: v.speed, at: new Date(v.at).toISOString() })) };
  // The cheap first step: same JSON, coordinates rounded to 5 decimals, speed to 2.
  const rounded = { ...naive, positions: naive.positions.map((p) => ({ ...p, lat: codec.round(p.lat), lon: codec.round(p.lon), speed: p.speed == null ? null : Math.round(p.speed * 100) / 100 })) };
  const pbNaive = Naive.encode(Naive.fromObject({ serverTime: naive.serverTime, positions: fleet.map((v) => ({ id: v.id, lat: v.lat, lon: v.lon, speed: v.speed ?? 0, atMs: v.at })) })).finish();
  let prev = 0;
  const pbTuned = Tuned.encode(
    Tuned.fromObject({
      serverTimeMs: T,
      positions: fleet.map((v, i) => {
        const n = i + 1;
        const gap = n - prev;
        prev = n;
        return { nGap: gap, dLat: Math.round(v.lat * 1e5) - 3120000, dLon: Math.round(v.lon * 1e5) - 3420000, speedQ: v.speed == null ? 0 : Math.round(v.speed * 4), ageSec: Math.floor((T - v.at) / 1000) };
      }),
    }),
  ).finish();
  const frame = codec.encodeFrame(fleet.map((v) => ({ ...v, n: table.assign(v.id) })), { serverTime: T });
  const firstFrame = codec.encodeFrame(fleet.map((v) => ({ ...v, n: table.assign(v.id) })), { serverTime: T, json: { index: table.entries() } });
  const json = JSON.stringify(naive);
  rows.push({
    vehicles: count,
    json_raw: json.length,
    json_gzip: gz(json),
    json_rounded_gzip: gz(JSON.stringify(rounded)),
    msgpack_gzip: gz(msgpack(naive)),
    cbor_gzip: gz(cbor(naive)),
    protobuf_naive_gzip: gz(pbNaive),
    protobuf_tuned: pbTuned.length,
    binary: frame.length,
    binary_gzip: gz(frame),
    binary_sent: Math.min(frame.length, gz(frame)),
    first_sync_binary_sent: Math.min(firstFrame.length, gz(firstFrame)),
    ratio_json_gzip_over_binary: (gz(json) / Math.min(frame.length, gz(frame))).toFixed(2),
    binary_bytes_per_vehicle: ((frame.length - codec.encodeFrame([], { serverTime: T }).length) / count).toFixed(2),
  });
}

const header = Object.keys(rows[0]!);
writeFileSync(new URL("./results/sizes.csv", import.meta.url), [header.join(","), ...rows.map((r) => header.map((h) => r[h]).join(","))].join("\n") + "\n");
console.log("SYNTHETIC Gaza fleet, one routine refresh (bytes; gzip level 6; client already knows the index)\n");
console.table(rows.map((r) => ({ vehicles: r.vehicles, "JSON": r.json_raw, "JSON gzip": r.json_gzip, "JSON 5dp gzip": r.json_rounded_gzip, "MsgPack gzip": r.msgpack_gzip, "CBOR gzip": r.cbor_gzip, "Protobuf gzip": r.protobuf_naive_gzip, "Protobuf tuned": r.protobuf_tuned, "this format": r.binary_sent, "×": r.ratio_json_gzip_over_binary })));
