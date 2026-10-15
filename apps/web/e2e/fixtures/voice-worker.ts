import { BaseKeyProvider, Room, RoomEvent, Track, createKeyMaterialFromBuffer, type RemoteTrack } from "livekit-client";
import { StrictVoiceWorker } from "../../src/lib/voice/strict-worker";

type Scenario = "normal" | "unknown-identity" | "missing-key" | "wrong-key" | "tamper" | "plaintext-signaling";
type Metrics = { encoded: number; decoded: number; changed: number; errors: string[]; framesAtFailure: number | null; energy: number; connected: boolean };
type Frame = RTCEncodedAudioFrame | RTCEncodedVideoFrame;
function object(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null; }

class Provider extends BaseKeyProvider {
  constructor() { super({ sharedKey: false, ratchetWindowSize: 0, failureTolerance: 0 }); }
  async install(identity: string, bytes: ArrayBuffer): Promise<void> {
    this.onSetEncryptionKey(await createKeyMaterialFromBuffer(bytes), identity, 0);
  }
}

const metrics: Metrics = { encoded: 0, decoded: 0, changed: 0, errors: [], framesAtFailure: null, energy: 0, connected: false };
let sender: Room | undefined;
let receiver: Room | undefined;
let source: MediaStreamTrack | undefined;
let remote: RemoteTrack | undefined;
let sendingWorker: StrictVoiceWorker | undefined;
let receivingWorker: StrictVoiceWorker | undefined;
let context: AudioContext | undefined;

/** Test-only observation/corruption around real native transform streams; no replacement cipher. */
class ObservedWorker extends StrictVoiceWorker {
  private originals = new Map<number, Uint8Array>();
  override postMessage(message: unknown, transfer: Transferable[]): void;
  override postMessage(message: unknown, options?: StructuredSerializeOptions): void;
  override postMessage(message: unknown, transferOrOptions?: Transferable[] | StructuredSerializeOptions): void {
    if (object(message) && (message.kind === "encode" || message.kind === "decode") && object(message.data)) {
      const data = message.data;
      if (data.readableStream instanceof ReadableStream && data.writableStream instanceof WritableStream) {
        const direction = message.kind;
        const observe = new TransformStream<Frame, Frame>({ transform: (frame, controller) => {
          if (direction === "encode") {
            this.originals.set(frame.timestamp, new Uint8Array(frame.data.slice(0)));
            if (this.originals.size > 100) this.originals.delete(this.originals.keys().next().value ?? 0);
          } else if (currentScenario === "tamper" && frame.data.byteLength > 8) {
            const changed = new Uint8Array(frame.data.slice(0));
            changed[5] ^= 1;
            frame.data = changed.buffer;
          }
          controller.enqueue(frame);
        } });
        const output = new TransformStream<Frame, Frame>({ transform: (frame, controller) => {
          if (direction === "encode") {
            metrics.encoded++;
            const original = this.originals.get(frame.timestamp);
            if (original && (original.length !== frame.data.byteLength || original.some((byte, index) => byte !== new Uint8Array(frame.data)[index]))) metrics.changed++;
            this.originals.delete(frame.timestamp);
          } else metrics.decoded++;
          controller.enqueue(frame);
        } });
        const input = data.readableStream.pipeThrough(observe);
        void output.readable.pipeTo(data.writableStream).catch(() => undefined);
        super.postMessage({ ...message, data: { ...data, readableStream: input, writableStream: output.writable } }, [input, output.writable]);
        return;
      }
    }
    if (Array.isArray(transferOrOptions)) super.postMessage(message, transferOrOptions);
    else super.postMessage(message, transferOrOptions);
  }
}

let currentScenario: Scenario = "normal";
async function start(input: { url: string; senderToken: string; receiverToken: string; scenario: Scenario }): Promise<void> {
  currentScenario = input.scenario;
  const failure = (reason: string) => {
    if (metrics.framesAtFailure === null) metrics.framesAtFailure = metrics.decoded;
    metrics.errors.push(reason);
    // Synchronously stop the source; terminate worker pipes before asynchronous SFU teardown.
    source?.stop();
    remote?.mediaStreamTrack.stop();
    void sender?.disconnect();
    void receiver?.disconnect();
  };
  const identities = ["sender", "receiver"];
  sendingWorker = new ObservedWorker(new URL("/voice-proof/worker.mjs", location.href), identities, failure);
  receivingWorker = new ObservedWorker(new URL("/voice-proof/worker.mjs", location.href), identities, failure);
  const senderKeys = new Provider(), receiverKeys = new Provider();
  const bytes = crypto.getRandomValues(new Uint8Array(32)).buffer;
  await senderKeys.install("sender", bytes);
  if (input.scenario !== "missing-key") await receiverKeys.install("sender", input.scenario === "wrong-key" ? crypto.getRandomValues(new Uint8Array(32)).buffer : bytes);
  // Each local identity has native state even when the receiving participant publishes nothing.
  await receiverKeys.install("receiver", crypto.getRandomValues(new Uint8Array(32)).buffer);
  sender = new Room(input.scenario === "plaintext-signaling" ? {} : { encryption: { keyProvider: senderKeys, worker: sendingWorker } });
  receiver = new Room({ encryption: { keyProvider: receiverKeys, worker: receivingWorker } });
  receiver.on(RoomEvent.TrackPublished, (publication, participant) => {
    if (participant.identity !== "sender") { failure("Unexpected participant."); return; }
    void receivingWorker?.waitUntilEnabled(participant.identity).then(() => {
      publication.setSubscribed(true);
    }).catch(() => undefined);
  });
  receiver.on(RoomEvent.TrackSubscribed, (track) => {
    if (track.kind === Track.Kind.Audio) {
      remote = track;
      document.body.append(track.attach());
    }
  });
  if (input.scenario !== "plaintext-signaling") await sender.setE2EEEnabled(true);
  await receiver.setE2EEEnabled(true);
  await receiver.connect(input.url, input.receiverToken, { autoSubscribe: false });
  await receivingWorker.waitUntilEnabled("receiver");
  await sender.connect(input.url, input.senderToken, { autoSubscribe: false });
  if (input.scenario !== "plaintext-signaling") await sendingWorker.waitUntilEnabled("sender");
  context = new AudioContext();
  await context.resume();
  const oscillator = context.createOscillator();
  oscillator.frequency.value = 440;
  const destination = context.createMediaStreamDestination();
  oscillator.connect(destination);
  oscillator.start();
  source = destination.stream.getAudioTracks()[0];
  await sender.localParticipant.publishTrack(source, { source: Track.Source.Microphone, dtx: false, red: false });
  metrics.connected = true;
}

async function snapshot(): Promise<Metrics> {
  const report = await remote?.getRTCStatsReport();
  report?.forEach((entry) => { if (entry.type === "inbound-rtp" && typeof entry.totalAudioEnergy === "number") metrics.energy = entry.totalAudioEnergy; });
  return { ...metrics, errors: [...metrics.errors] };
}

function downgrade(): void {
  const participant = receiver?.remoteParticipants.get("sender");
  const publication = participant ? [...participant.trackPublications.values()][0] : undefined;
  if (!receiver || !participant || !publication?.trackInfo) throw new Error("No actual publication to manipulate.");
  // Same metadata and native event handler used when signaling announces an unencrypted track.
  Reflect.set(publication.trackInfo, "encryption", 0);
  receiver.emit(RoomEvent.TrackPublished, publication, participant);
}

function unknown(): void {
  receivingWorker?.postMessage({ kind: "enable", data: { participantIdentity: "unadmitted", enabled: true } });
}

async function unknownState(): Promise<string> {
  let reason = "";
  const worker = new StrictVoiceWorker(new URL("/voice-proof/worker.mjs", location.href), ["sender"], (value) => { reason = value; });
  const input = new TransformStream<Frame, Frame>(), output = new TransformStream<Frame, Frame>();
  worker.postMessage({ kind: "encode", data: { participantIdentity: "sender", trackId: "unknown-state", readableStream: input.readable, writableStream: output.writable, hasPacketTrailer: false } }, [input.readable, output.writable]);
  return reason;
}

declare global {
  interface Window {
    voiceProof: { start: typeof start; snapshot: typeof snapshot; downgrade: typeof downgrade; unknown: typeof unknown; unknownState: typeof unknownState };
  }
}
window.voiceProof = { start, snapshot, downgrade, unknown, unknownState };
