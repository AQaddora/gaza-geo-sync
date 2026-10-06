import { describe, expect, it } from "vitest";
import { syntheticFleet } from "../bench/synthetic.js";
import { ACCEPT_BINARY, GAZA, IndexTable, createCodec, createPointSender, fetchPositions, fixAgeSec, frameToPayload, sentBinary, wantsBinary, worthSending } from "../src/index.js";
import { positionsReply, readPointBody, toFetchResponse } from "../src/server.js";

const T = Date.parse("2026-10-06T08:00:00.000Z");
const codec = createCodec(GAZA);

describe("negotiation", () => {
  it("binary only when asked for, JSON by default", () => {
    expect(wantsBinary(ACCEPT_BINARY)).toBe(true);
    expect(wantsBinary("application/octet-stream")).toBe(true);
    expect(wantsBinary("*/*")).toBe(false);
    expect(wantsBinary(undefined)).toBe(false);
    expect(wantsBinary("application/json")).toBe(false);
    expect(wantsBinary("application/octet-stream;q=0, application/json")).toBe(false);
    expect(sentBinary("application/octet-stream")).toBe(true);
    expect(sentBinary("application/json; charset=utf-8")).toBe(false);
  });
});

describe("server reply → client, both forms give the same records", () => {
  const fleet = syntheticFleet(20, T, 5);
  const table = new IndexTable();
  const index = fleet.map((v) => [table.assign(v.id), v.id] as [number, string]);

  const serve = (accept: string, acceptEncoding = "gzip") =>
    toFetchResponse(positionsReply({ codec, accept, acceptEncoding, positions: fleet, table, index, extra: { cursor: "c1" }, now: T }));

  it("JSON and binary decode to identical payloads (offline cache stays the same)", async () => {
    const asJson = await fetchPositions("/p", { codec, idOf: () => undefined, fetch: async () => serve("application/json") });
    const asBinary = await fetchPositions("/p", { codec, idOf: () => undefined, fetch: async (_u, init) => serve(new Headers(init?.headers).get("accept")!, "identity") });
    expect(asJson.binary).toBe(false);
    expect(asBinary.binary).toBe(true);
    expect(asBinary.unknown).toBe(0);
    // JSON ages are milliseconds; binary ages are whole seconds. Compare at second precision.
    const norm = (p: typeof asJson.payload) => ({ ...p, positions: p.positions.map((x) => ({ ...x, at: new Date(Math.floor(Date.parse(x.at) / 1000) * 1000).toISOString() })).sort((a, b) => a.id.localeCompare(b.id)) });
    const a = norm(asJson.payload);
    const b = norm(asBinary.payload);
    expect(b.positions.map((p) => [p.id, p.lat, p.lon])).toEqual(a.positions.map((p) => [p.id, p.lat, p.lon]));
    expect(asBinary.payload.cursor).toBe("c1");
    expect(b.index).toEqual(index);
    for (const [i, p] of b.positions.entries()) {
      const want = a.positions[i]!;
      if (want.speed === undefined) expect(p.speed).toBeUndefined();
      else expect(Math.abs(p.speed! - want.speed)).toBeLessThanOrEqual(0.13);
      expect(Math.abs(Date.parse(p.at) - Date.parse(want.at))).toBeLessThanOrEqual(1000);
    }
  });

  it("gzips the binary frame only when that is smaller", () => {
    const routine = positionsReply({ codec, accept: ACCEPT_BINARY, acceptEncoding: "gzip", positions: fleet, table, now: T });
    const first = positionsReply({ codec, accept: ACCEPT_BINARY, acceptEncoding: "gzip", positions: fleet, table, index, now: T });
    expect(routine.form).toBe("binary"); // quantised points barely compress
    expect(first.form).toBe("binary+gzip"); // the index of ids does
  });

  it("names points from the client's stored table and counts strangers", () => {
    const frame = codec.decodeFrame(codec.encodeFrame([{ n: 1, lat: 31.5, lon: 34.4, at: T }, { n: 2, lat: 31.5, lon: 34.4, at: T }, { n: 3, lat: 31.5, lon: 34.4, at: T }], { serverTime: T, json: { index: [[3, "new"]] } }));
    const { payload, unknown } = frameToPayload(frame, (n) => (n === 1 ? "old" : undefined));
    expect(payload.positions.map((p) => p.id)).toEqual(["old", "new"]);
    expect(unknown).toBe(1);
  });

  it("falls back to JSON when the server answers JSON", async () => {
    const res = await fetchPositions("/p", { codec, idOf: () => undefined, fetch: async () => Response.json({ serverTime: new Date(T).toISOString(), positions: [] }) });
    expect(res.binary).toBe(false);
  });
});

describe("index table", () => {
  it("numbers are small, stable and reversible", () => {
    const t = new IndexTable([[7, "a"]]);
    expect(t.assign("a")).toBe(7);
    expect(t.assign("b")).toBe(8);
    expect(t.idOf(8)).toBe("b");
    expect(t.entries()).toEqual([[7, "a"], [8, "b"]]);
  });
});

describe("uploads", () => {
  it("server reads binary and JSON bodies, and says which", () => {
    const bin = readPointBody(codec, "application/octet-stream", codec.encodePoint({ lat: 31.5, lon: 34.4, speed: 2, ageSec: 1 }));
    expect(bin).toEqual({ ok: true, binary: true, point: { lat: 31.5, lon: 34.4, speed: 2, ageSec: 1 } });
    expect(readPointBody(codec, "application/json", '{"lat":31.5,"lon":34.4}')).toEqual({ ok: true, binary: false, point: { lat: 31.5, lon: 34.4, ageSec: 0 } });
    expect(readPointBody(codec, "application/octet-stream", Uint8Array.of(1, 2, 3))).toEqual({ ok: false, error: "bad_body" });
    expect(readPointBody(codec, "application/json", "{")).toEqual({ ok: false, error: "bad_json" });
    expect(readPointBody(codec, "application/json", '{"lat":91,"lon":0}')).toEqual({ ok: false, error: "bad_position" });
  });

  it("standing still sends once a minute; moving 15 m sends at once", () => {
    const at = { lat: 31.5, lon: 34.45 };
    expect(worthSending(null, at, 0)).toBe(true);
    const last = { ...at, sentAt: 0 };
    expect(worthSending(last, { lat: 31.50005, lon: 34.45 }, 15_000)).toBe(false); // ~5.6 m
    expect(worthSending(last, { lat: 31.5002, lon: 34.45 }, 15_000)).toBe(true); // ~22 m
    expect(worthSending(last, { lat: 31.5, lon: 34.45012 }, 15_000)).toBe(false); // ~11 m east
    expect(worthSending(last, at, 59_999)).toBe(false);
    expect(worthSending(last, at, 60_000)).toBe(true);
  });

  it("a fix's age is clamped to 0–60 seconds", () => {
    expect(fixAgeSec(1000, 4500)).toBe(3.5);
    expect(fixAgeSec(5000, 1000)).toBe(0);
    expect(fixAgeSec(0, 10_000_000)).toBe(60);
    expect(fixAgeSec(Number.NaN, 1)).toBe(0);
  });

  it("the sender throttles, sends binary, and switches to JSON for good after a 400", async () => {
    let clock = 0;
    const bodies: { type: string; size: number }[] = [];
    let speaksBinary = true;
    const sender = createPointSender({
      url: "/position",
      codec,
      now: () => clock,
      fetch: async (_u, init) => {
        const type = new Headers(init?.headers).get("content-type")!;
        const body = init?.body as Uint8Array | string;
        bodies.push({ type, size: typeof body === "string" ? body.length : body.length });
        if (type === "application/octet-stream" && !speaksBinary) return new Response(null, { status: 400 });
        return new Response(null, { status: 204 });
      },
    });
    const fix = { lat: 31.5, lon: 34.45, speed: 0, fixAt: 0 };
    expect(await sender.offer(fix)).toBe("sent");
    expect(bodies[0]).toEqual({ type: "application/octet-stream", size: 8 });
    clock = 5_000;
    expect(await sender.offer({ ...fix, lat: 31.501 })).toBe("skipped"); // moved 110 m, but only 5 s ago
    clock = 15_000;
    expect(await sender.offer(fix)).toBe("skipped"); // standing still
    clock = 60_000;
    speaksBinary = false;
    expect(await sender.offer(fix)).toBe("sent");
    expect(bodies.map((b) => b.type)).toEqual(["application/octet-stream", "application/octet-stream", "application/json"]);
    expect(sender.usingJson).toBe(true);
    clock = 75_000;
    expect(await sender.offer({ ...fix, lat: 31.501 })).toBe("sent");
    expect(bodies.at(-1)!.type).toBe("application/json");
  });
});
