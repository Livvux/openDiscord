"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useState } from "react";
import { AuthCard, Field, FormError, FormNotice } from "@/components/app/auth-card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { authClient } from "@/lib/auth-client";
import { safeNextPath } from "@/lib/safe-redirect";
import { TwoFactorStep } from "./two-factor-step";

export function AuthForm({ mode }: { mode: "sign-in" | "sign-up" }) {
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [needsSecondFactor, setNeedsSecondFactor] = useState(false);
  const isSignUp = mode === "sign-up";
  const next = safeNextPath(useSearchParams().get("next"));
  const nextQuery = next === "/app" ? "" : `?next=${encodeURIComponent(next)}`;

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const email = String(form.get("email"));
    const password = String(form.get("password"));
    setPending(true);
    setError(null);

    const { data, error } = isSignUp
      ? await authClient.signUp.email({ email, password, name: String(form.get("name")), callbackURL: next })
      : await authClient.signIn.email({ email, password });

    setPending(false);
    if (error) {
      setError(error.message ?? "Something went wrong. Please try again.");
      return;
    }
    if (data && "twoFactorRedirect" in data && data.twoFactorRedirect) {
      setNeedsSecondFactor(true);
      return;
    }
    // With email verification enabled, sign-up returns no session token.
    if (isSignUp && data && "token" in data && !data.token) {
      setNotice("Check your inbox to verify your email address.");
      return;
    }
    done();
  }

  function done() {
    // Auth endpoints change cookies outside Server Actions. Discard cached signed-out redirects.
    window.location.assign(next);
  }

  async function signInWithPasskey() {
    setError(null);
    const result = await authClient.signIn.passkey();
    if (result?.error) setError(result.error.message ?? "Passkey sign-in failed.");
    else done();
  }

  if (needsSecondFactor) return <TwoFactorStep onDone={done} />;

  return (
    <AuthCard title={isSignUp ? "Create your account" : "Welcome back"}>
      <form onSubmit={onSubmit} className="grid gap-4">
        {isSignUp && (
          <Field label="Display name" id="name">
            <Input id="name" name="name" required maxLength={64} autoComplete="nickname" />
          </Field>
        )}
        <Field label="Email" id="email">
          <Input id="email" name="email" type="email" required autoComplete="email" />
        </Field>
        <Field label="Password" id="password">
          <Input
            id="password"
            name="password"
            type="password"
            required
            minLength={10}
            autoComplete={isSignUp ? "new-password" : "current-password"}
          />
        </Field>
        {!isSignUp && (
          <Link href="/forgot-password" className="link w-fit">
            Forgot your password?
          </Link>
        )}
        {error && <FormError>{error}</FormError>}
        {notice && <FormNotice>{notice}</FormNotice>}
        <Button type="submit" size="lg" disabled={pending}>
          {pending ? "Please wait…" : isSignUp ? "Create account" : "Sign in"}
        </Button>
        {!isSignUp && (
          <Button type="button" size="lg" variant="outline" onClick={signInWithPasskey}>
            Sign in with a passkey
          </Button>
        )}
        <p className="text-muted-foreground">
          {isSignUp ? "Already have an account? " : "New here? "}
          <Link href={`${isSignUp ? "/sign-in" : "/sign-up"}${nextQuery}`} className="link">
            {isSignUp ? "Sign in" : "Create an account"}
          </Link>
        </p>
      </form>
    </AuthCard>
  );
}

