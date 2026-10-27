"use client";

import { BellIcon, CheckIcon, CopyIcon, FlagIcon, LogOutIcon, SettingsIcon, UserPlusIcon } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef, useState, useTransition } from "react";
import { leaveCommunity, setNotificationLevel } from "@/app/app/actions";
import { Button } from "@/components/ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuLinkItem,
  ContextMenuRadioGroup,
  ContextMenuRadioItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { CommunityNavigationSummary } from "@/server/communities";
import type { ActionResult } from "@/server/errors";
import { has, Permission } from "@/server/permissions";
import { fmt } from "@/lib/i18n";
import { useMessages } from "@/lib/i18n/client";
import { InviteDialog } from "./invite-dialog";
import { ReportDialog } from "./report-dialog";

const SETTINGS_PERMISSIONS =
  Permission.ManageCommunity | Permission.ManageRoles | Permission.KickMembers | Permission.BanMembers | Permission.ViewAuditLog;

interface ServerContextMenuProps {
  community: Pick<CommunityNavigationSummary, "id" | "name" | "authority" | "notifications">;
  children: React.ReactNode;
  className?: string;
  /** Existing links remain the tab stop; the header can be focused on its own. */
  tabIndex?: number;
}

/** The same server actions on its rail icon, name, or community card. */
export function ServerContextMenu({ community, children, className, tabIndex = -1 }: ServerContextMenuProps) {
  const router = useRouter();
  const trigger = useRef<HTMLDivElement>(null);
  const focusTarget = useRef<HTMLElement | null>(null);
  const [open, setOpen] = useState(false);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [leaveOpen, setLeaveOpen] = useState(false);
  const [reportOpen, setReportOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [pending, startTransition] = useTransition();
  const t = useMessages().community;
  const canInvite = has(community.authority, Permission.CreateInvites);
  const canManage = (community.authority.permissions & SETTINGS_PERMISSIONS) !== 0;

  const returnFocus = () => {
    if (focusTarget.current?.isConnected) return focusTarget.current;
    return trigger.current?.querySelector<HTMLElement>("a, button, [tabindex='0']") ?? trigger.current;
  };

  function rememberTarget(event: React.SyntheticEvent<HTMLDivElement>) {
    const target = event.target instanceof HTMLElement ? event.target.closest<HTMLElement>("a, button, [tabindex]") : null;
    const active = document.activeElement instanceof HTMLElement && event.currentTarget.contains(document.activeElement) ? document.activeElement : null;
    // Keyboard shortcuts dispatch the context-menu event on the wrapper; keep its
    // focused link or button as the return destination in that case.
    focusTarget.current = target && target !== event.currentTarget && event.currentTarget.contains(target) ? target : active;
  }

  function run(action: () => Promise<ActionResult<unknown>>, onSuccess?: () => void) {
    setError(null);
    startTransition(async () => {
      try {
        const result = await action();
        if (!result.ok) return setError(result.error);
        onSuccess?.();
      } catch {
        setError("The server action could not be completed. Please try again.");
      }
    });
  }

  async function copyId() {
    try {
      await navigator.clipboard.writeText(community.id);
      setCopied(true);
    } catch {
      setOpen(false);
      setError("Could not copy the server ID. Allow clipboard access and try again.");
    }
  }

  function leave() {
    run(() => leaveCommunity(community.id), () => {
      setLeaveOpen(false);
      if (window.location.pathname.startsWith(`/app/c/${community.id}`)) router.push("/app");
      router.refresh();
    });
  }

  return (
    <>
      <ContextMenu
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (next) setCopied(false);
        }}
      >
        <ContextMenuTrigger
          ref={trigger}
          className={className}
          tabIndex={tabIndex}
          aria-label={`${community.name} server actions`}
          onContextMenu={rememberTarget}
          onTouchStart={rememberTarget}
          onKeyDown={rememberTarget}
        >
          {children}
        </ContextMenuTrigger>
        <ContextMenuContent aria-label={`${community.name} server actions`} finalFocus={inviteOpen || leaveOpen || reportOpen || error ? false : returnFocus}>
          <ContextMenuLabel>{community.name}</ContextMenuLabel>
          {canInvite && (
            <ContextMenuItem disabled={pending} onClick={() => setInviteOpen(true)}>
              <UserPlusIcon aria-hidden /> {t.invite}
            </ContextMenuItem>
          )}
          <ContextMenuLinkItem render={<Link href={`/app/c/${community.id}/settings`} />}>
            <SettingsIcon aria-hidden /> {canManage ? t.settings : t.info}
          </ContextMenuLinkItem>
          <ContextMenuSeparator />
          <ContextMenuSub>
            <ContextMenuSubTrigger disabled={pending}>
              <BellIcon aria-hidden /> {t.notifications}
            </ContextMenuSubTrigger>
            <ContextMenuContent aria-label="Server notifications">
              <ContextMenuRadioGroup
                value={community.notifications}
                disabled={pending}
                onValueChange={(level: unknown) => {
                  if ((level === "mentions" || level === "muted") && level !== community.notifications) {
                    run(() => setNotificationLevel(community.id, level));
                  }
                }}
              >
                <ContextMenuRadioItem value="mentions" closeOnClick>{t.mentions}</ContextMenuRadioItem>
                <ContextMenuRadioItem value="muted" closeOnClick>{t.muted}</ContextMenuRadioItem>
              </ContextMenuRadioGroup>
            </ContextMenuContent>
          </ContextMenuSub>
          <ContextMenuItem onClick={() => void copyId()} closeOnClick={false}>
            {copied ? <CheckIcon aria-hidden /> : <CopyIcon aria-hidden />} {copied ? t.copiedId : t.copyId}
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem disabled={pending} onClick={() => setReportOpen(true)}>
            <FlagIcon aria-hidden /> {t.report}
          </ContextMenuItem>
          {!community.authority.isOwner && (
            <>
              <ContextMenuItem variant="destructive" disabled={pending} onClick={() => { setError(null); setLeaveOpen(true); }}>
                <LogOutIcon aria-hidden /> {t.leave}
              </ContextMenuItem>
            </>
          )}
        </ContextMenuContent>
      </ContextMenu>

      {canInvite && (
        <InviteDialog
          communityId={community.id}
          communityName={community.name}
          open={inviteOpen}
          onOpenChange={setInviteOpen}
          hideTrigger
          finalFocus={returnFocus}
        />
      )}

      <ReportDialog communityId={community.id} open={reportOpen} onOpenChange={setReportOpen} hideTrigger />

      <Dialog open={leaveOpen} onOpenChange={(next) => { if (!pending) { setLeaveOpen(next); setError(null); } }}>
        <DialogContent finalFocus={returnFocus} showCloseButton={!pending}>
          <DialogHeader>
            <DialogTitle>{fmt(t.leaveTitle, { name: community.name })}</DialogTitle>
            <DialogDescription>{t.leaveDescription}</DialogDescription>
          </DialogHeader>
          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
          <DialogFooter>
            <Button variant="outline" disabled={pending} onClick={() => { setLeaveOpen(false); setError(null); }}>{t.cancel}</Button>
            <Button variant="destructive" disabled={pending} onClick={leave}>{pending ? t.leaving : t.leave}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(error) && !leaveOpen} onOpenChange={(next) => { if (!next) setError(null); }}>
        <DialogContent finalFocus={returnFocus}>
          <DialogHeader>
            <DialogTitle>Server action failed</DialogTitle>
            <DialogDescription>{error}</DialogDescription>
          </DialogHeader>
          <DialogFooter><Button onClick={() => setError(null)}>Close</Button></DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
