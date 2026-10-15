"use client";

import { PlusIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { createCommunity } from "@/app/app/actions";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export function CreateCommunityDialog({ trigger = "icon" }: { trigger?: "icon" | "button" }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const name = String(new FormData(event.currentTarget).get("name"));
    startTransition(async () => {
      const result = await createCommunity(name);
      if (!result.ok) return setError(result.error);
      setOpen(false);
      router.push(`/app/c/${result.data.communityId}/${result.data.channelId}`);
    });
  }

  return (
    <Dialog open={open} onOpenChange={(o) => (setOpen(o), setError(null))}>
      {trigger === "icon" ? (
        <DialogTrigger
          render={
            <button
              type="button"
              aria-label="Create a community"
              className="flex size-12 items-center justify-center rounded-2xl bg-card text-brand-online transition hover:rounded-xl hover:bg-brand-online hover:text-white focus-visible:outline-2 focus-visible:outline-ring"
            />
          }
        >
          <PlusIcon />
        </DialogTrigger>
      ) : (
        <DialogTrigger render={<Button size="lg" />}>Create a community</DialogTrigger>
      )}
      <DialogContent>
        <form onSubmit={onSubmit} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>Create a community</DialogTitle>
            <DialogDescription>You&apos;ll be the owner. You can invite people right after.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-2">
            <Label htmlFor="community-name">Name</Label>
            <Input id="community-name" name="name" required maxLength={64} autoFocus autoComplete="off" />
          </div>
          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
          <DialogFooter>
            <Button type="submit" disabled={pending}>{pending ? "Creating…" : "Create"}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
