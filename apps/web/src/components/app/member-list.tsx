"use client";

import { CrownIcon, UsersIcon } from "lucide-react";
import { useSelectedLayoutSegment } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Button } from "@/components/ui/button";
import { PresenceAvatar } from "./presence-avatar";
import { useOnlineMembers } from "./presence-provider";
import { UserContextMenu } from "./user-context-menu";
import { UserProfilePopover } from "./user-profile";

export interface ListedMember {
  userId: string;
  name: string;
  avatar: string | null;
  isOwner: boolean;
}

interface MemberListProps {
  members: ListedMember[];
  currentUserId: string;
  blockedIds: string[];
}

const STORAGE_KEY = "member-list-hidden";
const DESKTOP = "(min-width: 1024px)";
const DOCKED_EVENT = "member-list-docked";
const MemberListContext = createContext<{ shown: boolean; toggle: (trigger: HTMLElement) => void; panel: React.ReactNode; members: ListedMember[] }>({ shown: false, toggle: () => {}, panel: null, members: [] });

/** Right-hand member list: docked from lg up (remembered per browser), an overlay below. The state lives with the
 * community; the channel page places it under its header with `MemberListPanel`, as Discord does. */
export function MemberListProvider({ members, currentUserId, blockedIds, children }: MemberListProps & { children: React.ReactNode }) {
  const [overlay, setOverlay] = useState(false);
  const overlayTrigger = useRef<HTMLElement | null>(null);
  const closeOverlay = useCallback(() => {
    setOverlay(false);
    if (overlayTrigger.current?.isConnected) overlayTrigger.current.focus();
  }, []);
  const desktop = useSyncExternalStore(subscribeDesktop, () => window.matchMedia(DESKTOP).matches, () => true);
  const docked = useSyncExternalStore(subscribeDocked, () => localStorage.getItem(STORAGE_KEY) !== "1", () => true);
  // Channels only: settings and the community index have no member list.
  const segment = useSelectedLayoutSegment();
  const inChannel = segment !== null && segment !== "settings";
  useEffect(() => {
    if (!overlay) return;
    const onKey = (e: KeyboardEvent) => {
      // A menu consumes its own Escape first and returns focus to the member row.
      if (e.key === "Escape" && !e.defaultPrevented && !e.isComposing) closeOverlay();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [overlay, closeOverlay]);

  const toggle = (trigger: HTMLElement) => {
    if (!desktop) {
      if (overlay) return closeOverlay();
      overlayTrigger.current = trigger;
      return setOverlay(true);
    }
    localStorage.setItem(STORAGE_KEY, docked ? "1" : "0");
    window.dispatchEvent(new Event(DOCKED_EVENT));
  };

  return (
    <MemberListContext.Provider value={{ shown: desktop ? docked : overlay, toggle, members, panel: inChannel && (
      <>
        {overlay && <div aria-hidden className="fixed inset-0 z-30 bg-black/50 lg:hidden" onClick={closeOverlay} />}
        <aside
          aria-label="Members"
          className={`w-66 shrink-0 flex-col overflow-y-auto border-l bg-panel ${docked ? "lg:flex" : "lg:hidden"} ${overlay ? "max-lg:fixed max-lg:inset-y-0 max-lg:right-0 max-lg:z-40 max-lg:flex max-lg:pt-[env(safe-area-inset-top)] max-lg:pb-[env(safe-area-inset-bottom)]" : "max-lg:hidden"}`}
        >
          <MemberGroups members={members} currentUserId={currentUserId} blockedIds={blockedIds} />
        </aside>
      </>
    ) }}>
      {children}
    </MemberListContext.Provider>
  );
}

function subscribeDesktop(onChange: () => void) {
  const query = window.matchMedia(DESKTOP);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

function subscribeDocked(onChange: () => void) {
  window.addEventListener(DOCKED_EVENT, onChange);
  window.addEventListener("storage", onChange);
  return () => {
    window.removeEventListener(DOCKED_EVENT, onChange);
    window.removeEventListener("storage", onChange);
  };
}

function MemberGroups({ members, currentUserId, blockedIds }: MemberListProps) {
  const online = useOnlineMembers();
  const blocked = new Set(blockedIds);
  const groups = [
    { label: "Online", members: members.filter((m) => online.has(m.userId)) },
    { label: "Offline", members: members.filter((m) => !online.has(m.userId)) },
  ].filter((g) => g.members.length > 0);
  return (
    <div className="flex flex-col px-2 pb-4">
      {groups.map((group) => (
        <section key={group.label} aria-label={`${group.label} members`}>
          <h2 className="px-2 pt-5 pb-1 text-sm font-medium text-muted-foreground">
            {group.label} — {group.members.length}
          </h2>
          <ul>
            {group.members.map((m) => (
              <UserContextMenu key={m.userId} userId={m.userId} name={m.name} currentUserId={currentUserId} blocked={blocked.has(m.userId)}>
                <li className="rounded-md focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring">
                  <UserProfilePopover userId={m.userId} currentUserId={currentUserId} render={
                    <button type="button" className="group/member flex h-[42px] w-full items-center gap-3 rounded-lg px-2 text-left hover:bg-white/[0.06] focus-visible:outline-2 focus-visible:outline-ring data-popup-open:bg-white/10">
                      {/* Discord dims offline members; only the avatar fades so the name keeps AA contrast. */}
                      <span className={group.label === "Offline" ? "opacity-40 group-hover/member:opacity-100" : undefined}><PresenceAvatar userId={m.userId} name={m.name} avatar={m.avatar} announce /></span>
                      <span className="truncate text-base font-medium text-muted-foreground">{m.name}</span>
                      {m.isOwner && <CrownIcon aria-label="Owner" className="size-3.5 shrink-0 text-amber-400" />}
                    </button>
                  } />
                </li>
              </UserContextMenu>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

/** Display names of the community's members, for typing notices. */
export function useMemberNames(ids: string[]): string[] {
  const { members } = useContext(MemberListContext);
  return ids.map((id) => members.find((m) => m.userId === id)?.name ?? "Someone");
}

export function MemberListPanel() {
  return useContext(MemberListContext).panel;
}

export function MemberListToggle() {
  const { shown, toggle } = useContext(MemberListContext);
  return (
    <Button variant="ghost" size="icon" aria-label={shown ? "Hide member list" : "Show member list"} aria-pressed={shown} onClick={(event) => toggle(event.currentTarget)}>
      <UsersIcon />
    </Button>
  );
}
