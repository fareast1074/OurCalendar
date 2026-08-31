const CACHE = "pastel-calendar-v1";
const ASSETS = ["./","./index.html","./styles.css","./app.js","./firebase-config.js","./manifest.json"];
self.addEventListener("install", event => event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(ASSETS)).then(()=>self.skipWaiting())));
self.addEventListener("activate", event => event.waitUntil(self.clients.claim()));
self.addEventListener("fetch", event => {
  if (event.request.method !== "GET") return;
  event.respondWith(caches.match(event.request).then(cached => cached || fetch(event.request).then(res => {
    const copy=res.clone(); caches.open(CACHE).then(cache=>cache.put(event.request,copy)); return res;
  }).catch(()=>caches.match("./index.html"))));
});
