// Browser (or any fetch) helpers: pull positions with JSON fallback, and send a phone's
// point with the standing-still throttle and a JSON fallback for servers that refuse binary.
//
// Offline cache: decode on arrival. `fetchPositions` always resolves to the JSON payload
// shape (PositionsPayload), whatever travelled, so your IndexedDB / Cache Storage keeps the
// same records as before and every screen reads what it read before. Store the index pairs
// (payload.index) next to them: the next binary frame needs them to name its points.
import { BINARY_TYPE, type Codec, type Point } from "./codec.js";
import { fixAgeSec, frameToPayload, worthSending, type PositionsPayload } from "./sync.js";

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

/** Accept header: binary when the server has it, JSON from an older server is fine too. */
export const ACCEPT_BINARY = `${BINARY_TYPE}, application/json;q=0.5`;

export interface FetchPositionsResult {
  payload: PositionsPayload;
  /** True when the server answered in binary. */
  binary: boolean;
  /** Points whose number this client does not know (ask for a full sync when > 0). */
  unknown: number;
}

export async function fetchPositions(
  url: string,
  opts: { codec: Codec; idOf: (n: number) => string | undefined; fetch?: Fetch; init?: RequestInit; binary?: boolean },
): Promise<FetchPositionsResult> {
  const doFetch = opts.fetch ?? fetch;
  const headers = new Headers(opts.init?.headers);
  headers.set("accept", opts.binary === false ? "application/json" : ACCEPT_BINARY);
  const response = await doFetch(url, { cache: "no-store", ...opts.init, headers });
  if (!response.ok) throw new Error(`positions: HTTP ${response.status}`);
  if (!(response.headers.get("content-type") ?? "").toLowerCase().startsWith(BINARY_TYPE)) {
    return { payload: (await response.json()) as PositionsPayload, binary: false, unknown: 0 };
  }
  const frame = opts.codec.decodeFrame(new Uint8Array(await response.arrayBuffer()));
  const { payload, unknown } = frameToPayload(frame, opts.idOf);
  return { payload, binary: true, unknown };
}

export interface Fix {
  lat: number;
  lon: number;
  speed?: number | null;
  heading?: number | null;
  /** The GPS fix's own timestamp (GeolocationPosition.timestamp), epoch ms. */
  fixAt: number;
}

export type SendOutcome = "sent" | "skipped" | "failed";

/**
 * Sends a phone's points. Call `offer(fix)` on every GPS fix or timer tick; it sends at most
 * once per minIntervalMs (default 15 s), and then only when the phone moved ≥ minMeters
 * (default 15 m) or heartbeatMs (default 60 s) passed. Binary first; a 400/415 from a
 * server that does not speak it switches this sender to JSON for good.
 * Positions are never queued offline: a point that could not be sent is replaced by the next.
 */
export function createPointSender(opts: {
  url: string;
  codec: Codec;
  id?: string;
  fetch?: Fetch;
  minMeters?: number;
  heartbeatMs?: number;
  minIntervalMs?: number;
  init?: RequestInit;
  now?: () => number;
}) {
  const doFetch = opts.fetch ?? fetch;
  const now = opts.now ?? Date.now;
  let json = false;
  let last: { lat: number; lon: number; sentAt: number } | null = null;

  const send = (fix: Fix) => {
    const point: Point = { lat: fix.lat, lon: fix.lon, speed: fix.speed, heading: fix.heading, ageSec: fixAgeSec(fix.fixAt, now()) };
    const headers = new Headers(opts.init?.headers);
    headers.set("content-type", json ? "application/json" : BINARY_TYPE);
    const body = json ? JSON.stringify({ ...point, ...(opts.id ? { id: opts.id } : {}) }) : opts.codec.encodePoint(point, opts.id);
    return doFetch(opts.url, { method: "POST", ...opts.init, headers, body: body as BodyInit });
  };

  return {
    get usingJson() {
      return json;
    },
    /** Forget the last point (e.g. a new trip starts): the next offer always sends. */
    reset() {
      last = null;
    },
    async offer(fix: Fix): Promise<SendOutcome> {
      const t = now();
      if (last && t - last.sentAt < (opts.minIntervalMs ?? 15_000)) return "skipped";
      if (!worthSending(last, fix, t, { minMeters: opts.minMeters, heartbeatMs: opts.heartbeatMs })) return "skipped";
      try {
        let response = await send(fix);
        if (!json && (response.status === 400 || response.status === 415)) {
          json = true;
          response = await send(fix);
        }
        if (!response.ok) return "failed";
        last = { lat: fix.lat, lon: fix.lon, sentAt: t };
        return "sent";
      } catch {
        return "failed";
      }
    },
  };
}
