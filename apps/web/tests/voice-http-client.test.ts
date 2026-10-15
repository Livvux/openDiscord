import { describe, expect, it, vi } from "vitest";
import { readVoiceResponse, VoiceHttpError, createVoiceHttpClient } from "@/lib/voice/http-client";

describe("bounded voice HTTP transport", () => {
  it("cancels a stream exceeding its real byte budget despite a misleading length", async () => {
    const cancel = vi.fn();
    const response = new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(101)); }, cancel }), { headers: { "Content-Length": "1" } });
    await expect(readVoiceResponse(response, 100)).rejects.toMatchObject({ code: "protocol" });
    expect(cancel).toHaveBeenCalledOnce();
  });
  it("rejects declared oversized and malformed JSON responses", async () => {
    await expect(readVoiceResponse(new Response("{}", { headers: { "Content-Length": "101" } }), 100)).rejects.toMatchObject({ code: "protocol" });
    await expect(readVoiceResponse(new Response("no"), 100)).rejects.toMatchObject({ code: "protocol" });
  });
  it("preserves stable authorization/conflict errors without turning them into success", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ code: "conflict" }), { status: 409, headers: { "Content-Type": "application/json" } }));
    const client = createVoiceHttpClient({ fetch: request });
    await expect(client.heartbeat({ callId: crypto.randomUUID(), memberId: crypto.randomUUID(), joinNonce: crypto.randomUUID(), expectedGeneration: 1 }, "a".repeat(64), new AbortController().signal)).rejects.toBeInstanceOf(VoiceHttpError);
    expect(request).toHaveBeenCalledOnce();
  });
  it("does not start a request after cancellation", async () => {
    const request = vi.fn<typeof fetch>(); const abort = new AbortController(); abort.abort();
    const client = createVoiceHttpClient({ fetch: request });
    await expect(client.heartbeat({ callId: crypto.randomUUID(), memberId: crypto.randomUUID(), joinNonce: crypto.randomUUID(), expectedGeneration: 1 }, "a".repeat(64), abort.signal)).rejects.toMatchObject({ code: "aborted" });
    expect(request).not.toHaveBeenCalled();
  });
});

describe("Voice HTTP wire identity and cancellation", () => {
  it("keeps exact native body and native/transport IDs across an explicit caller retry", async () => {
    const request = vi.fn<typeof fetch>().mockImplementation(async () => new Response(JSON.stringify({ one_time_keys: {}, failures: {} }), { headers: { "Content-Type": "application/json" } }));
    const client = createVoiceHttpClient({ fetch: request }), signal = new AbortController().signal;
    const binding = { callId: crypto.randomUUID(), memberId: crypto.randomUUID(), joinNonce: crypto.randomUUID(), expectedGeneration: 7 };
    const work = { kind: "claim" as const, body: { one_time_keys: { "@voice_peer:opendiscord.local": { device: "signed_curve25519" } } }, requestId: "transport-original", nativeRequestId: "native-original" };
    await client.crypto(binding, work, "a".repeat(64), signal); await client.crypto(binding, work, "a".repeat(64), signal);
    const first = request.mock.calls[0][1], second = request.mock.calls[1][1];
    expect(first?.body).toBe(second?.body);
    expect(JSON.parse(String(first?.body))).toEqual({ action: "crypto", input: { ...binding, request: work } });
    expect(first?.credentials).toBe("same-origin"); expect(first?.cache).toBe("no-store"); expect(first?.redirect).toBe("error");
  });
  it("cancels a stalled response reader at its deadline without retry", async () => {
    const cancel = vi.fn();
    const request = vi.fn<typeof fetch>().mockResolvedValue(new Response(new ReadableStream({ cancel }), { headers: { "Content-Type": "application/json" } }));
    const client = createVoiceHttpClient({ fetch: request, timeoutMs: 5 });
    await expect(client.heartbeat({ callId: crypto.randomUUID(), memberId: crypto.randomUUID(), joinNonce: crypto.randomUUID(), expectedGeneration: 1 }, "a".repeat(64), new AbortController().signal)).rejects.toMatchObject({ code: "timeout" });
    expect(cancel).toHaveBeenCalledOnce(); expect(request).toHaveBeenCalledOnce();
  });
  it("rejects a forged status/code combination as protocol failure", async () => {
    const client = createVoiceHttpClient({ fetch: vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ code: "conflict" }), { status: 403 })) });
    await expect(client.heartbeat({ callId: crypto.randomUUID(), memberId: crypto.randomUUID(), joinNonce: crypto.randomUUID(), expectedGeneration: 1 }, "a".repeat(64), new AbortController().signal)).rejects.toMatchObject({ code: "protocol" });
  });
});
