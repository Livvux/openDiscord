"use client";

import { useCallback, useEffect, useState } from "react";
import type { MessagePage, MessageView } from "@/server/messages";
import { applyResync, mergeMessages, type LoadedMessages } from "@/lib/merge-messages";
import { useRealtime } from "../realtime-provider";

async function fetchPage(channelId: string, before?: string): Promise<MessagePage> {
  const query = before ? `?before=${encodeURIComponent(before)}` : "";
  const res = await fetch(`/api/channels/${channelId}/messages${query}`, { cache: "no-store" });
  if (!res.ok) throw new Error(((await res.json().catch(() => null)) as { error?: string } | null)?.error ?? "Could not load messages.");
  return res.json() as Promise<MessagePage>;
}

export function useChannelMessages(channelId: string, initialPage: MessagePage) {
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
          case "message.updated":
            if (event.message.channelId === channelId) setMessages((m) => mergeMessages(m, [event.message]));
            break;
          case "message.deleted":
            if (event.channelId === channelId) setMessages((m) => m.filter((x) => x.id !== event.messageId));
            break;
          case "resync":
            // Catch up on anything missed while disconnected.
            fetchPage(channelId).then(
              (page) => setState((s) => applyResync(s, page)),
              () => {},
            );
            break;
        }
      }),
    [channelId, subscribe, setMessages],
  );

  const loadOlder = useCallback(async () => {
    if (loadingOlder || messages.length === 0) return;
    setLoadingOlder(true);
    setLoadError(null);
    try {
      const page = await fetchPage(channelId, messages[0].id);
      setState((s) => ({ messages: mergeMessages(s.messages, page.messages), hasMore: page.hasMore }));
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "Could not load messages.");
    } finally {
      setLoadingOlder(false);
    }
  }, [channelId, loadingOlder, messages]);

  const upsert = useCallback((message: MessageView) => setMessages((m) => mergeMessages(m, [message])), [setMessages]);
  const remove = useCallback((id: string) => setMessages((m) => m.filter((x) => x.id !== id)), [setMessages]);

  return { messages, hasMore, loadingOlder, loadError, loadOlder, upsert, remove };
}
