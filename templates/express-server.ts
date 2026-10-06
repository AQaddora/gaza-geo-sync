// templates/express-server.ts — Express (or plain node:http) version of both routes.
import express from "express";
import { IndexTable } from "gaza-geo-sync";
import { positionsReply, readPointBody, sendReply } from "gaza-geo-sync/server";
import { codec } from "./geo-codec";

const app = express();
const table = new IndexTable(); // single process only; use a DB column in production

app.get("/api/positions", async (req, res) => {
  const live: { id: string; lat: number; lon: number; speed: number | null; at: Date }[] = []; // your data
  for (const v of live) table.assign(v.id);
  sendReply(
    res,
    positionsReply({
      codec,
      accept: req.get("accept"),
      acceptEncoding: req.get("accept-encoding"),
      positions: live,
      table,
      index: req.query.since ? undefined : table.entries(),
    }),
  );
});

// express.raw keeps binary bodies as a Buffer; express.text keeps JSON as a string.
app.post("/api/position", express.raw({ type: "application/octet-stream", limit: "1kb" }), express.text({ type: "application/json", limit: "4kb" }), (req, res) => {
  const body = Buffer.isBuffer(req.body) ? new Uint8Array(req.body) : String(req.body ?? "");
  const read = readPointBody(codec, req.get("content-type"), body);
  if (!read.ok) return res.status(400).json({ error: read.error });
  // save read.point ...
  return read.binary ? res.status(204).end() : res.json({ ok: true });
});

// If compression() middleware is in front, it skips application/octet-stream by default;
// positionsReply gzips binary frames itself when that is smaller.
app.listen(3000);
