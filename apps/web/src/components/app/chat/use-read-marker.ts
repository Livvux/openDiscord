"use client";

import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { markChannelRead } from "@/app/app/actions";
import { firstUnseen, laterId, newestVisibleId } from "@/lib/read-marker";
import { setChannelAtPresent, useClearUnread } from "../unread-provider";

/** Scrolling settles before the view is judged, so one request covers a whole scroll gesture. */
const SETTLE_MS = 300;

interface ReadMarkerOptions {
  channelId: string;
  /** Off for threads: they don't move the channel's marker. */
  enabled: boolean;
  messages: readonly { id: string; authorId: string }[];
  currentUserId: string;
  /** The server's marker when the channel was opened. */
  lastReadId: string | null;
  scroller: RefObject<HTMLDivElement | null>;
  /** Realtime connection state: a reconnect resync can merge messages in. */
  connection: string;
}

/**
 * Moves the channel's read marker to the newest message actually on screen while the tab is visible,
 * or to the newest loaded message through `markAll`. `unseen` is the first unseen message below the view.
 */
export function useReadMarker({ channelId, enabled, messages, currentUserId, lastReadId, scroller, connection }: ReadMarkerOptions) {
  const clearUnread = useClearUnread();
  const [unseen, setUnseen] = useState<string | null>(null);
  const live = useRef({ messages, clearUnread });
  const api = useRef({ schedule: () => {}, markAll: () => {} });
  useLayoutEffect(() => { live.current = { messages, clearUnread }; }, [messages, clearUnread]);

  useEffect(() => {
    if (!enabled) return;
    let stopped = false, inFlight = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // `marked`: confirmed by the server. `wanted`: seen or explicitly read, not yet confirmed. `seen`: on screen here.
    let marked = lastReadId, wanted: string | null = null, seen: string | null = null;
    const newest = () => live.current.messages.at(-1)?.id ?? null;
    const showUnseen = () => setUnseen(firstUnseen(live.current.messages, currentUserId, laterId(marked, seen)));
    const push = async () => {
      if (stopped || inFlight || !wanted || laterId(marked, wanted) === marked) return;
      const id = wanted;
      inFlight = true;
      // Navigation/offline can reject the transport before the action returns a result.
      // The target stays pending for a later visibility/online/reconnect attempt.
      const result = await markChannelRead(channelId, id).catch(() => null);
      inFlight = false;
      if (stopped || !result?.ok) return;
      marked = laterId(marked, id);
      // The sidebar badge covers the whole channel: clear it only once the newest loaded message is read.
      if (id === newest()) live.current.clearUnread?.(channelId);
      showUnseen();
      void push();
    };
    const evaluate = () => {
      clearTimeout(timer);
      const el = scroller.current;
      // A hidden tab sees nothing, whatever its layout says.
      if (stopped || !el || document.visibilityState !== "visible") return;
      const rows = Array.from(el.querySelectorAll<HTMLElement>("li[data-message-id]"), (row) => {
        const box = row.getBoundingClientRect();
        return { id: row.dataset.messageId!, top: box.top, bottom: box.bottom };
      });
      const visible = newestVisibleId(el.getBoundingClientRect(), rows);
      seen = laterId(seen, visible);
      setChannelAtPresent(channelId, visible !== null && visible === newest());
      showUnseen();
      wanted = laterId(wanted, visible);
      void push();
    };
    api.current = {
      schedule: () => {
        // A moving view isn't at the present until it settles there: a message arriving meanwhile counts as unread.
        setChannelAtPresent(channelId, false);
        clearTimeout(timer);
        timer = setTimeout(evaluate, SETTLE_MS);
      },
      markAll: () => { wanted = laterId(wanted, newest()); void push(); },
    };
    document.addEventListener("visibilitychange", evaluate);
    window.addEventListener("online", evaluate);
    return () => {
      stopped = true;
      clearTimeout(timer);
      api.current = { schedule: () => {}, markAll: () => {} };
      setChannelAtPresent(channelId, false);
      document.removeEventListener("visibilitychange", evaluate);
      window.removeEventListener("online", evaluate);
    };
  }, [enabled, channelId, currentUserId, lastReadId, scroller]);

  // New or merged messages (including a reconnect resync) are judged once the view settles.
  useEffect(() => { api.current.schedule(); }, [messages, connection]);

  return { unseen: enabled ? unseen : null, schedule: () => api.current.schedule(), markAll: () => api.current.markAll() };
}
