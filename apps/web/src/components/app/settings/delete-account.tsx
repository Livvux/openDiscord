"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { authClient } from "@/lib/auth-client";

export function DeleteAccount({ ownedCommunities }: { ownedCommunities: string[] }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  if (ownedCommunities.length > 0) {
    return (
      <p className="text-sm">
        You own {ownedCommunities.join(", ")}. Delete {ownedCommunities.length === 1 ? "it" : "them"} in the community
        settings first, so members aren&apos;t left without an owner.
      </p>
    );
  }

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!window.confirm("Delete your account and all your messages permanently?")) return;
    setPending(true);
    const password = String(new FormData(event.currentTarget).get("password"));
    const { error } = await authClient.deleteUser({ password });
    setPending(false);
    if (error) return setError(error.message ?? "Could not delete your account.");
    router.push("/");
    router.refresh();
  }

  return (
    <form onSubmit={onSubmit} className="grid max-w-sm gap-3">
      <div className="grid gap-1.5">
        <Label htmlFor="delete-password">Confirm with your password</Label>
        <Input id="delete-password" name="password" type="password" required autoComplete="current-password" />
      </div>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <Button type="submit" variant="destructive" disabled={pending}>
        {pending ? "Deleting…" : "Delete my account"}
      </Button>
    </form>
  );
}
