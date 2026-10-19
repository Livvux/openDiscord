import { defineConfig, devices } from "@playwright/test";
import base from "./playwright.config";

const server = base.webServer;
if (!server || Array.isArray(server)) throw new Error("Voice product acceptance requires the actual single Next server.");

// VOICE_PRODUCT_BROWSER=firefox runs the same spec through RTCRtpScriptTransform instead of
// Chromium's encoded streams. Prefs: fake media without prompts, and loopback host ICE so
// Firefox can reach the loopback-only test SFU (test environment only; real SFUs are not loopback).
// VOICE_PRODUCT_BROWSER=webkit runs it in Playwright WebKit (Safari's engine, RTCRtpScriptTransform too).
const choice = process.env.VOICE_PRODUCT_BROWSER;
const firefox = choice === "firefox", webkit = choice === "webkit";
const browser = firefox
  ? { ...devices["Desktop Firefox"], launchOptions: { firefoxUserPrefs: { "media.navigator.streams.fake": true, "media.navigator.permission.disabled": true, "media.peerconnection.ice.loopback": true, "media.peerconnection.ice.obfuscate_host_addresses": false } } }
  // WebKit sends a page's fetches through its service worker, where page.route cannot see them; the
  // worker only adds push and an offline page, so it is blocked for the request observers.
  : webkit ? { ...devices["Desktop Safari"], launchOptions: {}, serviceWorkers: "block" as const } : devices["Desktop Chrome"];

export default defineConfig({
  ...base,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  // Separate output so a second browser run does not wipe the first run's evidence.
  outputDir: firefox || webkit ? `test-results/${choice}` : undefined,
  use: { ...base.use, ...browser, trace: "off" },
  projects: [{ name: firefox || webkit ? `voice-product-${choice}` : "voice-product", testMatch: /voice-product\.spec|dm-calls\.spec/ }],
  webServer: { ...server, reuseExistingServer: false },
});
