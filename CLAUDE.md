# gaza-geo-sync — notes for Claude Code

Compact binary live-position sync with JSON fallback. TypeScript, zero runtime dependencies.

## Layout
- `src/bytes.ts` — Writer/Reader (varint, zigzag, bounds checks, `CodecError`).
- `src/codec.ts` — `createCodec(options)`: frame + point encoders/decoders. **Byte layout is documented in its header comment; keep it in sync with `docs/images/byte-layout.svg` and the README.**
- `src/sync.ts` — JSON record shape, `IndexTable`, negotiation (`wantsBinary`, `sentBinary`), standing-still throttle.
- `src/client.ts` — `fetchPositions`, `createPointSender` (browser-safe, no Node imports).
- `src/server.ts` — `positionsReply`, `readPointBody`, Fetch/Express adapters (uses `node:zlib`).
- `tests/` — vitest: unit, round-trip, fuzz, negotiation, client fallback.
- `bench/` — `sizes.ts`, `decode-cpu.ts`, `uploads.ts` (synthetic data) and `bench/sim/` (Chromium + tc-netem). Results in `bench/results/`.
- `templates/` — copy-paste integrations. `.claude/skills/` — integrate / migrate / verify skills.
- `paper/` — the research paper (Markdown + PDF). `docs/` — research, migration, test report.

## Commands
- `npm test` (typecheck + vitest), `npm run build`, `npm run bench`.
- Simulation (Linux + sudo): `bench/sim/run-all.sh 40 30`, then `python3 bench/analyze.py`.

## Rules
- Any change to the wire format bumps `FORMAT_VERSION` and adds a test with the old bytes refused.
- Decoders must only ever throw `CodecError` on bad input. Add fuzz cases for new fields.
- `src/client.ts`, `src/codec.ts`, `src/sync.ts`, `src/bytes.ts` must stay free of Node built-ins.
- Bench data is synthetic. Never commit real user positions or ids.
