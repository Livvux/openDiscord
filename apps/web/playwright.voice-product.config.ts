import { defineConfig, devices } from "@playwright/test";
import base from "./playwright.config";

const server = base.webServer;
if (!server || Array.isArray(server)) throw new Error("Voice product acceptance requires the actual single Next server.");

export default defineConfig({
  ...base,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  use: { ...base.use, ...devices["Desktop Chrome"], trace: "off" },
  projects: [{ name: "voice-product", testMatch: /voice-product\.spec/ }],
  webServer: { ...server, reuseExistingServer: false },
});
