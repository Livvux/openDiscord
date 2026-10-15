import { createHash, randomBytes, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import * as C from "@matrix-org/matrix-sdk-crypto-wasm";
import { and, eq, inArray, SQL, sql } from "drizzle-orm";
import { z } from "zod";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { db } from "@/db";
import { channel, dmDevice, dmIdentity, dmKey, dmMailbox, dmMessage, dmSignature, member, role, session, userBlock } from "@/db/schema";
import { acceptInvite, createCommunity, createInvite } from "@/server/communities";
import { registerDmDevice } from "@/server/direct-messages";
import { heartbeatVoiceControl, invalidateVoiceMembership, joinVoiceControl, leaveVoiceControl, handleVoiceCrypto } from "@/server/voice-control";
import { voiceCall, voiceCallMember, voiceControlMailbox, voiceControlReceipt, voiceIdentity, voicePrekey, voiceSignature } from "@/db/voice-schema";
import { VOICE_LIMITS, type VoiceSnapshot } from "@/lib/voice/contracts";
import { Permission } from "@/server/permissions";
import { testUsers } from "./helpers";

const users = testUsers();
let userId: string, channelId: string;
const sessionId = randomUUID(), anchorDeviceId = randomUUID();
const anchorSecret = randomBytes(32).toString("hex"), enrollmentSecret = randomBytes(32).toString("hex");
const joinNonce = randomUUID(), voiceDeviceId = randomUUID();
const auth = () => ({ userId, sessionId, anchorDeviceId, anchorSecret });
const join = () => ({ channelId, joinNonce, voiceDeviceId, enrollmentSecret, consent: true });
beforeAll(async () => {
  userId = await users.create("Voice control draft");
  await db.insert(session).values({ id: sessionId, userId, token: randomUUID(), expiresAt: new Date(Date.now() + 3_600_000) });
  await registerDmDevice(userId, sessionId, { id: anchorDeviceId, secret: anchorSecret, name: "Enrollment only" });
  const c = await createCommunity(userId, "Voice control draft");
  const [ch] = await db.insert(channel).values({ communityId: c.communityId, name: "voice-draft", kind: "voice" }).returning({ id: channel.id });
  channelId = ch.id;
});
afterAll(() => users.cleanup());

describe("unactivated voice control server admission", () => {
  it("creates a server-owned namespace and preserves the entire exact nonce binding", async () => {
    const first = await joinVoiceControl(auth(), join());
    expect(first).toMatchObject({ channelId, joinNonce, voiceDeviceId, generation: 1 });
    expect(first.voiceUserId).toBe(`@voice_${first.callId}_${first.memberId}:opendiscord.local`);
    expect(first.participantIdentity).toBe(`v1:${first.memberId}`);
    expect(await joinVoiceControl(auth(), join())).toMatchObject({ memberId: first.memberId, callId: first.callId });
    expect(JSON.stringify(first)).not.toContain(enrollmentSecret);
  });
  it("rejects nonce reuse with a different secret, voice device or session", async () => {
    for (const changed of [{ enrollmentSecret: randomBytes(32).toString("hex") }, { voiceDeviceId: randomUUID() }]) {
      await expect(joinVoiceControl(auth(), { ...join(), ...changed })).rejects.toMatchObject({ code: "conflict" });
    }
    const otherSession = randomUUID();
    await db.insert(session).values({ id: otherSession, userId, token: randomUUID(), expiresAt: new Date(Date.now() + 3_600_000) });
    await expect(joinVoiceControl({ ...auth(), sessionId: otherSession }, join())).rejects.toMatchObject({ code: "conflict" });
    const otherAnchor = randomUUID(), otherSecret = randomBytes(32).toString("hex");
    await registerDmDevice(userId, sessionId, { id: otherAnchor, secret: otherSecret, name: "Other valid anchor" });
    await expect(joinVoiceControl({ ...auth(), anchorDeviceId: otherAnchor, anchorSecret: otherSecret }, join())).rejects.toMatchObject({ code: "conflict" });
  });
});

type Endpoint = { userId: string; sessionId: string; anchorDeviceId: string; anchorSecret: string; secret: string; snapshot: VoiceSnapshot };
const memberAuth = (e: Endpoint) => ({ userId: e.userId, sessionId: e.sessionId, memberId: e.snapshot.memberId, secret: e.secret });
const binding = (e: Endpoint) => ({ callId: e.snapshot.callId, memberId: e.snapshot.memberId, joinNonce: e.snapshot.joinNonce, expectedGeneration: e.snapshot.generation });
const crypto = (e: Endpoint, request: unknown) => handleVoiceCrypto(memberAuth(e), { ...binding(e), request });
async function refresh(e: Endpoint) { e.snapshot = await heartbeatVoiceControl(memberAuth(e), binding(e)); }
async function account(name: string) {
  const userId = await users.create(name), sessionId = randomUUID(), anchorDeviceId = randomUUID(), anchorSecret = randomBytes(32).toString("hex");
  await db.insert(session).values({ id: sessionId, userId, token: randomUUID(), expiresAt: new Date(Date.now() + 3_600_000) });
  await registerDmDevice(userId, sessionId, { id: anchorDeviceId, secret: anchorSecret, name: "Voice enrollment anchor" });
  return { userId, sessionId, anchorDeviceId, anchorSecret };
}
async function fixture(count = 2) {
  const accounts = await Promise.all(Array.from({ length: count }, (_, i) => account(`Voice isolated ${i}`)));
  const c = await createCommunity(accounts[0].userId, "Voice draft fixture");
  const code = await createInvite(accounts[0].userId, c.communityId, { expiresInHours: 24, maxUses: null });
  for (const a of accounts.slice(1)) await acceptInvite(a.userId, code);
  const [ch] = await db.insert(channel).values({ communityId: c.communityId, name: "voice", kind: "voice" }).returning();
  const endpoints: Endpoint[] = [];
  for (const a of accounts) {
    const secret = randomBytes(32).toString("hex");
    const snapshot = await joinVoiceControl(a, { channelId: ch.id, joinNonce: randomUUID(), voiceDeviceId: randomUUID(), enrollmentSecret: secret, consent: true });
    endpoints.push({ ...a, secret, snapshot });
  }
  for (const e of endpoints) await refresh(e);
  return { communityId: c.communityId, channelId: ch.id, accounts, endpoints };
}
function keys(e: Endpoint, letter = "a") {
  const s = e.snapshot;
  return { user_id: s.voiceUserId, device_id: s.voiceDeviceId, algorithms: ["m.olm.v1.curve25519-aes-sha2", "m.megolm.v1.aes-sha2"], keys: { [`curve25519:${s.voiceDeviceId}`]: letter.repeat(43), [`ed25519:${s.voiceDeviceId}`]: "b".repeat(43) }, signatures: { [s.voiceUserId]: { [`ed25519:${s.voiceDeviceId}`]: "c".repeat(86) } } };
}
async function upload(e: Endpoint, prekeys: Record<string, unknown> = {}) {
  await crypto(e, { kind: "upload", body: { device_keys: keys(e), one_time_keys: prekeys } });
}
const keyContent = (letter: string) => ({ key: letter.repeat(43), signatures: {} });
const claim = (e: Endpoint, requestId = randomUUID()) => ({ kind: "claim", requestId, nativeRequestId: requestId, body: { one_time_keys: { [e.snapshot.voiceUserId]: { [e.snapshot.voiceDeviceId]: "signed_curve25519" } } } });
const send = (a: Endpoint, b: Endpoint, requestId = randomUUID()) => ({ kind: "send", requestId, nativeRequestId: requestId, nativeTxnId: requestId, eventType: "m.key.verification.request", body: { messages: { [b.snapshot.voiceUserId]: { [b.snapshot.voiceDeviceId]: { from_device: a.snapshot.voiceDeviceId, transaction_id: randomUUID(), methods: ["m.sas.v1"], timestamp: Date.now() } } } } });

// These tests exercise the internal draft directly. No endpoint or active product flow is created.
describe("voice-only scope, immutable public state and replay", () => {
  it.each((["lease", "session"] as const).flatMap(deadline => (["heartbeat", "crypto", "join-retry"] as const).map(operation => ({ deadline, operation }))))("rechecks $deadline after an observed row-lock wait before $operation", async ({ deadline, operation }) => {
    const { endpoints: [a] } = await fixture(1);
    const writer = await db.$client.connect();
    const start = Date.now();
    if (deadline === "lease") await db.update(voiceCallMember).set({ leaseExpiresAt: new Date(start + 10_000) }).where(eq(voiceCallMember.id, a.snapshot.memberId));
    else await db.update(session).set({ expiresAt: new Date(start + 10_000) }).where(eq(session.id, a.sessionId));
    let pending: Promise<unknown> | undefined;
    try {
      await writer.query("BEGIN");
      const { rows: [{ pid }] } = await writer.query<{ pid: number }>("select pg_backend_pid() as pid");
      await writer.query('select id from "user" where id = $1 for update', [a.userId]);
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(start);
      const action = operation === "heartbeat" ? heartbeatVoiceControl(memberAuth(a), binding(a))
        : operation === "crypto" ? crypto(a, { kind: "sync" })
        : joinVoiceControl({ userId: a.userId, sessionId: a.sessionId, anchorDeviceId: a.anchorDeviceId, anchorSecret: a.anchorSecret }, { channelId: a.snapshot.channelId, joinNonce: a.snapshot.joinNonce, voiceDeviceId: a.snapshot.voiceDeviceId, enrollmentSecret: a.secret, consent: true });
      pending = action.then(value => ({ value }), error => ({ error }));
      let observed = false;
      for (let i = 0; i < 100; i++) {
        const { rows: [{ blocked }] } = await db.$client.query<{ blocked: boolean }>("select exists(select 1 from pg_stat_activity where $1 = any(pg_blocking_pids(pid))) as blocked", [pid]);
        if (blocked) { observed = true; break; }
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      expect(observed).toBe(true);
      vi.setSystemTime(start + 20_000);
      await writer.query("COMMIT");
      expect(await pending).toMatchObject({ error: { code: operation === "join-retry" && deadline === "lease" ? "conflict" : "forbidden" } });
      const [member] = await db.select().from(voiceCallMember).where(eq(voiceCallMember.id, a.snapshot.memberId));
      if (deadline === "lease") expect(member.state).toBe("left");
      expect(member.leaseExpiresAt.getTime()).toBeLessThanOrEqual(deadline === "lease" ? start + 20_000 : new Date(a.snapshot.leaseExpiresAt).getTime());
      expect(await db.$count(voiceControlMailbox, eq(voiceControlMailbox.senderMemberId, a.snapshot.memberId))).toBe(0);
    } finally {
      await writer.query("ROLLBACK");
      await pending;
      vi.useRealTimers();
      writer.release();
    }
  });
  it("strictly separates single-target current enqueue from explicit nondelivery retirement", async () => {
    const { endpoints: [a, b] } = await fixture();
    await upload(a); await upload(b);
    const request = send(a, b);
    expect(await crypto(a, request)).toEqual({ nativeResponse: {}, disposition: { status: "processed-current", enqueued: 1 } });
    const before = await db.$count(voiceControlMailbox);
    const retire = { ...request, kind: "retire", requestId: randomUUID() };
    expect(await crypto(a, retire)).toEqual({ nativeResponse: {}, disposition: { status: "processed-retired", enqueued: 0 } });
    expect(await crypto(a, retire)).toEqual({ nativeResponse: {}, disposition: { status: "processed-retired", enqueued: 0 } });
    const unknown = `@voice_${a.snapshot.callId}_${randomUUID()}:opendiscord.local`;
    const unknownRequest = { ...retire, requestId: randomUUID(), body: { messages: { [unknown]: { [randomUUID()]: request.body.messages[b.snapshot.voiceUserId][b.snapshot.voiceDeviceId] } } } };
    expect(await crypto(a, unknownRequest)).toEqual({ nativeResponse: {}, disposition: { status: "processed-retired", enqueued: 0 } });
    expect(await db.$count(voiceControlMailbox)).toBe(before);
    await expect(crypto(a, { ...retire, requestId: request.requestId })).rejects.toMatchObject({ code: "conflict" });
    await expect(crypto(a, { ...retire, nativeRequestId: randomUUID() })).rejects.toMatchObject({ code: "conflict" });
    await expect(crypto(a, { ...retire, nativeTxnId: randomUUID() })).rejects.toMatchObject({ code: "conflict" });
    for (const kind of ["send", "retire", "signatures"]) {
      const body = kind === "signatures" ? {} : { messages: {} };
      await expect(crypto(a, kind === "signatures" ? { kind, body } : { ...request, kind, requestId: randomUUID(), body })).rejects.toMatchObject({ code: "invalid" });
    }
    for (const kind of ["send", "retire"]) {
      await expect(crypto(a, { ...request, kind, requestId: randomUUID(), body: { messages: { ...request.body.messages, [unknown]: { [randomUUID()]: {} } } } })).rejects.toMatchObject({ code: "invalid" });
    }
    await expect(crypto(a, { kind: "signatures", body: { [a.snapshot.voiceUserId]: {}, [b.snapshot.voiceUserId]: {} } })).rejects.toMatchObject({ code: "invalid" });
  });
  it("returns current same-call absence and truthful signature refusal without historical keys", async () => {
    const { endpoints: [a, b] } = await fixture();
    await upload(a); await upload(b, { "signed_curve25519:one": keyContent("d") });
    const unknown = `@voice_${a.snapshot.callId}_${randomUUID()}:opendiscord.local`, device = randomUUID();
    expect(await crypto(a, { kind: "query", body: { device_keys: { [unknown]: [] } } })).toEqual({ device_keys: { [unknown]: {} }, master_keys: {}, self_signing_keys: {}, user_signing_keys: {}, failures: {} });
    const request = { kind: "claim", requestId: randomUUID(), nativeRequestId: randomUUID(), body: { one_time_keys: { [unknown]: { [device]: "signed_curve25519" } } } };
    expect(await crypto(a, request)).toEqual({ one_time_keys: {}, failures: {} });
    expect(await crypto(a, request)).toEqual({ one_time_keys: {}, failures: {} });
    expect(await crypto(a, { kind: "signatures", body: { [unknown]: { [device]: keys(b) } } })).toEqual({ failures: { [unknown]: { [device]: { errcode: "M_FORBIDDEN", error: "Current voice signature target is unavailable." } } } });
    expect(await db.$count(voicePrekey, and(eq(voicePrekey.memberId, b.snapshot.memberId), eq(voicePrekey.used, true)))).toBe(0);
    expect(await db.$count(voiceSignature, eq(voiceSignature.signerMemberId, a.snapshot.memberId))).toBe(0);
  });
  it.each(["session", "anchor", "lease", "generation"] as const)("checks current %s authority before retirement receipt replay", async (loss) => {
    const { endpoints: [a, b] } = await fixture();
    const request = { ...send(a, b), kind: "retire" };
    await crypto(a, request);
    if (loss === "session") await db.update(session).set({ expiresAt: new Date(Date.now() - 1) }).where(eq(session.id, a.sessionId));
    else if (loss === "anchor") await db.update(dmDevice).set({ revokedAt: new Date() }).where(eq(dmDevice.id, a.anchorDeviceId));
    else if (loss === "lease") await db.update(voiceCallMember).set({ leaseExpiresAt: new Date(Date.now() - 1) }).where(eq(voiceCallMember.id, a.snapshot.memberId));
    else await leaveVoiceControl(memberAuth(b), binding(b));
    await expect(crypto(a, request)).rejects.toMatchObject({ code: loss === "generation" ? "conflict" : "forbidden" });
    expect(await db.$count(voiceControlMailbox, eq(voiceControlMailbox.callId, a.snapshot.callId))).toBe(0);
  });
  it("retires healthy current and unknown targets without recipient/key reads or mailbox inserts", async () => {
    const { endpoints: [a, b] } = await fixture();
    const transaction = db.transaction.bind(db);
    let forbiddenAccesses = 0;
    const targetsRecipient = (value: unknown): boolean => value === voiceCallMember.voiceUserId || (value instanceof SQL && value.queryChunks.some(targetsRecipient));
    // Instrument the real transaction; retain its real PostgreSQL locks, reads and receipt writes.
    const spy = vi.spyOn(db, "transaction").mockImplementation((callback, config) => transaction(tx => callback(new Proxy(tx, {
      get(target, key, receiver) {
        const method: unknown = Reflect.get(target, key, receiver);
        if ((key !== "select" && key !== "insert") || typeof method !== "function") return method;
        return (...args: unknown[]) => {
          if (key === "insert" && args[0] === voiceControlMailbox) { forbiddenAccesses++; throw new Error("Retirement mailbox insert"); }
          const builder: object = Reflect.apply(method, target, args);
          if (key !== "select") return builder;
          return new Proxy(builder, {
            get(query, property, queryReceiver) {
              const from: unknown = Reflect.get(query, property, queryReceiver);
              if (property !== "from" || typeof from !== "function") return from;
              return (table: unknown) => {
                if (table === voiceIdentity || table === voicePrekey || table === voiceSignature) { forbiddenAccesses++; throw new Error("Retirement key read"); }
                const scoped: object = Reflect.apply(from, query, [table]);
                if (table !== voiceCallMember) return scoped;
                return new Proxy(scoped, {
                  get(scope, field, scopeReceiver) {
                    const where: unknown = Reflect.get(scope, field, scopeReceiver);
                    if (field !== "where" || typeof where !== "function") return where;
                    return (...conditions: unknown[]) => {
                      if (conditions.some(targetsRecipient)) { forbiddenAccesses++; throw new Error("Retirement recipient lookup"); }
                      return Reflect.apply(where, scope, conditions);
                    };
                  },
                });
              };
            },
          });
        };
      },
    })), config));
    try {
      expect(await crypto(a, { ...send(a, b), kind: "retire" })).toMatchObject({ disposition: { status: "processed-retired", enqueued: 0 } });
      const unknown = `@voice_${a.snapshot.callId}_${randomUUID()}:opendiscord.local`;
      const request = send(a, b);
      expect(await crypto(a, { ...request, kind: "retire", body: { messages: { [unknown]: request.body.messages[b.snapshot.voiceUserId] } } })).toMatchObject({ disposition: { status: "processed-retired", enqueued: 0 } });
      expect(forbiddenAccesses).toBe(0);
    } finally { spy.mockRestore(); }
  });
  it("requires a real owned live session, active anchor possession, Connect and consent", async () => {
    const f = await fixture(1), a = f.endpoints[0], input = { channelId: f.channelId, joinNonce: randomUUID(), voiceDeviceId: randomUUID(), enrollmentSecret: a.secret, consent: true };
    await expect(joinVoiceControl({ ...f.accounts[0], anchorSecret: randomBytes(32).toString("hex") }, input)).rejects.toMatchObject({ code: "forbidden" });
    await expect(joinVoiceControl({ ...f.accounts[0], sessionId: "missing-session" }, input)).rejects.toMatchObject({ code: "forbidden" });
    await expect(joinVoiceControl(f.accounts[0], { ...input, consent: false })).rejects.toMatchObject({ code: "invalid" });
    const other = await account("Foreign anchor");
    await expect(joinVoiceControl({ ...f.accounts[0], anchorDeviceId: other.anchorDeviceId, anchorSecret: other.anchorSecret }, input)).rejects.toMatchObject({ code: "forbidden" });
    await expect(joinVoiceControl(other, input)).rejects.toMatchObject({ code: "not_found" });
    await expect(heartbeatVoiceControl({ ...memberAuth(a), secret: randomBytes(32).toString("hex") }, binding(a))).rejects.toMatchObject({ code: "forbidden" });
    await expect(heartbeatVoiceControl({ ...memberAuth(a), userId: other.userId, sessionId: other.sessionId }, binding(a))).rejects.toMatchObject({ code: "forbidden" });
  });
  it("binds device/cross-signing uploads to the exact voice namespace and forbids replacement", async () => {
    const { endpoints: [a, b] } = await fixture();
    await expect(crypto(a, { kind: "upload", body: { device_keys: keys(b) } })).rejects.toThrow("do not match");
    await expect(crypto(a, { kind: "upload", body: { device_keys: { ...keys(a), user_id: `@${a.userId}:opendiscord.local` } } })).rejects.toThrow("do not match");
    await upload(a);
    await expect(crypto(a, { kind: "upload", body: { device_keys: keys(a, "z") } })).rejects.toThrow("immutable");
    const cross = (usage: string, letter: string) => ({ user_id: a.snapshot.voiceUserId, usage: [usage], keys: { [`ed25519:${letter.repeat(43)}`]: letter.repeat(43) } });
    const body = { master_key: cross("master", "k"), self_signing_key: cross("self_signing", "l"), user_signing_key: cross("user_signing", "m") };
    await crypto(a, { kind: "signing", body });
    await expect(crypto(a, { kind: "signing", body: { ...body, master_key: cross("master", "n") } })).rejects.toThrow("immutable");
    expect(await db.$count(voiceIdentity, eq(voiceIdentity.memberId, a.snapshot.memberId))).toBe(1);
  });
  it("denies every DM/foreign-call native target, unknown devices, wildcard and unsupported event", async () => {
    const { endpoints: [a, b] } = await fixture(), { endpoints: [foreign] } = await fixture(1);
    await upload(a);
    for (const target of [foreign.snapshot.voiceUserId, `@${b.userId}:opendiscord.local`]) {
      const device = b.snapshot.voiceDeviceId;
      const requests = [
        { kind: "query", body: { device_keys: { [target]: [] } } },
        { kind: "claim", requestId: randomUUID(), nativeRequestId: randomUUID(), body: { one_time_keys: { [target]: { [device]: "signed_curve25519" } } } },
        { kind: "signatures", body: { [target]: { [device]: keys(b) } } },
        { ...send(a, b), body: { messages: { [target]: { [device]: { transaction_id: randomUUID() } } } } },
        { ...send(a, b), kind: "retire", body: { messages: { [target]: { [device]: { transaction_id: randomUUID() } } } } },
      ];
      for (const request of requests) await expect(crypto(a, request)).rejects.toMatchObject({ code: "not_found" });
    }
    await expect(crypto(a, { kind: "query", body: { device_keys: { [b.snapshot.voiceUserId]: [randomUUID()] } } })).rejects.toMatchObject({ code: "not_found" });
    await expect(crypto(a, { ...send(a, b), body: { messages: { [b.snapshot.voiceUserId]: { "*": {} } } } })).rejects.toMatchObject({ code: "invalid" });
    await expect(crypto(a, { ...send(a, b), eventType: "m.secret.request" })).rejects.toThrow("Unsupported");
    await expect(crypto(a, { ...send(a, b), eventType: "m.room_key_request" })).rejects.toThrow("Unsupported");
  });
  it("atomically claims once, returns exact retry receipts, rejects digest changes and preserves used tombstones", async () => {
    const { endpoints: [a, b] } = await fixture();
    await upload(a); await upload(b, { "signed_curve25519:one": keyContent("d"), "signed_curve25519:two": keyContent("e") });
    const request = claim(b);
    const results = await Promise.all(Array.from({ length: 5 }, () => crypto(a, request)));
    expect(results.every((r) => isDeepStrictEqual(r, results[0]))).toBe(true);
    expect(await db.$count(voicePrekey, and(eq(voicePrekey.memberId, b.snapshot.memberId), eq(voicePrekey.used, true)))).toBe(1);
    await expect(crypto(a, { ...request, body: { one_time_keys: { [a.snapshot.voiceUserId]: { [a.snapshot.voiceDeviceId]: "signed_curve25519" } } } })).rejects.toMatchObject({ code: "conflict" });
    await upload(b, { "signed_curve25519:one": keyContent("d"), "signed_curve25519:two": keyContent("e") });
    const next = await crypto(a, claim(b));
    expect(JSON.stringify(next)).not.toBe(JSON.stringify(results[0]));
    await db.update(voiceControlReceipt).set({ expiresAt: new Date(Date.now() - 1) }).where(and(eq(voiceControlReceipt.senderMemberId, a.snapshot.memberId), eq(voiceControlReceipt.requestId, request.requestId)));
    await expect(crypto(a, request)).rejects.toMatchObject({ code: "conflict" });
    expect(await db.$count(voicePrekey, and(eq(voicePrekey.memberId, b.snapshot.memberId), eq(voicePrekey.used, true)))).toBe(2);
  });
  it("separates fallback from one-time IDs and never reactivates a retired fallback", async () => {
    const { endpoints: [a, b] } = await fixture(); await upload(a); await upload(b);
    const fallback = (letter: string) => ({ ...keyContent(letter), fallback: true });
    await crypto(b, { kind: "upload", body: { one_time_keys: { "signed_curve25519:same": keyContent("a") }, fallback_keys: { "signed_curve25519:same": fallback("b") } } });
    expect(JSON.stringify(await crypto(a, claim(b)))).toContain('"key":"' + "a".repeat(43));
    expect(JSON.stringify(await crypto(a, claim(b)))).toContain('"key":"' + "b".repeat(43));
    await crypto(b, { kind: "upload", body: { fallback_keys: { "signed_curve25519:new": fallback("c") } } });
    await crypto(b, { kind: "upload", body: { fallback_keys: { "signed_curve25519:same": fallback("b") } } });
    expect(JSON.stringify(await crypto(a, claim(b)))).toContain('"key":"' + "c".repeat(43));
  });
  it("bounds available/lifetime prekeys and work before mutation", async () => {
    const { endpoints: [a] } = await fixture(1); await upload(a);
    const hundred = Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`signed_curve25519:k${i}`, keyContent("k")]));
    await crypto(a, { kind: "upload", body: { one_time_keys: hundred } });
    await expect(crypto(a, { kind: "upload", body: { one_time_keys: { "signed_curve25519:overflow": keyContent("l") } } })).rejects.toThrow("available");
    expect(await db.$count(voicePrekey, eq(voicePrekey.memberId, a.snapshot.memberId))).toBe(100);
    // Fill used lifetime tombstones directly, then prove one extra upload is atomically rejected.
    await db.insert(voicePrekey).values(Array.from({ length: 900 }, (_, i) => ({ memberId: a.snapshot.memberId, keyId: `signed_curve25519:used${i}`, content: keyContent("u"), used: true })));
    await expect(crypto(a, { kind: "upload", body: { one_time_keys: { "signed_curve25519:oneMore": keyContent("m") } } })).rejects.toThrow("lifetime");
    await expect(crypto(a, { kind: "upload", body: { one_time_keys: Object.fromEntries(Array.from({ length: 101 }, (_, i) => [`signed_curve25519:over${i}`, keyContent("n")])) } })).rejects.toThrow("Too many");
  });
  it("queries fresh identities and signatures for repeated identical bodies and explicit request IDs", async () => {
    const { endpoints: [a, b] } = await fixture();
    await upload(a);
    for (const requestId of [undefined, randomUUID()]) {
      const request = { kind: "query", body: { device_keys: { [b.snapshot.voiceUserId]: [] } }, ...(requestId ? { requestId } : {}) };
      const before = await crypto(a, request);
      if (!requestId) expect(JSON.stringify(before)).not.toContain(b.snapshot.voiceDeviceId);
      await upload(b);
      const updated = await crypto(a, request);
      expect(JSON.stringify(updated)).toContain(b.snapshot.voiceDeviceId);
      const signature = (requestId ? "p" : "n").repeat(86);
      await db.insert(voiceSignature).values({ signerMemberId: a.snapshot.memberId, targetMemberId: b.snapshot.memberId, keyId: b.snapshot.voiceDeviceId, signatures: { [`ed25519:${a.snapshot.voiceDeviceId}`]: signature } }).onConflictDoUpdate({ target: [voiceSignature.signerMemberId, voiceSignature.targetMemberId, voiceSignature.keyId], set: { signatures: { [`ed25519:${a.snapshot.voiceDeviceId}`]: signature } } });
      expect(JSON.stringify(await crypto(a, request))).toContain(signature);
    }
    expect(await db.$count(voiceControlReceipt, eq(voiceControlReceipt.senderMemberId, a.snapshot.memberId))).toBe(1);
  });
  it("filters embedded/stored signatures to the querying and target voice identities", async () => {
    const { endpoints: [a, b, c] } = await fixture(3); await upload(a); await upload(b); await upload(c);
    const bKeys = keys(b);
    await db.update(voiceIdentity).set({ deviceKeys: { ...bKeys, signatures: { ...bKeys.signatures, [c.snapshot.voiceUserId]: { "ed25519:hidden": "x".repeat(86) } } } }).where(eq(voiceIdentity.memberId, b.snapshot.memberId));
    await db.insert(voiceSignature).values([
      { signerMemberId: c.snapshot.memberId, targetMemberId: b.snapshot.memberId, keyId: b.snapshot.voiceDeviceId, signatures: { "ed25519:hidden": "y".repeat(86) } },
      { signerMemberId: a.snapshot.memberId, targetMemberId: b.snapshot.memberId, keyId: b.snapshot.voiceDeviceId, signatures: { [`ed25519:${a.snapshot.voiceDeviceId}`]: "z".repeat(86) } },
    ]);
    const query = await crypto(a, { kind: "query", body: { device_keys: { [b.snapshot.voiceUserId]: [] } } });
    expect(JSON.stringify(query)).not.toContain(c.snapshot.voiceUserId);
    expect(JSON.stringify(query)).not.toContain("hidden");
    expect(JSON.stringify(query)).toContain(a.snapshot.voiceUserId);
    const foreignSignature = { ...bKeys, signatures: { [a.snapshot.voiceUserId]: { "ed25519:unowned": "w".repeat(86) } } };
    await expect(crypto(a, { kind: "signatures", body: { [b.snapshot.voiceUserId]: { [b.snapshot.voiceDeviceId]: foreignSignature } } })).rejects.toThrow("foreign");
  });
});

describe("leases, generation and mailbox transaction order", () => {
  it("enforces eight waiting+active devices across concurrent admissions", async () => {
    const f = await fixture(1);
    const anchors = await Promise.all(Array.from({ length: 9 }, (_, i) => account(`Capacity ${i}`)));
    for (const a of anchors) await db.insert(member).values({ communityId: f.communityId, userId: a.userId });
    const results = await Promise.allSettled(anchors.map((a) => joinVoiceControl(a, { channelId: f.channelId, joinNonce: randomUUID(), voiceDeviceId: randomUUID(), enrollmentSecret: randomBytes(32).toString("hex"), consent: true })));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(7);
    expect(await db.$count(voiceCallMember, and(eq(voiceCallMember.callId, f.endpoints[0].snapshot.callId), neLeft()))).toBe(8);
  });
  it("never renews expired membership; expiry commits generation/cleanup before denial and releases capacity", async () => {
    const { endpoints: [a, b] } = await fixture(); await upload(a); await upload(b);
    await crypto(a, send(a, b));
    const generation = a.snapshot.generation;
    await db.update(voiceCallMember).set({ leaseExpiresAt: new Date(Date.now() - 1) }).where(eq(voiceCallMember.id, b.snapshot.memberId));
    await expect(refresh(b)).rejects.toThrow("ended");
    const [call] = await db.select().from(voiceCall).where(eq(voiceCall.id, a.snapshot.callId));
    expect(call.generation).toBe(generation + 1);
    expect(await db.$count(voiceControlMailbox, eq(voiceControlMailbox.callId, call.id))).toBe(0);
    expect(await db.$count(voiceIdentity, eq(voiceIdentity.memberId, b.snapshot.memberId))).toBe(0);
    await expect(crypto(a, { kind: "sync" })).rejects.toMatchObject({ code: "conflict" });
    await refresh(a);
    expect(a.snapshot.members.map((m) => m.memberId)).toEqual([a.snapshot.memberId]);
    await expect(joinVoiceControl({ userId: b.userId, sessionId: b.sessionId, anchorDeviceId: b.anchorDeviceId, anchorSecret: b.anchorSecret }, { channelId: a.snapshot.channelId, joinNonce: b.snapshot.joinNonce, voiceDeviceId: b.snapshot.voiceDeviceId, enrollmentSecret: b.secret, consent: true })).rejects.toThrow("ended");
  });
  it("checks expiry/revocation of real sessions and anchors before/after join", async () => {
    const f = await fixture(2), [a, b] = f.endpoints;
    await db.update(session).set({ expiresAt: new Date(Date.now() - 1) }).where(eq(session.id, b.sessionId));
    await expect(refresh(b)).rejects.toThrow("session");
    await refresh(a);
    expect(a.snapshot.members).toHaveLength(1);
    await db.delete(session).where(eq(session.id, a.sessionId));
    await expect(crypto(a, { kind: "sync" })).rejects.toThrow("session");
    const g = await fixture(2), [x, y] = g.endpoints;
    await db.update(dmDevice).set({ revokedAt: new Date() }).where(eq(dmDevice.id, y.anchorDeviceId));
    await expect(crypto(y, { kind: "sync" })).rejects.toThrow("ended");
    await refresh(x);
    expect(x.snapshot.members).toHaveLength(1);
    await expect(joinVoiceControl(g.accounts[1], { channelId: g.channelId, joinNonce: randomUUID(), voiceDeviceId: randomUUID(), enrollmentSecret: y.secret, consent: true })).rejects.toThrow("anchor");
  });
  it("denies Connect removal and both-direction blocks on every control request", async () => {
    const f = await fixture(), [a, b] = f.endpoints;
    await db.insert(userBlock).values({ blockerId: a.userId, blockedId: b.userId });
    await expect(crypto(a, { kind: "sync" })).rejects.toThrow("unavailable");
    await expect(refresh(b)).rejects.toThrow("unavailable");
    await db.delete(userBlock).where(eq(userBlock.blockerId, a.userId));
    await db.insert(userBlock).values({ blockerId: b.userId, blockedId: a.userId });
    await expect(crypto(a, { kind: "sync" })).rejects.toThrow("unavailable");
    await db.delete(userBlock).where(eq(userBlock.blockerId, b.userId));
    await db.update(role).set({ permissions: sql`${role.permissions} & ${~Permission.Connect}` }).where(and(eq(role.communityId, f.communityId), eq(role.isDefault, true)));
    await expect(refresh(b)).rejects.toThrow("ended");
    await expect(joinVoiceControl(f.accounts[1], { channelId: f.channelId, joinNonce: randomUUID(), voiceDeviceId: randomUUID(), enrollmentSecret: b.secret, consent: true })).rejects.toMatchObject({ code: "forbidden" });
  });
  it("persists send receipts and permits only delivered cumulative ACKs under commit order", async () => {
    const { endpoints: [a, b] } = await fixture(); await upload(a); await upload(b);
    const request = send(a, b);
    await Promise.all([crypto(a, request), crypto(a, request)]);
    await expect(crypto(b, { kind: "ack", cursor: "999999999999999" })).rejects.toThrow("already delivered");
    const sync = z.object({ cursor: z.string(), events: z.array(z.unknown()) }).parse(await crypto(b, { kind: "sync" }));
    expect(sync.events).toHaveLength(1);
    await crypto(a, send(a, b));
    await crypto(b, { kind: "ack", cursor: sync.cursor });
    const next = z.object({ cursor: z.string(), events: z.array(z.unknown()) }).parse(await crypto(b, { kind: "sync" }));
    expect(next.events).toHaveLength(1); expect(Number(next.cursor)).toBeGreaterThan(Number(sync.cursor));
    // The same advisory lock delays send sequence allocation and sync until the earlier TX commits.
    let release!: () => void, acquired!: () => void;
    const ready = new Promise<void>((resolve) => { acquired = resolve; });
    const hold = new Promise<void>((resolve) => { release = resolve; });
    const tx = db.transaction(async (t) => { await t.execute(sql`select pg_advisory_xact_lock(810030)`); acquired(); await hold; });
    await ready;
    let completed = false;
    const pending = crypto(a, send(a, b)).then(() => { completed = true; });
    try {
      await new Promise((resolve) => setTimeout(resolve, 40));
      expect(completed).toBe(false);
    } finally { release(); }
    await tx; await pending;
    await crypto(b, { kind: "ack", cursor: next.cursor });
    expect(z.object({ events: z.array(z.unknown()) }).parse(await crypto(b, { kind: "sync" })).events).toHaveLength(1);
  });
  it("bounds sync batches and mailbox, drops expired queue entries and rejects changed replay", async () => {
    const { endpoints: [a, b] } = await fixture(); await upload(a); await upload(b);
    const request = send(a, b);
    await crypto(a, request);
    await expect(crypto(a, { ...request, eventType: "m.key.verification.cancel" })).rejects.toMatchObject({ code: "conflict" });
    await db.insert(voiceControlMailbox).values(Array.from({ length: 255 }, () => ({ callId: a.snapshot.callId, senderMemberId: a.snapshot.memberId, recipientMemberId: b.snapshot.memberId, generation: a.snapshot.generation, event: { type: "m.key.verification.done", sender: a.snapshot.voiceUserId, content: { transaction_id: randomUUID() } }, expiresAt: new Date(Date.now() + 60_000) })));
    await expect(crypto(a, send(a, b))).rejects.toThrow("mailbox is full");
    expect(z.object({ events: z.array(z.unknown()) }).parse(await crypto(b, { kind: "sync" })).events).toHaveLength(64);
    await db.update(voiceControlMailbox).set({ expiresAt: new Date(Date.now() - 1) }).where(eq(voiceControlMailbox.callId, a.snapshot.callId));
    expect(z.object({ events: z.array(z.unknown()) }).parse(await crypto(b, { kind: "sync" })).events).toHaveLength(0);
  });
  it("leaves idempotently and invalidates call/member/session/anchor selectors with inert effects", async () => {
    for (const selector of ["callId", "memberId", "sessionId", "anchorDeviceId"] as const) {
      const { endpoints: [a, b] } = await fixture(); await upload(a); await upload(b);
      await crypto(a, send(a, b));
      const value = selector === "callId" ? b.snapshot.callId : selector === "memberId" ? b.snapshot.memberId : b[selector];
      const effects = await db.transaction((tx) => invalidateVoiceMembership(tx, { [selector]: value }, "test-invalidation"));
      expect(effects.length).toBe(selector === "callId" ? 2 : 1);
      expect(effects.every((e) => e.participantIdentity.startsWith("v1:"))).toBe(true);
      expect(await db.$count(voicePrekey, eq(voicePrekey.memberId, b.snapshot.memberId))).toBe(0);
      expect(await db.$count(voiceControlReceipt, eq(voiceControlReceipt.senderMemberId, b.snapshot.memberId))).toBe(0);
      expect(await db.$count(voiceControlMailbox, eq(voiceControlMailbox.callId, b.snapshot.callId))).toBe(0);
      expect(await db.transaction((tx) => invalidateVoiceMembership(tx, { [selector]: value }, "retry"))).toEqual([]);
    }
    const { endpoints: [a] } = await fixture(1);
    const effects = await leaveVoiceControl(memberAuth(a), binding(a));
    expect(effects.removals).toHaveLength(1);
    expect(await leaveVoiceControl(memberAuth(a), binding(a))).toEqual({ removals: [] });
    expect((await db.select().from(voiceCall).where(eq(voiceCall.id, a.snapshot.callId)))[0].status).toBe("closed");
  });
});
function neLeft() { return sql`${voiceCallMember.state} <> 'left'`; }

type NativeRequest = Awaited<ReturnType<C.OlmMachine["outgoingRequests"]>>[number];
const syncResult = z.object({ cursor: z.string(), events: z.array(z.record(z.string(), z.unknown())), oneTimeKeys: z.record(z.string(), z.number()), unusedFallbackKeys: z.array(z.string()) });
const nativeLogger = { debug() {}, info() {}, warn() {}, error() {} };
class ProductProtocolPaused extends Error {
  constructor(readonly request: NativeRequest) { super("Intentional public protocol pause"); }
}
const nativeTransportId = (endpoint: Endpoint, request: NativeRequest, operation: "send" | "retire" = "send") => createHash("sha256").update(JSON.stringify([endpoint.snapshot.generation, operation, request.type, request.id, request.body])).digest("hex");
class NativeVoice {
  pauseEvent?: string;
  pauseType?: C.RequestType;
  private constructor(readonly endpoint: Endpoint, readonly machine: C.OlmMachine, readonly sizes: number[]) {}
  static async open(endpoint: Endpoint) {
    const s = endpoint.snapshot;
    const machine = await C.OlmMachine.initialize(new C.UserId(s.voiceUserId), new C.DeviceId(s.voiceDeviceId), undefined, undefined, nativeLogger);
    machine.roomKeyRequestsEnabled = false; machine.roomKeyForwardingEnabled = false;
    const owner = new NativeVoice(endpoint, machine, []);
    try {
      await owner.flush();
      const bootstrap = await machine.bootstrapCrossSigning(false);
      if (bootstrap.uploadKeysRequest) await owner.out(bootstrap.uploadKeysRequest);
      owner.sizes.push(Buffer.byteLength(bootstrap.uploadSigningKeysRequest.body));
      await crypto(endpoint, { kind: "signing", body: JSON.parse(bootstrap.uploadSigningKeysRequest.body) });
      await owner.out(bootstrap.uploadSignaturesRequest);
      return owner;
    } catch (error) { machine.close(); throw error; }
  }
  async out(request: NativeRequest, operation: "send" | "retire" = "send") {
    if (request.type === this.pauseType || (request instanceof C.ToDeviceRequest && request.event_type === this.pauseEvent)) {
      this.pauseEvent = undefined;
      this.pauseType = undefined;
      throw new ProductProtocolPaused(request);
    }
    const body: unknown = JSON.parse(request.body);
    const requestId = nativeTransportId(this.endpoint, request, operation);
    let response: Record<string, unknown>;
    if (operation === "retire" && !(request instanceof C.ToDeviceRequest)) throw new Error("Only ToDevice can retire.");
    if (request instanceof C.KeysUploadRequest) { this.sizes.push(Buffer.byteLength(request.body)); response = await crypto(this.endpoint, { kind: "upload", body, requestId, nativeRequestId: request.id }); }
    else if (request instanceof C.KeysQueryRequest) response = await crypto(this.endpoint, { kind: "query", body, requestId, nativeRequestId: request.id });
    else if (request instanceof C.KeysClaimRequest) response = await crypto(this.endpoint, { kind: "claim", body, requestId, nativeRequestId: request.id });
    else if (request instanceof C.SignatureUploadRequest) response = await crypto(this.endpoint, { kind: "signatures", body, requestId, ...(request.id ? { nativeRequestId: request.id } : {}) });
    else if (request instanceof C.ToDeviceRequest) response = await crypto(this.endpoint, { kind: operation, body, requestId, nativeRequestId: request.id, nativeTxnId: request.txn_id, eventType: request.event_type });
    else throw new Error("Unowned native request kind in voice server fixture.");
    if (request.id) await this.machine.markRequestAsSent(request.id, request.type, JSON.stringify(request instanceof C.ToDeviceRequest ? response.nativeResponse : response));
    return response;
  }
  async flush() {
    for (let i = 0; i < 4; i++) {
      const requests = await this.machine.outgoingRequests();
      if (!requests.length) return;
      for (const request of requests) await this.out(request);
    }
    throw new Error("Native voice server fixture drain bound exceeded.");
  }
  async query(peers: NativeVoice[]) { await this.out(this.machine.queryKeysForUsers(peers.map((p) => new C.UserId(p.endpoint.snapshot.voiceUserId)))); }
  async sync() {
    const result = syncResult.parse(await crypto(this.endpoint, { kind: "sync" }));
    const changes = await this.machine.receiveSyncChanges(JSON.stringify(result.events), new C.DeviceLists([], []), new Map(Object.entries(result.oneTimeKeys)), new Set(result.unusedFallbackKeys));
    if (result.cursor !== "0") await crypto(this.endpoint, { kind: "ack", cursor: result.cursor });
    await this.flush();
    return changes;
  }
  verification(peer: NativeVoice) {
    const known = this.machine.getVerificationRequests(new C.UserId(peer.endpoint.snapshot.voiceUserId)).filter(flow => !flow.isCancelled());
    const active = known.filter(flow => !flow.isDone());
    const requests = active.length ? active : known;
    if (requests.length !== 1) throw new Error("Expected one scoped native voice verification flow.");
    return requests[0];
  }
  sas(peer: NativeVoice) {
    const sas = this.verification(peer).getVerification();
    if (!(sas instanceof C.Sas)) throw new Error("Native voice SAS was not established.");
    return sas;
  }
}
async function verifyNativePair(a: NativeVoice, b: NativeVoice) {
  await a.query([a, b]); await b.query([a, b]);
  const peer = await a.machine.getDevice(new C.UserId(b.endpoint.snapshot.voiceUserId), new C.DeviceId(b.endpoint.snapshot.voiceDeviceId));
  if (!peer) throw new Error("Missing real service peer device.");
  await a.out(peer.requestVerification([C.VerificationMethod.SasV1])[1]); await b.sync();
  const first = a.verification(b), second = b.verification(a);
  const ready = second.acceptWithMethods([C.VerificationMethod.SasV1]);
  if (!ready) throw new Error("Missing public SAS ready.");
  await b.out(ready); await a.sync();
  const started = await a.verification(b).startSas();
  if (!started) throw new Error("Missing public SAS start.");
  await a.out(started[1]); await b.sync();
  const accept = b.sas(a).accept();
  if (accept) await b.out(accept);
  await a.sync(); await b.sync(); await a.sync();
  const left = a.sas(b).decimals(), right = b.sas(a).decimals();
  expect(!!left && !!right && Array.from(left).every((value, i) => value === right[i])).toBe(true);
  for (const request of await a.sas(b).confirm()) await a.out(request);
  for (const request of await b.sas(a).confirm()) await b.out(request);
  await a.sync(); await b.sync(); await a.sync(); await b.sync();
  expect(first.isDone() && second.isDone()).toBe(true);
  await a.query([a, b]); await b.query([a, b]);
}
const nativeIdentityDigest = (owner: NativeVoice) => createHash("sha256").update(JSON.stringify([owner.machine.identityKeys.curve25519.toBase64(), owner.machine.identityKeys.ed25519.toBase64()])).digest("hex");
async function nativeEncryptedRequest(sender: NativeVoice, recipient: NativeVoice, message: string) {
  const claim = await sender.machine.getMissingSessions([new C.UserId(recipient.endpoint.snapshot.voiceUserId)]);
  if (claim) await sender.out(claim);
  const device = await sender.machine.getDevice(new C.UserId(recipient.endpoint.snapshot.voiceUserId), new C.DeviceId(recipient.endpoint.snapshot.voiceDeviceId));
  if (!device?.isVerified()) throw new Error("Verified real service peer required.");
  const encrypted = await device.encryptToDeviceEvent("app.opendiscord.voice.control", { message }, C.CollectStrategy.onlyTrustedDevices());
  const id = randomUUID();
  // Public constructor fixture around genuine encryptToDeviceEvent output; not a queued-output claim.
  return new C.ToDeviceRequest(id, "m.room.encrypted", id, JSON.stringify({ messages: { [recipient.endpoint.snapshot.voiceUserId]: { [recipient.endpoint.snapshot.voiceDeviceId]: JSON.parse(encrypted) } } }));
}
async function expectNativeDelivery(sender: NativeVoice, recipient: NativeVoice, message: string) {
  await sender.out(await nativeEncryptedRequest(sender, recipient, message));
  const events = await recipient.sync();
  expect(events.some(item => item instanceof C.DecryptedToDeviceEvent && item.encryptionInfo.isSenderVerified() && JSON.parse(item.rawEvent).content?.message === message)).toBe(true);
}
async function dmStateDigest(endpoints: Endpoint[]) {
  const users = endpoints.map((e) => e.userId), devices = endpoints.map((e) => e.anchorDeviceId);
  const rows = await Promise.all([
    db.select({ id: dmDevice.id, userId: dmDevice.userId, keys: dmDevice.keys, revokedAt: dmDevice.revokedAt }).from(dmDevice).where(inArray(dmDevice.id, devices)),
    db.select().from(dmIdentity).where(inArray(dmIdentity.userId, users)), db.select().from(dmKey).where(inArray(dmKey.deviceId, devices)),
    db.select().from(dmSignature).where(inArray(dmSignature.signerId, users)), db.select().from(dmMailbox).where(inArray(dmMailbox.deviceId, devices)), db.select().from(dmMessage).where(inArray(dmMessage.senderId, users)),
  ]);
  // Assertion diffs expose only a digest, never native key bodies or stored encryption state.
  return createHash("sha256").update(JSON.stringify(rows)).digest("hex");
}

describe("pinned native18.9.0 public request compatibility", () => {
  it("processes genuine mixed query/claim absence and exact retry against current real membership", async () => {
    await C.initAsync();
    const { endpoints } = await fixture(3);
    const before = await dmStateDigest(endpoints), owners: NativeVoice[] = [];
    try {
      for (const endpoint of endpoints) owners.push(await NativeVoice.open(endpoint));
      const [a, b, c] = owners;
      await a.query([a, b, c]);
      const claim = await a.machine.getMissingSessions([new C.UserId(b.endpoint.snapshot.voiceUserId), new C.UserId(c.endpoint.snapshot.voiceUserId)]);
      if (!claim) throw new Error("Expected genuine native mixed claim.");
      expect(Object.keys(JSON.parse(claim.body).one_time_keys)).toHaveLength(2);
      const original = claim.body;
      await leaveVoiceControl(memberAuth(b.endpoint), binding(b.endpoint));
      await refresh(a.endpoint); await refresh(c.endpoint);
      const used = await db.$count(voicePrekey, and(eq(voicePrekey.memberId, c.endpoint.snapshot.memberId), eq(voicePrekey.used, true)));
      const response = await a.out(claim);
      expect(Object.hasOwn(z.record(z.string(), z.unknown()).parse(response.one_time_keys), b.endpoint.snapshot.voiceUserId)).toBe(false);
      expect(Object.hasOwn(z.record(z.string(), z.unknown()).parse(response.one_time_keys), c.endpoint.snapshot.voiceUserId)).toBe(true);
      expect(await crypto(a.endpoint, { kind: "claim", requestId: nativeTransportId(a.endpoint, claim), nativeRequestId: claim.id, body: JSON.parse(claim.body) })).toEqual(response);
      expect(await db.$count(voicePrekey, and(eq(voicePrekey.memberId, c.endpoint.snapshot.memberId), eq(voicePrekey.used, true)))).toBe(used + 1);
      expect(claim.body === original).toBe(true);
      const query = a.machine.queryKeysForUsers([new C.UserId(b.endpoint.snapshot.voiceUserId), new C.UserId(c.endpoint.snapshot.voiceUserId)]);
      const current = await a.out(query);
      expect(z.record(z.string(), z.unknown()).parse(current.device_keys)[b.endpoint.snapshot.voiceUserId]).toEqual({});
      expect(Object.hasOwn(z.record(z.string(), z.unknown()).parse(current.device_keys), c.endpoint.snapshot.voiceUserId)).toBe(true);
      expect(await a.machine.getDevice(new C.UserId(b.endpoint.snapshot.voiceUserId), new C.DeviceId(b.endpoint.snapshot.voiceDeviceId))).toBeUndefined();
      expect(await a.machine.getMissingSessions([new C.UserId(b.endpoint.snapshot.voiceUserId)])).toBeNull();
      await a.flush();
      await verifyNativePair(a, c);
      await expectNativeDelivery(a, c, "current peer after real absence");
      expect(await dmStateDigest(endpoints)).toBe(before);
    } finally { for (const owner of owners) owner.machine.close(); }
  }, 60_000);
  it("feeds genuine single-user signature refusal to the SDK without remote storage or disturbing a verified current peer", async () => {
    await C.initAsync();
    const { endpoints } = await fixture(3), owners: NativeVoice[] = [];
    const before = await dmStateDigest(endpoints);
    try {
      for (const endpoint of endpoints) owners.push(await NativeVoice.open(endpoint));
      const [a, b, c] = owners;
      await verifyNativePair(a, c);
      a.pauseType = C.RequestType.SignatureUpload;
      let pending: C.SignatureUploadRequest;
      try { await verifyNativePair(a, b); throw new Error("Expected real SAS signature upload."); }
      catch (error) {
        if (!(error instanceof ProductProtocolPaused)) throw error;
        if (!(error.request instanceof C.SignatureUploadRequest)) throw new Error("Expected public SignatureUpload.");
        pending = error.request;
      }
      const targets = z.record(z.string(), z.record(z.string(), z.unknown())).parse(JSON.parse(pending.body));
      expect(Object.keys(targets)).toEqual([b.endpoint.snapshot.voiceUserId]);
      const localBefore = (await a.machine.getDevice(new C.UserId(b.endpoint.snapshot.voiceUserId), new C.DeviceId(b.endpoint.snapshot.voiceDeviceId)))?.isVerified();
      await leaveVoiceControl(memberAuth(b.endpoint), binding(b.endpoint));
      await refresh(a.endpoint); await refresh(c.endpoint);
      const response = await a.out(pending);
      const failures = z.record(z.string(), z.record(z.string(), z.object({ errcode: z.literal("M_FORBIDDEN") }).passthrough())).parse(response.failures);
      expect(Object.keys(failures[b.endpoint.snapshot.voiceUserId])).toEqual(Object.keys(targets[b.endpoint.snapshot.voiceUserId]));
      expect(await db.$count(voiceSignature, and(eq(voiceSignature.signerMemberId, a.endpoint.snapshot.memberId), eq(voiceSignature.targetMemberId, b.endpoint.snapshot.memberId)))).toBe(0);
      expect((await a.machine.getDevice(new C.UserId(b.endpoint.snapshot.voiceUserId), new C.DeviceId(b.endpoint.snapshot.voiceDeviceId)))?.isVerified()).toBe(localBefore);
      expect((await a.machine.outgoingRequests()).some(request => request.type === C.RequestType.SignatureUpload && request.id === pending.id)).toBe(false);
      await a.flush();
      expect((await a.machine.getDevice(new C.UserId(c.endpoint.snapshot.voiceUserId), new C.DeviceId(c.endpoint.snapshot.voiceDeviceId)))?.isVerified()).toBe(true);
      await expectNativeDelivery(a, c, "current verified peer after signature refusal");
      expect(await dmStateDigest(endpoints)).toBe(before);
    } finally { for (const owner of owners) owner.machine.close(); }
  }, 60_000);
  it("retires a genuine first Olm type0 constructor fixture without delivery then decrypts real traffic in both directions", async () => {
    await C.initAsync();
    const { endpoints } = await fixture(), owners: NativeVoice[] = [];
    const before = await dmStateDigest(endpoints);
    try {
      for (const endpoint of endpoints) owners.push(await NativeVoice.open(endpoint));
      const [a, b] = owners;
      await verifyNativePair(a, b);
      const identity = nativeIdentityDigest(a), request = await nativeEncryptedRequest(a, b, "retired initial Olm");
      const messages = z.record(z.string(), z.record(z.string(), z.object({ ciphertext: z.record(z.string(), z.object({ type: z.number() }).passthrough()) }).passthrough())).parse(JSON.parse(request.body).messages);
      expect(Object.values(messages[b.endpoint.snapshot.voiceUserId][b.endpoint.snapshot.voiceDeviceId].ciphertext)[0].type).toBe(0);
      expect(await a.out(request, "retire")).toEqual({ nativeResponse: {}, disposition: { status: "processed-retired", enqueued: 0 } });
      expect(await b.sync()).toHaveLength(0);
      await expectNativeDelivery(a, b, "real control after initial nondelivery");
      await expectNativeDelivery(b, a, "real reply after initial nondelivery");
      expect(nativeIdentityDigest(a)).toBe(identity);
      expect(await dmStateDigest(endpoints)).toBe(before);
    } finally { for (const owner of owners) owner.machine.close(); }
  }, 60_000);
  for (const phase of ["request", "ready", "start", "key", "mac", "done"]) {
    for (const departed of [false, true]) {
      it(`retires genuine pending ${phase} to a ${departed ? "departed" : "current"} peer through the real service and preserves fresh verified traffic`, async () => {
        await C.initAsync();
        const { endpoints } = await fixture(4);
        const before = await dmStateDigest(endpoints);
        const owners: NativeVoice[] = [];
        try {
          for (const endpoint of endpoints) owners.push(await NativeVoice.open(endpoint));
          const [a, b, c, d] = owners;
          await verifyNativePair(a, d);
          const identity = nativeIdentityDigest(a), retained = nativeIdentityDigest(d);
          a.pauseEvent = `m.key.verification.${phase}`;
          let pending: C.ToDeviceRequest;
          try {
            await (phase === "ready" ? verifyNativePair(b, a) : verifyNativePair(a, b));
            throw new Error("Expected genuine pending native phase.");
          } catch (error) {
            if (!(error instanceof ProductProtocolPaused)) throw error;
            if (!(error.request instanceof C.ToDeviceRequest)) throw new Error("Expected public ToDevice phase.");
            pending = error.request;
          }
          expect(pending.event_type).toBe(`m.key.verification.${phase}`);
          const original = { id: pending.id, txn: pending.txn_id, body: pending.body, type: pending.type };
          const removed = departed ? b : c;
          await leaveVoiceControl(memberAuth(removed.endpoint), binding(removed.endpoint));
          for (const owner of owners.filter(owner => owner !== removed)) await refresh(owner.endpoint);
          if (departed) await expect(crypto(a.endpoint, { kind: "send", requestId: randomUUID(), nativeRequestId: pending.id, nativeTxnId: pending.txn_id, eventType: pending.event_type, body: JSON.parse(pending.body) })).rejects.toMatchObject({ code: "not_found" });
          const cancellations: NativeRequest[] = [pending];
          for (const flow of a.machine.getVerificationRequests(new C.UserId(b.endpoint.snapshot.voiceUserId))) {
            if (!flow.isDone() && !flow.isCancelled()) {
              const cancel = flow.cancel();
              if (cancel instanceof C.ToDeviceRequest) cancellations.push(cancel);
            }
          }
          cancellations.push(...(await a.machine.outgoingRequests()).filter(request => request instanceof C.ToDeviceRequest));
          const unique = new Map(cancellations.map(request => [request.id, request]));
          for (const request of unique.values()) expect(await a.out(request, "retire")).toEqual({ nativeResponse: {}, disposition: { status: "processed-retired", enqueued: 0 } });
          expect(pending.id === original.id && pending.txn_id === original.txn && pending.body === original.body && pending.type === original.type).toBe(true);
          expect(await db.$count(voiceControlMailbox, eq(voiceControlMailbox.callId, a.endpoint.snapshot.callId))).toBe(0);
          expect((await a.machine.outgoingRequests()).filter(request => request instanceof C.ToDeviceRequest)).toHaveLength(0);
          expect(nativeIdentityDigest(a)).toBe(identity);
          expect(nativeIdentityDigest(d)).toBe(retained);
          expect((await a.machine.getDevice(new C.UserId(d.endpoint.snapshot.voiceUserId), new C.DeviceId(d.endpoint.snapshot.voiceDeviceId)))?.isVerified()).toBe(true);
          await expectNativeDelivery(a, d, "retained verified peer control");
          await expectNativeDelivery(d, a, "retained verified peer reply");
          const fresh = departed ? c : b;
          if (!departed) {
            for (const flow of b.machine.getVerificationRequests(new C.UserId(a.endpoint.snapshot.voiceUserId))) {
              if (!flow.isDone() && !flow.isCancelled()) {
                const cancel = flow.cancel();
                if (cancel instanceof C.ToDeviceRequest) await b.out(cancel, "retire");
              }
            }
            for (const request of (await b.machine.outgoingRequests()).filter(request => request instanceof C.ToDeviceRequest)) await b.out(request, "retire");
          }
          await verifyNativePair(a, fresh);
          await expectNativeDelivery(a, fresh, "fresh forward control");
          await expectNativeDelivery(fresh, a, "fresh reverse control");
          expect(nativeIdentityDigest(a)).toBe(identity);
          expect(await dmStateDigest(endpoints)).toBe(before);
        } finally { for (const owner of owners) owner.machine.close(); }
      }, 60_000);
    }
  }
  it("bootstraps independent memory-only identities, completes native SAS and verified Olm through only voice tables", async () => {
    await C.initAsync();
    const { endpoints } = await fixture();
    const before = await dmStateDigest(endpoints);
    const a = await NativeVoice.open(endpoints[0]);
    let b: NativeVoice | undefined;
    try {
      b = await NativeVoice.open(endpoints[1]);
      await a.query([a, b]); await b.query([a, b]);
      const peer = await a.machine.getDevice(new C.UserId(b.endpoint.snapshot.voiceUserId), new C.DeviceId(b.endpoint.snapshot.voiceDeviceId));
      expect(peer?.isVerified()).toBe(false);
      if (!peer) throw new Error("Missing scoped native peer.");
      await a.out(peer.requestVerification([C.VerificationMethod.SasV1])[1]); await b.sync();
      const senderVerification = a.verification(b), receiverVerification = b.verification(a);
      const accept = receiverVerification.acceptWithMethods([C.VerificationMethod.SasV1]);
      if (!accept) throw new Error("Native verification acceptance unavailable.");
      await b.out(accept); await a.sync();
      const started = await a.verification(b).startSas();
      if (!started) throw new Error("Native SAS start unavailable.");
      await a.out(started[1]); await b.sync();
      const sasAccept = b.sas(a).accept();
      if (sasAccept) await b.out(sasAccept);
      await a.sync(); await b.sync(); await a.sync();
      const first = a.sas(b).decimals(), second = b.sas(a).decimals();
      expect(!!first && !!second && Array.from(first).every((v, i) => v === second[i])).toBe(true);
      for (const request of await a.sas(b).confirm()) await a.out(request);
      for (const request of await b.sas(a).confirm()) await b.out(request);
      await a.sync(); await b.sync(); await a.sync(); await b.sync();
      expect(senderVerification.isDone() && receiverVerification.isDone()).toBe(true);
      await a.query([a, b]); await b.query([a, b]);
      const verifiedPeer = await a.machine.getDevice(new C.UserId(b.endpoint.snapshot.voiceUserId), new C.DeviceId(b.endpoint.snapshot.voiceDeviceId));
      expect(verifiedPeer?.isVerified()).toBe(true);
      const claim = await a.machine.getMissingSessions([new C.UserId(b.endpoint.snapshot.voiceUserId)]);
      if (claim) await a.out(claim);
      if (!verifiedPeer) throw new Error("Missing verified native peer.");
      const encrypted = await verifiedPeer.encryptToDeviceEvent("app.opendiscord.voice.control", { purpose: "voice-server-fixture", message: "verified opaque control" }, C.CollectStrategy.onlyTrustedDevices());
      const id = randomUUID();
      await a.out(new C.ToDeviceRequest(id, "m.room.encrypted", id, JSON.stringify({ messages: { [b.endpoint.snapshot.voiceUserId]: { [b.endpoint.snapshot.voiceDeviceId]: JSON.parse(encrypted) } } })));
      const decrypted = await b.sync();
      expect(decrypted.some((item) => item instanceof C.DecryptedToDeviceEvent && item.encryptionInfo.isSenderVerified() && JSON.parse(item.rawEvent).content?.purpose === "voice-server-fixture")).toBe(true);
      expect(await dmStateDigest(endpoints)).toBe(before);
      const sizes = [...a.sizes, ...b.sizes];
      expect(Math.max(...sizes)).toBeLessThan(VOICE_LIMITS.bootstrapBytes);
      console.info("voice-server-native-metadata", JSON.stringify({ devices: 2, verifiedPairs: 1, bootstrapBodyBytes: sizes, dmUnchanged: true, publicRequestApi: "18.9.0" }));
    } finally { a.machine.close(); b?.machine.close(); }
    expect(await dmStateDigest(endpoints)).toBe(before);
  }, 30_000);
});
