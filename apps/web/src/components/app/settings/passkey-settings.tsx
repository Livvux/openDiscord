"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { authClient } from "@/lib/auth-client";

export function PasskeySettings() {
  const { data: passkeys, isPending, refetch } = authClient.useListPasskeys();
  const [error, setError] = useState<string | null>(null);

  async function add(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const name = String(new FormData(form).get("name")).trim() || undefined;
    setError(null);
    const result = await authClient.passkey.addPasskey({ name });
    if (result?.error) return setError(result.error.message ?? "Could not add the passkey.");
    form.reset();
    refetch();
  }

  async function remove(id: string) {
    const { error } = await authClient.passkey.deletePasskey({ id });
    if (error) setError(error.message ?? "Could not remove the passkey.");
    else refetch();
  }

  return (
    <div className="grid gap-3">
      {isPending ? (
        <p className="text-sm text-muted-foreground">Loading passkeys…</p>
      ) : passkeys && passkeys.length > 0 ? (
        <ul className="divide-y rounded-lg border text-sm">
          {passkeys.map((p) => (
            <li key={p.id} className="flex items-center justify-between gap-3 px-3 py-2">
              <span>
                {p.name ?? "Passkey"}
                <span className="block text-xs text-muted-foreground" suppressHydrationWarning>
                  Added {new Date(p.createdAt).toLocaleDateString()}
                </span>
              </span>
              <Button variant="outline" size="sm" onClick={() => remove(p.id)} aria-label={`Remove passkey ${p.name ?? ""}`.trim()}>
                Remove
              </Button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted-foreground">No passkeys yet. Passkeys let you sign in with your device instead of a password.</p>
      )}
      <form onSubmit={add} className="grid max-w-sm gap-2">
        <Label htmlFor="passkey-name">Name (optional)</Label>
        <div className="flex gap-2">
          <Input id="passkey-name" name="name" maxLength={64} placeholder="e.g. Laptop" />
          <Button type="submit">Add passkey</Button>
        </div>
      </form>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    </div>
  );
}
