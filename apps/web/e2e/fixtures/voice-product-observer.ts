/** Browser init script: observes genuine native effects without exposing auth, keys or SDK control. */
export function installVoiceProductObserver() {
  type Entry = { sequence: number; kind: string; peer: number };
  const NativeWorker = window.Worker, NativeConnection = window.RTCPeerConnection;
  const connections: RTCPeerConnection[] = [];
  const workers: { submitted: Set<string>; enabled: Set<string>; own?: string; ownAckAt: number; keysBeforeOwnAck: number; trace: Entry[]; terminated: boolean; url: string }[] = [];
  let sequence = 0, captureCalls = 0, displayCalls = 0;
  const captures: MediaStreamTrack[] = [];
  const object = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;
  window.Worker = class extends NativeWorker {
    private readonly observation = { submitted: new Set<string>(), enabled: new Set<string>(), own: undefined as string | undefined, ownAckAt: 0, keysBeforeOwnAck: 0, trace: [] as Entry[], terminated: false, url: "" };
    private readonly identities = new Map<string, number>();
    private mark(kind: string, identity: string) {
      if (!this.identities.has(identity)) this.identities.set(identity, this.identities.size);
      if (this.observation.trace.length < 100) this.observation.trace.push({ sequence: ++sequence, kind, peer: this.identities.get(identity)! });
    }
    constructor(url: string | URL, options?: WorkerOptions) {
      super(url, options);
      this.observation.url = new URL(url, location.href).href; workers.push(this.observation);
      this.addEventListener("message", (event: MessageEvent<unknown>) => {
        if (!object(event.data) || event.data.kind !== "enable" || !object(event.data.data)) return;
        const { participantIdentity, enabled } = event.data.data;
        if (typeof participantIdentity !== "string" || enabled !== true) return;
        this.mark("ack", participantIdentity); this.observation.enabled.add(participantIdentity);
        if (participantIdentity === this.observation.own && !this.observation.ownAckAt) {
          this.observation.ownAckAt = sequence; this.observation.keysBeforeOwnAck = this.observation.submitted.size;
        }
      });
    }
    override postMessage(message: unknown, transfer: Transferable[]): void;
    override postMessage(message: unknown, options?: StructuredSerializeOptions): void;
    override postMessage(message: unknown, options?: Transferable[] | StructuredSerializeOptions): void {
      if (object(message) && object(message.data) && typeof message.data.participantIdentity === "string") {
        const id = message.data.participantIdentity;
        if (message.kind === "setKey") { this.observation.submitted.add(id); this.mark("setKey", id); }
        if (message.kind === "enable" && message.data.enabled === true) { this.observation.own ??= id; this.mark("enable", id); }
        if (message.kind === "encode" || message.kind === "decode") this.mark(message.kind, id);
      }
      if (Array.isArray(options)) super.postMessage(message, options); else super.postMessage(message, options);
    }
    override terminate() { this.observation.terminated = true; super.terminate(); }
  };
  window.RTCPeerConnection = class extends NativeConnection {
    constructor(configuration?: RTCConfiguration) { super(configuration); connections.push(this); }
  };
  const nativeCapture = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  navigator.mediaDevices.getUserMedia = async constraints => {
    captureCalls++; const stream = await nativeCapture(constraints); captures.push(...stream.getTracks()); return stream;
  };
  const nativeDisplay = navigator.mediaDevices.getDisplayMedia.bind(navigator.mediaDevices);
  navigator.mediaDevices.getDisplayMedia = async constraints => {
    displayCalls++; const stream = await nativeDisplay(constraints); captures.push(...stream.getTracks()); return stream;
  };
  const observer = {
    async snapshot() {
      let audioEnergy = 0, videoFrames = 0, samples = 0, width = 0;
      const codecs = new Set<string>();
      for (const connection of connections) {
        if (connection.connectionState === "closed") continue;
        const report = await connection.getStats();
        report.forEach(entry => {
          if (entry.type !== "inbound-rtp") return;
          if (typeof entry.totalAudioEnergy === "number") audioEnergy += entry.totalAudioEnergy;
          if (typeof entry.totalSamplesReceived === "number") samples += entry.totalSamplesReceived;
          if (typeof entry.framesDecoded === "number") videoFrames += entry.framesDecoded;
          if (typeof entry.frameWidth === "number") width = Math.max(width, entry.frameWidth);
          const codec = report.get(entry.codecId); if (typeof codec?.mimeType === "string") codecs.add(codec.mimeType.toLowerCase());
        });
      }
      const current = workers.at(-1);
      const ordered = !current || current.trace.every(entry => {
        if (entry.kind === "encode") return current.ownAckAt > 0 && current.ownAckAt < entry.sequence;
        if (entry.kind === "decode") return current.trace.some(ack => ack.kind === "ack" && ack.peer === entry.peer && ack.sequence < entry.sequence);
        return true;
      });
      return { captureCalls, displayCalls, liveCaptures: captures.filter(track => track.readyState === "live").length, senders: connections.flatMap(connection => connection.getSenders()).filter(sender => sender.track?.readyState === "live").length, audioEnergy, videoFrames, samples, width, codecs: [...codecs], workers: workers.length, submitted: current?.submitted.size ?? 0, ownAck: !!current?.ownAckAt, keysBeforeOwnAck: current?.keysBeforeOwnAck ?? 0, ordered, allTerminated: workers.every(worker => worker.terminated), workerUrl: current?.url ?? "" };
    },
  };
  Object.defineProperty(window, "__voiceProductEvidence", { value: observer, configurable: true });
}
export type VoiceProductEvidence = {
  captureCalls: number; displayCalls: number; liveCaptures: number; senders: number;
  audioEnergy: number; videoFrames: number; samples: number; width: number; codecs: string[];
  workers: number; submitted: number; ownAck: boolean; keysBeforeOwnAck: number; ordered: boolean;
  allTerminated: boolean; workerUrl: string;
};
declare global { interface Window { __voiceProductEvidence: { snapshot(): Promise<VoiceProductEvidence> } } }
