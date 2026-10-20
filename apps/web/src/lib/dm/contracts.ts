import { z } from "zod";

export const DM_DOMAIN = "opendiscord.local";
export const matrixUser = (userId: string) => `@${userId}:${DM_DOMAIN}`;
export const matrixRoom = (conversationId: string) => `!${conversationId}:${DM_DOMAIN}`;
export const DM_MAX_TEXT = 4000;
export const DM_MAX_CIPHERTEXT = 24_000;
export const DM_MAX_BACKUP_BYTES = 4_000_000;
export const deviceIdSchema = z.uuid();
export const deviceSecretSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const base64Schema = z.string().regex(/^[A-Za-z0-9+/=_-]+$/);
export const encryptedMessageSchema = z.object({
  algorithm: z.literal("m.megolm.v1.aes-sha2"),
  sender_key: base64Schema.max(64),
  device_id: deviceIdSchema,
  session_id: base64Schema.max(128),
  ciphertext: base64Schema.min(32).max(DM_MAX_CIPHERTEXT),
}).strict();
/** Same per-file cap as community file uploads. */
export const DM_MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
export const DM_MAX_ATTACHMENTS = 4;
/** The SDK's Matrix attachment information (key, IV, SHA-256 hash); a missing hash is never accepted. */
const mediaInfoSchema = z.string().max(4000).refine((value) => {
  try { return z.object({ v: z.string(), key: z.object({ k: base64Schema }).passthrough(), iv: base64Schema, hashes: z.object({ sha256: base64Schema }).passthrough() }).passthrough().safeParse(JSON.parse(value)).success; } catch { return false; }
}, "Attachment encryption information needs a SHA-256 hash.");
/** Lives only inside the Megolm payload: the server sees an opaque ID and the ciphertext size. */
export const dmAttachmentSchema = z.object({
  id: z.uuid(),
  info: mediaInfoSchema,
  name: z.string().min(1).max(255),
  mime: z.string().max(255),
  size: z.number().int().nonnegative().max(DM_MAX_ATTACHMENT_BYTES),
}).strict();
export type DmAttachment = z.infer<typeof dmAttachmentSchema>;
export const plainMessageSchema = z.object({
  msgtype: z.literal("m.text"),
  body: z.string().trim().max(DM_MAX_TEXT),
  conversation: z.uuid(),
  transaction: z.uuid(),
  attachments: z.array(dmAttachmentSchema).min(1).max(DM_MAX_ATTACHMENTS).optional(),
}).strict().refine((message) => message.body.length > 0 || !!message.attachments, "A message needs text or an attachment.");
export type PlainDirectMessage = z.infer<typeof plainMessageSchema>;
export type DmDeviceAuth = { userId: string; sessionId: string; deviceId: string; secret: string };
// Matches the eight-device E2EE call bound (VOICE_LIMITS.members) so every member can join a call.
export const DM_GROUP_MAX_MEMBERS = 8;
export const DM_GROUP_NAME_MAX = 100;
export type DmMemberView = { id: string; name: string; avatar: string | null; /** A former group member, still shown as the sender of earlier messages. */ left: boolean; /** Either of you blocked the other: no keys are exchanged. */ blocked: boolean };
export type DirectConversation = {
  id: string; kind: "direct" | "group";
  /** Group name (plaintext metadata); null for 1:1 conversations and unnamed groups. */
  name: string | null;
  /** Everyone else: the peer of a 1:1 conversation, or current and former group members. */
  members: DmMemberView[];
  /** The group's longest-standing member, who may remove others; null for 1:1 conversations. */
  owner: string | null;
  /** When you joined a group; earlier messages are not yours to read. */
  joinedAt: string | null;
  /** For groups: peerId is empty and peerName is the display label. */
  peerId: string; peerName: string; peerAvatar: string | null; requestedBy: string | null; status: "pending" | "accepted" | "rejected"; blocked: boolean; ownBlocked: boolean; /** Messages from others after the read marker. */ unread: number;
};
/** Shown in the DM list: declined requests and people you blocked are hidden. */
export const visibleConversation = (c: DirectConversation) => c.status !== "rejected" && !c.ownBlocked;
export const unreadTotal = (list: DirectConversation[]) => list.filter(visibleConversation).reduce((sum, c) => sum + (c.blocked ? 0 : c.unread), 0);
export type DirectEnvelope = { id: string; conversationId: string; senderId: string; deviceId: string; transactionId: string; content: Record<string, unknown>; createdAt: string };
export type DeviceView = { id: string; userId: string; name: string; revoked: boolean; createdAt: string };
export type CryptoSync = { cursor: string; events: Record<string, unknown>[]; oneTimeKeys: Record<string, number>; unusedFallbackKeys: string[] };
export type RecoveryFile = { format: "opendiscord.e2ee-recovery"; version: 2; origin: string; userId: string; backupId: string; encryptionInfo: string };

export type DmResetState = { identity: string | null; twoFactorEnabled: boolean; freshSession: boolean };
