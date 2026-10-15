"use client";

import { PlusIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { createChannel } from "@/app/app/actions";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export function CreateChannelDialog({ communityId, voiceEnabled }: { communityId: string; voiceEnabled: boolean }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const name = String(form.get("name"));
    const kind = form.get("kind") === "voice" ? "voice" : "text";
    startTransition(async () => {
      const result = await createChannel(communityId, name, kind);
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
      <DialogContent>
        <form onSubmit={onSubmit} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>Create channel</DialogTitle>
          </DialogHeader>
          <div className="grid gap-2">
            <Label htmlFor="channel-name">Channel name</Label>
            <Input id="channel-name" name="name" required maxLength={32} autoFocus autoComplete="off" placeholder="new-channel" />
          </div>
          {voiceEnabled && (
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
