"use client";

import { CopyIcon, FlagIcon, HashIcon } from "lucide-react";
import { useRef, useState } from "react";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from "@/components/ui/context-menu";
import type { PrivateMessaging } from "@/lib/dm/client";
import { Avatar, nameColor } from "../avatar";
import { EmojiText } from "../emoji-text";

export type MessageView = Awaited<ReturnType<PrivateMessaging["decrypt"]>>[number];
const dateTimeFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "short", timeStyle: "short" });

/** A private message in the channel layout. These actions use only text already decrypted in this browser. Reporting keeps its explicit disclosure step. */
export function PrivateMessageItem({ message, authorName, onError, onReport }: {
  message: MessageView;
  authorName: string;
  onError: (error: string) => void;
  onReport: () => void;
}) {
  const [notice, setNotice] = useState<string | null>(null);
  const handoffFocus = useRef(false);
  async function copy(value: string, success: string) {
    try {
      await navigator.clipboard.writeText(value);
      setNotice(success);
    } catch {
      onError("Couldn't copy. Your browser may not allow clipboard access.");
    }
  }
  const created = new Date(message.createdAt);
  return (
    <ContextMenu onOpenChange={(open) => { if (open) handoffFocus.current = false; }}>
      {/* Direct <p> children (header, then body) are a contract with desktop/tests/native_app_flows.py. */}
      <ContextMenuTrigger render={<li />} className="grid grid-cols-[2rem_minmax(0,1fr)] gap-x-3 px-4 py-1.5 outline-none hover:bg-white/[0.03] focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset [&>*:not(:first-child)]:col-start-2">
        <span className="row-span-4 pt-0.5"><Avatar name={authorName} /></span>
        <p className="flex flex-wrap items-baseline gap-x-1.5">
          <span className={`font-medium ${nameColor(message.senderId)}`}>{message.own ? "You" : authorName}</span>{" "}
          <span aria-hidden className="text-zinc-500">·</span>{" "}
          <time dateTime={message.createdAt} className="text-[11px] whitespace-nowrap text-zinc-400" suppressHydrationWarning>{dateTimeFormat.format(created)}</time>
        </p>
        <p className={`break-words whitespace-pre-wrap ${message.body ? "text-zinc-300" : "text-sm text-destructive"}`} data-dm-failure-stage={message.diagnostic?.stage} data-dm-failure-code={message.diagnostic?.code} data-dm-shield-color={message.diagnostic?.shieldColor} data-dm-shield-code={message.diagnostic?.shieldCode}>{message.body ? <EmojiText text={message.body} /> : message.error}</p>
        {!message.own && message.body && <button type="button" className="mt-0.5 min-h-6 w-fit rounded text-xs text-zinc-400 hover:text-zinc-100 hover:underline focus-visible:outline-2 focus-visible:outline-ring" onClick={onReport}>Report private message</button>}
        {notice && <p role="status" className="mt-1 text-xs text-muted-foreground">{notice}</p>}
      </ContextMenuTrigger>
      <ContextMenuContent aria-label="Private message actions" finalFocus={() => handoffFocus.current ? false : true}>
        {message.body && <ContextMenuItem onClick={() => void copy(message.body!, "Message text copied.")}><CopyIcon aria-hidden />Copy text</ContextMenuItem>}
        <ContextMenuItem onClick={() => void copy(message.id, "Message ID copied.")}><HashIcon aria-hidden />Copy message ID</ContextMenuItem>
        {!message.own && message.body && <><ContextMenuSeparator /><ContextMenuItem onClick={() => { handoffFocus.current = true; onReport(); }}><FlagIcon aria-hidden />Report private message</ContextMenuItem></>}
      </ContextMenuContent>
    </ContextMenu>
  );
}
