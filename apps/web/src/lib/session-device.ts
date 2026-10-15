const BROWSERS = ["Firefox", "Edge", "Chrome", "Safari", "Browser"] as const;
const PLATFORMS = ["Windows", "Android", "iOS", "macOS", "Linux"] as const;

/** Only these coarse labels may be persisted; versions and device models are discarded. */
export const SESSION_DEVICE_LABELS = BROWSERS.flatMap((browser) => [
  browser,
  ...PLATFORMS.map((platform) => `${browser} on ${platform}`),
]);

export function sessionDeviceLabel(agent: string | null | undefined): string | null {
  if (!agent) return null;
  if (SESSION_DEVICE_LABELS.includes(agent)) return agent;
  const browser = /Firefox\//.test(agent) ? "Firefox" : /Edg\//.test(agent) ? "Edge" : /Chrome\//.test(agent) ? "Chrome" : /Safari\//.test(agent) ? "Safari" : "Browser";
  const platform = /Windows/.test(agent) ? "Windows" : /Android/.test(agent) ? "Android" : /iPhone|iPad/.test(agent) ? "iOS" : /Mac OS X/.test(agent) ? "macOS" : /Linux/.test(agent) ? "Linux" : null;
  return platform ? `${browser} on ${platform}` : browser;
}
