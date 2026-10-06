// Simulation server: serves the page, the library build (dist/) and SYNTHETIC positions in
// JSON (gzip level 6, as a proxy would) or binary, and counts the bytes each request
// really put on the socket (HTTP headers + body, not TCP/IP framing).
// Run: npx tsx bench/sim/server.ts [host] [port]
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { gzipSync } from "node:zlib";
import { GAZA, IndexTable, createCodec } from "../../src/index.js";
import { positionsReply, readPointBody, sendReply } from "../../src/server.js";
import { step, syntheticFleet, type SyntheticVehicle } from "../synthetic.js";

const host = process.argv[2] ?? "127.0.0.1";
const port = Number(process.argv[3] ?? 8080);
const root = new URL("../../", import.meta.url);
const codec = createCodec(GAZA);

const fleets = new Map<number, { base: SyntheticVehicle[]; table: IndexTable; tick: number }>();
function fleetFor(n: number) {
  let f = fleets.get(n);
  if (!f) {
    const base = syntheticFleet(n, Date.now(), 1000 + n);
    f = { base, table: new IndexTable(base.map((v, i) => [i + 1, v.id] as [number, string])), tick: 0 };
    fleets.set(n, f);
  }
  return f;
}

const stats = new Map<string, { reqBytes: number; resBytes: number; status: number; form: string; bodyBytes: number }>();
const last = new WeakMap<Socket, { read: number; written: number }>();

function account(req: IncomingMessage, res: ServerResponse, rid: string | null, form: string, bodyBytes: number) {
  res.on("finish", () => {
    const s = req.socket;
    const prev = last.get(s) ?? { read: 0, written: 0 };
    const now = { read: s.bytesRead, written: s.bytesWritten };
    last.set(s, now);
    if (rid) stats.set(rid, { reqBytes: now.read - prev.read, resBytes: now.written - prev.written, status: res.statusCode, form, bodyBytes });
  });
}

const statics: Record<string, [string, string]> = {
  "/": ["bench/sim/page.html", "text/html; charset=utf-8"],
  "/page.js": ["bench/sim/page.js", "text/javascript"],
};

createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  const rid = url.searchParams.get("rid");
  if (statics[url.pathname]) {
    const [file, type] = statics[url.pathname]!;
    account(req, res, null, "static", 0);
    res.setHeader("content-type", type);
    res.setHeader("cache-control", "no-store");
    return res.end(readFileSync(new URL(file, root)));
  }
  if (url.pathname.startsWith("/lib/")) {
    account(req, res, null, "static", 0);
    res.setHeader("content-type", "text/javascript");
    return res.end(readFileSync(new URL(`dist/${url.pathname.slice(5).replace(/[^a-z.-]/g, "")}`, root)));
  }
  if (url.pathname === "/positions") {
    const n = Number(url.searchParams.get("n") ?? 50);
    const f = fleetFor(n);
    const now = Date.now();
    const positions = step(f.base, now, ++f.tick * 15_000, f.tick);
    const reply = positionsReply({
      codec,
      accept: req.headers.accept,
      acceptEncoding: req.headers["accept-encoding"] as string | undefined,
      positions,
      table: f.table,
      index: url.searchParams.get("first") ? f.table.entries() : undefined,
      now,
    });
    let body = reply.body;
    const headers = { ...reply.headers };
    // JSON is compressed the way a proxy (nginx gzip on) would do it.
    if (reply.form === "json" && /\bgzip\b/.test(String(req.headers["accept-encoding"] ?? ""))) {
      body = gzipSync(Buffer.from(body as string), { level: 6 });
      headers["Content-Encoding"] = "gzip";
    }
    account(req, res, rid, reply.form, typeof body === "string" ? Buffer.byteLength(body) : body.length);
    return sendReply(res, { ...reply, headers, body });
  }
  if (url.pathname === "/point" && req.method === "POST") {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = new Uint8Array(Buffer.concat(chunks));
    const read = readPointBody(codec, req.headers["content-type"], body);
    if (!read.ok) {
      account(req, res, rid, "error", 0);
      res.statusCode = 400;
      return res.end(JSON.stringify({ error: read.error }));
    }
    account(req, res, rid, read.binary ? "binary" : "json", body.length);
    if (read.binary) {
      res.statusCode = 204;
      return res.end();
    }
    res.setHeader("content-type", "application/json");
    return res.end('{"ok":true}');
  }
  if (url.pathname === "/stats") {
    account(req, res, null, "stats", 0);
    res.setHeader("content-type", "application/json");
    return res.end(JSON.stringify(Object.fromEntries(stats)));
  }
  account(req, res, null, "404", 0);
  res.statusCode = 404;
  res.end();
}).listen(port, host, () => console.log(`sim server on http://${host}:${port}`));
