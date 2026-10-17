"use client";

import { createContext, useContext, useEffect, useState } from "react";
import type { PresenceStatus } from "@/lib/presence";

const POLL_MS = 60_000;
const PresenceContext = createContext<ReadonlyMap<string, PresenceStatus>>(new Map());

/** Every member shown as online in the open community. */
export function useOnlineMembers(): ReadonlyMap<string, PresenceStatus> {
  return useContext(PresenceContext);
}

/** The member's shown status, or null when offline or hidden. */
export function usePresence(userId: string): PresenceStatus | null {
  return useContext(PresenceContext).get(userId) ?? null;
}

/**
 * Who is online in the open community. Polled, not pushed: presence changes are frequent and
 * low-value, so a minute of delay beats a write and a broadcast per tab heartbeat.
 */
export function PresenceProvider({ communityId, children }: { communityId: string; children: React.ReactNode }) {
  const [online, setOnline] = useState<ReadonlyMap<string, PresenceStatus>>(new Map());

  useEffect(() => {
    let active = true;
    const load = () => {
      if (document.visibilityState !== "visible") return;
      fetch(`/api/communities/${communityId}/presence`, { cache: "no-store" })
        .then((r) => (r.ok ? (r.json() as Promise<{ id: string; status: PresenceStatus }[]>) : null))
        .then((rows) => active && rows && setOnline(new Map(rows.map((r) => [r.id, r.status]))), () => {});
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
