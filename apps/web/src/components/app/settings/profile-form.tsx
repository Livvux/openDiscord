"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { updateProfile } from "@/app/app/actions";
import { Textarea } from "@/components/ui/textarea";
import { authClient } from "@/lib/auth-client";

interface ProfileFormProps {
  name: string;
  email: string;
  bio: string;
  customStatus: string;
}

export function ProfileForm({ name, email, bio, customStatus }: ProfileFormProps) {
  const router = useRouter();
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    const form = new FormData(event.currentTarget);
    const { error } = await authClient.updateUser({ name: String(form.get("name")).trim() });
    const profile = error ? null : await updateProfile({ bio: String(form.get("bio") ?? ""), customStatus: String(form.get("customStatus") ?? "") });
    setPending(false);
    const failure = error ? (error.message ?? "Could not save.") : profile && !profile.ok ? profile.error : null;
    setStatus(failure ? { ok: false, text: failure } : { ok: true, text: "Saved." });
    if (!failure) router.refresh();
  }

  return (
    <form onSubmit={onSubmit} className="grid max-w-sm gap-3">
      <div className="grid gap-1.5">
        <Label htmlFor="profile-name">Display name</Label>
        <Input id="profile-name" name="name" defaultValue={name} required maxLength={64} autoComplete="nickname" />
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor="profile-status">Custom status</Label>
        <Input id="profile-status" name="customStatus" defaultValue={customStatus} maxLength={80} placeholder="What are you up to?" />
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor="profile-bio">About me</Label>
        <Textarea id="profile-bio" name="bio" defaultValue={bio} maxLength={190} rows={3} placeholder="A short line about you" />
        <p className="text-xs text-muted-foreground">Up to 190 characters. Shown to your friends.</p>
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
