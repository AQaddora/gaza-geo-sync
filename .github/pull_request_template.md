## What and why

## Checklist
- [ ] `npm test` passes (typecheck + unit + fuzz)
- [ ] Wire format unchanged — or `FORMAT_VERSION` bumped, with a test that old/new bytes are refused/handled
- [ ] Decoders still only throw `CodecError` on bad input (fuzz case added for any new field)
- [ ] No Node built-ins in `src/bytes.ts`, `src/codec.ts`, `src/sync.ts`, `src/client.ts`
- [ ] Numbers in docs re-measured if the format changed (`npm run bench`)
- [ ] Only synthetic data in tests/bench
