import Link from "next/link";
import { Logo } from "@/components/logo";
import { GITHUB_URL } from "@/lib/site";
import { localeNames, localePath, locales, messages, type Locale, type Messages } from "./i18n";

export function Footer({ t = messages.en.footer, locale = "en" }: { t?: Messages["footer"]; locale?: Locale }) {
  return (
    <footer className="relative isolate overflow-hidden border-t border-white/[0.06]">
      <div aria-hidden className="absolute inset-0 -z-10">
        <div className="absolute top-24 left-1/2 size-[44rem] -translate-x-[70%] rounded-full border-[72px] border-brand-indigo/20 blur-3xl" />
        <div className="absolute top-40 left-1/2 size-[38rem] -translate-x-[20%] rounded-full border-[64px] border-brand-mint/15 blur-3xl" />
        <div className="grain absolute inset-0" />
      </div>
      <div className="mx-auto max-w-6xl px-6 pt-32 pb-14 text-center">
        <h2 className="reveal mx-auto max-w-4xl text-5xl font-semibold tracking-[-0.035em] text-balance sm:text-7xl">
          {t.titleStart} <span className="accent">{t.titleAccent}</span>
        </h2>
        <p className="reveal mx-auto mt-7 max-w-xl text-lg text-slate-300">{t.lead}</p>
        <div className="reveal mt-11 flex flex-wrap justify-center gap-3">
          <Link
            href="/sign-up"
            className="rounded-full bg-white px-7 py-3.5 font-medium text-brand-charcoal shadow-[0_10px_40px_-10px_rgba(73,221,192,0.55)] transition hover:bg-brand-mist"
          >
            {t.join} <span aria-hidden>→</span>
          </Link>
          <Link href="/funding" className="rounded-full border border-white/15 bg-white/[0.04] px-7 py-3.5 font-medium backdrop-blur transition hover:bg-white/10">
            {t.funding}
          </Link>
        </div>

        <div className="mt-32 flex flex-col items-center gap-6 border-t border-white/10 pt-10 text-sm text-slate-400">
          <Logo href={localePath(locale)} />
          <p className="tracking-[0.25em] uppercase">{t.tagline}</p>
          <nav aria-label={t.nav} className="flex flex-wrap justify-center gap-5">
            <a href={GITHUB_URL} className="hover:text-white">GitHub</a>
            <a href={`${GITHUB_URL}/blob/main/LICENSE`} className="hover:text-white">AGPL-3.0</a>
            {/* eslint-disable-next-line @next/next/no-html-link-for-pages -- /discover is a route handler, not a page; the rule mistakes it for /[lang] */}
            <a href="/discover" className="hover:text-white">{t.discover}</a>
            <Link href="/privacy" className="hover:text-white">{t.privacy}</Link>
            <Link href="/terms" className="hover:text-white">{t.terms}</Link>
            <Link href="/imprint" className="hover:text-white">{t.imprint}</Link>
            <Link href="/sign-in" className="hover:text-white">{t.signIn}</Link>
          </nav>
        </div>
        <ul aria-label={messages[locale].nav.language} className="mt-6 flex flex-wrap justify-center gap-x-4 gap-y-2 text-sm text-slate-400">
          {locales.map((l) => (
            <li key={l}>
              <a href={localePath(l)} hrefLang={l} lang={l} aria-current={l === locale ? "page" : undefined} className="hover:text-white aria-[current=page]:text-white">
                {localeNames[l]}
              </a>
            </li>
          ))}
        </ul>
      </div>
    </footer>
  );
}
