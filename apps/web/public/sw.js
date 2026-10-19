// Service worker: Web Push and an offline fallback page. Shows mention and DM notifications unless a
// visible openDiscord tab is already focused, and opens the channel when one is clicked.
//
// Caching is limited to the static /offline.html. Only page navigations are intercepted, and only to
// substitute that page when the network fails; no response is ever stored, so authenticated pages,
// API responses and DM data never reach Cache Storage.
const OFFLINE_CACHE = "od-offline-v1";
const OFFLINE_URL = "/offline.html";

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(OFFLINE_CACHE)
      .then((cache) => cache.add(new Request(OFFLINE_URL, { cache: "reload" })))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) {
      if (key.startsWith("od-offline-") && key !== OFFLINE_CACHE) await caches.delete(key);
    }
    // Lets the browser start the page request while the worker boots, so navigations aren't slowed down.
    await self.registration.navigationPreload?.enable();
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  if (event.request.mode !== "navigate") return;
  event.respondWith((async () => {
    try {
      return (await event.preloadResponse) || (await fetch(event.request));
    } catch {
      return (await caches.match(OFFLINE_URL)) || Response.error();
    }
  })());
});

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    return;
  }
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((tabs) => {
      if (tabs.some((tab) => tab.focused && tab.visibilityState === "visible")) return;
      return self.registration.showNotification(data.title || "openDiscord", {
        body: data.body || "",
        tag: data.tag,
        icon: "/icon.svg",
        data: { url: typeof data.url === "string" && data.url.startsWith("/app/") ? data.url : "/app" },
      });
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = event.notification.data?.url || "/app";
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((tabs) => {
      const tab = tabs.find((t) => new URL(t.url).origin === self.location.origin);
      if (tab) return tab.focus().then(() => tab.navigate(url));
      return self.clients.openWindow(url);
    }),
  );
});
