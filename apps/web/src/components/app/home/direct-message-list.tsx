"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { useState } from "react";
import { visibleConversation as visible, type DirectConversation } from "@/lib/dm/contracts";
import type { PresenceStatus } from "@/lib/presence";
import { useDirectConversations } from "../notifications-provider";
import { PresenceAvatar } from "../presence-avatar";
import { UserContextMenu } from "../user-context-menu";
import { GroupAvatars } from "../dm/group-panel";

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

/** Discord's DM column: every conversation with avatar, presence and unread count, updated live. */
export function DirectMessageList({ userId, initial, presence, relations }: DirectMessageListProps) {
  const { direct: polled } = useDirectConversations();
  const [error, setError] = useState<string | null>(null);
  const pathname = usePathname();
  const params = useSearchParams();
  const onMessages = pathname === "/app/messages";
  const isActive = (c: DirectConversation) => onMessages && (params.get("c") === c.id || (c.kind === "direct" && params.get("to") === c.peerId));
  const conversations = polled ? merge(initial, polled) : initial.filter(visible);
  if (conversations.length === 0) return <p className="px-2 text-xs text-muted-foreground">No direct messages yet. Message a friend to start one.</p>;
  return (
    <>
      {error && <p role="alert" className="px-2 text-xs text-destructive">{error}</p>}
      <ul className="space-y-0.5">
        {conversations.map((c) => {
          const active = isActive(c);
          const status = c.blocked ? "Unavailable" : c.status === "pending" ? (c.requestedBy === userId ? "Request sent" : "Message request") : null;
          // The open conversation marks itself read; don't flash its count meanwhile.
          const unread = active || c.blocked ? 0 : c.unread;
          const label = unread > 0 ? `${c.peerName}, ${unread} unread ${unread === 1 ? "message" : "messages"}` : undefined;
          if (c.kind === "group") return (
            <li key={c.id}>
              <Link
                href={`/app/messages?c=${encodeURIComponent(c.id)}`}
                aria-current={active ? "page" : undefined}
                aria-label={label}
                className={`flex h-[42px] items-center gap-3 rounded-lg px-2 text-base font-medium focus-visible:outline-2 focus-visible:outline-ring ${active ? "bg-white/10 text-sidebar-foreground" : unread > 0 ? "text-sidebar-foreground hover:bg-white/[0.06]" : "text-muted-foreground hover:bg-white/[0.06] hover:text-sidebar-foreground"}`}
              >
                <GroupAvatars members={c.members} />
                <span className="min-w-0 flex-1">
                  <span data-dm-peer-name className="block truncate">{c.peerName}</span>
                  <span className="block truncate text-xs font-normal text-muted-foreground">{c.members.filter((m) => !m.left).length + 1} members</span>
                </span>
                {unread > 0 && <span data-dm-unread aria-hidden className="min-w-4 rounded-full bg-[#dc2626] px-1 text-center text-xs leading-4 font-bold text-white">{unread > 99 ? "99+" : unread}</span>}
              </Link>
            </li>
          );
          return (
            <li key={c.id}>
              <UserContextMenu userId={c.peerId} name={c.peerName} currentUserId={userId} blocked={c.ownBlocked} relation={relations[c.peerId] ?? null} onError={setError}>
                <Link
                  href={`/app/messages?to=${encodeURIComponent(c.peerId)}`}
                  aria-current={active ? "page" : undefined}
                  aria-label={label}
                  className={`flex h-[42px] items-center gap-3 rounded-lg px-2 text-base font-medium focus-visible:outline-2 focus-visible:outline-ring ${active ? "bg-white/10 text-sidebar-foreground" : unread > 0 ? "text-sidebar-foreground hover:bg-white/[0.06]" : "text-muted-foreground hover:bg-white/[0.06] hover:text-sidebar-foreground"}`}
                >
                  <PresenceAvatar userId={c.peerId} name={c.peerName} avatar={c.peerAvatar} status={presence[c.peerId] ?? null} announce />
                  <span className="min-w-0 flex-1">
                    <span data-dm-peer-name className="block truncate">{c.peerName}</span>
                    {status && <span className="block truncate text-xs font-normal text-muted-foreground">{status}</span>}
                  </span>
                  {unread > 0 && (
                    <span data-dm-unread aria-hidden className="min-w-4 rounded-full bg-[#dc2626] px-1 text-center text-xs leading-4 font-bold text-white">
                      {unread > 99 ? "99+" : unread}
                    </span>
                  )}
                </Link>
              </UserContextMenu>
            </li>
          );
        })}
      </ul>
    </>
  );
}
