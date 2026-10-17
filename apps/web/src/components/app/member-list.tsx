"use client";

import { CrownIcon, UsersIcon } from "lucide-react";
import { useSelectedLayoutSegment } from "next/navigation";
import { createContext, useContext, useEffect, useState, useSyncExternalStore } from "react";
import { Button } from "@/components/ui/button";
import { PresenceAvatar } from "./presence-avatar";
import { useOnlineMembers } from "./presence-provider";

export interface ListedMember {
  userId: string;
  name: string;
  isOwner: boolean;
}

const STORAGE_KEY = "member-list-hidden";
const DESKTOP = "(min-width: 1024px)";
const DOCKED_EVENT = "member-list-docked";
const MemberListContext = createContext<{ shown: boolean; toggle: () => void }>({ shown: false, toggle: () => {} });

/** Right-hand member list: docked from lg up (remembered per browser), an overlay below. */
export function MemberListProvider({ members, children }: { members: ListedMember[]; children: React.ReactNode }) {
  const [overlay, setOverlay] = useState(false);
  const desktop = useSyncExternalStore(subscribeDesktop, () => window.matchMedia(DESKTOP).matches, () => true);
  const docked = useSyncExternalStore(subscribeDocked, () => localStorage.getItem(STORAGE_KEY) !== "1", () => true);
  // Channels only: settings and the community index have no member list.
  const segment = useSelectedLayoutSegment();
  const inChannel = segment !== null && segment !== "settings";
  useEffect(() => {
    if (!overlay) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOverlay(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [overlay]);

  const toggle = () => {
    if (!desktop) return setOverlay(!overlay);
    localStorage.setItem(STORAGE_KEY, docked ? "1" : "0");
    window.dispatchEvent(new Event(DOCKED_EVENT));
  };

  return (
    <MemberListContext.Provider value={{ shown: desktop ? docked : overlay, toggle }}>
      {children}
      {inChannel && overlay && <div aria-hidden className="fixed inset-0 z-30 bg-black/50 lg:hidden" onClick={() => setOverlay(false)} />}
      {inChannel && (
      <aside
        aria-label="Members"
        className={`w-60 shrink-0 flex-col overflow-y-auto border-l border-white/5 bg-panel ${docked ? "lg:flex" : "lg:hidden"} ${overlay ? "max-lg:fixed max-lg:inset-y-0 max-lg:right-0 max-lg:z-40 max-lg:flex" : "max-lg:hidden"}`}
      >
        <MemberGroups members={members} />
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

function MemberGroups({ members }: { members: ListedMember[] }) {
  const online = useOnlineMembers();
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
              <li key={m.userId} className="flex items-center gap-2 rounded-md px-2 py-1.5">
                <span className={group.label === "Offline" ? "opacity-50" : undefined}>
                  <PresenceAvatar userId={m.userId} name={m.name} size="sm" announce />
                </span>
                <span className={`truncate text-sm ${group.label === "Offline" ? "text-zinc-400" : "text-zinc-200"}`}>{m.name}</span>
                {m.isOwner && <CrownIcon aria-label="Owner" className="size-3.5 shrink-0 text-amber-400" />}
              </li>
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
    <Button variant="ghost" size="icon" aria-label={shown ? "Hide member list" : "Show member list"} aria-pressed={shown} onClick={toggle}>
      <UsersIcon />
    </Button>
  );
}
