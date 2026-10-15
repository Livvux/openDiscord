/** Experimental, unused by the product until the native-worker browser proof passes review. */
function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export class StrictVoiceWorker extends Worker {
  private readonly admitted: Set<string>;
  private readonly enabled = new Set<string>();
  private failed = false;
  private readonly waiters = new Map<string, Set<() => void>>();

  constructor(url: URL, identities: readonly string[], private readonly onFailure: (reason: string) => void) {
    super(url, { type: "module" });
    this.admitted = new Set(identities);
    this.addEventListener("message", (event: MessageEvent<unknown>) => {
      const message = event.data;
      if (!object(message)) return;
      if (message.kind === "error") { this.fail("Native encryption worker failed."); return; }
      if (message.kind !== "enable" || !object(message.data)) return;
      const { participantIdentity, enabled } = message.data;
      if (typeof participantIdentity !== "string" || enabled !== true || !this.admitted.has(participantIdentity)) {
        this.fail("Unexpected encryption acknowledgement."); return;
      }
      this.enabled.add(participantIdentity);
      this.waiters.get(participantIdentity)?.forEach((done) => done());
    });
    this.addEventListener("error", () => this.fail("Encryption worker stopped."));
    this.addEventListener("messageerror", () => this.fail("Encryption worker message failed."));
  }

  private fail(reason: string): void {
    if (this.failed) return;
    this.failed = true;
    super.terminate();
    this.waiters.forEach((waiters) => waiters.forEach((done) => done()));
    this.onFailure(reason);
  }

  /** Both overloads preserve native transferable ownership; no frame crypto is implemented here. */
  override postMessage(message: unknown, transfer: Transferable[]): void;
  override postMessage(message: unknown, options?: StructuredSerializeOptions): void;
  override postMessage(message: unknown, transferOrOptions?: Transferable[] | StructuredSerializeOptions): void {
    if (this.failed) return;
    if (object(message)) {
      const data = object(message.data) ? message.data : undefined;
      if (message.kind === "enable" || message.kind === "encode" || message.kind === "decode" || message.kind === "updateCodec" || message.kind === "setKey") {
        const id = data?.participantIdentity;
        if (typeof id !== "string" || !this.admitted.has(id)) { this.fail("Unadmitted media identity."); return; }
        if (message.kind === "enable" && data?.enabled !== true) { this.fail("Encryption downgrade refused."); return; }
        if ((message.kind === "encode" || message.kind === "decode" || message.kind === "updateCodec") && !this.enabled.has(id)) {
          this.fail("Media started before encryption acknowledgement."); return;
        }
      }
    }
    if (Array.isArray(transferOrOptions)) super.postMessage(message, transferOrOptions);
    else super.postMessage(message, transferOrOptions);
  }

  /** Publication/subscription must wait for the native queue's positive enable acknowledgement. */
  async waitUntilEnabled(identity: string, timeoutMs = 5000): Promise<void> {
    if (!this.admitted.has(identity)) throw new Error("Unadmitted media identity.");
    if (this.failed) throw new Error("Encryption worker failed.");
    if (this.enabled.has(identity)) return;
    await new Promise<void>((resolve) => {
      const callbacks = this.waiters.get(identity) ?? new Set<() => void>();
      this.waiters.set(identity, callbacks);
      const done = () => { clearTimeout(timeout); callbacks.delete(done); resolve(); };
      const timeout = setTimeout(() => { this.fail("Encryption acknowledgement timed out."); done(); }, timeoutMs);
      callbacks.add(done);
    });
    if (this.failed || !this.enabled.has(identity)) throw new Error("Encryption worker failed.");
  }

  override terminate(): void { this.fail("Encryption worker closed."); }
}
