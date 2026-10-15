"use client";

import { useState } from "react";
import { Logo } from "@/components/logo";
import { authClient } from "@/lib/auth-client";

const inputClass =
  "w-full rounded-md border border-slate-700 bg-slate-900 px-3 py-2 tracking-widest outline-none focus:border-brand-indigo";

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
    <main className="flex flex-1 items-center justify-center p-8">
      <form onSubmit={onSubmit} className="w-full max-w-sm space-y-4">
        <Logo />
        <h1 className="text-2xl font-semibold">Two-factor authentication</h1>
        <label className="block space-y-1">
          <span className="text-sm text-slate-400">{useBackupCode ? "Backup code" : "6-digit code from your authenticator app"}</span>
          <input
            key={String(useBackupCode)}
            name="code"
            required
            autoFocus
            autoComplete="one-time-code"
            inputMode={useBackupCode ? "text" : "numeric"}
            pattern={useBackupCode ? undefined : "[0-9 ]{6,7}"}
            className={inputClass}
          />
        </label>
        {error && <p role="alert" className="text-sm text-red-400">{error}</p>}
        <button
          type="submit"
          disabled={pending}
          className="w-full rounded-full bg-indigo-600 px-4 py-2.5 font-medium hover:bg-indigo-500 disabled:opacity-50"
        >
          {pending ? "Checking…" : "Verify"}
        </button>
        <button type="button" onClick={() => setUseBackupCode(!useBackupCode)} className="text-sm text-brand-cyan hover:underline">
          {useBackupCode ? "Use authenticator code instead" : "Use a backup code instead"}
        </button>
      </form>
    </main>
  );
}
