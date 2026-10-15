"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import { AuthCard, Field, FormError } from "@/components/app/auth-card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { authClient } from "@/lib/auth-client";

export function ResetPasswordForm() {
  const router = useRouter();
  const params = useSearchParams();
  const token = params.get("token");
  const [error, setError] = useState<string | null>(params.get("error") ? "This reset link is invalid or has expired." : null);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!token) return;
    setPending(true);
    const newPassword = String(new FormData(event.currentTarget).get("password"));
    const { error } = await authClient.resetPassword({ newPassword, token });
    setPending(false);
    if (error) return setError(error.message ?? "This reset link is invalid or has expired.");
    router.push("/sign-in");
  }

  return (
    <AuthCard title="Choose a new password" description={token ? "You'll be signed out on all devices." : undefined}>
      <form onSubmit={onSubmit} className="grid gap-4">
        {token && (
          <>
            <Field label="New password" id="password">
              <Input id="password" name="password" type="password" required minLength={10} autoComplete="new-password" />
            </Field>
            <Button type="submit" size="lg" disabled={pending}>
              {pending ? "Please wait…" : "Set new password"}
            </Button>
          </>
        )}
        {(error || !token) && (
          <FormError>
            {error ?? "This reset link is invalid or has expired."}{" "}
            <Link href="/forgot-password" className="link">Request a new one</Link>
          </FormError>
        )}
      </form>
    </AuthCard>
  );
}
