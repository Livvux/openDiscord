"use client";

import Link from "next/link";
import { useState, type ReactNode } from "react";
import { Button, buttonVariants } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { dmSignOutLosesHistory, wipeDmDevice } from "@/lib/dm/sign-out";
import { clearDrafts } from "@/lib/chat-drafts";
import { outbox } from "@/lib/outbox";

/**
 * Sign-out that first removes unsent drafts and messages and this account's encrypted-message device from the browser. When this is
 * the only device and no recovery backup exists, asks first: the wipe would lose access to history.
 */
export function useDmSignOut(userId: string, signOut: () => Promise<void>): { request: () => Promise<void>; busy: boolean; dialog: ReactNode } {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  async function proceed() {
    setBusy(true);
    try {
      // Local wipe first and independent of the network: an offline sign-out must not leave keys behind.
      clearDrafts();
      outbox.clear();
      await wipeDmDevice(userId);
      await signOut();
    } finally { setBusy(false); setOpen(false); }
  }
  async function request() {
    setBusy(true);
    const confirm = await dmSignOutLosesHistory(userId);
    setBusy(false);
    if (confirm) setOpen(true); else await proceed();
  }
  const dialog = (
    <Dialog open={open} onOpenChange={(value) => { if (!busy) setOpen(value); }}>
      <DialogContent data-dm-sign-out-dialog>
        <DialogHeader>
          <DialogTitle>Sign out of this browser?</DialogTitle>
          <DialogDescription>This is your only device with access to encrypted messages and you have no recovery backup. Signing out will remove them from this browser. Create a recovery backup first?</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <DialogClose render={<Button variant="outline" disabled={busy} />}>Cancel</DialogClose>
          <Link href="/app/messages#devices-and-recovery" className={buttonVariants({ variant: "outline" })} onClick={() => setOpen(false)}>Go to Devices and recovery</Link>
          <Button variant="destructive" disabled={busy} onClick={() => void proceed()}>Sign out anyway</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
  return { request, busy, dialog };
}
