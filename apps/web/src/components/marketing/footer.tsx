import Link from "next/link";
import { Logo } from "@/components/logo";
import { GITHUB_URL } from "@/lib/site";
import { localeNames, localePath, locales, messages, type Locale, type Messages } from "./i18n";
import { button, container, size } from "./ui";

export function Footer({ t = messages.en.footer, locale = "en" }: { t?: Messages["footer"]; locale?: Locale }) {
  const nav = messages[locale].nav;
  const home = localePath(locale);
  const linkClass = "text-ink-muted transition-colors hover:text-ink";
  return (
    <footer>
      <div className="mx-2 rounded-[1.75rem] bg-dark text-canvas sm:mx-3">
        <div className={`${container} py-20 text-center sm:py-28`}>
          <h2 className="mx-auto max-w-3xl text-[clamp(2.25rem,5.4vw,4.25rem)] leading-[1.03] font-semibold tracking-[-0.04em] text-balance">
            {t.titleStart} {t.titleAccent}
          </h2>
          <p className="mx-auto mt-6 max-w-xl text-lg text-balance text-dark-muted">{t.lead}</p>
          <div className="mt-10 flex flex-wrap justify-center gap-3">
            <Link href="/sign-up" className={`${button.onDark} ${size.lg}`}>
              {t.join}
            </Link>
            <Link href="/funding" className={`${button.outlineOnDark} ${size.lg}`}>
              {t.funding}
            </Link>
          </div>
        </div>
      </div>

      <div className={`${container} grid gap-12 py-16 text-[15px] sm:grid-cols-2 lg:grid-cols-[1.6fr_1fr_1fr_1fr_1fr]`}>
        <div className="sm:col-span-2 lg:col-span-1">
          <Logo tone="light" href={home} />
          <p className="mt-4 max-w-xs text-ink-muted">{t.tagline}</p>
        </div>
        <nav aria-label={t.nav} className="contents">
          <ul className="space-y-3">
            <li><a href={`${home}#features`} className={linkClass}>{nav.features}</a></li>
            <li><a href={`${home}#self-host`} className={linkClass}>{nav.selfHost}</a></li>
            <li><a href={`${home}#roadmap`} className={linkClass}>{nav.roadmap}</a></li>
            {/* eslint-disable-next-line @next/next/no-html-link-for-pages -- /discover is a route handler, not a page; the rule mistakes it for /[lang] */}
            <li><a href="/discover" className={linkClass}>{t.discover}</a></li>
          </ul>
          <ul className="space-y-3">
            <li><a href={GITHUB_URL} className={linkClass}>GitHub</a></li>
            <li><a href={`${GITHUB_URL}/blob/main/LICENSE`} className={linkClass}>AGPL-3.0</a></li>
            <li><Link href="/sign-in" className={linkClass}>{t.signIn}</Link></li>
          </ul>
          <ul className="space-y-3">
            <li><Link href="/privacy" className={linkClass}>{t.privacy}</Link></li>
            <li><Link href="/terms" className={linkClass}>{t.terms}</Link></li>
            <li><Link href="/guidelines" className={linkClass}>{t.guidelines}</Link></li>
            <li><Link href="/imprint" className={linkClass}>{t.imprint}</Link></li>
          </ul>
        </nav>
        <ul aria-label={nav.language} className="space-y-3">
          {locales.map((l) => (
            <li key={l}>
              <a href={localePath(l)} hrefLang={l} lang={l} aria-current={l === locale ? "page" : undefined} className={`${linkClass} aria-[current=page]:font-medium aria-[current=page]:text-ink`}>
                {localeNames[l]}
              </a>
            </li>
          ))}
        </ul>
      </div>
    </footer>
  );
}
