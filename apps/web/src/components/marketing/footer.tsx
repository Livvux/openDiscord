import Link from "next/link";
import { Logo } from "@/components/logo";
import { GITHUB_URL, SPONSOR_URL } from "@/lib/site";

export function Footer() {
  return (
    <footer className="relative isolate overflow-hidden">
      <div className="mx-auto max-w-6xl px-6 pt-28 pb-14 text-center">
        <h2 className="reveal mx-auto max-w-3xl text-4xl font-semibold tracking-tight text-balance sm:text-6xl">
          Bring your community home.
        </h2>
        <p className="reveal mx-auto mt-6 max-w-xl text-lg text-slate-300">
          Join the invite-only beta, or help fund development and hosting.
        </p>
        <div className="reveal mt-10 flex flex-wrap justify-center gap-3">
          <Link href="/sign-up" className="rounded-full bg-brand-indigo px-6 py-3 font-medium transition hover:bg-indigo-400">
            Join the beta →
          </Link>
          <a href={SPONSOR_URL} className="rounded-full border border-white/15 bg-white/5 px-6 py-3 font-medium transition hover:bg-white/10">
            ♥ Sponsor on GitHub
          </a>
        </div>

        <div className="mt-28 flex flex-col items-center justify-between gap-6 border-t border-white/10 pt-8 text-sm text-slate-400 md:flex-row">
          <Logo />
          <p className="tracking-[0.25em] uppercase">Open minds. Brighter together.</p>
          <nav aria-label="Footer" className="flex gap-5">
            <a href={GITHUB_URL} className="hover:text-white">GitHub</a>
            <a href={`${GITHUB_URL}/blob/main/LICENSE`} className="hover:text-white">AGPL-3.0</a>
            <Link href="/sign-in" className="hover:text-white">Sign in</Link>
          </nav>
        </div>
      </div>
    </footer>
  );
}
