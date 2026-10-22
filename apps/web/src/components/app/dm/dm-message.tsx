"use client";

import { CopyIcon, FlagIcon, HashIcon } from "lucide-react";
import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from "@/components/ui/context-menu";
import type { PrivateMessaging } from "@/lib/dm/client";
import type { DmAttachment } from "@/lib/dm/contracts";
import { decryptionHint } from "@/lib/dm/decryption-diagnostics";
import { DmAttachmentView } from "./dm-attachment";
import { Avatar, nameColor } from "../avatar";
import { EmojiText } from "../emoji-text";
import { GifEmbed } from "../gif-embed";
import { gifSource } from "@/lib/gifs";

export type MessageView = Awaited<ReturnType<PrivateMessaging["decrypt"]>>[number];
const dateTimeFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "short", timeStyle: "short" });

/** A private message in the channel layout. These actions use only text already decrypted in this browser. Reporting keeps its explicit disclosure step. */
export function PrivateMessageItem({ message, authorName, authorAvatar, onError, onReport, openAttachment, reply, onReply, onEdit, onDelete, onReact, userId, disabled = false }: {
  message: MessageView;
  openAttachment: (file: DmAttachment) => Promise<Blob>;
  authorName: string;
  authorAvatar: string | null;
  onError: (error: string) => void;
  onReport: () => void;
  reply?: MessageView;
  onReply?: () => void;
  onEdit?: (body: string) => Promise<void>;
  onDelete?: () => Promise<void>;
  onReact?: (emoji: "👍" | "❤️" | "😂" | "🎉" | "😮" | "😢", active: boolean) => Promise<void>;
  userId?: string;
  disabled?: boolean;
}) {
  const [notice, setNotice] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  async function act(action: () => Promise<void>) {
    setSaving(true);
    try { await action(); setEditing(false); } catch (error) { onError(error instanceof Error ? error.message : "Could not update this message."); }
    finally { setSaving(false); }
  }
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
  const hint = message.diagnostic ? decryptionHint(message.diagnostic) : null;
  return (
    <ContextMenu onOpenChange={(open) => { if (open) handoffFocus.current = false; }}>
      {/* Direct <p> children (header, then body) are a contract with desktop/tests/native_app_flows.py. */}
      <ContextMenuTrigger render={<li id={`dm-${message.id}`} />} className="grid grid-cols-[2rem_minmax(0,1fr)] gap-x-3 px-4 py-1.5 outline-none hover:bg-white/[0.03] focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset [&>*:not(:first-child)]:col-start-2">
        <span className="row-span-4 pt-0.5"><Avatar name={authorName} avatar={authorAvatar} /></span>
        <p className="flex flex-wrap items-baseline gap-x-1.5">
          <span className={`font-medium ${nameColor(message.senderId)}`}>{message.own ? "You" : authorName}</span>{" "}
          <span aria-hidden className="text-zinc-500">·</span>{" "}
          <time dateTime={message.createdAt} className="text-[11px] whitespace-nowrap text-zinc-400" suppressHydrationWarning>{dateTimeFormat.format(created)}</time>
        </p>
        {message.replyTo && <a href={`#dm-${message.replyTo}`} className="block truncate border-l-2 pl-2 text-xs text-muted-foreground">Reply: {reply?.deleted ? "Deleted message" : reply?.body ?? "Earlier message — load history to view"}</a>}
        {message.deleted && <p className="text-sm italic text-muted-foreground">Message deleted</p>}
        {/* A GIF embed can't live inside <p>; text keeps <p>, which native acceptance reads. */}
        {message.body && gifSource(message.body) ? <div><GifEmbed url={message.body} /></div> : message.body === "" ? null : <p className={`break-words whitespace-pre-wrap ${message.body ? "text-zinc-300" : "text-sm text-destructive"}`} data-dm-failure-stage={message.diagnostic?.stage} data-dm-failure-code={message.diagnostic?.code} data-dm-shield-color={message.diagnostic?.shieldColor} data-dm-shield-code={message.diagnostic?.shieldCode}>{message.body ? <EmojiText text={message.body} /> : message.error}</p>}
        {hint && <p className="text-xs text-muted-foreground" data-dm-failure-hint>{hint}</p>}
        {message.attachments?.map((file) => <div key={`${file.id}:${file.info}`}><DmAttachmentView file={file} open={openAttachment} /></div>)}
        {message.edited && !message.deleted && <span className="text-[10px] text-muted-foreground">Edited</span>}
        {!message.deleted && message.body !== null && onReply && <div className="flex flex-wrap items-center gap-2 text-xs">
          <button type="button" disabled={disabled || saving} onClick={onReply} className="min-h-7 underline">Reply</button>
          {message.own && onEdit && <button type="button" disabled={disabled || saving} onClick={() => { setDraft(message.body ?? ""); setEditing(true); }} className="min-h-7 underline">Edit</button>}
          {message.own && onDelete && <button type="button" disabled={disabled || saving} onClick={() => { if (window.confirm("Delete this message for everyone? Downloaded copies and older backups may remain.")) void act(onDelete); }} className="min-h-7 text-destructive underline">Delete</button>}
          {onReact && <details><summary className="min-h-7 cursor-pointer py-1">React</summary><div className="flex flex-wrap gap-1">{(["👍", "❤️", "😂", "🎉", "😮", "😢"] as const).map((emoji) => <button key={emoji} type="button" className="min-h-8 min-w-8 rounded border" disabled={disabled || saving} aria-label={`React ${emoji}`} onClick={() => void act(() => onReact(emoji, !message.reactions?.find((r) => r.emoji === emoji)?.users.includes(userId ?? "")))}>{emoji}</button>)}</div></details>}
        </div>}
        {!!message.reactions?.length && !message.deleted && <div className="flex flex-wrap gap-1">{message.reactions.map((reaction) => <button type="button" key={reaction.emoji} aria-label={`${reaction.emoji}: ${reaction.users.length} reactions`} aria-pressed={reaction.users.includes(userId ?? "")} className="min-h-8 rounded border px-2 text-xs aria-pressed:border-brand-mint" disabled={!onReact || disabled || saving} onClick={() => void act(() => onReact!(reaction.emoji, !reaction.users.includes(userId ?? "")))}>{reaction.emoji} {reaction.users.length}</button>)}</div>}
        {editing && onEdit && <form className="grid gap-2 py-2" onSubmit={(event) => { event.preventDefault(); if (draft.trim()) void act(() => onEdit(draft)); }}>
          <label className="grid gap-1 text-sm">Edit encrypted message<textarea autoFocus className="rounded border bg-background p-2" value={draft} maxLength={4000} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Escape") setEditing(false); }} /></label>
          <div className="flex gap-2"><Button type="submit" size="sm" disabled={disabled || saving || !draft.trim()}>Save edit</Button><Button type="button" size="sm" variant="outline" disabled={saving} onClick={() => setEditing(false)}>Cancel edit</Button></div>
        </form>}
        {!message.own && !message.deleted && message.body !== null && <button type="button" className="mt-0.5 min-h-6 w-fit rounded text-xs text-zinc-400 hover:text-zinc-100 hover:underline focus-visible:outline-2 focus-visible:outline-ring" onClick={onReport}>Report private message</button>}
        {notice && <p role="status" className="mt-1 text-xs text-muted-foreground">{notice}</p>}
      </ContextMenuTrigger>
      <ContextMenuContent aria-label="Private message actions" finalFocus={() => handoffFocus.current ? false : true}>
        {message.body && <ContextMenuItem onClick={() => void copy(message.body!, "Message text copied.")}><CopyIcon aria-hidden />Copy text</ContextMenuItem>}
        <ContextMenuItem onClick={() => void copy(message.id, "Message ID copied.")}><HashIcon aria-hidden />Copy message ID</ContextMenuItem>
        {!message.own && !message.deleted && message.body !== null && <><ContextMenuSeparator /><ContextMenuItem onClick={() => { handoffFocus.current = true; onReport(); }}><FlagIcon aria-hidden />Report private message</ContextMenuItem></>}
      </ContextMenuContent>
    </ContextMenu>
  );
}
