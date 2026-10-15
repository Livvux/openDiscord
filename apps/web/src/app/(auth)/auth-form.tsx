"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import { Logo } from "@/components/logo";
import { authClient } from "@/lib/auth-client";
import { safeNextPath } from "@/lib/safe-redirect";
import { TwoFactorStep } from "./two-factor-step";

const inputClass =
  "w-full rounded-md border border-slate-700 bg-slate-900 px-3 py-2 outline-none focus:border-brand-indigo";

export function AuthForm({ mode }: { mode: "sign-in" | "sign-up" }) {
  const router = useRouter();
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
    router.push(next);
    router.refresh();
  }

  async function signInWithPasskey() {
    setError(null);
    const result = await authClient.signIn.passkey();
    if (result?.error) setError(result.error.message ?? "Passkey sign-in failed.");
    else done();
  }

  if (needsSecondFactor) return <TwoFactorStep onDone={done} />;

  return (
    <main className="flex flex-1 items-center justify-center p-8">
      <form onSubmit={onSubmit} className="w-full max-w-sm space-y-4">
        <Logo />
        <h1 className="text-2xl font-semibold">{isSignUp ? "Create your account" : "Welcome back"}</h1>
        {isSignUp && (
          <label className="block space-y-1">
            <span className="text-sm text-slate-400">Display name</span>
            <input name="name" required maxLength={64} autoComplete="nickname" className={inputClass} />
          </label>
        )}
        <label className="block space-y-1">
          <span className="text-sm text-slate-400">Email</span>
          <input name="email" type="email" required autoComplete="email" className={inputClass} />
        </label>
        <label className="block space-y-1">
          <span className="text-sm text-slate-400">Password</span>
          <input
            name="password"
            type="password"
            required
            minLength={10}
            autoComplete={isSignUp ? "new-password" : "current-password"}
            className={inputClass}
          />
        </label>
        {!isSignUp && (
          <p className="text-sm">
            <Link href="/forgot-password" className="text-slate-400 hover:text-white hover:underline">
              Forgot your password?
            </Link>
          </p>
        )}
        {error && <p role="alert" className="text-sm text-red-400">{error}</p>}
        {notice && <p role="status" className="text-sm text-emerald-400">{notice}</p>}
        <button
          type="submit"
          disabled={pending}
          className="w-full rounded-full bg-indigo-600 px-4 py-2.5 font-medium hover:bg-indigo-500 disabled:opacity-50"
        >
          {pending ? "Please wait…" : isSignUp ? "Create account" : "Sign in"}
        </button>
        {!isSignUp && (
          <button
            type="button"
            onClick={signInWithPasskey}
            className="w-full rounded-full border border-slate-700 px-4 py-2.5 font-medium hover:bg-slate-800"
          >
            Sign in with a passkey
          </button>
        )}
        <p className="text-sm text-slate-400">
          {isSignUp ? "Already have an account? " : "New here? "}
          <Link href={`${isSignUp ? "/sign-in" : "/sign-up"}${nextQuery}`} className="text-brand-cyan underline underline-offset-2">
            {isSignUp ? "Sign in" : "Create an account"}
          </Link>
        </p>
      </form>
    </main>
  );
}
