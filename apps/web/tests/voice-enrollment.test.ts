import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readExistingDmEnrollment } from "@/lib/dm/enrollment";
import { parseVoiceRoomName, voiceRoomName } from "@/lib/voice/room";

const id = "00000000-0000-4000-8000-000000000001", secret = "a".repeat(64), storeKey = "b".repeat(64);
afterEach(() => vi.unstubAllGlobals());
describe("existing DM enrollment prerequisite", () => {
  it("returns only existing canonical anchor possession without writing or exposing the store key", () => {
    const storage = { getItem: vi.fn(() => JSON.stringify({ id, secret, storeKey })), setItem: vi.fn(), removeItem: vi.fn(), clear: vi.fn() };
    vi.stubGlobal("window", { localStorage: storage });
    const enrollment = readExistingDmEnrollment("account");
    expect(enrollment).toEqual({ id, secret });
    expect(Object.keys(enrollment!)).toEqual(["id", "secret"]);
    expect(storage.getItem).toHaveBeenCalledExactlyOnceWith("opendiscord.dm.device:account");
    for (const mutate of [storage.setItem, storage.removeItem, storage.clear]) expect(mutate).not.toHaveBeenCalled();
  });
  it("fails to an explicit null prerequisite without repairs for missing or invalid metadata", () => {
    for (const saved of [null, "{", "null", JSON.stringify({ id, secret }), JSON.stringify({ id, secret: "a".repeat(63), storeKey }), JSON.stringify({ id: "bad", secret, storeKey })]) {
      const storage = { getItem: vi.fn(() => saved), setItem: vi.fn(), removeItem: vi.fn() };
      vi.stubGlobal("window", { localStorage: storage });
      expect(readExistingDmEnrollment("account")).toBeNull();
      expect(storage.setItem).not.toHaveBeenCalled(); expect(storage.removeItem).not.toHaveBeenCalled();
    }
  });
  it("does not initialize storage/native state on SSR or inaccessible localStorage", () => {
    vi.stubGlobal("window", undefined);
    expect(readExistingDmEnrollment("account")).toBeNull();
    vi.stubGlobal("window", { get localStorage() { throw new Error("Storage denied"); } });
    expect(readExistingDmEnrollment("account")).toBeNull();
    const source = readFileSync(new URL("../src/lib/dm/enrollment.ts", import.meta.url), "utf8");
    expect([...source.matchAll(/^import .*from "([^"]+)"/gm)].map(match => match[1])).toEqual(["zod"]);
    expect(source).not.toMatch(/PrivateMessaging|HistoryStore|indexedDB|fetch\(|setItem\(|removeItem\(/);
  });
});
describe("owned Voice room namespace", () => {
  it("round-trips only the whole canonical generation room", () => {
    const binding = { channelId: id, callId: "00000000-0000-4000-8000-000000000002", generation: 12 };
    const room = voiceRoomName(binding);
    expect(parseVoiceRoomName(room)).toEqual(binding);
    for (const invalid of [id, `${room}:extra`, `prefix:${room}`, room.replace(":12", ":012"), room.replace(":12", ":0"), room.replace(":12", ":1e2"), room.replace(":12", ":9007199254740992"), room.replace(id, "bad")]) expect(parseVoiceRoomName(invalid)).toBeNull();
  });
});
