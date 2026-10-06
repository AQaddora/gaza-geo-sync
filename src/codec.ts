// A compact binary form for live positions (vehicles on a map, a phone's GPS point).
//
// Three ideas do almost all the work:
//   1. Quantise. A coordinate is a whole number of 1/scale degree (default 1e-5° ≈ 1.1 m,
//      finer than phone GPS), stored as an unsigned offset from the south-west corner of
//      the area most points fall in: 2 bytes per axis. A point outside that box still
//      works, as two zigzag varints of absolute units.
//   2. Index, don't repeat. Each object (vehicle, courier, phone) gets a small number once,
//      in the JSON part or an earlier response; after that positions carry only the number,
//      sorted and sent as gaps (1 byte each, usually).
//   3. Ages, not timestamps. A time is "whole seconds before the frame's serverTime" (1 byte).
//
// Layouts (format version 1). varint = unsigned LEB128, uintN = big-endian.
//   header:  u8 (version << 4 | kind) · u8 profile
//   point:   varint head = age·F + flags   (F = 8 with heading enabled, else 4)
//              flags: 1 = speed present, 2 = outside the box, 4 = heading present
//            inside:  uintB dLat · uintB dLon   (B = offsetBytes, 2 or 3)
//            outside: zigzag lat · zigzag lon     (absolute units)
//            speed:   u8 (speed / speedStep, capped at 255)
//            heading: u8 (degrees · 256 / 360)
//   kind 1, sync frame:  header · varint serverTimeMs · varint jsonLength · JSON (UTF-8)
//                        · varint count · count × (varint gap in n · point)
//   kind 2, point:       header · point
//   kind 3, point + id:  header · 16-byte UUID · point
//   kind 4, point + id:  header · u8 length (1–64) · ASCII id · point
//
// A decoder never trusts its input: reads are bounds-checked, lengths capped, leftovers
// refused, and every failure is a CodecError.
import { CodecError, Reader, Writer } from "./bytes.js";

export { CodecError } from "./bytes.js";

/** Media type of every binary body. */
export const BINARY_TYPE = "application/octet-stream";
/** Format version written in every header. */
export const FORMAT_VERSION = 1;

const KIND_FRAME = 1;
const KIND_POINT = 2;
const KIND_POINT_UUID = 3;
const KIND_POINT_TEXT = 4;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TEXT_ID = /^[\x21-\x7e]{1,64}$/;
const MAX_JSON = 4 * 1024 * 1024;
const MAX_POINTS = 100_000;
/** Ages above this (≈136 years) are refused, so every decoded time is a valid Date. */
const MAX_AGE_SEC = 2 ** 32;
/** Largest epoch ms a JavaScript Date can hold. */
const MAX_TIME_MS = 8.64e15;

export interface CodecOptions {
  /** South-west corner (degrees) of the area most points fall in. */
  south: number;
  west: number;
  /** Units per degree. 1e5 (default) ≈ 1.1 m; 1e4 ≈ 11 m; 1e6 ≈ 0.11 m. */
  scale?: number;
  /** Bytes per in-box offset: 2 (default) or 3. The box is (256^B − 1) / scale degrees wide. */
  offsetBytes?: 2 | 3;
  /** Speed resolution in m/s (default 0.25 → 0–63.75 m/s). 0 leaves speed out. */
  speedStep?: number;
  /** Carry a heading byte (≈1.4° resolution). Default false. */
  heading?: boolean;
  /** 0–255, written in every header; a decoder refuses another profile. Default 0. */
  profile?: number;
}

/** One position as your app sees it. */
export interface Point {
  lat: number;
  lon: number;
  /** m/s, optional. */
  speed?: number | null;
  /** Degrees clockwise from north, optional. */
  heading?: number | null;
  /** Seconds before the reference time (the frame's serverTime, or "now" for an upload). */
  ageSec: number;
}

/** A position with its object's small number, for a sync frame. */
export interface NumberedPoint {
  n: number;
  lat: number;
  lon: number;
  speed?: number | null;
  heading?: number | null;
  /** When the fix was taken: Date or epoch ms. */
  at: Date | number;
}

export interface DecodedPoint extends Point {
  n: number;
  /** Epoch ms: serverTime − ageSec. */
  at: number;
}

export interface Frame<J = unknown> {
  serverTime: number;
  json: J | undefined;
  points: DecodedPoint[];
}

export type Codec = ReturnType<typeof createCodec>;

const validLatLon = (lat: number, lon: number) =>
  Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180;

export function createCodec(options: CodecOptions) {
  const scale = options.scale ?? 1e5;
  const offsetBytes = options.offsetBytes ?? 2;
  const speedStep = options.speedStep ?? 0.25;
  const withHeading = options.heading ?? false;
  const profile = options.profile ?? 0;
  if (!(scale > 0) || !Number.isFinite(scale)) throw new RangeError("scale must be a positive number");
  if (offsetBytes !== 2 && offsetBytes !== 3) throw new RangeError("offsetBytes must be 2 or 3");
  if (!(speedStep >= 0)) throw new RangeError("speedStep must be ≥ 0");
  if (!Number.isInteger(profile) || profile < 0 || profile > 255) throw new RangeError("profile must be 0–255");
  if (!validLatLon(options.south, options.west)) throw new RangeError("bad origin");
  // Absolute coordinates as integers must stay safe: 180 · scale < 2^52.
  if (180 * scale > 2 ** 52) throw new RangeError("scale too large");

  const originLat = Math.round(options.south * scale);
  const originLon = Math.round(options.west * scale);
  const maxOffset = 256 ** offsetBytes - 1;
  const flagSpan = withHeading ? 8 : 4;

  const quantise = (deg: number) => Math.round(deg * scale);
  const round = (deg: number) => quantise(deg) / scale;

  function writePoint(w: Writer, p: Point) {
    if (!validLatLon(p.lat, p.lon)) throw new CodecError("bad coordinates");
    const lat = quantise(p.lat);
    const lon = quantise(p.lon);
    const dLat = lat - originLat;
    const dLon = lon - originLon;
    const inside = dLat >= 0 && dLat <= maxOffset && dLon >= 0 && dLon <= maxOffset;
    const hasSpeed = speedStep > 0 && p.speed != null && Number.isFinite(p.speed) && p.speed >= 0;
    const hasHeading = withHeading && p.heading != null && Number.isFinite(p.heading);
    const age = Number.isFinite(p.ageSec) ? Math.min(MAX_AGE_SEC, Math.max(0, Math.floor(p.ageSec))) : 0;
    w.varint(age * flagSpan + (hasHeading ? 4 : 0) + (inside ? 0 : 2) + (hasSpeed ? 1 : 0));
    if (inside) {
      w.uint(dLat, offsetBytes);
      w.uint(dLon, offsetBytes);
    } else {
      w.zigzag(lat);
      w.zigzag(lon);
    }
    if (hasSpeed) w.u8(Math.min(255, Math.round((p.speed as number) / speedStep)));
    if (hasHeading) w.u8(Math.round(((((p.heading as number) % 360) + 360) % 360) * (256 / 360)) & 0xff);
  }

  function readPoint(r: Reader): Point {
    const head = r.varint();
    const flags = head % flagSpan;
    const ageSec = Math.floor(head / flagSpan);
    if (ageSec > MAX_AGE_SEC) throw new CodecError("age too large");
    const hasSpeed = (flags & 1) !== 0;
    const outside = (flags & 2) !== 0;
    const hasHeading = (flags & 4) !== 0;
    if (hasSpeed && speedStep === 0) throw new CodecError("speed not in this profile");
    const lat = outside ? r.zigzag() : originLat + r.uint(offsetBytes);
    const lon = outside ? r.zigzag() : originLon + r.uint(offsetBytes);
    if (!validLatLon(lat / scale, lon / scale)) throw new CodecError("bad coordinates");
    const point: Point = { lat: lat / scale, lon: lon / scale, ageSec };
    if (hasSpeed) point.speed = r.u8() * speedStep;
    if (hasHeading) point.heading = (r.u8() * 360) / 256;
    return point;
  }

  function writeHeader(w: Writer, kind: number) {
    w.u8((FORMAT_VERSION << 4) | kind);
    w.u8(profile);
  }

  function readHeader(r: Reader): number {
    const byte = r.u8();
    if (byte >> 4 !== FORMAT_VERSION) throw new CodecError(`unknown version ${byte >> 4}`);
    if (r.u8() !== profile) throw new CodecError("another profile");
    return byte & 0x0f;
  }

  /**
   * A sync frame: the positions in binary, plus (optionally) any JSON your response
   * already carries. `serverTime` is the reference for every age.
   */
  function encodeFrame(positions: NumberedPoint[], opts: { serverTime?: number; json?: unknown } = {}): Uint8Array {
    const serverTime = Math.floor(opts.serverTime ?? Date.now());
    if (!(serverTime >= 0 && serverTime <= MAX_TIME_MS)) throw new CodecError("bad serverTime");
    const json = opts.json === undefined ? new Uint8Array() : new TextEncoder().encode(JSON.stringify(opts.json));
    if (json.length > MAX_JSON) throw new CodecError("json too long");
    const w = new Writer();
    writeHeader(w, KIND_FRAME);
    w.varint(serverTime);
    w.varint(json.length);
    w.raw(json);
    const sorted = [...positions].sort((a, b) => a.n - b.n);
    w.varint(sorted.length);
    let previous = 0;
    for (const [i, p] of sorted.entries()) {
      if (!Number.isSafeInteger(p.n) || p.n < 0 || (i > 0 && p.n <= previous)) throw new CodecError(`bad or repeated number ${p.n}`);
      w.varint(p.n - previous);
      previous = p.n;
      const at = typeof p.at === "number" ? p.at : p.at.getTime();
      writePoint(w, { lat: p.lat, lon: p.lon, speed: p.speed, heading: p.heading, ageSec: Math.max(0, (serverTime - at) / 1000) });
    }
    return w.done();
  }

  function decodeFrame<J = unknown>(bytes: Uint8Array): Frame<J> {
    const r = new Reader(bytes);
    if (readHeader(r) !== KIND_FRAME) throw new CodecError("not a sync frame");
    const serverTime = r.varint();
    if (serverTime > MAX_TIME_MS) throw new CodecError("bad serverTime");
    const length = r.varint();
    if (length > MAX_JSON) throw new CodecError("json too long");
    let json: J | undefined;
    if (length > 0) {
      try {
        json = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(r.bytes(length))) as J;
      } catch (error) {
        throw error instanceof CodecError ? error : new CodecError("bad json part");
      }
    }
    const count = r.varint();
    if (count > MAX_POINTS) throw new CodecError("too many points");
    const points: DecodedPoint[] = [];
    let n = 0;
    for (let i = 0; i < count; i++) {
      const gap = r.varint();
      if (i > 0 && gap === 0) throw new CodecError("repeated number");
      n += gap;
      if (!Number.isSafeInteger(n)) throw new CodecError("number too large");
      const p = readPoint(r);
      points.push({ n, ...p, at: serverTime - p.ageSec * 1000 });
    }
    r.end();
    return { serverTime, json, points };
  }

  /** One point a phone sends (a driver's GPS fix, a shared location), with an optional id. */
  function encodePoint(p: Point, id?: string): Uint8Array {
    const w = new Writer();
    if (id === undefined) {
      writeHeader(w, KIND_POINT);
    } else if (UUID.test(id)) {
      // A lowercase UUID travels as its 16 bytes instead of 36 characters.
      writeHeader(w, KIND_POINT_UUID);
      const hex = id.replace(/-/g, "");
      for (let i = 0; i < 32; i += 2) w.u8(parseInt(hex.slice(i, i + 2), 16));
    } else {
      if (!TEXT_ID.test(id)) throw new CodecError("bad id");
      writeHeader(w, KIND_POINT_TEXT);
      w.u8(id.length);
      w.raw(new TextEncoder().encode(id));
    }
    writePoint(w, p);
    return w.done();
  }

  function decodePoint(bytes: Uint8Array): Point & { id?: string } {
    const r = new Reader(bytes);
    const kind = readHeader(r);
    let id: string | undefined;
    if (kind === KIND_POINT_UUID) {
      const hex = Array.from(r.bytes(16), (b) => b.toString(16).padStart(2, "0")).join("");
      id = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    } else if (kind === KIND_POINT_TEXT) {
      const length = r.u8();
      if (length < 1 || length > 64) throw new CodecError("bad id");
      id = String.fromCharCode(...r.bytes(length));
      if (!TEXT_ID.test(id)) throw new CodecError("bad id");
    } else if (kind !== KIND_POINT) {
      throw new CodecError("not a point");
    }
    const p = readPoint(r);
    r.end();
    return id === undefined ? p : { id, ...p };
  }

  return {
    options: { south: options.south, west: options.west, scale, offsetBytes, speedStep, heading: withHeading, profile },
    /** The box points are cheapest in: [south, west, north, east]. */
    box: [originLat / scale, originLon / scale, (originLat + maxOffset) / scale, (originLon + maxOffset) / scale] as const,
    /** Rounds a coordinate exactly as the codec will (use it for the JSON form too). */
    round,
    encodeFrame,
    decodeFrame,
    encodePoint,
    decodePoint,
  };
}

/** The Gaza Strip: a 2-byte box from 31.2°N 34.2°E covers it with room to spare (≈73 km north–south, ≈62 km east–west). */
export const GAZA = { south: 31.2, west: 34.2 } as const;
