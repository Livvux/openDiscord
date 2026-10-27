"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { setChannelTyping } from "@/app/app/actions";
import { useRealtime } from "../realtime-provider";

/** Re-announce while typing; the server keeps a notice for 8 s. */
const ANNOUNCE_EVERY_MS = 5000;
const IDLE_MS = 6000;

/** Discord's "… is typing" for one channel: announces this person's typing and lists everyone else's. */
export function useChannelTyping(channelId: string, currentUserId: string, blockedIds: string[]) {
  const { subscribe } = useRealtime();
  const [typers, setTypers] = useState<Record<string, number>>({});
  const lastSent = useRef(0);
  const announced = useRef(false);
  const idle = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const stop = useCallback(() => {
    clearTimeout(idle.current);
    if (!announced.current) return;
    announced.current = false;
    lastSent.current = 0;
    void setChannelTyping(channelId, false).catch(() => {});
  }, [channelId]);

  /** Call on every draft change. */
  const changed = useCallback((hasText: boolean) => {
    clearTimeout(idle.current);
    if (!hasText) return stop();
    idle.current = setTimeout(stop, IDLE_MS);
    if (Date.now() - lastSent.current < ANNOUNCE_EVERY_MS) return;
    lastSent.current = Date.now();
    announced.current = true;
    void setChannelTyping(channelId, true).catch(() => {});
  }, [channelId, stop]);

  useEffect(() => {
    const unsubscribe = subscribe((event) => {
      if (event.type === "channel.typing" && event.channelId === channelId && event.userId !== currentUserId) {
        setTypers((current) => ({ ...current, [event.userId]: event.typing ? Math.min(event.expiresAt, Date.now() + 10_000) : 0 }));
      } else if (event.type === "message.created" && event.message.channelId === channelId) {
        // Sending ends that person's typing, as in Discord.
        setTypers((current) => (event.message.authorId in current ? { ...current, [event.message.authorId]: 0 } : current));
      }
    });
    const expire = setInterval(() => setTypers((current) => {
      const live = Object.entries(current).filter(([, until]) => until > Date.now());
      return live.length === Object.keys(current).length ? current : Object.fromEntries(live);
    }), 1000);
    const hidden = () => { if (document.visibilityState !== "visible") stop(); };
    document.addEventListener("visibilitychange", hidden);
    return () => {
      unsubscribe();
      clearInterval(expire);
      document.removeEventListener("visibilitychange", hidden);
      stop();
    };
  }, [subscribe, channelId, currentUserId, stop]);

  const blocked = new Set(blockedIds);
  return { changed, stop, typing: Object.keys(typers).filter((id) => !blocked.has(id)) };
}
