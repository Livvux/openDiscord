"use client";

import { useId, useState, useTransition } from "react";
import { setClosedAlpha } from "@/app/app/admin/actions";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";

/** The switch shows the saved state; flipping it asks for an audited reason before anything changes. */
export function ClosedAlphaToggle({ enabled, pending }: { enabled: boolean; pending: number }) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, startTransition] = useTransition();
  const next = !enabled;
  return (
    <div className="flex flex-wrap items-center justify-between gap-4 py-4">
      <div className="min-w-0 max-w-xl">
        <p id={`${id}-label`} className="font-medium text-zinc-100">Closed Alpha</p>
        <p id={`${id}-state`} className="text-sm text-muted-foreground">
          {enabled
            ? "On. Anyone can request an account, but only approved accounts can sign in."
            : "Off. New accounts can sign in right after registration."}
        </p>
      </div>
      <div className="flex items-center gap-3">
        <span className={`text-sm font-medium ${enabled ? "text-brand-mint" : "text-zinc-400"}`} aria-hidden>{enabled ? "On" : "Off"}</span>
        <Switch
          checked={enabled}
          onCheckedChange={() => setOpen(true)}
          aria-labelledby={`${id}-label`}
          aria-describedby={`${id}-state`}
          className="data-[size=default]:h-6 data-[size=default]:w-11 [&>span]:size-5!"
        />
      </div>
      <Dialog open={open} onOpenChange={(v) => { setOpen(v); setError(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{next ? "Turn on Closed Alpha" : "Turn off Closed Alpha"}</DialogTitle>
            <DialogDescription>
              {next
                ? "New registrations will wait for approval before they can sign in. Existing accounts keep their access."
                : `Registration and access return to normal: ${pending ? `${pending} pending ${pending === 1 ? "account" : "accounts"}` : "pending accounts"} can sign in. Rejected accounts stay blocked.`}{" "}
              The change and your reason are recorded in the instance audit log.
            </DialogDescription>
          </DialogHeader>
          <form
            className="grid gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              const reason = String(new FormData(event.currentTarget).get("reason"));
              startTransition(async () => {
                const result = await setClosedAlpha(next, reason);
                if (result.ok) setOpen(false);
                else setError(result.error);
              });
            }}
          >
            <Label htmlFor={`${id}-reason`}>Reason</Label>
            <Textarea id={`${id}-reason`} name="reason" required minLength={3} maxLength={512} />
            {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
            <DialogFooter>
              <Button type="submit" disabled={saving}>{next ? "Turn on Closed Alpha" : "Turn off Closed Alpha"}</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
