"use client";

import { closeDmClient, dmFetch } from "./client";
import { readExistingDmEnrollment } from "./enrollment";

const REVOKE_TIMEOUT_MS = 4000;
const BLOCKED_TIMEOUT_MS = 2000;

const dmDeviceKey = (userId: string) => `opendiscord.dm.device:${userId}`;
const dmReadyKey = (userId: string) => `opendiscord.dm.ready:${userId}`;
/** The Matrix crypto store (`opendiscord-dm-<user>-<device>::…`) and the history/archive store, for every device this browser held. */
const storePrefixes = (userId: string) => [`opendiscord-dm-${userId}-`, `opendiscord-dm-history-${userId}-`];
/** Used when `indexedDB.databases()` is unavailable: the stores of the current device only. */
const knownStores = (userId: string, deviceId: string) => [
  `opendiscord-dm-${userId}-${deviceId}::matrix-sdk-crypto`,
  `opendiscord-dm-${userId}-${deviceId}::matrix-sdk-crypto-meta`,
  `opendiscord-dm-history-${userId}-${deviceId}`,
];

export type WipeDeps = {
  storage: Pick<Storage, "removeItem">;
  indexedDB: Pick<IDBFactory, "deleteDatabase"> & { databases?: IDBFactory["databases"] };
  /** Revokes the device server-side with the account session; may fail offline. */
  revoke: (deviceId: string) => Promise<unknown>;
  closeClient: (userId: string) => Promise<void>;
  deviceId: (userId: string) => string | null;
};
export type WipeResult = { revoked: boolean; deleted: string[]; failed: string[] };

const browserDeps = (): WipeDeps => ({
  storage: localStorage,
  indexedDB,
  revoke: (id) => dmFetch("/api/dm", { action: "revoke", id }),
  closeClient: closeDmClient,
  deviceId: (userId) => readExistingDmEnrollment(userId)?.id ?? null,
});

const timeout = (ms: number) => new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), ms));

function deleteStore(factory: WipeDeps["indexedDB"], name: string): Promise<boolean> {
  return new Promise((resolve) => {
    const request = factory.deleteDatabase(name);
    request.onsuccess = () => resolve(true);
    request.onerror = () => resolve(false);
    // A connection is still open: the Matrix store stays open until the SDK's JS wrappers holding it are
    // garbage-collected. The browser keeps the deletion queued and runs it then (seen in e2e within seconds);
    // that store is encrypted with the store key removed above, so sign-out does not wait for it.
    request.onblocked = () => { void timeout(BLOCKED_TIMEOUT_MS).then(() => resolve(false)); };
  });
}

/**
 * Explicit sign-out: removes this account's DM device secret, crypto stores, history cache and
 * recovered archives from this browser, and revokes the device server-side (best effort, so an
 * offline sign-out still wipes locally). The next sign-in here is a new device that must be verified.
 */
export async function wipeDmDevice(userId: string, deps: WipeDeps = browserDeps()): Promise<WipeResult> {
  const deviceId = deps.deviceId(userId);
  await deps.closeClient(userId);
  deps.storage.removeItem(dmDeviceKey(userId));
  deps.storage.removeItem(dmReadyKey(userId));
  const revoking = deviceId
    ? Promise.race([deps.revoke(deviceId).then(() => true as const), timeout(REVOKE_TIMEOUT_MS)]).then((value) => value === true, () => false)
    : Promise.resolve(false);
  const listed = deps.indexedDB.databases ? await deps.indexedDB.databases().then((all) => all.flatMap((db) => db.name ? [db.name] : []), () => null) : null;
  const prefixes = storePrefixes(userId);
  const names = listed ? listed.filter((name) => prefixes.some((prefix) => name.startsWith(prefix))) : deviceId ? knownStores(userId, deviceId) : [];
  const results = await Promise.all(names.map((name) => deleteStore(deps.indexedDB, name)));
  const result = { revoked: await revoking, deleted: names.filter((_, i) => results[i]), failed: names.filter((_, i) => !results[i]) };
  if (deviceId && !result.revoked) console.warn("Encrypted messaging device could not be revoked; revoke it in Devices and recovery from another device.");
  if (result.failed.length) console.warn("Some encrypted message stores could not be deleted yet:", result.failed);
  return result;
}

/**
 * True when signing out would lose access to encrypted history: this browser holds the account's
 * only active device and no encrypted recovery backup exists. Unknown (offline) counts as true.
 */
export async function dmSignOutLosesHistory(userId: string): Promise<boolean> {
  const enrollment = readExistingDmEnrollment(userId);
  if (!enrollment) return false;
  try {
    const [{ devices }, { backups }] = await Promise.all([
      dmFetch<{ devices: { id: string; revoked: boolean }[] }>(`/api/dm?devices=${encodeURIComponent(userId)}`),
      dmFetch<{ backups: unknown[] }>("/api/dm/backups"),
    ]);
    return backups.length === 0 && !devices.some((device) => !device.revoked && device.id !== enrollment.id);
  } catch {
    return true;
  }
}
