import { createKeyMaterialFromBuffer } from "livekit-client";
import { z } from "zod";
import { BrowserOlm } from "./voice-three-olm";
import { BrowserMedia, type MediaKind } from "./voice-three-media";
import { bindingSchema, controlSchema, same, sameAudience, type Binding, type Control, type WireRequest } from "./voice-three-contracts";

type Material = { keyId: string; reference: string; key: CryptoKey };
class BrowserProof {
  private owner?: BrowserOlm;
  private epoch?: string;
  private audience: Binding[] = [];
  private readonly materials = new Map<string, Material>();
  private readonly sent = new Map<string, Control>();
  private readonly receipts = new Set<string>();
  private readonly prepared = new Set<string>();
  private readonly seen = new Set<string>();
  private readonly previousReady = new Map<string, Control>();
  private raw?: Uint8Array<ArrayBuffer>;
  private media?: BrowserMedia;
  private queue: Promise<unknown> = Promise.resolve();
  private invalid = true;
  private ignored = 0;
  private receivedMaterial = 0;
  private url = new URL("/voice-worker-proof/unconfigured", location.href);
  configure(url: URL): void { this.url = new URL(url.href, location.href); }
  serial<T>(fn: () => Promise<T>): Promise<T> { const next = this.queue.then(fn, fn); this.queue = next.catch(() => undefined); return next; }
  private active(): BrowserOlm { if (!this.owner) throw new Error("Browser native owner missing."); return this.owner; }
  async open(input: { binding: Binding; peers: Binding[] }): Promise<{ fingerprint: string }> {
    if (this.owner) throw new Error("Owner already exists.");
    const binding = bindingSchema.parse(input.binding), peers = z.array(bindingSchema).length(3).parse(input.peers);
    if (!peers.some((peer) => same(peer, binding)) || peers.some((peer) => peer.call !== binding.call)) throw new Error("Browser call binding.");
    this.owner = await BrowserOlm.open(binding, peers, (request) => window.voiceThreeTransport(request), (control) => this.receive(control));
    return { fingerprint: this.owner.fingerprint() };
  }
  async begin(epoch: string, members: string[]): Promise<void> {
    z.uuid().parse(epoch);
    if (epoch === this.epoch) throw new Error("New epoch required.");
    await this.media?.close(); this.media = undefined;
    this.raw?.fill(0); this.raw = undefined;
    this.materials.clear(); this.sent.clear(); this.receipts.clear(); this.prepared.clear(); this.seen.clear();
    const owner = this.active();
    this.audience = members.map((member) => owner.peer(member)).sort((a, b) => a.member.localeCompare(b.member));
    if (this.audience.length < 2 || this.audience.length > 3 || new Set(members).size !== members.length || !this.audience.some((peer) => same(peer, owner.binding))) throw new Error("Epoch audience mismatch.");
    this.epoch = epoch; this.invalid = false;
    this.raw = crypto.getRandomValues(new Uint8Array(32));
    this.materials.set(owner.binding.member, { keyId: crypto.randomUUID(), reference: crypto.randomUUID(), key: await createKeyMaterialFromBuffer(this.raw.buffer) });
  }
  private async receive(control: Control): Promise<void> {
    if (this.invalid || control.epoch !== this.epoch) { this.ignored++; return; }
    if (!sameAudience(control.audience, this.audience) || !this.audience.some((peer) => same(peer, control.publisher)) || !this.audience.some((peer) => same(peer, control.sender))) throw new Error("Current control audience mismatch.");
    if (this.seen.has(control.transaction)) { this.ignored++; return; }
    if (this.seen.size >= 64) throw new Error("Epoch control cap.");
    const owner = this.active();
    if (control.kind === "material") {
      if (!same(control.publisher, control.sender) || control.reference !== control.transaction || !control.material || this.materials.has(control.publisher.member)) throw new Error("Changed or malformed material.");
      const bytes = Uint8Array.from(atob(control.material), (value) => value.charCodeAt(0));
      if (bytes.byteLength !== 32 || btoa(String.fromCharCode(...bytes)) !== control.material) throw new Error("Noncanonical material.");
      const key = await createKeyMaterialFromBuffer(bytes.buffer); bytes.fill(0);
      this.materials.set(control.publisher.member, { keyId: control.keyId, reference: control.reference, key });
      this.receivedMaterial++;
      // Omit material entirely: the native WASM object bridge preserves an explicit
      // undefined property as null, which is not a valid material-free receipt.
      await owner.send({ version: 1, kind: "prepared", transaction: crypto.randomUUID(), epoch: control.epoch, sender: owner.binding, recipient: control.publisher, publisher: control.publisher, audience: control.audience, keyId: control.keyId, reference: control.reference });
    } else {
      const material = this.sent.get(control.sender.member);
      if (!same(control.publisher, owner.binding) || !material || control.keyId !== material.keyId || control.reference !== material.reference) throw new Error("Unbound material receipt.");
      if (control.kind === "prepared") this.prepared.add(control.sender.member);
      else this.receipts.add(control.sender.member);
    }
    this.seen.add(control.transaction);
  }
  async distribute(member?: string): Promise<void> {
    const owner = this.active(), own = this.materials.get(owner.binding.member);
    if (this.invalid || !this.epoch || !this.raw || !own) throw new Error("No current publisher material.");
    const peers = member ? [owner.peer(member)] : this.audience.filter((peer) => !same(peer, owner.binding));
    for (const peer of peers) {
      if (!this.audience.some((current) => same(current, peer)) || same(peer, owner.binding)) throw new Error("Recipient outside current media audience.");
      if (this.sent.has(peer.member)) throw new Error("Material already sent.");
      const control = controlSchema.parse({ version: 1, kind: "material", transaction: own.reference, epoch: this.epoch, sender: owner.binding, recipient: peer, publisher: owner.binding, audience: this.audience, keyId: own.keyId, reference: own.reference, material: btoa(String.fromCharCode(...this.raw)) });
      await owner.send(control); this.sent.set(peer.member, control);
    }
  }
  async connect(input: { url: string; token: string; omit?: string; diagnostic?: "missing-key" | "wrong-key"; target?: string }): Promise<void> {
    if (this.invalid || this.materials.size !== this.audience.length) throw new Error("All authenticated material required.");
    if (this.media && !input.diagnostic) throw new Error("Fresh epoch required for normal worker replacement.");
    // A diagnostic receiver can never send key-ready or publish, including after its native fence.
    const diagnostic = input.diagnostic !== undefined;
    if (diagnostic && (!this.media || !input.target || input.target === this.active().binding.member || !this.audience.some((peer) => peer.member === input.target))) throw new Error("Diagnostic remote target required.");
    if (this.media) await this.media.close();
    const expected = new Map([...this.materials].map(([identity, value]) => [identity, value.key]));
    if (input.diagnostic === "wrong-key" && input.target) expected.set(input.target, await createKeyMaterialFromBuffer(crypto.getRandomValues(new Uint8Array(32)).buffer));
    const supplied = new Map(expected);
    if (input.omit) supplied.delete(input.omit);
    if (input.diagnostic === "missing-key" && input.target) supplied.delete(input.target);
    this.receipts.clear();
    const current: BrowserMedia = new BrowserMedia(this.active().binding.member, this.url, expected, supplied, diagnostic, () => { if (this.media === current) { this.receipts.clear(); this.invalid = true; } });
    this.media = current;
    await current.connect(input.url, input.token);
  }
  async keyReady(): Promise<void> {
    if (this.invalid || !this.media?.ready() || !this.epoch) throw new Error("Current normal worker fence required.");
    const owner = this.active();
    for (const publisher of this.audience) {
      if (same(publisher, owner.binding)) continue;
      const material = this.materials.get(publisher.member);
      if (!material) throw new Error("Material absent.");
      const control: Control = { version: 1, kind: "key-ready", transaction: crypto.randomUUID(), epoch: this.epoch, sender: owner.binding, recipient: publisher, publisher, audience: this.audience, keyId: material.keyId, reference: material.reference };
      await owner.send(control); this.previousReady.set(publisher.member, control);
    }
    this.media.mark("key-ready-sent");
  }
  async stale(member: string): Promise<void> {
    const control = this.previousReady.get(member);
    if (!control) throw new Error("No previous genuine receipt.");
    await this.active().send(control);
  }
  async publish(kind: MediaKind): Promise<void> {
    const owner = this.active();
    if (this.invalid || !this.media?.ready() || this.audience.some((peer) => !same(peer, owner.binding) && !this.receipts.has(peer.member))) throw new Error("All current authenticated key-ready receipts required.");
    this.media.mark("receipts-complete");
    await this.media.publish(kind);
  }
  async closeMedia(): Promise<void> { await this.media?.close(); }
  async close(): Promise<void> { await this.media?.close(); this.raw?.fill(0); this.raw = undefined; this.sent.clear(); this.previousReady.clear(); this.materials.clear(); this.owner?.close(); this.owner = undefined; }
  async snapshot() {
    return { workerUrl: this.url.href, epoch: this.epoch, invalid: this.invalid, material: this.materials.size, receivedMaterial: this.receivedMaterial, prepared: [...this.prepared], ready: [...this.receipts], ignored: this.ignored, verifiedControls: this.owner?.verifiedControls ?? 0, media: await this.media?.snapshot() };
  }
  query(): Promise<void> { return this.active().query(); }
  sync(): Promise<void> { return this.active().sync(); }
  request(member: string): Promise<string> { return this.active().request(member); }
  verify(member: string, flow: string, step: "accept" | "start" | "accept-sas" | "confirm"): Promise<void> { return this.active().verifyStep(member, flow, step); }
  sas(member: string, flow: string) { return this.active().sas(member, flow); }
  trusted(member: string): Promise<boolean> { return this.active().trusted(member); }
  admit(member: string): Promise<void> { return this.active().admit(member); }
}
const proof = new BrowserProof();
export function configureWorker(url: URL): void { proof.configure(url); }
const api = {
  open: (input: Parameters<BrowserProof["open"]>[0]) => proof.serial(() => proof.open(input)),
  begin: (epoch: string, members: string[]) => proof.serial(() => proof.begin(epoch, members)),
  query: () => proof.serial(() => proof.query()), sync: () => proof.serial(() => proof.sync()),
  request: (member: string) => proof.serial(() => proof.request(member)),
  verify: (member: string, flow: string, step: Parameters<BrowserProof["verify"]>[2]) => proof.serial(() => proof.verify(member, flow, step)),
  sas: (member: string, flow: string) => proof.serial(async () => proof.sas(member, flow)),
  trusted: (member: string) => proof.serial(() => proof.trusted(member)), admit: (member: string) => proof.serial(() => proof.admit(member)),
  distribute: (member?: string) => proof.serial(() => proof.distribute(member)),
  connect: (input: Parameters<BrowserProof["connect"]>[0]) => proof.serial(() => proof.connect(input)),
  keyReady: () => proof.serial(() => proof.keyReady()), stale: (member: string) => proof.serial(() => proof.stale(member)),
  publish: (kind: MediaKind) => proof.serial(() => proof.publish(kind)),
  closeMedia: () => proof.serial(() => proof.closeMedia()), close: () => proof.serial(() => proof.close()), snapshot: () => proof.serial(() => proof.snapshot()),
};
declare global {
  interface Window { threeVoice: typeof api; voiceThreeTransport: (request: WireRequest) => Promise<unknown>; }
}
window.threeVoice = api;
