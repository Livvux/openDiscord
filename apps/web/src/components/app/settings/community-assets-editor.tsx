"use client";

import { useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { assetRawLimit, type AssetView } from "@/lib/community-assets";
import { CommunityAssetImage } from "../community-asset-image";

export function CommunityAssetsEditor({ communityId, initialAssets }: { communityId: string; initialAssets: AssetView[] }) {
  const [assets, setAssets] = useState(initialAssets);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const id = useId();
  async function refresh() {
    const response = await fetch(`/api/communities/${communityId}/assets`, { cache: "no-store" });
    if (!response.ok) throw new Error("Community images could not be loaded.");
    setAssets(await response.json() as AssetView[]);
  }
  async function upload(form: HTMLFormElement) {
    setBusy(true); setError(null);
    try {
      const data = new FormData(form);
      const file = data.get("file");
      const kind = data.get("kind") === "sticker" ? "sticker" : "emoji";
      if (!(file instanceof File) || !file.size) throw new Error("Choose a static raster image.");
      if (file.size > assetRawLimit(kind)) throw new Error(kind === "emoji" ? "Emoji can be at most 256 KiB." : "Stickers can be at most 1 MiB.");
      const params = new URLSearchParams({ name: String(data.get("name")), kind });
      const response = await fetch(`/api/communities/${communityId}/assets?${params}`, { method: "POST", body: file, headers: { "Content-Type": file.type } });
      if (!response.ok) throw new Error((await response.json() as { error: string }).error);
      await refresh(); form.reset();
    } catch (error) { setError(error instanceof Error ? error.message : "Upload failed."); }
    finally { setBusy(false); }
  }
  async function remove(asset: AssetView) {
    if (!window.confirm(`Delete ${asset.name}? Old messages will show a text fallback.`)) return;
    setBusy(true); setError(null);
    try {
      const response = await fetch(`/api/communities/${communityId}/assets/${asset.id}`, { method: "DELETE" });
      if (!response.ok) throw new Error((await response.json() as { error: string }).error);
      await refresh();
    } catch (error) { setError(error instanceof Error ? error.message : "Deletion failed."); }
    finally { setBusy(false); }
  }
  return <div className="space-y-4">
    <p className="text-sm text-muted-foreground">Private to this community. Static PNG, JPEG, WebP or GIF; emoji up to 256 KiB, stickers up to 1 MiB. Names cannot be changed. 128 emoji, 64 stickers and 64 MiB per community.</p>
    <form className="grid max-w-md gap-2" onSubmit={(event) => { event.preventDefault(); void upload(event.currentTarget); }}>
      <Label htmlFor={`${id}-name`}>Image name</Label><Input id={`${id}-name`} name="name" required pattern="[a-z0-9_]{2,32}" minLength={2} maxLength={32} placeholder="party_blob" />
      <Label htmlFor={`${id}-kind`}>Image kind</Label><select id={`${id}-kind`} name="kind" className="rounded-md border bg-background p-2"><option value="emoji">Emoji</option><option value="sticker">Sticker</option></select>
      <Label htmlFor={`${id}-file`}>Static image</Label><Input id={`${id}-file`} name="file" type="file" accept="image/png,image/jpeg,image/webp,image/gif" required />
      <Button type="submit" disabled={busy}>{busy ? "Working…" : "Upload community image"}</Button>
    </form>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    <ul aria-label="Community image library" className="space-y-2">{assets.map((asset) => <li key={asset.id} className="flex min-w-0 items-center gap-3 rounded-md border p-2">
      <CommunityAssetImage asset={{ ...asset, kind: "emoji" }} /><span className="min-w-0 flex-1 truncate text-sm">{asset.name} <span className="text-muted-foreground">({asset.kind})</span></span><Button type="button" variant="outline" size="sm" disabled={busy} aria-label={`Delete ${asset.name}`} onClick={() => void remove(asset)}>Delete</Button>
    </li>)}</ul>
  </div>;
}
