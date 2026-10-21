import type { Metadata } from "next";
import Link from "next/link";
import { Logo } from "@/components/logo";
import { Footer } from "@/components/marketing/footer";
import { MarketingShell } from "@/components/marketing/shell";
import { button, container, size } from "@/components/marketing/ui";
import { GITHUB_URL } from "@/lib/site";

const description = "Choose hosted openDiscord or self-host community chat. Understand free software, alpha access, server costs, LiveKit voice, backups and operator responsibilities.";
export const metadata: Metadata = {
  title: "Hosting and costs",
  description,
  alternates: { canonical: "/hosting" },
  openGraph: { title: "openDiscord hosting and costs", description, url: "/hosting" },
};

export default function HostingPage() {
  return <MarketingShell>
    <header className="border-b border-line"><div className={`${container} flex min-h-16 items-center justify-between gap-4 py-3`}><Logo tone="light" /><Link href="/discord-alternative" className="text-sm underline underline-offset-4">Compare with Discord</Link></div></header>
    <main className="mx-auto w-full max-w-3xl px-6 py-16 sm:py-24">
      <p className="text-sm text-ink-muted">Hosting decision guide · Closed alpha</p>
      <h1 className="mt-4 text-4xl font-semibold tracking-tight text-balance sm:text-6xl">Free software. Real hosting responsibilities.</h1>
      <p className="mt-6 text-lg leading-relaxed text-ink-muted">openDiscord has no software license fee under AGPL-3.0. You can request access to the official hosted instance or operate the same release on your own server. Self-hosting gives you infrastructure control and the work that comes with it.</p>
      <div className="mt-8 flex flex-wrap gap-3"><Link href="/sign-up" className={`${button.primary} ${size.lg}`}>Request alpha access</Link><a href={`${GITHUB_URL}/blob/main/docs/SELF-HOSTING.md`} className={`${button.outline} ${size.lg}`}>Read the self-hosting guide</a></div>
      <section className="mt-14 space-y-4 leading-relaxed" aria-labelledby="hosted"><h2 id="hosted" className="text-2xl font-semibold">Use opendiscord.app</h2>
        <p>Basic chat is not paywalled. During closed alpha, an administrator reviews new accounts before they can sign in. Requesting access does not guarantee immediate approval. There is no paid hosting plan offered on this page.</p>
        <p>The project accepts voluntary sponsorship. Financial support grants no moderation powers or exclusive hosted features. The <Link href="/funding" className="underline underline-offset-4">funding statement</Link> reports an operator-provided €250 monthly instance cost as of 15 October 2026. That is an operating total, not a customer price or a quote for your server.</p>
      </section>
      <section className="mt-14 space-y-4 leading-relaxed" aria-labelledby="self-host"><h2 id="self-host" className="text-2xl font-semibold">Run your own community server</h2>
        <p>The documented starting point is a Linux host with Docker Engine and Compose, a domain, and ports 80/443 available for Caddy HTTPS. PostgreSQL 18 is bundled. You do not need an account on the official instance.</p>
        <p>The self-hosting documentation describes 1 vCPU and 1 GB RAM as a starting point for small communities. This is not a voice/video capacity guarantee. Size your deployment with actual concurrent users, attachment volume and media traffic.</p>
        <p>AGPL-3.0 permits self-hosting; if you modify the software and provide it over a network, you must offer the corresponding source to its users. Review the <a href={`${GITHUB_URL}/blob/main/LICENSE`} className="underline underline-offset-4">license</a> before deployment.</p>
      </section>
      <section className="mt-14" aria-labelledby="budget"><h2 id="budget" className="text-2xl font-semibold">What belongs in your hosting budget?</h2>
        <dl className="mt-6 divide-y divide-line border-y border-line">
          {[
            ["Compute and database", "Host the web application and PostgreSQL. Allow for peak concurrency, database growth and security updates."],
            ["Domain and email", "Budget for your domain and an SMTP provider if you enable verification and password-reset email."],
            ["Storage and backups", "Account for attachments, encrypted off-host backups and storage growth. Test restoration; a backup file alone is not recovery proof."],
            ["Voice and video", "LiveKit is optional. Include media bandwidth and reachable media ports. Restrictive networks may require additional TURN configuration."],
            ["Operator time", "Someone must handle upgrades, monitoring, abuse reports, moderation and incidents. Include this work when comparing with managed services."],
          ].map(([term, detail]) => <div key={term} className="py-5"><dt className="font-semibold">{term}</dt><dd className="mt-2 leading-relaxed text-ink-muted">{detail}</dd></div>)}
        </dl>
        <p className="mt-5 leading-relaxed text-ink-muted">Monthly total = compute + storage + backup + email + media bandwidth + operator time, plus any domain cost spread over the year. Provider prices and your usage determine the amount; we have not measured a universal per-community hosting cost.</p>
      </section>
      <section className="mt-14 space-y-4 leading-relaxed" aria-labelledby="readiness"><h2 id="readiness" className="text-2xl font-semibold">Check readiness before inviting your members</h2>
        <p>1:1 and group DMs, including DM attachments, are end-to-end encrypted. Voice media uses end-to-end encryption on supported browsers. Community text and its attachments are readable by the operator. There has been no independent security or cryptographic integration audit. Avoid treating an alpha deployment as a replacement for a service with contractual support or compliance requirements.</p>
        <ul className="list-disc space-y-3 pl-6"><li>Verify email delivery, registration policy and private-channel permissions.</li><li>Test voice, camera and screen sharing with real member devices and networks.</li><li>Complete an off-host backup and isolated restore, then assign upgrade and moderation responsibilities.</li></ul>
        <p>Use the <a href={`${GITHUB_URL}/blob/main/docs/SELF-HOSTING.md`} className="underline underline-offset-4">deployment documentation</a> for commands and configuration, and the <a href={`${GITHUB_URL}/blob/main/docs/ROADMAP.md`} className="underline underline-offset-4">roadmap</a> for current limitations. Still deciding? Read our <Link href="/discord-alternative" className="underline underline-offset-4">Discord alternative comparison</Link>.</p>
      </section>
      <p className="mt-14 text-sm text-ink-muted">Written by the openDiscord project. Product and documentation reviewed on <time dateTime="2026-10-18">18 October 2026</time>.</p>
    </main><Footer />
  </MarketingShell>;
}
