"use client";

import { useState } from "react";
import { AuthCard, Field, FormError } from "@/components/app/auth-card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { authClient } from "@/lib/auth-client";

/** Second sign-in step for accounts with an authenticator app. */
export function TwoFactorStep({ onDone }: { onDone: () => void }) {
  const [useBackupCode, setUseBackupCode] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const code = String(new FormData(event.currentTarget).get("code")).replace(/\s+/g, "");
    setPending(true);
    setError(null);
    const { error } = useBackupCode
      ? await authClient.twoFactor.verifyBackupCode({ code })
      : await authClient.twoFactor.verifyTotp({ code });
    setPending(false);
    if (error) setError(error.message ?? "That code didn't work.");
    else onDone();
  }

  return (
    <AuthCard title="Two-factor authentication">
      <form onSubmit={onSubmit} className="grid gap-4">
        <Field label={useBackupCode ? "Backup code" : "6-digit code from your authenticator app"} id="code">
          <Input
            key={String(useBackupCode)}
            id="code"
            name="code"
            required
            autoFocus
            autoComplete="one-time-code"
            inputMode={useBackupCode ? "text" : "numeric"}
            pattern={useBackupCode ? undefined : "[0-9 ]{6,7}"}
            className="tracking-widest"
          />
        </Field>
        {error && <FormError>{error}</FormError>}
        <Button type="submit" size="lg" disabled={pending}>
          {pending ? "Checking…" : "Verify"}
        </Button>
        <button type="button" onClick={() => setUseBackupCode(!useBackupCode)} className="link w-fit">
          {useBackupCode ? "Use authenticator code instead" : "Use a backup code instead"}
        </button>
      </form>
    </AuthCard>
  );
}
