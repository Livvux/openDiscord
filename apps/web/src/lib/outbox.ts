import type { Mention } from "./mentions";

/**
 * Community sends whose delivery is not confirmed yet, kept in this tab's sessionStorage so a reload
 * or navigation can offer Retry with the same send id (the server deduplicates it). DMs never enter.
 * Not encrypted at rest: community messages are server-visible on delivery and a key kept in the same
 * browser profile would protect nothing. See docs/PRIVACY.md and docs/DECISIONS.md.
 */
/** unconfirmed: outcome unknown; unsent: the server has no record of it; failed: refused; deleted: sent, removed since. */
export type OutboxState = "sending" | "unconfirmed" | "unsent" | "failed" | "deleted";

export interface OutboxEntry {
  /** Doubles as the server send id (`message_send.transaction_id`). */
  id: string;
  channelId: string;
  threadId: string | null;
  content: string;
  mentions: Mention[];
  attachmentIds: string[];
  images: number;
  /** Only the id: the reply target's content is never copied into storage. */
  replyToId: string | null;
  publicGeneration: string | null;
  createdAt: number;
  state: OutboxState;
  error: string | null;
}

export const OUTBOX_PREFIX = "od.outbox.v1:";
export const OUTBOX_TTL_MS = 24 * 60 * 60_000;
export const OUTBOX_CAP = 20;
const STATES: readonly string[] = ["sending", "unconfirmed", "unsent", "failed", "deleted"];

const isString = (value: unknown): value is string => typeof value === "string";
const isNullableString = (value: unknown) => value === null || isString(value);

/** sessionStorage is user-writable: anything malformed is dropped, not trusted. */
function parseEntry(value: unknown): OutboxEntry | null {
  if (!value || typeof value !== "object") return null;
  const e = value as Record<string, unknown>;
  const valid = isString(e.id) && isString(e.channelId) && isNullableString(e.threadId) && isString(e.content)
    && Array.isArray(e.mentions) && e.mentions.every((m) => !!m && isString((m as Mention).id) && isString((m as Mention).name))
    && Array.isArray(e.attachmentIds) && e.attachmentIds.every(isString) && typeof e.images === "number"
    && isNullableString(e.replyToId) && isNullableString(e.publicGeneration) && typeof e.createdAt === "number"
    && isString(e.state) && STATES.includes(e.state) && isNullableString(e.error);
  if (!valid) return null;
  return {
    id: e.id as string, channelId: e.channelId as string, threadId: e.threadId as string | null, content: e.content as string,
    mentions: (e.mentions as Mention[]).map((m) => ({ id: m.id, name: m.name })), attachmentIds: e.attachmentIds as string[],
    images: e.images as number, replyToId: e.replyToId as string | null, publicGeneration: e.publicGeneration as string | null,
    createdAt: e.createdAt as number, state: e.state as OutboxState, error: e.error as string | null,
  };
}

function parse(raw: string | null): OutboxEntry[] {
  if (!raw) return [];
  try {
    const value: unknown = JSON.parse(raw);
    return Array.isArray(value) ? value.map(parseEntry).filter((e): e is OutboxEntry => e !== null) : [];
  } catch {
    return [];
  }
}

export function createOutbox(storage: () => Storage | null, now: () => number = Date.now) {
  let user: string | null = null;
  let entries: OutboxEntry[] = [];
  const listeners = new Set<() => void>();
  const emit = () => listeners.forEach((listener) => listener());

  function prune(list: OutboxEntry[]): OutboxEntry[] {
    const fresh = list.filter((e) => now() - e.createdAt < OUTBOX_TTL_MS).sort((a, b) => a.createdAt - b.createdAt);
    return fresh.slice(-OUTBOX_CAP);
  }

  // Storage can be unavailable or full; the outbox then still works for this page's lifetime.
  function persist() {
    if (!user) return;
    try {
      const store = storage();
      if (!store) return;
      if (entries.length) store.setItem(OUTBOX_PREFIX + user, JSON.stringify(entries));
      else store.removeItem(OUTBOX_PREFIX + user);
    } catch { /* memory copy stays authoritative */ }
  }

  function removeKeys(keep: (userId: string) => boolean) {
    try {
      const store = storage();
      if (!store) return;
      const keys = Array.from({ length: store.length }, (_, i) => store.key(i)).filter((key): key is string => !!key?.startsWith(OUTBOX_PREFIX));
      keys.filter((key) => !keep(key.slice(OUTBOX_PREFIX.length))).forEach((key) => store.removeItem(key));
    } catch { /* nothing readable to remove */ }
  }

  /** Loads a user's entries once per page; nothing is in flight after a load, so "sending" is unconfirmed. */
  function load(userId: string) {
    let raw: string | null = null;
    try { raw = storage()?.getItem(OUTBOX_PREFIX + userId) ?? null; } catch { /* treated as empty */ }
    user = userId;
    entries = prune(parse(raw)).map((e) => e.state === "sending" ? { ...e, state: "unconfirmed" } : e);
    // Same tab, different account: the previous account's unsent messages go.
    removeKeys((id) => id === userId);
    persist();
  }

  function set(userId: string, next: (list: OutboxEntry[]) => OutboxEntry[]) {
    // A late result for an account that is no longer signed in here must not resurrect its entries.
    if (user !== userId) return;
    entries = prune(next(entries));
    persist();
    emit();
  }

  return {
    /** Stable reference while nothing changes (for useSyncExternalStore); prunes expired entries on every read. */
    list(userId: string): OutboxEntry[] {
      if (user !== userId) load(userId);
      const pruned = prune(entries);
      if (pruned.length !== entries.length) {
        entries = pruned;
        persist();
      }
      return entries;
    },
    /** Adds a new send, stamped with the current time. */
    put(userId: string, entry: Omit<OutboxEntry, "createdAt">) {
      if (user !== userId) load(userId);
      // Only the known fields are kept, so nothing extra (e.g. a reply's MessageView) reaches storage.
      const clean = parseEntry({ ...entry, createdAt: now() });
      if (clean) set(userId, (list) => [...list.filter((e) => e.id !== clean.id), clean]);
    },
    update(userId: string, id: string, patch: Partial<Pick<OutboxEntry, "state" | "error">>) {
      set(userId, (list) => list.map((e) => e.id === id ? { ...e, ...patch } : e));
    },
    remove(userId: string, id: string) {
      set(userId, (list) => list.filter((e) => e.id !== id));
    },
    /** Sign-out: every account's entries in this tab. */
    clear() {
      user = null;
      entries = [];
      removeKeys(() => false);
      emit();
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
}

export const outbox = createOutbox(() => (typeof window === "undefined" ? null : window.sessionStorage));
