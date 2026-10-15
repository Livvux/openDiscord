import { BaseKeyProvider, Room, RoomEvent, Track, createKeyMaterialFromBuffer, type RemoteTrack } from "livekit-client";
import { StrictVoiceWorker } from "../../src/lib/voice/strict-worker";

export type Scenario = "normal" | "unknown-identity" | "missing-key" | "wrong-key" | "tamper" | "plaintext-signaling";
export type Media = "audio" | "video";
export type Metrics = { framesDecoded: number; videoWidth: number; codec: string; subscriptions: number; unsubscriptions: number; reconnecting: number; reconnected: number; workerUrl: string; encoded: number; decoded: number; changed: number; nonemptyEncoded: number; unmatched: number; encodeSetups: number; decodeSetups: number; scriptTransform: boolean; errors: string[]; framesAtFailure: number | null; energy: number; connected: boolean };
type Frame = RTCEncodedAudioFrame | RTCEncodedVideoFrame;
function object(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null; }

class Provider extends BaseKeyProvider {
  constructor() { super({ sharedKey: false, ratchetWindowSize: 0, failureTolerance: 0 }); }
  async install(identity: string, bytes: ArrayBuffer): Promise<void> {
    this.onSetEncryptionKey(await createKeyMaterialFromBuffer(bytes), identity, 0);
  }
}

let workerUrl = new URL("/voice-proof/worker.mjs", location.href);
export function configureWorkerUrl(url: URL): void { workerUrl = url; metrics.workerUrl = url.href; }

const metrics: Metrics = { framesDecoded: 0, videoWidth: 0, codec: "", subscriptions: 0, unsubscriptions: 0, reconnecting: 0, reconnected: 0, workerUrl: workerUrl.href, encoded: 0, decoded: 0, changed: 0, nonemptyEncoded: 0, unmatched: 0, encodeSetups: 0, decodeSetups: 0, scriptTransform: false, errors: [], framesAtFailure: null, energy: 0, connected: false };
let sender: Room | undefined;
let receiver: Room | undefined;
let source: MediaStreamTrack | undefined;
let remote: RemoteTrack | undefined;
let sendingWorker: StrictVoiceWorker | undefined;
let receivingWorker: StrictVoiceWorker | undefined;
let context: AudioContext | undefined;
let animation: ReturnType<typeof setInterval> | undefined;

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
        if (direction === "encode") metrics.encodeSetups++; else metrics.decodeSetups++;
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
            if (!original) metrics.unmatched++;
            else if (original.byteLength > 0) {
              metrics.nonemptyEncoded++;
              if (original.length !== frame.data.byteLength || original.some((byte, index) => byte !== new Uint8Array(frame.data)[index])) metrics.changed++;
            }
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
async function start(input: { url: string; senderToken: string; receiverToken: string; scenario: Scenario; media?: Media }): Promise<void> {
  currentScenario = input.scenario;
  const failure = (reason: string) => {
    if (metrics.framesAtFailure === null) metrics.framesAtFailure = metrics.decoded;
    metrics.errors.push(reason);
    // Synchronously stop the source; terminate worker pipes before asynchronous SFU teardown.
    source?.stop();
    clearInterval(animation);
    remote?.mediaStreamTrack.stop();
    void sender?.disconnect();
    void receiver?.disconnect();
  };
  const identities = ["sender", "receiver"];
  sendingWorker = new ObservedWorker(workerUrl, identities, failure);
  receivingWorker = new ObservedWorker(workerUrl, identities, failure);
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
    remote = track;
    metrics.subscriptions++;
    const element = track.attach();
    if (element instanceof HTMLVideoElement) { element.muted = true; element.playsInline = true; }
    document.body.append(element);
  });
  receiver.on(RoomEvent.TrackUnsubscribed, (track) => {
    metrics.unsubscriptions++;
    track.detach().forEach((element) => element.remove());
    if (remote === track) remote = undefined;
  });
  for (const room of [sender, receiver]) {
    room.on(RoomEvent.Reconnecting, () => { metrics.reconnecting++; });
    room.on(RoomEvent.Reconnected, () => { metrics.reconnected++; });
  }
  if (input.scenario !== "plaintext-signaling") await sender.setE2EEEnabled(true);
  await receiver.setE2EEEnabled(true);
  await receiver.connect(input.url, input.receiverToken, { autoSubscribe: false });
  await receivingWorker.waitUntilEnabled("receiver");
  await sender.connect(input.url, input.senderToken, { autoSubscribe: false });
  if (input.scenario !== "plaintext-signaling") await sendingWorker.waitUntilEnabled("sender");
  if (input.media === "video") {
    const canvas = document.createElement("canvas");
    canvas.width = 160; canvas.height = 90;
    const drawing = canvas.getContext("2d");
    if (!drawing) throw new Error("Canvas capture unavailable.");
    let frame = 0;
    const draw = () => {
      drawing.fillStyle = "#14364b"; drawing.fillRect(0, 0, 160, 90);
      drawing.fillStyle = "#ffb54a"; drawing.fillRect((frame++ * 7) % 140, 10, 20, 70);
    };
    draw();
    animation = setInterval(draw, 1000 / 15);
    source = canvas.captureStream(15).getVideoTracks()[0];
  } else {
    context = new AudioContext();
    await context.resume();
    const oscillator = context.createOscillator();
    oscillator.frequency.value = 440;
    const destination = context.createMediaStreamDestination();
    oscillator.connect(destination);
    oscillator.start();
    source = destination.stream.getAudioTracks()[0];
  }
  const publication = await sender.localParticipant.publishTrack(source, input.media === "video"
    ? { source: Track.Source.Camera, videoCodec: "vp8", simulcast: false }
    : { source: Track.Source.Microphone, dtx: false, red: false });
  const nativeSender: unknown = publication.track ? Reflect.get(publication.track, "sender") : undefined;
  metrics.scriptTransform = nativeSender instanceof RTCRtpSender && !!Reflect.get(nativeSender, "transform");
  metrics.connected = true;
}

async function snapshot(): Promise<Metrics> {
  const report = await remote?.getRTCStatsReport();
  if (remote?.receiver && Reflect.get(remote.receiver, "transform")) metrics.scriptTransform = true;
  report?.forEach((entry) => {
    if (entry.type !== "inbound-rtp") return;
    if (typeof entry.totalAudioEnergy === "number") metrics.energy = entry.totalAudioEnergy;
    if (typeof entry.framesDecoded === "number") metrics.framesDecoded = entry.framesDecoded;
    if (typeof entry.frameWidth === "number") metrics.videoWidth = entry.frameWidth;
    const codec = report.get(entry.codecId);
    if (typeof codec?.mimeType === "string") metrics.codec = codec.mimeType;
  });
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
  const worker = new StrictVoiceWorker(workerUrl, ["sender"], (value) => { reason = value; });
  const input = new TransformStream<Frame, Frame>(), output = new TransformStream<Frame, Frame>();
  worker.postMessage({ kind: "encode", data: { participantIdentity: "sender", trackId: "unknown-state", readableStream: input.readable, writableStream: output.writable, hasPacketTrailer: false } }, [input.readable, output.writable]);
  return reason;
}

async function until(condition: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (!condition()) {
    if (metrics.errors.length) throw new Error(metrics.errors.join("; "));
    if (Date.now() >= deadline) throw new Error(`${label} timed out.`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function resubscribe(): Promise<void> {
  const participant = receiver?.remoteParticipants.get("sender");
  const publication = participant ? [...participant.trackPublications.values()][0] : undefined;
  if (!publication || !receivingWorker) throw new Error("No live subscription.");
  const unsubscribed = metrics.unsubscriptions, subscribed = metrics.subscriptions;
  publication.setSubscribed(false);
  await until(() => metrics.unsubscriptions > unsubscribed, "Unsubscribe");
  await receivingWorker.waitUntilEnabled("sender");
  publication.setSubscribed(true);
  await until(() => metrics.subscriptions > subscribed, "Resubscribe");
}

async function reconnect(side: "sender" | "receiver"): Promise<void> {
  const room = side === "sender" ? sender : receiver;
  if (!room) throw new Error("Room missing.");
  const reconnecting = metrics.reconnecting, reconnected = metrics.reconnected;
  // Installed SDK's explicit test API exercises its native full disconnect/rejoin path.
  await room.simulateScenario("full-reconnect");
  await until(() => metrics.reconnecting > reconnecting && metrics.reconnected > reconnected, "Full reconnect");
}

declare global {
  interface Window {
    voiceProof: { start: typeof start; snapshot: typeof snapshot; downgrade: typeof downgrade; unknown: typeof unknown; unknownState: typeof unknownState; resubscribe: typeof resubscribe; reconnect: typeof reconnect };
  }
}
window.voiceProof = { start, snapshot, downgrade, unknown, unknownState, resubscribe, reconnect };
