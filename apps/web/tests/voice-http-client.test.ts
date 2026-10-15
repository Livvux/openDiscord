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
