"use client";

import { useEffect } from "react";
import { ProfileCardBody, useProfileCard } from "../user-profile";

/** The DM peer's profile on the right, as in Discord (wide screens only). */
export function PeerProfile({ userId, peerId }: { userId: string; peerId: string }) {
  const { state, load } = useProfileCard(peerId);
  useEffect(() => { void load(); }, [load]);
  return (
    <aside aria-label="Profile" className="hidden w-80 shrink-0 overflow-y-auto border-l border-white/5 bg-panel/60 xl:block">
      {!state ? <p role="status" className="p-4 text-sm text-muted-foreground">Loading profile…</p>
        : state.card ? <ProfileCardBody card={state.card} currentUserId={userId} onChanged={() => void load()} />
        : <p role="alert" className="p-4 text-sm text-destructive">{state.error}</p>}
    </aside>
  );
}
