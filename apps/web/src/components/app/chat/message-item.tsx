"use client";

import { CornerUpLeftIcon, FileDownIcon, MessagesSquareIcon, PencilIcon, PinIcon, PinOffIcon, SmilePlusIcon, Trash2Icon, UserXIcon } from "lucide-react";
import Image from "next/image";
import { useId, useRef, useState, useTransition } from "react";
import { blockUser, deleteMessage, editMessage, setPinned, toggleReaction } from "@/app/app/actions";
import { Button } from "@/components/ui/button";
import { MESSAGE_MAX_LENGTH } from "@/lib/limits";
import { shortFilename } from "@/lib/filename";
import { renderMarkdown } from "@/lib/markdown";
import { decodeMentions, encodeMentions, type Mention } from "@/lib/mentions";
import type { MessageView } from "@/server/messages";
import { ReportDialog } from "../report-dialog";
import { nameColor } from "../avatar";
import { PresenceAvatar } from "../presence-avatar";

const timeFormat = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" });
const dateTimeFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export const QUICK_REACTIONS = ["👍", "❤️", "😂", "🎉", "😮", "😢", "👀", "✅"];

/** Renders stored content: the Markdown subset, with `<@id>` tokens as readable, highlighted names. */
export function MessageContent({ content, mentions, currentUserId }: { content: string; mentions: readonly Mention[]; currentUserId?: string }) {
  const names = new Map(mentions.map((m) => [m.id, m.name]));
  return renderMarkdown(content, (id, key) => (
    <span
      key={key}
      className={`rounded px-0.5 font-medium ${id === currentUserId ? "bg-amber-400/25 text-amber-100" : "bg-primary/20 text-indigo-200"}`}
    >
      @{names.get(id) ?? "unknown member"}
    </span>
  ));
}

function ReactionPicker({ onPick, onClose }: { onPick: (emoji: string) => void; onClose: () => void }) {
  return (
    <div
      role="group"
      aria-label="Add a reaction"
      onKeyDown={(e) => e.key === "Escape" && onClose()}
      // Inline, not floating: rows use content-visibility, whose paint containment would clip a popover.
      className="mt-1 flex w-fit flex-wrap gap-0.5 rounded-lg border bg-popover p-1 shadow-lg"
    >
      {QUICK_REACTIONS.map((emoji, i) => (
        <button
          key={emoji}
          type="button"
          autoFocus={i === 0}
          aria-label={`React with ${emoji}`}
          onClick={() => onPick(emoji)}
          className="grid size-8 place-items-center rounded-md text-lg hover:bg-white/10 focus-visible:outline-2 focus-visible:outline-ring"
        >
          {emoji}
        </button>
      ))}
    </div>
  );
}

interface MessageItemProps {
  message: MessageView;
  currentUserId: string;
  /** The author is blocked by the viewer: collapsed until revealed. */
  blocked: boolean;
  grouped: boolean;
  canEdit: boolean;
  canDelete: boolean;
  /** May reply and react (send permission in this channel). */
  canReact: boolean;
  /** May pin (manage messages in this channel). */
  canPin: boolean;
  /** The replied-to author is blocked by the viewer: hide the preview text. */
  replyBlocked: boolean;
  onDeleted: (id: string) => void;
  onReply: (message: MessageView) => void;
  /** Channel messages only: open (or start) this message's thread. */
  onOpenThread?: (message: MessageView) => void;
}

export function MessageItem(props: MessageItemProps) {
  const { message, currentUserId, blocked, grouped, canEdit, canDelete, canReact, canPin, replyBlocked, onDeleted, onReply, onOpenThread } = props;
  const [editing, setEditing] = useState(false);
  const [picking, setPicking] = useState(false);
  const reactButton = useRef<HTMLButtonElement>(null);
  const [revealed, setRevealed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const created = new Date(message.createdAt);
  const mentionsMe = message.mentions.some((m) => m.id === currentUserId);

  function onDelete() {
    if (!window.confirm("Delete this message? This can't be undone.")) return;
    startTransition(async () => {
      const result = await deleteMessage(message.id);
      if (result.ok) onDeleted(message.id);
      else setError(result.error);
    });
  }

  function onBlock() {
    if (!window.confirm(`Block ${message.authorName}? Their messages will be hidden for you and their mentions won't notify you. They won't be told.`)) return;
    startTransition(async () => {
      const result = await blockUser(message.authorId);
      if (!result.ok) setError(result.error);
    });
  }

  function run(action: () => Promise<{ ok: boolean; error?: string }>) {
    startTransition(async () => {
      const result = await action();
      setError(result.ok ? null : (result.error ?? "Something went wrong."));
    });
  }

  function closePicker() {
    setPicking(false);
    // The picker unmounts; keep keyboard focus where it was opened.
    reactButton.current?.focus();
  }

  function react(emoji: string) {
    closePicker();
    run(() => toggleReaction(message.id, emoji));
  }

  function jumpToReply(e: React.MouseEvent<HTMLButtonElement>, id: string) {
    const target = e.currentTarget.closest('[role="log"]')?.querySelector<HTMLElement>(`[data-message-id="${id}"]`);
    if (!target) return setError("The original message isn't loaded. Load older messages to see it.");
    target.scrollIntoView({ block: "center", behavior: "smooth" });
    target.focus();
  }

  function onSaveEdit(content: string) {
    startTransition(async () => {
      const result = await editMessage(message.id, encodeMentions(content, message.mentions));
      if (result.ok) {
        setEditing(false);
        setError(null);
      } else setError(result.error);
    });
  }

  if (blocked && !revealed) {
    return (
      <li className={`flex gap-3 px-5 py-0.5 text-sm text-zinc-400 ${grouped ? "" : "mt-4"}`}>
        <div className="w-8 shrink-0" />
        <p>
          Message from a blocked person.{" "}
          <button type="button" aria-label="Show blocked message" className="underline hover:text-zinc-200" onClick={() => setRevealed(true)}>Show</button>
        </p>
      </li>
    );
  }

  return (
    <li
      data-message-id={message.id}
      tabIndex={-1}
      className={`group relative flex gap-3 px-5 outline-none hover:bg-white/[0.03] focus-within:bg-white/[0.03] [content-visibility:auto] ${grouped ? "py-0.5" : "mt-4 py-0.5"} ${mentionsMe ? "border-l-2 border-amber-400 bg-amber-400/[0.07]" : ""}`}
      aria-busy={pending || undefined}
    >
      <div className="w-8 shrink-0">
        {!grouped && <PresenceAvatar userId={message.authorId} name={message.authorName} />}
      </div>
      <div className="min-w-0 flex-1">
        {message.replyTo && (
          <button
            type="button"
            onClick={(e) => jumpToReply(e, message.replyTo!.id)}
            className="flex max-w-full items-center gap-1 truncate text-left text-xs text-zinc-400 hover:text-zinc-200"
          >
            <CornerUpLeftIcon aria-hidden className="size-3 shrink-0" />
            <span className="sr-only">Reply to </span>
            <span className={`font-medium ${nameColor(message.replyTo.authorImported ? message.replyTo.authorName : message.replyTo.authorId)}`}>{message.replyTo.authorName}</span>
            {message.replyTo.authorImported && <span className="text-[10px] text-zinc-500">(imported)</span>}
            <span className="truncate">{replyBlocked ? "Message from a blocked person" : message.replyTo.excerpt || "an image"}</span>
          </button>
        )}
        {!grouped && (
          <p className="flex items-baseline gap-2">
            {/* Imported authors share the importer's account, so colour them by name instead. */}
            <span className={`font-medium ${nameColor(message.authorImported ? message.authorName : message.authorId)}`}>{message.authorName}</span>
            {message.authorBot && <span className="rounded bg-primary/30 px-1 text-[10px] font-semibold text-indigo-100">BOT</span>}
            {message.authorImported && <span className="rounded bg-white/10 px-1 text-[10px] font-semibold text-zinc-300" title="Imported from another instance">IMPORTED</span>}
            <time dateTime={message.createdAt} title={dateTimeFormat.format(created)} className="text-[11px] text-zinc-400" suppressHydrationWarning>
              {dateTimeFormat.format(created)}
            </time>
            {message.pinned && <span className="inline-flex items-center gap-0.5 text-[11px] text-zinc-400"><PinIcon aria-hidden className="size-3" />Pinned</span>}
          </p>
        )}
        {grouped && <span className="sr-only" suppressHydrationWarning>{message.authorName}, {timeFormat.format(created)}: </span>}
        {editing ? (
          <EditForm initial={decodeMentions(message.content, message.mentions)} pending={pending} onSave={onSaveEdit} onCancel={() => setEditing(false)} />
        ) : (
          (message.content || message.editedAt) && (
            <div className="break-words whitespace-pre-wrap text-zinc-300">
              <MessageContent content={message.content} mentions={message.mentions} currentUserId={currentUserId} />
              {message.editedAt && <span className="ml-1 text-[11px] text-zinc-400">(edited)</span>}
            </div>
          )
        )}
        {message.attachments.some((a) => !a.filename) && (
          <ul aria-label="Images" className="mt-1 flex flex-wrap gap-2">
            {message.attachments.filter((a) => !a.filename).map((a, i) => (
              <li key={a.id}>
                <a
                  href={`/api/attachments/${a.id}`}
                  target="_blank"
                  rel="noopener"
                  className="block overflow-hidden rounded-lg ring-1 ring-white/10 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                >
                  {/* Served through the access-checked route; the optimizer must not cache it publicly. */}
                  <Image
                    src={`/api/attachments/${a.id}`}
                    alt={`Image ${i + 1} from ${message.authorName}`}
                    width={a.width}
                    height={a.height}
                    unoptimized
                    loading="lazy"
                    className="h-auto max-h-80 w-auto max-w-[min(100%,28rem)] bg-white/5 object-contain"
                  />
                </a>
              </li>
            ))}
          </ul>
        )}
        {message.attachments.some((a) => a.filename) && (
          <ul aria-label="Files" className="mt-1 grid max-w-md gap-1">
            {message.attachments.filter((a) => a.filename).map((a) => (
              <li key={a.id}>
                <a
                  href={`/api/attachments/${a.id}`}
                  download={a.filename!}
                  className="flex items-center gap-2 rounded-lg bg-white/5 px-3 py-2 ring-1 ring-white/10 hover:bg-white/10 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                >
                  <FileDownIcon aria-hidden className="size-5 shrink-0 text-zinc-300" />
                  <span className="min-w-0 flex-1 text-sm break-all text-sky-300" title={a.filename!}>{shortFilename(a.filename!)}</span>
                  <span className="text-xs text-zinc-400">{formatBytes(a.size)}</span>
                </a>
              </li>
            ))}
          </ul>
        )}
        {message.reactions.length > 0 && (
          <ul aria-label="Reactions" className="mt-1 flex flex-wrap gap-1">
            {message.reactions.map((r) => {
              const mine = r.userIds.includes(currentUserId);
              return (
                <li key={r.emoji}>
                  <button
                    type="button"
                    aria-pressed={mine}
                    aria-label={`${r.emoji} ${r.userIds.length} ${r.userIds.length === 1 ? "reaction" : "reactions"}${mine ? ", including you" : ""}`}
                    disabled={!canReact || pending}
                    onClick={() => react(r.emoji)}
                    className={`flex items-center gap-1 rounded-full px-2 py-0.5 text-xs ring-1 ${mine ? "bg-primary/25 text-indigo-100 ring-primary/60" : "bg-white/5 text-zinc-300 ring-white/10 hover:bg-white/10"}`}
                  >
                    <span aria-hidden>{r.emoji}</span>
                    <span aria-hidden>{r.userIds.length}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        {message.thread && onOpenThread && (
          <button
            type="button"
            onClick={() => onOpenThread(message)}
            className="mt-1 flex items-center gap-1.5 rounded-md text-xs font-medium text-sky-300 hover:underline focus-visible:outline-2 focus-visible:outline-ring"
          >
            <MessagesSquareIcon aria-hidden className="size-3.5" />
            {message.thread.count} {message.thread.count === 1 ? "reply" : "replies"}
            <span className="font-normal text-zinc-400" suppressHydrationWarning>· last {timeFormat.format(new Date(message.thread.lastAt))}</span>
          </button>
        )}
        {picking && <ReactionPicker onPick={react} onClose={closePicker} />}
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      </div>
      {!editing && (
        <div className="absolute -top-3 right-4 flex rounded-md border bg-popover opacity-0 shadow-sm group-focus-within:opacity-100 group-hover:opacity-100 max-md:static max-md:self-start max-md:border-0 max-md:bg-transparent max-md:opacity-100 max-md:shadow-none">
          {canReact && (
            <Button variant="ghost" size="icon-sm" aria-label="Reply" onClick={() => onReply(message)}>
              <CornerUpLeftIcon />
            </Button>
          )}
          {canReact && onOpenThread && !message.thread && (
            <Button variant="ghost" size="icon-sm" aria-label="Start a thread" onClick={() => onOpenThread(message)}>
              <MessagesSquareIcon />
            </Button>
          )}
          {canReact && (
            <Button ref={reactButton} variant="ghost" size="icon-sm" aria-label="Add reaction" aria-expanded={picking} onClick={() => setPicking((p) => !p)}>
              <SmilePlusIcon />
            </Button>
          )}
          {canPin && (
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={message.pinned ? "Unpin message" : "Pin message"}
              disabled={pending}
              onClick={() => run(() => setPinned(message.id, !message.pinned))}
            >
              {message.pinned ? <PinOffIcon /> : <PinIcon />}
            </Button>
          )}
          <ReportDialog messageId={message.id} />
          {message.authorId !== currentUserId && !blocked && (
            <Button variant="ghost" size="icon-sm" aria-label={`Block ${message.authorName}`} onClick={onBlock} disabled={pending}>
              <UserXIcon />
            </Button>
          )}
          {canEdit && (
            <Button variant="ghost" size="icon-sm" aria-label="Edit message" onClick={() => setEditing(true)}>
              <PencilIcon />
            </Button>
          )}
          {canDelete && (
            <Button variant="ghost" size="icon-sm" aria-label="Delete message" onClick={onDelete} disabled={pending}>
              <Trash2Icon />
            </Button>
          )}
        </div>
      )}
    </li>
  );
}

function EditForm({ initial, pending, onSave, onCancel }: { initial: string; pending: boolean; onSave: (c: string) => void; onCancel: () => void }) {
  const [value, setValue] = useState(initial);
  const id = useId();
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (value.trim()) onSave(value);
      }}
      className="grid gap-1"
    >
      <label className="sr-only" htmlFor={id}>Edit message</label>
      <textarea
        id={id}
        autoFocus
        value={value}
        maxLength={MESSAGE_MAX_LENGTH}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") onCancel();
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            if (value.trim()) onSave(value);
          }
        }}
        className="field-sizing-content min-h-10 w-full resize-none rounded-lg bg-white/5 px-3 py-2 text-zinc-100 ring-1 ring-white/10 outline-none focus-visible:ring-2 focus-visible:ring-ring"
      />
      <p className="text-[11px] text-zinc-400">
        Escape to <button type="button" className="underline" onClick={onCancel}>cancel</button> · Enter to{" "}
        <button type="submit" className="underline" disabled={pending}>save</button>
      </p>
    </form>
  );
}

export function PendingItem({ content, mentions, images }: { content: string; mentions: Mention[]; images: number }) {
  return (
    <li className="flex gap-3 px-5 py-0.5 opacity-60" aria-label="Sending">
      <div className="w-8 shrink-0" />
      <div className="min-w-0 flex-1 break-words whitespace-pre-wrap text-zinc-300">
        <MessageContent content={content} mentions={mentions} />
        {images > 0 && <span className="block text-[11px] text-zinc-400">Sending {images === 1 ? "1 attachment" : `${images} attachments`}…</span>}
      </div>
    </li>
  );
}
