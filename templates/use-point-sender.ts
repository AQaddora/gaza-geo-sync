// templates/use-point-sender.ts — React hook for a driver / a rider sharing location.
// Binary (8 B) first, JSON if the server refuses; one point a minute while standing still.
"use client";
import { useEffect, useRef } from "react";
import { createPointSender } from "gaza-geo-sync";
import { codec } from "@/lib/geo-codec";

export function usePointSender(active: boolean, url = "/api/position", id?: string) {
  const latest = useRef<GeolocationPosition | null>(null);
  useEffect(() => {
    if (!active || !("geolocation" in navigator)) return;
    const sender = createPointSender({ url, codec, id });
    const watch = navigator.geolocation.watchPosition((p) => (latest.current = p), undefined, { enableHighAccuracy: true, maximumAge: 5_000 });
    // Every 15 s offer the newest fix; the sender skips it when we have not moved 15 m.
    const timer = setInterval(() => {
      const p = latest.current;
      if (p) void sender.offer({ lat: p.coords.latitude, lon: p.coords.longitude, speed: p.coords.speed, heading: p.coords.heading, fixAt: p.timestamp });
    }, 15_000);
    return () => {
      navigator.geolocation.clearWatch(watch);
      clearInterval(timer);
    };
  }, [active, url, id]);
}
