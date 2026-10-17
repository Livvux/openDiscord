import { Globe } from "lucide-react";
import { localeNames, localePath, locales, type Locale } from "./i18n";

/** A disclosure instead of a client-side menu: works without JavaScript and every option is a real link. */
export function LanguageSwitcher({ locale, label }: { locale: Locale; label: string }) {
  return (
    <details className="group relative">
      <summary
        aria-label={`${label}: ${localeNames[locale]}`}
        className="flex h-9 cursor-pointer list-none items-center gap-1.5 rounded-lg px-2.5 transition-colors hover:bg-ink/5 [&::-webkit-details-marker]:hidden"
      >
        <Globe aria-hidden className="size-4" />
        <span className="text-xs font-medium uppercase">{locale}</span>
      </summary>
      <ul className="absolute right-0 mt-2 w-44 rounded-2xl border border-line bg-white p-1.5 shadow-lg shadow-ink/10">
        {locales.map((l) => (
          <li key={l}>
            <a
              href={localePath(l)}
              hrefLang={l}
              lang={l}
              aria-current={l === locale ? "page" : undefined}
              className="flex items-center justify-between rounded-xl px-3 py-2 text-ink-muted transition-colors hover:bg-ink/5 hover:text-ink aria-[current=page]:font-medium aria-[current=page]:text-ink"
            >
              {localeNames[l]}
              <span className="text-xs uppercase">{l}</span>
            </a>
          </li>
        ))}
      </ul>
    </details>
  );
}
