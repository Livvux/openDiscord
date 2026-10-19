import { describe, expect, it, vi } from "vitest";
import { requestPersistentStorage, storageHint } from "@/lib/dm/storage-persistence";

describe("persistent storage for DM keys", () => {
  it("does not ask again when storage is already persistent", async () => {
    const persist = vi.fn(async () => true);
    expect(await requestPersistentStorage({ persisted: async () => true, persist })).toBe("persisted");
    expect(persist).not.toHaveBeenCalled();
  });
  it("reports the browser's answer", async () => {
    expect(await requestPersistentStorage({ persisted: async () => false, persist: async () => true })).toBe("persisted");
    expect(await requestPersistentStorage({ persisted: async () => false, persist: async () => false })).toBe("denied");
  });
  it("treats a missing API or a failing request as not persistent", async () => {
    expect(await requestPersistentStorage(undefined)).toBe("unsupported");
    expect(await requestPersistentStorage({ persisted: async () => false, persist: async () => { throw new Error("blocked"); } })).toBe("denied");
  });
  it("only hints when storage may be cleared, with Home Screen advice on iOS Safari tabs", () => {
    expect(storageHint("persisted", { ios: true, standalone: false })).toBeNull();
    expect(storageHint("denied", { ios: false, standalone: false })).not.toMatch(/Home Screen/);
    expect(storageHint("denied", { ios: true, standalone: false })).toMatch(/Add to Home Screen/);
    expect(storageHint("unsupported", { ios: true, standalone: true })).not.toMatch(/Home Screen/);
    expect(storageHint("denied", { ios: false, standalone: false })).toMatch(/recovery backup/);
  });
});
