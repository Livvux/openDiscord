"use client";

import Link from "next/link";
import { useState } from "react";
import { Logo } from "@/components/logo";
import { authClient } from "@/lib/auth-client";

const inputClass =
  "w-full rounded-md border border-slate-700 bg-slate-900 px-3 py-2 outline-none focus:border-brand-indigo";

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
    <main className="flex flex-1 items-center justify-center p-8">
      <form onSubmit={onSubmit} className="w-full max-w-sm space-y-4">
        <Logo />
        <h1 className="text-2xl font-semibold">Reset your password</h1>
        {sent ? (
          <p role="status" className="text-emerald-400">
            If an account exists for that address, we&apos;ve sent a reset link. It expires in one hour.
          </p>
        ) : (
          <>
            <label className="block space-y-1">
              <span className="text-sm text-slate-400">Email</span>
              <input name="email" type="email" required autoComplete="email" className={inputClass} />
            </label>
            {error && <p role="alert" className="text-sm text-red-400">{error}</p>}
            <button
              type="submit"
              disabled={pending}
              className="w-full rounded-full bg-indigo-600 px-4 py-2.5 font-medium hover:bg-indigo-500 disabled:opacity-50"
            >
              {pending ? "Please wait…" : "Send reset link"}
            </button>
          </>
        )}
        <p className="text-sm text-slate-400">
          <Link href="/sign-in" className="text-brand-cyan hover:underline">Back to sign in</Link>
        </p>
      </form>
    </main>
  );
}
