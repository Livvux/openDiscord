"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import { Logo } from "@/components/logo";
import { authClient } from "@/lib/auth-client";

const inputClass =
  "w-full rounded-md border border-slate-700 bg-slate-900 px-3 py-2 outline-none focus:border-brand-indigo";

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
    <main className="flex flex-1 items-center justify-center p-8">
      <form onSubmit={onSubmit} className="w-full max-w-sm space-y-4">
        <Logo />
        <h1 className="text-2xl font-semibold">Choose a new password</h1>
        {token ? (
          <>
            <label className="block space-y-1">
              <span className="text-sm text-slate-400">New password</span>
              <input name="password" type="password" required minLength={10} autoComplete="new-password" className={inputClass} />
            </label>
            <p className="text-sm text-slate-400">You&apos;ll be signed out on all devices.</p>
            <button
              type="submit"
              disabled={pending}
              className="w-full rounded-full bg-indigo-600 px-4 py-2.5 font-medium hover:bg-indigo-500 disabled:opacity-50"
            >
              {pending ? "Please wait…" : "Set new password"}
            </button>
          </>
        ) : null}
        {(error || !token) && (
          <p role="alert" className="text-sm text-red-400">
            {error ?? "This reset link is invalid or has expired."}{" "}
            <Link href="/forgot-password" className="text-brand-cyan underline underline-offset-2">Request a new one</Link>
          </p>
        )}
      </form>
    </main>
  );
}
