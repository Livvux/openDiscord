import { z } from "zod";
import { voiceContextControlSchema, type VoiceContextControl } from "./context-control";
import { sameVoiceParty, voiceControlPartySchema, voiceOwnerControlSchema, type VoiceOwnerControl } from "./owner-control";

const encoding = z.literal("party-table-v1"), id = z.uuid();
const references = { encoding, parties: z.array(voiceControlPartySchema).min(1).max(8), sender: id, recipient: id };
const media = { ...voiceOwnerControlSchema.options[1].omit({ audience: true, kind: true }).shape, ...references, publisher: id };
const context = { ...voiceContextControlSchema.options[0].omit({ audience: true, kind: true }).shape, ...references, leader: id };
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

function validateTable(value: CanonicalControl): void {
  if (value.audience.some((party, index) => index > 0 && value.audience[index - 1].memberId >= party.memberId)) throw new Error("Voice wire party table must be sorted and unique.");
  const referenced = [value.sender, value.recipient, "publisher" in value ? value.publisher : value.leader];
  if (referenced.some(party => !value.audience.some(entry => sameVoiceParty(entry, party)))) throw new Error("Voice wire party reference mismatch.");
}

/** Canonical full bindings are checked before native encryption, never by rewriting SDK output. */
export function encodeVoiceControlWire(raw: CanonicalControl): z.infer<typeof voiceControlWireSchema> {
  const value = canonicalSchema.parse(raw);
  validateTable(value);
  const fields = Object.fromEntries(Object.entries(value).filter(([key]) => key !== "audience"));
  return voiceControlWireSchema.parse({ ...fields, encoding: "party-table-v1", parties: value.audience, sender: value.sender.memberId, recipient: value.recipient.memberId, ...("publisher" in value ? { publisher: value.publisher.memberId } : { leader: value.leader.memberId }) });
}

/** The encoding discriminator is authoritative: malformed compact data never retries legacy. */
export function decodeVoiceControlWire(raw: unknown): CanonicalControl {
  if (typeof raw !== "object" || raw === null || !("encoding" in raw)) {
    return canonicalSchema.parse(raw);
  }
  const wire = voiceControlWireSchema.parse(raw);
  const resolve = (memberId: string) => {
    const found = wire.parties.find(party => party.memberId === memberId);
    if (!found) throw new Error("Unknown voice wire party reference.");
    return found;
  };
  const fields = Object.fromEntries(Object.entries(wire).filter(([key]) => key !== "encoding" && key !== "parties"));
  const value = canonicalSchema.parse({ ...fields, audience: wire.parties, sender: resolve(wire.sender), recipient: resolve(wire.recipient), ...("publisher" in wire ? { publisher: resolve(wire.publisher) } : { leader: resolve(wire.leader) }) });
  validateTable(value);
  return value;
}
