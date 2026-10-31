import { describe, expect, it } from "vitest";
import { clearDrafts, readDraft, writeDraft } from "@/lib/chat-drafts";
import { createOutbox, OUTBOX_CAP, OUTBOX_PREFIX, OUTBOX_TTL_MS, type OutboxEntry } from "@/lib/outbox";

const USER = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";

class FakeStorage implements Storage {
  private items = new Map<string, string>();
  get length() { return this.items.size; }
  clear() { this.items.clear(); }
  getItem(key: string) { return this.items.get(key) ?? null; }
  key(index: number) { return [...this.items.keys()][index] ?? null; }
  removeItem(key: string) { this.items.delete(key); }
  setItem(key: string, value: string) { this.items.set(key, value); }
}

function setup(start = 1_000_000) {
  const storage = new FakeStorage();
  const clock = { now: start };
  const outbox = createOutbox(() => storage, () => clock.now);
  return { storage, clock, outbox };
}

const entry = (id: string, createdAt: number, extra: Partial<OutboxEntry> = {}): OutboxEntry => ({
  id, channelId: "c1", threadId: null, content: `message ${id}`, mentions: [{ id: OTHER, name: "Bea" }], attachmentIds: [],
  images: 0, replyToId: null, publicGeneration: null, createdAt, state: "sending", error: null, ...extra,
});
const stored = (storage: Storage, userId = USER) => JSON.parse(storage.getItem(OUTBOX_PREFIX + userId) ?? "[]") as OutboxEntry[];

describe("outbox", () => {
  it("persists entries per user and removes them when settled", () => {
    const { storage, outbox } = setup();
    outbox.put(USER, entry("a", 1_000_000));
    expect(stored(storage).map((e) => e.id)).toEqual(["a"]);
    outbox.update(USER, "a", { state: "unconfirmed", error: "Failed to fetch" });
    expect(stored(storage)[0]).toMatchObject({ state: "unconfirmed", error: "Failed to fetch" });
    outbox.remove(USER, "a");
    expect(storage.getItem(OUTBOX_PREFIX + USER)).toBeNull();
  });

  it("restores after a reload as unconfirmed and never stores a reply message view", () => {
    const { storage, clock } = setup();
    const before = createOutbox(() => storage, () => clock.now);
    const withView = { ...entry("a", clock.now, { replyToId: "m1" }), replyTo: { id: "m1", content: "someone else's words" } };
    before.put(USER, withView as OutboxEntry);
    expect(storage.getItem(OUTBOX_PREFIX + USER)).not.toContain("someone else's words");
    // A fresh page: the same storage, a new module instance.
    const after = createOutbox(() => storage, () => clock.now);
    const [restored] = after.list(USER);
    expect(restored).toMatchObject({ id: "a", replyToId: "m1", state: "unconfirmed" });
    expect(restored).not.toHaveProperty("replyTo");
    expect(storage.getItem(OUTBOX_PREFIX + USER)).not.toContain("someone else's words");
  });

  it("drops entries older than 24 hours on read", () => {
    const { storage, clock, outbox } = setup();
    outbox.put(USER, entry("old", clock.now));
    clock.now += OUTBOX_TTL_MS - 1;
    outbox.put(USER, entry("new", clock.now));
    expect(outbox.list(USER).map((e) => e.id)).toEqual(["old", "new"]);
    clock.now += 2;
    expect(outbox.list(USER).map((e) => e.id)).toEqual(["new"]);
    expect(stored(storage).map((e) => e.id)).toEqual(["new"]);
  });

  it("keeps at most the newest 20 entries", () => {
    const { storage, clock, outbox } = setup();
    for (let i = 0; i < OUTBOX_CAP + 5; i++) { clock.now += 1; outbox.put(USER, entry(`e${i}`, clock.now)); }
    const ids = outbox.list(USER).map((e) => e.id);
    expect(ids).toHaveLength(OUTBOX_CAP);
    expect(ids[0]).toBe("e5");
    expect(stored(storage)).toHaveLength(OUTBOX_CAP);
  });

  it("returns the same list reference until something changes", () => {
    const { outbox, clock } = setup();
    outbox.put(USER, entry("a", clock.now));
    expect(outbox.list(USER)).toBe(outbox.list(USER));
  });

  it("deletes other accounts' entries when a user loads in the same tab", () => {
    const { storage, clock } = setup();
    storage.setItem(OUTBOX_PREFIX + OTHER, JSON.stringify([entry("theirs", clock.now)]));
    storage.setItem("unrelated", "kept");
    const outbox = createOutbox(() => storage, () => clock.now);
    expect(outbox.list(USER)).toEqual([]);
    expect(storage.getItem(OUTBOX_PREFIX + OTHER)).toBeNull();
    expect(storage.getItem("unrelated")).toBe("kept");
  });

  it("ignores late results for an account that is no longer loaded", () => {
    const { storage, clock, outbox } = setup();
    outbox.put(USER, entry("a", clock.now));
    outbox.list(OTHER);
    outbox.update(USER, "a", { state: "unconfirmed" });
    expect(storage.getItem(OUTBOX_PREFIX + USER)).toBeNull();
    expect(outbox.list(OTHER)).toEqual([]);
  });

  it("sign-out clears every outbox key", () => {
    const { storage, clock, outbox } = setup();
    outbox.put(USER, entry("a", clock.now));
    storage.setItem(OUTBOX_PREFIX + OTHER, "[]");
    storage.setItem("unrelated", "kept");
    let notified = 0;
    outbox.subscribe(() => notified++);
    outbox.clear();
    expect(Object.keys(Object.fromEntries(Array.from({ length: storage.length }, (_, i) => [storage.key(i), 1])))).toEqual(["unrelated"]);
    expect(notified).toBe(1);
    outbox.update(USER, "a", { state: "failed" });
    expect(storage.getItem(OUTBOX_PREFIX + USER)).toBeNull();
  });

  it("drops malformed or tampered storage instead of trusting it", () => {
    const { storage, clock } = setup();
    storage.setItem(OUTBOX_PREFIX + USER, JSON.stringify([entry("ok", clock.now), { id: 1 }, { ...entry("bad", clock.now), state: "sent" }, null]));
    expect(createOutbox(() => storage, () => clock.now).list(USER).map((e) => e.id)).toEqual(["ok"]);
    storage.setItem(OUTBOX_PREFIX + USER, "{not json");
    expect(createOutbox(() => storage, () => clock.now).list(USER)).toEqual([]);
  });

  it("keeps working in memory when storage throws", () => {
    const outbox = createOutbox(() => { throw new Error("SecurityError"); });
    outbox.put(USER, entry("a", Date.now()));
    expect(outbox.list(USER).map((e) => e.id)).toEqual(["a"]);
  });
});

describe("chat drafts", () => {
  it("keeps text and reply per scope, deletes empty drafts and scopes to the signed-in user", () => {
    clearDrafts();
    writeDraft(USER, "channel:1", { text: "hello", replyTo: { id: "m1" } });
    writeDraft(USER, "dm:9", { text: "private", replyTo: null });
    expect(readDraft(USER, "channel:1")).toEqual({ text: "hello", replyTo: { id: "m1" } });
    expect(readDraft(USER, "dm:9")?.text).toBe("private");
    expect(readDraft(USER, "thread:1")).toBeUndefined();
    writeDraft(USER, "dm:9", { text: "  ", replyTo: null });
    expect(readDraft(USER, "dm:9")).toBeUndefined();
    // A different account in the same tab starts empty and the previous drafts are gone.
    expect(readDraft(OTHER, "channel:1")).toBeUndefined();
    expect(readDraft(USER, "channel:1")).toBeUndefined();
  });

  it("sign-out clears drafts", () => {
    writeDraft(USER, "channel:1", { text: "hello", replyTo: null });
    clearDrafts();
    expect(readDraft(USER, "channel:1")).toBeUndefined();
  });
});
