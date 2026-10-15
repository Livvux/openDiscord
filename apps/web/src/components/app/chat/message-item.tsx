"use client";

import { PencilIcon, Trash2Icon } from "lucide-react";
import { useId, useState, useTransition } from "react";
import { deleteMessage, editMessage } from "@/app/app/actions";
import { Button } from "@/components/ui/button";
import { MESSAGE_MAX_LENGTH } from "@/lib/limits";
import type { MessageView } from "@/server/messages";
import { Avatar } from "../avatar";

const timeFormat = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" });
const dateTimeFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

interface MessageItemProps {
  message: MessageView;
  grouped: boolean;
  canEdit: boolean;
  canDelete: boolean;
  onDeleted: (id: string) => void;
}

export function MessageItem({ message, grouped, canEdit, canDelete, onDeleted }: MessageItemProps) {
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const created = new Date(message.createdAt);

  function onDelete() {
    if (!window.confirm("Delete this message? This can't be undone.")) return;
    startTransition(async () => {
      const result = await deleteMessage(message.id);
      if (result.ok) onDeleted(message.id);
      else setError(result.error);
    });
  }

  function onSaveEdit(content: string) {
    startTransition(async () => {
      const result = await editMessage(message.id, content);
      if (result.ok) {
        setEditing(false);
        setError(null);
      } else setError(result.error);
    });
  }

  return (
    <li
      className={`group relative flex gap-3 px-4 hover:bg-muted/30 focus-within:bg-muted/30 [content-visibility:auto] ${grouped ? "py-0.5" : "mt-3 py-1"}`}
      aria-busy={pending || undefined}
    >
      <div className="w-10 shrink-0">
        {!grouped && <Avatar name={message.authorName} />}
      </div>
      <div className="min-w-0 flex-1">
        {!grouped && (
          <p className="flex items-baseline gap-2">
            <span className="font-semibold">{message.authorName}</span>
            <time dateTime={message.createdAt} title={dateTimeFormat.format(created)} className="text-xs text-muted-foreground" suppressHydrationWarning>
              {dateTimeFormat.format(created)}
            </time>
          </p>
        )}
        {grouped && <span className="sr-only" suppressHydrationWarning>{message.authorName}, {timeFormat.format(created)}: </span>}
        {editing ? (
          <EditForm initial={message.content} pending={pending} onSave={onSaveEdit} onCancel={() => setEditing(false)} />
        ) : (
          <p className="break-words whitespace-pre-wrap">
            {message.content}
            {message.editedAt && <span className="ml-1 text-xs text-muted-foreground">(edited)</span>}
          </p>
        )}
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      </div>
      {!editing && (canEdit || canDelete) && (
        <div className="absolute -top-3 right-4 flex rounded-md border bg-popover opacity-0 shadow-sm group-focus-within:opacity-100 group-hover:opacity-100 max-md:static max-md:self-start max-md:border-0 max-md:bg-transparent max-md:opacity-100 max-md:shadow-none">
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
        className="field-sizing-content min-h-10 w-full resize-none rounded-lg border border-input bg-input/30 px-3 py-2 text-sm outline-none focus-visible:border-ring"
      />
      <p className="text-xs text-muted-foreground">
        Escape to <button type="button" className="underline" onClick={onCancel}>cancel</button> · Enter to{" "}
        <button type="submit" className="underline" disabled={pending}>save</button>
      </p>
    </form>
  );
}

export function PendingItem({ content }: { content: string }) {
  return (
    <li className="flex gap-3 px-4 py-0.5 opacity-60" aria-label="Sending">
      <div className="w-10 shrink-0" />
      <p className="min-w-0 flex-1 break-words whitespace-pre-wrap">{content}</p>
    </li>
  );
}
