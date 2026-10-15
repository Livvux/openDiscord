"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { authClient } from "@/lib/auth-client";

export function EmailSettings({ email }: { email: string }) {
  const [pending, setPending] = useState(false);
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    const newEmail = String(new FormData(event.currentTarget).get("newEmail")).trim();
    setPending(true);
    setStatus(null);
    try {
      const { error } = await authClient.changeEmail({ newEmail, callbackURL: "/app/settings" });
      setStatus(error
        ? { ok: false, text: error.message ?? "Could not request the email change. Try signing in again." }
        : { ok: true, text: "Check your current inbox to approve the change, then verify the new address. If your current address isn't verified, check the new inbox directly. Your address stays unchanged until verification completes." });
    } catch {
      setStatus({ ok: false, text: "Could not reach the server. Please try again." });
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={submit} className="grid max-w-sm gap-3">
      <p className="text-sm text-muted-foreground">Current address: {email}</p>
      <div className="grid gap-1.5">
        <Label htmlFor="new-email">New email address</Label>
        <Input id="new-email" name="newEmail" type="email" autoComplete="email" required maxLength={254} disabled={pending} />
      </div>
      <Button type="submit" disabled={pending}>{pending ? "Sending…" : "Change email"}</Button>
      {status && <p role={status.ok ? "status" : "alert"} className="text-sm">{status.text}</p>}
    </form>
  );
}
