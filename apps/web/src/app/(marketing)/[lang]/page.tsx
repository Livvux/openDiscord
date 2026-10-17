import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Landing } from "@/components/marketing/landing";
import { isLocale, landingMetadata, locales } from "@/components/marketing/i18n";

// English is served at `/`; every other locale is prerendered and unknown segments 404.
export function generateStaticParams() {
  return locales.filter((l) => l !== "en").map((lang) => ({ lang }));
}

export async function generateMetadata({ params }: PageProps<"/[lang]">): Promise<Metadata> {
  const { lang } = await params;
  return isLocale(lang) ? landingMetadata(lang) : {};
}

export default async function LocalizedHome({ params }: PageProps<"/[lang]">) {
  const { lang } = await params;
  if (!isLocale(lang) || lang === "en") notFound();
  return <Landing locale={lang} />;
}
