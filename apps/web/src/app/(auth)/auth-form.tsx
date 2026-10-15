"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { authClient } from "@/lib/auth-client";

const inputClass =
  "w-full rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 outline-none focus:border-violet-500";

export function AuthForm({ mode }: { mode: "sign-in" | "sign-up" }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const isSignUp = mode === "sign-up";

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const email = String(form.get("email"));
    const password = String(form.get("password"));
    setPending(true);
    setError(null);

    const { data, error } = isSignUp
      ? await authClient.signUp.email({ email, password, name: String(form.get("name")), callbackURL: "/app" })
      : await authClient.signIn.email({ email, password });

    setPending(false);
    if (error) {
      setError(error.message ?? "Something went wrong. Please try again.");
      return;
    }
    // With email verification enabled, sign-up returns no session token.
    if (isSignUp && !data?.token) {
      setNotice("Check your inbox to verify your email address.");
      return;
    }
    router.push("/app");
    router.refresh();
  }

  return (
    <main className="flex flex-1 items-center justify-center p-8">
      <form onSubmit={onSubmit} className="w-full max-w-sm space-y-4">
        <h1 className="text-2xl font-semibold">{isSignUp ? "Create your account" : "Welcome back"}</h1>
        {isSignUp && (
          <label className="block space-y-1">
            <span className="text-sm text-zinc-400">Display name</span>
            <input name="name" required maxLength={64} autoComplete="nickname" className={inputClass} />
          </label>
        )}
        <label className="block space-y-1">
          <span className="text-sm text-zinc-400">Email</span>
          <input name="email" type="email" required autoComplete="email" className={inputClass} />
        </label>
        <label className="block space-y-1">
          <span className="text-sm text-zinc-400">Password</span>
          <input
            name="password"
            type="password"
            required
            minLength={10}
            autoComplete={isSignUp ? "new-password" : "current-password"}
            className={inputClass}
          />
        </label>
        {error && <p role="alert" className="text-sm text-red-400">{error}</p>}
        {notice && <p role="status" className="text-sm text-emerald-400">{notice}</p>}
        <button
          type="submit"
          disabled={pending}
          className="w-full rounded-md bg-violet-600 px-4 py-2 font-medium hover:bg-violet-500 disabled:opacity-50"
        >
          {pending ? "Please wait…" : isSignUp ? "Create account" : "Sign in"}
        </button>
        <p className="text-sm text-zinc-400">
          {isSignUp ? "Already have an account? " : "New here? "}
          <Link href={isSignUp ? "/sign-in" : "/sign-up"} className="text-violet-400 hover:underline">
            {isSignUp ? "Sign in" : "Create an account"}
          </Link>
        </p>
      </form>
    </main>
  );
}
