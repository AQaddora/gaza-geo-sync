// templates/nextjs-point-route.ts — Next.js App Router: app/api/position/route.ts
// POST one GPS point: 8 bytes of application/octet-stream, or JSON {lat, lon, speed} as before.
import { readPointBody } from "gaza-geo-sync/server";
import { codec } from "@/lib/geo-codec";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  // Authenticate first, as your existing route does.
  const read = readPointBody(codec, request.headers.get("content-type"), new Uint8Array(await request.arrayBuffer()));
  if (!read.ok) return Response.json({ error: read.error }, { status: 400 }); // a 400 makes old clients fall back to JSON
  const { lat, lon, speed, ageSec } = read.point;
  const at = new Date(Date.now() - Math.min(ageSec, 60) * 1000); // the fix's own time
  void { lat, lon, speed, at }; // save it: upsert one row per vehicle
  // Binary callers get an empty 204 (no `{"ok":true}` to download); JSON callers what they had.
  return read.binary ? new Response(null, { status: 204 }) : Response.json({ ok: true });
}
