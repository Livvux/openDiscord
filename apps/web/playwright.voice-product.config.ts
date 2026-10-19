import { defineConfig, devices } from "@playwright/test";
import base from "./playwright.config";

const server = base.webServer;
if (!server || Array.isArray(server)) throw new Error("Voice product acceptance requires the actual single Next server.");

// VOICE_PRODUCT_BROWSER=firefox runs the same spec through RTCRtpScriptTransform instead of
// Chromium's encoded streams. Prefs: fake media without prompts, and loopback host ICE so
// Firefox can reach the loopback-only test SFU (test environment only; real SFUs are not loopback).
const firefox = process.env.VOICE_PRODUCT_BROWSER === "firefox";
const browser = firefox
  ? { ...devices["Desktop Firefox"], launchOptions: { firefoxUserPrefs: { "media.navigator.streams.fake": true, "media.navigator.permission.disabled": true, "media.peerconnection.ice.loopback": true, "media.peerconnection.ice.obfuscate_host_addresses": false } } }
  : devices["Desktop Chrome"];

export default defineConfig({
  ...base,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  // Separate output so a second browser run does not wipe the first run's evidence.
  outputDir: firefox ? "test-results/firefox" : undefined,
  use: { ...base.use, ...browser, trace: "off" },
  projects: [{ name: firefox ? "voice-product-firefox" : "voice-product", testMatch: /voice-product\.spec/ }],
  webServer: { ...server, reuseExistingServer: false },
});
