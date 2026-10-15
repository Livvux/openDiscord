import type { MessagePage, MessageView } from "@/server/messages";

export interface LoadedMessages {
  /** Oldest first. */
  messages: MessageView[];
  hasMore: boolean;
}

/** Merges by id and keeps oldest-first order; UUIDv7 strings sort chronologically. */
export function mergeMessages(current: readonly MessageView[], incoming: readonly MessageView[]): MessageView[] {
  const byId = new Map(current.map((m) => [m.id, m]));
  for (const m of incoming) byId.set(m.id, m);
  return [...byId.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * Reconciles local state with a fresh newest page after missed events. The page is authoritative for
 * its id range (so deletions made while offline disappear). If more was missed than one page holds,
 * local history is dropped instead of leaving a silent gap.
 */
export function applyResync(current: LoadedMessages, page: MessagePage): LoadedMessages {
  if (!page.hasMore) return { messages: page.messages, hasMore: false };
  const oldestInPage = page.messages[0]?.id;
  const newestLocal = current.messages.at(-1)?.id;
  if (!oldestInPage || !newestLocal || newestLocal < oldestInPage) return { messages: page.messages, hasMore: true };
  const olderThanPage = current.messages.filter((m) => m.id < oldestInPage);
  return { messages: [...olderThanPage, ...page.messages], hasMore: current.hasMore };
}
