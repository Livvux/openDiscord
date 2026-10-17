import { z } from "zod";

// Independent namespace, using the instance's existing registered Matrix domain, never a DM account.
export const VOICE_DOMAIN = "opendiscord.local";
export const VOICE_LIMITS = { members: 8, leaseMs: 30_000, mailbox: 256, syncBatch: 64, bootstrapBytes: 65_536, requestBytes: 8192, prekeys: 100, lifetimePrekeys: 1000, receipts: 4096, mailboxTtlMs: 60_000, receiptTtlMs: 600_000 } as const;
const id = z.uuid();
const secret = z.string().regex(/^[a-f0-9]{64}$/);
const realId = z.string().min(1).max(128);
export const voiceJoinAuthSchema = z.object({ userId: realId, sessionId: realId, anchorDeviceId: id, anchorSecret: secret }).strict();
export const voiceMemberAuthSchema = z.object({ userId: realId, sessionId: realId, memberId: id, secret }).strict();
export const voiceJoinSchema = z.object({ channelId: id, joinNonce: id, voiceDeviceId: id, enrollmentSecret: secret, consent: z.literal(true) }).strict();
export const voiceBindingSchema = z.object({ callId: id, memberId: id, joinNonce: id, expectedGeneration: z.number().int().positive() }).strict();
const object = z.record(z.string().min(1).max(256), z.unknown());
const requestId = z.string().min(1).max(128);
// Supported pinned18.9.0 public request bodies, not SDK object instances or private native fields.
export const voiceCryptoSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("upload"), body: object, requestId: requestId.optional(), nativeRequestId: requestId.optional() }).strict(),
  z.object({ kind: z.literal("signing"), body: object }).strict(),
  z.object({ kind: z.literal("query"), body: object, requestId: requestId.optional(), nativeRequestId: requestId.optional() }).strict(),
  z.object({ kind: z.literal("claim"), body: object, requestId, nativeRequestId: requestId }).strict(),
  z.object({ kind: z.literal("signatures"), body: object, requestId: requestId.optional(), nativeRequestId: requestId.optional() }).strict(),
  z.object({ kind: z.literal("send"), body: object, eventType: z.string().max(100), requestId, nativeRequestId: requestId, nativeTxnId: requestId }).strict(),
  z.object({ kind: z.literal("retire"), body: object, eventType: z.string().max(100), requestId, nativeRequestId: requestId, nativeTxnId: requestId }).strict(),
  z.object({ kind: z.literal("sync") }).strict(),
  z.object({ kind: z.literal("ack"), cursor: z.string().regex(/^\d{1,15}$/) }).strict(),
]);
export const voiceCryptoInputSchema = z.object({ ...voiceBindingSchema.shape, request: voiceCryptoSchema }).strict();
export type VoiceJoinAuth = z.infer<typeof voiceJoinAuthSchema>;
export type VoiceMemberAuth = z.infer<typeof voiceMemberAuthSchema>;
export type VoiceBinding = z.infer<typeof voiceBindingSchema>;
export type VoiceDeviceOutcome = { nativeResponse: Record<string, never>; disposition: { status: "processed-current"; enqueued: 1 } | { status: "processed-retired"; enqueued: 0 } };
export type VoiceCryptoRequest = z.infer<typeof voiceCryptoSchema>;
export type VoiceMember = { memberId: string; userId: string; anchorDeviceId: string; voiceUserId: string; voiceDeviceId: string; joinNonce: string; participantIdentity: string; displayName: string; state: "waiting" | "active" };
export type VoiceRemoval = { callId: string; memberId: string; participantIdentity: string; reason: string };
export type VoiceSnapshot = { callId: string; channelId: string; generation: number; memberId: string; joinNonce: string; voiceUserId: string; voiceDeviceId: string; participantIdentity: string; leaseExpiresAt: string; serverTime: string; members: VoiceMember[]; removals: VoiceRemoval[] };

const base64 = z.string().regex(/^[A-Za-z0-9+/_=-]+$/);
export const voiceSignedObjectSchema = z.object({ user_id: z.string().max(256), keys: z.record(z.string().max(160), base64.max(128)), signatures: z.record(z.string().max(256), z.record(z.string().max(160), base64.max(128))).optional() }).strict();
export const voiceDeviceKeysSchema = voiceSignedObjectSchema.extend({ device_id: id, algorithms: z.array(z.enum(["m.olm.v1.curve25519-aes-sha2", "m.megolm.v1.aes-sha2"])).min(1).max(2) });
export const voicePrekeySchema = z.object({ key: base64.max(64), signatures: z.record(z.string().max(256), z.record(z.string().max(160), base64.max(128))), fallback: z.boolean().optional() }).strict();
const transaction = z.string().min(1).max(128);
const methods = z.array(z.string().min(1).max(100)).min(1).max(8);
const sasSchemas: Record<string, z.ZodType> = {
  request: z.object({ transaction_id: transaction, from_device: id, methods, timestamp: z.number().int().nonnegative() }).strict(),
  ready: z.object({ transaction_id: transaction, from_device: id, methods }).strict(),
  start: z.object({ transaction_id: transaction, from_device: id, method: z.literal("m.sas.v1"), key_agreement_protocols: methods, hashes: methods, message_authentication_codes: methods, short_authentication_string: methods }).strict(),
  accept: z.object({ transaction_id: transaction, method: z.literal("m.sas.v1").optional(), commitment: base64.max(128), key_agreement_protocol: z.string().max(100), hash: z.string().max(100), message_authentication_code: z.string().max(100), short_authentication_string: methods }).strict(),
  key: z.object({ transaction_id: transaction, key: base64.max(128) }).strict(),
  mac: z.object({ transaction_id: transaction, mac: z.record(z.string().max(160), base64.max(128)), keys: base64.max(128) }).strict(),
  done: z.object({ transaction_id: transaction }).strict(),
  cancel: z.object({ transaction_id: transaction, code: z.string().max(100), reason: z.string().max(256) }).strict(),
};
const encryptedEvent = z.object({ algorithm: z.literal("m.olm.v1.curve25519-aes-sha2"), sender_key: base64.max(64), "org.matrix.msgid": z.string().regex(/^[a-f0-9]{32}$/).optional(), ciphertext: z.record(base64.max(64), z.object({ type: z.union([z.literal(0), z.literal(1)]), body: base64.max(8192) }).strict()) }).strict();
export function voiceEventSchema(type: string): z.ZodType | undefined {
  if (type === "m.room.encrypted") return encryptedEvent;
  return type.startsWith("m.key.verification.") ? sasSchemas[type.slice("m.key.verification.".length)] : undefined;
}

/** Inert locked authorization snapshot; never proof of native SAS or media admission. */
export type VoiceMediaSource = "microphone" | "camera" | "screen_share" | "screen_share_audio";
export type VoiceMediaGrant = { snapshot: VoiceSnapshot; roomName: string; participantIdentity: string; sources: VoiceMediaSource[]; canPublishData: false; expiresAt: string };
