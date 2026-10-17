import { Globe } from "lucide-react";
import { localeNames, localePath, locales, type Locale } from "./i18n";

/** A disclosure instead of a client-side menu: works without JavaScript and every option is a real link. */
export function LanguageSwitcher({ locale, label }: { locale: Locale; label: string }) {
  return (
    <details className="group relative">
      <summary
        aria-label={`${label}: ${localeNames[locale]}`}
        className="flex cursor-pointer list-none items-center gap-1.5 rounded-full px-3 py-1.5 text-slate-300 transition hover:bg-white/5 hover:text-white [&::-webkit-details-marker]:hidden"
      >
        <Globe aria-hidden className="size-4" />
        <span className="font-mono text-xs uppercase">{locale}</span>
      </summary>
      <ul className="absolute right-0 mt-2 w-44 rounded-2xl border border-white/10 bg-brand-charcoal/95 p-1.5 shadow-2xl shadow-black/50 backdrop-blur-xl">
        {locales.map((l) => (
          <li key={l}>
            <a
              href={localePath(l)}
              hrefLang={l}
              lang={l}
              aria-current={l === locale ? "page" : undefined}
              className="flex items-center justify-between rounded-xl px-3 py-2 text-slate-300 transition hover:bg-white/5 hover:text-white aria-[current=page]:text-white"
            >
              {localeNames[l]}
              <span className="font-mono text-xs text-slate-400 uppercase">{l}</span>
            </a>
          </li>
        ))}
      </ul>
    </details>
  );
}
