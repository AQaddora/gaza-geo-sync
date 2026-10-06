// The simulated map client. SYNTHETIC data from the sim server. Exposes window.sim.
import { ACCEPT_BINARY, GAZA, createCodec, frameToPayload } from "/lib/index.js";

const codec = createCodec(GAZA);
const known = new Map();
const markers = new Map();
const map = document.getElementById("map");
const [S, W, N, E] = [31.2, 34.2, 31.6, 34.6];

function draw(positions) {
  for (const p of positions) {
    let el = markers.get(p.id);
    if (!el) {
      el = document.createElement("div");
      el.className = "m";
      map.appendChild(el);
      markers.set(p.id, el);
    }
    const x = ((p.lon - W) / (E - W)) * 360;
    const y = ((N - p.lat) / (N - S)) * 640;
    el.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;
  }
}

const frame = () => new Promise((r) => requestAnimationFrame(() => r()));

async function pull(url, fmt) {
  const t0 = performance.now();
  const res = await fetch(url, { cache: "no-store", headers: { accept: fmt === "bin" ? ACCEPT_BINARY : "application/json" } });
  let payload;
  let d0;
  let d1;
  if ((res.headers.get("content-type") || "").startsWith("application/octet-stream")) {
    const buf = await res.arrayBuffer();
    d0 = performance.now();
    payload = frameToPayload(codec.decodeFrame(new Uint8Array(buf)), (n) => known.get(n)).payload;
    d1 = performance.now();
  } else {
    const text = await res.text();
    d0 = performance.now();
    payload = JSON.parse(text);
    d1 = performance.now();
  }
  for (const [n, id] of payload.index || []) known.set(n, id);
  draw(payload.positions);
  await frame();
  const t1 = performance.now();
  return { ttu: t1 - t0, network: d0 - t0, decode: d1 - d0, render: t1 - d1, count: payload.positions.length, binary: res.headers.get("content-type").startsWith("application/octet-stream") };
}

window.sim = {
  first: (n, fmt, rid) => pull(`/positions?n=${n}&first=1&rid=${rid}`, fmt),
  refresh: (n, fmt, rid) => pull(`/positions?n=${n}&rid=${rid}`, fmt),
  async upload(fmt, rid) {
    const fix = { lat: 31.41234567891234, lon: 34.36789123456789, speed: 8.33 };
    const t0 = performance.now();
    const res = await fetch(`/point?rid=${rid}`, {
      method: "POST",
      headers: { "content-type": fmt === "bin" ? "application/octet-stream" : "application/json" },
      body: fmt === "bin" ? codec.encodePoint({ ...fix, ageSec: 1 }) : JSON.stringify(fix),
    });
    await res.arrayBuffer();
    return { ttu: performance.now() - t0, status: res.status };
  },
};
window.simReady = true;
