import { describe, expect, it } from "vitest";
import { SESSION_DEVICE_LABELS, sessionDeviceLabel } from "@/lib/session-device";

describe("session device metadata minimization", () => {
  it("drops versions, hardware models and arbitrary identifying data", () => {
    expect(sessionDeviceLabel("Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 Chrome/130.0.1 Safari/537.36 private-value"))
      .toBe("Chrome on Android");
    expect(sessionDeviceLabel("Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) Version/18.1 Safari/604.1")).toBe("Safari on iOS");
    expect(sessionDeviceLabel("unique-client-identifier")).toBe("Browser");
    expect(sessionDeviceLabel(null)).toBeNull();
  });

  it("keeps coarse persisted labels stable on session refresh", () => {
    for (const label of SESSION_DEVICE_LABELS) expect(sessionDeviceLabel(label)).toBe(label);
  });
});
