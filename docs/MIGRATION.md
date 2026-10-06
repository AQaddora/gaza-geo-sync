# Migrating a JSON positions sync to gaza-geo-sync

You have an endpoint that returns live positions as JSON, and clients that poll it. This guide
moves the positions to the binary frame **one safe step at a time**. After every step the app
works, old clients keep working, and you can stop.

Using Claude Code? Install the skills (see the README) and ask: *"migrate our positions endpoint
to gaza-geo-sync"* — the `binary-sync-migrate` skill follows this guide.

---

## Step 0 — Measure what you have

Write these down; you will compare against them at the end.

```bash
URL=http://localhost:3000/api/positions
curl -s -o /dev/null -w 'body %{size_download} B, headers %{size_header} B\n' \
  -H 'Accept-Encoding: gzip' "$URL"
```

- bytes per refresh (gzipped, as your proxy sends it) × refreshes per minute
- upload: body size, requests per minute moving and parked
- the **exact JSON shape** clients parse — this becomes the fallback contract and the offline-cache record

Typical starting point:

```json
{ "serverTime": "2026-10-06T08:00:00.000Z",
  "positions": [ { "id": "cm1x4k2ab0003npyq8vi3ojyf", "lat": 31.51234567891234, "lon": 34.45678912345678,
                   "speed": 8.329999923706055, "at": "2026-10-06T07:59:41.512Z" } ] }
```

## Step 1 — Free wins, still JSON

1. **Round coordinates** to 5 decimals (≈1.1 m, finer than phone GPS):
   `lat: codec.round(lat)`. On our synthetic fleet this alone cuts gzipped JSON by ~30%.
2. **Throttle uploads while standing still** (`worthSending` from the package): a parked vehicle
   sends once a minute instead of every 15 s. For small uploads this saves far more than any
   encoding, because each request carries hundreds of bytes of HTTP headers.

## Step 2 — Give every tracked object a stable small number

The binary frame names objects by a small integer `n` instead of a 25-character id.

```sql
-- Postgres (additive, existing rows get numbers automatically)
ALTER TABLE vehicles ADD COLUMN seq SERIAL UNIQUE;
```

Rules: a number is never reused for another id; numbers never change. Expose `n` in your JSON
object lists if clients load objects separately (Mishwar sends it with each vehicle).

## Step 3 — Install and share one codec

```bash
npm install github:AQaddora/gaza-geo-sync      # or vendor src/*.ts (zero dependencies)
```

Copy [`templates/geo-codec.ts`](../templates/geo-codec.ts) and set the south-west corner of your area.
Server and client import this same file.

## Step 4 — Server: negotiate, JSON stays the default

```ts
// before
return Response.json({ serverTime, positions });

// after
import { IndexTable } from "gaza-geo-sync";
import { positionsReply, toFetchResponse } from "gaza-geo-sync/server";

const table = new IndexTable(rows.map((r) => [r.seq, r.id]));
return toFetchResponse(positionsReply({
  codec,
  accept: request.headers.get("accept"),
  acceptEncoding: request.headers.get("accept-encoding"),
  positions: rows,                        // { id, lat, lon, speed, at }
  table,
  index: isFirstSync ? table.entries() : undefined,
  extra: { cursor },                      // anything else your response carries
}));
```

- No `Accept: application/octet-stream` → the same JSON as before (rounded). curl, old app
  versions, your monitoring: unchanged.
- With it → one frame: `extra` (+ `index`) as a JSON part, positions in binary, gzipped by the
  helper only when that is smaller (proxies usually skip `application/octet-stream`).
- `Vary: Accept, Accept-Encoding` is set, so caches never mix the forms.

Full files: [`templates/nextjs-route.ts`](../templates/nextjs-route.ts),
[`templates/express-server.ts`](../templates/express-server.ts).

Ship this. Nothing changes for anyone yet.

## Step 5 — Client: ask for binary, decode on arrival

```ts
// before
const body = await (await fetch(url)).json();
await cache.put(body.positions);

// after
import { fetchPositions } from "gaza-geo-sync";
const { payload, unknown } = await fetchPositions(url, { codec, idOf: (n) => index.get(n) });
for (const [n, id] of payload.index ?? []) index.set(n, id);   // remember the numbers
await cache.put(payload.positions);                              // same records as before
if (unknown > 0) cursor = null;                                  // a stranger: full sync next time
```

- `fetchPositions` sends `Accept: application/octet-stream, application/json;q=0.5`. A server that
  has not been updated answers JSON, and that is handled too.
- **Offline cache:** it resolves to the JSON shape whichever format travelled, so IndexedDB / your
  store keeps identical records and every screen reads what it read before.
- **Bump your local cache schema version once** so installed clients do one full sync and learn every number.

Hook version: [`templates/use-live-positions.ts`](../templates/use-live-positions.ts).

## Step 6 — Uploads (driver / shared location)

Server accepts both bodies:

```ts
const read = readPointBody(codec, request.headers.get("content-type"), new Uint8Array(await request.arrayBuffer()));
if (!read.ok) return Response.json({ error: read.error }, { status: 400 });
// read.point = { lat, lon, speed?, ageSec, id? } — ageSec gives the fix's own time
return read.binary ? new Response(null, { status: 204 }) : Response.json({ ok: true });
```

Client:

```ts
const sender = createPointSender({ url: "/api/position", codec });
navigator.geolocation.watchPosition((p) => sender.offer({
  lat: p.coords.latitude, lon: p.coords.longitude, speed: p.coords.speed, fixAt: p.timestamp }));
```

Binary first; a 400/415 from a server that does not speak it switches to JSON for good.
Never queue positions in an offline outbox: a stale point is worse than none.

## Step 7 — Service worker

Network-only for both endpoints; no Cache Storage for live positions
([`templates/service-worker-cache.js`](../templates/service-worker-cache.js)).

## Step 8 — Prove it

- Tests: the same server state through both `Accept` values gives the same records
  (see `tests/sync.test.ts`).
- Bytes: repeat Step 0 with `-H 'Accept: application/octet-stream'`.
- Report before/after per refresh **and** per minute, and say where it did not help.

## What not to migrate

Text-heavy or diffed data — chat, bookings, descriptions, routes with names — compresses well as
gzipped JSON and changes rarely. Keep it JSON (it can ride in the frame's JSON part).

## Rolling back

Remove the `Accept` header on the client (or ignore it on the server). Everything is JSON again;
the `seq` column is harmless.
