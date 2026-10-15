"use client";

import { PinIcon } from "lucide-react";
import { useState } from "react";
import { listPinned } from "@/app/app/actions";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import type { MessageView } from "@/server/messages";
import { MessageContent } from "./message-item";

const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });

export function PinnedDialog({ channelId, channelName }: { channelId: string; channelName: string }) {
  const [messages, setMessages] = useState<MessageView[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setMessages(null);
    const result = await listPinned(channelId);
    if (result.ok) setMessages(result.data);
    else setError(result.error);
  }

  return (
    <Dialog onOpenChange={(open) => open && void load()}>
      <DialogTrigger render={<Button variant="ghost" size="icon" aria-label="Pinned messages" />}>
        <PinIcon />
      </DialogTrigger>
      <DialogContent className="max-h-[80dvh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Pinned in #{channelName}</DialogTitle>
        </DialogHeader>
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        {!messages && !error && <p className="text-sm text-muted-foreground">Loading…</p>}
        {messages?.length === 0 && <p className="text-sm text-muted-foreground">Nothing pinned yet. Moderators can pin messages from their menu.</p>}
        {messages && messages.length > 0 && (
          <ol className="divide-y rounded-lg border">
            {messages.map((m) => (
              <li key={m.id} className="grid gap-0.5 px-3 py-2 text-sm">
                <p className="flex gap-2 text-xs text-zinc-400">
                  <span className="font-medium text-zinc-200">{m.authorName}</span>
                  {m.authorImported && <span className="text-zinc-500">(imported)</span>}
                  <time dateTime={m.createdAt} suppressHydrationWarning>{dateFormat.format(new Date(m.createdAt))}</time>
                </p>
                <div className="break-words whitespace-pre-wrap text-zinc-300">
                  <MessageContent content={m.content} mentions={m.mentions} />
                  {m.attachments.length > 0 && <span className="text-xs text-zinc-400"> ({m.attachments.length} image{m.attachments.length === 1 ? "" : "s"})</span>}
                </div>
              </li>
            ))}
          </ol>
        )}
      </DialogContent>
    </Dialog>
  );
}
