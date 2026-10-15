"use client";

import { useState, useTransition } from "react";
import { unpublishChannel } from "@/app/app/actions";
import { Button } from "@/components/ui/button";

export function PublicChannelControls({ channelId, unpublished, isOwner }: { channelId: string; unpublished: boolean; isOwner: boolean }) {
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  return <aside className="shrink-0 border-b border-white/10 px-4 py-3 text-sm text-zinc-300" aria-label="Public channel status">
    {unpublished ? <p>Permanently unpublished. Public reading and posting have stopped. External copies and search caches may remain. Create a new channel to publish again.</p> : <div className="flex flex-wrap items-center gap-3"><p>This channel is public and searchable.</p><a className="underline" href={`/public/${channelId}`} target="_blank" rel="noopener">View public page</a>{isOwner && <Button variant="outline" size="sm" disabled={pending} onClick={() => {
      if (!window.confirm("Permanently unpublish this channel? Public reading and posting will stop. You cannot republish it. External copies and search caches may remain.")) return;
      startTransition(async () => { const result = await unpublishChannel(channelId); if (!result.ok) setError(result.error); });
    }}>Unpublish permanently</Button>}</div>}
    {error && <p role="alert" className="text-destructive">{error}</p>}
  </aside>;
}
