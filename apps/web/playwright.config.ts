import { defineConfig, devices } from "@playwright/test";

// E2E_PORT lets several local worktrees run their own server side by side.
const port = Number(process.env.E2E_PORT ?? 3200);

// Runs against a production build: `pnpm build && pnpm test:e2e` (needs DATABASE_URL).
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  use: {
    baseURL: `http://localhost:${port}`,
    trace: "retain-on-failure",
    // Voice tests: a synthetic microphone and camera, granted without a prompt; screen sharing picks the screen.
    launchOptions: {
      args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", "--auto-select-desktop-capture-source=Entire screen"],
    },
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] }, testIgnore: /closed-alpha\.spec|voice-product\.spec|dm-calls\.spec/ },
    // Auth flow runs once: Better Auth rate-limits sign-in to 3 attempts per 10s per IP.
    { name: "mobile", use: { ...devices["Pixel 7"] }, testIgnore: /auth\.spec|closed-alpha\.spec|voice-product\.spec|dm-calls\.spec/ },
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
      // Requires GITHUB_ACTIONS as a second server-side gate; ordinary deployments return HTTP 404.
      OPENDISCORD_VOICE_PROOF: process.env.GITHUB_ACTIONS === "true" ? "1" : "0",
      BETTER_AUTH_URL: `http://localhost:${port}`,
      // Exercise the native versioned-key deployment in browser auth/2FA flows on disposable CI data.
      BETTER_AUTH_SECRETS: process.env.BETTER_AUTH_SECRETS ?? (process.env.CI
        ? "2:ci-primary-encryption-key-not-for-production-2026,1:ci-previous-encryption-key-not-for-production-2026"
        : ""),
      // Cloudflare's public Turnstile test keys: the widget always passes and the server accepts its dummy token.
      TURNSTILE_SITE_KEY: "1x00000000000000000000AA",
      TURNSTILE_SECRET_KEY: "1x0000000000000000000000000000000AA",
      // LiveKit in dev mode (`livekit-server --dev`); the voice spec skips when it isn't running.
      LIVEKIT_URL: process.env.LIVEKIT_URL ?? "ws://localhost:7880",
      LIVEKIT_API_KEY: process.env.LIVEKIT_API_KEY ?? "devkey",
      LIVEKIT_API_SECRET: process.env.LIVEKIT_API_SECRET ?? "secret",
      // S3-compatible storage for attachment tests (e.g. a local MinIO); those specs skip without it.
      ATTACHMENT_DIR: process.env.ATTACHMENT_DIR ?? "",
      R2_ENDPOINT: process.env.R2_ENDPOINT ?? "",
      R2_BUCKET: process.env.R2_BUCKET ?? "",
      R2_ACCESS_KEY_ID: process.env.R2_ACCESS_KEY_ID ?? "",
      R2_SECRET_ACCESS_KEY: process.env.R2_SECRET_ACCESS_KEY ?? "",
      // Web Push (VAPID); the push spec skips without keys.
      VAPID_PUBLIC_KEY: process.env.VAPID_PUBLIC_KEY ?? "",
      VAPID_PRIVATE_KEY: process.env.VAPID_PRIVATE_KEY ?? "",
      VAPID_SUBJECT: process.env.VAPID_SUBJECT ?? "",
    },
  },
});
