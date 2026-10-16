import { describe, expect, it, vi } from "vitest";
import { readVoiceResponse, createVoiceHttpClient } from "@/lib/voice/http-client";

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
    await expect(client.heartbeat({ callId: crypto.randomUUID(), memberId: crypto.randomUUID(), joinNonce: crypto.randomUUID(), expectedGeneration: 1 }, "a".repeat(64), new AbortController().signal)).rejects.toMatchObject({ code: "conflict", status: 409 });
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

it("rejects a structurally valid snapshot for a different call before passing it to an owner", async () => {
  const binding = { callId: crypto.randomUUID(), memberId: crypto.randomUUID(), joinNonce: crypto.randomUUID(), expectedGeneration: 1 };
  const callId = crypto.randomUUID(), voiceDeviceId = crypto.randomUUID(), channelId = crypto.randomUUID();
  const voiceUserId = `@voice_${callId}_${binding.memberId}:opendiscord.local`, participantIdentity = `v1:${binding.memberId}`;
  const body = { callId, channelId, generation: 1, memberId: binding.memberId, joinNonce: binding.joinNonce, voiceUserId, voiceDeviceId, participantIdentity, leaseExpiresAt: new Date(Date.now() + 30_000).toISOString(), serverTime: new Date().toISOString(), members: [{ memberId: binding.memberId, userId: "test-account", anchorDeviceId: crypto.randomUUID(), voiceUserId, voiceDeviceId, joinNonce: binding.joinNonce, participantIdentity, displayName: "Test", state: "active" }], removals: [] };
  const request = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } }));
  await expect(createVoiceHttpClient({ fetch: request }).heartbeat(binding, "a".repeat(64), new AbortController().signal)).rejects.toMatchObject({ code: "protocol" });
});

it.each(["query9", "query3users", "claim5", "claim2users"] as const)("rejects %s signature cardinality before any native verifier", async scenario => {
  const binding = { callId: crypto.randomUUID(), memberId: crypto.randomUUID(), joinNonce: crypto.randomUUID(), expectedGeneration: 1 }, deviceId = crypto.randomUUID();
  const user = `@voice_${binding.callId}_${crypto.randomUUID()}:opendiscord.local`;
  const signatures = Object.fromEntries(Array.from({ length: scenario === "query9" ? 9 : scenario === "claim5" ? 5 : 1 }, (_, index) => [`ed25519:key-${index}`, "AAAA"]));
  const signers = Object.fromEntries(Array.from({ length: scenario === "query3users" ? 3 : scenario === "claim2users" ? 2 : 1 }, (_, index) => [`signer-${index}`, signatures]));
  const query = scenario.startsWith("query");
  const request = query ? { kind: "query" as const, body: { device_keys: { [user]: [] } } } : { kind: "claim" as const, body: { one_time_keys: { [user]: { [deviceId]: "signed_curve25519" } } }, requestId: "plain-contract-claim", nativeRequestId: "plain-contract-native-id" };
  const response = query ? { device_keys: { [user]: { [deviceId]: { user_id: user, device_id: deviceId, algorithms: ["m.olm.v1.curve25519-aes-sha2", "m.megolm.v1.aes-sha2"], keys: { [`curve25519:${deviceId}`]: "AAAA", [`ed25519:${deviceId}`]: "AAAA" }, signatures: signers } } }, master_keys: {}, self_signing_keys: {}, user_signing_keys: {}, failures: {} } : { one_time_keys: { [user]: { [deviceId]: { "signed_curve25519:key": { key: "AAAA", signatures: signers } } } }, failures: {} };
  const client = createVoiceHttpClient({ fetch: vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(response), { headers: { "Content-Type": "application/json" } })) });
  await expect(client.crypto(binding, request, "a".repeat(64), new AbortController().signal)).rejects.toMatchObject({ code: "protocol" });
});
