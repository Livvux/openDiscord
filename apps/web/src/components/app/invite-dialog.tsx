"use client";

import { UserPlusIcon } from "lucide-react";
import { useState, useTransition } from "react";
import { createInvite } from "@/app/app/actions";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

const EXPIRY = [
  ["1 hour", "1"],
  ["1 day", "24"],
  ["7 days", "168"],
  ["Never", "never"],
] as const;
const USES = [
  ["1 use", "1"],
  ["5 uses", "5"],
  ["25 uses", "25"],
  ["100 uses", "100"],
  ["Unlimited", "unlimited"],
] as const;

const selectClass = "h-8 w-full rounded-lg border border-input bg-input/30 px-2 text-sm";

export function InviteDialog({ communityId, communityName }: { communityId: string; communityName: string }) {
  const [link, setLink] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [pending, startTransition] = useTransition();

  function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const expiry = String(form.get("expiry"));
    const uses = String(form.get("uses"));
    startTransition(async () => {
      const result = await createInvite(communityId, {
        expiresInHours: expiry === "never" ? null : Number(expiry),
        maxUses: uses === "unlimited" ? null : Number(uses),
      });
      if (!result.ok) return setError(result.error);
      setError(null);
      setCopied(false);
      setLink(`${window.location.origin}/invite/${result.data}`);
    });
  }

  async function copy() {
    if (!link) return;
    await navigator.clipboard.writeText(link);
    setCopied(true);
  }

  return (
    <Dialog onOpenChange={(open) => !open && setLink(null)}>
      <DialogTrigger render={<Button variant="secondary" className="w-full" />}>
        <UserPlusIcon /> Invite people
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Invite people to {communityName}</DialogTitle>
          <DialogDescription>Anyone with the link can join until it expires or runs out of uses.</DialogDescription>
        </DialogHeader>
        <form onSubmit={onSubmit} className="grid gap-3">
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="invite-expiry">Expires after</Label>
              <select id="invite-expiry" name="expiry" defaultValue="168" className={selectClass}>
                {EXPIRY.map(([label, value]) => (
                  <option key={value} value={value}>{label}</option>
                ))}
              </select>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="invite-uses">Max uses</Label>
              <select id="invite-uses" name="uses" defaultValue="unlimited" className={selectClass}>
                {USES.map(([label, value]) => (
                  <option key={value} value={value}>{label}</option>
                ))}
              </select>
            </div>
          </div>
          <Button type="submit" disabled={pending}>{pending ? "Creating…" : link ? "Create another link" : "Create invite link"}</Button>
        </form>
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        {link && (
          <div className="grid gap-1.5">
            <Label htmlFor="invite-link">Invite link</Label>
            <div className="flex gap-2">
              <Input id="invite-link" readOnly value={link} onFocus={(e) => e.currentTarget.select()} />
              <Button type="button" variant="outline" onClick={copy}>{copied ? "Copied" : "Copy"}</Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
