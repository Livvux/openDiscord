import { z } from "zod";
import type { VoiceMember, VoiceSnapshot } from "./contracts";
export const VOICE_CONTROL_EVENT = "app.opendiscord.voice.control";
const id = z.uuid();
export const voiceControlPartySchema = z.object({ memberId: id, userId: z.string().min(1).max(128), voiceUserId: z.string().min(1).max(256), voiceDeviceId: id, joinNonce: id, participantIdentity: z.string().min(1).max(128) }).strict();
const common = { version: z.literal(1), purpose: z.literal(VOICE_CONTROL_EVENT), callId: id, generation: z.number().int().positive(), epochId: id, sender: voiceControlPartySchema, recipient: voiceControlPartySchema, publisher: voiceControlPartySchema, audience: z.array(voiceControlPartySchema).min(1).max(8), keyId: id, reference: id, transaction: id };
export const voiceOwnerControlSchema = z.discriminatedUnion("kind", [
  z.object({ ...common, kind: z.literal("material"), material: z.string().regex(/^[A-Za-z0-9+/]{43}=$/) }).strict(),
  z.object({ ...common, kind: z.literal("prepared") }).strict(),
  z.object({ ...common, kind: z.literal("key-ready") }).strict(),
]);
export type VoiceOwnerControl = z.infer<typeof voiceOwnerControlSchema>;
export type VoiceControlParty = z.infer<typeof voiceControlPartySchema>;
export function voiceControlParty(member: VoiceMember): VoiceControlParty {
  return voiceControlPartySchema.parse({ memberId: member.memberId, userId: member.userId, voiceUserId: member.voiceUserId, voiceDeviceId: member.voiceDeviceId, joinNonce: member.joinNonce, participantIdentity: member.participantIdentity });
}
export function sameVoiceParty(a: VoiceControlParty, b: VoiceControlParty): boolean { return Object.keys(voiceControlPartySchema.shape).every(key => a[key as keyof VoiceControlParty] === b[key as keyof VoiceControlParty]); }
export function validateVoiceOwnerControl(raw: unknown, snapshot: VoiceSnapshot, epochId: string, audience: readonly VoiceControlParty[]): VoiceOwnerControl {
  const value = voiceOwnerControlSchema.parse(raw);
  const current = (party: VoiceControlParty) => snapshot.members.some(member => sameVoiceParty(party, voiceControlParty(member)));
  if (value.callId !== snapshot.callId || value.generation !== snapshot.generation || value.epochId !== epochId || !current(value.sender) || !current(value.recipient) || !current(value.publisher)) throw new Error("Stale voice control binding.");
  if (value.audience.length !== audience.length || value.audience.some((party, index) => !current(party) || !sameVoiceParty(party, audience[index])) || value.audience.some((party, index) => index > 0 && value.audience[index - 1].memberId >= party.memberId)) throw new Error("Voice control audience mismatch.");
  if (!value.audience.some(party => sameVoiceParty(party, value.publisher)) || !value.audience.some(party => sameVoiceParty(party, value.sender)) || !value.audience.some(party => sameVoiceParty(party, value.recipient)) || (value.kind === "material" && !sameVoiceParty(value.sender, value.publisher)) || (value.kind !== "material" && !sameVoiceParty(value.recipient, value.publisher))) throw new Error("Voice control publisher mismatch.");
  return value;
}
