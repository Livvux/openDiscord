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
    { name: "desktop", use: { ...devices["Desktop Chrome"] } },
    // Auth flow runs once: Better Auth rate-limits sign-in to 3 attempts per 10s per IP.
    { name: "mobile", use: { ...devices["Pixel 7"] }, testIgnore: /auth\.spec/ },
  ],
  webServer: {
    // Same artefact as the Docker image: the standalone server plus its static assets.
    command:
      "cp -r .next/static .next/standalone/apps/web/.next/ && cp -r public .next/standalone/apps/web/ && node .next/standalone/apps/web/server.js",
    url: `http://localhost:${port}`,
    reuseExistingServer: !process.env.CI,
    env: { PORT: String(port), BETTER_AUTH_URL: `http://localhost:${port}` },
  },
});
