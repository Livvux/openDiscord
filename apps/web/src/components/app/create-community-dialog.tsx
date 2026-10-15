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
              className="grid size-10 place-items-center rounded-2xl bg-white/5 text-brand-mint transition-[border-radius,background-color] hover:rounded-xl hover:bg-white/10 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
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
        <div className="grid gap-1.5 border-t pt-4">
          <Label htmlFor="community-import">Or import an export file</Label>
          <input
            id="community-import"
            type="file"
            accept="application/json,.json"
            disabled={pending}
            aria-describedby="community-import-help"
            className="text-sm file:mr-3 file:rounded-md file:border-0 file:bg-white/10 file:px-3 file:py-1.5 file:text-sm file:text-zinc-100"
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = "";
              if (!file) return;
              startTransition(async () => {
                setError(null);
                const res = await fetch("/api/communities/import", { method: "POST", body: file, headers: { "Content-Type": "application/json" } });
                const body = (await res.json().catch(() => null)) as { communityId?: string; error?: string } | null;
                if (!res.ok || !body?.communityId) return setError(body?.error ?? "The import failed.");
                setOpen(false);
                router.push(`/app/c/${body.communityId}`);
                router.refresh();
              });
            }}
          />
          <p id="community-import-help" className="text-xs text-muted-foreground">
            A community export from openDiscord (owner&apos;s settings). Messages keep their original author names, marked as imported.
          </p>
        </div>
      </DialogContent>
    </Dialog>
  );
}
