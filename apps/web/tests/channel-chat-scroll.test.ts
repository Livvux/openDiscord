import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isValidElement, type ComponentProps, type ReactNode, type RefObject } from "react";
import type { MessageView } from "@/server/messages";

// Execute ChannelChat's actual effects/handlers with explicit hook and DOM doubles.
// This is not a React renderer; the unchanged Playwright scroll spec covers browser ordering.
const harness = vi.hoisted(() => {
  type Slot = { value?: unknown; deps?: readonly unknown[]; cleanup?: () => void };
  let slots: Slot[] = [];
  let cursor = 0;
  let layouts: (() => void)[] = [];
  let effects: (() => void)[] = [];
  const slot = (): Slot => slots[cursor++] ?? (slots[cursor - 1] = {});
  const effect = (queue: (() => void)[], setup: () => void | (() => void), deps: readonly unknown[]) => {
    const current = slot();
    if (current.deps?.length === deps.length && deps.every((value, index) => Object.is(value, current.deps?.[index]))) return;
    current.deps = deps;
    queue.push(() => {
      current.cleanup?.();
      const cleanup = setup();
      current.cleanup = typeof cleanup === "function" ? cleanup : undefined;
    });
  };
  const messages = {
    messages: [] as MessageView[], hasMore: true, loadingOlder: false, loadError: null,
    loadOlder: vi.fn(async () => {}), upsert: vi.fn(), remove: vi.fn(),
  };
  return {
    messages,
    clearUnread: vi.fn(),
    begin() { cursor = 0; },
    commit() {
      for (const run of [...layouts, ...effects]) run();
      layouts = []; effects = [];
    },
    unmount() { for (const current of slots) current.cleanup?.(); },
    reset() { slots = []; cursor = 0; layouts = []; effects = []; messages.messages = []; },
    react: {
      useRef<T>(value: T) {
        const current = slot();
        current.value ??= { current: value };
        // Stable hook order narrows the heterogeneous test slots.
        return current.value as { current: T };
      },
      useState<T>(initial: T) {
        const current = slot();
        if (!("value" in current)) current.value = initial;
        return [current.value as T, (update: T | ((previous: T) => T)) => {
          current.value = typeof update === "function" ? (update as (previous: T) => T)(current.value as T) : update;
        }] as const;
      },
      useLayoutEffect(setup: () => void | (() => void), deps: readonly unknown[]) { effect(layouts, setup, deps); },
      useEffect(setup: () => void | (() => void), deps: readonly unknown[]) { effect(effects, setup, deps); },
    },
  };
});

vi.mock("react", async (original) => ({ ...await original<typeof import("react")>(), ...harness.react }));
vi.mock("@/app/app/actions", () => ({ markChannelRead: vi.fn(), sendMessage: vi.fn() }));
vi.mock("@/components/app/realtime-provider", () => ({ useRealtime: () => ({ state: "open" }) }));
vi.mock("@/components/app/unread-provider", () => ({ useClearUnread: () => harness.clearUnread }));
vi.mock("@/components/app/chat/use-channel-messages", () => ({ useChannelMessages: () => harness.messages }));
vi.mock("@/components/ui/button", () => ({ Button: "button" }));
vi.mock("@/components/app/chat/composer", () => ({ Composer: () => null }));
vi.mock("@/components/app/chat/message-item", () => ({ MessageItem: () => null, PendingItem: () => null }));
vi.mock("@/components/app/chat/thread-panel", () => ({ ThreadPanel: () => null }));

import { ChannelChat } from "@/components/app/chat/channel-chat";
import { markChannelRead } from "@/app/app/actions";

class ResizeDouble implements ResizeObserver {
  static instances: ResizeDouble[] = [];
  observe = vi.fn();
  unobserve = vi.fn();
  disconnect = vi.fn();
  constructor(private callback: ResizeObserverCallback) { ResizeDouble.instances.push(this); }
  // Delivery after disconnect is intentional: test the callback's own lifetime fence too.
  deliver() { this.callback([], this); }
}

function geometry() {
  let top = 0;
  const writes: number[] = [];
  const element = {
    scrollHeight: 1484, clientHeight: 608,
    get scrollTop() { return top; },
    set scrollTop(value: number) { writes.push(value); top = Math.max(0, Math.min(value, this.scrollHeight - this.clientHeight)); },
  };
  // Only the DOM surface used by the component is modeled; no DOM renderer is installed.
  return { element: element as HTMLDivElement, writes,
    resize(height: number) { element.scrollHeight = height; },
    userScroll(topValue: number) { top = topValue; } };
}

type ElementProps = {
  children?: ReactNode;
  ref?: RefObject<HTMLDivElement | null>;
  onScroll?: (event: { currentTarget: HTMLDivElement }) => void;
  onClick?: () => Promise<void>;
};
function findProps(node: ReactNode, matches: (props: ElementProps) => boolean): ElementProps | undefined {
  if (Array.isArray(node)) {
    for (const child of node) { const found = findProps(child, matches); if (found) return found; }
  } else if (isValidElement<ElementProps>(node)) {
    return matches(node.props) ? node.props : findProps(node.props.children, matches);
  }
}

const props: ComponentProps<typeof ChannelChat> = {
  channel: { id: "channel", name: "general", topic: null, kind: "text", categoryId: null, permissions: 0,
    isPrivate: true, unread: false, mentions: 0, lastReadId: null },
  initialPage: { messages: [], hasMore: true }, currentUserId: "reader", canSend: true, canModerate: false,
  mediaEnabled: false, communityId: "community", lastReadId: null, blockedIds: [],
};
const message = (id: string): MessageView => ({
  id, channelId: "channel", authorId: "author", authorName: "Author", authorAvatar: null, authorBot: false, authorImported: false,
  content: id, createdAt: "2026-01-01T00:00:00.000Z", editedAt: null, attachments: [], assets: [], mentions: [],
  replyTo: null, reactions: [], pinned: false, threadId: null, thread: null,
});

function render(scroller = geometry(), content = geometry()) {
  harness.begin();
  const tree = ChannelChat(props);
  const scrollProps = findProps(tree, (candidate) => !!candidate.onScroll);
  if (!scrollProps?.ref || !scrollProps.onScroll) throw new Error("Missing ChannelChat scroller");
  const contentProps = findProps(scrollProps.children, (candidate) => !!candidate.ref);
  if (!contentProps?.ref) throw new Error("Missing ChannelChat content ref");
  scrollProps.ref.current = scroller.element;
  contentProps.ref.current = content.element;
  harness.commit();
  return {
    scroller, content, observer: ResizeDouble.instances.at(-1)!,
    scroll(top: number) { scroller.userScroll(top); scrollProps.onScroll!({ currentTarget: scroller.element }); },
    async loadOlder() {
      const button = findProps(tree, (candidate) => !!candidate.onClick);
      if (!button?.onClick) throw new Error("Missing Load older button");
      await button.onClick();
    },
  };
}

beforeEach(() => {
  harness.reset(); ResizeDouble.instances = []; vi.clearAllMocks(); vi.useFakeTimers();
  vi.stubGlobal("ResizeObserver", ResizeDouble);
  vi.stubGlobal("document", { visibilityState: "hidden", addEventListener: vi.fn(), removeEventListener: vi.fn() });
  vi.stubGlobal("window", new EventTarget());
  vi.stubGlobal("requestAnimationFrame", vi.fn());
  vi.stubGlobal("fetch", vi.fn());
});
afterEach(() => { harness.unmount(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("ChannelChat read-marker lifecycle", () => {
  it("keeps a failed transport pending, retries on visibility and clears only after success", async () => {
    vi.stubGlobal("document", Object.assign(new EventTarget(), { visibilityState: "visible" }));
    harness.messages.messages = [message("latest")];
    vi.mocked(markChannelRead).mockRejectedValueOnce(new TypeError("Load failed"))
      .mockResolvedValueOnce({ ok: true, data: undefined });
    render();
    await vi.advanceTimersByTimeAsync(500);
    expect(markChannelRead).toHaveBeenCalledTimes(1);
    expect(harness.clearUnread).not.toHaveBeenCalled();
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(0);
    expect(markChannelRead).toHaveBeenCalledTimes(2);
    expect(harness.clearUnread).toHaveBeenCalledExactlyOnceWith("channel");
    window.dispatchEvent(new Event("online"));
    expect(markChannelRead).toHaveBeenCalledTimes(2);
  });

  it("serializes pending requests and fences a late successful result after cleanup", async () => {
    vi.stubGlobal("document", Object.assign(new EventTarget(), { visibilityState: "visible" }));
    harness.messages.messages = [message("latest")];
    let complete!: (result: { ok: true; data: undefined }) => void;
    vi.mocked(markChannelRead).mockReturnValueOnce(new Promise((resolve) => { complete = resolve; }));
    render();
    await vi.advanceTimersByTimeAsync(500);
    document.dispatchEvent(new Event("visibilitychange"));
    window.dispatchEvent(new Event("online"));
    expect(markChannelRead).toHaveBeenCalledTimes(1);
    harness.unmount();
    complete({ ok: true, data: undefined });
    await vi.advanceTimersByTimeAsync(0);
    expect(harness.clearUnread).not.toHaveBeenCalled();
    window.dispatchEvent(new Event("online"));
    expect(markChannelRead).toHaveBeenCalledTimes(1);
  });
});

describe("ChannelChat content-size pinning", () => {
  it("observes content and follows growth after the layout effect already pinned the view", () => {
    const view = render();
    expect(view.observer.observe).toHaveBeenCalledTimes(1);
    expect(view.observer.observe).toHaveBeenCalledWith(view.content.element);
    expect(view.scroller.element.scrollTop).toBe(876);
    view.scroller.writes.length = 0;
    view.scroller.resize(1504);
    view.observer.deliver();
    expect(view.scroller.writes).toEqual([1504]);
    expect(view.scroller.element.scrollTop).toBe(896);
  });

  it.each([119, 120, 500])("respects the existing scroll handler's strict 120px boundary (gap %s)", (gap) => {
    const view = render();
    view.scroll(876 - gap);
    view.scroller.writes.length = 0;
    view.scroller.resize(1704);
    view.observer.deliver();
    expect(view.scroller.writes).toEqual(gap < 120 ? [1704] : []);
    if (gap >= 120) expect(view.scroller.element.scrollTop).toBe(876 - gap);
    // The existing observer must read the later intent from the same actual handler.
    view.scroll(1096);
    view.scroller.writes.length = 0;
    view.scroller.resize(1724);
    view.observer.deliver();
    expect(view.scroller.writes).toEqual([1724]);
  });

  it("gives a pending older-page anchor priority even while bottom intent is true", async () => {
    const view = render();
    await view.loadOlder();
    expect(harness.messages.loadOlder).toHaveBeenCalledTimes(1);
    view.scroller.writes.length = 0;
    view.scroller.resize(1784);
    view.observer.deliver();
    expect(view.scroller.writes).toEqual([]);
  });

  it("preserves the existing prepend delta and leaves an up-scrolled reader alone after anchor reset", async () => {
    harness.messages.messages = [message("02")];
    const view = render();
    view.scroll(100);
    await view.loadOlder();
    view.scroller.resize(1784);
    harness.messages.messages = [message("01"), ...harness.messages.messages];
    view.scroller.writes.length = 0;
    render(view.scroller, view.content);
    expect(view.scroller.writes).toEqual([400]);
    view.scroller.writes.length = 0;
    view.scroller.resize(1804);
    view.observer.deliver();
    expect(view.scroller.writes).toEqual([]);
    expect(view.scroller.element.scrollTop).toBe(400);
  });

  it("disconnects and fences a late callback across cleanup and a fresh component lifetime", () => {
    const old = render();
    harness.unmount();
    expect(old.observer.disconnect).toHaveBeenCalledTimes(1);
    harness.reset();
    const fresh = render();
    old.scroller.writes.length = 0;
    fresh.scroller.writes.length = 0;
    old.observer.deliver();
    expect(old.scroller.writes).toEqual([]);
    expect(fresh.scroller.writes).toEqual([]);
    fresh.scroller.resize(1504);
    fresh.observer.deliver();
    expect(fresh.scroller.writes).toEqual([1504]);
  });

  it.each(["scroller", "content"])("fences a callback whose captured %s node has been replaced", (replaced) => {
    const old = render();
    const replacement = render(replaced === "scroller" ? geometry() : old.scroller, replaced === "content" ? geometry() : old.content);
    old.scroller.writes.length = 0;
    old.observer.deliver();
    expect(old.scroller.writes).toEqual([]);
    expect(replacement.scroller.writes).toEqual([]);
  });

  it("does only bounded work per resize delivery without timers, frames, or requests", () => {
    const view = render();
    view.scroller.writes.length = 0;
    const timers = vi.getTimerCount();
    for (const height of [1504, 1524, 1544]) { view.scroller.resize(height); view.observer.deliver(); }
    expect(view.scroller.writes).toEqual([1504, 1524, 1544]);
    expect(vi.getTimerCount()).toBe(timers);
    expect(requestAnimationFrame).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(ResizeDouble.instances).toHaveLength(1);
  });
});
