"use client";

import Link from "next/link";
import { useState } from "react";
import { AuthCard, Field, FormError, FormNotice } from "@/components/app/auth-card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { authClient } from "@/lib/auth-client";

export default function ForgotPasswordPage() {
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);
    const email = String(new FormData(event.currentTarget).get("email"));
    const { error } = await authClient.requestPasswordReset({ email, redirectTo: "/reset-password" });
    setPending(false);
    // Same message whether or not the account exists, so the form can't be used to probe emails.
    if (error) setError(error.message ?? "Something went wrong. Please try again.");
    else setSent(true);
  }

  return (
    <AuthCard title="Reset your password">
      <form onSubmit={onSubmit} className="grid gap-4">
        {sent ? (
          <FormNotice>If an account exists for that address, we&apos;ve sent a reset link. It expires in one hour.</FormNotice>
        ) : (
          <>
            <Field label="Email" id="email">
              <Input id="email" name="email" type="email" required autoComplete="email" />
            </Field>
            {error && <FormError>{error}</FormError>}
            <Button type="submit" size="lg" disabled={pending}>
              {pending ? "Please wait…" : "Send reset link"}
            </Button>
          </>
        )}
        <Link href="/sign-in" className="link w-fit">Back to sign in</Link>
      </form>
    </AuthCard>
  );
}
