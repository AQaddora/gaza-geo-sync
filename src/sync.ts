// The parts both sides share: the JSON shape of a position (the fallback and the offline
// cache), the index table that gives each object its small number, content negotiation,
// and the standing-still throttle for uploads.
import { BINARY_TYPE, type Codec, type Frame } from "./codec.js";

/**
 * One position as JSON. The JSON fallback carries these, and the binary path decodes into
 * exactly these, so whatever stores them (IndexedDB, a cache, a screen) never knows which
 * format travelled.
 */
export interface PositionRecord {
  id: string;
  lat: number;
  lon: number;
  speed?: number;
  heading?: number;
  /** ISO time of the fix. */
  at: string;
}

/**
 * The response of a positions endpoint, in its JSON form. `index` lists [n, id] pairs the
 * client may not know yet (send all of them on a first sync, new ones afterwards).
 */
export interface PositionsPayload {
  serverTime: string;
  positions: PositionRecord[];
  index?: [number, string][];
  [extra: string]: unknown;
}

/**
 * Small, stable numbers for ids. On a server, back it with a database column (a SERIAL or
 * an identity column) so numbers survive restarts; this in-memory one is for tests,
 * single-process servers and clients.
 */
export class IndexTable {
  private byId = new Map<string, number>();
  private byN = new Map<number, string>();
  private next = 1;

  constructor(entries: Iterable<[number, string]> = []) {
    for (const [n, id] of entries) this.set(n, id);
  }

  set(n: number, id: string) {
    if (!Number.isSafeInteger(n) || n < 0) throw new RangeError(`bad number ${n}`);
    const old = this.byN.get(n);
    if (old !== undefined && old !== id) this.byId.delete(old);
    this.byId.set(id, n);
    this.byN.set(n, id);
    this.next = Math.max(this.next, n + 1);
  }

  /** The id's number, assigning the next free one the first time. */
  assign(id: string): number {
    const known = this.byId.get(id);
    if (known !== undefined) return known;
    const n = this.next++;
    this.set(n, id);
    return n;
  }

  numberOf(id: string): number | undefined {
    return this.byId.get(id);
  }

  idOf(n: number): string | undefined {
    return this.byN.get(n);
  }

  entries(): [number, string][] {
    return [...this.byN.entries()].sort((a, b) => a[0] - b[0]);
  }

  get size() {
    return this.byN.size;
  }
}

/**
 * Turns a decoded frame into the JSON payload shape. Ids come from the frame's own index
 * first, then from `idOf` (the client's stored table). Positions of numbers nobody knows
 * are dropped and counted: the client should ask for a full sync next time.
 */
export function frameToPayload(frame: Frame, idOf: (n: number) => string | undefined): { payload: PositionsPayload; unknown: number } {
  const json = frame.json && typeof frame.json === "object" && !Array.isArray(frame.json) ? (frame.json as Record<string, unknown>) : {};
  const index = Array.isArray(json.index) ? (json.index as [number, string][]) : [];
  const fromFrame = new Map(index.filter((e) => Array.isArray(e) && typeof e[0] === "number" && typeof e[1] === "string"));
  const positions: PositionRecord[] = [];
  let unknown = 0;
  for (const p of frame.points) {
    const id = fromFrame.get(p.n) ?? idOf(p.n);
    if (id === undefined) {
      unknown++;
      continue;
    }
    const record: PositionRecord = { id, lat: p.lat, lon: p.lon, at: new Date(p.at).toISOString() };
    if (p.speed != null) record.speed = p.speed;
    if (p.heading != null) record.heading = p.heading;
    positions.push(record);
  }
  return { payload: { ...json, serverTime: new Date(frame.serverTime).toISOString(), positions }, unknown };
}

/** The JSON form of a set of positions, rounded exactly as the binary form would be. */
export function toRecords(codec: Codec, positions: { id: string; lat: number; lon: number; speed?: number | null; heading?: number | null; at: Date | number }[]): PositionRecord[] {
  return positions.map((p) => {
    const r: PositionRecord = { id: p.id, lat: codec.round(p.lat), lon: codec.round(p.lon), at: new Date(p.at).toISOString() };
    if (p.speed != null && Number.isFinite(p.speed)) r.speed = Math.round(p.speed * 100) / 100;
    if (p.heading != null && Number.isFinite(p.heading)) r.heading = Math.round(p.heading);
    return r;
  });
}

// ---- Content negotiation ----

/** True when an Accept header asks for the binary form. JSON stays the default. */
export function wantsBinary(accept: string | null | undefined): boolean {
  return (accept ?? "").toLowerCase().split(",").some((part) => {
    const [type, ...params] = part.trim().split(";");
    if (type?.trim() !== BINARY_TYPE) return false;
    const q = params.map((s) => s.trim()).find((s) => s.startsWith("q="));
    return q === undefined || Number(q.slice(2)) > 0;
  });
}

/** True when a Content-Type header says the body is binary. */
export function sentBinary(contentType: string | null | undefined): boolean {
  return (contentType ?? "").toLowerCase().trim().startsWith(BINARY_TYPE);
}

// ---- When a phone sends its next point ----

/** Moved at least this far since the last point sent: send now. */
export const SEND_MIN_METERS = 15;
/** Standing still: still send this often, so the point never looks lost. */
export const SEND_HEARTBEAT_MS = 60_000;

/** Approximate distance in metres (equirectangular; plenty for a 15 m threshold). */
export function distanceMeters(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const dy = (b.lat - a.lat) * 111_320;
  const dx = (b.lon - a.lon) * 111_320 * Math.cos((((a.lat + b.lat) / 2) * Math.PI) / 180);
  return Math.hypot(dx, dy);
}

/**
 * The standing-still throttle: a parked vehicle sends one point a minute instead of one
 * every 15 s, because the same place again tells nobody anything new.
 */
export function worthSending(
  last: { lat: number; lon: number; sentAt: number } | null,
  next: { lat: number; lon: number },
  now: number,
  opts: { minMeters?: number; heartbeatMs?: number } = {},
): boolean {
  if (!last || now - last.sentAt >= (opts.heartbeatMs ?? SEND_HEARTBEAT_MS)) return true;
  return distanceMeters(last, next) >= (opts.minMeters ?? SEND_MIN_METERS);
}

/** How old a GPS fix is, in seconds, from its own timestamp (clamped to 0–max). */
export function fixAgeSec(fixAt: number, now: number, max = 60): number {
  return Number.isFinite(fixAt) ? Math.min(max, Math.max(0, (now - fixAt) / 1000)) : 0;
}
