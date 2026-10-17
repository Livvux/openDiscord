import Link from "next/link";
import Image from "next/image";
import { DemoVideo } from "./demo-video";
import type { Messages } from "./i18n";
import { button, container, size } from "./ui";

export function Hero({ t }: { t: Messages }) {
  const h = t.hero;
  return (
    <section className="pt-14 pb-16 sm:pt-24 sm:pb-24">
      <div className={`${container} text-center`}>
        <h1 className="animate-rise mx-auto max-w-4xl text-[clamp(2.75rem,7.4vw,5.5rem)] leading-[1.02] font-semibold tracking-[-0.04em] text-balance">
          {h.titleStart} {h.titleAccent}
        </h1>
        <p className="animate-rise mx-auto mt-6 max-w-xl text-lg leading-relaxed text-pretty text-ink-muted [animation-delay:80ms] sm:text-xl">
          {h.lead}
        </p>
        <div className="animate-rise mt-9 flex flex-wrap justify-center gap-3 [animation-delay:160ms]">
          <Link href="/sign-up" className={`${button.primary} ${size.lg}`}>
            {h.primary}
          </Link>
          <a href="#self-host" className={`${button.outline} ${size.lg}`}>
            {h.secondary}
          </a>
        </div>
        <ul className="animate-rise mt-7 flex flex-wrap justify-center gap-x-5 gap-y-1 text-sm text-ink-muted [animation-delay:220ms]">
          {h.trust.map((item) => (
            <li key={item} className="flex items-center gap-5 not-first:before:size-[3px] not-first:before:rounded-full not-first:before:bg-ink/40">
              {item}
            </li>
          ))}
        </ul>
      </div>

      <div className={`${container} animate-rise mt-14 [animation-delay:300ms] sm:mt-20`}>
        <DemoVideo
          src="/media/demo/chat.mp4"
          poster="/media/demo/chat.jpg"
          label={t.mockup.label}
          labels={t.media}
          width={1440}
          height={900}
          priority
        />
      </div>

      <div className="mt-10 flex justify-center">
        <a
          href="https://www.producthunt.com/products/opendiscord?embed=true&utm_source=badge-featured&utm_medium=badge&utm_campaign=badge-opendiscord"
          target="_blank"
          rel="noopener noreferrer"
          className="inline-block rounded-lg transition-opacity hover:opacity-80 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-brand-blue"
        >
          <Image
            alt="openDiscord - Open Source Communication Platform | Product Hunt"
            width={250}
            height={54}
            src="https://api.producthunt.com/widgets/embed-image/v1/featured.svg?post_id=1282282&theme=light&t=1792138859188"
            unoptimized
          />
        </a>
      </div>
    </section>
  );
}
