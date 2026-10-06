// templates/service-worker-cache.js — what a service worker should do with this format.
//
// 1. Never cache the positions endpoint in Cache Storage. Live positions are stale in
//    seconds, and the binary frame is only meaningful with the client's index table.
//    The app decodes on arrival and keeps JSON records in IndexedDB (see the hook).
// 2. Never queue a point upload in an offline outbox: a position that waited is stale,
//    and stale is worse than none. The next fix replaces it.
// 3. Keep `Vary: Accept` working: if some generic caching layer sits in front, it must
//    key on Accept, or a JSON client could be served a binary body.
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (url.pathname === "/api/positions" || url.pathname === "/api/position") {
    // Network only. If it fails, the page falls back to its IndexedDB copy.
    event.respondWith(fetch(event.request));
    return;
  }
  // ... your existing app-shell / static caching
});
