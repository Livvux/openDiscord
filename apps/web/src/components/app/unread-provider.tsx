"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { useReportCommunityUnread, type UnreadSummary } from "./notifications-provider";
import { useRealtime } from "./realtime-provider";

interface UnreadValue {
  get: (channelId: string) => UnreadSummary;
  /** The person has seen the channel's newest message. */
  clear: (channelId: string) => void;
}

const NONE: UnreadSummary = { unread: false, mentions: 0 };
const UnreadContext = createContext<UnreadValue | null>(null);

export function useChannelUnread(channelId: string): UnreadSummary {
  return useContext(UnreadContext)?.get(channelId) ?? NONE;
}

export function useClearUnread() {
  return useContext(UnreadContext)?.clear;
}

interface UnreadProviderProps {
  communityId: string;
  currentUserId: string;
  /** Server-rendered state per visible channel. */
  initial: Record<string, UnreadSummary>;
  children: React.ReactNode;
}

/** Keeps the open community's channel markers current from its realtime stream. */
export function UnreadProvider({ communityId, currentUserId, initial, children }: UnreadProviderProps) {
  const { subscribe } = useRealtime();
  const [state, setState] = useState(initial);
  const [seenInitial, setSeenInitial] = useState(initial);
  const report = useReportCommunityUnread();

  // A fresh server render (navigation, refresh) is authoritative again.
  if (JSON.stringify(seenInitial) !== JSON.stringify(initial)) {
    setSeenInitial(initial);
    setState(initial);
  }

  useEffect(
    () =>
      subscribe((event) => {
        if (event.type !== "message.created" || event.message.authorId === currentUserId) return;
        const { channelId, mentions } = event.message;
        const watching = window.location.pathname === `/app/c/${communityId}/${channelId}` && document.visibilityState === "visible";
        if (watching) return;
        const mentioned = mentions.some((m) => m.id === currentUserId);
        setState((s) => {
          const prev = s[channelId] ?? NONE;
          return { ...s, [channelId]: { unread: true, mentions: prev.mentions + (mentioned ? 1 : 0) } };
        });
      }),
    [subscribe, communityId, currentUserId],
  );

  useEffect(() => {
    const all = Object.values(state);
    report?.(communityId, { unread: all.some((s) => s.unread), mentions: all.reduce((n, s) => n + s.mentions, 0) });
  }, [state, report, communityId]);

  const clear = useCallback(
    (channelId: string) => setState((s) => (s[channelId]?.unread || s[channelId]?.mentions ? { ...s, [channelId]: NONE } : s)),
    [],
  );
  const value = useMemo(() => ({ get: (id: string) => state[id] ?? NONE, clear }), [state, clear]);
  return <UnreadContext.Provider value={value}>{children}</UnreadContext.Provider>;
}
