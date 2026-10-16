import { afterEach, describe, expect, it, vi } from "vitest";
import { CallSession, VoiceCallSessionError } from "@/lib/voice/call-session";

const join = vi.fn();
vi.mock("@/lib/voice/http-client", async importOriginal => {
  const actual = await importOriginal<typeof import("@/lib/voice/http-client")>();
  return { ...actual, createVoiceHttpClient: () => ({ join }) };
});
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });
const options = { accountId: "account", sessionId: "session", channelId: crypto.randomUUID(), consent: true as const, assertSessionCurrent() {} };
describe("control-only CallSession bootstrap boundary", () => {
  it("imports without a browser or constructing the native owner", async () => {
    vi.stubGlobal("window", undefined);
    await expect(CallSession.create(options)).rejects.toMatchObject({ code: "browser-unavailable" });
    expect(join).not.toHaveBeenCalled();
  });
  it("requires existing DM enrollment without initializing or writing storage", async () => {
    const getItem = vi.fn(() => null), setItem = vi.fn();
    vi.stubGlobal("window", { localStorage: { getItem, setItem } });
    await expect(CallSession.create(options)).rejects.toMatchObject({ code: "messaging-setup-required" });
    expect(getItem).toHaveBeenCalledWith("opendiscord.dm.device:account"); expect(setItem).not.toHaveBeenCalled(); expect(join).not.toHaveBeenCalled();
  });
  it("releases the account guard after failed join and retains no DM store key", async () => {
    const held = new Set<string>();
    vi.stubGlobal("navigator", { locks: { async request(name: string, _options: unknown, callback: (lock: object | null) => Promise<void>) { if (held.has(name)) return callback(null); held.add(name); try { await callback({ name }); } finally { held.delete(name); } } } });
    const setItem = vi.fn();
    vi.stubGlobal("window", { localStorage: { getItem: () => JSON.stringify({ id: crypto.randomUUID(), secret: "a".repeat(64), storeKey: "never-export-this-store-key-value" }), setItem } });
    join.mockRejectedValue(new Error("join failed"));
    await expect(CallSession.create(options)).rejects.toThrow("join failed");
    expect(held.size).toBe(0); expect(setItem).not.toHaveBeenCalled();
    expect(join.mock.calls[0][1]).toEqual({ id: expect.any(String), secret: "a".repeat(64) });
    expect(join.mock.calls[0][0].enrollmentSecret).not.toBe("a".repeat(64));
    expect(join.mock.calls[0][0].voiceDeviceId).not.toBe(join.mock.calls[0][1].id);
    expect(VoiceCallSessionError).toBeDefined();
  });
});
