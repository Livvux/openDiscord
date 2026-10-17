import Link from "next/link";
import { Logo } from "@/components/logo";
import { GITHUB_URL } from "@/lib/site";
import { LanguageSwitcher } from "./language-switcher";
import { MobileMenu } from "./mobile-menu";
import { localePath, type Locale, type Messages } from "./i18n";
import { button, container, size } from "./ui";

export function Nav({ t, locale }: { t: Messages["nav"]; locale: Locale }) {
  const links = [
    [t.features, "#features"],
    [t.selfHost, "#self-host"],
    [t.roadmap, "#roadmap"],
    ["GitHub", GITHUB_URL],
  ] as const;
  const linkClass = "rounded-lg px-3 py-2 transition-colors hover:bg-ink/5";
  return (
    <header className="sticky top-0 z-40 bg-canvas">
      <div className={`${container} flex h-16 items-center gap-6`}>
        <div className="shrink-0">
          <Logo tone="light" href={localePath(locale)} />
        </div>
        <nav aria-label={t.primary} className="hidden gap-0.5 text-[15px] md:flex">
          {links.map(([label, href]) => (
            <a key={href} href={href} className={linkClass}>
              {label}
            </a>
          ))}
        </nav>
        <div className="ml-auto flex items-center gap-2 text-sm">
          <div className="max-sm:hidden">
            <LanguageSwitcher locale={locale} label={t.language} />
          </div>
          <Link href="/sign-in" className={`${button.outline} ${size.sm} max-sm:hidden`}>
            {t.signIn}
          </Link>
          <Link href="/sign-up" className={`${button.primary} ${size.sm}`}>
            {t.join}
          </Link>
          <MobileMenu label={t.primary} items={[...links.map(([label, href]) => ({ label, href })), { label: t.signIn, href: "/sign-in", internal: true }]} />
        </div>
      </div>
    </header>
  );
}
