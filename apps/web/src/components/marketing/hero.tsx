import Link from "next/link";
import { GITHUB_URL } from "@/lib/site";
import { AppMockup } from "./app-mockup";
import { InstallPanel } from "./install-panel";

export function Hero() {
  return (
    <section className="relative isolate overflow-hidden">
      {/* Brand motif: two overlapping open rings, solid colours only */}
      <div aria-hidden className="absolute top-16 right-[-8rem] -z-10 hidden lg:block">
        <div className="size-[34rem] rounded-full border-[56px] border-brand-indigo/15" />
        <div className="absolute top-40 -left-56 size-[34rem] rounded-full border-[56px] border-brand-mint/10" />
      </div>
      <div
        aria-hidden
        className="absolute inset-0 -z-10 bg-[radial-gradient(rgba(255,255,255,0.08)_1px,transparent_1px)] [background-size:22px_22px]"
      />

      <div className="mx-auto grid max-w-6xl items-center gap-12 px-6 pt-20 pb-28 grid-cols-[minmax(0,1fr)] lg:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)] lg:pt-28">
        <div>
          <a
            href={GITHUB_URL}
            className="animate-rise inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/5 py-1 pr-3 pl-1 text-sm text-slate-300 backdrop-blur transition hover:border-white/20"
          >
            <span className="rounded-full bg-brand-mint/15 px-2 py-0.5 text-xs font-medium text-brand-mint">AGPL-3.0</span>
            Open source, read every line <span aria-hidden>→</span>
          </a>
          <h1 className="animate-rise mt-6 text-5xl font-semibold tracking-tight text-balance [animation-delay:80ms] sm:text-6xl lg:text-7xl">
            Communities belong to{" "}
            <span className="text-brand-mint">
              everyone.
            </span>
          </h1>
          <p className="animate-rise mt-6 max-w-xl text-lg leading-relaxed text-slate-300 [animation-delay:160ms]">
            openDiscord is an open-source community platform. Chat on opendiscord.app, or run the exact same release on
            your own server. No lock-in, and basic chat is never behind a paywall.
          </p>
          <div className="animate-rise mt-9 flex flex-wrap gap-3 [animation-delay:240ms]">
            <Link
              href="/sign-up"
              className="group rounded-full bg-white px-6 py-3 font-medium text-brand-charcoal transition hover:bg-brand-mist"
            >
              Start a community{" "}
              <span aria-hidden className="inline-block transition group-hover:translate-x-0.5">
                →
              </span>
            </Link>
            <a href="#self-host" className="rounded-full border border-white/15 bg-white/5 px-6 py-3 font-medium backdrop-blur transition hover:bg-white/10">
              Self-host it
            </a>
          </div>
        </div>
        <div className="animate-rise [animation-delay:320ms]">
          <InstallPanel />
        </div>
      </div>

      {/* qoder-style product stage: the client floats across the dark/light seam */}
      <div className="relative">
        <div aria-hidden className="absolute inset-x-0 top-1/2 bottom-0 bg-brand-surface" />
        <svg aria-hidden viewBox="0 0 1440 400" preserveAspectRatio="none" className="absolute inset-x-0 top-1/3 h-2/3 w-full opacity-70">
          <path d="M-40 380 C 300 120, 620 360, 900 160 S 1300 40, 1500 120" fill="none" stroke="#49DDC0" strokeWidth="26" strokeLinecap="round" opacity=".35" />
          <path d="M-40 300 C 260 40, 700 300, 1000 80 S 1350 20, 1500 60" fill="none" stroke="#6366F1" strokeWidth="18" strokeLinecap="round" opacity=".35" />
        </svg>
        <div className="animate-rise relative mx-auto max-w-5xl px-6 [animation-delay:420ms]">
          <AppMockup />
        </div>
      </div>
    </section>
  );
}
