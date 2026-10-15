import { createRequire } from "node:module";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

// Pins Better Auth's own client-IP logic, which our rate limits rely on (not a public export).
const require = createRequire(import.meta.url);
const betterAuthDir = dirname(require.resolve("better-auth"));
const ipModule = require.resolve("@better-auth/core/utils/ip", { paths: [betterAuthDir] });
const { getIPFromHeader } = (await import(pathToFileURL(ipModule).href)) as {
  getIPFromHeader: (value: string, options: { trustedProxies?: string[] }) => string | null;
};

// Cloudflare → Traefik: Cloudflare appends the client, Traefik (trusting Cloudflare) appends the edge.
const CLOUDFLARE = ["173.245.48.0/20", "104.16.0.0/13", "2400:cb00::/32"];

describe("client IP behind trusted proxies", () => {
  it("takes the rightmost untrusted entry, ignoring values the client prepended", () => {
    expect(getIPFromHeader("203.0.113.9, 104.16.1.1", { trustedProxies: CLOUDFLARE })).toBe("203.0.113.9");
    expect(getIPFromHeader("6.6.6.6, 203.0.113.9, 173.245.48.7", { trustedProxies: CLOUDFLARE })).toBe("203.0.113.9");
  });
  it("falls back to one shared bucket without trusted proxies (why TRUSTED_PROXIES matters)", () => {
    expect(getIPFromHeader("203.0.113.9, 104.16.1.1", {})).toBeNull();
  });
  it("uses the single value Caddy writes", () => {
    expect(getIPFromHeader("198.51.100.4", { trustedProxies: CLOUDFLARE })).toBe("198.51.100.4");
  });
});
