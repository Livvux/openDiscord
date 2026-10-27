"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { ACCEPTED_IMAGE_TYPES, MAX_ATTACHMENT_BYTES } from "@/lib/limits";
import { fmt } from "@/lib/i18n";
import { useMessages } from "@/lib/i18n/client";
import { bannerStyle } from "../discover/community-card";
import { CommunityPicture } from "../community-icon";

type Kind = "icon" | "banner";

interface CommunityImagesProps {
  communityId: string;
  name: string;
  iconId: string | null;
  bannerId: string | null;
}

/** Server picture and banner; the server centre-crops uploads (square, 16:9), so no cropper here. */
export function CommunityImages({ communityId, name, iconId, bannerId }: CommunityImagesProps) {
  const router = useRouter();
  const inputs = { icon: useRef<HTMLInputElement>(null), banner: useRef<HTMLInputElement>(null) };
  const [busy, setBusy] = useState<Kind | null>(null);
  const [error, setError] = useState<string | null>(null);
  const t = useMessages().images;

  async function request(kind: Kind, init: RequestInit) {
    setBusy(kind);
    setError(null);
    try {
      const response = await fetch(`/api/communities/${communityId}/images/${kind}`, init);
      if (!response.ok) throw new Error(((await response.json().catch(() => null)) as { error?: string } | null)?.error ?? t.failed);
      router.refresh();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : t.failed);
    } finally {
      setBusy(null);
    }
  }

  function choose(kind: Kind, file: File | undefined) {
    const input = inputs[kind].current;
    if (input) input.value = "";
    if (!file) return;
    if (!(ACCEPTED_IMAGE_TYPES as readonly string[]).includes(file.type)) return setError(t.wrongType);
    if (file.size > MAX_ATTACHMENT_BYTES) return setError(fmt(t.tooLarge, { mb: MAX_ATTACHMENT_BYTES / 1024 / 1024 }));
    void request(kind, { method: "POST", body: file, headers: { "Content-Type": file.type } });
  }

  const controls = (kind: Kind, current: string | null, label: string) => (
    <div className="flex flex-wrap gap-2">
      <Button type="button" variant="outline" size="sm" disabled={busy !== null} aria-label={`${label}: ${current ? t.change : t.upload}`} onClick={() => inputs[kind].current?.click()}>
        {busy === kind ? t.uploading : current ? t.change : t.upload}
      </Button>
      {current && <Button type="button" variant="ghost" size="sm" disabled={busy !== null} aria-label={`${label}: ${t.remove}`} onClick={() => void request(kind, { method: "DELETE" })}>{t.remove}</Button>}
      <input ref={inputs[kind]} type="file" accept={ACCEPTED_IMAGE_TYPES.join(",")} className="sr-only" tabIndex={-1} aria-hidden onChange={(e) => choose(kind, e.target.files?.[0])} />
    </div>
  );

  return (
    <div className="mb-6 grid max-w-md gap-5">
      <div className="flex items-center gap-4">
        <span aria-hidden className="grid size-20 shrink-0 place-items-center overflow-hidden rounded-full bg-white/10 text-2xl font-semibold">
          <CommunityPicture name={name} iconId={iconId} />
        </span>
        <div className="grid gap-1.5">
          <p className="text-sm font-medium">{t.picture}</p>
          {controls("icon", iconId, t.picture)}
        </div>
      </div>
      <div className="grid gap-2">
        <p className="text-sm font-medium">{t.banner}</p>
        <div aria-hidden className="aspect-video w-full overflow-hidden rounded-lg" style={bannerStyle(communityId, bannerId)} />
        {controls("banner", bannerId, t.banner)}
      </div>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    </div>
  );
}
