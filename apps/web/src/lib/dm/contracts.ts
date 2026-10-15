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
export const plainMessageSchema = z.object({
  msgtype: z.literal("m.text"),
  body: z.string().trim().min(1).max(DM_MAX_TEXT),
  conversation: z.uuid(),
  transaction: z.uuid(),
}).strict();
export type PlainDirectMessage = z.infer<typeof plainMessageSchema>;
export type DmDeviceAuth = { userId: string; sessionId: string; deviceId: string; secret: string };
export type DirectConversation = { id: string; peerId: string; peerName: string; requestedBy: string; status: "pending" | "accepted" | "rejected"; blocked: boolean; ownBlocked: boolean };
export type DirectEnvelope = { id: string; conversationId: string; senderId: string; deviceId: string; transactionId: string; content: Record<string, unknown>; createdAt: string };
export type DeviceView = { id: string; userId: string; name: string; revoked: boolean; createdAt: string };
export type CryptoSync = { cursor: string; events: Record<string, unknown>[]; oneTimeKeys: Record<string, number>; unusedFallbackKeys: string[] };
export type RecoveryFile = { format: "opendiscord.e2ee-recovery"; version: 2; origin: string; userId: string; backupId: string; encryptionInfo: string };

export type DmResetState = { identity: string | null; twoFactorEnabled: boolean; freshSession: boolean };
