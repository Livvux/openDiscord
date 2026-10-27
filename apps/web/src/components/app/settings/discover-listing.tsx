"use client";

import { useState, useTransition } from "react";
import { updateListing } from "@/app/app/actions";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";

const DESCRIPTION_MAX = 300;

export function DiscoverListing({ communityId, listing }: { communityId: string; listing: { discoverable: boolean; description: string } }) {
  const [discoverable, setDiscoverable] = useState(listing.discoverable);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [pending, startTransition] = useTransition();
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        const description = String(new FormData(e.currentTarget).get("description"));
        startTransition(async () => {
          const result = await updateListing(communityId, { discoverable, description });
          setError(result.ok ? null : result.error);
          setSaved(result.ok);
        });
      }}
      className="mt-6 grid max-w-md gap-4"
    >
      <label className="flex items-center gap-3 text-sm">
        <Switch checked={discoverable} onCheckedChange={(v) => (setDiscoverable(v), setSaved(false))} />
        Show in Discover (anyone can join without an invite)
      </label>
      <div className="grid gap-1.5">
        <Label htmlFor="community-description">Description</Label>
        <Textarea id="community-description" name="description" defaultValue={listing.description} maxLength={DESCRIPTION_MAX} rows={3} onChange={() => setSaved(false)} />
      </div>
      <div className="flex items-center gap-3">
        <Button type="submit" disabled={pending}>Save</Button>
        {saved && <p role="status" className="text-sm text-muted-foreground">Saved.</p>}
      </div>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    </form>
  );
}
