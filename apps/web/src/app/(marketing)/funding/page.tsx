import type { Metadata } from "next";
import Link from "next/link";
import { Logo } from "@/components/logo";
import { Footer } from "@/components/marketing/footer";
import { GITHUB_URL } from "@/lib/site";

export const metadata: Metadata = {
  title: "Funding and running costs",
  description: "The operating costs and funding goal for the hosted openDiscord instance.",
};

export default function FundingPage() {
  return <>
    <header className="border-b border-white/10">
      <div className="mx-auto flex max-w-6xl items-center justify-between gap-6 px-6 py-5">
        <Logo />
        <Link href="/" className="text-sm text-slate-300 underline underline-offset-4">Back to home</Link>
      </div>
    </header>
    <main className="mx-auto w-full max-w-3xl px-6 py-20 sm:py-28">
      <p className="text-sm font-medium text-indigo-300">Funding openDiscord</p>
      <h1 className="mt-4 text-4xl font-semibold tracking-tight sm:text-5xl">What it costs to keep us online.</h1>
      <p className="mt-6 text-lg leading-relaxed text-slate-300">The hosted instance has running costs. Publishing them helps the community understand the resources behind the service.</p>
      <section aria-labelledby="running-costs" className="mt-12 rounded-2xl border border-white/15 bg-white/5 p-6 sm:p-8">
        <h2 id="running-costs" className="text-xl font-semibold">Monthly running costs</h2>
        <p className="mt-6"><strong className="text-5xl font-semibold tracking-tight">€250</strong><span className="ml-3 text-slate-300">per month</span></p>
        <p className="mt-5 leading-relaxed text-slate-300">Total provided by the operator on <time dateTime="2026-10-15">15 October 2026</time>. A breakdown by hosting, storage and email has not been provided.</p>
      </section>
      <section aria-labelledby="funding-goal" className="mt-12">
        <h2 id="funding-goal" className="text-2xl font-semibold">Our funding goal</h2>
        <p className="mt-4 leading-relaxed text-slate-300">Cover the €250 monthly operating total so the hosted instance can continue running. Contribution income and development costs are not included in this cost statement.</p>
        <p className="mt-4 leading-relaxed text-slate-300">Community permissions follow the same rules for everyone. Financial support grants no moderation powers or exclusive hosted features.</p>
      </section>
      <section aria-labelledby="contribute" className="mt-12">
        <h2 id="contribute" className="text-2xl font-semibold">Help the project grow</h2>
        <p className="mt-4 leading-relaxed text-slate-300">Code, documentation, testing and thoughtful issue reports all help. The contribution guide explains how to get involved.</p>
        <a href={`${GITHUB_URL}/blob/main/CONTRIBUTING.md`} className="mt-6 inline-flex rounded-full bg-indigo-600 px-6 py-3 font-medium hover:bg-indigo-500">Contribute on GitHub →</a>
        <p className="mt-6 text-sm text-slate-300">Read our <a href={`${GITHUB_URL}/blob/main/GOVERNANCE.md`} className="underline underline-offset-4">governance and licensing policy</a>.</p>
      </section>
    </main>
    <Footer />
  </>;
}
