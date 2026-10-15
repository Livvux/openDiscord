"use client";

import type * as Matrix from "@matrix-org/matrix-sdk-crypto-wasm";
import { z } from "zod";
import { DM_MAX_BACKUP_BYTES, matrixRoom, matrixUser, plainMessageSchema, type CryptoSync, type DirectEnvelope, type RecoveryFile } from "./contracts";

type SDK = typeof Matrix;
type Outgoing = Matrix.KeysUploadRequest | Matrix.KeysQueryRequest | Matrix.KeysClaimRequest | Matrix.ToDeviceRequest | Matrix.SignatureUploadRequest | Matrix.RoomMessageRequest | Matrix.KeysBackupRequest;
type Metadata = { id: string; secret: string; storeKey: string };
export type TrustedDevice = { userId: string; id: string; verified: boolean; fingerprint: string };
export type VerificationView = { userId: string; deviceId: string; flowId: string; requested: boolean; ready: boolean; done: boolean; cancelled: boolean; confirmed: boolean; decimals: number[] | null };
const metadataSchema = z.object({ id: z.uuid(), secret: z.string().regex(/^[a-f0-9]{64}$/), storeKey: z.string().min(32) });
const recoverySchema = z.object({ format: z.literal("opendiscord.e2ee-recovery"), version: z.literal(1), userId: z.string(), backupId: z.uuid(), encryptionInfo: z.string().max(4000) }).strict();
const snapshotSchema = z.object({ userId: z.string(), secrets: z.unknown(), roomKeys: z.string(), createdAt: z.string() }).strict();
const transferSchema = snapshotSchema.extend({ recipient: z.uuid(), transferId: z.uuid() }).strict();
const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };
const clients = new Map<string, Promise<PrivateMessaging>>();

export async function dmFetch<T>(path: string, body?: unknown, metadata?: Metadata, method = "POST"): Promise<T> {
  const response = await fetch(path, {
    method: body === undefined ? "GET" : method,
    headers: { ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...(metadata ? { "x-dm-device": metadata.id, "x-dm-device-secret": metadata.secret } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body), cache: "no-store", credentials: "same-origin",
  });
  const value: unknown = await response.json();
  if (!response.ok) throw new Error(z.object({ error: z.string() }).safeParse(value).data?.error ?? "Private messaging could not connect.");
  // Typed callers consume our same-origin API; cryptographic payloads are validated separately below.
  return value as T;
}
function encode(bytes: Uint8Array): string {
  let value = "";
  for (let i = 0; i < bytes.length; i += 8192) value += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(value);
}
function decode(value: string): Uint8Array { return Uint8Array.from(atob(value), (c) => c.charCodeAt(0)); }
function randomSecret(): string { return Array.from(crypto.getRandomValues(new Uint8Array(32)), (n) => n.toString(16).padStart(2, "0")).join(""); }

export function privateMessaging(userId: string): Promise<PrivateMessaging> {
  let client = clients.get(userId);
  if (!client) {
    client = PrivateMessaging.open(userId).catch((error: unknown) => { clients.delete(userId); throw error; });
    clients.set(userId, client);
  }
  return client;
}

/** Explicit local re-enrollment: old keys are retained in IndexedDB but never silently reused. */
export async function enrollNewDmDevice(userId: string): Promise<void> {
  const existing = clients.get(userId);
  if (existing) (await existing.catch(() => undefined))?.close();
  const saved = localStorage.getItem(`opendiscord.dm.device:${userId}`);
  if (saved) {
    const metadata = metadataSchema.parse(JSON.parse(saved));
    await dmFetch("/api/dm", { action: "revoke", id: metadata.id });
  }
  localStorage.removeItem(`opendiscord.dm.device:${userId}`);
}

/** One serialized owner per IndexedDB crypto store. Private material never enters server rendering. */
export class PrivateMessaging {
  private queue: Promise<unknown> = Promise.resolve();
  private users = new Set<string>();
  private rosters = new Map<string, string>();
  private releaseLock: (() => void) | undefined;
  private constructor(readonly userId: string, private C: SDK, readonly metadata: Metadata, private machine: Matrix.OlmMachine) { this.users.add(userId); }
  get deviceId(): string { return this.metadata.id; }
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn, fn);
    this.queue = next.catch(() => undefined);
    return next;
  }
  private crypto<T = Record<string, unknown>>(body: unknown): Promise<T> { return dmFetch<T>("/api/dm/crypto", body, this.metadata); }
  static async open(userId: string): Promise<PrivateMessaging> {
    if (!window.isSecureContext || !window.indexedDB || !navigator.locks) throw new Error("Encrypted messages need a secure browser with persistent storage and Web Locks.");
    const key = `opendiscord.dm.device:${userId}`;
    const saved = localStorage.getItem(key);
    const metadata = saved ? metadataSchema.parse(JSON.parse(saved)) : { id: crypto.randomUUID(), secret: randomSecret(), storeKey: randomSecret() };
    // Save before network work so a failed registration can be retried with the same device identity.
    localStorage.setItem(key, JSON.stringify(metadata));
    let release: (() => void) | undefined;
    await new Promise<void>((resolve, reject) => {
      void navigator.locks.request(`opendiscord.dm:${userId}`, { ifAvailable: true }, async (lock) => {
        if (!lock) { reject(new Error("Private messages are open in another tab. Close that tab, then retry here.")); return; }
        await new Promise<void>((done) => { release = done; resolve(); });
      }).catch(reject);
    });
    let opened: Matrix.OlmMachine | undefined;
    try {
      const C = await import("@matrix-org/matrix-sdk-crypto-wasm");
      await C.initAsync();
      const machine = await C.OlmMachine.initialize(new C.UserId(matrixUser(userId)), new C.DeviceId(metadata.id), `opendiscord-dm-${userId}-${metadata.id}`, metadata.storeKey, silentLogger);
      opened = machine;
      const client = new PrivateMessaging(userId, C, metadata, machine);
      client.releaseLock = release;
      await dmFetch("/api/dm", { action: "register", input: { id: metadata.id, secret: metadata.secret, name: "Web browser" } });
      await client.flush();
      await client.query([userId]);
      const identity = await machine.getIdentity(new C.UserId(matrixUser(userId)));
      if (!identity) await client.bootstrap();
      window.addEventListener("pagehide", () => client.close(), { once: true });
      window.addEventListener("pageshow", (event) => { if (event.persisted) window.location.reload(); });
      return client;
    } catch (error) { opened?.close(); release?.(); throw error; }
  }
  close(): void { this.machine.close(); this.releaseLock?.(); this.releaseLock = undefined; clients.delete(this.userId); }
  private async outgoing(request: Outgoing): Promise<void> {
    const C = this.C;
    const body: unknown = JSON.parse(request.body);
    let response: Record<string, unknown>;
    switch (request.type) {
      case C.RequestType.KeysUpload: response = await this.crypto({ kind: "upload", body }); break;
      case C.RequestType.KeysQuery: response = await this.crypto({ kind: "query", body }); break;
      case C.RequestType.KeysClaim: response = await this.crypto({ kind: "claim", requestId: request.id, body }); break;
      case C.RequestType.SignatureUpload: response = await this.crypto({ kind: "signatures", body }); break;
      case C.RequestType.ToDevice:
        if (!(request instanceof C.ToDeviceRequest)) throw new Error("Invalid device request.");
        response = await this.crypto({ kind: "send", requestId: request.txn_id, eventType: request.event_type, body }); break;
      default: throw new Error("An unsupported encryption request was refused.");
    }
    if (request.id) await this.machine.markRequestAsSent(request.id, request.type, JSON.stringify(response));
  }
  private async flush(): Promise<void> {
    for (let round = 0; round < 4; round++) {
      const requests = await this.machine.outgoingRequests();
      if (!requests.length) break;
      for (const request of requests) await this.outgoing(request);
    }
  }
  private async query(users: string[]): Promise<void> {
    for (const id of users) this.users.add(id);
    await this.outgoing(this.machine.queryKeysForUsers(users.map((id) => new this.C.UserId(matrixUser(id)))));
  }
  private async bootstrap(): Promise<void> {
    const requests = await this.machine.bootstrapCrossSigning(false);
    // The upstream declaration is `any`; narrow it to the documented request class.
    if (requests.uploadKeysRequest instanceof this.C.KeysUploadRequest) await this.outgoing(requests.uploadKeysRequest);
    await this.crypto({ kind: "signing", body: JSON.parse(requests.uploadSigningKeysRequest.body) });
    await this.outgoing(requests.uploadSignaturesRequest);
    await this.query([this.userId]);
  }
  async sync(peer?: string): Promise<void> {
    return this.serial(async () => {
      const sync = await this.crypto<CryptoSync>({ kind: "sync" });
      // Do not trust a server roster to enroll arbitrary strangers. Only own and explicitly opened peers are queried.
      this.users = new Set([this.userId, ...(peer ? [peer] : [])]);
      await this.query([...this.users]);
      const events = await this.machine.receiveSyncChanges(JSON.stringify(sync.events), new this.C.DeviceLists([], []), new Map(Object.entries(sync.oneTimeKeys)), new Set(sync.unusedFallbackKeys));
      for (const processed of events) {
        if (!(processed instanceof this.C.DecryptedToDeviceEvent) || !processed.encryptionInfo.isSenderVerified()) continue;
        const event = z.object({ sender: z.string(), type: z.string(), content: z.unknown() }).parse(JSON.parse(processed.rawEvent));
        if (event.type !== "app.opendiscord.device-transfer" || event.sender !== matrixUser(this.userId)) continue;
        const content = transferSchema.parse(event.content);
        if (content.recipient !== this.deviceId || content.userId !== this.userId) throw new Error("Device transfer identity mismatch.");
        await this.importSnapshot({ userId: content.userId, createdAt: content.createdAt, secrets: content.secrets, roomKeys: content.roomKeys });
      }
      // OlmMachine persisted its state before this point; retry delivery after a lost acknowledgment is safe.
      if (sync.cursor !== "0") await this.crypto({ kind: "ack", cursor: sync.cursor });
      await this.flush();
    });
  }
  async devices(userId: string): Promise<TrustedDevice[]> {
    return this.serial(async () => {
      const devices = await this.machine.getUserDevices(new this.C.UserId(matrixUser(userId)));
      return devices.devices().filter((d) => !d.isDeleted()).map((d) => ({ userId, id: d.deviceId.toString(), verified: d.isVerified() || (userId === this.userId && d.deviceId.toString() === this.deviceId), fingerprint: d.ed25519Key?.toBase64() ?? "" }));
    });
  }
  async startVerification(userId: string, id: string): Promise<void> {
    return this.serial(async () => {
      await this.query([userId]);
      const device = await this.machine.getDevice(new this.C.UserId(matrixUser(userId)), new this.C.DeviceId(id));
      if (!device) throw new Error("Device not found.");
      const [, request] = device.requestVerification([this.C.VerificationMethod.SasV1]);
      await this.outgoing(request);
    });
  }
  verifications(): VerificationView[] {
    return [...this.users].flatMap((userId) => this.machine.getVerificationRequests(new this.C.UserId(matrixUser(userId))).map((r) => {
      const v = r.getVerification();
      const sas = v instanceof this.C.Sas ? v : undefined;
      return { userId, deviceId: r.otherDeviceId?.toString() ?? "", flowId: r.flowId, requested: !r.weStarted() && !r.isReady() && !sas, ready: r.isReady(), done: r.isDone(), cancelled: r.isCancelled(), confirmed: sas?.haveWeConfirmed() ?? false, decimals: sas?.decimals() ? Array.from(sas.decimals()!) : null };
    }));
  }
  async verificationAction(userId: string, flowId: string, action: "accept" | "start" | "confirm" | "cancel"): Promise<void> {
    return this.serial(async () => {
      const request = this.machine.getVerificationRequests(new this.C.UserId(matrixUser(userId))).find((r) => r.flowId === flowId);
      if (!request) throw new Error("The verification has expired. Start again.");
      const verification = request.getVerification();
      if (action === "cancel") { const out = request.cancel(); if (out) await this.outgoing(out); }
      else if (action === "accept") { const out = request.acceptWithMethods([this.C.VerificationMethod.SasV1]); if (out) await this.outgoing(out); }
      else if (action === "start") { const out = await request.startSas(); if (out) await this.outgoing(out[1]); }
      else if (verification instanceof this.C.Sas && verification.canBePresented()) { for (const out of await verification.confirm()) await this.outgoing(out); }
      else throw new Error("Compare the verification numbers on both devices first.");
      await this.flush();
    });
  }
  async acceptStartedVerifications(): Promise<void> {
    return this.serial(async () => {
      for (const userId of this.users) for (const request of this.machine.getVerificationRequests(new this.C.UserId(matrixUser(userId)))) {
        const verification = request.getVerification();
        if (verification instanceof this.C.Sas && !verification.weStarted() && !verification.hasBeenAccepted()) { const out = verification.accept(); if (out) await this.outgoing(out); }
      }
    });
  }
  async send(conversation: string, peer: string, text: string): Promise<void> {
    return this.serial(async () => {
      await this.query([this.userId, peer]);
      const identities = [this.userId, peer];
      const roster: string[] = [];
      for (const user of identities) {
        const devices = (await this.machine.getUserDevices(new this.C.UserId(matrixUser(user)))).devices().filter((d) => !d.isDeleted());
        if (!devices.length || devices.some((d) => !d.isVerified() && !(user === this.userId && d.deviceId.toString() === this.deviceId))) throw new Error("Verify every active device before sending. Revoke unused devices in their account.");
        roster.push(...devices.map((d) => `${user}/${d.deviceId.toString()}/${d.ed25519Key?.toBase64()}`));
      }
      const room = matrixRoom(conversation), rosterKey = roster.sort().join("|");
      if (this.rosters.get(room) !== rosterKey) { await this.machine.invalidateGroupSession(new this.C.RoomId(room)); this.rosters.set(room, rosterKey); }
      const claim = await this.machine.getMissingSessions(identities.map((id) => new this.C.UserId(matrixUser(id))));
      if (claim) await this.outgoing(claim);
      const settings = new this.C.EncryptionSettings();
      settings.sharingStrategy = this.C.CollectStrategy.onlyTrustedDevices();
      for (const request of await this.machine.shareRoomKey(new this.C.RoomId(room), identities.map((id) => new this.C.UserId(matrixUser(id))), settings)) await this.outgoing(request);
      const transaction = crypto.randomUUID();
      const plain = plainMessageSchema.parse({ msgtype: "m.text", body: text, conversation, transaction });
      const content: unknown = JSON.parse(await this.machine.encryptRoomEvent(new this.C.RoomId(room), "m.room.message", JSON.stringify(plain)));
      await dmFetch("/api/dm", { action: "send", id: conversation, input: { transactionId: transaction, content } }, this.metadata);
    });
  }
  async decrypt(envelopes: DirectEnvelope[], conversation: string, peer: string): Promise<{ id: string; body: string | null; error?: string; own: boolean; createdAt: string; senderId: string }[]> {
    return this.serial(async () => {
      const result = [];
      for (const envelope of envelopes) {
        const base = { id: envelope.id, own: envelope.senderId === this.userId, createdAt: envelope.createdAt, senderId: envelope.senderId };
        try {
          if (envelope.conversationId !== conversation || ![this.userId, peer].includes(envelope.senderId)) throw new Error("Unexpected message sender.");
          const event = { type: "m.room.encrypted", event_id: `$${envelope.id}`, sender: matrixUser(envelope.senderId), origin_server_ts: new Date(envelope.createdAt).getTime(), content: envelope.content };
          const decrypted = await this.machine.decryptRoomEvent(JSON.stringify(event), new this.C.RoomId(matrixRoom(conversation)), new this.C.DecryptionSettings(this.C.TrustRequirement.CrossSigned));
          if (decrypted.shieldState(true).color !== this.C.ShieldColor.None) throw new Error("The SDK could not authenticate this message sender.");
          if (!decrypted.senderDevice || decrypted.sender.toString() !== matrixUser(envelope.senderId)) throw new Error("The sender cannot be authenticated.");
          const device = await this.machine.getDevice(decrypted.sender, decrypted.senderDevice);
          if (!device?.isVerified() && !(envelope.senderId === this.userId && decrypted.senderDevice.toString() === this.deviceId)) throw new Error("Verify the sender's device to read this message.");
          const plain = plainMessageSchema.parse(z.object({ content: z.unknown() }).parse(JSON.parse(decrypted.event)).content);
          if (plain.conversation !== conversation || plain.transaction !== envelope.transactionId) throw new Error("Message binding mismatch.");
          result.push({ ...base, body: plain.body });
        } catch { result.push({ ...base, body: null, error: "Cannot decrypt or authenticate this message. Verify devices, sync, or restore a trusted history backup." }); }
      }
      return result;
    });
  }
  private async snapshot() {
    return { userId: this.userId, createdAt: new Date().toISOString(), secrets: (await this.machine.exportSecretsBundle()).to_json(), roomKeys: await this.machine.exportRoomKeys(() => true) };
  }
  private async importSnapshot(raw: unknown): Promise<void> {
    const snapshot = snapshotSchema.parse(raw);
    if (snapshot.userId !== this.userId) throw new Error("This recovery belongs to another account.");
    const secrets = this.C.SecretsBundle.from_json(snapshot.secrets);
    await this.machine.importSecretsBundle(secrets);
    await this.machine.importExportedRoomKeys(snapshot.roomKeys, () => {});
    await this.bootstrap();
  }
  async createBackup(): Promise<RecoveryFile> {
    return this.serial(async () => {
      const bytes = new TextEncoder().encode(JSON.stringify(await this.snapshot()));
      if (bytes.length > DM_MAX_BACKUP_BYTES) throw new Error("This history exceeds the encrypted backup size limit.");
      const attachment = this.C.Attachment.encrypt(bytes);
      const encryptionInfo = attachment.mediaEncryptionInfo;
      if (!encryptionInfo) throw new Error("Could not create recovery information.");
      const backupId = crypto.randomUUID();
      await dmFetch("/api/dm/backups", { id: backupId, ciphertext: encode(attachment.encryptedData) }, this.metadata);
      attachment.free();
      return { format: "opendiscord.e2ee-recovery", version: 1, userId: this.userId, backupId, encryptionInfo };
    });
  }
  async restoreBackup(raw: unknown): Promise<void> {
    return this.serial(async () => {
      const file = recoverySchema.parse(raw);
      if (file.userId !== this.userId) throw new Error("This recovery file belongs to another account.");
      const backup = await dmFetch<{ ciphertext: string }>(`/api/dm/backups?id=${file.backupId}`);
      const attachment = new this.C.EncryptedAttachment(decode(backup.ciphertext), file.encryptionInfo);
      const plain = this.C.Attachment.decrypt(attachment);
      await this.importSnapshot(JSON.parse(new TextDecoder().decode(plain)));
    });
  }
  async shareHistory(targetDeviceId: string): Promise<void> {
    return this.serial(async () => {
      await this.query([this.userId]);
      const claim = await this.machine.getMissingSessions([new this.C.UserId(matrixUser(this.userId))]);
      if (claim) await this.outgoing(claim);
      const device = await this.machine.getDevice(new this.C.UserId(matrixUser(this.userId)), new this.C.DeviceId(targetDeviceId));
      if (!device?.isVerified() || device.isDeleted()) throw new Error("Verify your other device before sharing identity and history.");
      const content = { ...await this.snapshot(), recipient: targetDeviceId, transferId: crypto.randomUUID() };
      if (new TextEncoder().encode(JSON.stringify(content)).length > 300_000) throw new Error("Use an encrypted recovery file for this larger history.");
      const encrypted = await device.encryptToDeviceEvent("app.opendiscord.device-transfer", content, this.C.CollectStrategy.onlyTrustedDevices());
      await this.crypto({ kind: "send", requestId: crypto.randomUUID(), eventType: "m.room.encrypted", body: { messages: { [matrixUser(this.userId)]: { [targetDeviceId]: JSON.parse(encrypted) } } } });
    });
  }
}
