import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClientEvent, ConnectionState } from "@/components/app/realtime-provider";
import type { MessagePage, MessageView } from "@/server/messages";

// This drives the actual hook with a small effect/state harness, not a React renderer.
// The unchanged initial-community-sync Playwright test covers real React/provider/browser ordering.
const harness = vi.hoisted(() => {
  type Slot = { value?: unknown; deps?: readonly unknown[]; cleanup?: () => void };
  let slots: Slot[] = [];
  let cursor = 0;
  let effects: (() => void)[] = [];
  const listeners = new Set<(event: ClientEvent) => void>();
  const replay: ClientEvent[] = [];
  const same = (a: readonly unknown[] | undefined, b: readonly unknown[]) =>
    a !== undefined && a.length === b.length && a.every((value, index) => Object.is(value, b[index]));
  const slot = (): Slot => slots[cursor++] ?? (slots[cursor - 1] = {});
  const realtime = {
    state: "connecting" as ConnectionState,
    subscribe(listener: (event: ClientEvent) => void) {
      listeners.add(listener);
      for (const event of replay) listener(event);
      return () => { listeners.delete(listener); };
    },
  };
  return {
    realtime, replay, listeners,
    emit(event: ClientEvent) { for (const listener of listeners) listener(event); },
    render<T>(Hook: () => T): T {
      cursor = 0;
      const value = Hook();
      const pending = effects;
      effects = [];
      for (const effect of pending) effect();
      return value;
    },
    unmount() {
      for (const current of slots) current.cleanup?.();
    },
    reset() {
      slots = []; cursor = 0; effects = []; listeners.clear(); replay.length = 0;
      realtime.state = "connecting";
    },
    react: {
      useRef<T>(value: T) {
        const current = slot();
        current.value ??= { current: value };
        // Heterogeneous slots are narrowed by the hook's stable call order.
        return current.value as { current: T };
      },
      useState<T>(initial: T) {
        const current = slot();
        if (!("value" in current)) current.value = initial;
        return [current.value as T, (update: T | ((previous: T) => T)) => {
          current.value = typeof update === "function" ? (update as (previous: T) => T)(current.value as T) : update;
        }] as const;
      },
      useCallback<T>(callback: T, deps: readonly unknown[]) {
        const current = slot();
        if (!same(current.deps, deps)) { current.value = callback; current.deps = deps; }
        return current.value as T;
      },
      useEffect(setup: () => void | (() => void), deps: readonly unknown[]) {
        const current = slot();
        if (same(current.deps, deps)) return;
        current.deps = deps;
        effects.push(() => {
          current.cleanup?.();
          const cleanup = setup();
          current.cleanup = typeof cleanup === "function" ? cleanup : undefined;
        });
      },
    },
  };
});

vi.mock("react", () => harness.react);
vi.mock("@/components/app/realtime-provider", () => ({ useRealtime: () => harness.realtime }));

import { useChannelMessages } from "@/components/app/chat/use-channel-messages";

const message = (id: string, patch: Partial<MessageView> = {}): MessageView => ({
  id, channelId: "channel", authorId: "author", authorName: "Author", authorAvatar: null, authorBot: false, authorImported: false,
  content: id, createdAt: "2026-01-01T00:00:00.000Z", editedAt: null,
  attachments: [], assets: [], mentions: [], replyTo: null, reactions: [], pinned: false, threadId: null, thread: null,
  ...patch,
});
const page = (messages: MessageView[], hasMore = false): MessagePage => ({ messages, hasMore });

type Pending = { url: string; subscribers: number; signal: AbortSignal | null | undefined; finish: (page: MessagePage) => void; fail: (error: Error) => void };
let requests: Pending[];
let props: { channelId: string; initialPage: MessagePage; threadId: string | null };
function Hook() { return useChannelMessages(props.channelId, props.initialPage, props.threadId); }
const view = () => harness.render(Hook);
const ids = () => view().messages.map((message) => message.id);
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

beforeEach(() => {
  harness.reset();
  requests = [];
  props = { channelId: "channel", initialPage: page([message("02")]), threadId: null };
  vi.stubGlobal("fetch", vi.fn((url: string, init?: RequestInit) => new Promise<Response>((resolve, reject) => {
    // Deliberately allow completion after abort to prove the hook also fences stale responses.
    requests.push({ url, subscribers: harness.listeners.size, signal: init?.signal,
      finish: (page) => resolve(new Response(JSON.stringify(page))), fail: reject });
  })));
});
afterEach(() => { harness.unmount(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("community message catch-up", () => {
  it.each([false, true])("subscribes before first-ready catch-up (already open: %s), then shows the missed UUID once", async (alreadyOpen) => {
    harness.replay.push({ type: "message.created", message: message("03") });
    if (alreadyOpen) harness.realtime.state = "open";
    view();
    expect(harness.listeners.size).toBe(1);
    expect(ids()).toEqual(["02", "03"]);
    if (!alreadyOpen) {
      expect(requests).toHaveLength(0);
      harness.realtime.state = "open";
      view();
    }
    expect(requests).toHaveLength(1);
    expect(requests[0].subscribers).toBe(1);
    // A message arriving after subscription but before the GET completes must survive it.
    harness.emit({ type: "message.created", message: message("05") });
    requests[0].finish(page([message("02"), message("03"), message("04")]));
    await flush();
    expect(ids()).toEqual(["02", "03", "04", "05"]);
    harness.emit({ type: "message.created", message: message("04") });
    expect(ids().filter((id) => id === "04")).toHaveLength(1);
    expect(requests).toHaveLength(1);
  });

  it("joins initial-open to reconnect work, and takes a trailing snapshot after resync during an active GET", async () => {
    view();
    harness.emit({ type: "resync" });
    harness.realtime.state = "open";
    view();
    expect(requests).toHaveLength(1);
    requests[0].finish(page([message("02"), message("03")]));
    await flush();
    expect(ids()).toEqual(["02", "03"]);
    expect(requests).toHaveLength(1);
    harness.emit({ type: "resync" });
    harness.emit({ type: "resync" });
    harness.emit({ type: "resync" });
    expect(requests).toHaveLength(2);
    requests[1].finish(page([message("02"), message("03")]));
    await flush();
    expect(requests).toHaveLength(3);
    requests[2].finish(page([message("02"), message("03"), message("04")]));
    await flush();
    expect(ids()).toEqual(["02", "03", "04"]);
    expect(requests).toHaveLength(3);
  });

  it("applies missed history during continuous live creates and preserves fresh edit/delete/reaction/pin and reply previews", async () => {
    const original = message("02");
    const reply = message("03", { replyTo: { id: "02", authorId: "author", authorName: "Author", authorImported: false, excerpt: "02" } });
    props.initialPage = page([original, reply, message("04"), message("05")]);
    harness.realtime.state = "open";
    view();
    const edited = message("02", { content: "fresh edit", editedAt: "2026-01-01T00:01:00.000Z", pinned: true,
      reactions: [{ emoji: "👍", userIds: ["author"] }] });
    harness.emit({ type: "message.updated", message: edited });
    harness.emit({ type: "message.deleted", channelId: "channel", messageId: "04" });
    view().remove("05");
    view().upsert(message("07", { content: "successful local send" }));
    for (const id of ["08", "09", "10"]) harness.emit({ type: "message.created", message: message(id) });
    requests[0].finish(page([original, reply, message("04"), message("05"), message("06")]));
    await flush();
    expect(ids()).toEqual(["02", "03", "06", "07", "08", "09", "10"]);
    expect(view().messages.find((m) => m.id === "02")).toEqual(edited);
    expect(view().messages.find((m) => m.id === "03")?.replyTo?.excerpt).toBe("fresh edit");
    expect(requests).toHaveLength(1);
    // Completed journals must not reapply an old edit or resurrect local sends on later resync.
    harness.emit({ type: "resync" });
    requests[1].finish(page([message("02", { content: "later authoritative edit" })]));
    await flush();
    expect(view().messages).toEqual([message("02", { content: "later authoritative edit" })]);
  });

  it("preserves live root summaries without duplicate increments and bounds their follow-up under continuous replies", async () => {
    const root = message("02", { thread: { count: 1, lastAt: "2026-01-01T00:00:00.000Z" } });
    props.initialPage = page([root]);
    harness.realtime.state = "open";
    view();
    harness.emit({ type: "message.created", message: message("04", { threadId: "02" }) });
    // The snapshot already includes that reply: replaying the increment would incorrectly yield 3.
    requests[0].finish(page([{ ...root, thread: { count: 2, lastAt: root.createdAt } }, message("03")]));
    await flush();
    expect(ids()).toEqual(["02", "03"]);
    expect(view().messages[0].thread?.count).toBe(2);
    expect(requests).toHaveLength(2);
    harness.emit({ type: "message.created", message: message("05", { threadId: "02" }) });
    requests[1].finish(page([root, message("03"), message("06")]));
    await flush();
    expect(ids()).toEqual(["02", "03", "06"]);
    expect(view().messages[0].thread?.count).toBe(3);
    expect(requests).toHaveLength(2);
  });

  it("filters channel/thread events and refreshes only the selected thread", async () => {
    props.threadId = "root";
    props.initialPage = page([message("02", { threadId: "root" })]);
    harness.realtime.state = "open";
    view();
    expect(requests[0].url).toContain("thread=root");
    harness.emit({ type: "message.created", message: message("03", { channelId: "other", threadId: "root" }) });
    harness.emit({ type: "message.created", message: message("04", { threadId: "other" }) });
    harness.emit({ type: "message.created", message: message("05") });
    harness.emit({ type: "message.created", message: message("06", { threadId: "root" }) });
    requests[0].finish(page([message("02", { threadId: "root" }), message("07", { threadId: "root" })]));
    await flush();
    expect(ids()).toEqual(["02", "06", "07"]);
  });

  it.each(["channel", "thread", "unmount"] as const)("aborts and fences a stale GET after %s change", async (change) => {
    harness.realtime.state = "open";
    view();
    harness.emit({ type: "message.created", message: message("03") });
    harness.emit({ type: "resync" });
    const before = ids();
    if (change === "unmount") harness.unmount();
    else {
      props = { ...props, ...(change === "channel" ? { channelId: "other" } : { threadId: "root" }) };
      view();
      expect(requests).toHaveLength(2);
    }
    expect(requests[0].signal?.aborted).toBe(true);
    requests[0].finish(page([message("99")]));
    await flush();
    expect(ids()).toEqual(before);
    expect(requests).toHaveLength(change === "unmount" ? 1 : 2);
  });

  it("releases a failed or timed-out journal so later resync recovers", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    harness.realtime.state = "open";
    view();
    harness.emit({ type: "message.created", message: message("03") });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(requests[0].signal?.aborted).toBe(true);
    requests[0].fail(new Error("aborted"));
    await flush();
    harness.emit({ type: "resync" });
    requests[1].finish(page([message("02"), message("04")]));
    await flush();
    expect(ids()).toEqual(["02", "04"]);
  });

  it("keeps loaded older history and pagination state while catch-up inserts missing newest messages", async () => {
    props.initialPage = page([message("04"), message("05")], true);
    harness.realtime.state = "open";
    view();
    const older = view().loadOlder();
    expect(requests[1].url).toContain("before=04");
    requests[1].finish(page([message("01"), message("02"), message("03")], false));
    await older;
    expect(view().hasMore).toBe(false);
    expect(view().loadingOlder).toBe(false);
    requests[0].finish(page([message("04"), message("05"), message("06")], true));
    await flush();
    expect(ids()).toEqual(["01", "02", "03", "04", "05", "06"]);
    expect(view().hasMore).toBe(false);
  });

  it("aborts older-page loading on unmount and ignores its completion", async () => {
    view();
    const older = view().loadOlder();
    harness.unmount();
    expect(requests[0].signal?.aborted).toBe(true);
    requests[0].finish(page([message("01")]));
    await older;
    expect(ids()).toEqual(["02"]);
    expect(view().loadError).toBeNull();
  });
});
