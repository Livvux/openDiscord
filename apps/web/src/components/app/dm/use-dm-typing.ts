"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { dmFetch } from "@/lib/dm/client";
import { DM_TYPING_EVENT } from "../notifications-provider";

type Notice = { conversationId: string; senderId: string; typing: boolean; expiresAt: number };

export function useDmTyping(conversationId: string | null, enabled: boolean) {
  const [people, setPeople] = useState<Record<string, number>>({});
  const last = useRef(0);
  const sending = useRef(false);
  const idle = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const notify = useCallback((typing: boolean) => {
    if (!conversationId || !enabled) return;
    if (typing && Date.now() - last.current < 4000) return;
    if (!typing && !sending.current) return;
    last.current = Date.now(); sending.current = typing;
    void dmFetch("/api/dm", { action: "typing", id: conversationId, typing }).catch(() => {});
  }, [conversationId, enabled]);
  const stop = useCallback(() => { clearTimeout(idle.current); notify(false); }, [notify]);
  const changed = useCallback((hasText: boolean) => {
    clearTimeout(idle.current);
    if (!hasText) { stop(); return; }
    notify(true);
    idle.current = setTimeout(stop, 3000);
  }, [notify, stop]);
  useEffect(() => {
    const receive = (event: Event) => {
      const notice = (event as CustomEvent<Notice>).detail;
      if (notice.conversationId !== conversationId || !enabled) return;
      setPeople((current) => ({ ...current, [notice.senderId]: notice.typing ? Math.min(notice.expiresAt, Date.now() + 6000) : 0 }));
    };
    const expire = setInterval(() => setPeople((current) => {
      const entries = Object.entries(current).filter(([, until]) => until > Date.now());
      return entries.length === Object.keys(current).length ? current : Object.fromEntries(entries);
    }), 500);
    const hidden = () => { if (document.visibilityState !== "visible") stop(); };
    window.addEventListener(DM_TYPING_EVENT, receive);
    document.addEventListener("visibilitychange", hidden);
    return () => { stop(); last.current = 0; clearInterval(expire); window.removeEventListener(DM_TYPING_EVENT, receive); document.removeEventListener("visibilitychange", hidden); };
  }, [conversationId, enabled, stop]);
  // Include the conversation in the state boundary so a navigation never shows a previous peer.
  useEffect(() => { const timer = setTimeout(() => setPeople({}), 0); return () => clearTimeout(timer); }, [conversationId]);
  return { changed, stop, people: enabled ? Object.keys(people) : [] };
}
