"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { authClient } from "@/lib/auth-client";
import { dmFetch, forgetDmDevice } from "@/lib/dm/client";
import type { DmResetState } from "@/lib/dm/contracts";

export function IdentityReset({ userId }: { userId: string }) {
  const [state, setState] = useState<DmResetState | null>(null);
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const field = "rounded-lg border bg-background px-3 py-2 text-sm";
  async function open() {
    setBusy(true); setError(null); setConfirmed(false); setPassword(""); setCode(""); setState(null);
    try { setState(await dmFetch<DmResetState>("/api/dm/reset")); } catch (error) { setError(error instanceof Error ? error.message : "Reset is unavailable."); }
    finally { setBusy(false); }
  }
  async function signInAgain() {
    setBusy(true); setError(null);
    try {
      const result = await authClient.signOut();
      if (result.error) throw new Error(result.error.message ?? "Could not sign out. Try again.");
      window.location.assign(new URL("/sign-in?next=/app/messages", window.location.origin).href);
    } catch (error) { setError(error instanceof Error ? error.message : "Could not sign out. Try again."); setBusy(false); }
  }
  async function reset() {
    if (!state?.identity || !confirmed) return;
    setBusy(true); setError(null);
    try {
      await dmFetch("/api/dm/reset", { identity: state.identity, password, ...(state.twoFactorEnabled ? { code } : {}), confirmed });
      forgetDmDevice(userId);
      window.location.assign(new URL("/sign-in?next=/app/messages", window.location.origin).href);
    } catch (error) { setError(error instanceof Error ? error.message : "Encryption could not be reset."); }
    finally { setPassword(""); setCode(""); setConfirmed(false); setBusy(false); }
  }
  return <div className="grid gap-3 border-t pt-4">
    <Button variant="outline" className="justify-self-start" disabled={busy} onClick={() => void open()}>Reset lost encryption identity</Button>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    {state && <form className="grid max-w-xl gap-3 rounded-lg border border-destructive/50 p-4" onSubmit={(event) => { event.preventDefault(); void reset(); }}>
      <h3 className="font-semibold">Start a new encryption identity</h3>
      <p className="text-sm">Use this only after losing all trusted devices and private recovery files. This permanently revokes every encryption device, deletes every encrypted server backup and signs out every session, including this browser. Sign in again afterwards to enroll your new identity. Old encrypted history cannot be recovered through this reset. Existing downloaded copies cannot be erased. Contacts must verify your new identity before you can message them again.</p>
      {!state.identity ? <p>No existing encryption identity needs a reset.</p> : !state.freshSession ? <><p>Sign in again, then return here within five minutes.</p><Button type="button" variant="outline" disabled={busy} onClick={() => void signInAgain()}>Sign in again</Button></> : <>
        <label className="grid gap-1 text-sm">Current password<input className={field} type="password" autoComplete="current-password" required maxLength={256} value={password} onChange={(event) => setPassword(event.target.value)} /></label>
        {state.twoFactorEnabled && <label className="grid gap-1 text-sm">Authenticator code<input className={field} inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" required maxLength={6} value={code} onChange={(event) => setCode(event.target.value)} /></label>}
        <label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} required />I understand that this destroys my old recovery path and requires new verification.</label>
        <Button type="submit" variant="destructive" disabled={busy || !confirmed || !password}>Permanently reset encryption identity</Button>
      </>}
      <Button type="button" variant="outline" disabled={busy} onClick={() => { setState(null); setPassword(""); setCode(""); setConfirmed(false); }}>Close reset form</Button>
    </form>}
  </div>;
}
