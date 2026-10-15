"use client";

import { useCallback, useEffect, useState } from "react";
import type { MessagePage, MessageView } from "@/server/messages";
import { applyResync, mergeMessages, syncReplies, type LoadedMessages } from "@/lib/merge-messages";
import { useRealtime } from "../realtime-provider";

async function fetchPage(channelId: string, threadId: string | null, before?: string): Promise<MessagePage> {
  const query = new URLSearchParams();
  if (before) query.set("before", before);
  if (threadId) query.set("thread", threadId);
  const res = await fetch(`/api/channels/${channelId}/messages?${query}`, { cache: "no-store" });
  if (!res.ok) throw new Error(((await res.json().catch(() => null)) as { error?: string } | null)?.error ?? "Could not load messages.");
  return res.json() as Promise<MessagePage>;
}

/** Messages of a channel's main list, or of one thread when `threadId` is set; kept live from the stream. */
export function useChannelMessages(channelId: string, initialPage: MessagePage, threadId: string | null = null) {
  const { subscribe } = useRealtime();
  const [state, setState] = useState<LoadedMessages>(initialPage);
  const { messages, hasMore } = state;
  const setMessages = useCallback(
    (update: (m: MessageView[]) => MessageView[]) => setState((s) => ({ ...s, messages: update(s.messages) })),
    [],
  );
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(
    () =>
      subscribe((event) => {
        switch (event.type) {
          case "message.created":
          case "message.updated": {
            const msg = event.message;
            if (msg.channelId !== channelId) break;
            if (msg.threadId === threadId) setMessages((m) => syncReplies(mergeMessages(m, [msg]), { updated: msg }));
            // A new reply in a thread: the main list only bumps its root's summary.
            else if (threadId === null && event.type === "message.created" && msg.threadId) {
              setMessages((m) => m.map((x) => (x.id === msg.threadId
                ? { ...x, thread: { count: (x.thread?.count ?? 0) + 1, lastAt: msg.createdAt } }
                : x)));
            }
            break;
          }
          case "message.deleted":
            if (event.channelId === channelId) setMessages((m) => syncReplies(m.filter((x) => x.id !== event.messageId), { deletedId: event.messageId }));
            break;
          case "resync":
            // Catch up on anything missed while disconnected.
            fetchPage(channelId, threadId).then(
              (page) => setState((s) => applyResync(s, page)),
              () => {},
            );
            break;
        }
      }, { replay: true }),
    [channelId, threadId, subscribe, setMessages],
  );

  const loadOlder = useCallback(async () => {
    if (loadingOlder || messages.length === 0) return;
    setLoadingOlder(true);
    setLoadError(null);
    try {
      const page = await fetchPage(channelId, threadId, messages[0].id);
      setState((s) => ({ messages: mergeMessages(s.messages, page.messages), hasMore: page.hasMore }));
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "Could not load messages.");
    } finally {
      setLoadingOlder(false);
    }
  }, [channelId, threadId, loadingOlder, messages]);

  const upsert = useCallback((message: MessageView) => setMessages((m) => mergeMessages(m, [message])), [setMessages]);
  const remove = useCallback((id: string) => setMessages((m) => syncReplies(m.filter((x) => x.id !== id), { deletedId: id })), [setMessages]);

  return { messages, hasMore, loadingOlder, loadError, loadOlder, upsert, remove };
}
