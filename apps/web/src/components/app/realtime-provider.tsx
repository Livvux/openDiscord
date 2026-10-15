"use client";

import { useRouter } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { MessageView } from "@/server/messages";

export type ClientEvent =
  | { type: "message.created" | "message.updated"; message: MessageView }
  | { type: "message.deleted"; channelId: string; messageId: string }
  /** Events may have been missed (reconnect): refetch. */
  | { type: "resync" };

type Listener = (event: ClientEvent) => void;
export type ConnectionState = "connecting" | "open" | "reconnecting" | "closed";

interface RealtimeContextValue {
  subscribe: (listener: Listener) => () => void;
  state: ConnectionState;
}

/** Twice the server heartbeat plus slack. */
const STALE_MS = 60_000;

const RealtimeContext = createContext<RealtimeContextValue | null>(null);

export function useRealtime(): RealtimeContextValue {
  const value = useContext(RealtimeContext);
  if (!value) throw new Error("useRealtime must be used inside <RealtimeProvider>");
  return value;
}

/** One EventSource per open community; the browser reconnects automatically. */
export function RealtimeProvider({ communityId, children }: { communityId: string; children: React.ReactNode }) {
  const router = useRouter();
  const listeners = useRef(new Set<Listener>());
  const [state, setState] = useState<ConnectionState>("connecting");

  useEffect(() => {
    const emit = (event: ClientEvent) => listeners.current.forEach((l) => l(event));
    let source: EventSource | null = null;
    let opened = false;
    let lastSeen = Date.now();
    let stopped = false;

    const connect = () => {
      source?.close();
      lastSeen = Date.now();
      const es = new EventSource(`/api/communities/${communityId}/events`);
      source = es;
      const seen = () => (lastSeen = Date.now());
      es.addEventListener("ready", () => {
        seen();
        setState("open");
        if (opened) emit({ type: "resync" });
        opened = true;
      });
      es.addEventListener("ping", seen);
      // CLOSED means the server refused (e.g. signed out); otherwise the browser is retrying.
      es.addEventListener("error", () => setState(es.readyState === EventSource.CLOSED ? "closed" : "reconnecting"));
      for (const type of ["message.created", "message.updated"] as const) {
        es.addEventListener(type, (e) => {
          seen();
          emit({ type, message: JSON.parse(e.data) as MessageView });
        });
      }
      es.addEventListener("message.deleted", (e) => {
        seen();
        const { channelId, messageId } = JSON.parse(e.data) as { channelId: string; messageId: string };
        emit({ type: "message.deleted", channelId, messageId });
      });
      es.addEventListener("resync", () => (seen(), emit({ type: "resync" })));
      es.addEventListener("channels.changed", () => (seen(), router.refresh()));
      es.addEventListener("removed", () => {
        stopped = true;
        es.close();
        router.push("/app");
        router.refresh();
      });
    };

    // A dropped network can leave a dead connection open for minutes. The server pings every 25 s;
    // after STALE_MS of silence, or when the browser reports it is back online, reconnect.
    const watchdog = setInterval(() => {
      if (!stopped && source?.readyState !== EventSource.CLOSED && Date.now() - lastSeen > STALE_MS) {
        setState("reconnecting");
        connect();
      }
    }, 5_000);
    const onOffline = () => setState("reconnecting");
    const onOnline = () => !stopped && connect();
    window.addEventListener("offline", onOffline);
    window.addEventListener("online", onOnline);
    connect();

    return () => {
      stopped = true;
      clearInterval(watchdog);
      window.removeEventListener("offline", onOffline);
      window.removeEventListener("online", onOnline);
      source?.close();
    };
  }, [communityId, router]);

  const subscribe = useCallback((listener: Listener) => {
    listeners.current.add(listener);
    return () => void listeners.current.delete(listener);
  }, []);
  const value = useMemo(() => ({ state, subscribe }), [state, subscribe]);
  return <RealtimeContext.Provider value={value}>{children}</RealtimeContext.Provider>;
}
