"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import type { DirectConversation } from "@/lib/dm/contracts";
import type { PresenceStatus } from "@/lib/presence";
import { PresenceAvatar } from "../presence-avatar";
import { UserContextMenu } from "../user-context-menu";

const POLL_MS = 10_000;
const visible = (c: DirectConversation) => c.status !== "rejected" && !c.ownBlocked;

/** Keeps the server's recency order and puts conversations that appeared since then on top. */
function merge(current: DirectConversation[], fresh: DirectConversation[]): DirectConversation[] {
  const byId = new Map(fresh.filter(visible).map((c) => [c.id, c]));
  const kept = current.filter((c) => byId.has(c.id)).map((c) => byId.get(c.id)!);
  const known = new Set(kept.map((c) => c.id));
  return [...[...byId.values()].filter((c) => !known.has(c.id)), ...kept];
}

interface DirectMessageListProps {
  userId: string;
  initial: DirectConversation[];
  presence: Record<string, PresenceStatus>;
  relations: Record<string, "friend" | "incoming" | "outgoing">;
}

/** Discord's DM column: every conversation with avatar and presence; new requests appear without a reload. */
export function DirectMessageList({ userId, initial, presence, relations }: DirectMessageListProps) {
  const [polled, setPolled] = useState<DirectConversation[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pathname = usePathname();
  const params = useSearchParams();
  const activePeer = pathname === "/app/messages" ? params.get("to") : null;
  const conversations = polled ? merge(initial, polled) : initial.filter(visible);
  useEffect(() => {
    let alive = true;
    async function poll() {
      if (document.visibilityState !== "visible") return;
      try {
        const response = await fetch("/api/dm", { cache: "no-store" });
        if (!response.ok) return;
        const data = (await response.json()) as { conversations: DirectConversation[] };
        if (alive && Array.isArray(data.conversations)) setPolled(data.conversations);
      } catch {
        // Offline or rate limited: keep the last list; the next poll retries.
      }
    }
    const timer = window.setInterval(() => void poll(), POLL_MS);
    return () => { alive = false; window.clearInterval(timer); };
  }, []);

  if (conversations.length === 0) return <p className="px-2 text-xs text-muted-foreground">No direct messages yet. Message a friend to start one.</p>;
  return (
    <>
      {error && <p role="alert" className="px-2 text-xs text-destructive">{error}</p>}
      <ul className="space-y-0.5">
        {conversations.map((c) => {
          const active = activePeer === c.peerId;
          const status = c.blocked ? "Unavailable" : c.status === "pending" ? (c.requestedBy === userId ? "Request sent" : "Message request") : null;
          return (
            <li key={c.id}>
              <UserContextMenu userId={c.peerId} name={c.peerName} currentUserId={userId} blocked={c.ownBlocked} relation={relations[c.peerId] ?? null} onError={setError}>
                <Link
                  href={`/app/messages?to=${encodeURIComponent(c.peerId)}`}
                  aria-current={active ? "page" : undefined}
                  className={`flex items-center gap-3 rounded-md px-2 py-1.5 focus-visible:outline-2 focus-visible:outline-ring ${active ? "bg-white/10 text-zinc-50" : "text-zinc-400 hover:bg-white/5 hover:text-zinc-100"}`}
                >
                  <PresenceAvatar userId={c.peerId} name={c.peerName} avatar={c.peerAvatar} status={presence[c.peerId] ?? null} announce />
                  <span className="min-w-0 flex-1">
                    <span data-dm-peer-name className="block truncate">{c.peerName}</span>
                    {status && <span className="block truncate text-xs text-muted-foreground">{status}</span>}
                  </span>
                </Link>
              </UserContextMenu>
            </li>
          );
        })}
      </ul>
    </>
  );
}
