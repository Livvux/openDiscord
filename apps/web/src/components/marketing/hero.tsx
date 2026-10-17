import Link from "next/link";
import Image from "next/image";
import { Check } from "lucide-react";
import { GITHUB_URL } from "@/lib/site";
import { AppMockup } from "./app-mockup";
import type { Messages } from "./i18n";

export function Hero({ t }: { t: Messages }) {
  const h = t.hero;
  return (
    <section className="relative isolate overflow-hidden">
      {/* Atmosphere: the brand's two open rings as slow-drifting light, a fading grid and grain. */}
      <div aria-hidden className="absolute inset-0 -z-10">
        <div className="animate-drift absolute top-[-14rem] left-1/2 size-[46rem] -translate-x-[78%] rounded-full border-[80px] border-brand-indigo/25 blur-3xl" />
        <div className="animate-drift absolute top-[-6rem] left-1/2 size-[40rem] -translate-x-[12%] rounded-full border-[70px] border-brand-mint/20 blur-3xl [animation-delay:-9s]" />
        <div className="absolute inset-0 bg-[linear-gradient(rgba(255,255,255,0.045)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,0.045)_1px,transparent_1px)] [mask-image:radial-gradient(ellipse_60%_55%_at_50%_30%,black,transparent)] [background-size:64px_64px]" />
        <div className="grain absolute inset-0" />
      </div>

      <div className="mx-auto max-w-5xl px-6 pt-20 text-center lg:pt-28">
        <a
          href={GITHUB_URL}
          className="animate-rise inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.04] py-1 pr-3 pl-1 text-sm text-slate-300 backdrop-blur transition hover:border-white/25 hover:text-white"
        >
          <span className="rounded-full bg-brand-mint/15 px-2 py-0.5 text-xs font-medium text-brand-mint">AGPL-3.0</span>
          {h.badge} <span aria-hidden>→</span>
        </a>
        <h1 className="animate-rise mx-auto mt-8 max-w-4xl text-5xl font-semibold tracking-[-0.035em] text-balance [animation-delay:80ms] sm:text-7xl lg:text-[5.75rem] lg:leading-[0.98]">
          {h.titleStart} <span className="accent">{h.titleAccent}</span>
        </h1>
        <p className="animate-rise mx-auto mt-7 max-w-2xl text-lg leading-relaxed text-pretty text-slate-300 [animation-delay:160ms] sm:text-xl">
          {h.lead}
        </p>
        <div className="animate-rise mt-10 flex flex-wrap justify-center gap-3 [animation-delay:240ms]">
          <Link
            href="/sign-up"
            className="group rounded-full bg-white px-7 py-3.5 font-medium text-brand-charcoal shadow-[0_10px_40px_-10px_rgba(73,221,192,0.55)] transition hover:bg-brand-mist"
          >
            {h.primary}{" "}
            <span aria-hidden className="inline-block transition group-hover:translate-x-0.5">
              →
            </span>
          </Link>
          <a
            href="#self-host"
            className="rounded-full border border-white/15 bg-white/[0.04] px-7 py-3.5 font-medium backdrop-blur transition hover:border-white/30 hover:bg-white/10"
          >
            {h.secondary}
          </a>
        </div>
        <ul className="animate-rise mt-8 flex flex-wrap justify-center gap-x-6 gap-y-2 text-sm text-slate-400 [animation-delay:300ms]">
          {h.trust.map((item) => (
            <li key={item} className="flex items-center gap-1.5">
              <Check aria-hidden className="size-4 text-brand-mint" />
              {item}
            </li>
          ))}
        </ul>
      </div>

      {/* Product stage: the client rises out of a glow and straightens as you scroll. */}
      <div className="relative mt-16 pb-24 lg:mt-20">
        <div aria-hidden className="absolute inset-x-0 top-24 mx-auto h-72 max-w-4xl rounded-full bg-brand-indigo/40 blur-[120px]" />
        <div aria-hidden className="absolute inset-x-0 top-40 mx-auto h-56 max-w-2xl rounded-full bg-brand-mint/20 blur-[100px]" />
        <div className="animate-rise relative mx-auto max-w-5xl px-4 [animation-delay:420ms] sm:px-6">
          <div className="stand-up origin-bottom">
            <div className="rounded-[1.4rem] bg-gradient-to-b from-white/20 via-white/[0.06] to-transparent p-px shadow-[0_40px_120px_-30px_rgba(0,0,0,0.9)]">
              <AppMockup t={t.mockup} />
            </div>
          </div>
        </div>
        <div aria-hidden className="pointer-events-none absolute inset-x-0 bottom-0 h-48 bg-gradient-to-b from-transparent to-brand-charcoal" />
      </div>

      <div className="flex justify-center pb-6">
        <a
          href="https://www.producthunt.com/products/opendiscord?embed=true&utm_source=badge-featured&utm_medium=badge&utm_campaign=badge-opendiscord"
          target="_blank"
          rel="noopener noreferrer"
          className="inline-block rounded-lg opacity-80 transition hover:opacity-100 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-brand-mint"
        >
          <Image
            alt="openDiscord - Open Source Communication Platform | Product Hunt"
            width={250}
            height={54}
            src="https://api.producthunt.com/widgets/embed-image/v1/featured.svg?post_id=1282282&theme=dark&t=1792138859188"
            unoptimized
          />
        </a>
      </div>
    </section>
  );
}
