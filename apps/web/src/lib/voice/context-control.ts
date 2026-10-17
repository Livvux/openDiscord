import { z } from "zod";
import type { VoiceSnapshot } from "./contracts";
import { sameVoiceParty, voiceControlParty, voiceControlPartySchema, VOICE_CONTROL_EVENT, type VoiceControlParty } from "./owner-control";

const id = z.uuid();
export const voiceContextCommon = { version: z.literal(1), purpose: z.literal(VOICE_CONTROL_EVENT), callId: id, generation: z.number().int().positive(), epochId: id, sender: voiceControlPartySchema, recipient: voiceControlPartySchema, audience: z.array(voiceControlPartySchema).min(1).max(8), leader: voiceControlPartySchema, sequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), reference: id, transaction: id };
export const voiceContextControlSchema = z.discriminatedUnion("kind", [
  z.object({ ...voiceContextCommon, kind: z.literal("context-offer") }).strict(),
  z.object({ ...voiceContextCommon, kind: z.literal("context-accept") }).strict(),
  z.object({ ...voiceContextCommon, kind: z.literal("context-restart") }).strict(),
]);
export type VoiceContextControl = z.infer<typeof voiceContextControlSchema>;

/** Pure binding validator only; no consent, native authentication or agreement certificate. */
export function validateVoiceContextControl(raw: unknown, snapshot: VoiceSnapshot, audience: readonly VoiceControlParty[]): VoiceContextControl {
  const value = voiceContextControlSchema.parse(raw);
  if (value.callId !== snapshot.callId || value.generation !== snapshot.generation) throw new Error("Stale voice context binding.");
  if (value.audience.length !== audience.length || value.audience.some((party, index) => !sameVoiceParty(party, audience[index]) || !snapshot.members.some(member => sameVoiceParty(party, voiceControlParty(member))) || (index > 0 && value.audience[index - 1].memberId >= party.memberId))) throw new Error("Voice context audience mismatch.");
  if (![value.sender, value.recipient, value.leader].every(party => value.audience.some(entry => sameVoiceParty(entry, party))) || !sameVoiceParty(value.leader, value.audience[0])) throw new Error("Voice context party mismatch.");
  if ((value.kind === "context-offer" && (!sameVoiceParty(value.sender, value.leader) || value.reference !== value.transaction)) || (value.kind === "context-restart" && !sameVoiceParty(value.recipient, value.leader))) throw new Error("Voice context leader mismatch.");
  return value;
}
