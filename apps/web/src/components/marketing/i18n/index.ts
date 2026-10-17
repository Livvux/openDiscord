import type { Metadata } from "next";
import { de } from "./de";
import { en, type Messages } from "./en";
import { es } from "./es";
import { fr } from "./fr";
import { pt } from "./pt";

export type { Messages };

export const locales = ["en", "de", "es", "fr", "pt"] as const;
export type Locale = (typeof locales)[number];

export const messages: Record<Locale, Messages> = { en, de, es, fr, pt };

export const localeNames: Record<Locale, string> = {
  en: "English",
  de: "Deutsch",
  es: "Español",
  fr: "Français",
  pt: "Português",
};

export function isLocale(value: string): value is Locale {
  return (locales as readonly string[]).includes(value);
}

/** English lives at `/` so existing links keep working; other languages get a path prefix. */
export function localePath(locale: Locale): string {
  return locale === "en" ? "/" : `/${locale}`;
}

export function landingMetadata(locale: Locale): Metadata {
  const { title, description } = messages[locale].meta;
  return {
    title: { absolute: title },
    description,
    alternates: {
      canonical: localePath(locale),
      languages: { ...Object.fromEntries(locales.map((l) => [l, localePath(l)])), "x-default": "/" },
    },
    openGraph: { title: "openDiscord", description, siteName: "openDiscord", locale },
  };
}
