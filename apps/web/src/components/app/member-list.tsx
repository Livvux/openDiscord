"use client";

import { CrownIcon, UsersIcon } from "lucide-react";
import { useSelectedLayoutSegment } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Button } from "@/components/ui/button";
import { PresenceAvatar } from "./presence-avatar";
import { useOnlineMembers } from "./presence-provider";
import { UserContextMenu } from "./user-context-menu";

export interface ListedMember {
  userId: string;
  name: string;
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
const MemberListContext = createContext<{ shown: boolean; toggle: (trigger: HTMLElement) => void }>({ shown: false, toggle: () => {} });

/** Right-hand member list: docked from lg up (remembered per browser), an overlay below. */
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
    <MemberListContext.Provider value={{ shown: desktop ? docked : overlay, toggle }}>
      {children}
      {inChannel && overlay && <div aria-hidden className="fixed inset-0 z-30 bg-black/50 lg:hidden" onClick={closeOverlay} />}
      {inChannel && (
      <aside
        aria-label="Members"
        className={`w-60 shrink-0 flex-col overflow-y-auto border-l border-white/5 bg-panel ${docked ? "lg:flex" : "lg:hidden"} ${overlay ? "max-lg:fixed max-lg:inset-y-0 max-lg:right-0 max-lg:z-40 max-lg:flex" : "max-lg:hidden"}`}
      >
        <MemberGroups members={members} currentUserId={currentUserId} blockedIds={blockedIds} />
      </aside>
      )}
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
    <div className="flex flex-col gap-4 p-3">
      {groups.map((group) => (
        <section key={group.label} aria-label={`${group.label} members`}>
          <h2 className="mb-1 px-2 text-xs font-semibold tracking-wide text-zinc-400 uppercase">
            {group.label} — {group.members.length}
          </h2>
          <ul>
            {group.members.map((m) => (
              <UserContextMenu key={m.userId} userId={m.userId} name={m.name} currentUserId={currentUserId} blocked={blocked.has(m.userId)}>
                <li className="flex items-center gap-2 rounded-md px-2 py-1.5 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring">
                  <span className={group.label === "Offline" ? "opacity-50" : undefined}>
                    <PresenceAvatar userId={m.userId} name={m.name} size="sm" announce />
                  </span>
                  <span className={`truncate text-sm ${group.label === "Offline" ? "text-zinc-400" : "text-zinc-200"}`}>{m.name}</span>
                  {m.isOwner && <CrownIcon aria-label="Owner" className="size-3.5 shrink-0 text-amber-400" />}
                </li>
              </UserContextMenu>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

export function MemberListToggle() {
  const { shown, toggle } = useContext(MemberListContext);
  return (
    <Button variant="ghost" size="icon" aria-label={shown ? "Hide member list" : "Show member list"} aria-pressed={shown} onClick={(event) => toggle(event.currentTarget)}>
      <UsersIcon />
    </Button>
  );
}
