# Research notes: why this format, and why it is smaller and faster

These notes explain the design, compare it with the usual alternatives, and say plainly where a
binary format does **not** help. The longer, paper-style version with the network simulations is
[`paper/paper.md`](../paper/paper.md) ([PDF](../paper/gaza-geo-sync.pdf)); every raw number is in
[`docs/TEST-REPORT.md`](TEST-REPORT.md) and `bench/results/`.

## 1. The problem

A live map polls the server (here every 30 s) and receives the position of every vehicle on the road.
As JSON, one position is typically:

```json
{"id":"cm1x4k2ab0003npyq8vi3ojyf","lat":31.51234567891234,"lon":34.45678912345678,"speed":8.329999923706055,"at":"2026-10-06T07:59:41.512Z"}
```

That is ~130 bytes, and **gzip cannot shrink it much**: the id is random, the float digits are noise,
and the time is different for every vehicle. On our synthetic Gaza fleet, gzip'd JSON costs about
**50 bytes per vehicle per refresh** (2,630 B for 50 vehicles).

What actually changes between two refreshes is tiny: a vehicle moved some metres, and its fix is a few
seconds old. The format below sends only that.

## 2. The design, one idea at a time

| idea | what it replaces | bytes saved per vehicle (approx.) |
|---|---|---|
| **Quantise** coordinates to whole 1e-5° (≈1.1 m) | 15–17-digit floats | ~25 → 4 |
| **Offset from an origin** (south-west corner of the area) as 2-byte unsigned ints | absolute values | 2 × (4–5 varint bytes) → 2 × 2 |
| **Index table**: each object gets a small number once; frames carry only sorted gaps | 25-char ids every time | ~28 → 1 |
| **Ages, not timestamps**: whole seconds before the frame's `serverTime` | 24-char ISO strings | ~30 → part of 1 byte |
| **Flags in the age varint** (speed present, outside the box, heading present) | per-field tags | 2–3 → 0 |
| **Speed in ¼ m/s**, one byte | float | ~6 → 1 |

Result: **7 bytes for a moving vehicle**, 6 without speed. The full layout is in the
[README](../README.md#byte-layout) and the header comment of [`src/codec.ts`](../src/codec.ts).

### Why quantise to 1e-5°?

Phone GPS is good to a few metres at best. A 1e-5° grid is 1.1 m north–south and ~0.95 m east–west at
Gaza's latitude, so rounding to it loses nothing a map can show. The step is configurable (`scale`):
`1e4` (≈11 m) is plenty for a bus map, `1e6` for surveying.

### Why an origin and 2-byte offsets, not delta-from-previous?

Delta coding *between* vehicles (as Google's polyline algorithm does along one line
[[polyline]](https://developers.google.com/maps/documentation/utilities/polylinealgorithm), and Mapbox
Vector Tiles do within a geometry [[MVT]](https://github.com/mapbox/vector-tile-spec)) only pays when
consecutive points are close. Vehicles in one frame are spread over the whole area, so deltas between them
are as large as the area itself. Delta *in time* (vs the client's previous copy) would need the client and
server to agree on what the client holds — fragile on a link that drops frames. A fixed origin needs no
state: 65,536 steps of 1e-5° is ≈73 km, which covers the Gaza Strip (≈41 km long) with room to spare.
Points outside the box are still legal (zigzag varints of absolute units), just a few bytes longer.

### Why varints (LEB128)?

Most numbers here are small (gaps of 1, ages under 32 s) but must not have a hard limit. Unsigned LEB128
[[LEB128]](https://en.wikipedia.org/wiki/LEB128) — the same varint Protocol Buffers use
[[protobuf-encoding]](https://protobuf.dev/programming-guides/encoding/) — gives 1 byte below 128 and grows
only when needed. Zigzag maps signed values to small unsigned ones for the out-of-box path. Faster integer
codecs exist (SIMD schemes [[Lemire & Boytsov]](https://doi.org/10.1002/spe.2203)), but at a few hundred
numbers per frame decode time is not the bottleneck; simplicity and a strict bounds-checked reader are worth more.

### Why an index table?

Ids are the biggest part of a JSON position and the least compressible (random by design). They do not
change between refreshes, so they belong in a table sent once — the same idea as HPACK's header table in
HTTP/2 [[RFC 7541]](https://www.rfc-editor.org/rfc/rfc7541). Numbers are sorted in the frame, so each costs
its gap from the previous one: 1 byte for dense numbering. The cost is state: the client must remember the
table, and a number it does not know means "do a full sync" (handled by `frameToPayload`'s `unknown` count).

### Why a JSON part inside the frame?

A real sync response carries other things (bookings, routes, cursors) that are text-heavy and compress
well. Putting them in a length-prefixed JSON part keeps one request per refresh and leaves that data
in the format your code already handles.

### Why content negotiation and a JSON fallback?

HTTP already has the mechanism [[RFC 9110 §12]](https://www.rfc-editor.org/rfc/rfc9110#name-content-negotiation):
the client says `Accept: application/octet-stream, application/json;q=0.5`, the server answers either, and
`Vary: Accept` keeps caches honest. Old app versions, curl, monitoring and the debugger keep seeing JSON;
a client meeting an old server gets JSON and copes. No flag day.

## 3. Alternatives, measured

One routine refresh, synthetic Gaza fleet (`bench/sizes.ts`, gzip level 6, client already knows the index):

| vehicles | JSON | JSON gzip | JSON 5-dp gzip | MessagePack gzip | CBOR gzip | Protobuf gzip | Protobuf, tuned* | **this format** |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 10 | 1,418 | 641 | 484 | 619 | 624 | 560 | 160 | **79** |
| 50 | 6,935 | 2,630 | 1,846 | 2,419 | 2,438 | 2,280 | 778 | **356** |
| 150 | 20,410 | 7,535 | 5,153 | 6,807 | 6,861 | 6,423 | 2,270 | **1,001** |
| 300 | 40,903 | 14,959 | 10,098 | 13,413 | 13,508 | 12,641 | 4,601 | **1,913** |

\* *Protobuf, tuned* uses the same quantisation, origin offsets, numbers and ages, as a repeated message.

What this shows:

- **MessagePack [[spec]](https://github.com/msgpack/msgpack/blob/master/spec.md) and CBOR
  [[RFC 8949]](https://www.rfc-editor.org/rfc/rfc8949)** are JSON's data model in binary. With the same data
  (random ids, full floats, ISO strings) they save only 3–10% after gzip. The container is not the problem; the content is.
- **Protobuf** [[encoding]](https://protobuf.dev/programming-guides/encoding/) with a naive schema (string id,
  double lat/lon) is close to MessagePack. With the *same ideas* as this format it gets within ~2.2× — the
  remaining gap is per-field tags and per-message length prefixes. A packed, column-wise Protobuf schema would
  come closer still. If you already run Protobuf everywhere, **apply these ideas inside your schema**; that is
  most of the win.
- **FlatBuffers** [[flatbuffers.dev]](https://flatbuffers.dev/) and **Cap'n Proto**
  [[capnproto.org]](https://capnproto.org/) optimise for zero-copy access, not size: fixed-width fields and
  alignment padding make them larger than Protobuf on the wire. Great for large structures read in place;
  wrong trade-off for a 2G link.
- **Rounding JSON to 5 decimals** is a free 30%: do it even if you never ship binary.
- **Geobuf** [[mapbox/geobuf]](https://github.com/mapbox/geobuf) compresses GeoJSON with Protobuf, quantisation and
  deltas; it targets geometry documents, not frequent small position updates with an index.
- **Trajectory simplification** (Douglas–Peucker [[1973]](https://doi.org/10.3138/FM57-6770-U75U-7727),
  spatio-temporal variants [[Meratnia & de By 2004]](https://doi.org/10.1007/978-3-540-24741-8_44)) removes
  *points from a track*. It is complementary: the standing-still throttle here is the simplest member of that
  family (send when moved ≥ 15 m or every 60 s).

## 4. Where binary does NOT win (be honest)

1. **Small uploads: headers dominate.** A driver's point goes from 77 B of JSON to 8 B. But each HTTP/1.1
   request also carries ~350–800 B of headers (more with cookies), and the response its own. Measured at
   the socket in the simulation, a whole upload exchange shrinks only ~17% (607 → 505 B), and its round-trip time does not change on any profile. HTTP/2 and HTTP/3
   compress repeated headers [[RFC 7541]](https://www.rfc-editor.org/rfc/rfc7541),
   [[RFC 9114]](https://www.rfc-editor.org/rfc/rfc9114), which shrinks the gap further. **The real win for
   uploads is fewer requests** — the standing-still throttle cuts a parked driver from 4 to ~1 request per minute.
2. **Latency-bound refreshes.** On a link with 300–840 ms round trips, a refresh of a few hundred bytes takes
   one round trip either way. Binary only shortens time-to-update when the JSON payload is big enough to need
   extra round trips or noticeable transfer time. In our runs: no difference on Wi-Fi/4G; on EDGE −2% at 10 vehicles, −6% at 50, −14% at 150, −24% at 300; on 3G −3% at 50 and −12% at 300. See the paper's §5.2.
3. **CPU.** Browsers parse JSON in optimised native code. Our decoder is JavaScript: in Node it decodes the raw
   frame faster than `JSON.parse` reads the equivalent JSON, but producing the same records (ISO dates, id lookups)
   costs ~1.2–1.9× `JSON.parse`. In headless Chromium at 4× CPU throttling it is ~3× (1.8 ms vs 0.6 ms for 300 vehicles); Mishwar measured 0.26 ms vs 0.11 ms for 50 vehicles at 6×. Total main-thread time per refresh was nevertheless equal within ±4% in our simulation. It is
   sub-millisecond to a few ms, tiny next to radio time — but it is not free.
4. **Text-heavy and diffed data.** Chat, bookings, names: gzip already does well; keep them JSON.
5. **Debuggability.** You cannot read a frame in DevTools. Mitigations: JSON stays one header away, and the
   decoder is ~150 lines.
6. **State.** The index table is state the client must keep. A lost table means one full sync (handled).
7. **Tiny fleets.** At 4 vehicles the whole response is headers; bytes saved are a few hundred per minute.

## 5. Connectivity: what each feature does on each kind of link

| | Wi-Fi (shared / good) | 4G | 3G | 2G/EDGE (weakest mobile data) | lossy links |
|---|---|---|---|---|---|
| fewer bytes per refresh | data saved, little time | data saved | data + time saved at 150+ vehicles | **largest time saving**: fewer TCP round trips in slow start, less airtime | fewer packets → fewer to lose and retransmit |
| standing-still throttle | fewer requests | fewer radio wake-ups (battery [[Huang 2012]](https://doi.org/10.1145/2307636.2307658)) | same | **~4× fewer requests while parked** | fewer chances to hit a timeout |
| 204 instead of a JSON answer | — | — | — | one less body to wait for | — |
| decode on arrival + offline cache | — | — | — | screens keep working between successful refreshes | **map still shows the last good copy** |
| JSON fallback | old clients fine | | | | |

Radio energy matters as much as bytes: a cellular radio stays in a high-power state for seconds after each
transfer ("tail energy") [[Balasubramanian 2009]](https://doi.org/10.1145/1644893.1644927),
[[Huang 2012]](https://doi.org/10.1145/2307636.2307658). Fewer, smaller requests mean less of that tail.

## 6. References

- MessagePack specification — https://github.com/msgpack/msgpack/blob/master/spec.md
- Protocol Buffers, encoding — https://protobuf.dev/programming-guides/encoding/
- FlatBuffers — https://flatbuffers.dev/ · Cap'n Proto — https://capnproto.org/
- RFC 8949, CBOR — https://www.rfc-editor.org/rfc/rfc8949
- RFC 9110, HTTP Semantics (content negotiation) — https://www.rfc-editor.org/rfc/rfc9110
- RFC 7541, HPACK — https://www.rfc-editor.org/rfc/rfc7541 · RFC 9114, HTTP/3 — https://www.rfc-editor.org/rfc/rfc9114
- RFC 1952, gzip — https://www.rfc-editor.org/rfc/rfc1952
- LEB128 — https://en.wikipedia.org/wiki/LEB128
- Google Encoded Polyline Algorithm — https://developers.google.com/maps/documentation/utilities/polylinealgorithm
- Mapbox Vector Tile specification — https://github.com/mapbox/vector-tile-spec · Geobuf — https://github.com/mapbox/geobuf
- D. Lemire, L. Boytsov, "Decoding billions of integers per second through vectorization", *Software: Practice and Experience* 45(1), 2015 — https://doi.org/10.1002/spe.2203
- D. Douglas, T. Peucker, "Algorithms for the reduction of the number of points required to represent a digitized line or its caricature", *Cartographica* 10(2), 1973 — https://doi.org/10.3138/FM57-6770-U75U-7727
- N. Meratnia, R. A. de By, "Spatiotemporal compression techniques for moving point objects", EDBT 2004 — https://doi.org/10.1007/978-3-540-24741-8_44
- J. Huang et al., "A close examination of performance and power characteristics of 4G LTE networks", MobiSys 2012 — https://doi.org/10.1145/2307636.2307658
- N. Balasubramanian, A. Balasubramanian, A. Venkataramani, "Energy consumption in mobile phones: a measurement study and implications for network applications", IMC 2009 — https://doi.org/10.1145/1644893.1644927
- World Bank, "The Telecommunication Sector in the Palestinian Territories: A Missed Opportunity for Economic Development", 2016 — https://documents1.worldbank.org/curated/en/993031473856114803/pdf/104263-REVISED-title-a-little-different-WP-P150798-NOW-OUO-9.pdf
- WebPageTest connectivity profiles — https://github.com/catchpoint/WebPageTest/blob/master/www/settings/connectivity.ini.sample
- tc-netem(8) — https://man7.org/linux/man-pages/man8/tc-netem.8.html
