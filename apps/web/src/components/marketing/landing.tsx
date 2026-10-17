import { Instrument_Serif } from "next/font/google";
import { Features } from "./features";
import { Footer } from "./footer";
import { Hero } from "./hero";
import { messages, type Locale } from "./i18n";
import { Nav } from "./nav";
import { Roadmap } from "./roadmap";
import { SelfHost } from "./self-host";

// Accent face for the italic words in headlines only; body and UI stay Inter per the brand guide.
const serif = Instrument_Serif({ variable: "--font-serif", subsets: ["latin", "latin-ext"], weight: "400", style: "italic" });

export function Landing({ locale }: { locale: Locale }) {
  const t = messages[locale];
  return (
    <div lang={locale} className={`${serif.variable} flex flex-1 flex-col`}>
      <Nav t={t.nav} locale={locale} />
      <main>
        <Hero t={t} />
        <Features t={t} />
        <SelfHost t={t.selfHost} />
        <Roadmap t={t.roadmap} />
      </main>
      <Footer t={t.footer} locale={locale} />
    </div>
  );
}
