import Link from "next/link";
import { Logo } from "@/components/logo";
import { GITHUB_URL } from "@/lib/site";
import { LanguageSwitcher } from "./language-switcher";
import { localePath, type Locale, type Messages } from "./i18n";

export function Nav({ t, locale }: { t: Messages["nav"]; locale: Locale }) {
  const links = [
    [t.features, "#features"],
    [t.selfHost, "#self-host"],
    [t.roadmap, "#roadmap"],
  ] as const;
  return (
    <header className="sticky top-0 z-50 border-b border-white/[0.06] bg-brand-charcoal/75 backdrop-blur-xl backdrop-saturate-150">
      <div className="mx-auto flex h-16 max-w-6xl items-center gap-8 px-6">
        <Logo href={localePath(locale)} />
        <nav aria-label={t.primary} className="hidden gap-1 text-sm text-slate-300 md:flex">
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
          <LanguageSwitcher locale={locale} label={t.language} />
          <Link href="/sign-in" className="hidden rounded-full px-3 py-1.5 text-slate-300 transition hover:text-white sm:block">
            {t.signIn}
          </Link>
          <Link
            href="/sign-up"
            className="rounded-full bg-indigo-600 px-4 py-2 font-medium shadow-[0_0_0_1px_rgba(255,255,255,0.12)_inset,0_8px_24px_-8px_rgba(99,102,241,0.7)] transition hover:bg-indigo-500"
          >
            {t.join}
          </Link>
        </div>
      </div>
    </header>
  );
}
