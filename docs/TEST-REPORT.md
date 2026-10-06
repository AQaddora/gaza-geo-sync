# Test report

Everything measured for this repository: unit and fuzz tests, payload sizes, decode CPU, upload
requests, and a browser simulation across five network profiles. **All data is synthetic** — generated
by `bench/synthetic.ts` (seeded) — except §7, which quotes the measurements made in Mishwar.

Raw data: [`bench/results/`](../bench/results). Re-run everything:

```bash
npm ci
npm test
npm run bench                         # → bench/results/sizes.csv, decode-node.csv, uploads.csv
bench/sim/run-all.sh 40 30            # → bench/results/sim-raw.csv   (Linux, sudo, tc, Playwright Chromium)
python3 bench/analyze.py              # → bench/results/sim-summary.csv, paper/figures/*.png
```

Run date: 2026-10-06.

## 1. Environment

| | unit tests + Node benchmarks | browser simulation |
|---|---|---|
| OS | Ubuntu 24.04.4 LTS, kernel 6.8 | Ubuntu 24.04.4 LTS, kernel 6.8.0 |
| CPU | 4 vCPU Intel Xeon Platinum 8375C @ 2.90 GHz | 4 vCPU Intel Xeon Platinum 8375C @ 2.90 GHz, 15 GB RAM |
| Node | v22.23.1 | v22.23.1 |
| Libraries | TypeScript 5.9, vitest 3.2.7, tsx 4.20, @msgpack/msgpack 3.1, cbor-x 1.6, protobufjs 7.5 | playwright-core 1.63.0 |
| Browser | — | Chromium 153.0.8010.12 (headless), 4× CPU throttling via CDP `Emulation.setCPUThrottlingRate`, 360×640 viewport |
| Network | — | veth pair into a network namespace, shaped both ways with tc-netem (iproute2 6.1.0); TSO/GSO/GRO off |
| HTTP | — | HTTP/1.1, keep-alive, no TLS; Node `http` server |

## 2. Unit, round-trip and fuzz tests

`npm test` = `tsc --noEmit` + vitest. Result: **28 tests passed, 3 files, ~3 s.**

| file | what it checks |
|---|---|
| `tests/codec.test.ts` (14) | round-trip of 50 synthetic Gaza positions within half a quantisation step, speeds within 0.125 m/s, ages in whole seconds; JSON part carried unchanged; points outside the box (incl. ±90°/180°); < 8 B per vehicle; 8 kinds of broken frame → `CodecError`; refusing repeated numbers / NaN / negative numbers; other city, coarser grid, 3-byte offsets, heading; profile mismatch refused; `speedStep: 0`; bad options; 7/8-byte points; 23-byte UUID point; text ids; kind confusion |
| `tests/fuzz.test.ts` (4) | 2,000 random frames × 2 configurations round-trip (80% in Gaza, 20% anywhere on Earth; numbers up to 2⁴⁰; ages up to ~115 days; optional speed/heading); 20,000 random/mutated/truncated inputs against both decoders — every outcome is a valid point or a `CodecError`; hostile ages and server times beyond what a Date can hold are refused; everything that decodes also converts to valid JSON records |
| `tests/sync.test.ts` (10) | negotiation (`Accept` parsing incl. `q=0`); server → client through both forms gives the same records (offline cache unchanged); gzip only when smaller; naming from the frame's index, then the stored table, counting unknown numbers; JSON fallback when the server answers JSON; index table; upload bodies (binary, JSON, broken); standing-still throttle; fix age clamp; point sender: throttle, minimum interval, binary first, JSON for good after a 400 |

## 3. Payload size (`bench/sizes.ts`)

One routine refresh, client already knows the index. Synthetic fleet: vehicles along the Strip's
main axis, raw-GPS floats, 25-character random ids, ages 0–30 s, a third parked. gzip level 6.
"Protobuf tuned" uses this format's quantisation, numbering and ages inside a Protobuf schema.

| vehicles | JSON | JSON gzip | JSON 5-dp gzip | MsgPack gzip | CBOR gzip | Protobuf gzip | Protobuf tuned | **this format** | JSON gzip ÷ this |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 4 | 607 | 338 | 267 | 322 | 327 | 268 | 64 | **38** | 8.9× |
| 10 | 1,418 | 641 | 484 | 619 | 624 | 560 | 160 | **79** | 8.1× |
| 50 | 6,935 | 2,630 | 1,846 | 2,419 | 2,438 | 2,280 | 778 | **356** | 7.4× |
| 100 | 13,554 | 4,987 | 3,488 | 4,569 | 4,609 | 4,311 | 1,548 | **680** | 7.3× |
| 150 | 20,410 | 7,535 | 5,153 | 6,807 | 6,861 | 6,423 | 2,270 | **1,001** | 7.5× |
| 300 | 40,903 | 14,959 | 10,098 | 13,413 | 13,508 | 12,641 | 4,601 | **1,913** | 7.8× |

*Table 1. Bytes for one routine refresh (synthetic Gaza fleet; gzip level 6).*

First sync (index of all `[n, id]` pairs in the JSON part, gzipped): 374 B for 10 vehicles, 1,511 B for 50,
4,314 B for 150, 8,482 B for 300 (`first_sync_binary_sent` in `sizes.csv`).

## 4. Decode CPU in Node (`bench/decode-cpu.ts`)

Median µs per decode (200 samples × 20 calls, after JIT warm-up). "decode + records" also builds the
JSON-shaped records (ids from the table, ISO dates) — the fair comparison with `JSON.parse`.

| vehicles | `JSON.parse` | `decodeFrame` | decode + records |
|---:|---:|---:|---:|
| 10 | 10.1 µs | 6.9 µs | 12.1 µs |
| 50 | 30.5 µs | 24.3 µs | 50.6 µs |
| 150 | 93.2 µs | 72.9 µs | 159.7 µs |
| 300 | 191.0 µs | 116.3 µs | 353.4 µs |

Binary decoding alone is faster than `JSON.parse` of the equivalent text; producing the same records costs
≈1.2–1.9× `JSON.parse`. Sub-millisecond either way on this CPU.

## 5. Uploads (`bench/uploads.ts`)

Synthetic two-hour driver trace at 1 Hz: driving 3–12 min at 8–14 m/s, waiting 2–12 min with ±4 m GPS
jitter (60 of 120 minutes waiting). Ticks every 15 s.

| policy | requests/min moving | requests/min parked | requests in 2 h |
|---|---:|---:|---:|
| every 15 s | 4.00 | 4.00 | 480 |
| every 15 s + standing-still throttle | 4.00 | 1.05 | 302 |

Bodies: driver point JSON 77 B → binary 8 B; shared point with a UUID JSON 94 B → binary 23 B.

## 6. Browser simulation (`bench/sim/`)

### Method

- `bench/sim/netem.sh` creates namespace `ggs`, a veth pair (10.77.0.1 ↔ 10.77.0.2) and shapes each
  direction with `tc qdisc … netem delay RTT/2 loss L% rate R`. Profiles:

| profile | down | up | RTT | loss (each way) | source |
|---|---:|---:|---:|---:|---|
| `wifi` | 30 Mbit/s | 15 Mbit/s | 20 ms | 0 | assumption: good shared Wi-Fi |
| `4g` | 9 Mbit/s | 9 Mbit/s | 170 ms | 0 | WebPageTest "4G" |
| `3g` | 1.6 Mbit/s | 768 kbit/s | 300 ms | 0 | WebPageTest "3G" |
| `edge` | 240 kbit/s | 200 kbit/s | 840 ms | 0 | WebPageTest "Mobile Edge" |
| `lossy` | 1.6 Mbit/s | 768 kbit/s | 300 ms | 3% | 3G + random loss |

- `bench/sim/server.ts` serves the page, the built library, and `/positions?n=N` from a synthetic fleet that
  advances 15 s per request. JSON form: records rounded to 5 decimals (the *favourable* JSON baseline) and gzipped
  at level 6, as a proxy would. Binary form: `positionsReply` (gzip only when smaller). It records, per request,
  the bytes read from and written to the socket (HTTP headers + body; not TCP/IP framing or retransmissions).
- `bench/sim/run.mjs` (Playwright, headless Chromium, 4× CPU throttle): for each fleet size (10, 50, 150, 300) and
  format, a fresh browser context does one full sync and **40 routine refreshes**, 250 ms apart, on a kept-alive
  connection; then **30 uploads** per format. Per refresh: time-to-update (from `fetch()` to the animation frame
  after all markers moved), network time, parse/decode time, main-thread task time (CDP `Performance.getMetrics`
  `TaskDuration` delta).
- Total: 1,940 measurements in `bench/results/sim-raw.csv`; medians and p90 in `sim-summary.csv`.

### Bytes on the wire per refresh

From the Wi-Fi runs (first in order; see the fleet-drift note in §8).

| vehicles | JSON body | JSON on wire | binary body | binary on wire | wire change |
|---:|---:|---:|---:|---:|---:|
| 10 | 517 | 1,127 | 80 | 690 | -39% |
| 50 | 1,963 | 2,574 | 356 | 968 | -62% |
| 150 | 5,542 | 6,156 | 1,022 | 1,660 | -73% |
| 300 | 10,962 | 11,576 | 1,990 | 2,628 | -77% |

*Table 2. Median bytes per routine refresh. Wire = request + response, HTTP headers included (≈360–390 B request, ≈220–250 B response headers).*

### Time to update

| profile | vehicles | JSON median | JSON p90 | binary median | binary p90 | median change |
|---|---:|---:|---:|---:|---:|---:|
| Wi-Fi | 10 | 30 | 38 | 30 | 39 | -3% |
| Wi-Fi | 50 | 32 | 36 | 31 | 38 | -5% |
| Wi-Fi | 150 | 33 | 37 | 34 | 42 | +1% |
| Wi-Fi | 300 | 37 | 45 | 35 | 42 | -6% |
| 4G | 10 | 182 | 186 | 181 | 184 | -0% |
| 4G | 50 | 183 | 189 | 182 | 188 | -0% |
| 4G | 150 | 184 | 189 | 183 | 187 | -1% |
| 4G | 300 | 193 | 198 | 188 | 195 | -2% |
| 3G | 10 | 317 | 323 | 314 | 316 | -1% |
| 3G | 50 | 324 | 329 | 314 | 315 | -3% |
| 3G | 150 | 341 | 342 | 319 | 320 | -6% |
| 3G | 300 | 371 | 371 | 326 | 327 | -12% |
| EDGE (2G) | 10 | 891 | 892 | 877 | 878 | -2% |
| EDGE (2G) | 50 | 943 | 943 | 889 | 890 | -6% |
| EDGE (2G) | 150 | 1,070 | 1,071 | 919 | 921 | -14% |
| EDGE (2G) | 300 | 1,261 | 1,263 | 959 | 960 | -24% |
| 3G + 3% loss | 10 | 315 | 849 | 313 | 370 | -1% |
| 3G + 3% loss | 50 | 323 | 324 | 315 | 906 | -2% |
| 3G + 3% loss | 150 | 341 | 627 | 320 | 834 | -6% |
| 3G + 3% loss | 300 | 372 | 943 | 326 | 372 | -12% |

*Table 3. Time to update the map (ms), 40 refreshes per cell.*

![time to update](images/fig-time-to-update.png)

On Wi-Fi and 4G the two formats are indistinguishable (differences of 0–5 ms, within run-to-run noise): the link is fast enough that a few kilobytes cost nothing, and the round trip dominates. On 3G the binary format is 3% faster at 50 vehicles and 12% faster at 300 (371 → 327 ms). On EDGE the gain grows with the fleet: −2% at 10 vehicles (one round trip either way, 891 vs 877 ms), −6% at 50, −14% at 150 and **−24% at 300 vehicles (1,261 → 959 ms)** — at 240 kbit/s, 9 KB of extra JSON is ≈0.3 s of airtime. On the lossy 3G link medians follow 3G, while the 90th percentile is dominated by TCP retransmission timeouts that hit either format at random (p90 at 50 vehicles was worse for binary, at 300 better: 943 → 372 ms); fewer packets per refresh means fewer chances to lose one, but 40 samples per cell are too few to rank tail latency under random loss.

### CPU

| vehicles | JSON parse | binary decode + records | JSON main-thread task | binary main-thread task |
|---:|---:|---:|---:|---:|
| 10 | 0.00 | 0.20 | 6.5 | 6.7 |
| 50 | 0.10 | 0.60 | 7.6 | 7.5 |
| 150 | 0.20 | 1.10 | 9.7 | 9.6 |
| 300 | 0.60 | 1.80 | 12.7 | 12.4 |

*Table 4. CPU per refresh (ms, medians over all profiles, 4× CPU throttle; browser timer resolution 0.1 ms).*

In the browser, decoding into JSON-shaped records is slower than native `JSON.parse` — 1.8 ms vs 0.6 ms for 300 vehicles at 4× throttling, about 3× — consistent with the Mishwar measurement (≈2.3×). But parsing is a small part of a refresh: total main-thread task time, which includes fetch handling, gzip inflation of the JSON, drawing and layout, is the same within ±4% for both formats at every fleet size (12.7 vs 12.4 ms at 300 vehicles). As a battery proxy, CPU is a wash; the energy difference comes from the radio (fewer bytes, fewer requests [17, 18]).

### First sync

| profile | vehicles | JSON first sync (B / ms) | binary first sync (B / ms) |
|---|---:|---:|---:|
| Wi-Fi | 10 | 1,212 / 54 | 1,026 / 40 |
| Wi-Fi | 50 | 2,961 / 41 | 2,147 / 44 |
| Wi-Fi | 150 | 7,287 / 37 | 4,984 / 44 |
| Wi-Fi | 300 | 14,426 / 55 | 9,212 / 44 |
| 4G | 10 | 1,207 / 184 | 1,034 / 190 |
| 4G | 50 | 2,969 / 189 | 2,196 / 188 |
| 4G | 150 | 7,312 / 200 | 5,074 / 229 |
| 4G | 300 | 14,442 / 206 | 9,408 / 207 |
| 3G | 10 | 1,211 / 318 | 1,059 / 325 |
| 3G | 50 | 2,973 / 332 | 2,221 / 327 |
| 3G | 150 | 7,329 / 351 | 5,143 / 344 |
| 3G | 300 | 14,484 / 391 | 9,681 / 373 |
| EDGE (2G) | 10 | 1,221 / 896 | 1,059 / 894 |
| EDGE (2G) | 50 | 2,981 / 959 | 2,249 / 941 |
| EDGE (2G) | 150 | 7,345 / 1,110 | 5,260 / 1,044 |
| EDGE (2G) | 300 | 14,564 / 1,365 | 9,811 / 1,207 |
| 3G + 3% loss | 10 | 1,221 / 318 | 1,069 / 321 |
| 3G + 3% loss | 50 | 3,007 / 328 | 2,273 / 328 |
| 3G + 3% loss | 150 | 7,401 / 351 | 5,322 / 345 |
| 3G + 3% loss | 300 | 14,637 / 392 | 9,901 / 977 |

### Uploads

| profile | JSON exchange (B) | binary exchange (B) | JSON median / p90 (ms) | binary median / p90 (ms) |
|---|---:|---:|---:|---:|
| Wi-Fi | 607 | 505 | 29 / 33 | 28 / 32 |
| 4G | 605 | 503 | 180 / 184 | 177 / 180 |
| 3G | 605 | 503 | 312 / 312 | 311 / 312 |
| EDGE (2G) | 607 | 505 | 873 / 874 | 869 / 871 |
| 3G + 3% loss | 608 | 506 | 312 / 366 | 311 / 312 |

*Table 5. One upload exchange (request + response, headers included) and its round-trip time.*

Bodies shrink from 62–77 B to 8 B, but the whole exchange, with ≈360–390 B of request headers and ≈110–250 B of response, shrinks only **17% (607 → 505 B)**, and round-trip time is unchanged on every profile — an upload is one round trip either way. The throttle, by contrast, removes 74% of a parked driver's requests: bytes per minute on the wire fall from 2,428 B (JSON every 15 s) to 2,020 B (binary every 15 s) to **530 B (binary with the throttle)**. For small uploads, fewer requests matter more than smaller ones.

![uploads](images/fig-uploads.png)

## 7. Measured in Mishwar (not synthetic)

From the original work in Mishwar (production builds, headless Chrome, 50 vehicles on real map stops,
JSON gzipped as the app's server sends it): guest map refresh 2,120 → 584 B; signed-in 2,630 → 1,105 B; first
sync 9,958 → 8,584 B; driver point 37–60 B → 7 B (answered 204); parked driver 4.3 → 0.9 uploads/min; rider
shared point 73 → 24 B, 3 → 0.9/min while standing; sync unit test 300 vehicles 11,998 → 2,050 B gzipped;
decode 50 vehicles 0.11 ms (`JSON.parse`) vs 0.26 ms (binary), 300 vehicles 0.65 vs 1.53 ms, 6× CPU throttle.
Details: [USED-IN.md](USED-IN.md).

## 8. Threats to validity

- Synthetic positions and ids; real fleets cluster differently (denser numbering helps the format, sparse hurts slightly).
- One host; HTTP/1.1 without TLS (TLS adds per-record overhead to both formats equally; HTTP/2 would shrink headers for both).
- Refreshes 250 ms apart keep the connection and congestion window warm; real 30-s polling may pay TCP slow-start
  after idle and, on cellular, radio promotion delays, which favour fewer and smaller transfers further.
- netem random loss is independent per packet; real radio loss is bursty.
- The synthetic fleet is not reset between profiles: moving vehicles keep driving in a straight line, so by the later profiles some have left the 2-byte box and use the longer absolute encoding. Binary frames at 300 vehicles grow from 2,628 B (Wi-Fi, run first) to 3,089 B (lossy, run last), +18%, against +2% for JSON. This biases the slower profiles *against* the format.
- 40 refreshes per cell: medians are stable (p90 ≈ median on loss-free links), but tail latency under random loss is not reliably ranked with this many samples.
- Browser timer resolution is 0.1 ms, so sub-0.1-ms parse times read as 0.
- CPU throttling approximates a slower phone; it is not a phone.
