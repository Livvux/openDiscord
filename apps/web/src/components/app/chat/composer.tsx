"use client";

import { SmilePlusIcon, FileIcon, LoaderCircleIcon, PaperclipIcon, SendHorizontalIcon, XIcon } from "lucide-react";
import Image from "next/image";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { ACCEPTED_IMAGE_TYPES, MAX_ATTACHMENT_BYTES, MAX_ATTACHMENTS_PER_MESSAGE, MAX_FILE_BYTES, MESSAGE_MAX_LENGTH } from "@/lib/limits";
import { shortFilename } from "@/lib/filename";
import { encodeMentions, mentionQuery, type Mention } from "@/lib/mentions";

import { assetShortcode, encodeAssetShortcodes, type AssetRef } from "@/lib/community-assets";
import { CommunityAssetPicker } from "../community-asset-picker";

interface ComposerProps {
  channelId: string;
  channelName: string;
  /** Overrides "Message #channel" (e.g. in threads). */
  placeholder?: string;
  draft: string;
  setDraft: (draft: string) => void;
  /** Resolves true when the message was sent; attachments are kept otherwise. Content has `<@id>` tokens. */
  onSend: (content: string, attachmentIds: string[], mentions: Mention[]) => Promise<boolean>;
  /** Object storage is configured on this instance. */
  mediaEnabled: boolean;
  communityId: string;
  /** The message being replied to, shown above the input. */
  replyTo: { id: string; authorName: string } | null;
  onCancelReply: () => void;
}

interface Upload {
  localId: string;
  name: string;
  /** Object URL for images; null for other files. */
  preview: string | null;
  id?: string;
  error?: string;
}

const MAX_MB = MAX_ATTACHMENT_BYTES / 1024 / 1024;
const MAX_FILE_MB = MAX_FILE_BYTES / 1024 / 1024;
const isImage = (file: File) => (ACCEPTED_IMAGE_TYPES as readonly string[]).includes(file.type);

async function uploadFile(channelId: string, file: File): Promise<string> {
  const res = await fetch(`/api/channels/${channelId}/attachments`, {
    method: "POST",
    body: file,
    headers: { "Content-Type": file.type || "application/octet-stream", "X-Filename": encodeURIComponent(file.name) },
  });
  const body = (await res.json().catch(() => null)) as { id?: string; error?: string } | null;
  if (!res.ok || !body?.id) throw new Error(body?.error ?? "Upload failed.");
  return body.id;
}

/** Member suggestions for the `@query` before the caret. */
function useMentionSuggestions(communityId: string, query: string | null) {
  const [results, setResults] = useState<{ query: string; members: Mention[] } | null>(null);
  useEffect(() => {
    if (query === null) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      fetch(`/api/communities/${communityId}/members?q=${encodeURIComponent(query)}`, { signal: controller.signal })
        .then((r) => (r.ok ? (r.json() as Promise<Mention[]>) : []))
        .then((members) => setResults({ query, members }), () => {});
    }, 120);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [communityId, query]);
  return query !== null && results?.query === query ? results.members : [];
}

export function Composer({ channelId, channelName, placeholder, draft, setDraft, onSend, mediaEnabled, communityId, replyTo, onCancelReply }: ComposerProps) {
  const [mentionAt, setMentionAt] = useState<{ query: string; start: number } | null>(null);
  const [activeOption, setActiveOption] = useState(0);
  const picked = useRef<Mention[]>([]);
  const pickedAssets = useRef<AssetRef[]>([]);
  const [pickingAssets, setPickingAssets] = useState(false);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const pendingCaret = useRef<number | null>(null);
  // Hidden copies of previous routes stay mounted, so ids must be unique per instance.
  const id = useId();
  const optionsId = `${id}-mentions`;
  const suggestions = useMentionSuggestions(communityId, mentionAt?.query ?? null);
  const listOpen = mentionAt !== null && suggestions.length > 0;
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
      if (gone?.preview) {
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
      const image = isImage(file);
      const preview = image ? URL.createObjectURL(file) : null;
      if (preview) previews.current.add(preview);
      // Mirrors the server checks for fast feedback; the server re-validates everything.
      const error =
        file.size === 0 ? "The file is empty."
        : image && file.size > MAX_ATTACHMENT_BYTES ? `Images can be at most ${MAX_MB} MB.`
        : !image && file.size > MAX_FILE_BYTES ? `Files can be at most ${MAX_FILE_MB} MB.`
        : undefined;
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

  function trackMention(el: HTMLTextAreaElement) {
    const next = mentionQuery(el.value, el.selectionStart);
    setMentionAt(next);
    if (next?.query !== mentionAt?.query) setActiveOption(0);
  }

  function pick(m: Mention) {
    if (!mentionAt) return;
    const before = draft.slice(0, mentionAt.start);
    const after = draft.slice(mentionAt.start + 1 + mentionAt.query.length);
    const inserted = `@${m.name} `;
    picked.current = [...picked.current.filter((p) => p.id !== m.id), m];
    setDraft(before + inserted + after);
    setMentionAt(null);
    pendingCaret.current = before.length + inserted.length;
  }

  useEffect(() => {
    if (replyTo) textarea.current?.focus();
  }, [replyTo]);

  // Place the caret after an inserted mention once React has rendered the new value.
  useLayoutEffect(() => {
    if (pendingCaret.current === null) return;
    textarea.current?.setSelectionRange(pendingCaret.current, pendingCaret.current);
    pendingCaret.current = null;
  }, [draft]);

  async function submit() {
    if (!canSend) return;
    const text = draft.trim();
    const mentions = picked.current.filter((m) => text.includes(`@${m.name}`));
    const content = encodeAssetShortcodes(encodeMentions(text, mentions), pickedAssets.current);
    picked.current = [];
    setDraft("");
    setMentionAt(null);
    if (ready.length === 0) {
      void onSend(content, [], mentions);
      return;
    }
    setSending(true);
    const sent = await onSend(content, ready, mentions);
    setSending(false);
    if (sent) {
      uploads.forEach((u) => u.preview && URL.revokeObjectURL(u.preview));
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
      className="relative mx-4 mb-4 rounded-lg bg-white/5 ring-1 ring-white/10 focus-within:ring-2 focus-within:ring-ring"
    >
      {replyTo && (
        <div className="flex items-center gap-2 border-b border-white/10 px-3 py-1.5 text-xs text-zinc-300">
          <span className="min-w-0 flex-1 truncate">Replying to <span className="font-medium text-zinc-100">{replyTo.authorName}</span></span>
          <Button type="button" variant="ghost" size="icon-xs" aria-label="Cancel reply" onClick={onCancelReply}>
            <XIcon />
          </Button>
        </div>
      )}
      <p role="status" className="sr-only">
        {listOpen ? `${suggestions.length} ${suggestions.length === 1 ? "member" : "members"} found. Use arrow keys and Enter to pick.` : ""}
      </p>
      {listOpen && (
        <ul
          id={optionsId}
          role="listbox"
          aria-label="Mention a member"
          className="absolute right-0 bottom-full left-0 mb-2 max-h-64 overflow-y-auto rounded-lg border bg-popover p-1 shadow-lg"
        >
          {suggestions.map((m, i) => (
            <li
              key={m.id}
              id={`${optionsId}-${m.id}`}
              role="option"
              aria-selected={i === activeOption}
              onMouseDown={(e) => {
                e.preventDefault();
                pick(m);
              }}
              className={`cursor-pointer rounded-md px-2 py-1.5 text-sm ${i === activeOption ? "bg-white/10 text-white" : "text-zinc-300"}`}
            >
              @{m.name}
            </li>
          ))}
        </ul>
      )}
      {uploads.length > 0 && (
        <ul aria-label="Attachments" className="flex flex-wrap gap-2 px-3 pt-3">
          {uploads.map((u) => (
            <li key={u.localId} className={`relative size-20 overflow-hidden rounded-md ring-1 ${u.error ? "ring-destructive" : "ring-white/15"}`}>
              {u.preview ? (
                <Image src={u.preview} alt={u.name} fill unoptimized className={`object-cover ${u.id ? "" : "opacity-50"}`} />
              ) : (
                <span className={`flex h-full flex-col items-center justify-center gap-1 p-1 text-center ${u.id ? "" : "opacity-50"}`}>
                  <FileIcon aria-hidden className="size-6 text-zinc-300" />
                  <span className="text-[10px] break-all text-zinc-300">{shortFilename(u.name, 24)}</span>
                </span>
              )}
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
      {pickingAssets && <CommunityAssetPicker channelId={channelId} onPick={(asset) => {
        pickedAssets.current = [...pickedAssets.current.filter((item) => item.id !== asset.id), asset];
        setDraft(`${draft}${draft && !draft.endsWith(" ") ? " " : ""}${assetShortcode(asset)} `);
        setPickingAssets(false);
        textarea.current?.focus();
      }} />}
      <div className="flex items-end gap-2 py-1 pr-1 pl-2">
        <Button type="button" variant="ghost" size="icon" className="mb-1 shrink-0" aria-label="Choose community emoji or sticker" aria-expanded={pickingAssets} onClick={() => setPickingAssets((value) => !value)}><SmilePlusIcon /></Button>
        {mediaEnabled && (
          <>
            <input
              ref={fileInput}
              type="file"
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
              aria-label={`Attach files (up to ${MAX_ATTACHMENTS_PER_MESSAGE}; images ${MAX_MB} MB, other files ${MAX_FILE_MB} MB)`}
              title={`Attach files (up to ${MAX_ATTACHMENTS_PER_MESSAGE}; images ${MAX_MB} MB, other files ${MAX_FILE_MB} MB)`}
              disabled={uploads.length >= MAX_ATTACHMENTS_PER_MESSAGE}
              onClick={() => fileInput.current?.click()}
            >
              <PaperclipIcon />
            </Button>
          </>
        )}
        <label htmlFor={id} className="sr-only">
          {placeholder ?? `Message #${channelName}`}
        </label>
        <textarea
          id={id}
          ref={textarea}
          value={draft}
          aria-autocomplete="list"
          aria-controls={listOpen ? optionsId : undefined}
          aria-activedescendant={listOpen ? `${optionsId}-${suggestions[activeOption]?.id}` : undefined}
          onChange={(e) => {
            setDraft(e.target.value);
            trackMention(e.target);
          }}
          onSelect={(e) => trackMention(e.currentTarget)}
          onBlur={() => setMentionAt(null)}
          onPaste={(e) => {
            const files = [...e.clipboardData.files].filter((f) => f.type.startsWith("image/"));
            if (mediaEnabled && files.length > 0) {
              e.preventDefault();
              addFiles(files);
            }
          }}
          onKeyDown={(e) => {
            if (listOpen) {
              if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                e.preventDefault();
                const step = e.key === "ArrowDown" ? 1 : -1;
                setActiveOption((i) => (i + step + suggestions.length) % suggestions.length);
                return;
              }
              if ((e.key === "Enter" || e.key === "Tab") && !e.nativeEvent.isComposing) {
                e.preventDefault();
                pick(suggestions[activeOption] ?? suggestions[0]);
                return;
              }
              if (e.key === "Escape") {
                e.preventDefault();
                setMentionAt(null);
                return;
              }
            }
            if (e.key === "Escape" && replyTo) {
              e.preventDefault();
              onCancelReply();
              return;
            }
            // Enter sends, Shift+Enter adds a line; don't interrupt IME composition.
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void submit();
            }
          }}
          rows={1}
          maxLength={MESSAGE_MAX_LENGTH}
          placeholder={placeholder ?? `Message #${channelName}`}
          aria-describedby={remaining < 200 ? `${id}-remaining` : undefined}
          className={`field-sizing-content max-h-48 min-h-10 min-w-0 flex-1 resize-none bg-transparent py-2 text-zinc-100 outline-none placeholder:text-zinc-400 ${mediaEnabled ? "" : "pl-2"}`}
        />
        {remaining < 200 && (
          <span id={`${id}-remaining`} className="pb-2.5 text-[11px] text-zinc-400">
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
