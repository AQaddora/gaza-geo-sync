// templates/use-live-positions.ts — React hook: poll positions, decode on arrival, keep an
// offline copy. The cache stores the same JSON records whichever format travelled, so
// screens that read the cache never change.
"use client";
import { useEffect, useState } from "react";
import { fetchPositions, type PositionRecord } from "gaza-geo-sync";
import { codec } from "@/lib/geo-codec";

const CACHE_KEY = "live-positions-v1";
const INDEX_KEY = "live-positions-index-v1";

// localStorage keeps the template short; use IndexedDB for anything sizeable.
const load = <T,>(key: string, fallback: T): T => {
  try {
    return JSON.parse(localStorage.getItem(key) ?? "null") ?? fallback;
  } catch {
    return fallback;
  }
};
const save = (key: string, value: unknown) => {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* private mode or full: the live data still works */
  }
};

export function useLivePositions(url = "/api/positions", everyMs = 30_000) {
  const [positions, setPositions] = useState<PositionRecord[]>(() => (typeof window === "undefined" ? [] : load(CACHE_KEY, [])));
  const [online, setOnline] = useState(true);

  useEffect(() => {
    let alive = true;
    let cursor: string | null = null;
    const index = new Map<number, string>(load<[number, string][]>(INDEX_KEY, []));
    async function tick() {
      try {
        // No cursor yet, or a number we do not know: ask for a full sync (the server sends the index).
        const { payload, unknown } = await fetchPositions(cursor ? `${url}?since=${encodeURIComponent(cursor)}` : url, { codec, idOf: (n) => index.get(n) });
        for (const [n, id] of payload.index ?? []) index.set(n, id);
        cursor = unknown > 0 ? null : typeof payload.cursor === "string" ? payload.cursor : payload.serverTime;
        save(INDEX_KEY, [...index]);
        save(CACHE_KEY, payload.positions);
        if (alive) {
          setPositions(payload.positions);
          setOnline(true);
        }
      } catch {
        if (alive) setOnline(false); // keep showing the cached copy
      }
    }
    void tick();
    const timer = setInterval(() => document.visibilityState === "visible" && void tick(), everyMs);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [url, everyMs]);

  return { positions, online };
}
