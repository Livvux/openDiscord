"use client";

import { UserPlusIcon } from "lucide-react";
import { useId, useState, useTransition } from "react";
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

interface InviteDialogProps {
  communityId: string;
  communityName: string;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  hideTrigger?: boolean;
  /** A bare person-plus icon, as in Discord's server header. */
  iconTrigger?: boolean;
  finalFocus?: React.ComponentProps<typeof DialogContent>["finalFocus"];
}

export function InviteDialog({ communityId, communityName, open, onOpenChange, hideTrigger = false, iconTrigger = false, finalFocus }: InviteDialogProps) {
  const id = useId();
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
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      setError(null);
    } catch {
      setError("Could not copy the invite link. Copy it from the field or allow clipboard access.");
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          setLink(null);
          setError(null);
        }
        onOpenChange?.(next);
      }}
    >
      {!hideTrigger && iconTrigger && (
        <DialogTrigger render={<Button variant="ghost" size="icon-sm" aria-label="Invite people" title="Invite people" className="text-muted-foreground hover:text-sidebar-foreground" />}>
          <UserPlusIcon />
        </DialogTrigger>
      )}
      {!hideTrigger && !iconTrigger && (
        <DialogTrigger render={<Button variant="secondary" className="w-full" />}>
          <UserPlusIcon /> Invite people
        </DialogTrigger>
      )}
      <DialogContent finalFocus={finalFocus}>
        <DialogHeader>
          <DialogTitle>Invite people to {communityName}</DialogTitle>
          <DialogDescription>Anyone with the link can join until it expires or runs out of uses.</DialogDescription>
        </DialogHeader>
        <form onSubmit={onSubmit} className="grid gap-3">
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor={`${id}-expiry`}>Expires after</Label>
              <select id={`${id}-expiry`} name="expiry" defaultValue="168" className={selectClass}>
                {EXPIRY.map(([label, value]) => (
                  <option key={value} value={value}>{label}</option>
                ))}
              </select>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor={`${id}-uses`}>Max uses</Label>
              <select id={`${id}-uses`} name="uses" defaultValue="unlimited" className={selectClass}>
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
            <Label htmlFor={`${id}-link`}>Invite link</Label>
            <div className="flex gap-2">
              <Input id={`${id}-link`} readOnly value={link} onFocus={(e) => e.currentTarget.select()} />
              <Button type="button" variant="outline" onClick={copy}>{copied ? "Copied" : "Copy"}</Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
