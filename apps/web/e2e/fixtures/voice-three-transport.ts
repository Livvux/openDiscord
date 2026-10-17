import { createHash } from "node:crypto";
import { z } from "zod";
import { entries, parse, record, requestSchema, sasTypes, type Binding } from "./voice-three-contracts";

const signedKey = z.object({ user_id: z.string(), keys: z.record(z.string(), z.string()), signatures: z.record(z.string(), z.record(z.string(), z.string())).optional() }).passthrough();
type SignedKey = z.infer<typeof signedKey>;
type Envelope = { sender: string; type: string; content: Record<string, unknown> };
type Entry = { binding: Binding; device?: SignedKey; signing: Record<string, SignedKey>; prekeys: Map<string, unknown>; claimed: Set<string>; fallback: boolean; inbox: Envelope[]; admitted: Set<string>; flows: Map<string, Set<string>> };

/** Runner-side test transport sees public native data/ciphertext only, never an OlmMachine or media material. */
export class BrowserVoiceTransport {
  private readonly records = new Map<string, Entry>();
  private readonly receipts = new Map<string, { digest: string; response: Record<string, unknown> }>();
  readonly delivered = new Map<string, number>();
  submissions = 0;
  constructor(readonly bindings: readonly Binding[]) {
    if (bindings.length !== 3 || new Set(bindings.map((b) => b.call)).size !== 1) throw new Error("Fixture call bindings.");
    for (const binding of bindings) this.records.set(binding.user, { binding, signing: {}, prekeys: new Map(), claimed: new Set(), fallback: false, inbox: [], admitted: new Set(), flows: new Map() });
  }
  private get(user: string, device?: string): Entry {
    const value = this.records.get(user);
    if (!value || (device !== undefined && value.binding.device !== device)) throw new Error("Unknown call device.");
    return value;
  }
  submit(source: Binding, input: unknown): Record<string, unknown> {
    const request = requestSchema.parse(input), body = parse(request.body), own = this.get(source.user, source.device);
    if (++this.submissions > 1024) throw new Error("Fixture work cap.");
    if (request.kind === "sync") return { events: own.inbox.splice(0), count: own.prekeys.size, fallback: own.fallback };
    if (request.kind === "admit") {
      const peer = this.get(z.string().parse(body.user), z.string().parse(body.device));
      own.admitted.add(peer.binding.user); return {};
    }
    const receipt = request.id ? `${source.device}:${request.kind}:${request.id}` : undefined;
    const digest = createHash("sha256").update(JSON.stringify([request.kind, request.event, body])).digest("hex");
    const previous = receipt ? this.receipts.get(receipt) : undefined;
    if (previous) { if (previous.digest !== digest) throw new Error("Changed request retry."); return previous.response; }
    let response: Record<string, unknown>;
    if (request.kind === "signing") {
      for (const name of ["master_key", "self_signing_key", "user_signing_key"]) {
        const key = signedKey.parse(body[name]);
        if (key.user_id !== source.user) throw new Error("Signing binding.");
        own.signing[name] = key;
      }
      response = {};
    } else if (request.kind === "upload") {
      if (body.device_keys) {
        const key = signedKey.extend({ device_id: z.string() }).parse(body.device_keys);
        if (key.user_id !== source.user || key.device_id !== source.device) throw new Error("Device binding.");
        own.device = key;
      }
      for (const [id, value] of entries(body.one_time_keys ?? {}, 100)) {
        if (own.claimed.has(id)) continue;
        if (own.prekeys.has(id) && JSON.stringify(own.prekeys.get(id)) !== JSON.stringify(value)) throw new Error("Changed prekey.");
        own.prekeys.set(id, value);
      }
      if (entries(body.fallback_keys ?? {}, 1).length) own.fallback = true;
      if (own.prekeys.size > 100) throw new Error("Prekey cap.");
      response = { one_time_key_counts: { signed_curve25519: own.prekeys.size } };
    } else if (request.kind === "query") {
      const device_keys: Record<string, unknown> = {}, master_keys: Record<string, unknown> = {}, self_signing_keys: Record<string, unknown> = {}, user_signing_keys: Record<string, unknown> = {};
      for (const [user, requested] of entries(body.device_keys)) {
        const target = this.get(user);
        const ids = z.array(z.string()).max(1).parse(requested);
        if (ids.some((id) => id !== target.binding.device)) throw new Error("Unknown query device.");
        device_keys[user] = target.device ? { [target.binding.device]: target.device } : {};
        if (target.signing.master_key) master_keys[user] = target.signing.master_key;
        if (target.signing.self_signing_key) self_signing_keys[user] = target.signing.self_signing_key;
        if (user === source.user && target.signing.user_signing_key) user_signing_keys[user] = target.signing.user_signing_key;
      }
      response = { device_keys, master_keys, self_signing_keys, user_signing_keys, failures: {} };
    } else if (request.kind === "claim") {
      const one_time_keys: Record<string, unknown> = {};
      for (const [user, devices] of entries(body.one_time_keys)) for (const [device, algorithm] of entries(devices, 1)) {
        if (algorithm !== "signed_curve25519") throw new Error("Unknown prekey algorithm.");
        const target = this.get(user, device), next = target.prekeys.entries().next().value;
        if (!next) throw new Error("Missing prekey.");
        const [id, value] = next; target.prekeys.delete(id); target.claimed.add(id);
        one_time_keys[user] = { [device]: { [id]: value } };
      }
      response = { one_time_keys, failures: {} };
    } else if (request.kind === "signatures") {
      for (const [user, values] of entries(body)) for (const [id, value] of entries(values, 2)) {
        const target = this.get(user), signed = signedKey.parse(value);
        if (signed.user_id !== user) throw new Error("Signature binding.");
        const key = id === target.binding.device ? target.device : Object.values(target.signing).find((item) => Object.values(item.keys).includes(id));
        const signature = signed.signatures?.[source.user];
        if (!key || !signature) throw new Error("Unknown signature target.");
        key.signatures = { ...key.signatures, [source.user]: { ...key.signatures?.[source.user], ...signature } };
      }
      response = { failures: {} };
    } else if (request.kind === "send") {
      const event = request.event;
      if (!event || (!sasTypes.has(event) && event !== "m.room.encrypted")) throw new Error("Unsupported native event.");
      const pending: { target: Entry; content: Record<string, unknown> }[] = [];
      for (const [user, devices] of entries(body.messages)) for (const [device, value] of entries(devices, 1)) {
        const target = this.get(user, device), content = record.parse(value);
        if (target.inbox.length >= 64) throw new Error("Mailbox cap.");
        if (sasTypes.has(event)) {
          const flow = z.string().min(1).max(256).parse(content.transaction_id);
          if (event === "m.key.verification.request") {
            if ((own.flows.get(user)?.size ?? 0) >= 8) throw new Error("SAS flow cap.");
            const ownFlows = own.flows.get(user) ?? new Set<string>(), peerFlows = target.flows.get(source.user) ?? new Set<string>();
            ownFlows.add(flow); peerFlows.add(flow); own.flows.set(user, ownFlows); target.flows.set(source.user, peerFlows);
          } else if (!own.flows.get(user)?.has(flow) || !target.flows.get(source.user)?.has(flow)) throw new Error("Unknown SAS flow.");
        } else if (!own.admitted.has(user)) throw new Error("Unadmitted encrypted transport.");
        pending.push({ target, content });
      }
      for (const { target, content } of pending) {
        target.inbox.push({ sender: source.user, type: event, content });
        this.delivered.set(target.binding.member, (this.delivered.get(target.binding.member) ?? 0) + 1);
      }
      response = {};
    } else throw new Error("Unsupported request.");
    if (receipt) this.receipts.set(receipt, { digest, response });
    return response;
  }
  queued(binding: Binding): number { return this.get(binding.user).inbox.length; }
  close(): void { this.records.clear(); this.receipts.clear(); this.delivered.clear(); }
}
