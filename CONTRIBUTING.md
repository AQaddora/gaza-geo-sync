# Contributing

Thank you for helping. This project started in Gaza, for people on the weakest mobile data,
and every improvement that saves a byte or a request matters to someone on a 2G link.

## Ways to help

- **Field reports.** Measured it on a real network (EDGE, congested 3G, satellite, a crowded
  shelter's Wi-Fi)? Open a *Field report* issue with before/after numbers. These are the most valuable contributions.
- **Adapters and templates.** Fastify, Hono, Django/FastAPI ports, Kotlin/Swift decoders, a
  React Native hook. A port must pass the same test vectors (see below).
- **Docs and translations.** Arabic translations of the README and the migration guide are very welcome.
- **Format proposals.** Open an issue first, with a measurement that shows the need.

## Development

```bash
npm ci
npm test          # typecheck + vitest (unit, round-trip, fuzz, negotiation)
npm run bench     # payload sizes, decode CPU, upload requests (synthetic data)
npm run build     # dist/
```

The browser simulation (`bench/sim/`) needs Linux, `sudo`, `tc` and a Playwright Chromium:
`bench/sim/run-all.sh 40 30 && python3 bench/analyze.py`. See `docs/TEST-REPORT.md`.

## Rules for changes

1. **The wire format is a contract.** Any change bumps `FORMAT_VERSION` in `src/codec.ts`, updates the
   header comment, `docs/images/byte-layout.svg` and the README, and adds a test that the other version is refused.
2. **Decoders never trust input.** Bounds-check every read, cap every length, refuse trailing bytes, and
   throw only `CodecError`. Add fuzz cases for anything new.
3. **JSON fallback stays.** No change may make JSON clients worse.
4. **Zero runtime dependencies** in `src/`. Browser files (`bytes`, `codec`, `sync`, `client`) use no Node built-ins.
5. **Honest numbers.** Re-run the benchmarks when behaviour changes; label synthetic data; say where it does not help.
6. **No real user data** anywhere — not in tests, fixtures, issues or screenshots.

## Pull requests

Small and focused. Fill in the PR checklist. Commit messages: present tense, say *why*.
By contributing you agree your work is released under the MIT licence and that you follow the
[Code of Conduct](CODE_OF_CONDUCT.md).

## Using Claude Code on this repo

`CLAUDE.md` describes the layout and rules; the skills in `.claude/skills/` work here too.
