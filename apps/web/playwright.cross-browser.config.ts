import { defineConfig, devices } from "@playwright/test";
import base from "./playwright.config";

// RC1 cross-engine QA: the regular suite in Firefox, WebKit (Safari's engine) and an emulated iPhone 13.
// Opt-in only (`playwright test --config playwright.cross-browser.config.ts`); CI keeps the base config.
// Emulation evidence, not physical devices. Run one --project at a time: Better Auth rate-limits sign-in per IP.
// voice-worker/voice-three-browser/voice-media-session are Chromium encoded-streams harness proofs (Chromium-only
// permission names, CDP); Firefox/WebKit E2EE voice and DM calls run via playwright.voice-product.config.ts.
const chromiumProofs = "voice-worker|voice-three-browser|voice-media-session";
const skip = new RegExp(`closed-alpha\\.spec|voice-product\\.spec|dm-calls\\.spec|${chromiumProofs}`);
// Fake media without prompts and loopback ICE for the local SFU, as in playwright.voice-product.config.ts.
const firefoxMedia = { firefoxUserPrefs: { "media.navigator.streams.fake": true, "media.navigator.permission.disabled": true, "media.peerconnection.ice.loopback": true, "media.peerconnection.ice.obfuscate_host_addresses": false } };

// Playwright WebKit (no push daemon): PushManager.getSubscription() on the settings page reloads the page and
// leaves it unscriptable, so the service worker is blocked there; webkit-sw keeps it for the PWA and push specs.
const sw = /pwa\.spec|push\.spec/;
const safari = { ...devices["Desktop Safari"], launchOptions: {} };

export default defineConfig({
  ...base,
  // Separate output so cross-browser evidence never overwrites a default run.
  outputDir: "test-results/cross-browser",
  projects: [
    { name: "firefox", use: { ...devices["Desktop Firefox"], launchOptions: firefoxMedia }, testIgnore: skip },
    { name: "webkit", use: { ...safari, serviceWorkers: "block" }, testIgnore: [skip, sw] },
    { name: "webkit-sw", use: safari, testMatch: sw },
    { name: "iphone", use: { ...devices["iPhone 13"], launchOptions: {}, serviceWorkers: "block" }, testIgnore: [skip, sw, /auth\.spec/] },
    { name: "iphone-sw", use: { ...devices["iPhone 13"], launchOptions: {} }, testMatch: sw },
  ],
});
