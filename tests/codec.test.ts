import { describe, expect, it } from "vitest";
import { syntheticFleet } from "../bench/synthetic.js";
import { CodecError, GAZA, createCodec, type NumberedPoint } from "../src/index.js";

const T = Date.parse("2026-10-06T08:00:00.000Z");
const codec = createCodec(GAZA);
const fleet = syntheticFleet(50, T, 11);

describe("sync frame", () => {
  it("round-trips Gaza positions to within half a unit, with speeds and whole-second ages", () => {
    const positions: NumberedPoint[] = fleet.map((v, i) => ({
      n: i * 3 + 1,
      lat: v.lat,
      lon: v.lon,
      speed: i % 4 === 0 ? null : (i * 0.37) % 30,
      at: T - i * 7_300,
    }));
    const frame = codec.decodeFrame(codec.encodeFrame(positions, { serverTime: T }));
    expect(frame.serverTime).toBe(T);
    expect(frame.points).toHaveLength(50);
    for (const p of positions) {
      const got = frame.points.find((x) => x.n === p.n)!;
      expect(Math.abs(got.lat - p.lat)).toBeLessThanOrEqual(0.5e-5 + 1e-12);
      expect(Math.abs(got.lon - p.lon)).toBeLessThanOrEqual(0.5e-5 + 1e-12);
      if (p.speed == null) expect(got.speed).toBeUndefined();
      else expect(Math.abs(got.speed! - p.speed)).toBeLessThanOrEqual(0.125);
      expect(T - got.at).toBe(Math.floor((T - (p.at as number)) / 1000) * 1000);
    }
  });

  it("carries the JSON part unchanged, and none at all when there is none", () => {
    const json = { cursor: "abc", routes: [{ id: "r1", name: "شارع صلاح الدين", stops: ["a", "b"] }], index: [[1, "v1"]] };
    const frame = codec.decodeFrame(codec.encodeFrame([{ n: 1, lat: 31.5, lon: 34.45, at: T }], { serverTime: T, json }));
    expect(frame.json).toEqual(json);
    expect(frame.points).toEqual([{ n: 1, lat: 31.5, lon: 34.45, ageSec: 0, at: T }]);
    expect(codec.decodeFrame(codec.encodeFrame([], { serverTime: T })).json).toBeUndefined();
  });

  it("still carries a point outside the box (absolute coordinates)", () => {
    const far = [
      { n: 1, lat: 31.9, lon: 35.2, at: T },
      { n: 2, lat: -33.86882, lon: 151.20929, speed: 3, at: T },
      { n: 3, lat: 31.1, lon: 34.1, at: T },
      { n: 4, lat: -90, lon: 180, at: T },
    ];
    const frame = codec.decodeFrame(codec.encodeFrame(far, { serverTime: T }));
    expect(frame.points.map((p) => [p.lat, p.lon])).toEqual([
      [31.9, 35.2],
      [-33.86882, 151.20929],
      [31.1, 34.1],
      [-90, 180],
    ]);
  });

  it("is small: 50 vehicles on the road cost under 8 bytes each", () => {
    const positions = fleet.map((v, i) => ({ n: i + 1, lat: v.lat, lon: v.lon, speed: 8.3, at: T - 20_000 }));
    const per = (codec.encodeFrame(positions, { serverTime: T }).length - codec.encodeFrame([], { serverTime: T }).length) / 50;
    expect(per).toBeLessThan(8);
  });

  it("refuses broken frames with a CodecError, never anything else", () => {
    const good = codec.encodeFrame([{ n: 1, lat: 31.5, lon: 34.4, speed: 2, at: T }], { serverTime: T, json: { a: 1 } });
    const bad: Uint8Array[] = [
      new Uint8Array(),
      Uint8Array.of(0x21, ...good.subarray(1)), // version 2
      Uint8Array.of(good[0]!, 9, ...good.subarray(2)), // another profile
      good.subarray(0, good.length - 1), // truncated
      Uint8Array.of(...good, 0), // trailing byte
      Uint8Array.of(0x11, 0, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff), // runaway varint
      Uint8Array.of(0x11, 0, 0, 2, 0x7b, 0x7b, 0), // "{{" is not JSON
      Uint8Array.of(0x11, 0, 0, 0, 2, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0), // repeated number (gap 0)
    ];
    for (const bytes of bad) expect(() => codec.decodeFrame(bytes)).toThrow(CodecError);
  });

  it("refuses to encode a number twice or a broken coordinate", () => {
    expect(() => codec.encodeFrame([{ n: 1, lat: 31.5, lon: 34.4, at: T }, { n: 1, lat: 31.5, lon: 34.4, at: T }])).toThrow(CodecError);
    expect(() => codec.encodeFrame([{ n: 1, lat: Number.NaN, lon: 34.4, at: T }])).toThrow(CodecError);
    expect(() => codec.encodeFrame([{ n: -1, lat: 31.5, lon: 34.4, at: T }])).toThrow(CodecError);
  });
});

describe("configuration", () => {
  it("another city, a coarser grid, 3-byte offsets and headings", () => {
    // Cairo-sized area, 1e4 units (≈11 m) is plenty for a bus map.
    const cairo = createCodec({ south: 29.8, west: 31.0, scale: 1e4, heading: true, profile: 7 });
    const bytes = cairo.encodePoint({ lat: 30.0444, lon: 31.2357, speed: 10, heading: 271, ageSec: 3 });
    expect(bytes.length).toBe(2 + 1 + 4 + 2);
    const p = cairo.decodePoint(bytes);
    expect(p.lat).toBeCloseTo(30.0444, 4);
    expect(p.heading).toBeCloseTo(271, 0);
    const wide = createCodec({ south: 20, west: 30, offsetBytes: 3 });
    expect(wide.box[2]).toBeGreaterThan(187);
    expect(wide.encodePoint({ lat: 45.123456, lon: 60.654321, ageSec: 0 }).length).toBe(2 + 1 + 6);
  });

  it("a frame made with one profile is refused by another", () => {
    const a = createCodec({ ...GAZA, profile: 1 });
    const b = createCodec({ ...GAZA, profile: 2 });
    expect(() => b.decodeFrame(a.encodeFrame([]))).toThrow(CodecError);
  });

  it("speedStep 0 leaves speed out", () => {
    const noSpeed = createCodec({ ...GAZA, speedStep: 0 });
    expect(noSpeed.decodePoint(noSpeed.encodePoint({ lat: 31.5, lon: 34.4, speed: 9, ageSec: 0 })).speed).toBeUndefined();
  });

  it("rejects nonsense options", () => {
    expect(() => createCodec({ south: 99, west: 0 })).toThrow(RangeError);
    expect(() => createCodec({ ...GAZA, scale: 0 })).toThrow(RangeError);
    expect(() => createCodec({ ...GAZA, profile: 256 })).toThrow(RangeError);
    expect(() => createCodec({ ...GAZA, offsetBytes: 4 as 2 })).toThrow(RangeError);
  });
});

describe("the points a phone sends", () => {
  it("is 7 bytes inside the box, 8 with a speed", () => {
    expect(codec.encodePoint({ lat: 31.51234567891234, lon: 34.45678912345678, ageSec: 3 }).length).toBe(7);
    const bytes = codec.encodePoint({ lat: 31.51234567891234, lon: 34.45678912345678, speed: 8.329999923706055, ageSec: 3.9 });
    expect(bytes.length).toBe(8);
    expect(codec.decodePoint(bytes)).toEqual({ lat: 31.51235, lon: 34.45679, speed: 8.25, ageSec: 3 });
  });

  it("carries a UUID id in 16 bytes (23 bytes in all)", () => {
    const id = "00000000-0000-4000-8000-0000000000c2";
    const bytes = codec.encodePoint({ lat: 31.52, lon: 34.44, ageSec: 2 }, id);
    expect(bytes.length).toBe(2 + 16 + 5);
    expect(codec.decodePoint(bytes)).toEqual({ id, lat: 31.52, lon: 34.44, ageSec: 2 });
    // Upper case travels as text and comes back unchanged.
    expect(codec.decodePoint(codec.encodePoint({ lat: 31.52, lon: 34.44, ageSec: 0 }, id.toUpperCase())).id).toBe(id.toUpperCase());
  });

  it("carries any other printable id as text", () => {
    const id = "cmuwxo0pw0003npyq8vi3ojyf";
    const bytes = codec.encodePoint({ lat: 31.52, lon: 34.44, ageSec: 0 }, id);
    expect(bytes.length).toBe(2 + 1 + id.length + 5);
    expect(codec.decodePoint(bytes)).toEqual({ id, lat: 31.52, lon: 34.44, ageSec: 0 });
    expect(() => codec.encodePoint({ lat: 31.5, lon: 34.4, ageSec: 0 }, "no spaces allowed")).toThrow(CodecError);
    expect(() => codec.encodePoint({ lat: 31.5, lon: 34.4, ageSec: 0 }, "x".repeat(65))).toThrow(CodecError);
  });

  it("a point is not a frame, and the other way round", () => {
    expect(() => codec.decodeFrame(codec.encodePoint({ lat: 31.5, lon: 34.4, ageSec: 0 }))).toThrow(CodecError);
    expect(() => codec.decodePoint(codec.encodeFrame([]))).toThrow(CodecError);
  });
});
