import { afterEach, describe, expect, it, vi } from "vitest";
import { voiceRoomService } from "@/server/voice-sfu";

afterEach(() => vi.restoreAllMocks());

describe("public SDK bounds", () => {
  it("passes a half-second timeout through the public SDK in seconds", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("{}", { status: 200 }));
    const client = voiceRoomService();
    expect(client).not.toBeNull();
    await client!.createRoom({ name: "sdk-timeout-contract" });
    expect(timeout).toHaveBeenCalledWith(500);
  });

  it("does not multiply failed SDK requests through region failover", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response('{"code":"unavailable","msg":"generic"}', { status: 503 }));
    const client = voiceRoomService();
    expect(client).not.toBeNull();
    await expect(client!.createRoom({ name: "sdk-failover-contract" })).rejects.toBeDefined();
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
