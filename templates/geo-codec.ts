// templates/geo-codec.ts — one shared codec instance for server and client.
// Copy into your project (e.g. src/lib/geo-codec.ts). Both sides MUST use the same options.
import { createCodec } from "gaza-geo-sync";

export const codec = createCodec({
  // South-west corner of the area most of your points fall in. Gaza Strip shown;
  // with the default 1e-5° grid and 2-byte offsets the box is ≈0.655° on each side.
  south: 31.2,
  west: 34.2,
  scale: 1e5, // 1e-5° ≈ 1.1 m. Use 1e4 (≈11 m) for a coarse city map.
  speedStep: 0.25, // m/s per step; 0 to leave speed out
  heading: false, // true adds 1 byte per point
  profile: 1, // bump when you change any option above: old frames are then refused, not misread
});
