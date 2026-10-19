import type { MetadataRoute } from "next";

// Charcoal brand background (globals.css --color-brand-charcoal), so the splash matches the dark app.
const CHARCOAL = "#0f172a";

export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/app",
    name: "openDiscord",
    short_name: "openDiscord",
    description: "Open-source community chat with end-to-end encrypted direct messages.",
    start_url: "/app",
    scope: "/",
    display: "standalone",
    orientation: "any",
    theme_color: CHARCOAL,
    background_color: CHARCOAL,
    categories: ["social"],
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
    shortcuts: [
      { name: "Direct messages", url: "/app/messages", icons: [{ src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" }] },
      { name: "Friends", url: "/app/friends", icons: [{ src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" }] },
    ],
  };
}
