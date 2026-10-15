"use client";

import { PencilIcon, Trash2Icon, UserXIcon } from "lucide-react";
import Image from "next/image";
import { useId, useState, useTransition } from "react";
import { blockUser, deleteMessage, editMessage } from "@/app/app/actions";
import { Button } from "@/components/ui/button";
import { MESSAGE_MAX_LENGTH } from "@/lib/limits";
import { decodeMentions, encodeMentions, splitMentions, type Mention } from "@/lib/mentions";
import type { MessageView } from "@/server/messages";
import { ReportDialog } from "../report-dialog";
import { Avatar, nameColor } from "../avatar";

const timeFormat = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" });
const dateTimeFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

/** Renders stored content with `<@id>` tokens as readable, highlighted names. */
function MessageContent({ content, mentions, currentUserId }: { content: string; mentions: readonly Mention[]; currentUserId?: string }) {
  const names = new Map(mentions.map((m) => [m.id, m.name]));
  return splitMentions(content).map((part, i) =>
    part.type === "text" ? (
      part.text
    ) : (
      <span
        key={i}
        className={`rounded px-0.5 font-medium ${part.id === currentUserId ? "bg-amber-400/25 text-amber-100" : "bg-primary/20 text-indigo-200"}`}
      >
        @{names.get(part.id) ?? "unknown member"}
      </span>
    ),
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
  onDeleted: (id: string) => void;
}

export function MessageItem({ message, currentUserId, blocked, grouped, canEdit, canDelete, onDeleted }: MessageItemProps) {
  const [editing, setEditing] = useState(false);
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
          <button type="button" className="underline hover:text-zinc-200" onClick={() => setRevealed(true)}>Show</button>
        </p>
      </li>
    );
  }

  return (
    <li
      className={`group relative flex gap-3 px-5 hover:bg-white/[0.03] focus-within:bg-white/[0.03] [content-visibility:auto] ${grouped ? "py-0.5" : "mt-4 py-0.5"} ${mentionsMe ? "border-l-2 border-amber-400 bg-amber-400/[0.07]" : ""}`}
      aria-busy={pending || undefined}
    >
      <div className="w-8 shrink-0">
        {!grouped && <Avatar name={message.authorName} />}
      </div>
      <div className="min-w-0 flex-1">
        {!grouped && (
          <p className="flex items-baseline gap-2">
            <span className={`font-medium ${nameColor(message.authorId)}`}>{message.authorName}</span>
            <time dateTime={message.createdAt} title={dateTimeFormat.format(created)} className="text-[11px] text-zinc-400" suppressHydrationWarning>
              {dateTimeFormat.format(created)}
            </time>
          </p>
        )}
        {grouped && <span className="sr-only" suppressHydrationWarning>{message.authorName}, {timeFormat.format(created)}: </span>}
        {editing ? (
          <EditForm initial={decodeMentions(message.content, message.mentions)} pending={pending} onSave={onSaveEdit} onCancel={() => setEditing(false)} />
        ) : (
          (message.content || message.editedAt) && (
            <p className="break-words whitespace-pre-wrap text-zinc-300">
              <MessageContent content={message.content} mentions={message.mentions} currentUserId={currentUserId} />
              {message.editedAt && <span className="ml-1 text-[11px] text-zinc-400">(edited)</span>}
            </p>
          )
        )}
        {message.attachments.length > 0 && (
          <ul aria-label="Images" className="mt-1 flex flex-wrap gap-2">
            {message.attachments.map((a, i) => (
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
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      </div>
      {!editing && (
        <div className="absolute -top-3 right-4 flex rounded-md border bg-popover opacity-0 shadow-sm group-focus-within:opacity-100 group-hover:opacity-100 max-md:static max-md:self-start max-md:border-0 max-md:bg-transparent max-md:opacity-100 max-md:shadow-none">
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
      <p className="min-w-0 flex-1 break-words whitespace-pre-wrap text-zinc-300">
        <MessageContent content={content} mentions={mentions} />
        {images > 0 && <span className="block text-[11px] text-zinc-400">Sending {images === 1 ? "1 image" : `${images} images`}…</span>}
      </p>
    </li>
  );
}
