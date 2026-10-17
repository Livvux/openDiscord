"use client";

import { useRouter } from "next/navigation";
import { useEffect, useId, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { ACCEPTED_IMAGE_TYPES, AVATAR_DIMENSION, MAX_ATTACHMENT_BYTES } from "@/lib/limits";
import { Avatar } from "../avatar";

/** Crop viewport in CSS pixels; equal to the uploaded size, so the preview maps 1:1 onto the canvas. */
const VIEW = AVATAR_DIMENSION;
const MAX_ZOOM = 4;
const KEY_STEP = 8;

interface Crop { bitmap: ImageBitmap; url: string; zoom: number; x: number; y: number }

/** Image size at a zoom where 1 just covers the square viewport. */
const scaled = (bitmap: ImageBitmap, zoom: number) => {
  const base = VIEW / Math.min(bitmap.width, bitmap.height);
  return { w: bitmap.width * base * zoom, h: bitmap.height * base * zoom };
};

/** Keeps the image covering the whole viewport. */
function clamp(crop: Crop): Crop {
  const { w, h } = scaled(crop.bitmap, crop.zoom);
  return { ...crop, x: Math.min(0, Math.max(VIEW - w, crop.x)), y: Math.min(0, Math.max(VIEW - h, crop.y)) };
}

function render(crop: Crop): Promise<Blob> {
  const canvas = document.createElement("canvas");
  canvas.width = VIEW;
  canvas.height = VIEW;
  const context = canvas.getContext("2d");
  if (!context) return Promise.reject(new Error("Your browser can't crop images."));
  context.imageSmoothingQuality = "high";
  const { w, h } = scaled(crop.bitmap, crop.zoom);
  context.drawImage(crop.bitmap, crop.x, crop.y, w, h);
  // Browsers without WebP encoding return PNG instead; the server re-encodes either.
  return new Promise((resolve, reject) => canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("The picture couldn't be cropped."))), "image/webp", 0.92));
}

export function AvatarSettings({ name, avatar }: { name: string; avatar: string | null }) {
  const router = useRouter();
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const drag = useRef<{ pointer: number; x: number; y: number } | null>(null);
  const [crop, setCrop] = useState<Crop | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Frees the decoded image and its preview URL when the dialog closes or another file is chosen.
  const bitmap = crop?.bitmap;
  const url = crop?.url;
  useEffect(() => () => { bitmap?.close(); if (url) URL.revokeObjectURL(url); }, [bitmap, url]);

  async function choose(file: File | undefined) {
    if (input.current) input.current.value = "";
    if (!file) return;
    setError(null);
    if (!(ACCEPTED_IMAGE_TYPES as readonly string[]).includes(file.type)) return setError("Use a PNG, JPEG, WebP or GIF image.");
    if (file.size > MAX_ATTACHMENT_BYTES) return setError(`Images can be at most ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB.`);
    try {
      const bitmap = await createImageBitmap(file);
      const { w, h } = scaled(bitmap, 1);
      setCrop({ bitmap, url: URL.createObjectURL(file), zoom: 1, x: (VIEW - w) / 2, y: (VIEW - h) / 2 });
    } catch {
      setError("That file isn't a supported image.");
    }
  }

  function zoomTo(zoom: number) {
    // Zooms around the centre of the viewport.
    setCrop((c) => c && clamp({ ...c, zoom, x: VIEW / 2 - (VIEW / 2 - c.x) * (zoom / c.zoom), y: VIEW / 2 - (VIEW / 2 - c.y) * (zoom / c.zoom) }));
  }

  function onKeyDown(event: React.KeyboardEvent) {
    const moves: Record<string, [number, number]> = { ArrowLeft: [KEY_STEP, 0], ArrowRight: [-KEY_STEP, 0], ArrowUp: [0, KEY_STEP], ArrowDown: [0, -KEY_STEP] };
    const move = moves[event.key];
    if (!move) return;
    event.preventDefault();
    setCrop((c) => c && clamp({ ...c, x: c.x + move[0], y: c.y + move[1] }));
  }

  async function request(init: RequestInit) {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/me/avatar", init);
      if (!response.ok) throw new Error(((await response.json().catch(() => null)) as { error?: string } | null)?.error ?? "Could not save the picture.");
      setCrop(null);
      router.refresh();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Could not save the picture.");
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    if (!crop) return;
    try {
      const blob = await render(crop);
      await request({ method: "POST", body: blob, headers: { "Content-Type": blob.type } });
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "The picture couldn't be cropped.");
    }
  }

  const size = crop && scaled(crop.bitmap, crop.zoom);
  return (
    <div className="flex items-center gap-4">
      <Avatar name={name} avatar={avatar} size="lg" />
      <div className="grid gap-2">
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="outline" disabled={busy} onClick={() => input.current?.click()}>{avatar ? "Change picture" : "Upload picture"}</Button>
          {avatar && <Button type="button" variant="ghost" disabled={busy} onClick={() => void request({ method: "DELETE" })}>Remove</Button>}
        </div>
        <input ref={input} id={`${id}-file`} type="file" accept={ACCEPTED_IMAGE_TYPES.join(",")} className="sr-only" tabIndex={-1} aria-hidden onChange={(event) => void choose(event.target.files?.[0])} />
        <p className="text-xs text-muted-foreground">PNG, JPEG, WebP or GIF (first frame). Visible wherever your name is.</p>
        {error && !crop && <p role="alert" className="text-sm text-destructive">{error}</p>}
      </div>

      <Dialog open={crop !== null} onOpenChange={(open) => { if (!open && !busy) setCrop(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Crop your picture</DialogTitle>
            <DialogDescription>Drag or use the arrow keys to position it, and the slider to zoom.</DialogDescription>
          </DialogHeader>
          {crop && size && (
            <div className="grid justify-items-center gap-4">
              <div
                role="application"
                aria-label="Picture position"
                tabIndex={0}
                onKeyDown={onKeyDown}
                onPointerDown={(event) => { event.currentTarget.setPointerCapture(event.pointerId); drag.current = { pointer: event.pointerId, x: event.clientX, y: event.clientY }; }}
                onPointerMove={(event) => {
                  const start = drag.current;
                  if (!start || start.pointer !== event.pointerId) return;
                  drag.current = { ...start, x: event.clientX, y: event.clientY };
                  setCrop((c) => c && clamp({ ...c, x: c.x + event.clientX - start.x, y: c.y + event.clientY - start.y }));
                }}
                onPointerUp={() => { drag.current = null; }}
                onPointerCancel={() => { drag.current = null; }}
                style={{ width: VIEW, height: VIEW }}
                className="relative cursor-move touch-none overflow-hidden rounded-lg bg-black focus-visible:outline-2 focus-visible:outline-ring"
              >
                {/* eslint-disable-next-line @next/next/no-img-element -- local blob preview, nothing to optimise */}
                <img src={crop.url} alt="" draggable={false} className="pointer-events-none absolute top-0 left-0 max-w-none select-none"
                  style={{ width: size.w, height: size.h, transform: `translate(${crop.x}px, ${crop.y}px)` }} />
                {/* The round mask shows what others will see. */}
                <div aria-hidden className="pointer-events-none absolute inset-0 rounded-full shadow-[0_0_0_9999px_rgba(0,0,0,0.55)]" />
              </div>
              <div className="grid w-full max-w-64 gap-1.5">
                <Label htmlFor={`${id}-zoom`}>Zoom</Label>
                <input id={`${id}-zoom`} type="range" min={1} max={MAX_ZOOM} step={0.01} value={crop.zoom} onChange={(event) => zoomTo(Number(event.target.value))} className="accent-brand-mint" />
              </div>
            </div>
          )}
          {error && crop && <p role="alert" className="text-sm text-destructive">{error}</p>}
          <DialogFooter>
            <Button type="button" variant="outline" disabled={busy} onClick={() => setCrop(null)}>Cancel</Button>
            <Button type="button" disabled={busy} onClick={() => void save()}>{busy ? "Saving…" : "Save picture"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
