import { Features } from "./features";
import { Footer } from "./footer";
import { Hero } from "./hero";
import { messages, type Locale } from "./i18n";
import { Nav } from "./nav";
import { Roadmap } from "./roadmap";
import { SelfHost } from "./self-host";
import { MarketingShell } from "./shell";

export function Landing({ locale }: { locale: Locale }) {
  const t = messages[locale];
  return (
    <MarketingShell lang={locale}>
      <Nav t={t.nav} locale={locale} />
      <main>
        <Hero t={t} />
        <Features t={t} />
        <SelfHost t={t.selfHost} />
        <Roadmap t={t.roadmap} />
      </main>
      <Footer t={t.footer} locale={locale} />
    </MarketingShell>
  );
}
