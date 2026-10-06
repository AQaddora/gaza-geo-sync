// Server helpers (Node). Framework-agnostic core plus thin adapters for the Fetch API
// (Next.js route handlers, Hono, Bun, Deno) and Express. Import from "gaza-geo-sync/server".
import { gzipSync } from "node:zlib";
import { BINARY_TYPE, CodecError, type Codec, type Point } from "./codec.js";
import { IndexTable, sentBinary, toRecords, wantsBinary, type PositionsPayload } from "./sync.js";

export interface LivePosition {
  id: string;
  lat: number;
  lon: number;
  speed?: number | null;
  heading?: number | null;
  at: Date | number;
}

export interface PositionsReply {
  status: number;
  headers: Record<string, string>;
  body: Uint8Array | string;
  /** Which form was chosen, for logs and tests. */
  form: "json" | "binary" | "binary+gzip";
}

/**
 * Builds the reply to a positions request.
 * - No `Accept: application/octet-stream` → the JSON payload (old clients, curl, debugging).
 *   Leave its compression to your proxy or framework, as today.
 * - Otherwise → one binary frame: `extra` (+ `index` when given) as the JSON part, the
 *   positions in binary. Gzipped here when the client accepts it and it is smaller, since
 *   many proxies do not compress application/octet-stream.
 */
export function positionsReply(input: {
  codec: Codec;
  accept: string | null | undefined;
  acceptEncoding?: string | null;
  positions: LivePosition[];
  /** Numbers for ids. Positions whose id has no number are numbered here (assign). */
  table: IndexTable;
  /** [n, id] pairs this client needs (all of them on a first sync). Defaults to none. */
  index?: [number, string][];
  /** Anything else your response carries (bookings, cursors...). */
  extra?: Record<string, unknown>;
  now?: number;
}): PositionsReply {
  const now = input.now ?? Date.now();
  const extra = { ...(input.extra ?? {}), ...(input.index && input.index.length ? { index: input.index } : {}) };
  const vary = "Accept, Accept-Encoding";
  if (!wantsBinary(input.accept)) {
    const payload: PositionsPayload = { ...extra, serverTime: new Date(now).toISOString(), positions: toRecords(input.codec, input.positions) };
    return { status: 200, form: "json", headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", Vary: vary }, body: JSON.stringify(payload) };
  }
  const numbered = input.positions.map((p) => ({ ...p, n: input.table.assign(p.id) }));
  const frame = input.codec.encodeFrame(numbered, { serverTime: now, json: Object.keys(extra).length ? extra : undefined });
  const headers: Record<string, string> = { "Content-Type": BINARY_TYPE, "Cache-Control": "no-store", Vary: vary };
  if (/\bgzip\b/i.test(input.acceptEncoding ?? "")) {
    const zipped = gzipSync(frame);
    if (zipped.length < frame.length) return { status: 200, form: "binary+gzip", headers: { ...headers, "Content-Encoding": "gzip" }, body: new Uint8Array(zipped) };
  }
  return { status: 200, form: "binary", headers, body: frame };
}

/** Reads one uploaded point: binary (Content-Type octet-stream) or JSON {lat, lon, speed?, heading?, id?}. */
export function readPointBody(
  codec: Codec,
  contentType: string | null | undefined,
  body: Uint8Array | string,
): { ok: true; point: Point & { id?: string }; binary: boolean } | { ok: false; error: string } {
  try {
    if (sentBinary(contentType)) {
      const bytes = typeof body === "string" ? new TextEncoder().encode(body) : body;
      return { ok: true, binary: true, point: codec.decodePoint(bytes) };
    }
    const json = JSON.parse(typeof body === "string" ? body : new TextDecoder().decode(body)) as Record<string, unknown>;
    const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
    const lat = num(json.lat);
    const lon = num(json.lon);
    if (lat === undefined || lon === undefined || Math.abs(lat) > 90 || Math.abs(lon) > 180) return { ok: false, error: "bad_position" };
    const point: Point & { id?: string } = { lat, lon, ageSec: num(json.ageSec) ?? 0 };
    if (num(json.speed) !== undefined) point.speed = num(json.speed);
    if (num(json.heading) !== undefined) point.heading = num(json.heading);
    if (typeof json.id === "string") point.id = json.id;
    return { ok: true, binary: false, point };
  } catch (error) {
    return { ok: false, error: error instanceof CodecError ? "bad_body" : "bad_json" };
  }
}

/** Fetch API adapter (Next.js App Router, Hono, Bun, Deno, Cloudflare Workers with nodejs_compat). */
export function toFetchResponse(reply: PositionsReply): Response {
  return new Response(reply.body as BodyInit, { status: reply.status, headers: reply.headers });
}

/** Express / Node http adapter: `sendReply(res, reply)`. */
export function sendReply(
  res: { statusCode: number; setHeader(name: string, value: string): unknown; end(body?: Uint8Array | string): unknown },
  reply: PositionsReply,
) {
  res.statusCode = reply.status;
  for (const [k, v] of Object.entries(reply.headers)) res.setHeader(k, v);
  res.end(reply.body);
}
