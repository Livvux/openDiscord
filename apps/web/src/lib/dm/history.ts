"use client";

import type * as Matrix from "@matrix-org/matrix-sdk-crypto-wasm";
import { z } from "zod";
import { DM_MAX_BACKUP_BYTES, encryptedMessageSchema, plainMessageSchema } from "./contracts";

export const MAX_HISTORY_COPIES = 200;
export const historyEntrySchema = z.object({
  envelope: z.object({ id: z.uuid(), conversationId: z.uuid(), senderId: z.string().max(64), deviceId: z.uuid(), transactionId: z.uuid(), content: encryptedMessageSchema, createdAt: z.iso.datetime() }).strict(),
  message: plainMessageSchema,
  verifiedAt: z.iso.datetime(),
}).strict().refine((entry) => entry.envelope.conversationId === entry.message.conversation && entry.envelope.transactionId === entry.message.transaction, "Historical message binding mismatch");
export const archiveSchema = z.object({
  format: z.literal("opendiscord.e2ee-history"), version: z.literal(2), id: z.uuid(), origin: z.url().max(2048), userId: z.string().max(64),
  sourceDevice: z.uuid(), sourceFingerprint: z.string().min(40).max(64), masterKey: z.string().max(4096), createdAt: z.iso.datetime(),
  messages: z.array(historyEntrySchema).max(MAX_HISTORY_COPIES),
}).strict();
export const recoverySnapshotSchema = archiveSchema.extend({ secrets: z.unknown() }).strict();
export type HistoryEntry = z.infer<typeof historyEntrySchema>;
export type HistoryArchive = z.infer<typeof archiveSchema>;
export type RecoverySnapshot = z.infer<typeof recoverySnapshotSchema>;
const outgoingSchema = z.object({ id: z.uuid(), target: z.uuid(), snapshot: recoverySnapshotSchema, attempts: z.number().int().min(0).max(8), attemptedAt: z.number().nonnegative() }).strict();
export type PendingTransfer = z.infer<typeof outgoingSchema>;

/** Encrypted local copies, with unlocking information in the same origin. No endpoint-compromise protection is claimed. */
export class HistoryStore {
  private constructor(private database: IDBDatabase, private C: typeof Matrix) {}
  static async open(userId: string, deviceId: string, C: typeof Matrix): Promise<HistoryStore> {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(`opendiscord-dm-history-${userId}-${deviceId}`, 5);
      request.onupgradeneeded = () => { for (const name of ["encrypted", "seen", "imports", "outgoing", "identities"]) if (!request.result.objectStoreNames.contains(name)) request.result.createObjectStore(name, { keyPath: "id" }); };
      request.onerror = () => reject(new Error("Encrypted history storage is unavailable."));
      request.onsuccess = () => resolve(new HistoryStore(request.result, C));
    });
  }
  close() { this.database.close(); }
  private async rows(): Promise<unknown[]> {
    return new Promise((resolve, reject) => {
      const request = this.database.transaction("encrypted", "readonly").objectStore("encrypted").getAll();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(new Error("Cannot read encrypted history storage."));
    });
  }
  private decode(raw: unknown): { id: string; value: unknown } {
    const row = z.object({ id: z.string(), ciphertext: z.instanceof(Uint8Array), information: z.string().max(4096) }).parse(raw);
    if (row.ciphertext.length > DM_MAX_BACKUP_BYTES) throw new Error("Stored archive exceeds the size limit.");
    const attachment = new this.C.EncryptedAttachment(row.ciphertext, row.information);
    return { id: row.id, value: JSON.parse(new TextDecoder().decode(this.C.Attachment.decrypt(attachment))) };
  }
  async cached(): Promise<HistoryEntry[]> {
    for (const raw of await this.rows()) { const row = this.decode(raw); if (row.id === "verified-cache") return z.array(historyEntrySchema).max(MAX_HISTORY_COPIES).parse(row.value); }
    return [];
  }
  async archives(): Promise<HistoryArchive[]> {
    const archives: HistoryArchive[] = [];
    for (const raw of await this.rows()) { const row = this.decode(raw); if (row.id !== "verified-cache") archives.push(archiveSchema.parse(row.value)); }
    return archives.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  async put(id: string, value: HistoryEntry[] | HistoryArchive, recovery?: RecoverySnapshot): Promise<void> {
    const immutable = recovery !== undefined;
    const bytes = new TextEncoder().encode(JSON.stringify(value));
    if (bytes.length > DM_MAX_BACKUP_BYTES) throw new Error("Encrypted archive exceeds the 4 MB limit.");
    const encrypted = this.C.Attachment.encrypt(bytes);
    const row = { id, ciphertext: encrypted.encryptedData, information: encrypted.mediaEncryptionInfo };
    encrypted.free();
    let identityRow: { id: string; ciphertext: Uint8Array; information: string } | undefined;
    if (recovery) {
      const snapshot = recoverySnapshotSchema.parse(recovery);
      if (snapshot.id !== id) throw new Error("Recovery archive ID mismatch.");
      const identityBytes = new TextEncoder().encode(JSON.stringify({ snapshot, importedAt: Date.now() }));
      if (identityBytes.length > DM_MAX_BACKUP_BYTES) throw new Error("Recovery exceeds the 4 MB limit.");
      const attachment = this.C.Attachment.encrypt(identityBytes);
      const information = attachment.mediaEncryptionInfo;
      if (!information) { attachment.free(); throw new Error("Could not encrypt pending identity recovery."); }
      identityRow = { id, ciphertext: attachment.encryptedData, information };
      attachment.free();
    }
    return new Promise((resolve, reject) => {
      const transaction = this.database.transaction(immutable ? ["encrypted", "imports", "identities"] : "encrypted", "readwrite");
      const store = transaction.objectStore("encrypted");
      const found = (immutable ? transaction.objectStore("imports") : store).get(id);
      found.onsuccess = () => {
        if (immutable && found.result) return;
        const count = store.count();
        count.onsuccess = () => { if (!found.result && id !== "verified-cache" && count.result >= 10) transaction.abort(); else { store.put(row); if (identityRow) { transaction.objectStore("identities").add(identityRow); transaction.objectStore("imports").add({ id }); } } };
      };
      transaction.oncomplete = () => resolve();
      transaction.onabort = () => reject(new Error("Archive was not saved. Remove an old local archive or free browser storage."));
      transaction.onerror = () => reject(new Error("Cannot persist encrypted history."));
    });
  }
  async pendingIdentity(): Promise<RecoverySnapshot | null> {
    const rows: unknown[] = await new Promise((resolve, reject) => {
      const request = this.database.transaction("identities", "readonly").objectStore("identities").getAll();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(new Error("Cannot read pending identity recovery."));
    });
    return rows.map((row) => z.object({ snapshot: recoverySnapshotSchema, importedAt: z.number() }).strict().parse(this.decode(row).value))
      .sort((a, b) => b.importedAt - a.importedAt)[0]?.snapshot ?? null;
  }
  async removePendingIdentity(id: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const transaction = this.database.transaction("identities", "readwrite");
      transaction.objectStore("identities").delete(id);
      transaction.oncomplete = () => resolve();
      transaction.onabort = transaction.onerror = () => reject(new Error("Cannot update identity recovery status."));
    });
  }
  async outgoing(): Promise<PendingTransfer[]> {
    const rows: unknown[] = await new Promise((resolve, reject) => {
      const request = this.database.transaction("outgoing", "readonly").objectStore("outgoing").getAll();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(new Error("Cannot read pending encrypted transfers."));
    });
    return rows.map((row) => outgoingSchema.parse(this.decode(row).value));
  }
  async saveOutgoing(value: PendingTransfer): Promise<void> {
    const data = outgoingSchema.parse(value);
    const bytes = new TextEncoder().encode(JSON.stringify(data));
    if (bytes.length > 310_000) throw new Error("Use a recovery file for this larger archive.");
    const encrypted = this.C.Attachment.encrypt(bytes);
    const row = { id: data.id, ciphertext: encrypted.encryptedData, information: encrypted.mediaEncryptionInfo };
    encrypted.free();
    return new Promise((resolve, reject) => {
      const transaction = this.database.transaction("outgoing", "readwrite");
      const store = transaction.objectStore("outgoing");
      const existing = store.get(data.id);
      existing.onsuccess = () => {
        const count = store.count();
        count.onsuccess = () => { if (!existing.result && count.result >= 3) transaction.abort(); else store.put(row); };
      };
      transaction.oncomplete = () => resolve();
      transaction.onabort = () => reject(new Error("At most three encrypted transfers can await delivery. Retry or cancel an existing transfer."));
      transaction.onerror = () => reject(new Error("Cannot persist encrypted transfer."));
    });
  }
  async removeOutgoing(id: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const transaction = this.database.transaction("outgoing", "readwrite");
      transaction.objectStore("outgoing").delete(id);
      transaction.oncomplete = () => resolve();
      transaction.onabort = transaction.onerror = () => reject(new Error("Cannot update encrypted transfer status."));
    });
  }
  /** SDK Megolm authenticates content, not transport event IDs. Pin each signed transaction once. */
  async acceptEvent(envelope: HistoryEntry["envelope"]): Promise<void> {
    const id = JSON.stringify([envelope.conversationId, envelope.senderId, envelope.transactionId]);
    const canonical = JSON.stringify(encryptedMessageSchema.parse(envelope.content));
    const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
    const digest = Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
    return new Promise((resolve, reject) => {
      const transaction = this.database.transaction("seen", "readwrite");
      const store = transaction.objectStore("seen");
      let reason = "Cannot persist encrypted message replay protection.";
      const request = store.get(id);
      request.onsuccess = () => {
        const previous = z.object({ eventId: z.string(), digest: z.string() }).safeParse(request.result);
        if (request.result) {
          if (!previous.success || previous.data.eventId !== envelope.id || previous.data.digest !== digest) { reason = "This encrypted transaction was already delivered with a different envelope."; transaction.abort(); }
          return;
        }
        const count = store.count();
        count.onsuccess = () => { if (count.result >= 100_000) { reason = "Local replay-protection limit reached. Enroll another device."; transaction.abort(); } else store.add({ id, eventId: envelope.id, digest }); };
      };
      transaction.oncomplete = () => resolve();
      transaction.onabort = () => reject(new Error(reason));
      transaction.onerror = () => reject(new Error(reason));
    });
  }
  async remove(id: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const transaction = this.database.transaction(["encrypted", "identities"], "readwrite");
      transaction.objectStore("encrypted").delete(id);
      transaction.objectStore("identities").delete(id);
      transaction.oncomplete = () => resolve();
      transaction.onabort = transaction.onerror = () => reject(new Error("Cannot remove the local archive."));
    });
  }
}
