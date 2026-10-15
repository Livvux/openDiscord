"use client";

import { XIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import type { MessagePage, MessageView } from "@/server/messages";
import { ChannelChat } from "./channel-chat";

type ThreadPanelProps = Omit<React.ComponentProps<typeof ChannelChat>, "initialPage" | "threadRoot"> & {
  root: MessageView;
  onClose: () => void;
};

/** A thread beside the channel (full width on small screens). Escape closes it. */
export function ThreadPanel({ root, onClose, ...chat }: ThreadPanelProps) {
  const [page, setPage] = useState<MessagePage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const panel = useRef<HTMLElement>(null);

  useEffect(() => {
    let active = true;
    fetch(`/api/channels/${chat.channel.id}/messages?thread=${root.id}`, { cache: "no-store" })
      .then(async (r) => {
        const body = (await r.json().catch(() => null)) as (MessagePage & { error?: string }) | null;
        if (!active) return;
        if (r.ok && body) setPage(body);
        else setError(body?.error ?? "Couldn't load the thread.");
      })
      .catch(() => active && setError("Couldn't load the thread."));
    return () => void (active = false);
  }, [chat.channel.id, root.id]);

  // Move focus into the panel once, when it opens.
  useEffect(() => panel.current?.focus(), []);

  return (
    <aside
      ref={panel}
      tabIndex={-1}
      aria-label={`Thread by ${root.authorName}`}
      onKeyDown={(e) => e.key === "Escape" && onClose()}
      className="flex min-h-0 w-full flex-col border-l border-white/5 bg-panel outline-none lg:w-[26rem]"
    >
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-white/5 px-4">
        <h2 className="flex-1 font-medium text-zinc-100">Thread</h2>
        <Button variant="ghost" size="icon-sm" aria-label="Close thread" onClick={onClose}>
          <XIcon />
        </Button>
      </header>
      {error && <p role="alert" className="p-4 text-sm text-destructive">{error}</p>}
      {!page && !error && <p className="p-4 text-sm text-muted-foreground">Loading…</p>}
      {page && <ChannelChat {...chat} initialPage={page} threadRoot={root} />}
    </aside>
  );
}
