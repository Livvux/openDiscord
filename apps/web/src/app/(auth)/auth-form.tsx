"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useState } from "react";
import { AuthCard, Field, FormError, FormNotice } from "@/components/app/auth-card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { BLOCKED_MESSAGES, type BlockedState } from "@/lib/account-state";
import { authClient } from "@/lib/auth-client";
import { Turnstile } from "@/components/app/turnstile";
import { safeNextPath } from "@/lib/safe-redirect";
import { TwoFactorStep } from "./two-factor-step";


interface AuthFormProps {
  mode: "sign-in" | "sign-up";
  /** Sign-up only: new accounts need an administrator's approval. */
  closedAlpha?: boolean;
  /** Sign-up only: Cloudflare Turnstile is required when set. */
  turnstileSiteKey?: string;
}

export function AuthForm({ mode, closedAlpha = false, turnstileSiteKey }: AuthFormProps) {
  const params = useSearchParams();
  const [error, setError] = useState<string | null>(() => {
    // Set by the server when a signed-in account is blocked (src/server/session.ts).
    const state = params.get("error");
    return state && state in BLOCKED_MESSAGES ? BLOCKED_MESSAGES[state as BlockedState] : null;
  });
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [needsSecondFactor, setNeedsSecondFactor] = useState(false);
  const [awaitingApproval, setAwaitingApproval] = useState(false);
  const [captchaToken, setCaptchaToken] = useState<string | null>(null);
  const [captchaKey, setCaptchaKey] = useState(0);
  const isSignUp = mode === "sign-up";
  const captchaRequired = isSignUp && !!turnstileSiteKey;
  const next = safeNextPath(params.get("next"));
  const nextQuery = next === "/app" ? "" : `?next=${encodeURIComponent(next)}`;

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const email = String(form.get("email"));
    const password = String(form.get("password"));
    if (captchaRequired && !captchaToken) {
      setError("Complete the anti-spam check first.");
      return;
    }
    setPending(true);
    setError(null);
    setNotice(null);

    const { data, error } = isSignUp
      ? await authClient.signUp.email(
          { email, password, name: String(form.get("name")), callbackURL: next },
          { headers: captchaToken ? { "x-captcha-response": captchaToken } : undefined },
        )
      : await authClient.signIn.email({ email, password, callbackURL: next });

    setPending(false);
    if (captchaRequired) {
      // Turnstile tokens are single-use: get a fresh one for the next attempt.
      setCaptchaToken(null);
      setCaptchaKey((k) => k + 1);
    }
    if (isSignUp && error?.code === "ACCOUNT_PENDING") {
      setAwaitingApproval(true);
      return;
    }
    if (error?.code === "EMAIL_NOT_VERIFIED") {
      setNotice("Please confirm your email address first. We've sent you a new link.");
      return;
    }
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
      setNotice(
        closedAlpha
          ? "Check your inbox to verify your email address. An administrator then reviews your request."
          : "Check your inbox to verify your email address.",
      );
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

  if (awaitingApproval) {
    return (
      <AuthCard title="You're on the list" description={<span role="status">Your account is waiting for approval.</span>}>
        <p className="text-zinc-300">
          This instance is in Closed Alpha. An administrator reviews new accounts; once yours is approved, sign in
          with the email and password you just used.
        </p>
        <Link href="/sign-in" className="link mt-4 inline-block">Back to sign in</Link>
      </AuthCard>
    );
  }

  return (
    <AuthCard
      title={isSignUp ? (closedAlpha ? "Request alpha access" : "Create your account") : "Welcome back"}
      description={isSignUp && closedAlpha ? "openDiscord is in Closed Alpha. New accounts are reviewed by an administrator before they can sign in." : undefined}
    >
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
        {isSignUp && turnstileSiteKey && (
          <Turnstile key={captchaKey} siteKey={turnstileSiteKey} action="sign-up" onToken={setCaptchaToken} onError={setError} />
        )}
        {!isSignUp && (
          <Link href="/forgot-password" className="link w-fit">
            Forgot your password?
          </Link>
        )}
        {error && <FormError>{error}</FormError>}
        {notice && <FormNotice>{notice}</FormNotice>}
        <Button type="submit" size="lg" disabled={pending}>
          {pending ? "Please wait…" : isSignUp ? (closedAlpha ? "Request access" : "Create account") : "Sign in"}
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

