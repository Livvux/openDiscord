import { randomBytes, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { db } from "@/db";
import { channel, session } from "@/db/schema";
import { voiceControlReceipt, voiceIdentity, voicePrekey } from "@/db/voice-schema";
import { createVoiceHttpClient } from "@/lib/voice/http-client";
import type { VoiceCryptoRequest } from "@/lib/voice/contracts";
import { acceptInvite, createCommunity, createInvite } from "@/server/communities";
import { registerDmDevice } from "@/server/direct-messages";
import { handleVoiceCrypto, heartbeatVoiceControl, joinVoiceControl } from "@/server/voice-control";
import { testUsers } from "./helpers";

// Plain public JSON/DB resource-contract fixtures only. These synthetic signatures are NEVER
// passed to a native SDK, signature verifier, markRequestAsSent or an admission/trust operation.
const users = testUsers();
afterAll(() => users.cleanup());
const signature = Buffer.alloc(64, 7).toString("base64");
const publicKey = (byte: number) => Buffer.alloc(32, byte).toString("base64");
const initialKeys = (count = 4) => Object.fromEntries(Array.from({ length: count }, (_, index): [string, string] => [`ed25519:initial-${index}`, signature]));
type Party = Awaited<ReturnType<typeof fixture>>[number];
async function fixture(count = 1) {
  const accounts = [];
  for (let i = 0; i < count; i++) {
    const userId = await users.create(`Signature contract ${i}`), sessionId = randomUUID(), anchorDeviceId = randomUUID(), anchorSecret = randomBytes(32).toString("hex");
    await db.insert(session).values({ id: sessionId, userId, token: randomUUID(), expiresAt: new Date(Date.now() + 3_600_000) });
    await registerDmDevice(userId, sessionId, { id: anchorDeviceId, secret: anchorSecret, name: "JSON contract anchor" });
    accounts.push({ userId, sessionId, anchorDeviceId, anchorSecret });
  }
  const community = await createCommunity(accounts[0].userId, "Signature JSON contract");
  const invite = await createInvite(accounts[0].userId, community.communityId, { expiresInHours: 1, maxUses: null });
  for (const account of accounts.slice(1)) await acceptInvite(account.userId, invite);
  const [room] = await db.insert(channel).values({ communityId: community.communityId, kind: "voice", name: "signature-contract" }).returning();
  const parties = [];
  for (const account of accounts) {
    const secret = randomBytes(32).toString("hex");
    const snapshot = await joinVoiceControl(account, { channelId: room.id, joinNonce: randomUUID(), voiceDeviceId: randomUUID(), enrollmentSecret: secret, consent: true });
    parties.push({ auth: { userId: account.userId, sessionId: account.sessionId, memberId: snapshot.memberId, secret }, snapshot });
  }
  for (const party of parties) party.snapshot = await heartbeatVoiceControl(party.auth, binding(party));
  return parties;
}
function binding(party: { snapshot: { callId: string; memberId: string; joinNonce: string; generation: number } }) { const s = party.snapshot; return { callId: s.callId, memberId: s.memberId, joinNonce: s.joinNonce, expectedGeneration: s.generation }; }
function wire(party: Party, request: VoiceCryptoRequest) { return handleVoiceCrypto(party.auth, { ...binding(party), request }); }
function device(party: Party, keys = initialKeys()) {
  return { user_id: party.snapshot.voiceUserId, device_id: party.snapshot.voiceDeviceId, algorithms: ["m.olm.v1.curve25519-aes-sha2", "m.megolm.v1.aes-sha2"], keys: { [`curve25519:${party.snapshot.voiceDeviceId}`]: publicKey(1), [`ed25519:${party.snapshot.voiceDeviceId}`]: publicKey(2) }, signatures: { [party.snapshot.voiceUserId]: keys } };
}
type SigningObject = { user_id: string; usage: string[]; keys: Record<string, string>; signatures: Record<string, Record<string, string>> };
function signing(party: Party, count = 4): Record<string, SigningObject> {
  return Object.fromEntries(["master", "self_signing", "user_signing"].map((usage, index): [string, SigningObject] => [`${usage}_key`, { user_id: party.snapshot.voiceUserId, usage: [usage], keys: { [`ed25519:${publicKey(index + 3)}`]: publicKey(index + 3) }, signatures: { [party.snapshot.voiceUserId]: initialKeys(count) } }]));
}
function prekey(party: Party, fallback = false, count = 4) { return { key: publicKey(fallback ? 9 : 8), signatures: { [party.snapshot.voiceUserId]: initialKeys(count) }, ...(fallback ? { fallback: true } : {}) }; }
async function bootstrap(party: Party) { await wire(party, { kind: "upload", body: { device_keys: device(party) }, requestId: randomUUID() }); await wire(party, { kind: "signing", body: signing(party) }); }
async function stored(party: Party) {
  return {
    identities: await db.select({ device: voiceIdentity.deviceKeys, signing: voiceIdentity.crossSigningKeys }).from(voiceIdentity).where(eq(voiceIdentity.memberId, party.snapshot.memberId)),
    prekeys: await db.select({ id: voicePrekey.keyId, content: voicePrekey.content, used: voicePrekey.used, fallback: voicePrekey.fallback, retired: voicePrekey.retired }).from(voicePrekey).where(eq(voicePrekey.memberId, party.snapshot.memberId)),
    receipts: await db.select({ request: voiceControlReceipt.requestId, response: voiceControlReceipt.response }).from(voiceControlReceipt).where(eq(voiceControlReceipt.senderMemberId, party.snapshot.memberId)),
  };
}
const signed = z.object({ signatures: z.record(z.string(), z.record(z.string(), z.string())) }).passthrough();
const querySchema = z.object({ device_keys: z.record(z.string(), z.record(z.string(), signed)), master_keys: z.record(z.string(), signed) }).passthrough();
async function clientResponse(party: Party, request: VoiceCryptoRequest, response: unknown) {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(response), { headers: { "Content-Type": "application/json" } }));
  return createVoiceHttpClient({ fetch: fetcher }).crypto(binding(party), request, party.auth.secret, new AbortController().signal);
}

describe("finite public JSON voice signature contract before any native verifier", () => {
  it("accepts four initial own signatures before signing IDs are stored", async () => {
    const [party] = await fixture(); await bootstrap(party);
    await wire(party, { kind: "upload", body: { one_time_keys: { "signed_curve25519:ordinary": prekey(party) }, fallback_keys: { "signed_curve25519:fallback": prekey(party, true) } }, requestId: randomUUID() });
    const state = await stored(party); expect(state.identities).toHaveLength(1); expect(state.prekeys).toHaveLength(2);
  });
  it.each(["device", "master", "self_signing", "user_signing", "ordinary", "fallback"] as const)("rejects five initial %s signatures atomically", async kind => {
    const [party] = await fixture();
    if (kind !== "device") await wire(party, { kind: "upload", body: { device_keys: device(party) }, requestId: randomUUID() });
    const before = await stored(party);
    let request: VoiceCryptoRequest;
    if (kind === "device") request = { kind: "upload", body: { device_keys: device(party, initialKeys(5)) }, requestId: randomUUID() };
    else if (kind === "ordinary" || kind === "fallback") request = { kind: "upload", body: { device_keys: device(party), [kind === "ordinary" ? "one_time_keys" : "fallback_keys"]: { "signed_curve25519:too-many": prekey(party, kind === "fallback", 5) } }, requestId: randomUUID() };
    else { const body = signing(party); body[`${kind}_key`].signatures[party.snapshot.voiceUserId] = initialKeys(5); request = { kind: "signing", body }; }
    await expect(wire(party, request)).rejects.toMatchObject({ code: "invalid" });
    expect(await stored(party)).toEqual(before);
  });
  it("still rejects a foreign initial signer user without writing partial identity", async () => {
    const [party] = await fixture(); const item = device(party); item.signatures = { foreign: initialKeys() };
    const before = await stored(party);
    await expect(wire(party, { kind: "upload", body: { device_keys: item } })).rejects.toMatchObject({ code: "invalid" });
    expect(await stored(party)).toEqual(before);
  });
  it("roundtrips real device/master query union8 and requester4, replaces stored signatures and never caches query", async () => {
    const [target, requester] = await fixture(2); await bootstrap(target); await bootstrap(requester);
    const known = (party: Party) => Object.fromEntries([`ed25519:${party.snapshot.voiceDeviceId}`, ...[3, 4, 5].map(index => `ed25519:${publicKey(index)}`)].map((key): [string, string] => [key, signature]));
    const targetMaster = signing(target).master_key;
    const upload = async (signer: Party, keys: Record<string, string>) => wire(signer, { kind: "signatures", body: { [target.snapshot.voiceUserId]: { [target.snapshot.voiceDeviceId]: { ...device(target), signatures: { [signer.snapshot.voiceUserId]: keys } }, [publicKey(3)]: { ...targetMaster, signatures: { [signer.snapshot.voiceUserId]: keys } } } }, requestId: randomUUID() });
    await upload(target, known(target)); await upload(requester, known(requester));
    const request: VoiceCryptoRequest = { kind: "query", body: { device_keys: { [target.snapshot.voiceUserId]: [] } }, requestId: randomUUID() };
    const result = await wire(requester, request), parsed = querySchema.parse(result);
    for (const item of [parsed.device_keys[target.snapshot.voiceUserId][target.snapshot.voiceDeviceId], parsed.master_keys[target.snapshot.voiceUserId]]) {
      expect(Object.keys(item.signatures)).toHaveLength(2); expect(Object.keys(item.signatures[target.snapshot.voiceUserId])).toHaveLength(8); expect(Object.keys(item.signatures[requester.snapshot.voiceUserId])).toHaveLength(4);
    }
    await expect(clientResponse(requester, request, result)).resolves.toBeDefined();
    await upload(target, { [`ed25519:${target.snapshot.voiceDeviceId}`]: signature });
    const replaced = await wire(requester, request), replacement = querySchema.parse(replaced);
    for (const item of [replacement.device_keys[target.snapshot.voiceUserId][target.snapshot.voiceDeviceId], replacement.master_keys[target.snapshot.voiceUserId]]) expect(Object.keys(item.signatures[target.snapshot.voiceUserId])).toHaveLength(5);
    await expect(clientResponse(requester, request, replaced)).resolves.toBeDefined();
  });
  it("roundtrips ordinary and fallback claim own4, exact retry consumes no second key", async () => {
    const [target, requester] = await fixture(2); await bootstrap(target); await bootstrap(requester);
    await wire(target, { kind: "upload", body: { one_time_keys: { "signed_curve25519:ordinary": prekey(target) }, fallback_keys: { "signed_curve25519:fallback": prekey(target, true) } }, requestId: randomUUID() });
    const request: VoiceCryptoRequest = { kind: "claim", body: { one_time_keys: { [target.snapshot.voiceUserId]: { [target.snapshot.voiceDeviceId]: "signed_curve25519" } } }, requestId: randomUUID(), nativeRequestId: randomUUID() };
    const first = await wire(requester, request); await expect(clientResponse(requester, request, first)).resolves.toBeDefined();
    expect(await wire(requester, request)).toEqual(first);
    expect((await stored(target)).prekeys.filter(key => key.used)).toHaveLength(1);
    const fallback = await wire(requester, { ...request, requestId: randomUUID(), nativeRequestId: randomUUID() });
    await expect(clientResponse(requester, request, fallback)).resolves.toBeDefined();
    expect(JSON.stringify(fallback)).toContain('"fallback":true'); expect((await stored(target)).prekeys.filter(key => key.used && !key.fallback)).toHaveLength(1);
  });
});
