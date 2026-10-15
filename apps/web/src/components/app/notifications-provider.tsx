"use client";

import { useRouter } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { MentionNotice } from "@/app/api/me/events/route";

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
}

const NotificationsContext = createContext<NotificationsValue | null>(null);

export function useCommunityUnread(communityId: string, initial: UnreadSummary): UnreadSummary {
  return useContext(NotificationsContext)?.live.get(communityId) ?? initial;
}

export function useReportCommunityUnread() {
  return useContext(NotificationsContext)?.report;
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

/** One personal event stream per tab: mentions from every community. */
export function NotificationsProvider({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const [live, setLive] = useState<ReadonlyMap<string, UnreadSummary>>(new Map());

  const report = useCallback((communityId: string, summary: UnreadSummary) => {
    setLive((m) => {
      const prev = m.get(communityId);
      if (prev && prev.unread === summary.unread && prev.mentions === summary.mentions) return m;
      return new Map(m).set(communityId, summary);
    });
  }, []);

  useEffect(() => {
    const es = new EventSource("/api/me/events");
    es.addEventListener("mention", (e) => {
      const notice = JSON.parse((e as MessageEvent<string>).data) as MentionNotice;
      const channelPath = `/app/c/${notice.communityId}/${notice.channelId}`;
      // Read at event time; usePathname would force this app-wide provider into a Suspense boundary.
      const path = window.location.pathname;
      const watching = path === channelPath && document.visibilityState === "visible";
      if (!watching) desktopNotify(notice, () => router.push(channelPath));
      // The open community counts its own mentions from its stream; others are bumped here.
      if (!path.startsWith(`/app/c/${notice.communityId}`)) {
        setLive((m) => {
          const prev = m.get(notice.communityId);
          return new Map(m).set(notice.communityId, { unread: true, mentions: (prev?.mentions ?? 0) + 1 });
        });
      }
    });
    // Missed events: the server-rendered counts are authoritative again.
    es.addEventListener("resync", () => router.refresh());
    return () => es.close();
  }, [router]);

  const value = useMemo(() => ({ live, report }), [live, report]);
  return <NotificationsContext.Provider value={value}>{children}</NotificationsContext.Provider>;
}
