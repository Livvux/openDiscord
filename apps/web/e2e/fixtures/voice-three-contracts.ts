import { z } from "zod";

export const record = z.record(z.string(), z.unknown());
export const bindingSchema = z.object({ call: z.uuid(), member: z.uuid(), user: z.string().max(150), device: z.uuid() }).strict();
export type Binding = z.infer<typeof bindingSchema>;
export const requestSchema = z.object({
  kind: z.enum(["upload", "query", "claim", "signatures", "signing", "send", "sync", "admit"]),
  id: z.string().max(256).optional(), body: z.string().max(128_000), event: z.string().max(100).optional(),
}).strict();
export type WireRequest = z.infer<typeof requestSchema>;
export const sasTypes = new Set(["request", "ready", "start", "accept", "key", "mac", "done", "cancel"].map((part) => `m.key.verification.${part}`));
export const envelopeSchema = z.object({ sender: z.string(), type: z.string(), content: record }).strict();
export const syncSchema = z.object({ events: z.array(envelopeSchema).max(64), count: z.number().int().min(0).max(100), fallback: z.boolean() }).strict();
export const controlSchema = z.object({
  version: z.literal(1), kind: z.enum(["material", "prepared", "key-ready"]), transaction: z.uuid(), epoch: z.uuid(),
  sender: bindingSchema, recipient: bindingSchema, publisher: bindingSchema, audience: z.array(bindingSchema).min(2).max(3),
  keyId: z.uuid(), reference: z.uuid(), material: z.string().regex(/^[A-Za-z0-9+/]{43}=$/).optional(),
}).strict().superRefine((value, ctx) => {
  if ((value.kind === "material") !== (value.material !== undefined)) ctx.addIssue({ code: "custom", message: "Control material shape." });
  const ids = value.audience.map((item) => item.member);
  if (new Set(ids).size !== ids.length || [...ids].sort().join() !== ids.join()) ctx.addIssue({ code: "custom", message: "Audience order." });
});
export type Control = z.infer<typeof controlSchema>;
export const CONTROL = "app.opendiscord.voice.browser-proof";
export function same(a: Binding, b: Binding): boolean { return a.call === b.call && a.member === b.member && a.user === b.user && a.device === b.device; }
export function sameAudience(a: readonly Binding[], b: readonly Binding[]): boolean { return a.length === b.length && a.every((item, index) => same(item, b[index])); }
export function parse(body: string): Record<string, unknown> {
  if (new TextEncoder().encode(body).byteLength > 128_000) throw new Error("Fixture body limit.");
  return record.parse(JSON.parse(body));
}
export function entries(value: unknown, cap = 3): [string, unknown][] {
  const values = Object.entries(record.parse(value));
  if (values.length > cap) throw new Error("Fixture target limit.");
  return values;
}
