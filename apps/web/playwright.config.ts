import { defineConfig, devices } from "@playwright/test";

const port = 3200;

// Runs against a production build: `pnpm build && pnpm test:e2e` (needs DATABASE_URL).
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  use: { baseURL: `http://localhost:${port}`, trace: "retain-on-failure" },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] }, testIgnore: /closed-alpha\.spec/ },
    // Auth flow runs once: Better Auth rate-limits sign-in to 3 attempts per 10s per IP.
    { name: "mobile", use: { ...devices["Pixel 7"] }, testIgnore: /auth\.spec|closed-alpha\.spec/ },
    // Toggles an instance-wide setting, so it must not overlap with other sign-ups.
    { name: "closed-alpha", use: { ...devices["Desktop Chrome"] }, testMatch: /closed-alpha\.spec/, dependencies: ["desktop", "mobile"] },
  ],
  webServer: {
    // Same artefact as the Docker image: the standalone server plus its static assets.
    command:
      "cp -r .next/static .next/standalone/apps/web/.next/ && cp -r public .next/standalone/apps/web/ && node .next/standalone/apps/web/server.js",
    url: `http://localhost:${port}`,
    reuseExistingServer: !process.env.CI,
    env: {
      PORT: String(port),
      BETTER_AUTH_URL: `http://localhost:${port}`,
      // Cloudflare's public Turnstile test keys: the widget always passes and the server accepts its dummy token.
      TURNSTILE_SITE_KEY: "1x00000000000000000000AA",
      TURNSTILE_SECRET_KEY: "1x0000000000000000000000000000000AA",
    },
  },
});
