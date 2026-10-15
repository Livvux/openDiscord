"use client";

import { ImagePlusIcon, LoaderCircleIcon, SendHorizontalIcon, XIcon } from "lucide-react";
import Image from "next/image";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { ACCEPTED_IMAGE_TYPES, MAX_ATTACHMENT_BYTES, MAX_ATTACHMENTS_PER_MESSAGE, MESSAGE_MAX_LENGTH } from "@/lib/limits";

interface ComposerProps {
  channelId: string;
  channelName: string;
  draft: string;
  setDraft: (draft: string) => void;
  /** Resolves true when the message was sent; attachments are kept otherwise. */
  onSend: (content: string, attachmentIds: string[]) => Promise<boolean>;
  /** Object storage is configured on this instance. */
  mediaEnabled: boolean;
}

interface Upload {
  localId: string;
  name: string;
  preview: string;
  id?: string;
  error?: string;
}

const MAX_MB = MAX_ATTACHMENT_BYTES / 1024 / 1024;

async function uploadFile(channelId: string, file: File): Promise<string> {
  const res = await fetch(`/api/channels/${channelId}/attachments`, { method: "POST", body: file, headers: { "Content-Type": file.type } });
  const body = (await res.json().catch(() => null)) as { id?: string; error?: string } | null;
  if (!res.ok || !body?.id) throw new Error(body?.error ?? "Upload failed.");
  return body.id;
}

export function Composer({ channelId, channelName, draft, setDraft, onSend, mediaEnabled }: ComposerProps) {
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [sending, setSending] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const previews = useRef(new Set<string>());

  useEffect(() => {
    const urls = previews.current;
    return () => urls.forEach((url) => URL.revokeObjectURL(url));
  }, []);

  const update = (localId: string, patch: Partial<Upload>) =>
    setUploads((list) => list.map((u) => (u.localId === localId ? { ...u, ...patch } : u)));

  function remove(localId: string) {
    setUploads((list) => {
      const gone = list.find((u) => u.localId === localId);
      if (gone) {
        URL.revokeObjectURL(gone.preview);
        previews.current.delete(gone.preview);
      }
      return list.filter((u) => u.localId !== localId);
    });
  }

  function addFiles(files: File[]) {
    const room = MAX_ATTACHMENTS_PER_MESSAGE - uploads.length;
    for (const file of files.slice(0, Math.max(room, 0))) {
      const localId = crypto.randomUUID();
      const preview = URL.createObjectURL(file);
      previews.current.add(preview);
      const accepted = (ACCEPTED_IMAGE_TYPES as readonly string[]).includes(file.type);
      // Mirrors the server checks for fast feedback; the server re-validates everything.
      const error = !accepted ? "Use a PNG, JPEG, WebP or GIF image." : file.size > MAX_ATTACHMENT_BYTES ? `Images can be at most ${MAX_MB} MB.` : undefined;
      setUploads((list) => [...list, { localId, name: file.name, preview, error }]);
      if (!error) {
        uploadFile(channelId, file).then(
          (id) => update(localId, { id }),
          (e: unknown) => update(localId, { error: e instanceof Error ? e.message : "Upload failed." }),
        );
      }
    }
  }

  const uploading = uploads.some((u) => !u.id && !u.error);
  const ready = uploads.filter((u) => u.id).map((u) => u.id!);
  const failed = uploads.find((u) => u.error);
  const canSend = !sending && !uploading && !failed && (draft.trim().length > 0 || ready.length > 0);

  async function submit() {
    if (!canSend) return;
    const content = draft.trim();
    setDraft("");
    if (ready.length === 0) {
      void onSend(content, []);
      return;
    }
    setSending(true);
    const sent = await onSend(content, ready);
    setSending(false);
    if (sent) {
      uploads.forEach((u) => URL.revokeObjectURL(u.preview));
      setUploads([]);
    }
  }

  const remaining = MESSAGE_MAX_LENGTH - draft.length;
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
      className="mx-4 mb-4 rounded-lg bg-white/5 ring-1 ring-white/10 focus-within:ring-2 focus-within:ring-ring"
    >
      {uploads.length > 0 && (
        <ul aria-label="Attached images" className="flex flex-wrap gap-2 px-3 pt-3">
          {uploads.map((u) => (
            <li key={u.localId} className={`relative size-20 overflow-hidden rounded-md ring-1 ${u.error ? "ring-destructive" : "ring-white/15"}`}>
              <Image src={u.preview} alt={u.name} fill unoptimized className={`object-cover ${u.id ? "" : "opacity-50"}`} />
              {!u.id && !u.error && (
                <span className="absolute inset-0 grid place-items-center" role="status" aria-label={`Uploading ${u.name}`}>
                  <LoaderCircleIcon className="size-5 animate-spin text-zinc-100 motion-reduce:animate-none" aria-hidden />
                </span>
              )}
              <Button
                type="button"
                variant="secondary"
                size="icon-xs"
                className="absolute top-1 right-1"
                aria-label={`Remove ${u.name}`}
                onClick={() => remove(u.localId)}
              >
                <XIcon />
              </Button>
            </li>
          ))}
        </ul>
      )}
      {failed && (
        <p role="alert" className="px-4 pt-2 text-sm text-destructive">
          {failed.name}: {failed.error} Remove it to send.
        </p>
      )}
      <div className="flex items-end gap-2 py-1 pr-1 pl-2">
        {mediaEnabled && (
          <>
            <input
              ref={fileInput}
              type="file"
              accept={ACCEPTED_IMAGE_TYPES.join(",")}
              multiple
              hidden
              onChange={(e) => {
                addFiles([...(e.target.files ?? [])]);
                e.target.value = "";
              }}
            />
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="mb-1 text-zinc-300"
              aria-label={`Attach images (up to ${MAX_ATTACHMENTS_PER_MESSAGE}, ${MAX_MB} MB each)`}
              title={`Attach images (up to ${MAX_ATTACHMENTS_PER_MESSAGE}, ${MAX_MB} MB each)`}
              disabled={uploads.length >= MAX_ATTACHMENTS_PER_MESSAGE}
              onClick={() => fileInput.current?.click()}
            >
              <ImagePlusIcon />
            </Button>
          </>
        )}
        <label htmlFor="composer" className="sr-only">
          Message #{channelName}
        </label>
        <textarea
          id="composer"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onPaste={(e) => {
            const files = [...e.clipboardData.files].filter((f) => f.type.startsWith("image/"));
            if (mediaEnabled && files.length > 0) {
              e.preventDefault();
              addFiles(files);
            }
          }}
          onKeyDown={(e) => {
            // Enter sends, Shift+Enter adds a line; don't interrupt IME composition.
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void submit();
            }
          }}
          rows={1}
          maxLength={MESSAGE_MAX_LENGTH}
          placeholder={`Message #${channelName}`}
          aria-describedby={remaining < 200 ? "composer-remaining" : undefined}
          className={`field-sizing-content max-h-48 min-h-10 flex-1 resize-none bg-transparent py-2 text-zinc-100 outline-none placeholder:text-zinc-400 ${mediaEnabled ? "" : "pl-2"}`}
        />
        {remaining < 200 && (
          <span id="composer-remaining" className="pb-2.5 text-[11px] text-zinc-400">
            {remaining}
          </span>
        )}
        <Button type="submit" size="icon" aria-label="Send message" disabled={!canSend} className="mb-1">
          <SendHorizontalIcon />
        </Button>
      </div>
    </form>
  );
}
