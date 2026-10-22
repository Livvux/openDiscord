import { defineConfig, devices } from "@playwright/test";
import base from "./playwright.config";

// A bounded release gate in addition to the full Chromium desktop/mobile suite.
// No CDP-only proofs, physical-device claims or substituted browser engines.
const journeys = /(?:health|auth|registration-policy|friends-home|community|private-channels|message-features|threads|search|direct-messages|dm-groups|dm-attachments|dm-tools|dm-mobile-header|runtime-errors|csp)\.spec\.ts$/;

export default defineConfig({
  ...base,
  workers: 1,
  outputDir: "test-results/beta",
  reporter: [["list"], ["json", { outputFile: "beta-browser-results.json" }]],
  projects: [
    { name: "firefox", testMatch: journeys, use: { ...devices["Desktop Firefox"], launchOptions: {} } },
    // Playwright WebKit's push daemon issue is documented in QA-RC1. These jobs cover
    // app journeys; the required Chromium PWA tests exercise the real service worker.
    { name: "webkit", testMatch: journeys, use: { ...devices["Desktop Safari"], launchOptions: {}, serviceWorkers: "block" } },
    { name: "iphone", testMatch: journeys, use: { ...devices["iPhone 13"], launchOptions: {}, serviceWorkers: "block" } },
    { name: "edge", testMatch: journeys, use: { ...devices["Desktop Edge"], channel: "msedge" } },
  ],
});
