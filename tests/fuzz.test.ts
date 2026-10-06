import { describe, expect, it } from "vitest";
import { rng, syntheticFleet } from "../bench/synthetic.js";
import { CodecError, GAZA, createCodec, frameToPayload, type NumberedPoint } from "../src/index.js";

const T = Date.parse("2026-10-06T08:00:00.000Z");

describe("fuzz", () => {
  for (const [name, codec] of [
    ["default Gaza profile", createCodec(GAZA)],
    ["heading + 3-byte offsets", createCodec({ ...GAZA, heading: true, offsetBytes: 3, profile: 3 })],
  ] as const) {
    it(`${name}: random positions anywhere on earth round-trip (2,000 frames)`, () => {
      const r = rng(42);
      for (let round = 0; round < 2000; round++) {
        const count = Math.floor(r() * 12);
        const used = new Set<number>();
        const positions: NumberedPoint[] = [];
        for (let i = 0; i < count; i++) {
          const n = r() < 0.1 ? Math.floor(r() * 2 ** 40) : Math.floor(r() * 500);
          if (used.has(n)) continue;
          used.add(n);
          const inGaza = r() < 0.8;
          positions.push({
            n,
            lat: inGaza ? 31.21 + r() * 0.39 : (r() - 0.5) * 180,
            lon: inGaza ? 34.21 + r() * 0.36 : (r() - 0.5) * 360,
            speed: r() < 0.3 ? null : r() * 80,
            heading: r() < 0.5 ? null : r() * 720 - 360,
            at: T - Math.floor(r() * (r() < 0.1 ? 1e10 : 600_000)),
          });
        }
        const frame = codec.decodeFrame(codec.encodeFrame(positions, { serverTime: T }));
        expect(frame.points).toHaveLength(positions.length);
        for (const p of positions) {
          const got = frame.points.find((x) => x.n === p.n)!;
          expect(got.lat).toBeCloseTo(codec.round(p.lat), 9);
          expect(got.lon).toBeCloseTo(codec.round(p.lon), 9);
          if (p.speed == null) expect(got.speed).toBeUndefined();
          else expect(got.speed).toBeCloseTo(Math.min(63.75, Math.round(p.speed * 4) / 4), 9);
          if (codec.options.heading && p.heading != null) {
            const diff = Math.abs((((got.heading! - p.heading) % 360) + 540) % 360 - 180);
            expect(diff).toBeLessThanOrEqual(360 / 256);
          }
        }
      }
    });
  }

  it("random bytes and mutated frames only ever throw CodecError (20,000 inputs)", () => {
    const codec = createCodec(GAZA);
    const r = rng(7);
    const good = codec.encodeFrame(
      syntheticFleet(8, T).map((v, i) => ({ n: i + 1, lat: v.lat, lon: v.lon, speed: i, at: T })),
      { serverTime: T, json: { index: [[1, "a"]] } },
    );
    const point = codec.encodePoint({ lat: 31.5, lon: 34.4, speed: 3, ageSec: 2 });
    const withId = codec.encodePoint({ lat: 31.5, lon: 34.4, ageSec: 0 }, "cmuwxo0pw0003npyq8vi3ojyf");
    const withUuid = codec.encodePoint({ lat: 31.5, lon: 34.4, ageSec: 0 }, "00000000-0000-4000-8000-0000000000c2");
    let decoded = 0;
    for (let i = 0; i < 20_000; i++) {
      const source = [good, point, withId, withUuid][i % 4]!;
      const bytes = r() < 0.2 ? Uint8Array.from({ length: Math.floor(r() * 40) }, () => Math.floor(r() * 256)) : Uint8Array.from(source);
      for (let k = 0, flips = 1 + Math.floor(r() * 3); k < flips && bytes.length; k++) bytes[Math.floor(r() * bytes.length)] = Math.floor(r() * 256);
      const cut = r() < 0.2 ? bytes.subarray(0, Math.floor(r() * bytes.length)) : bytes;
      // Through frameToPayload too: whatever decodes must also become valid JSON records (valid dates).
      const viaRecords = (b: Uint8Array) => {
        const frame = codec.decodeFrame(b);
        frameToPayload(frame, (n) => `v${n}`);
        return frame.points;
      };
      for (const decode of [viaRecords, (b: Uint8Array) => [codec.decodePoint(b)]]) {
        try {
          for (const p of decode(cut)) {
            decoded++;
            expect(Math.abs(p.lat)).toBeLessThanOrEqual(90);
            expect(Math.abs(p.lon)).toBeLessThanOrEqual(180);
            expect(Number.isFinite(p.ageSec)).toBe(true);
          }
        } catch (error) {
          expect(error).toBeInstanceOf(CodecError);
        }
      }
    }
    expect(decoded).toBeGreaterThan(0); // some mutations are still valid frames, and stay valid points
  });

  it("hostile ages and server times are refused, not turned into invalid dates", () => {
    const codec = createCodec(GAZA);
    // header, profile, serverTime = 2^55 (beyond any Date)
    expect(() => codec.decodeFrame(Uint8Array.of(0x11, 0, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x40, 0, 0))).toThrow(CodecError);
    // a point whose age is 2^50 s
    const big = [0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x20];
    expect(() => codec.decodePoint(Uint8Array.of(0x12, 0, ...big, 0, 0, 0, 0))).toThrow(CodecError);
    expect(() => codec.encodeFrame([], { serverTime: Number.NaN })).toThrow(CodecError);
  });
});
