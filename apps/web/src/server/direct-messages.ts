import { createHash, timingSafeEqual } from "node:crypto";
import { and, asc, desc, eq, inArray, isNull, lt, lte, ne, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { z } from "zod";
import { db } from "@/db";
import { dmBackup, dmConversation, dmCryptoReceipt, dmDevice, dmIdentity, dmKey, dmMailbox, dmMessage, dmReport, dmSignature, instanceAuditLog, member, session, user, userBlock } from "@/db/schema";
import { base64Schema, deviceIdSchema, deviceSecretSchema, DM_DOMAIN, DM_MAX_BACKUP_BYTES, encryptedMessageSchema, matrixUser, type DeviceView, type DirectConversation, type DmDeviceAuth } from "@/lib/dm/contracts";
import { AppError, forbidden, invalid, notFound } from "./errors";
import { consume } from "./limits";
import { requireInstanceAdmin, type AdminActor } from "./instance-admin";
import { assertActiveUser } from "./instance-policy";
import { parse, uuid } from "./validation";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
const object = z.record(z.string(), z.unknown());
const record = (value: unknown): Record<string, unknown> => parse(object, value);
const conflict = (message: string) => new AppError("conflict", message);
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const same = (a: unknown, b: unknown): boolean => canonical(a) === canonical(b);
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  return JSON.stringify(value);
}
function fromMatrix(value: string): string {
  const suffix = `:${DM_DOMAIN}`;
  if (!value.startsWith("@") || !value.endsWith(suffix)) throw notFound("Account not found.");
  return parse(z.string().min(1).max(64), value.slice(1, -suffix.length));
}
const pair = (actor: string, target: string) => [actor, target].sort();
async function blocked(tx: Tx | typeof db, actor: string, target: string): Promise<boolean> {
  return !!(await tx.select({ id: userBlock.blockerId }).from(userBlock).where(or(and(eq(userBlock.blockerId, actor), eq(userBlock.blockedId, target)), and(eq(userBlock.blockerId, target), eq(userBlock.blockedId, actor)))).limit(1))[0];
}
async function reachable(tx: Tx | typeof db, actor: string, target: string): Promise<void> {
  if (actor === target) return;
  const [first, second] = pair(actor, target);
  const shared = alias(member, "dm_shared_member");
  const found = await tx.select({ id: member.userId }).from(member).innerJoin(shared, and(eq(shared.communityId, member.communityId), eq(shared.userId, actor))).where(eq(member.userId, target)).limit(1);
  if (!found.length && !(await tx.select({ id: dmConversation.id }).from(dmConversation).where(and(eq(dmConversation.firstId, first), eq(dmConversation.secondId, second), ne(dmConversation.status, "rejected"))).limit(1)).length) throw notFound("Account not found.");
  if (await blocked(tx, actor, target)) throw notFound("Account not found.");
}
async function cryptoReachable(tx: Tx, actor: string, target: string): Promise<void> {
  if (actor === target) return;
  const [first, second] = pair(actor, target);
  const [accepted] = await tx.select({ id: dmConversation.id }).from(dmConversation).where(and(eq(dmConversation.firstId, first), eq(dmConversation.secondId, second), eq(dmConversation.status, "accepted"))).limit(1);
  if (!accepted || await blocked(tx, actor, target)) throw notFound("Encrypted conversation not found.");
  await assertActiveUser(target, tx);
}
async function conversationFor(tx: Tx | typeof db, actor: string, id: string, sending = false) {
  const [row] = await tx.select().from(dmConversation).where(and(eq(dmConversation.id, parse(uuid, id)), or(eq(dmConversation.firstId, actor), eq(dmConversation.secondId, actor))));
  if (!row) throw notFound("Conversation not found.");
  const peer = row.firstId === actor ? row.secondId : row.firstId;
  if (sending) {
    if (row.status !== "accepted" || await blocked(tx, actor, peer)) throw forbidden("This conversation is not accepting messages.");
    await assertActiveUser(peer, tx);
  }
  return { ...row, peer };
}
async function activeSession(tx: Tx, actor: string, sessionId: string): Promise<void> {
  await assertActiveUser(actor, tx);
  const [current] = await tx.select({ expiresAt: session.expiresAt }).from(session).where(and(eq(session.id, sessionId), eq(session.userId, actor)));
  if (!current || current.expiresAt.getTime() <= Date.now()) throw forbidden("This account session is unavailable. Sign in again.");
}
async function deviceFor(tx: Tx, auth: DmDeviceAuth) {
  await activeSession(tx, auth.userId, auth.sessionId);
  const id = parse(deviceIdSchema, auth.deviceId), secret = parse(deviceSecretSchema, auth.secret);
  const [device] = await tx.select().from(dmDevice).where(and(eq(dmDevice.id, id), eq(dmDevice.userId, auth.userId), isNull(dmDevice.revokedAt))).for("share");
  if (!device || !timingSafeEqual(Buffer.from(device.secretHash, "hex"), Buffer.from(digest(secret), "hex"))) throw forbidden("This encryption device is unavailable. Restore or enroll a new device.");
  return device;
}

export async function createDirectConversation(actor: string, rawTarget: unknown): Promise<string> {
  const target = parse(z.string().min(1).max(64), rawTarget);
  if (actor === target) throw invalid("Choose another person.");
  await consume(`dm-request:${actor}`, 10, 3_600_000);
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${actor}, 31))`);
    await reachable(tx, actor, target);
    await assertActiveUser(target, tx);
    const [firstId, secondId] = pair(actor, target);
    const [existing] = await tx.select().from(dmConversation).where(and(eq(dmConversation.firstId, firstId), eq(dmConversation.secondId, secondId)));
    if (existing?.status === "rejected") throw forbidden("This person is not accepting this request.");
    if (existing) return existing.id;
    if (await tx.$count(dmConversation, or(eq(dmConversation.firstId, actor), eq(dmConversation.secondId, actor))) >= 500) throw invalid("You have reached the conversation limit.");
    const [created] = await tx.insert(dmConversation).values({ firstId, secondId, requestedBy: actor }).onConflictDoNothing().returning({ id: dmConversation.id });
    if (created) return created.id;
    const [raced] = await tx.select({ id: dmConversation.id }).from(dmConversation).where(and(eq(dmConversation.firstId, firstId), eq(dmConversation.secondId, secondId)));
    return raced.id;
  });
}
export async function respondToDirectRequest(actor: string, id: string, rawStatus: unknown): Promise<void> {
  const status = parse(z.enum(["accepted", "rejected"]), rawStatus);
  await db.transaction(async (tx) => {
    const row = await conversationFor(tx, actor, id);
    if (row.requestedBy === actor || row.status !== "pending") throw forbidden("Only the recipient can answer a pending request.");
    if (await blocked(tx, actor, row.peer)) throw forbidden();
    const changed = await tx.update(dmConversation).set({ status }).where(and(eq(dmConversation.id, id), eq(dmConversation.status, "pending"))).returning({ id: dmConversation.id });
    if (!changed.length) throw conflict("This request has already been answered.");
  });
}
export async function listDirectConversations(actor: string): Promise<DirectConversation[]> {
  const rows = await db.select().from(dmConversation).where(or(eq(dmConversation.firstId, actor), eq(dmConversation.secondId, actor))).orderBy(desc(dmConversation.id));
  if (!rows.length) return [];
  const peers = await db.select({ id: user.id, name: user.name }).from(user).where(inArray(user.id, rows.map((r) => r.firstId === actor ? r.secondId : r.firstId)));
  const blocks = await db.select().from(userBlock).where(or(eq(userBlock.blockerId, actor), eq(userBlock.blockedId, actor)));
  return rows.map((r) => { const peerId = r.firstId === actor ? r.secondId : r.firstId; return { id: r.id, peerId, peerName: peers.find((p) => p.id === peerId)?.name ?? "Deleted account", requestedBy: r.requestedBy, status: r.status, blocked: blocks.some((b) => b.blockedId === peerId || b.blockerId === peerId), ownBlocked: blocks.some((b) => b.blockerId === actor && b.blockedId === peerId) }; });
}
export async function listDirectMessages(actor: string, id: string, before?: string) {
  await conversationFor(db, actor, id);
  const rows = await db.select().from(dmMessage).where(and(eq(dmMessage.conversationId, id), before ? lt(dmMessage.id, parse(uuid, before)) : undefined)).orderBy(desc(dmMessage.id)).limit(50);
  return { messages: rows.reverse().map((r) => ({ ...r, createdAt: r.createdAt.toISOString() })), hasMore: rows.length === 50 };
}
export async function appendDirectMessage(auth: DmDeviceAuth, id: string, input: unknown) {
  const data = parse(z.object({ transactionId: uuid, content: encryptedMessageSchema }).strict(), input);
  await consume(`dm-send:${auth.userId}`, 5, 5000);
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(810025)`);
    const device = await deviceFor(tx, auth);
    await conversationFor(tx, auth.userId, id, true);
    if (data.content.device_id !== device.id || record(device.keys?.keys)[`curve25519:${device.id}`] !== data.content.sender_key) throw invalid("The encrypted sender does not match this device.");
    const [existing] = await tx.select().from(dmMessage).where(and(eq(dmMessage.deviceId, device.id), eq(dmMessage.transactionId, data.transactionId)));
    if (existing) {
      if (existing.conversationId !== id || !same(existing.content, data.content)) throw conflict("A message transaction cannot be reused.");
      return { id: existing.id };
    }
    const [created] = await tx.insert(dmMessage).values({ conversationId: id, senderId: auth.userId, deviceId: device.id, transactionId: data.transactionId, content: data.content }).returning({ id: dmMessage.id });
    return created;
  });
}
export async function registerDmDevice(actor: string, sessionId: string, input: unknown): Promise<void> {
  const data = parse(z.object({ id: deviceIdSchema, secret: deviceSecretSchema, name: z.string().trim().min(1).max(60) }).strict(), input);
  const [known] = await db.select({ id: dmDevice.id }).from(dmDevice).where(eq(dmDevice.id, data.id));
  if (!known) await consume(`dm-device:${actor}`, 12, 3_600_000);
  await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(810025)`);
    await activeSession(tx, actor, sessionId);
    const [existing] = await tx.select().from(dmDevice).where(eq(dmDevice.id, data.id));
    if (existing) { await deviceFor(tx, { userId: actor, sessionId, deviceId: data.id, secret: data.secret }); return; }
    if (await tx.$count(dmDevice, and(eq(dmDevice.userId, actor), isNull(dmDevice.revokedAt))) >= 10) throw invalid("Revoke an old device before adding another (maximum 10).");
    await tx.insert(dmDevice).values({ id: data.id, userId: actor, name: data.name, secretHash: digest(data.secret) });
  });
}
export async function listDmDevices(actor: string, target = actor): Promise<DeviceView[]> {
  await reachable(db, actor, target);
  return (await db.select().from(dmDevice).where(eq(dmDevice.userId, target)).orderBy(asc(dmDevice.createdAt))).map((d) => ({ id: d.id, userId: d.userId, name: d.name, revoked: !!d.revokedAt, createdAt: d.createdAt.toISOString() }));
}
export async function revokeDmDevice(actor: string, id: string): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(810025)`);
    const [device] = await tx.update(dmDevice).set({ revokedAt: new Date() }).where(and(eq(dmDevice.id, parse(uuid, id)), eq(dmDevice.userId, actor))).returning({ id: dmDevice.id });
    if (!device) throw notFound("Device not found.");
    await tx.delete(dmKey).where(eq(dmKey.deviceId, id));
    await tx.delete(dmMailbox).where(eq(dmMailbox.deviceId, id));
    await tx.delete(dmCryptoReceipt).where(eq(dmCryptoReceipt.deviceId, id));
  });
}

const keyBody = z.object({ key: base64Schema.max(128), signatures: z.record(z.string(), z.record(z.string(), base64Schema.max(128))), fallback: z.boolean().optional() }).strict();
const signedObject = z.object({ user_id: z.string().max(128), keys: z.record(z.string(), base64Schema.max(128)), signatures: z.record(z.string(), z.record(z.string(), base64Schema.max(128))).optional() }).passthrough();
const transaction = z.string().min(1).max(128);
const methods = z.array(z.string().max(100)).min(1).max(10);
const verificationSchemas: Record<string, z.ZodType<Record<string, unknown>>> = {
  request: z.object({ transaction_id: transaction, from_device: uuid, methods, timestamp: z.number().int().nonnegative() }).strict(),
  ready: z.object({ transaction_id: transaction, from_device: uuid, methods }).strict(),
  start: z.object({ transaction_id: transaction, from_device: uuid, method: z.literal("m.sas.v1"), key_agreement_protocols: methods, hashes: methods, message_authentication_codes: methods, short_authentication_string: methods }).strict(),
  accept: z.object({ transaction_id: transaction, method: z.literal("m.sas.v1").optional(), commitment: base64Schema.max(128), key_agreement_protocol: z.string().max(100), hash: z.string().max(100), message_authentication_code: z.string().max(100), short_authentication_string: methods }).strict(),
  key: z.object({ transaction_id: transaction, key: base64Schema.max(128) }).strict(),
  mac: z.object({ transaction_id: transaction, mac: z.record(z.string().max(128), base64Schema.max(128)), keys: base64Schema.max(128) }).strict(),
  done: z.object({ transaction_id: transaction }).strict(),
  cancel: z.object({ transaction_id: transaction, code: z.string().max(100), reason: z.string().max(256) }).strict(),
};
function parseDeviceEvent(type: string, input: unknown): Record<string, unknown> {
  if (type === "m.room.encrypted") return parse(z.object({ algorithm: z.literal("m.olm.v1.curve25519-aes-sha2"), sender_key: base64Schema.max(64), "org.matrix.msgid": z.string().regex(/^[a-f0-9]{32}$/).optional(), ciphertext: z.record(base64Schema.max(64), z.object({ type: z.union([z.literal(0), z.literal(1)]), body: base64Schema.max(450_000) }).strict()) }).strict(), input);
  const verification = verificationSchemas[type.replace("m.key.verification.", "")];
  if (type.startsWith("m.key.verification.") && verification) return parse(verification, input);
  const common = { action: z.enum(["request", "request_cancellation"]), requesting_device_id: uuid, request_id: transaction };
  if (type === "m.secret.request") return parse(z.object({ ...common, name: z.enum(["m.cross_signing.master", "m.cross_signing.self_signing", "m.cross_signing.user_signing", "m.megolm_backup.v1"]).optional() }).strict(), input);
  if (type === "m.room_key_request") return parse(z.object({ ...common, body: z.object({ algorithm: z.literal("m.megolm.v1.aes-sha2"), room_id: z.string().max(128), sender_key: base64Schema.max(64), session_id: base64Schema.max(128) }).strict().optional() }).strict(), input);
  throw invalid("Unsupported device event.");
}
const cryptoRequest = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("upload"), body: object }),
  z.object({ kind: z.literal("query"), body: object }),
  z.object({ kind: z.literal("signing"), body: object }),
  z.object({ kind: z.literal("signatures"), body: object }),
  z.object({ kind: z.literal("claim"), body: object, requestId: z.string().min(1).max(128) }),
  z.object({ kind: z.literal("send"), body: object, requestId: z.string().min(1).max(128), eventType: z.string().max(100) }),
  z.object({ kind: z.literal("sync") }),
  z.object({ kind: z.literal("ack"), cursor: z.string().regex(/^\d{1,15}$/) }),
]);

/** Exact Matrix wire shapes at the boundary; the application never processes private keys. */
export async function handleCryptoRequest(auth: DmDeviceAuth, input: unknown): Promise<Record<string, unknown>> {
  const data = parse(cryptoRequest, input);
  // Bound attacker-controlled fan-out before acquiring the shared transaction lock.
  if ("body" in data) {
    if (data.kind === "upload" && data.body.device_keys && Buffer.byteLength(JSON.stringify(data.body.device_keys)) > 8192) throw invalid("Device keys exceed the size limit.");
    if ((data.kind === "signing" || data.kind === "signatures") && Buffer.byteLength(JSON.stringify(data.body)) > 32_000) throw invalid("Signing request exceeds the size limit.");
    const nested = data.kind === "query" ? data.body.device_keys : data.kind === "claim" ? data.body.one_time_keys : data.kind === "send" ? data.body.messages : data.kind === "signatures" ? data.body : undefined;
    if (nested !== undefined) {
      const entries = Object.entries(record(nested));
      if (entries.length > 20) throw invalid("Too many target accounts.");
      let total = 0;
      for (const [, raw] of entries) {
        const inner = data.kind === "query" ? parse(z.array(uuid).max(10), raw).length : Object.keys(record(raw)).length;
        if (inner > 20 || (total += inner) > 40) throw invalid("Too many target keys or devices.");
      }
    }
  }
  await consume(`dm-crypto:${auth.userId}`, 240, 60_000);
  return db.transaction(async (tx) => {
    // Short DB-only critical section: atomic claims, receipt replay and mailbox commit/cursor ordering.
    await tx.execute(sql`select pg_advisory_xact_lock(810025)`);
    const own = await deviceFor(tx, auth), ownUser = matrixUser(auth.userId);
    if (data.kind === "sync") {
      const blocks = await tx.select().from(userBlock).where(or(eq(userBlock.blockerId, auth.userId), eq(userBlock.blockedId, auth.userId)));
      const blockedPeers = blocks.map((row) => row.blockerId === auth.userId ? row.blockedId : row.blockerId);
      if (blockedPeers.length) await tx.delete(dmMailbox).where(and(eq(dmMailbox.deviceId, own.id), inArray(dmMailbox.senderId, blockedPeers)));
      const events = await tx.select().from(dmMailbox).where(eq(dmMailbox.deviceId, own.id)).orderBy(asc(dmMailbox.id)).limit(100);
      const keys = await tx.select().from(dmKey).where(and(eq(dmKey.deviceId, own.id), or(eq(dmKey.fallback, true), eq(dmKey.used, false))));
      return { cursor: String(events.at(-1)?.id ?? 0), events: events.map((e) => e.event), oneTimeKeys: { signed_curve25519: keys.filter((k) => !k.fallback && !k.used).length }, unusedFallbackKeys: keys.some((k) => k.fallback && !k.used) ? ["signed_curve25519"] : [] };
    }
    if (data.kind === "ack") { await tx.delete(dmMailbox).where(and(eq(dmMailbox.deviceId, own.id), lte(dmMailbox.id, Number(data.cursor)))); return {}; }
    const body = data.body;
    if (data.kind === "upload") {
      const uploadId = `upload:${digest(canonical(body))}`;
      const [uploaded] = await tx.select({ id: dmCryptoReceipt.requestId }).from(dmCryptoReceipt).where(and(eq(dmCryptoReceipt.deviceId, own.id), eq(dmCryptoReceipt.requestId, uploadId)));
      if (uploaded) return { one_time_key_counts: { signed_curve25519: await tx.$count(dmKey, and(eq(dmKey.deviceId, own.id), eq(dmKey.fallback, false), eq(dmKey.used, false))) } };
      if (await tx.$count(dmKey, eq(dmKey.deviceId, own.id)) >= 100_000 || await tx.$count(dmCryptoReceipt, eq(dmCryptoReceipt.deviceId, own.id)) >= 100_000) throw invalid("Device prekey lifetime limit reached. Enroll a new device.");
      if (body.device_keys) {
        const keys = parse(signedObject.extend({ device_id: uuid, algorithms: z.array(z.string()).max(8) }), body.device_keys);
        if (keys.user_id !== ownUser || keys.device_id !== own.id || !keys.keys[`curve25519:${own.id}`] || !keys.keys[`ed25519:${own.id}`]) throw invalid("Device keys do not match this account and device.");
        if (own.keys && !same(record(own.keys).keys, keys.keys)) throw conflict("Device keys are immutable. Enroll a new device.");
        await tx.update(dmDevice).set({ keys }).where(eq(dmDevice.id, own.id));
      }
      for (const fallback of [false, true]) {
        const entries = Object.entries(body[fallback ? "fallback_keys" : "one_time_keys"] ? record(body[fallback ? "fallback_keys" : "one_time_keys"]) : {});
        if (entries.length > (fallback ? 1 : 100)) throw invalid("Too many prekeys.");
        for (const [keyId, raw] of entries) {
          if (!/^signed_curve25519:[A-Za-z0-9_-]{1,100}$/.test(keyId)) throw invalid("Unsupported prekey.");
          const content = parse(keyBody, raw);
          const [existing] = await tx.select().from(dmKey).where(and(eq(dmKey.deviceId, own.id), eq(dmKey.keyId, keyId), eq(dmKey.fallback, fallback)));
          if (existing && !same(existing.content, content)) throw conflict("Prekeys are immutable.");
          if (!existing) {
            if (fallback) await tx.delete(dmKey).where(and(eq(dmKey.deviceId, own.id), eq(dmKey.fallback, true)));
            await tx.insert(dmKey).values({ deviceId: own.id, keyId, content, fallback });
          }
        }
      }
      const total = await tx.$count(dmKey, and(eq(dmKey.deviceId, own.id), eq(dmKey.fallback, false), eq(dmKey.used, false)));
      if (total > 100) throw invalid("Too many prekeys.");
      await tx.insert(dmCryptoReceipt).values({ deviceId: own.id, requestId: uploadId, digest: uploadId, response: {} });
      return { one_time_key_counts: { signed_curve25519: total } };
    }
    if (data.kind === "signing") {
      const result: Record<string, unknown> = {};
      for (const keyName of ["master_key", "self_signing_key", "user_signing_key"]) {
        const key = parse(signedObject.extend({ usage: z.array(z.string()).length(1) }), body[keyName]);
        if (key.user_id !== ownUser || Object.keys(key.keys).length !== 1) throw invalid("Signing keys do not match this account.");
        result[keyName] = key;
      }
      const [existing] = await tx.select().from(dmIdentity).where(eq(dmIdentity.userId, auth.userId));
      if (existing && !same(record(existing.keys.master_key).keys, record(result.master_key).keys)) throw conflict("Restore your identity from a recovery file or a verified device.");
      await tx.insert(dmIdentity).values({ userId: auth.userId, keys: result }).onConflictDoNothing();
      return {};
    }
    if (data.kind === "signatures") {
      if (Object.keys(body).length > 20) throw invalid("Too many signatures.");
      for (const [matrixId, values] of Object.entries(body)) {
        const target = fromMatrix(matrixId); await cryptoReachable(tx, auth.userId, target);
        for (const [keyId, raw] of Object.entries(record(values))) {
          const [targetDevice] = uuid.safeParse(keyId).success ? await tx.select({ id: dmDevice.id }).from(dmDevice).where(and(eq(dmDevice.userId, target), eq(dmDevice.id, keyId), isNull(dmDevice.revokedAt))) : [];
          const [identity] = await tx.select().from(dmIdentity).where(eq(dmIdentity.userId, target));
          const masterId = identity ? Object.values(record(record(identity.keys.master_key).keys))[0] : undefined;
          if (!targetDevice && keyId !== masterId) throw invalid("Signature target key does not exist.");
          const item = parse(signedObject, raw);
          if (item.user_id !== matrixId) throw invalid("Signature target mismatch.");
          const signatures = item.signatures?.[ownUser];
          if (!signatures || keyId.length > 128) throw invalid("Missing signature.");
          await tx.insert(dmSignature).values({ signerId: auth.userId, targetId: target, keyId, signatures }).onConflictDoUpdate({ target: [dmSignature.signerId, dmSignature.targetId, dmSignature.keyId], set: { signatures } });
        }
      }
      return { failures: {} };
    }
    if (data.kind === "query") {
      const requested = Object.keys(record(body.device_keys));
      if (requested.length > 50) throw invalid("Too many accounts.");
      const device_keys: Record<string, unknown> = {}, master_keys: Record<string, unknown> = {}, self_signing_keys: Record<string, unknown> = {}, user_signing_keys: Record<string, unknown> = {};
      for (const matrixId of requested) {
        const target = fromMatrix(matrixId); await cryptoReachable(tx, auth.userId, target);
        const devices = await tx.select().from(dmDevice).where(and(eq(dmDevice.userId, target), isNull(dmDevice.revokedAt)));
        const signatures = await tx.select().from(dmSignature).where(and(eq(dmSignature.targetId, target), or(eq(dmSignature.signerId, target), eq(dmSignature.signerId, auth.userId))));
        const attach = (keyId: string, value: Record<string, unknown>) => {
          const merged = record(value.signatures ?? {});
          for (const signature of signatures.filter((s) => s.keyId === keyId)) {
            const signer = matrixUser(signature.signerId);
            merged[signer] = { ...record(merged[signer] ?? {}), ...signature.signatures };
          }
          return { ...value, signatures: Object.fromEntries(Object.entries(merged).filter(([signer]) => signer === matrixId || signer === ownUser)) };
        };
        device_keys[matrixId] = Object.fromEntries(devices.filter((d) => d.keys).map((d) => [d.id, attach(d.id, d.keys!)]));
        const [identity] = await tx.select().from(dmIdentity).where(eq(dmIdentity.userId, target));
        if (identity) {
          const key = record(identity.keys.master_key), keyId = Object.values(record(key.keys))[0];
          master_keys[matrixId] = attach(String(keyId), key);
          self_signing_keys[matrixId] = attach("", record(identity.keys.self_signing_key));
          if (target === auth.userId) user_signing_keys[matrixId] = attach("", record(identity.keys.user_signing_key));
        }
      }
      return { device_keys, master_keys, self_signing_keys, user_signing_keys, failures: {} };
    }
    const requestDigest = digest(canonical(data));
    const [receipt] = await tx.select().from(dmCryptoReceipt).where(and(eq(dmCryptoReceipt.deviceId, own.id), eq(dmCryptoReceipt.requestId, data.requestId)));
    if (receipt) { if (receipt.digest !== requestDigest) throw conflict("A device transaction cannot be reused."); return receipt.response; }
    let result: Record<string, unknown> = {};
    if (data.kind === "claim") {
      const requested = record(body.one_time_keys), one_time_keys: Record<string, unknown> = {};
      if (Object.keys(requested).length > 50) throw invalid("Too many accounts.");
      for (const [matrixId, rawDevices] of Object.entries(requested)) {
        const target = fromMatrix(matrixId); await cryptoReachable(tx, auth.userId, target);
        const response: Record<string, unknown> = {};
        for (const [id, algorithm] of Object.entries(record(rawDevices))) {
          if (algorithm !== "signed_curve25519") throw invalid("Unsupported prekey algorithm.");
          const [device] = await tx.select().from(dmDevice).where(and(eq(dmDevice.id, parse(uuid, id)), eq(dmDevice.userId, target), isNull(dmDevice.revokedAt)));
          if (!device) continue;
          const [key] = await tx.select().from(dmKey).where(and(eq(dmKey.deviceId, id), or(eq(dmKey.fallback, true), eq(dmKey.used, false)))).orderBy(asc(dmKey.fallback), asc(dmKey.keyId)).limit(1);
          if (key) {
            response[id] = { [key.keyId]: key.content };
            await tx.update(dmKey).set({ used: true }).where(and(eq(dmKey.deviceId, id), eq(dmKey.keyId, key.keyId), eq(dmKey.fallback, key.fallback)));
          }
        }
        one_time_keys[matrixId] = response;
      }
      result = { one_time_keys, failures: {} };
    } else {
      if (!["m.room.encrypted", "m.secret.request", "m.room_key_request"].includes(data.eventType) && !/^m\.key\.verification\.(request|ready|start|accept|key|mac|done|cancel)$/.test(data.eventType)) throw invalid("Only encrypted or verification device events are supported.");
      const recipients = record(body.messages);
      if (Object.keys(recipients).length > 20) throw invalid("Too many recipients.");
      let deliveries = 0;
      for (const [matrixId, rawDevices] of Object.entries(recipients)) {
        const target = fromMatrix(matrixId); await cryptoReachable(tx, auth.userId, target);
        const devices = await tx.select().from(dmDevice).where(and(eq(dmDevice.userId, target), isNull(dmDevice.revokedAt)));
        for (const [id, rawContent] of Object.entries(record(rawDevices))) {
          const content = parseDeviceEvent(data.eventType, rawContent);
          const largeOwnTransfer = Buffer.byteLength(JSON.stringify(content)) > 8192;
          if (largeOwnTransfer && (target !== auth.userId || data.eventType !== "m.room.encrypted")) throw invalid("Device event exceeds the size limit.");
          if (data.eventType === "m.room.encrypted") {
            if (content.algorithm !== "m.olm.v1.curve25519-aes-sha2" || content.sender_key !== record(own.keys?.keys)[`curve25519:${own.id}`]) throw invalid("Invalid encrypted device event.");
          } else if ((content.from_device !== undefined && content.from_device !== own.id) || (content.requesting_device_id !== undefined && content.requesting_device_id !== own.id)) throw invalid("Verification sender mismatch.");
          for (const device of devices.filter((d) => d.id === id || id === "*")) {
            if (++deliveries > 40) throw invalid("Too many device deliveries.");
            if (await tx.$count(dmMailbox, eq(dmMailbox.deviceId, device.id)) >= (largeOwnTransfer ? 16 : 256)) throw invalid("The recipient's device mailbox is full.");
            await tx.insert(dmMailbox).values({ deviceId: device.id, senderId: auth.userId, event: { sender: ownUser, type: data.eventType, content } });
          }
        }
      }
    }
    if (await tx.$count(dmCryptoReceipt, eq(dmCryptoReceipt.deviceId, own.id)) >= 100_000) throw invalid("Device transaction limit reached. Enroll a new device.");
    await tx.insert(dmCryptoReceipt).values({ deviceId: own.id, requestId: data.requestId, digest: requestDigest, response: result });
    return result;
  });
}
export async function saveDmBackup(auth: DmDeviceAuth, input: unknown): Promise<void> {
  const data = parse(z.object({ id: uuid, ciphertext: base64Schema.max(Math.ceil(DM_MAX_BACKUP_BYTES * 4 / 3)) }).strict(), input);
  await consume(`dm-backup:${auth.userId}`, 10, 3_600_000);
  await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(810025)`);
    await deviceFor(tx, auth);
    if (await tx.$count(dmBackup, eq(dmBackup.userId, auth.userId)) >= 10) throw invalid("Delete an old encrypted backup before creating another (maximum 10).");
    await tx.insert(dmBackup).values({ id: data.id, userId: auth.userId, ciphertext: data.ciphertext });
  });
}
export async function getDmBackup(actor: string, id: string) {
  const [backup] = await db.select().from(dmBackup).where(and(eq(dmBackup.id, parse(uuid, id)), eq(dmBackup.userId, actor)));
  if (!backup) throw notFound("Encrypted backup not found.");
  return { ciphertext: backup.ciphertext };
}
export async function listDmBackups(actor: string) {
  return db.select({ id: dmBackup.id, createdAt: dmBackup.createdAt }).from(dmBackup).where(eq(dmBackup.userId, actor)).orderBy(desc(dmBackup.createdAt));
}
export async function deleteDmBackup(actor: string, id: string): Promise<void> {
  await db.delete(dmBackup).where(and(eq(dmBackup.id, parse(uuid, id)), eq(dmBackup.userId, actor)));
}

export async function reportDirectMessage(actor: string, input: unknown): Promise<void> {
  const data = parse(z.object({ id: uuid, reason: z.string().trim().min(3).max(512), excerpt: z.string().max(4000).nullable() }).strict(), input);
  await consume(`dm-report:${actor}`, 10, 3_600_000);
  const [message] = await db.select().from(dmMessage).where(eq(dmMessage.id, data.id));
  if (!message || message.senderId === actor) throw notFound("Message not found.");
  await conversationFor(db, actor, message.conversationId);
  const rows = await db.insert(dmReport).values({ messageId: data.id, reporterId: actor, reason: data.reason, excerpt: data.excerpt }).onConflictDoNothing().returning({ id: dmReport.id });
  if (!rows.length) throw conflict("You have already reported this message.");
}
export async function listDirectReports(actor: AdminActor) {
  await requireInstanceAdmin(actor);
  return db.select({ id: dmReport.id, reason: dmReport.reason, excerpt: dmReport.excerpt, createdAt: dmReport.createdAt, senderId: dmMessage.senderId, senderName: user.name }).from(dmReport).innerJoin(dmMessage, eq(dmMessage.id, dmReport.messageId)).innerJoin(user, eq(user.id, dmMessage.senderId)).where(isNull(dmReport.resolvedAt)).orderBy(asc(dmReport.createdAt)).limit(100);
}
export async function resolveDirectReport(actor: AdminActor, rawId: unknown): Promise<void> {
  const id = parse(uuid, rawId);
  await db.transaction(async (tx) => {
    await requireInstanceAdmin(actor, tx);
    const rows = await tx.update(dmReport).set({ resolvedAt: new Date() }).where(and(eq(dmReport.id, id), isNull(dmReport.resolvedAt))).returning({ id: dmReport.id });
    if (!rows.length) throw notFound("Open private report not found.");
    await tx.insert(instanceAuditLog).values({ actorId: actor.userId, action: "dm.report.reviewed", targetId: id, reason: "Recipient disclosure reviewed." });
  });
}

/** Portable server-held data. Never includes a device bearer secret or any private crypto key. */
export async function exportDirectData(actor: string) {
  const conversations = await listDirectConversations(actor);
  const ids = conversations.map((c) => c.id);
  const [devices, identity, backups, messages, reports] = await Promise.all([
    listDmDevices(actor), db.select().from(dmIdentity).where(eq(dmIdentity.userId, actor)),
    db.select().from(dmBackup).where(eq(dmBackup.userId, actor)),
    ids.length ? db.select().from(dmMessage).where(inArray(dmMessage.conversationId, ids)).orderBy(asc(dmMessage.id)) : [],
    db.select({ messageId: dmReport.messageId, reason: dmReport.reason, excerpt: dmReport.excerpt, createdAt: dmReport.createdAt, resolvedAt: dmReport.resolvedAt }).from(dmReport).where(eq(dmReport.reporterId, actor)),
  ]);
  return { conversations, devices, publicIdentity: identity[0]?.keys ?? null, encryptedBackups: backups.map((b) => ({ id: b.id, ciphertext: b.ciphertext, createdAt: b.createdAt })), encryptedMessages: messages, reports };
}
