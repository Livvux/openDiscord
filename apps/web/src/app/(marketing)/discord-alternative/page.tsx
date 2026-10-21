import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { Logo } from "@/components/logo";
import { Footer } from "@/components/marketing/footer";
import { MarketingShell } from "@/components/marketing/shell";
import { button, container, size } from "@/components/marketing/ui";
import { GITHUB_URL } from "@/lib/site";

const description = "Compare openDiscord with Discord, Element and Stoat for community chat. See hosting costs, voice requirements, migration limits and closed-alpha tradeoffs.";
export const metadata: Metadata = {
  title: "Self-hosted Discord alternative",
  description,
  alternates: { canonical: "/discord-alternative" },
  openGraph: { title: "A self-hosted Discord alternative: openDiscord", description, url: "/discord-alternative" },
};

export default function DiscordAlternativePage() {
  return <MarketingShell>
    <header className="border-b border-line"><div className={`${container} flex min-h-16 items-center justify-between gap-4 py-3`}><Logo tone="light" /><Link href="/hosting" className="text-sm underline underline-offset-4">Hosting and costs</Link></div></header>
    <main className="mx-auto w-full max-w-4xl px-6 py-16 sm:py-24">
      <p className="text-sm text-ink-muted">For community owners · Closed alpha</p>
      <h1 className="mt-4 text-4xl font-semibold tracking-tight text-balance sm:text-6xl">A Discord alternative you can host yourself.</h1>
      <p className="mt-6 text-lg leading-relaxed text-ink-muted">Choose openDiscord when running community chat on infrastructure you control matters enough to maintain it. Keep Discord if your members depend on its existing apps, bots and communities. openDiscord is an early product, so pilot it with a small group before moving your community.</p>
      <div className="mt-8 flex flex-wrap gap-3"><Link href="/sign-up" className={`${button.primary} ${size.lg}`}>Request alpha access</Link><a href={`${GITHUB_URL}/blob/main/docs/SELF-HOSTING.md`} className={`${button.outline} ${size.lg}`}>Read the self-hosting guide</a></div>
      <p className="mt-4 text-sm leading-relaxed text-ink-muted">Hosted accounts require administrator approval during closed alpha. Self-hosting does not require an account on opendiscord.app.</p>

      <figure className="mt-12"><Image src="/media/demo/chat.jpg" alt="openDiscord chat interface with community channels and threaded conversations in the product demo" width={1440} height={900} className="h-auto w-full rounded-xl border border-line" /><figcaption className="mt-3 text-sm text-ink-muted">Product demo capture. See the <Link href="/#features" className="underline underline-offset-4">interactive feature tour</Link> before deciding.</figcaption></figure>

      <section className="mt-14" aria-labelledby="decision"><h2 id="decision" className="text-2xl font-semibold">Which option fits your community?</h2>
        <div className="mt-6 overflow-x-auto rounded-xl border border-line" role="region" aria-label="Community platform decision table" tabIndex={0}>
          <table className="w-full min-w-[35rem] text-left text-sm leading-relaxed"><caption className="sr-only">Platform choices and reasons to choose or investigate them</caption><thead className="bg-white"><tr><th scope="col" className="p-4">Option</th><th scope="col" className="p-4">Choose it when</th><th scope="col" className="p-4">Cost and tradeoff</th></tr></thead><tbody>
            <tr className="border-t border-line"><th scope="row" className="p-4">openDiscord</th><td className="p-4">You want source access, community channels, roles and optional LiveKit voice on your own server.</td><td className="p-4">AGPL-3.0 software with no license fee. Infrastructure and operations cost extra. Closed alpha; no independent security audit.</td></tr>
            <tr className="border-t border-line"><th scope="row" className="p-4"><a href="https://discord.com/" className="underline underline-offset-4">Discord</a></th><td className="p-4">Your members already use it and you want a managed service with an established app and integration ecosystem.</td><td className="p-4">Core chat is free; Nitro is optional. You do not operate the community service on your own infrastructure.</td></tr>
            <tr className="border-t border-line"><th scope="row" className="p-4"><a href="https://element.io/en/pricing" className="underline underline-offset-4">Element / Matrix</a></th><td className="p-4">An open federation standard or a supported enterprise deployment is central to your requirements.</td><td className="p-4">Element lists a free self-hosted Community edition for non-professional use/evaluation, and paid Enterprise plans. Check edition terms for your deployment.</td></tr>
            <tr className="border-t border-line"><th scope="row" className="p-4"><a href="https://stoat.chat/" className="underline underline-offset-4">Stoat</a></th><td className="p-4">You want another open-source community platform to evaluate, including group DMs.</td><td className="p-4">Its official site describes free self-hosting and group DMs up to 50 members. Verify the current release and client coverage against your needs.</td></tr>
          </tbody></table>
        </div>
        <p className="mt-4 text-sm leading-relaxed text-ink-muted">Written by the openDiscord project. Competitor statements checked against the linked official pages on <time dateTime="2026-10-18">18 October 2026</time>; this is a documentation comparison, not a performance benchmark. Paid amounts vary by plan and region; check the vendor before purchasing.</p>
      </section>

      <section className="mt-14 space-y-5 leading-relaxed" aria-labelledby="limits"><h2 id="limits" className="text-2xl font-semibold">What you should know before switching</h2>
        <p><strong>Encryption has boundaries.</strong> 1:1 and group DMs, including DM attachments, are end-to-end encrypted. Voice media uses end-to-end encryption on supported browsers. Community text and its attachments are readable by the operator. No independent security or cryptographic integration audit has been completed. Read the <a href={`${GITHUB_URL}/blob/main/docs/PRIVACY.md`} className="underline underline-offset-4">privacy and encryption details</a>.</p>
        <p><strong>Voice needs infrastructure.</strong> Voice, video and screen sharing require optional LiveKit configuration and reachable media ports. Test actual member devices and restrictive networks before a rollout. Our <Link href="/hosting" className="underline underline-offset-4">hosting guide and cost checklist</Link> explain the operational commitment.</p>
        <p><strong>Plan a fresh start.</strong> The documented community export/import format moves openDiscord communities between instances. It is not a Discord message-history importer. Do not assume Discord members, bot code or integrations transfer unchanged. Review the <a href={`${GITHUB_URL}/blob/main/docs/API.md`} className="underline underline-offset-4">public API and webhook documentation</a> before rebuilding integrations.</p>
        <p><strong>Check acceptance on your devices.</strong> Group DMs and DM calls are implemented; independent security review and physical-device acceptance remain open. The <a href={`${GITHUB_URL}/blob/main/docs/ROADMAP.md`} className="underline underline-offset-4">public roadmap</a> distinguishes implemented features from remaining acceptance work.</p>
      </section>
      <section className="mt-14 space-y-5 leading-relaxed" aria-labelledby="pilot"><h2 id="pilot" className="text-2xl font-semibold">Run a pilot before moving everyone</h2>
        <ol className="list-decimal space-y-3 pl-6"><li>Create a small test community and reproduce your real role and private-channel rules.</li><li>Ask members to try text, voice, screen sharing and notifications on the devices they actually use.</li><li>Test a webhook and review export/import and backup restoration before making it your primary community.</li></ol>
        <p>For a hosted pilot, <Link href="/sign-up" className="underline underline-offset-4">request access to the alpha</Link>. For a deployment you operate, <Link href="/hosting" className="underline underline-offset-4">compare hosting responsibilities and costs</Link>.</p>
      </section>
    </main><Footer />
  </MarketingShell>;
}
