// Service worker for Web Push only (no caching). Shows mention notifications unless a visible
// openDiscord tab is already focused, and opens the channel when one is clicked.
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
