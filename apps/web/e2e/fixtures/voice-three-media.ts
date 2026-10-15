import { BaseKeyProvider, Encryption_Type, Room, RoomEvent, Track, type RemoteTrack, type RemoteTrackPublication, type RemoteParticipant } from "livekit-client";
import { StrictVoiceWorker } from "../../src/lib/voice/strict-worker";

export type MediaKind = "audio" | "video";
export type TraceEntry = { sequence: number; kind: string; identity: string; track?: string };
export type FrameCount = { identity: string; direction: string; codec: string; input: number; output: number; nonempty: number; changed: number; unmatched: number };
export type StreamCount = { identity: string; kind: string; bytes: number; samples: number; energy: number; frames: number; width: number; codec: string };
export type MediaSnapshot = { generation: string; diagnostic: boolean; workerUrl: string; fence: boolean; stopped: boolean; errors: string[]; trace: TraceEntry[]; frames: FrameCount[]; streams: StreamCount[]; publications: number; scriptTransform: boolean; encodedStreams: boolean };
type Frame = RTCEncodedAudioFrame | RTCEncodedVideoFrame;
function object(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null; }

class Provider extends BaseKeyProvider {
  constructor(keys: ReadonlyMap<string, CryptoKey>) {
    super({ sharedKey: false, ratchetWindowSize: 0, failureTolerance: 0 });
    keys.forEach((key, id) => this.onSetEncryptionKey(key, id, 0));
  }
}

/** Observes exact native queue order. It does not claim per-key success or implement frame crypto. */
class ObservedWorker extends StrictVoiceWorker {
  readonly trace: TraceEntry[] = [];
  readonly frames: FrameCount[] = [];
  private readonly posted = new Set<string>();
  private localCommand = 0;
  fence = false;
  private sequence = 0;
  private dead = false;
  constructor(url: URL, private readonly local: string, private readonly expected: ReadonlyMap<string, CryptoKey>, private readonly diagnostic: boolean, private readonly failure: (reason: string) => void) {
    super(url, [...expected.keys()], failure);
    this.addEventListener("message", (event: MessageEvent<unknown>) => {
      if (this.dead || !object(event.data) || event.data.kind !== "enable" || !object(event.data.data)) return;
      const data = event.data.data;
      if (typeof data.participantIdentity !== "string" || data.enabled !== true) return;
      this.mark("ack", data.participantIdentity);
      if (data.participantIdentity === this.local) {
        if (!this.localCommand || (!this.diagnostic && this.posted.size !== this.expected.size)) { this.refuse("Invalid fresh-worker queue fence."); return; }
        this.fence = true;
      }
    });
  }
  mark(kind: string, identity: string, track?: string): void { if (this.trace.length < 200) this.trace.push({ sequence: ++this.sequence, kind, identity, ...(track ? { track } : {}) }); }
  private refuse(reason: string): void { if (this.dead) return; this.dead = true; this.fence = false; this.failure(reason); super.terminate(); }
  override postMessage(message: unknown, transfer: Transferable[]): void;
  override postMessage(message: unknown, options?: StructuredSerializeOptions): void;
  override postMessage(message: unknown, options?: Transferable[] | StructuredSerializeOptions): void {
    if (this.dead) return;
    if (object(message) && object(message.data)) {
      const data = message.data, id = data.participantIdentity;
      if (message.kind === "setKey") {
        if (typeof id !== "string" || data.key !== this.expected.get(id) || data.keyIndex !== 0 || !(data.key instanceof CryptoKey) || data.key.algorithm.name !== "HKDF" || data.key.extractable || !data.key.usages.includes("deriveBits") || !data.key.usages.includes("deriveKey")) { this.refuse("Unexpected native key mapping."); return; }
        this.posted.add(id); this.mark("setKey", id);
      } else if (message.kind === "enable" && typeof id === "string") {
        this.mark("enable", id);
        if (id === this.local) {
          if (!this.diagnostic && this.posted.size !== this.expected.size) { this.refuse("Missing expected key before local fence."); return; }
          if (!this.localCommand) this.localCommand = this.sequence;
        }
      }
      if ((message.kind === "encode" || message.kind === "decode") && typeof id === "string") {
        this.mark(message.kind, id, typeof data.trackId === "string" ? data.trackId : undefined);
        if (!(data.readableStream instanceof ReadableStream) || !(data.writableStream instanceof WritableStream)) { this.refuse("Native encoded streams missing."); return; }
        const count: FrameCount = { identity: id, direction: message.kind, codec: typeof data.codec === "string" ? data.codec : "opus", input: 0, output: 0, nonempty: 0, changed: 0, unmatched: 0 };
        this.frames.push(count);
        const originals = new Map<number, Uint8Array>();
        const input = data.readableStream.pipeThrough(new TransformStream<Frame, Frame>({ transform(frame, controller) {
          count.input++;
          if (count.direction === "encode") {
            originals.set(frame.timestamp, new Uint8Array(frame.data.slice(0)));
            if (originals.size > 100) originals.delete(originals.keys().next().value ?? 0);
          }
          controller.enqueue(frame);
        } }));
        const output = new TransformStream<Frame, Frame>({ transform(frame, controller) {
          count.output++;
          if (count.direction === "encode") {
            const original = originals.get(frame.timestamp);
            if (!original) count.unmatched++;
            else if (original.byteLength) {
              count.nonempty++;
              const result = new Uint8Array(frame.data);
              if (original.length !== result.length || original.some((byte, index) => byte !== result[index])) count.changed++;
            }
            originals.delete(frame.timestamp);
          }
          controller.enqueue(frame);
        } });
        void output.readable.pipeTo(data.writableStream).catch(() => undefined);
        super.postMessage({ ...message, data: { ...data, readableStream: input, writableStream: output.writable } }, [input, output.writable]);
        return;
      }
    }
    if (Array.isArray(options)) super.postMessage(message, options); else super.postMessage(message, options);
  }
  override terminate(): void { this.dead = true; this.fence = false; super.terminate(); }
}

export class BrowserMedia {
  readonly generation = crypto.randomUUID();
  readonly room: Room;
  private readonly worker: ObservedWorker;
  private readonly sources: MediaStreamTrack[] = [];
  private readonly tracks = new Map<string, { track: RemoteTrack; identity: string }>();
  private audio?: AudioContext;
  private animation?: ReturnType<typeof setInterval>;
  private dead = false;
  private readonly errors: string[] = [];
  private publications = 0;
  private scriptTransform = false;
  constructor(private readonly local: string, private readonly workerUrl: URL, expected: ReadonlyMap<string, CryptoKey>, supplied: ReadonlyMap<string, CryptoKey>, readonly diagnostic = false, private readonly invalidate: () => void = () => undefined) {
    this.worker = new ObservedWorker(workerUrl, local, expected, diagnostic, (reason) => this.fail(reason));
    this.room = new Room({ encryption: { keyProvider: new Provider(supplied), worker: this.worker } });
    this.room.on(RoomEvent.TrackPublished, (pub, peer) => { void this.subscribe(pub, peer).catch(() => this.fail("Subscription gate failed.")); });
    this.room.on(RoomEvent.TrackSubscribed, (track, pub, peer) => {
      if (this.dead) { track.mediaStreamTrack.stop(); return; }
      this.worker.mark("attached", peer.identity, pub.trackSid);
      this.tracks.set(pub.trackSid, { track, identity: peer.identity });
      if (track.receiver && Reflect.get(track.receiver, "transform")) this.scriptTransform = true;
      const element = track.attach();
      if (element instanceof HTMLVideoElement) { element.muted = true; element.playsInline = true; }
      document.body.append(element);
    });
    this.room.on(RoomEvent.TrackUnsubscribed, (track, pub) => { track.detach().forEach((element) => element.remove()); this.tracks.delete(pub.trackSid); });
    this.room.on(RoomEvent.Reconnecting, () => this.fail("Fresh epoch required after reconnect."));
  }
  private async subscribe(publication: RemoteTrackPublication, peer: RemoteParticipant): Promise<void> {
    if (this.dead) return;
    if (publication.trackInfo?.encryption !== Encryption_Type.GCM || !["audio/opus", "video/vp8"].includes(publication.mimeType?.toLowerCase() ?? "")) { this.fail("Unexpected encrypted publication."); return; }
    this.worker.mark("publication", peer.identity, publication.trackSid);
    await this.worker.waitUntilEnabled(peer.identity);
    if (this.dead) return;
    this.worker.mark("subscribe", peer.identity, publication.trackSid);
    publication.setSubscribed(true);
  }
  async connect(url: string, token: string): Promise<void> {
    await this.room.setE2EEEnabled(true);
    await this.room.connect(url, token, { autoSubscribe: false });
    await this.worker.waitUntilEnabled(this.local);
    if (!this.worker.fence || this.dead) throw new Error("Fresh native fence unavailable.");
    // Publications may predate connection in the explicitly diagnostic receiver cases.
    for (const peer of this.room.remoteParticipants.values()) for (const pub of peer.trackPublications.values()) await this.subscribe(pub, peer);
  }
  ready(): boolean { return !this.diagnostic && !this.dead && this.worker.fence; }
  mark(kind: string): void { this.worker.mark(kind, this.local); }
  async publish(kind: MediaKind): Promise<void> {
    if (!this.ready()) throw new Error("Normal native media fence required.");
    let source: MediaStreamTrack;
    if (kind === "audio") {
      this.audio = new AudioContext(); await this.audio.resume();
      const oscillator = this.audio.createOscillator(), destination = this.audio.createMediaStreamDestination();
      oscillator.frequency.value = 440; oscillator.connect(destination); oscillator.start();
      source = destination.stream.getAudioTracks()[0];
    } else {
      const canvas = document.createElement("canvas"); canvas.width = 160; canvas.height = 90;
      const drawing = canvas.getContext("2d"); if (!drawing) throw new Error("Canvas missing.");
      let index = 0;
      const draw = () => { drawing.fillStyle = "#14364b"; drawing.fillRect(0, 0, 160, 90); drawing.fillStyle = "#ffb54a"; drawing.fillRect((index++ * 7) % 140, 10, 20, 70); };
      draw(); this.animation = setInterval(draw, 1000 / 15); source = canvas.captureStream(15).getVideoTracks()[0];
    }
    this.sources.push(source); this.worker.mark("publish", this.local);
    const publication = await this.room.localParticipant.publishTrack(source, kind === "audio" ? { source: Track.Source.Microphone, dtx: false, red: false } : { source: Track.Source.Camera, videoCodec: "vp8", simulcast: false });
    if (this.dead) { source.stop(); return; }
    this.publications++;
    const sender: unknown = publication.track ? Reflect.get(publication.track, "sender") : undefined;
    if (!(sender instanceof RTCRtpSender)) throw new Error("Native sender missing.");
    this.scriptTransform ||= !!Reflect.get(sender, "transform");
  }
  private fail(reason: string): void {
    if (this.dead) return;
    this.errors.push(reason); this.stop();
  }
  stop(): void {
    if (this.dead) return;
    this.dead = true; this.invalidate();
    this.sources.forEach((source) => source.stop()); clearInterval(this.animation);
    this.tracks.forEach(({ track }) => { track.mediaStreamTrack.stop(); track.detach().forEach((element) => element.remove()); });
    this.worker.terminate(); void this.audio?.close(); void this.room.disconnect();
  }
  async close(): Promise<void> { this.stop(); await this.room.disconnect(); }
  async snapshot(): Promise<MediaSnapshot> {
    const streams: StreamCount[] = [];
    for (const { track, identity } of this.tracks.values()) {
      const value: StreamCount = { identity, kind: track.kind, bytes: 0, samples: 0, energy: 0, frames: 0, width: 0, codec: "" };
      const report = await track.getRTCStatsReport();
      report?.forEach((entry) => {
        if (entry.type !== "inbound-rtp") return;
        value.bytes = entry.bytesReceived ?? 0; value.samples = entry.totalSamplesReceived ?? 0; value.energy = entry.totalAudioEnergy ?? 0; value.frames = entry.framesDecoded ?? 0; value.width = entry.frameWidth ?? 0;
        value.codec = report.get(entry.codecId)?.mimeType ?? "";
      });
      streams.push(value);
    }
    return { generation: this.generation, diagnostic: this.diagnostic, workerUrl: this.workerUrl.href, fence: this.worker.fence, stopped: this.dead, errors: [...this.errors], trace: [...this.worker.trace], frames: this.worker.frames.map((entry) => ({ ...entry })), streams, publications: this.publications, scriptTransform: this.scriptTransform, encodedStreams: typeof Reflect.get(RTCRtpSender.prototype, "createEncodedStreams") === "function" && this.worker.frames.length > 0 };
  }
}
