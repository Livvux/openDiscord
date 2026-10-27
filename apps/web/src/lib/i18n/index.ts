import { de } from "./de";
import { en, type Messages } from "./en";

export type { Messages };

export const APP_LOCALES = ["en", "de"] as const;
export type AppLocale = (typeof APP_LOCALES)[number];
export const LOCALE_COOKIE = "locale";

export const appMessages: Record<AppLocale, Messages> = { en, de };
export const appLocaleNames: Record<AppLocale, string> = { en: "English", de: "Deutsch" };

export const isAppLocale = (value: unknown): value is AppLocale => (APP_LOCALES as readonly unknown[]).includes(value);

/** The saved choice wins; otherwise the browser's first supported language; English last. */
export function resolveLocale(saved: string | undefined, acceptLanguage: string | null): AppLocale {
  if (isAppLocale(saved)) return saved;
  for (const part of (acceptLanguage ?? "").split(",")) {
    const base = part.split(";")[0].trim().toLowerCase().split("-")[0];
    if (isAppLocale(base)) return base;
  }
  return "en";
}

/** Fills `{name}` placeholders. */
export function fmt(text: string, values: Record<string, string | number>): string {
  return text.replace(/\{(\w+)\}/g, (match, key: string) => (key in values ? String(values[key]) : match));
}
