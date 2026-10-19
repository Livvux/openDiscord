"use client";

import { useRouter } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { DmNotice, MentionNotice } from "@/app/api/me/events/route";
import type { DirectConversation } from "@/lib/dm/contracts";
import { DM_CALL_EVENT } from "@/components/app/voice/dm-call-ring";

export interface UnreadSummary {
  unread: boolean;
  mentions: number;
}

/** Local preference; the browser permission is asked for separately. */
export const DESKTOP_NOTIFICATIONS_KEY = "opendiscord:desktop-notifications";

interface NotificationsValue {
  /** Live unread state per community, overriding what the server rendered. */
  live: ReadonlyMap<string, UnreadSummary>;
  /** The open community reports its own aggregate, which it keeps current from its stream. */
  report: (communityId: string, summary: UnreadSummary) => void;
  /** Do not disturb: badges stay, desktop notifications stop. */
  setQuiet: (quiet: boolean) => void;
  /** Latest DM list from /api/dm; null until the first live refetch (server-rendered data is used until then). */
  direct: DirectConversation[] | null;
  refreshDirect: () => void;
}

/** Dispatched on window so mounted views (Home, the open conversation) can refetch their own data. */
export const DM_CHANGED_EVENT = "opendiscord:dm";
export const FRIENDS_CHANGED_EVENT = "opendiscord:friends";
/** Fallback while the stream is down or events were missed; normally the stream triggers refetches. */
const DIRECT_POLL_MS = 30_000;


const NotificationsContext = createContext<NotificationsValue | null>(null);

export function useCommunityUnread(communityId: string, initial: UnreadSummary): UnreadSummary {
  return useContext(NotificationsContext)?.live.get(communityId) ?? initial;
}

export function useReportCommunityUnread() {
  return useContext(NotificationsContext)?.report;
}

export function useSetQuiet() {
  return useContext(NotificationsContext)?.setQuiet;
}

export function useDirectConversations(): Pick<NotificationsValue, "direct" | "refreshDirect"> {
  const value = useContext(NotificationsContext);
  return { direct: value?.direct ?? null, refreshDirect: value?.refreshDirect ?? (() => {}) };
}

function desktopNotifyDm(notice: DmNotice, onClick: () => void) {
  if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
  if (localStorage.getItem(DESKTOP_NOTIFICATIONS_KEY) !== "on") return;
  // The server only knows who wrote; the text stays encrypted until this browser opens the conversation.
  const n = new Notification(notice.senderName ?? "Private message", { body: "New encrypted message", tag: `dm:${notice.conversationId}` });
  n.onclick = () => {
    window.focus();
    onClick();
    n.close();
  };
}

function desktopNotify(notice: MentionNotice, onClick: () => void) {
  if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
  if (localStorage.getItem(DESKTOP_NOTIFICATIONS_KEY) !== "on") return;
  const n = new Notification(`${notice.authorName} in #${notice.channelName}`, {
    body: notice.excerpt,
    tag: notice.messageId,
  });
  n.onclick = () => {
    window.focus();
    onClick();
    n.close();
  };
}

/** One personal event stream per tab: mentions from every community, DM and friend changes. */
export function NotificationsProvider({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const [live, setLive] = useState<ReadonlyMap<string, UnreadSummary>>(new Map());
  const quiet = useRef(false);
  const setQuiet = useCallback((value: boolean) => { quiet.current = value; }, []);
  const [direct, setDirect] = useState<DirectConversation[] | null>(null);
  const directLoading = useRef(false);
  const directAgain = useRef(false);
  const refreshDirect = useCallback(() => {
    // Coalesce bursts of events into at most one request in flight plus one follow-up.
    if (directLoading.current) { directAgain.current = true; return; }
    directLoading.current = true;
    void (async () => {
      try {
        do {
          directAgain.current = false;
          const response = await fetch("/api/dm", { cache: "no-store" });
          if (!response.ok) return;
          const data = (await response.json()) as { conversations?: unknown };
          if (Array.isArray(data.conversations)) setDirect(data.conversations as DirectConversation[]);
        } while (directAgain.current);
      } catch {
        // Offline or rate limited: keep the last list; the next event or poll retries.
      } finally {
        directLoading.current = false;
      }
    })();
  }, []);

  useEffect(() => {
    const poll = () => { if (document.visibilityState === "visible") refreshDirect(); };
    const timer = window.setInterval(poll, DIRECT_POLL_MS);
    document.addEventListener("visibilitychange", poll);
    return () => { window.clearInterval(timer); document.removeEventListener("visibilitychange", poll); };
  }, [refreshDirect]);

  const report = useCallback((communityId: string, summary: UnreadSummary) => {
    setLive((m) => {
      const prev = m.get(communityId);
      if (prev && prev.unread === summary.unread && prev.mentions === summary.mentions) return m;
      return new Map(m).set(communityId, summary);
    });
  }, []);

  useEffect(() => {
    const es = new EventSource("/api/me/events");
    let connected = false;
    // The stream reconnects every few minutes; mentions in the gap are only in the server counts.
    const changed = () => {
      refreshDirect();
      window.dispatchEvent(new CustomEvent(DM_CHANGED_EVENT));
      window.dispatchEvent(new CustomEvent(FRIENDS_CHANGED_EVENT));
    };
    es.addEventListener("ready", () => {
      if (connected) { router.refresh(); changed(); }
      // Subscribe, then fetch: changes between the server render and this subscription are not lost.
      else refreshDirect();
      connected = true;
    });
    es.addEventListener("dm", (e) => {
      const notice = JSON.parse((e as MessageEvent<string>).data) as DmNotice;
      refreshDirect();
      window.dispatchEvent(new CustomEvent<DmNotice>(DM_CHANGED_EVENT, { detail: notice }));
      // Requests change server-rendered Home badges.
      if (notice.reason === "request") window.dispatchEvent(new CustomEvent(FRIENDS_CHANGED_EVENT));
      if (notice.reason !== "message" || !notice.senderId) return;
      const params = new URLSearchParams(window.location.search);
      const watching = window.location.pathname === "/app/messages" && (params.get("to") === notice.senderId || params.get("c") === notice.conversationId) && document.visibilityState === "visible";
      // ?c= opens 1:1 conversations and groups alike.
      const url = `/app/messages?c=${encodeURIComponent(notice.conversationId)}`;
      if (!watching && !quiet.current) desktopNotifyDm(notice, () => router.push(url));
    });
    es.addEventListener("call", (e) => window.dispatchEvent(new CustomEvent(DM_CALL_EVENT, { detail: JSON.parse((e as MessageEvent<string>).data) })));
    es.addEventListener("friends", () => window.dispatchEvent(new CustomEvent(FRIENDS_CHANGED_EVENT)));
    es.addEventListener("mention", (e) => {
      const notice = JSON.parse((e as MessageEvent<string>).data) as MentionNotice;
      const channelPath = `/app/c/${notice.communityId}/${notice.channelId}`;
      // Read at event time; usePathname would force this app-wide provider into a Suspense boundary.
      const path = window.location.pathname;
      const watching = path === channelPath && document.visibilityState === "visible";
      if (!watching && !notice.muted && !quiet.current) desktopNotify(notice, () => router.push(channelPath));
      // The open community counts its own mentions from its stream; others are bumped here.
      if (!path.startsWith(`/app/c/${notice.communityId}`)) {
        setLive((m) => {
          const prev = m.get(notice.communityId);
          return new Map(m).set(notice.communityId, { unread: true, mentions: (prev?.mentions ?? 0) + 1 });
        });
      }
    });
    // Missed events: the server-rendered counts are authoritative again.
    es.addEventListener("resync", () => { router.refresh(); changed(); });
    return () => es.close();
  }, [router, refreshDirect]);

  const value = useMemo(() => ({ live, report, setQuiet, direct, refreshDirect }), [live, report, setQuiet, direct, refreshDirect]);
  return <NotificationsContext.Provider value={value}>{children}</NotificationsContext.Provider>;
}
