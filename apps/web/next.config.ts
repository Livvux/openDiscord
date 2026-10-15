import type { NextConfig } from "next";

// The Content-Security-Policy is set per request in src/proxy.ts: it depends on runtime settings
// (the LiveKit server for voice), which a build-time config can't know.
const securityHeaders = [
  // Also behind proxies that don't add it (e.g. Traefik on Dokploy); browsers ignore it over plain HTTP.
  { key: "Strict-Transport-Security", value: "max-age=31536000" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
  // Microphone for voice channels on this origin only; never for embedded third parties.
  { key: "Permissions-Policy", value: "camera=(), microphone=(self), geolocation=(), browsing-topics=()" },
];

const nextConfig: NextConfig = {
  output: "standalone",
  cacheComponents: true,
  partialPrefetching: true,
  poweredByHeader: false,
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
