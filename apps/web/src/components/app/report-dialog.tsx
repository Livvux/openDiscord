"use client";

import { FlagIcon } from "lucide-react";
import { useId, useState, useTransition } from "react";
import { reportContent } from "@/app/app/actions";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

export function ReportDialog({ communityId, messageId, open: controlledOpen, onOpenChange, hideTrigger = false }: {
  communityId?: string;
  /** Opened from a menu instead of its own button. */
  hideTrigger?: boolean;
  messageId?: string;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const [internalOpen, setInternalOpen] = useState(false);
  const open = controlledOpen ?? internalOpen;
  const setOpen = (value: boolean) => { setInternalOpen(value); onOpenChange?.(value); };
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const [pending, startTransition] = useTransition();
  const id = useId();
  const target = messageId ? "message" : "community";
  return (
    <Dialog open={open} onOpenChange={(value) => { setOpen(value); setError(null); setSent(false); }}>
      {!hideTrigger && (
        <DialogTrigger render={<Button variant="ghost" size={messageId ? "icon-sm" : "sm"} aria-label={`Report ${target}`} />}>
          <FlagIcon />{!messageId && "Report community"}
        </DialogTrigger>
      )}
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Report {target}</DialogTitle>
          <DialogDescription>Send this report to the instance administrators. Community moderators do not receive it. An administrator may review the reported content.</DialogDescription>
        </DialogHeader>
        {sent ? <p role="status">Report submitted. An instance administrator will review it.</p> : (
          <form className="grid gap-4" onSubmit={(event) => {
            event.preventDefault();
            const reason = String(new FormData(event.currentTarget).get("reason"));
            startTransition(async () => {
              const result = await reportContent({ communityId, messageId, reason });
              if (result.ok) setSent(true); else setError(result.error);
            });
          }}>
            <Label htmlFor={id}>Why are you reporting this {target}?</Label>
            <Textarea id={id} name="reason" required minLength={3} maxLength={512} autoFocus />
            {error && <p role="alert" className="text-destructive">{error}</p>}
            <DialogFooter><Button type="submit" disabled={pending}>Submit report</Button></DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
