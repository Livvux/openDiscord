import { defineConfig, devices } from "@playwright/test";
import base from "./playwright.config";

const server = base.webServer;
if (!server || Array.isArray(server)) throw new Error("Scanner acceptance requires the app's single web server");

// A separate disposable job owns the engine, database and storage for this acceptance.
export default defineConfig({
  ...base,
  testDir: "./scanner-acceptance",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 120_000,
  use: { ...base.use, ...devices["Desktop Chrome"], trace: "off" },
  projects: [{ name: "real-clamav" }],
  webServer: {
    ...server,
    command: "cp -r .next/static .next/standalone/apps/web/.next/ && cp -r public .next/standalone/apps/web/ && node .next/standalone/apps/web/server.js",
    url: "http://localhost:3200",
    reuseExistingServer: false,
    env: {
      ...server.env,
      CLAMAV_HOST: "127.0.0.1",
      CLAMAV_PORT: "3310",
    },
  },
});
