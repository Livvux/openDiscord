import Link from "next/link";
import { Logo } from "@/components/logo";
import { GITHUB_URL } from "@/lib/site";

const links = [
  ["Features", "#features"],
  ["Self-host", "#self-host"],
  ["Roadmap", "#roadmap"],
] as const;

export function Nav() {
  return (
    <header className="sticky top-0 z-50 border-b border-white/5 bg-brand-charcoal">
      <div className="mx-auto flex h-16 max-w-6xl items-center gap-8 px-6">
        <Logo />
        <nav aria-label="Primary" className="hidden gap-1 text-sm text-slate-300 md:flex">
          {links.map(([label, href]) => (
            <a key={href} href={href} className="rounded-full px-3 py-1.5 transition hover:bg-white/5 hover:text-white">
              {label}
            </a>
          ))}
          <a href={GITHUB_URL} className="rounded-full px-3 py-1.5 transition hover:bg-white/5 hover:text-white">
            GitHub
          </a>
        </nav>
        <div className="ml-auto flex items-center gap-2 text-sm whitespace-nowrap">
          <Link href="/sign-in" className="hidden rounded-full px-3 py-1.5 text-slate-300 transition hover:text-white sm:block">
            Sign in
          </Link>
          <Link
            href="/sign-up"
            className="rounded-full bg-indigo-600 px-4 py-2 font-medium transition hover:bg-indigo-500"
          >
            Join the beta
          </Link>
        </div>
      </div>
    </header>
  );
}
