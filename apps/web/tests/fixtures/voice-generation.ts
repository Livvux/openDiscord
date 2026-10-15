import { createHash, randomUUID } from "node:crypto";
import * as C from "@matrix-org/matrix-sdk-crypto-wasm";
import { EphemeralVoice, VoiceTransport } from "./ephemeral-voice";

export type NativeRequest = Awaited<ReturnType<C.OlmMachine["outgoingRequests"]>>[number];
type Operation = "send" | "retire";
type Receipt = { generation: number; disposition: "processed-current" | "processed-retired"; enqueued: number; nativeResponse: Record<string, unknown>; digest: string };
type Pending = { request: C.ToDeviceRequest; reject: (error: Error) => void };
const uuid = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

export function identity(owner: EphemeralVoice) {
  return { curve: owner.machine.identityKeys.curve25519.toBase64(), ed: owner.machine.identityKeys.ed25519.toBase64() };
}

/** An isolated in-memory test server; no application transport is imported. */
export class GenerationServer extends VoiceTransport {
  generation = 1;
  readonly retired: Receipt[] = [];
  private readonly generationReceipts = new Map<string, Receipt>();
  advance(): void { this.generation++; }

  async process(owner: EphemeralVoice, request: NativeRequest, generation: number, operation: Operation, transportId: string): Promise<Receipt> {
    // Authorization and current generation precede receipt replay, including for retirement.
    if (!this.owns(owner.binding) || generation !== this.generation) throw new Error("Current sender/generation required.");
    if ((operation === "retire" && !request.id) || Buffer.byteLength(request.body) > 128_000) throw new Error("Bounded native request required.");
    const digest = createHash("sha256").update(JSON.stringify([owner.binding, generation, operation, request.id, request.type, request.body])).digest("hex");
    const key = `${owner.binding.member}:${transportId}`;
    const previous = this.generationReceipts.get(key);
    if (previous) {
      if (previous.digest !== digest) throw new Error("Immutable receipt mismatch.");
      return previous;
    }
    let nativeResponse: Record<string, unknown>, enqueued = 0;
    if (operation === "retire") {
      if (!(request instanceof C.ToDeviceRequest)) throw new Error("Only ToDevice supports explicit retirement.");
      if (!/^m\.key\.verification\.(request|ready|start|accept|key|mac|done|cancel)$/.test(request.event_type) && request.event_type !== "m.room.encrypted") throw new Error("Unsupported retirement event.");
      const body: unknown = JSON.parse(request.body);
      if (!body || typeof body !== "object" || !("messages" in body) || !body.messages || typeof body.messages !== "object" || Array.isArray(body.messages)) throw new Error("Invalid retirement body.");
      const targets = Object.entries(body.messages);
      if (!targets.length || targets.length > 8) throw new Error("Retirement fanout bound.");
      const scoped = new RegExp(`^@voice_${this.call}_${uuid}:opendiscord\\.invalid$`);
      for (const [user, devices] of targets) {
        if (!scoped.test(user) || !devices || typeof devices !== "object" || Array.isArray(devices)) throw new Error("Same-call retirement targets required.");
        const entries = Object.entries(devices);
        if (entries.length !== 1 || !new RegExp(`^${uuid}$`).test(entries[0][0])) throw new Error("Exact bounded device required.");
      }
      // This branch cannot call submit/take or inspect any recipient's key record.
      nativeResponse = {};
    } else {
      const before = this.submitted.length;
      nativeResponse = await super.submit(owner, request);
      enqueued = this.submitted.slice(before).filter((entry) => entry.kind === "ToDevice").reduce((sum, entry) => sum + entry.recipients, 0);
    }
    const receipt: Receipt = { generation, digest, nativeResponse, enqueued, disposition: operation === "retire" ? "processed-retired" : "processed-current" };
    this.generationReceipts.set(key, receipt);
    if (operation === "retire") this.retired.push(receipt);
    if (this.generationReceipts.size > 512) throw new Error("Bounded server work exceeded.");
    return receipt;
  }
}

/** Public-API serial completion registry. Test pause models an unresolved HTTP request. */
export class GenerationDispatcher {
  readonly completions = new Map<string, number>();
  private readonly ids = new Map<string, string>();
  private readonly original: EphemeralVoice["out"];
  private pause?: { event: string; resolve: (pending: Pending) => void };
  private pending?: Pending;

  constructor(readonly owner: EphemeralVoice, readonly server: GenerationServer) {
    this.original = owner.out.bind(owner);
    owner.out = (request) => this.send(request);
  }
  private transportId(request: NativeRequest, operation: Operation): string {
    const key = JSON.stringify([this.server.generation, operation, request.id, request.type, request.body]);
    let id = this.ids.get(key);
    if (!id) { id = randomUUID(); this.ids.set(key, id); }
    return id;
  }
  private async complete(request: NativeRequest, receipt: Receipt): Promise<void> {
    if (receipt.generation !== this.server.generation) throw new Error("Stale response fenced.");
    if (!request.id) return;
    if (this.completions.has(request.id)) return;
    await this.owner.machine.markRequestAsSent(request.id, request.type, JSON.stringify(receipt.nativeResponse));
    this.completions.set(request.id, 1);
  }
  pauseAt(phase: string): Promise<Pending> {
    return new Promise((resolve) => { this.pause = { event: `m.key.verification.${phase}`, resolve }; });
  }
  async send(request: NativeRequest): Promise<void> {
    if (request instanceof C.ToDeviceRequest && this.pause?.event === request.event_type) {
      const pause = this.pause; this.pause = undefined;
      await new Promise<void>((_resolve, reject) => { this.pending = { request, reject }; pause.resolve(this.pending); });
      return;
    }
    const generation = this.server.generation;
    const response = await this.server.process(this.owner, request, generation, "send", this.transportId(request, "send"));
    await this.complete(request, response);
  }
  async retire(request: NativeRequest): Promise<void> {
    const receipt = await this.server.process(this.owner, request, this.server.generation, "retire", this.transportId(request, "retire"));
    await this.complete(request, receipt);
  }
  async cancelAndRetire(): Promise<void> {
    const cancel: C.ToDeviceRequest[] = [];
    // Public native handles only. Cancel unfinished flows even when the peer left.
    for (const user of await this.owner.machine.trackedUsers()) {
      for (const flow of this.owner.machine.getVerificationRequests(user)) {
        if (flow.isDone() || flow.isCancelled()) continue;
        const outgoing = flow.cancel();
        if (outgoing instanceof C.ToDeviceRequest) cancel.push(outgoing);
      }
    }
    const requests = [...cancel, ...(await this.owner.machine.outgoingRequests()).filter((r) => r instanceof C.ToDeviceRequest)];
    if (this.pending) requests.unshift(this.pending.request);
    const seen = new Set<string>();
    for (const request of requests) {
      if (!request.id || seen.has(request.id)) continue;
      seen.add(request.id); await this.retire(request);
    }
    this.pending?.reject(new Error("Generation changed; old operation interrupted."));
    this.pending = undefined; this.pause = undefined;
  }
  release(): void {
    this.pending?.reject(new Error("Proof disposed.")); this.pending = undefined;
    this.owner.out = this.original;
  }
}
