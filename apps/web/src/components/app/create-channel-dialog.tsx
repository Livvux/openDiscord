"use client";

import { PlusIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { createChannel, createPublicChannel } from "@/app/app/actions";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export function CreateChannelDialog({ communityId, voiceEnabled, isOwner }: { communityId: string; voiceEnabled: boolean; isOwner: boolean }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [publicMode, setPublicMode] = useState(false);
  const [pending, startTransition] = useTransition();

  function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const name = String(form.get("name"));
    const kind = form.get("kind") === "voice" ? "voice" : "text";
    startTransition(async () => {
      const result = publicMode
        ? await createPublicChannel(communityId, { name, communityTitle: String(form.get("publicTitle") ?? ""), acknowledge: form.get("acknowledge") === "on" })
        : await createChannel(communityId, name, kind);
      if (!result.ok) return setError(result.error);
      setOpen(false);
      router.push(`/app/c/${communityId}/${result.data}`);
    });
  }

  return (
    <Dialog open={open} onOpenChange={(o) => (setOpen(o), setError(null))}>
      <DialogTrigger render={<Button variant="ghost" size="icon-xs" aria-label="Create channel" />}>
        <PlusIcon />
      </DialogTrigger>
      <DialogContent className="max-h-[85dvh] overflow-y-auto">
        <form onSubmit={onSubmit} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>Create channel</DialogTitle>
          </DialogHeader>
          <div className="grid gap-2">
            <Label htmlFor="channel-name">Channel name</Label>
            <Input id="channel-name" name="name" required maxLength={32} autoFocus autoComplete="off" placeholder="new-channel" />
          </div>
          {isOwner && <label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={publicMode} onChange={(e) => setPublicMode(e.target.checked)} />Create a new public text channel</label>}
          {publicMode && <><div className="grid gap-2"><Label htmlFor="public-community-title">Public community title</Label><Input id="public-community-title" name="publicTitle" required maxLength={80} placeholder="Choose what the public sees" /><p className="text-xs text-muted-foreground">Separate from your private community name. Only this new channel is published. Existing private history stays private.</p></div><label className="flex items-start gap-2 text-sm"><input type="checkbox" name="acknowledge" required />I understand that this new channel’s title, future acknowledged posts, display names and timestamps will be public and searchable and may remain in third-party caches. Unpublishing is permanent and cannot erase external copies.</label></>}
          {voiceEnabled && !publicMode && (
            <fieldset className="grid gap-1.5">
              <legend className="mb-1 text-sm font-medium">Type</legend>
              <label className="flex items-center gap-2 text-sm">
                <input type="radio" name="kind" value="text" defaultChecked /> Text: messages, images and replies
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input type="radio" name="kind" value="voice" /> Voice: talk together in real time
              </label>
            </fieldset>
          )}
          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
          <DialogFooter>
            <Button type="submit" disabled={pending}>{pending ? "Creating…" : "Create channel"}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
