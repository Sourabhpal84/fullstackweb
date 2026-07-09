const CACHE_NAME = "magneetoz-premium-v12";
const RUNTIME_CACHE = "magneetoz-runtime-v6";
const APP_SHELL = [
  "/",
  "/index.html",
  "/style.css",
  "/compliance.css",
  "/privacy-policy.html",
  "/terms-and-conditions.html",
  "/contact-us.html",
  "/about-us.html",
  "/theme-studio-admin.html",
  "/super-admin-dashboard.html",
  "/logo_tran.jpeg",
  "/manifest.json"
];

self.addEventListener("install", event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => Promise.all(APP_SHELL.map(url => cache.add(url).catch(() => null))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys
        .filter(key => ![CACHE_NAME, RUNTIME_CACHE].includes(key))
        .map(key => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", event => {
  if(event.request.method !== "GET") return;

  const url = new URL(event.request.url);

  // Firestore/Auth/Functions streaming and API responses must never pass
  // through Cache Storage. Caching these requests breaks WebChannel.
  if(url.origin !== self.location.origin){
    return;
  }

  if(url.pathname.endsWith(".js") || url.pathname.endsWith(".mjs")){
    event.respondWith(
      fetch(event.request)
        .then(response => {
          const copy = response.clone();
          caches.open(RUNTIME_CACHE)
            .then(cache => cache.put(event.request, copy))
            .catch(() => {});
          return response;
        })
        .catch(() => caches.match(event.request))
    );
    return;
  }

  if(url.origin === location.origin && APP_SHELL.includes(url.pathname)){
    event.respondWith(
      fetch(event.request)
        .then(response => {
          const copy = response.clone();
          caches.open(CACHE_NAME)
            .then(cache => cache.put(event.request, copy))
            .catch(() => {});
          return response;
        })
        .catch(() => caches.match(event.request))
    );
    return;
  }

  if(event.request.destination === "image"){
    event.respondWith(
      caches.open(RUNTIME_CACHE).then(cache =>
        cache.match(event.request).then(cached => cached || fetch(event.request).then(response => {
          if(response.ok) cache.put(event.request, response.clone()).catch(() => {});
          return response;
        }).catch(() => caches.match("/logo_tran.jpeg")))
      )
    );
    return;
  }

  event.respondWith(
    fetch(event.request)
      .then(response => {
        const copy = response.clone();
        caches.open(RUNTIME_CACHE)
          .then(cache => cache.put(event.request, copy))
          .catch(() => {});
        return response;
      })
      .catch(() => caches.match(event.request).then(cached => cached || Response.error()))
  );
});

self.addEventListener("message", event => {
  if(event.data?.type === "SKIP_WAITING") self.skipWaiting();
});
