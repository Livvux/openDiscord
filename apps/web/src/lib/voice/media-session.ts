import { BaseKeyProvider, Encryption_Type, Room, RoomEvent, Track, type LocalTrack, type RemoteParticipant, type RemoteTrack, type RemoteTrackPublication } from "livekit-client";
import { StrictVoiceWorker } from "./strict-worker";
import { sameVoiceParty, validateVoiceOwnerControl, VOICE_CONTROL_EVENT, type VoiceControlParty, type VoiceOwnerControl } from "./owner-control";
import type { VoiceSnapshot } from "./contracts";
import type { createVoiceHttpClient } from "./http-client";

type Token = Awaited<ReturnType<ReturnType<typeof createVoiceHttpClient>["token"]>>;
export type InstalledVoiceMediaContext = Readonly<{
  snapshot: VoiceSnapshot; epochId: string; proposalSequence: number; reference: string;
  audience: readonly VoiceControlParty[]; self: VoiceControlParty; deadline: number;
}>;
export type VoiceMediaBridge = Readonly<{
  current(): void;
  send(control: VoiceOwnerControl): Promise<void>;
  token(): Promise<{ grant: Token; deadline: number }>;
  fatal(reason: string): void;
  presentation?(view: VoiceMediaView): void;
}>;
type Material = { key: CryptoKey; keyId: string; reference: string; wire: string };
export type VoiceSource = "microphone" | "camera" | "screen_share";
type Source = VoiceSource;
export type VoiceMediaTile = Readonly<{ id: string; memberId: string; source: Source; kind: "audio" | "video"; isLocal: boolean }>;
export type VoiceMediaView = Readonly<{ mediaState: "none" | "keying" | "ready" | "ended"; sources: readonly Source[]; microphone: boolean; camera: boolean; screenShare: boolean; audioBlocked: boolean; tiles: readonly VoiceMediaTile[] }>;
export const emptyVoiceMedia = (mediaState: VoiceMediaView["mediaState"] = "none"): VoiceMediaView => Object.freeze({ mediaState, sources: Object.freeze([]), microphone: false, camera: false, screenShare: false, audioBlocked: false, tiles: Object.freeze([]) });

class ParticipantKeys extends BaseKeyProvider {
  constructor(keys: ReadonlyMap<string, CryptoKey>) {
    super({ sharedKey: false, ratchetWindowSize: 0, failureTolerance: 0 });
    keys.forEach((key, identity) => this.onSetEncryptionKey(key, identity, 0));
  }
}

/** Browser-only, installed-epoch media consumer. The native Owner remains in CallSession. */
export class MediaSession {
  private dead = false;
  private readonly materials = new Map<string, Material>();
  private readonly transactions = new Map<string, string>();
  private readonly prepared = new Set<string>();
  private readonly ready = new Set<string>();
  private readonly remotes = new Set<RemoteTrack>();
  private readonly subscriptions = new Set<RemoteTrackPublication>();
  private readonly captures = new Set<MediaStreamTrack>();
  private readonly sourceFlights = new Set<Source>();
  private readonly timer: ReturnType<typeof setTimeout>;
  private room?: Room;
  private worker?: StrictVoiceWorker;
  private connecting = false;
  private localEnabled = false;
  private readinessSent = false;
  private keyingComplete = false;
  private connected = false;
  private tokenDeadline = Infinity;
  private readonly tiles = new Map<string, { view: VoiceMediaTile; track: RemoteTrack | LocalTrack }>();
  private readonly attachments = new Map<HTMLMediaElement, RemoteTrack | LocalTrack>();
  private readonly audioRoots = new Set<HTMLElement>();
  private source(source: Track.Source): Source | undefined { return source === Track.Source.Microphone ? "microphone" : source === Track.Source.Camera ? "camera" : source === Track.Source.ScreenShare ? "screen_share" : undefined; }
  private present(): void {
    if (this.dead) return;
    const local = this.room?.localParticipant;
    this.bridge.presentation?.(Object.freeze({ mediaState: this.keyingComplete ? "ready" : "keying", sources: Object.freeze([...this.sources]), microphone: local?.isMicrophoneEnabled === true, camera: local?.isCameraEnabled === true, screenShare: local?.isScreenShareEnabled === true, audioBlocked: this.room?.canPlaybackAudio === false, tiles: Object.freeze([...this.tiles.values()].map(tile => tile.view)) }));
  }
  private detach(element: HTMLMediaElement): void { this.attachments.get(element)?.detach(element); this.attachments.delete(element); }
  private removeTrack(track: RemoteTrack | LocalTrack): void {
    for (const [element, attached] of this.attachments) if (attached === track) { this.detach(element); if (element instanceof HTMLAudioElement) element.remove(); }
    for (const [id, tile] of this.tiles) if (tile.track === track) this.tiles.delete(id);
  }
  private localTracks(): void {
    if (this.dead || !this.room) return;
    const publications = [...this.room.localParticipant.trackPublications.values()];
    for (const tile of this.tiles.values()) if (tile.view.isLocal && !publications.some(publication => publication.track === tile.track && !publication.isMuted)) this.removeTrack(tile.track);
    for (const publication of publications) {
      const source = this.source(publication.source), track = publication.track;
      if (source && track && !publication.isMuted && publication.kind === Track.Kind.Video && ![...this.tiles.values()].some(tile => tile.track === track)) {
        const id = crypto.randomUUID();
        this.tiles.set(id, { track, view: Object.freeze({ id, memberId: this.context.self.memberId, source, kind: "video", isLocal: true }) });
      }
    }
    this.present();
  }
  private remoteTrack(track: RemoteTrack, publication: RemoteTrackPublication, participant: RemoteParticipant): void {
    this.current(); this.validate(publication, participant);
    if (!this.subscriptions.has(publication)) throw new Error("Unrequested media track.");
    this.remotes.add(track);
    if (publication.isMuted) this.removeTrack(track);
    else if (![...this.tiles.values()].some(tile => tile.track === track)) {
      const member = this.context.audience.find(party => party.participantIdentity === participant.identity)!;
      const id = crypto.randomUUID(), source = this.source(publication.source)!;
      this.tiles.set(id, { track, view: Object.freeze({ id, memberId: member.memberId, source, kind: publication.kind === Track.Kind.Audio ? "audio" : "video", isLocal: false }) });
    }
    this.attachAudio(); this.present();
  }
  private attachAudio(): void {
    if (this.dead) return;
    const container = this.audioRoots.values().next().value;
    if (!container) return;
    for (const tile of this.tiles.values()) {
      if (tile.view.kind !== "audio" || tile.view.isLocal || [...this.attachments.values()].includes(tile.track)) continue;
      const element = document.createElement("audio");
      tile.track.attach(element); this.attachments.set(element, tile.track); container.append(element);
    }
  }
  mountAudio(container: HTMLElement): () => void {
    this.current(); this.audioRoots.add(container); this.attachAudio();
    return () => { if (!this.audioRoots.delete(container)) return; for (const element of [...this.attachments.keys()]) if (element instanceof HTMLAudioElement && container.contains(element)) { this.detach(element); element.remove(); } this.attachAudio(); };
  }
  mountVideo(id: string, element: HTMLVideoElement): () => void {
    this.current(); const tile = this.tiles.get(id);
    if (!tile || tile.view.kind !== "video") throw new Error("Voice video is no longer current.");
    this.detach(element); element.muted = tile.view.isLocal; element.playsInline = true;
    tile.track.attach(element); this.attachments.set(element, tile.track);
    return () => { if (this.attachments.get(element) === tile.track) this.detach(element); };
  }
  async startAudio(): Promise<void> { this.current(); if (!this.room) throw new Error("Media not ready."); await this.checked(this.room.startAudio()); this.present(); }

  constructor(private readonly context: InstalledVoiceMediaContext, private readonly bridge: VoiceMediaBridge) {
    this.current();
    this.timer = setTimeout(() => this.fail("media-keying-expired"), Math.max(0, context.deadline - performance.now()));
  }
  private current(): void {
    if (this.dead) throw new Error("Voice media fenced.");
    this.bridge.current();
    if ((!this.keyingComplete && performance.now() >= this.context.deadline) || (!this.connected && performance.now() >= this.tokenDeadline)) throw new Error("Voice media expired.");
  }
  private async checked<T>(promise: Promise<T>): Promise<T> { const result = await promise; this.current(); return result; }
  private fail(reason: string): void { if (this.dead) return; this.fence(); this.bridge.fatal(reason); }
  private run(operation: Promise<unknown>): void { void operation.catch(() => this.fail("media-failed")); }
  private others(): readonly VoiceControlParty[] { return this.context.audience.filter(party => !sameVoiceParty(party, this.context.self)); }
  private control(kind: VoiceOwnerControl["kind"], publisher: VoiceControlParty, recipient: VoiceControlParty, material: Material): VoiceOwnerControl {
    const common = { version: 1, purpose: VOICE_CONTROL_EVENT, callId: this.context.snapshot.callId, generation: this.context.snapshot.generation, epochId: this.context.epochId, proposalSequence: this.context.proposalSequence, audience: [...this.context.audience], sender: this.context.self, publisher, recipient, keyId: material.keyId, reference: material.reference, transaction: crypto.randomUUID() } satisfies Omit<VoiceOwnerControl, "kind" | "material">;
    return kind === "material" ? { ...common, kind, material: material.wire } : { ...common, kind };
  }
  private async send(control: VoiceOwnerControl): Promise<void> { this.current(); await this.checked(this.bridge.send(control)); }
  private async import(bytes: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
    try { this.current(); return await this.checked(crypto.subtle.importKey("raw", bytes, "HKDF", false, ["deriveBits", "deriveKey"])); }
    finally { bytes.fill(0); }
  }
  /** Starts without waiting on future native receive batches. */
  start(): void { this.present(); this.run(this.initialize()); }
  private async initialize(): Promise<void> {
    this.current();
    if (typeof RTCRtpSender === "undefined" || typeof RTCRtpReceiver === "undefined" || !("createEncodedStreams" in RTCRtpSender.prototype) || !("createEncodedStreams" in RTCRtpReceiver.prototype)) throw new Error("Encoded-stream encryption unavailable.");
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    const wire = btoa(String.fromCharCode(...bytes));
    const key = await this.import(bytes);
    const material = { key, wire, keyId: crypto.randomUUID(), reference: crypto.randomUUID() };
    this.materials.set(this.context.self.memberId, material);
    for (const recipient of this.others()) await this.send(this.control("material", this.context.self, recipient, material));
    this.maybeConnect();
  }
  async consume(raw: VoiceOwnerControl): Promise<void> {
    this.current();
    const value = validateVoiceOwnerControl(raw, this.context.snapshot, this.context.epochId, this.context.audience, this.context.proposalSequence);
    if (!sameVoiceParty(value.recipient, this.context.self) || sameVoiceParty(value.sender, this.context.self)) throw new Error("Unexpected media recipient.");
    const serialized = JSON.stringify(value), previous = this.transactions.get(value.transaction);
    if (previous !== undefined) { if (previous !== serialized) throw new Error("Conflicting media transaction."); return; }
    if (this.transactions.size >= 128) throw new Error("Media transaction limit.");
    this.transactions.set(value.transaction, serialized);
    if (value.kind === "material") {
      const existing = this.materials.get(value.publisher.memberId);
      if (existing) {
        if (existing.keyId !== value.keyId || existing.reference !== value.reference || existing.wire !== value.material) throw new Error("Conflicting participant material.");
        return;
      }
      const bytes = Uint8Array.from(atob(value.material), byte => byte.charCodeAt(0));
      if (bytes.length !== 32 || btoa(String.fromCharCode(...bytes)) !== value.material) throw new Error("Invalid participant material.");
      const key = await this.import(bytes);
      this.materials.set(value.publisher.memberId, { key, keyId: value.keyId, reference: value.reference, wire: value.material });
      await this.send(this.control("prepared", value.publisher, value.publisher, this.materials.get(value.publisher.memberId)!));
    } else {
      const own = this.materials.get(this.context.self.memberId);
      if (!sameVoiceParty(value.publisher, this.context.self) || !own || own.keyId !== value.keyId || own.reference !== value.reference) throw new Error("Unbound participant readiness.");
      (value.kind === "prepared" ? this.prepared : this.ready).add(value.sender.memberId);
    }
    this.maybeConnect(); this.completeKeying();
  }
  private maybeConnect(): void {
    this.current();
    if (this.connecting || this.materials.size !== this.context.audience.length || this.prepared.size !== this.others().length) return;
    this.connecting = true; this.run(this.connect());
  }
  private async connect(): Promise<void> {
    const { grant, deadline } = await this.checked(this.bridge.token());
    this.tokenDeadline = deadline; this.current();
    for (const source of grant.sources) if (source !== "screen_share_audio") this.sources.add(source);
    this.present();
    const expected = new Map(this.context.audience.map(party => [party.participantIdentity, this.materials.get(party.memberId)!.key]));
    const provider = new ParticipantKeys(expected);
    const worker = new StrictVoiceWorker(new URL("livekit-client/e2ee-worker", import.meta.url), [...expected.keys()], reason => this.fail(reason), { ownIdentity: this.context.self.participantIdentity, expected });
    this.worker = worker;
    const room = new Room({ encryption: { keyProvider: provider, worker } }); this.room = room;
    room.on(RoomEvent.Reconnecting, () => this.fail("media-reconnecting"));
    room.on(RoomEvent.SignalReconnecting, () => this.fail("media-signal-reconnecting"));
    room.on(RoomEvent.Disconnected, () => this.fail("media-disconnected"));
    room.on(RoomEvent.EncryptionError, () => this.fail("media-encryption-failed"));
    room.on(RoomEvent.AudioPlaybackStatusChanged, () => this.present());
    room.on(RoomEvent.LocalTrackPublished, () => this.localTracks());
    room.on(RoomEvent.LocalTrackUnpublished, () => this.localTracks());
    room.on(RoomEvent.TrackMuted, publication => {
      for (const track of this.remotes) if (track === publication.track) this.removeTrack(track);
      this.localTracks();
    });
    room.on(RoomEvent.TrackUnmuted, (publication, participant) => {
      this.localTracks();
      const remote = room.remoteParticipants.get(participant.identity);
      const current = remote?.trackPublications.get(publication.trackSid);
      if (!remote || !current?.track || !this.remotes.has(current.track)) return;
      try { this.remoteTrack(current.track, current, remote); }
      catch { this.fail("media-attach-failed"); }
    });
    room.on(RoomEvent.ParticipantPermissionsChanged, (_previous, participant) => {
      if (participant !== room.localParticipant) return;
      const permissions = participant.permissions;
      const protocolSources = { microphone: 2, camera: 1, screen_share: 3 } as const;
      if (permissions?.canSubscribe === false || [...this.sources].some(source => permissions?.canPublish === false || (permissions?.canPublishSources?.length && !permissions.canPublishSources.includes(protocolSources[source])))) this.fail("media-permission-reduced");
    });
    room.on(RoomEvent.TrackPublished, (publication, participant) => this.subscribe(publication, participant));
    room.on(RoomEvent.TrackSubscribed, (track, publication, participant) => {
      try {
        this.remoteTrack(track, publication, participant);
      } catch { track.detach().forEach(element => element.remove()); track.stop(); this.fail("media-attach-failed"); }
    });
    room.on(RoomEvent.TrackUnsubscribed, track => { this.remotes.delete(track); this.removeTrack(track); this.present(); });
    await this.checked(room.setE2EEEnabled(true));
    try {
      this.current(); await room.connect(grant.url, grant.token, { autoSubscribe: false }); this.current();
      // JWT expiry bounds joining only. Established media uses the latest call
      // lease; reconnect is separately terminal and never reuses this credential.
      this.connected = true;
    }
    catch (error) { void room.disconnect(); throw error; }
    for (const participant of room.remoteParticipants.values()) for (const publication of participant.trackPublications.values()) this.subscribe(publication, participant);
    await this.checked(worker.waitUntilEnabled(this.context.self.participantIdentity, Math.max(1, this.context.deadline - performance.now())));
    this.localEnabled = true;
    for (const publisher of this.others()) await this.send(this.control("key-ready", publisher, publisher, this.materials.get(publisher.memberId)!));
    this.readinessSent = true;
    this.completeKeying();
  }
  private completeKeying(): void {
    if (!this.localEnabled || !this.readinessSent || this.ready.size !== this.others().length) return;
    this.current(); this.keyingComplete = true; clearTimeout(this.timer); this.present();
  }
  private validate(publication: RemoteTrackPublication, participant: RemoteParticipant): void {
    this.current();
    if (!this.context.audience.some(party => party.participantIdentity === participant.identity && !sameVoiceParty(party, this.context.self))) throw new Error("Unadmitted remote media.");
    const audio = publication.source === Track.Source.Microphone;
    const video = publication.source === Track.Source.Camera || publication.source === Track.Source.ScreenShare;
    if (!publication.isEncrypted || (!audio && !video) || publication.kind !== (audio ? Track.Kind.Audio : Track.Kind.Video) || publication.mimeType?.toLowerCase() !== (audio ? "audio/opus" : "video/vp8")) throw new Error("Unsupported encrypted publication.");
    // Pinned SDK 2.22.4 has no public exact-encryption getter. Read only this
    // declared signaling enum; isEncrypted also accepts non-GCM encryption.
    const encryption = publication.trackInfo?.encryption;
    if (encryption !== Encryption_Type.GCM) throw new Error("Non-GCM publication refused.");
  }
  private subscribe(publication: RemoteTrackPublication, participant: RemoteParticipant): void {
    this.run((async () => {
      this.validate(publication, participant);
      const timeout = Math.max(1, Math.min(5000, this.keyingComplete ? 5000 : this.context.deadline - performance.now()));
      await this.checked(this.worker!.waitUntilEnabled(participant.identity, timeout));
      this.validate(publication, participant);
      this.subscriptions.add(publication); publication.setSubscribed(true);
    })());
  }
  async setSource(source: Source, enabled: boolean): Promise<void> {
    this.current();
    if (!this.keyingComplete || !this.localEnabled || !this.room || this.sourceFlights.has(source)) throw new Error("Media not ready.");
    // Grants are local capabilities only, never inferred remote permissions.
    if (!this.sources.has(source)) throw new Error("Media source not granted.");
    this.sourceFlights.add(source);
    try {
      const local = this.room.localParticipant;
      const publication = source === "microphone" ? await local.setMicrophoneEnabled(enabled, undefined, { dtx: false, red: false })
        : source === "camera" ? await local.setCameraEnabled(enabled, undefined, { videoCodec: "vp8", simulcast: false })
          : await local.setScreenShareEnabled(enabled, { audio: false }, { videoCodec: "vp8", simulcast: false });
      const track = publication?.track;
      try { this.current(); } catch (error) { track?.stop(); void this.room.disconnect(); throw error; }
      if (track) this.captures.add(track.mediaStreamTrack);
      this.localTracks();
    } finally { this.sourceFlights.delete(source); }
  }
  private readonly sources = new Set<Source>();
  fence(): void {
    if (this.dead) return;
    this.dead = true; clearTimeout(this.timer);
    for (const element of [...this.attachments.keys()]) { this.detach(element); if (element instanceof HTMLAudioElement) element.remove(); }
    this.tiles.clear(); this.audioRoots.clear(); this.bridge.presentation?.(emptyVoiceMedia("ended"));
    this.captures.forEach(track => track.stop());
    this.room?.localParticipant.trackPublications.forEach(publication => publication.track?.stop());
    this.remotes.forEach(track => { track.detach().forEach(element => element.remove()); track.stop(); });
    this.subscriptions.forEach(publication => publication.setSubscribed(false));
    this.worker?.terminate(); void this.room?.disconnect();
    this.materials.clear(); this.transactions.clear(); this.prepared.clear(); this.ready.clear(); this.sources.clear();
  }
}
