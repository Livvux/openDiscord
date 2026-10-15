"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { encode } from "uqr";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { authClient } from "@/lib/auth-client";

/** QR code rendered as one SVG path, generated locally (the secret never leaves the browser). */
function QrCode({ value }: { value: string }) {
  const { data, size } = encode(value, { border: 2 });
  const d = data.flatMap((row, y) => row.map((on, x) => (on ? `M${x} ${y}h1v1h-1z` : ""))).join("");
  return (
    <svg viewBox={`0 0 ${size} ${size}`} className="size-44 rounded-lg bg-white" role="img" aria-label="QR code for your authenticator app">
      <path d={d} fill="black" shapeRendering="crispEdges" />
    </svg>
  );
}

type Setup = { totpURI: string; backupCodes: string[] };

export function TwoFactorSettings({ enabled, required = false }: { enabled: boolean; required?: boolean }) {
  const router = useRouter();
  const [setup, setSetup] = useState<Setup | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function call<T>(fn: () => Promise<{ data: T | null; error: { message?: string } | null }>) {
    setPending(true);
    setError(null);
    const { data, error } = await fn();
    setPending(false);
    if (error) setError(error.message ?? "Something went wrong.");
    return error ? null : data;
  }

  async function start(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const password = String(new FormData(event.currentTarget).get("password"));
    const data = await call(() => authClient.twoFactor.enable({ password }));
    // Only TOTP is configured on the server, so the response always carries a URI.
    if (data && "totpURI" in data) setSetup({ totpURI: data.totpURI, backupCodes: data.backupCodes });
  }

  async function confirm(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const code = String(new FormData(event.currentTarget).get("code")).replace(/\s+/g, "");
    if (await call(() => authClient.twoFactor.verifyTotp({ code }))) {
      setSetup(null);
      router.refresh();
    }
  }

  async function disable(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const password = String(new FormData(event.currentTarget).get("password"));
    if (await call(() => authClient.twoFactor.disable({ password }))) router.refresh();
  }

  const errorText = error && <p role="alert" className="text-sm text-destructive">{error}</p>;

  if (enabled && required) return <p className="text-sm text-success">Authenticator app is on and required for your instance administrator account.</p>;

  if (enabled) {
    return (
      <form onSubmit={disable} className="grid max-w-sm gap-2">
        <p className="text-sm text-success">Authenticator app is on. Sign-ins ask for a code.</p>
        <Label htmlFor="disable-2fa-password">Password to turn it off</Label>
        <div className="flex gap-2">
          <Input id="disable-2fa-password" name="password" type="password" required autoComplete="current-password" />
          <Button type="submit" variant="outline" disabled={pending}>Turn off</Button>
        </div>
        {errorText}
      </form>
    );
  }

  if (setup) {
    const secret = new URL(setup.totpURI).searchParams.get("secret") ?? "";
    return (
      <div className="grid gap-4">
        <div className="flex flex-wrap items-start gap-4">
          <QrCode value={setup.totpURI} />
          <div className="grid max-w-sm gap-2 text-sm">
            <p>Scan the code with an authenticator app, or enter this key manually:</p>
            <code className="rounded bg-muted px-2 py-1 font-mono break-all">{secret}</code>
            <p className="font-medium">Save these backup codes somewhere safe. Each works once if you lose your device:</p>
            <ul className="grid grid-cols-2 gap-1 font-mono">
              {setup.backupCodes.map((c) => (
                <li key={c}>{c}</li>
              ))}
            </ul>
          </div>
        </div>
        <form onSubmit={confirm} className="grid max-w-sm gap-2">
          <Label htmlFor="confirm-2fa-code">Enter the 6-digit code to finish</Label>
          <div className="flex gap-2">
            <Input id="confirm-2fa-code" name="code" required inputMode="numeric" autoComplete="one-time-code" />
            <Button type="submit" disabled={pending}>Turn on</Button>
          </div>
          {errorText}
        </form>
      </div>
    );
  }

  return (
    <form onSubmit={start} className="grid max-w-sm gap-2">
      <p className="text-sm text-muted-foreground">Ask for a code from an authenticator app when signing in with your password.</p>
      <Label htmlFor="enable-2fa-password">Confirm your password</Label>
      <div className="flex gap-2">
        <Input id="enable-2fa-password" name="password" type="password" required autoComplete="current-password" />
        <Button type="submit" disabled={pending}>Set up</Button>
      </div>
      {errorText}
    </form>
  );
}
