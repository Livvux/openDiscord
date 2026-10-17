"use client";

import { CheckIcon, CopyIcon, MessageSquareIcon, UserMinusIcon, UserPlusIcon, UserRoundCheckIcon, UserXIcon, XIcon } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState, useTransition, type ReactElement, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { blockUser, removeFriend, respondToFriendRequest, sendFriendRequest, unblockUser } from "@/app/app/actions";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuLabel, ContextMenuLinkItem, ContextMenuSeparator, ContextMenuTrigger } from "@/components/ui/context-menu";
import type { ActionResult } from "@/server/errors";
import type { FriendView } from "@/server/friends";

interface UserContextMenuProps {
  userId: string;
  name: string;
  currentUserId: string;
  blocked?: boolean;
  /** Omit when the surface has no relationship data; Add Friend opens the existing friend-code flow. */
  relation?: FriendView["state"] | null;
  children: ReactElement;
  /** Already-authorized moderation items from the member surface. The server checks every action again. */
  moderation?: ReactNode;
  disabled?: boolean;
  /** Author/avatar buttons can also expose the same menu with a normal click. */
  openOnClick?: boolean;
  onChanged?: () => void;
  onError?: (error: string) => void;
}

type Notice = { ok: boolean; text: string };

/** Shared person actions for friend rows, community members, message authors and DM peers. */
export function UserContextMenu({ userId, name, currentUserId, blocked = false, relation, children, moderation, disabled = false, openOnClick = false, onChanged, onError }: UserContextMenuProps) {
  const trigger = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [notice, setNotice] = useState<Notice | null>(null);
  const isSelf = userId === currentUserId;
  const busy = pending || disabled;
  // A pending friend request may come from a friend code without any shared community.
  const canMessage = !isSelf && !blocked && relation !== "incoming" && relation !== "outgoing";

  useEffect(() => {
    if (!notice?.ok) return;
    const timer = window.setTimeout(() => setNotice(null), 4000);
    return () => window.clearTimeout(timer);
  }, [notice]);

  function fail(error: string) {
    if (onError) onError(error);
    else setNotice({ ok: false, text: error });
  }

  function run(action: () => Promise<ActionResult<unknown>>, success?: string) {
    if (busy) return;
    setNotice(null);
    startTransition(async () => {
      try {
        const result = await action();
        if (!result.ok) return fail(result.error);
        if (success) setNotice({ ok: true, text: success });
        onChanged?.();
      } catch {
        fail("Couldn't complete that action. Please try again.");
      }
    });
  }

  function addFriend() {
    run(async () => {
      const result = await sendFriendRequest(userId);
      if (result.ok) {
        setNotice({ ok: true, text: result.data === "sent" ? "Friend request sent." : result.data === "accepted" ? `You and ${name} are now friends.` : "You're already friends or have a pending request." });
      }
      return result;
    });
  }

  function remove() {
    if (!window.confirm(`Remove ${name} as a friend? They won't be notified.`)) return;
    run(() => removeFriend(userId));
  }

  function block() {
    if (!window.confirm(`Block ${name}? Their messages will be hidden for you and their mentions won't notify you. They won't be told.`)) return;
    run(() => blockUser(userId));
  }

  async function copyId() {
    setNotice(null);
    try {
      await navigator.clipboard.writeText(userId);
      setNotice({ ok: true, text: "User ID copied." });
    } catch {
      fail(`Couldn't copy the user ID. You can copy it here: ${userId}`);
    }
  }

  return (
    <>
      <ContextMenu open={open} onOpenChange={setOpen}>
        <ContextMenuTrigger
          ref={trigger}
          render={children}
          aria-busy={busy || undefined}
          aria-haspopup={openOnClick ? "menu" : undefined}
          aria-expanded={openOnClick ? open : undefined}
          onClick={openOnClick ? (event) => {
            event.preventDefault();
            event.stopPropagation();
            const rect = event.currentTarget.getBoundingClientRect();
            event.currentTarget.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: rect.left, clientY: rect.bottom }));
          } : undefined}
        />
        <ContextMenuContent aria-label="User actions" finalFocus={trigger}>
          <ContextMenuLabel>{name}{isSelf ? " (you)" : ""}</ContextMenuLabel>
          {canMessage && (
            <ContextMenuLinkItem render={<Link href={`/app/messages?to=${encodeURIComponent(userId)}`} />}>
              <MessageSquareIcon aria-hidden /> Message
            </ContextMenuLinkItem>
          )}
          {!isSelf && !blocked && (
            <>
              {relation === undefined && (
                <ContextMenuLinkItem render={<Link href={`/app/friends?add=${encodeURIComponent(userId)}`} />}>
                  <UserPlusIcon aria-hidden /> Add Friend
                </ContextMenuLinkItem>
              )}
              {relation === null && <ContextMenuItem disabled={busy} onClick={addFriend}><UserPlusIcon aria-hidden /> Add Friend</ContextMenuItem>}
              {relation === "friend" && <ContextMenuItem disabled={busy} variant="destructive" onClick={remove}><UserMinusIcon aria-hidden /> Remove Friend</ContextMenuItem>}
              {relation === "incoming" && (
                <>
                  <ContextMenuItem disabled={busy} onClick={() => run(() => respondToFriendRequest(userId, true), `You and ${name} are now friends.`)}><CheckIcon aria-hidden /> Accept Friend Request</ContextMenuItem>
                  <ContextMenuItem disabled={busy} onClick={() => run(() => respondToFriendRequest(userId, false))}><XIcon aria-hidden /> Decline Friend Request</ContextMenuItem>
                </>
              )}
              {relation === "outgoing" && <ContextMenuItem disabled={busy} onClick={() => run(() => removeFriend(userId))}><XIcon aria-hidden /> Cancel Friend Request</ContextMenuItem>}
            </>
          )}
          {moderation && <><ContextMenuSeparator />{moderation}</>}
          {!isSelf && (
            <>
              <ContextMenuSeparator />
              {blocked ? (
                <ContextMenuItem disabled={busy} onClick={() => run(() => unblockUser(userId))}><UserRoundCheckIcon aria-hidden /> Unblock</ContextMenuItem>
              ) : (
                <ContextMenuItem disabled={busy} variant="destructive" onClick={block}><UserXIcon aria-hidden /> Block</ContextMenuItem>
              )}
            </>
          )}
          <ContextMenuSeparator />
          <ContextMenuItem onClick={() => void copyId()}><CopyIcon aria-hidden /> Copy User ID</ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
      {notice && createPortal(
        <div role={notice.ok ? "status" : "alert"} className="fixed right-4 bottom-4 z-[100] flex max-w-[min(24rem,calc(100vw-2rem))] items-start gap-3 rounded-lg border bg-popover px-4 py-3 text-sm text-popover-foreground shadow-xl">
          <span className={`min-w-0 break-words ${notice.ok ? "" : "text-destructive"}`}>{notice.text}</span>
          <button type="button" aria-label="Dismiss notification" className="shrink-0 rounded-sm text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring" onClick={() => { setNotice(null); trigger.current?.focus(); }}><XIcon aria-hidden className="size-4" /></button>
        </div>,
        document.body,
      )}
    </>
  );
}
