"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { authClient } from "@/lib/auth-client";

export function ProfileForm({ name, email }: { name: string; email: string }) {
  const router = useRouter();
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    const { error } = await authClient.updateUser({ name: String(new FormData(event.currentTarget).get("name")).trim() });
    setPending(false);
    setStatus(error ? { ok: false, text: error.message ?? "Could not save." } : { ok: true, text: "Saved." });
    if (!error) router.refresh();
  }

  return (
    <form onSubmit={onSubmit} className="grid max-w-sm gap-3">
      <div className="grid gap-1.5">
        <Label htmlFor="profile-name">Display name</Label>
        <Input id="profile-name" name="name" defaultValue={name} required maxLength={64} autoComplete="nickname" />
      </div>
      <p className="text-sm text-muted-foreground">Email: {email}</p>
      <div className="flex items-center gap-3">
        <Button type="submit" disabled={pending}>Save</Button>
        {status && (
          <p role={status.ok ? "status" : "alert"} className={`text-sm ${status.ok ? "text-success" : "text-destructive"}`}>
            {status.text}
          </p>
        )}
      </div>
    </form>
  );
}
