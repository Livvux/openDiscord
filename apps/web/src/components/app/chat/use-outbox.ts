"use client";

import { useMemo, useSyncExternalStore } from "react";
import { outbox, type OutboxEntry } from "@/lib/outbox";

const NONE: OutboxEntry[] = [];

/** This conversation's unconfirmed sends; the server render has none (sessionStorage is client-only). */
export function useOutbox(userId: string, channelId: string, threadId: string | null): OutboxEntry[] {
  const all = useSyncExternalStore(outbox.subscribe, () => outbox.list(userId), () => NONE);
  return useMemo(() => all.filter((e) => e.channelId === channelId && e.threadId === threadId), [all, channelId, threadId]);
}
