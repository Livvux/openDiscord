import { describe, expect, it, vi } from "vitest";
import { wipeDmDevice, type WipeDeps } from "@/lib/dm/sign-out";

const USER = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const DEVICE = "33333333-3333-4333-8333-333333333333";
const OLD = "44444444-4444-4444-8444-444444444444";

type Outcome = "success" | "error" | "blocked";
function fakeIndexedDB(names: string[] | null, outcome: (name: string) => Outcome = () => "success") {
  const deleted: string[] = [];
  const deleteDatabase = vi.fn((name: string) => {
    const request = {} as IDBOpenDBRequest;
    queueMicrotask(() => {
      const result = outcome(name);
      if (result === "success") { deleted.push(name); request.onsuccess?.(new Event("success")); }
      else if (result === "error") request.onerror?.(new Event("error"));
      else request.onblocked?.(new Event("blocked") as IDBVersionChangeEvent);
    });
    return request;
  });
  const factory: WipeDeps["indexedDB"] = { deleteDatabase, ...(names ? { databases: async () => names.map((name) => ({ name, version: 1 })) } : {}) };
  return { factory, deleted, deleteDatabase };
}
function deps(overrides: Partial<WipeDeps> = {}, idb = fakeIndexedDB([])) {
  const order: string[] = [];
  const storage = { removeItem: vi.fn((key: string) => { order.push(`remove:${key}`); }) };
  const value: WipeDeps = {
    storage, indexedDB: idb.factory, deviceId: () => DEVICE,
    closeClient: vi.fn(async () => { order.push("close"); }),
    revoke: vi.fn(async () => { order.push("revoke"); }),
    ...overrides,
  };
  return { value, order, storage };
}

describe("wiping DM device state on sign-out", () => {
  it("closes the client, removes the device secret and deletes every DM store of this account only", async () => {
    const idb = fakeIndexedDB([
      `opendiscord-dm-${USER}-${DEVICE}::matrix-sdk-crypto`,
      `opendiscord-dm-${USER}-${OLD}::matrix-sdk-crypto`,
      `opendiscord-dm-history-${USER}-${DEVICE}`,
      `opendiscord-dm-history-${USER}-${OLD}`,
      `opendiscord-dm-${OTHER}-${DEVICE}::matrix-sdk-crypto`,
      `opendiscord-dm-history-${OTHER}-${DEVICE}`,
      "unrelated",
    ]);
    const { value, order, storage } = deps({}, idb);
    const result = await wipeDmDevice(USER, value);
    expect(order.slice(0, 3)).toEqual(["close", `remove:opendiscord.dm.device:${USER}`, `remove:opendiscord.dm.ready:${USER}`]);
    expect(storage.removeItem).toHaveBeenCalledTimes(2);
    expect(value.revoke).toHaveBeenCalledWith(DEVICE);
    expect(result.revoked).toBe(true);
    expect(idb.deleted.sort()).toEqual([
      `opendiscord-dm-${USER}-${DEVICE}::matrix-sdk-crypto`,
      `opendiscord-dm-${USER}-${OLD}::matrix-sdk-crypto`,
      `opendiscord-dm-history-${USER}-${DEVICE}`,
      `opendiscord-dm-history-${USER}-${OLD}`,
    ].sort());
    expect(result.failed).toEqual([]);
  });

  it("still wipes locally when the server revoke fails (offline)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const idb = fakeIndexedDB([`opendiscord-dm-history-${USER}-${DEVICE}`]);
    const { value, storage } = deps({ revoke: vi.fn(async () => { throw new Error("offline"); }) }, idb);
    const result = await wipeDmDevice(USER, value);
    expect(result.revoked).toBe(false);
    expect(storage.removeItem).toHaveBeenCalledWith(`opendiscord.dm.device:${USER}`);
    expect(idb.deleted).toEqual([`opendiscord-dm-history-${USER}-${DEVICE}`]);
    warn.mockRestore();
  });

  it("does not wait forever for a hanging revoke or a blocked deletion", async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const blocked = `opendiscord-dm-history-${USER}-${DEVICE}`;
    const idb = fakeIndexedDB([blocked, `opendiscord-dm-${USER}-${DEVICE}::matrix-sdk-crypto`], (name) => name === blocked ? "blocked" : "success");
    const { value } = deps({ revoke: () => new Promise(() => undefined) }, idb);
    const pending = wipeDmDevice(USER, value);
    await vi.advanceTimersByTimeAsync(10_000);
    const result = await pending;
    expect(result).toEqual({ revoked: false, deleted: [`opendiscord-dm-${USER}-${DEVICE}::matrix-sdk-crypto`], failed: [blocked] });
    vi.useRealTimers();
    warn.mockRestore();
  });

  it("falls back to the current device's known store names without indexedDB.databases()", async () => {
    const idb = fakeIndexedDB(null);
    const { value } = deps({}, idb);
    await wipeDmDevice(USER, value);
    expect(idb.deleteDatabase.mock.calls.map(([name]) => name)).toEqual([
      `opendiscord-dm-${USER}-${DEVICE}::matrix-sdk-crypto`,
      `opendiscord-dm-${USER}-${DEVICE}::matrix-sdk-crypto-meta`,
      `opendiscord-dm-history-${USER}-${DEVICE}`,
    ]);
  });

  it("without an enrolled device still deletes leftover stores but revokes nothing", async () => {
    const idb = fakeIndexedDB([`opendiscord-dm-history-${USER}-${OLD}`]);
    const { value } = deps({ deviceId: () => null }, idb);
    const result = await wipeDmDevice(USER, value);
    expect(value.revoke).not.toHaveBeenCalled();
    expect(result.deleted).toEqual([`opendiscord-dm-history-${USER}-${OLD}`]);
  });
});
