import type { CallSession } from "../../src/lib/voice/call-session";
import { assertVoiceBrowserOrigin, createVoiceGrantObserver, strings } from "./voice-media-observer";

function object(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null; }
/** Transparent observations around genuine browser workers; no keys retained or ACK injected. */
export async function open(channelId: string) {
  assertVoiceBrowserOrigin(location.origin);
  // Only the exact disposable CI fixture may load this public verifier bundle.
  const { TokenVerifier } = await import("livekit-server-sdk");
  const verifier = new TokenVerifier("devkey", "secret");
  const NativeFetch = globalThis.fetch;
  const grants = createVoiceGrantObserver(NativeFetch.bind(globalThis), location.origin, async (token, binding) => {
    const claims = await verifier.verify(token, 0);
    // The SDK's declared TrackSource[] models mint input; actual JWT has strings.
    const sources: unknown = claims.video?.canPublishSources ?? [];
    if (claims.sub !== binding.identity || claims.video?.room !== binding.room || !strings(sources) || JSON.stringify([...sources].sort()) !== JSON.stringify([...binding.sources].sort()) || typeof claims.exp !== "number" || !Number.isFinite(claims.exp)) throw new Error("Actual signed media binding mismatch.");
    return { sources, publish: claims.video?.canPublish === true, subscribe: claims.video?.canSubscribe === true, data: claims.video?.canPublishData === true, expiresAtMs: claims.exp * 1000 };
  });
  // Install before the production HTTP client/Owner/media runtime is imported.
  globalThis.fetch = grants.fetch;
  const NativeWorker = globalThis.Worker, NativeConnection = globalThis.RTCPeerConnection;
  const workers: { submitted: Set<string>; ownAck: Set<string>; ackSizes: Map<string, number>; terminated: boolean; count: number }[] = [];
  const connections: RTCPeerConnection[] = [];
  let captureCalls = 0, sourceCalls = 0, valid = true;
  const contexts: AudioContext[] = [];
  const animations: ReturnType<typeof setInterval>[] = [];
  const sources: MediaStreamTrack[] = [];
  globalThis.Worker = class extends NativeWorker {
    private readonly observation = { submitted: new Set<string>(), ownAck: new Set<string>(), ackSizes: new Map<string, number>(), terminated: false, count: 0 };
    constructor(url: string | URL, options?: WorkerOptions) {
      super(url, options); workers.push(this.observation);
      this.addEventListener("message", (event: MessageEvent<unknown>) => {
        if (!object(event.data) || event.data.kind !== "enable" || !object(event.data.data)) return;
        const { participantIdentity, enabled } = event.data.data;
        if (typeof participantIdentity === "string" && enabled === true) {
          this.observation.ownAck.add(participantIdentity);
          if (!this.observation.ackSizes.has(participantIdentity)) this.observation.ackSizes.set(participantIdentity, this.observation.submitted.size);
        }
      });
    }
    override postMessage(message: unknown, transfer: Transferable[]): void;
    override postMessage(message: unknown, options?: StructuredSerializeOptions): void;
    override postMessage(message: unknown, transfer?: Transferable[] | StructuredSerializeOptions): void {
      if (object(message) && message.kind === "setKey" && object(message.data) && typeof message.data.participantIdentity === "string" && message.data.keyIndex === 0) {
        this.observation.submitted.add(message.data.participantIdentity); this.observation.count++;
      }
      if (Array.isArray(transfer)) super.postMessage(message, transfer); else super.postMessage(message, transfer);
    }
    override terminate() { this.observation.terminated = true; super.terminate(); }
  };
  globalThis.RTCPeerConnection = class extends NativeConnection {
    constructor(config?: RTCConfiguration) { super(config); connections.push(this); }
  };
  const originalCapture = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  const originalDisplay = navigator.mediaDevices.getDisplayMedia.bind(navigator.mediaDevices);
  // Controlled non-silent/moving devices, real native tracks and real RTP/SFU/cryptors.
  navigator.mediaDevices.getUserMedia = async constraints => {
    captureCalls++;
    const tracks: MediaStreamTrack[] = [];
    if (constraints?.audio) {
      const context = new AudioContext(); contexts.push(context); await context.resume();
      const oscillator = context.createOscillator(), destination = context.createMediaStreamDestination();
      oscillator.frequency.value = 440; oscillator.connect(destination); oscillator.start(); tracks.push(...destination.stream.getAudioTracks());
    }
    if (constraints?.video) {
      const canvas = document.createElement("canvas"); canvas.width = 160; canvas.height = 90;
      const drawing = canvas.getContext("2d"); if (!drawing) throw new Error("Canvas unavailable.");
      let frame = 0;
      const draw = () => { drawing.fillStyle = "#14364b"; drawing.fillRect(0, 0, 160, 90); drawing.fillStyle = "#ffb54a"; drawing.fillRect((frame++ * 7) % 140, 10, 20, 70); };
      draw(); animations.push(setInterval(draw, 1000 / 15)); tracks.push(...canvas.captureStream(15).getVideoTracks());
    }
    sources.push(...tracks); return new MediaStream(tracks);
  };
  navigator.mediaDevices.getDisplayMedia = async () => { captureCalls++; throw new Error("Screen audio/OS capture is outside this gate."); };
  const sessionResponse = await fetch("/api/auth/get-session", { cache: "no-store" });
  if (!sessionResponse.ok) throw new Error("Actual browser session unavailable.");
  const session: { user: { id: string }; session: { id: string } } = await sessionResponse.json();
  const anchor = { id: crypto.randomUUID(), secret: Array.from(crypto.getRandomValues(new Uint8Array(32)), byte => byte.toString(16).padStart(2, "0")).join(""), name: "Explicit disposable CI media enrollment" };
  const registered = await fetch("/api/dm", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "register", input: anchor }) });
  if (!registered.ok) throw new Error("Actual anchor registration failed.");
  localStorage.setItem(`opendiscord.dm.device:${session.user.id}`, JSON.stringify({ id: anchor.id, secret: anchor.secret, storeKey: btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))) }));
  const { CallSession } = await import("../../src/lib/voice/call-session");
  const call: CallSession = await CallSession.create({ accountId: session.user.id, sessionId: session.session.id, channelId, consent: true, assertSessionCurrent() { if (!valid) throw new Error("Disposable browser session retired."); } });
  // Presentation belongs to this harness call, separate from the page's idle Voice provider.
  const audio = document.createElement("div"); audio.hidden = true; document.body.append(audio);
  const detachAudio = call.mountAudio(audio);
  return {
    grants: grants.snapshot,
    settleGrants: grants.settle,
    view: () => call.getSnapshot(),
    request: (memberId: string) => call.requestVerification(memberId),
    step: (handle: string, step: "accept" | "start" | "accept-sas" | "confirm") => call.verificationStep(handle, step),
    admit: (memberId: string) => call.admit(memberId),
    confirm: () => call.confirmFullRoster(),
    microphone: async (enabled: boolean) => { sourceCalls++; await call.setMicrophoneEnabled(enabled); },
    camera: async (enabled: boolean) => { sourceCalls++; await call.setCameraEnabled(enabled); },
    startAudio: () => call.startAudio(),
    async stats() {
      let audioEnergy = 0, videoFrames = 0, width = 0; const codecs = new Set<string>();
      for (const connection of connections) {
        if (connection.connectionState === "closed") continue;
        const report = await connection.getStats();
        report.forEach(entry => {
          if (entry.type !== "inbound-rtp") return;
          if (typeof entry.totalAudioEnergy === "number") audioEnergy += entry.totalAudioEnergy;
          if (typeof entry.framesDecoded === "number") videoFrames += entry.framesDecoded;
          if (typeof entry.frameWidth === "number") width = Math.max(width, entry.frameWidth);
          const codec = report.get(entry.codecId); if (typeof codec?.mimeType === "string") codecs.add(codec.mimeType);
        });
      }
      const view = call.getSnapshot(), current = workers.at(-1);
      return { state: view.state, error: view.error, audioBlocked: view.media.audioBlocked, audioElements: audio.querySelectorAll("audio").length, captureCalls, sourceCalls, audioEnergy, videoFrames, width, codecs: [...codecs], workerCount: workers.length, submitted: current?.submitted.size ?? 0, ownAck: current?.ownAck.has(`v1:${view.selfMemberId}`) ?? false, keysBeforeOwnAck: current?.ackSizes.get(`v1:${view.selfMemberId}`) ?? 0, allTerminated: workers.every(worker => worker.terminated), liveSources: sources.filter(track => track.readyState === "live").length, localSenders: connections.flatMap(connection => connection.getSenders()).filter(sender => !!sender.track && sender.track.readyState === "live").length };
    },
    rekey: () => call.confirmFullRoster(),
    async close() {
      detachAudio(); audio.remove();
      await grants.settle();
      valid = false; await call.close("ci-harness-complete");
      sources.forEach(track => track.stop()); animations.forEach(clearInterval); await Promise.all(contexts.map(context => context.close()));
      globalThis.Worker = NativeWorker; globalThis.RTCPeerConnection = NativeConnection;
      globalThis.fetch = NativeFetch;
      navigator.mediaDevices.getUserMedia = originalCapture; navigator.mediaDevices.getDisplayMedia = originalDisplay;
    },
  };
}
export type MediaHarness = Awaited<ReturnType<typeof open>>;
