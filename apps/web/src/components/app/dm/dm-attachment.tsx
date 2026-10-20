"use client";

import { DownloadIcon, FileIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { DmAttachment } from "@/lib/dm/contracts";
import { inlineImage } from "@/lib/dm/client";
import { shortFilename } from "@/lib/filename";

const sizeText = (bytes: number) => bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;

/** `file.name` is already sanitized by `dmAttachmentSchema`. Decrypted in this browser only: images inline from an object URL (revoked on unmount), other files as downloads. */
export function DmAttachmentView({ file, open }: { file: DmAttachment; open: (file: DmAttachment) => Promise<Blob> }) {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const image = inlineImage(file);
  // Each refresh re-decrypts the message into a new object; decrypt the file again only when it really changes
  // (the parent keys this component by id and key information, so a different file remounts with fresh state).
  const latest = useRef({ file, open });
  useEffect(() => { latest.current = { file, open }; });
  const identity = `${file.id}:${file.info}`;
  useEffect(() => {
    if (!image) return;
    let alive = true, created: string | null = null;
    latest.current.open(latest.current.file).then((blob) => { if (alive) { created = URL.createObjectURL(blob); setUrl(created); } }, () => { if (alive) setError("Cannot decrypt or verify this file."); });
    return () => { alive = false; if (created) URL.revokeObjectURL(created); };
  }, [identity, image]);
  async function download() {
    setError(null);
    try {
      const href = URL.createObjectURL(await open(file));
      const link = Object.assign(document.createElement("a"), { href, download: file.name });
      link.click();
      // Long enough for the browser to read the blob into the download.
      setTimeout(() => URL.revokeObjectURL(href), 30_000);
    } catch { setError("Cannot decrypt or verify this file."); }
  }
  if (error && image) return <p role="alert" className="text-sm text-destructive"><bdi>{shortFilename(file.name)}</bdi>: {error}</p>;
  if (image) return url
    // eslint-disable-next-line @next/next/no-img-element -- a local blob: URL of decrypted bytes; next/image cannot optimise it.
    ? <img src={url} alt={file.name} data-dm-attachment-image className="mt-1 max-h-80 max-w-full rounded-md object-contain" />
    : <p role="status" className="text-xs text-muted-foreground">Decrypting <bdi>{shortFilename(file.name, 32)}</bdi>…</p>;
  return <><button type="button" aria-label={`Download encrypted file ${file.name}`} onClick={() => void download()} className="mt-1 flex w-fit max-w-full items-center gap-2 rounded-md border border-white/10 bg-white/5 px-3 py-2 text-left text-sm hover:bg-white/10 focus-visible:outline-2 focus-visible:outline-ring">
    <FileIcon aria-hidden className="size-5 shrink-0 text-zinc-300" />
    <bdi className="min-w-0 break-all">{shortFilename(file.name)}</bdi>
    <span className="shrink-0 text-xs text-zinc-400">{sizeText(file.size)}</span>
    <DownloadIcon aria-hidden className="size-4 shrink-0" />
  </button>{error && <p role="alert" className="text-sm text-destructive">{error}</p>}</>;
}
