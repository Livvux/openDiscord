"use client";

import { SettingsIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { deleteChannel, setChannelCategory, updateChannel } from "@/app/app/actions";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { CategorySummary } from "@/server/categories";
import type { ChannelSummary } from "@/server/communities";
import { ChannelPermissions } from "./channel-permissions";

interface ChannelSettingsDialogProps {
  channel: ChannelSummary;
  communityId: string;
  canManagePermissions: boolean;
  categories: CategorySummary[];
}

export function ChannelSettingsDialog({ channel, communityId, canManagePermissions, categories }: ChannelSettingsDialogProps) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    startTransition(async () => {
      const result = await updateChannel(channel.id, String(form.get("name")), String(form.get("topic")));
      if (!result.ok) return setError(result.error);
      const categoryId = String(form.get("category") ?? "") || null;
      if (categories.length > 0 && categoryId !== channel.categoryId) {
        const moved = await setChannelCategory(channel.id, categoryId);
        if (!moved.ok) return setError(moved.error);
      }
      setOpen(false);
    });
  }

  function onDelete() {
    if (!window.confirm(`Delete #${channel.name} and all its messages? This can't be undone.`)) return;
    startTransition(async () => {
      const result = await deleteChannel(channel.id);
      if (!result.ok) return setError(result.error);
      setOpen(false);
      router.push(`/app/c/${communityId}`);
    });
  }

  return (
    <Dialog open={open} onOpenChange={(o) => (setOpen(o), setError(null))}>
      <DialogTrigger render={<Button variant="ghost" size="icon" aria-label="Channel settings" />}>
        <SettingsIcon />
      </DialogTrigger>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-lg">
        <form onSubmit={onSubmit} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>Channel settings</DialogTitle>
          </DialogHeader>
          <div className="grid gap-2">
            <Label htmlFor="edit-channel-name">Name</Label>
            <Input id="edit-channel-name" name="name" defaultValue={channel.name} required maxLength={32} />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="edit-channel-topic">Topic</Label>
            <Input id="edit-channel-topic" name="topic" defaultValue={channel.topic ?? ""} maxLength={256} />
          </div>
          {categories.length > 0 && (
            <div className="grid gap-2">
              <Label htmlFor="edit-channel-category">Category</Label>
              <select
                id="edit-channel-category"
                name="category"
                defaultValue={channel.categoryId ?? ""}
                className="h-8 rounded-lg bg-white/5 px-2 text-sm ring-1 ring-white/10 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
              >
                <option value="">No category</option>
                {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </div>
          )}
          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
          <DialogFooter className="sm:justify-between">
            <Button type="button" variant="destructive" onClick={onDelete} disabled={pending}>
              Delete channel
            </Button>
            <Button type="submit" disabled={pending}>Save</Button>
          </DialogFooter>
        </form>
        {canManagePermissions && open && <ChannelPermissions channelId={channel.id} kind={channel.kind} />}
      </DialogContent>
    </Dialog>
  );
}
