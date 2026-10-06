// SYNTHETIC data only: no real user, vehicle or trip. A seeded generator places vehicles
// along the Gaza Strip's main south-west → north-east axis (Rafah ≈ 31.29N 34.25E to
// Beit Hanoun ≈ 31.54N 34.54E) with up to ±1.5 km of sideways jitter, like vehicles on the
// coastal and Salah al-Din roads. Ids are 25-character cuid-like strings, as many apps use.

/** Small LCG so every run (and every failing test) can be replayed. */
export function rng(seed: number) {
  return () => {
    seed = (seed * 1103515245 + 12345) % 2 ** 31;
    return seed / 2 ** 31;
  };
}

const ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

export function cuidLike(r: () => number): string {
  let s = "c";
  for (let i = 0; i < 24; i++) s += ALPHABET[Math.floor(r() * ALPHABET.length)];
  return s;
}

export interface SyntheticVehicle {
  id: string;
  lat: number;
  lon: number;
  speed: number | null;
  heading: number;
  /** Epoch ms of the fix. */
  at: number;
  parked: boolean;
}

const SW = { lat: 31.29, lon: 34.25 };
const NE = { lat: 31.54, lon: 34.54 };

/** N vehicles at time `now`; about a third parked (speed 0), a few without speed. */
export function syntheticFleet(count: number, now: number, seed = 1): SyntheticVehicle[] {
  const r = rng(seed);
  return Array.from({ length: count }, () => {
    const t = r();
    const side = (r() - 0.5) * 0.028; // ≈ ±1.5 km across the axis
    const parked = r() < 0.33;
    return {
      id: cuidLike(r),
      // Raw GPS floats, as a phone reports them (15–17 significant digits).
      lat: SW.lat + (NE.lat - SW.lat) * t - side * 0.7 + r() * 1e-9,
      lon: SW.lon + (NE.lon - SW.lon) * t + side * 0.7 + r() * 1e-9,
      speed: r() < 0.1 ? null : parked ? 0 : 3 + r() * 14,
      heading: r() * 360,
      at: now - Math.floor(r() * 30_000),
      parked,
    };
  });
}

/** Moves a fleet forward by `dtMs` (parked ones stay), for a "next refresh". */
export function step(fleet: SyntheticVehicle[], now: number, dtMs: number, seed = 2): SyntheticVehicle[] {
  const r = rng(seed);
  return fleet.map((v) => {
    if (v.parked || !v.speed) return { ...v, at: now - Math.floor(r() * 20_000) };
    const d = (v.speed * dtMs) / 1000;
    const rad = (v.heading * Math.PI) / 180;
    return {
      ...v,
      lat: v.lat + (d * Math.cos(rad)) / 111_320,
      lon: v.lon + (d * Math.sin(rad)) / (111_320 * Math.cos((v.lat * Math.PI) / 180)),
      at: now - Math.floor(r() * 20_000),
    };
  });
}
