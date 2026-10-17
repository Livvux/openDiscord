import type { ReactNode } from "react";
import { Hanken_Grotesk } from "next/font/google";

const sans = Hanken_Grotesk({ variable: "--font-marketing", subsets: ["latin", "latin-ext"] });

/** Light surface for every public page: the landing page, legal documents and funding. */
export function MarketingShell({ lang, children }: { lang?: string; children: ReactNode }) {
  return (
    <div
      lang={lang}
      className={`${sans.variable} flex flex-1 flex-col bg-canvas font-[family-name:var(--font-marketing)] text-ink antialiased selection:bg-ink selection:text-canvas`}
    >
      {children}
    </div>
  );
}
