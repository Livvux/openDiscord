"use client";

import { createContext, useContext, useEffect, useState } from "react";

const POLL_MS = 60_000;
const PresenceContext = createContext<ReadonlySet<string>>(new Set());

export function useOnline(userId: string): boolean {
  return useContext(PresenceContext).has(userId);
}

/**
 * Who is online in the open community. Polled, not pushed: presence changes are frequent and
 * low-value, so a minute of delay beats a write and a broadcast per tab heartbeat.
 */
export function PresenceProvider({ communityId, children }: { communityId: string; children: React.ReactNode }) {
  const [online, setOnline] = useState<ReadonlySet<string>>(new Set());

  useEffect(() => {
    let active = true;
    const load = () => {
      if (document.visibilityState !== "visible") return;
      fetch(`/api/communities/${communityId}/presence`, { cache: "no-store" })
        .then((r) => (r.ok ? (r.json() as Promise<string[]>) : null))
        .then((ids) => active && ids && setOnline(new Set(ids)), () => {});
    };
    load();
    const timer = setInterval(load, POLL_MS);
    document.addEventListener("visibilitychange", load);
    return () => {
      active = false;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", load);
    };
  }, [communityId]);

  return <PresenceContext.Provider value={online}>{children}</PresenceContext.Provider>;
}
