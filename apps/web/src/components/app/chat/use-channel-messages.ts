"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { assetTokens, type AssetView } from "@/lib/community-assets";
import type { MessagePage, MessageView } from "@/server/messages";
import { applyResync, mergeMessages, syncReplies, type LoadedMessages } from "@/lib/merge-messages";
import { useRealtime } from "../realtime-provider";

type MessageUpdate = (messages: MessageView[]) => MessageView[];
type Catchup = { controller: AbortController; updates: MessageUpdate[]; summaryRoots: Set<string>; timeout?: ReturnType<typeof setTimeout> };

async function fetchPage(channelId: string, threadId: string | null, before?: string, signal?: AbortSignal): Promise<MessagePage> {
  const query = new URLSearchParams();
  if (before) query.set("before", before);
  if (threadId) query.set("thread", threadId);
  const res = await fetch(`/api/channels/${channelId}/messages?${query}`, { cache: "no-store", signal });
  if (!res.ok) throw new Error(((await res.json().catch(() => null)) as { error?: string } | null)?.error ?? "Could not load messages.");
  return res.json() as Promise<MessagePage>;
}

/** Messages of a channel's main list, or of one thread when `threadId` is set; kept live from the stream. */
export function useChannelMessages(channelId: string, initialPage: MessagePage, threadId: string | null = null) {
  const { subscribe, state: connectionState } = useRealtime();
  const libraryGeneration = useRef(0);
  const catchup = useRef<Catchup | null>(null);
  const requestCatchup = useRef<((queueIfRunning: boolean) => void) | null>(null);
  const scopeSignal = useRef<AbortSignal | null>(null);
  const [state, setState] = useState<LoadedMessages>(initialPage);
  const { messages, hasMore } = state;
  const setMessages = useCallback((update: MessageUpdate, summaryRoot?: string) => {
    const pending = catchup.current;
    if (pending && !pending.controller.signal.aborted) {
      if (summaryRoot) pending.summaryRoots.add(summaryRoot);
      else pending.updates.push(update);
    }
    setState((s) => ({ ...s, messages: update(s.messages) }));
  }, []);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let stopped = false;
    let queued = false;
    const scope = new AbortController();
    scopeSignal.current = scope.signal;

    const refresh = (queueIfRunning: boolean, allowSummaryFollowup = true) => {
      if (stopped) return;
      if (catchup.current) {
        queued ||= queueIfRunning;
        return;
      }
      const request: Catchup = { controller: new AbortController(), updates: [], summaryRoots: new Set() };
      catchup.current = request;
      // Bound the temporary journal to one GET, including a stalled network.
      request.timeout = setTimeout(() => {
        request.controller.abort();
        request.updates = [];
        request.summaryRoots.clear();
      }, 30_000);
      void fetchPage(channelId, threadId, undefined, request.controller.signal).then((page) => {
        if (stopped || request.controller.signal.aborted) return;
        const updates = [...request.updates];
        const summaryRoots = new Set(request.summaryRoots);
        setState((s) => {
          if (stopped || request.controller.signal.aborted) return s;
          const next = applyResync(s, page);
          let messages = updates.reduce((messages, update) => update(messages), next.messages);
          // Summary counts have no event cursor: replaying increments can count a reply twice.
          // Keep the displayed live summary, then make at most one summary follow-up GET.
          if (summaryRoots.size) messages = messages.map((message) => {
            if (!summaryRoots.has(message.id)) return message;
            const live = s.messages.find((current) => current.id === message.id);
            return live ? { ...message, thread: live.thread } : message;
          });
          return { ...next, messages };
        });
      }).catch(() => {}).finally(() => {
        clearTimeout(request.timeout);
        if (catchup.current !== request) return;
        catchup.current = null;
        const refreshSummaries = allowSummaryFollowup && request.summaryRoots.size > 0;
        request.updates = [];
        request.summaryRoots.clear();
        if (stopped) return;
        if (queued) {
          queued = false;
          // A reconnect during this GET needs a new snapshot taken after that trigger.
          refresh(false);
        } else if (refreshSummaries) refresh(false, false);
      });
    };
    requestCatchup.current = refresh;
    const unsubscribe = subscribe((event) => {
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
              : x)), msg.threadId);
          }
          break;
        }
        case "message.deleted":
          if (event.channelId === channelId) setMessages((m) => syncReplies(m.filter((x) => x.id !== event.messageId), { deletedId: event.messageId }));
          break;
        case "assets.changed": {
          const generation = ++libraryGeneration.current;
          void fetch(`/api/channels/${channelId}/assets`, { cache: "no-store", signal: scope.signal })
            .then(async (response) => {
              if (!response.ok) return;
              const library = await response.json() as AssetView[];
              if (scope.signal.aborted || generation !== libraryGeneration.current) return;
              const resolve = (content: string) => assetTokens(content).flatMap((ref) => {
                const asset = library.find((asset) => asset.id === ref.id && asset.name === ref.name && asset.kind === ref.kind);
                return asset ? [asset] : [];
              });
              setMessages((messages) => messages.map((message) => ({ ...message, assets: resolve(message.content),
                reactions: message.reactions.map((reaction) => ({ emoji: reaction.emoji, userIds: reaction.userIds, asset: resolve(reaction.emoji)[0] })),
              })));
            }).catch(() => {});
          break;
        }
        case "resync":
          refresh(true);
          break;
      }
    }, { replay: true });
    return () => {
      stopped = true;
      queued = false;
      unsubscribe();
      scope.abort();
      scopeSignal.current = null;
      requestCatchup.current = null;
      libraryGeneration.current++;
      const request = catchup.current;
      catchup.current = null;
      request?.controller.abort();
      if (request) {
        clearTimeout(request.timeout);
        request.updates = [];
        request.summaryRoots.clear();
      }
    };
  }, [channelId, threadId, subscribe, setMessages]);

  // Subscribe first, then close the SSR-to-stream gap, also when mounting after ready.
  // Reconnect already emits resync; observing open joins that request without queuing another.
  useEffect(() => {
    if (connectionState === "open") requestCatchup.current?.(false);
  }, [connectionState, channelId, threadId, subscribe]);

  const loadOlder = useCallback(async () => {
    if (loadingOlder || messages.length === 0) return;
    const signal = scopeSignal.current;
    setLoadingOlder(true);
    setLoadError(null);
    try {
      const page = await fetchPage(channelId, threadId, messages[0].id, signal ?? undefined);
      if (signal?.aborted) return;
      setState((s) => signal?.aborted ? s : { messages: mergeMessages(page.messages, s.messages), hasMore: page.hasMore });
    } catch (error) {
      if (!signal?.aborted) setLoadError(error instanceof Error ? error.message : "Could not load messages.");
    } finally {
      if (!signal?.aborted) setLoadingOlder(false);
    }
  }, [channelId, threadId, loadingOlder, messages]);

  const upsert = useCallback((message: MessageView) => setMessages((m) => mergeMessages(m, [message])), [setMessages]);
  const remove = useCallback((id: string) => setMessages((m) => syncReplies(m.filter((x) => x.id !== id), { deletedId: id })), [setMessages]);

  return { messages, hasMore, loadingOlder, loadError, loadOlder, upsert, remove };
}
