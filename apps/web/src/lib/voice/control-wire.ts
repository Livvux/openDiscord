import { z } from "zod";
import { VOICE_DOMAIN } from "./contracts";
import { voiceContextControlSchema, type VoiceContextControl } from "./context-control";
import { sameVoiceParty, voiceControlPartySchema, voiceOwnerControlSchema, type VoiceOwnerControl } from "./owner-control";

const encoding = z.literal("party-table-v2"), id = z.uuid(), index = z.number().int().min(0).max(7);
const accountId = z.string().min(4).max(344).regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/);
const partyTuple = z.tuple([id, accountId, id, id]);
const references = { encoding, parties: z.array(partyTuple).min(1).max(8), sender: index, recipient: index };
const media = { ...voiceOwnerControlSchema.options[1].omit({ audience: true, kind: true }).shape, ...references, publisher: index };
const context = { ...voiceContextControlSchema.options[0].omit({ audience: true, kind: true }).shape, ...references, leader: index };
export const voiceControlWireSchema = z.discriminatedUnion("kind", [
  z.object({ ...media, kind: z.literal("material"), material: voiceOwnerControlSchema.options[0].shape.material }).strict(),
  z.object({ ...media, kind: z.literal("prepared") }).strict(),
  z.object({ ...media, kind: z.literal("key-ready") }).strict(),
  z.object({ ...context, kind: z.literal("context-offer") }).strict(),
  z.object({ ...context, kind: z.literal("context-accept") }).strict(),
  z.object({ ...context, kind: z.literal("context-restart") }).strict(),
]);
const canonicalSchema = z.discriminatedUnion("kind", [...voiceOwnerControlSchema.options, ...voiceContextControlSchema.options]);
type CanonicalControl = VoiceOwnerControl | VoiceContextControl;

// Fixed big-endian code units preserve the exact JS string, including unpaired surrogates.
function encodeAccount(value: string): string {
  const bytes: number[] = [];
  for (let i = 0; i < value.length; i++) { const unit = value.charCodeAt(i); bytes.push(unit >>> 8, unit & 255); }
  return btoa(String.fromCharCode(...bytes));
}
function decodeAccount(value: string): string {
  const bytes = atob(value);
  if (bytes.length < 2 || bytes.length > 256 || bytes.length % 2 !== 0) throw new Error("Invalid voice account code-unit bytes.");
  let result = "";
  for (let i = 0; i < bytes.length; i += 2) result += String.fromCharCode(bytes.charCodeAt(i) * 256 + bytes.charCodeAt(i + 1));
  if (encodeAccount(result) !== value) throw new Error("Noncanonical voice account base64.");
  return result;
}
function validateTable(value: CanonicalControl): void {
  if (value.audience.some((party, offset) => offset > 0 && value.audience[offset - 1].memberId >= party.memberId)) throw new Error("Voice wire party table must be sorted and unique.");
  if (value.audience.some(party => party.voiceUserId !== `@voice_${value.callId}_${party.memberId}:${VOICE_DOMAIN}` || party.participantIdentity !== `v1:${party.memberId}`)) throw new Error("Voice wire derived party mismatch.");
  const referenced = [value.sender, value.recipient, "publisher" in value ? value.publisher : value.leader];
  if (referenced.some(party => !value.audience.some(entry => sameVoiceParty(entry, party)))) throw new Error("Voice wire party reference mismatch.");
}

/** Canonical full bindings are checked before native encryption, never by rewriting SDK output. */
export function encodeVoiceControlWire(raw: CanonicalControl): z.infer<typeof voiceControlWireSchema> {
  const value = canonicalSchema.parse(raw);
  validateTable(value);
  const fields = Object.fromEntries(Object.entries(value).filter(([key]) => key !== "audience"));
  const ref = (memberId: string) => value.audience.findIndex(party => party.memberId === memberId);
  return voiceControlWireSchema.parse({ ...fields, encoding: "party-table-v2", parties: value.audience.map(party => [party.memberId, encodeAccount(party.userId), party.voiceDeviceId, party.joinNonce]), sender: ref(value.sender.memberId), recipient: ref(value.recipient.memberId), ...("publisher" in value ? { publisher: ref(value.publisher.memberId) } : { leader: ref(value.leader.memberId) }) });
}

/** The encoding discriminator is authoritative: malformed compact data never retries legacy. */
export function decodeVoiceControlWire(raw: unknown): CanonicalControl {
  if (typeof raw !== "object" || raw === null || !("encoding" in raw)) return canonicalSchema.parse(raw);
  const wire = voiceControlWireSchema.parse(raw);
  const audience = wire.parties.map(([memberId, encodedAccount, voiceDeviceId, joinNonce]) => voiceControlPartySchema.parse({ memberId, userId: decodeAccount(encodedAccount), voiceDeviceId, joinNonce, voiceUserId: `@voice_${wire.callId}_${memberId}:${VOICE_DOMAIN}`, participantIdentity: `v1:${memberId}` }));
  const resolve = (offset: number) => {
    const found = audience[offset];
    if (!found) throw new Error("Unknown voice wire party reference.");
    return found;
  };
  const fields = Object.fromEntries(Object.entries(wire).filter(([key]) => key !== "encoding" && key !== "parties"));
  const value = canonicalSchema.parse({ ...fields, audience, sender: resolve(wire.sender), recipient: resolve(wire.recipient), ...("publisher" in wire ? { publisher: resolve(wire.publisher) } : { leader: resolve(wire.leader) }) });
  validateTable(value);
  return value;
}
