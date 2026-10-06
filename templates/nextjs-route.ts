// templates/nextjs-route.ts — Next.js App Router: app/api/positions/route.ts
// GET /api/positions?since=<cursor>  → JSON by default, binary when the client asks.
import { IndexTable } from "gaza-geo-sync";
import { positionsReply, toFetchResponse } from "gaza-geo-sync/server";
import { codec } from "@/lib/geo-codec";

export const dynamic = "force-dynamic";

// Replace with your data access. `n` must be stable per id: back it with a DB column
// (e.g. Postgres `seq SERIAL UNIQUE` on your vehicles table) and load it here.
async function loadLive(): Promise<{ id: string; n: number; lat: number; lon: number; speed: number | null; at: Date }[]> {
  return [];
}

export async function GET(request: Request): Promise<Response> {
  const since = new URL(request.url).searchParams.get("since");
  const live = await loadLive();
  const table = new IndexTable(live.map((v) => [v.n, v.id] as [number, string]));
  return toFetchResponse(
    positionsReply({
      codec,
      accept: request.headers.get("accept"),
      acceptEncoding: request.headers.get("accept-encoding"),
      positions: live,
      table,
      // A first sync (no cursor) teaches the client every number. Afterwards send only the
      // new ones (here: all, which is simple and still small; optimise when it matters).
      index: since ? undefined : table.entries(),
      extra: { cursor: new Date().toISOString() },
    }),
  );
}
