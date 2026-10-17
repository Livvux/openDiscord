import { FeatureTour, type TourItem } from "./feature-tour";
import type { Messages } from "./i18n";
import { container } from "./ui";

const clip = (name: string) => ({ src: `/media/demo/${name}.mp4`, poster: `/media/demo/${name}.jpg` });

export function Features({ t }: { t: Messages }) {
  const f = t.features;
  const items: TourItem[] = [
    { id: "threads", ...f.threads, ...clip("threads") },
    { id: "invite", ...f.invite, ...clip("invite") },
    { id: "moderation", ...f.moderation, ...clip("moderation") },
  ];
  return (
    <section id="features">
      <div className="mx-2 rounded-[1.75rem] bg-dark text-canvas sm:mx-3">
        <div className={`${container} py-16 sm:py-24`}>
          <h2 className="max-w-3xl text-[clamp(2rem,4.6vw,3.5rem)] leading-[1.05] font-semibold tracking-[-0.035em] text-balance">
            {f.titleStart} <span className="block text-dark-muted">{f.titleAccent}</span>
          </h2>
          <div className="mt-12 sm:mt-16">
            <FeatureTour items={items} labels={t.media} width={1440} height={900} />
          </div>
        </div>
      </div>

      <div className={`${container} py-20 sm:py-32`}>
        <h2 className="max-w-3xl text-[clamp(2rem,4.6vw,3.5rem)] leading-[1.05] font-semibold tracking-[-0.035em] text-balance">{t.marquee.label}</h2>
        <ul className="mt-8 flex max-w-4xl flex-wrap gap-x-2 gap-y-1 text-[clamp(1.25rem,2.4vw,1.75rem)] leading-snug tracking-[-0.02em] text-ink-muted">
          {t.marquee.items.map((item, i) => (
            <li key={item}>
              <span className="text-ink">{item}</span>
              {i < t.marquee.items.length - 1 && <span aria-hidden>,</span>}
            </li>
          ))}
        </ul>

        <div className="mt-20 grid gap-12 md:grid-cols-3 md:gap-10">
          <article className="border-t border-ink pt-6">
            <h3 className="text-xl font-semibold tracking-tight">{f.realtime.title}</h3>
            <p className="mt-3 leading-relaxed text-ink-muted">{f.realtime.body}</p>
          </article>
          <article className="border-t border-ink pt-6">
            <h3 className="text-xl font-semibold tracking-tight">{f.data.title}</h3>
            <p className="mt-3 leading-relaxed text-ink-muted">{f.data.body}</p>
          </article>
          <article className="border-t border-ink pt-6">
            <h3 className="text-xl font-semibold tracking-tight">{f.encryption.title}</h3>
            <p className="mt-3 leading-relaxed text-ink-muted">{f.encryption.body}</p>
            <dl className="mt-5 divide-y divide-line border-y border-line text-sm">
              <div className="flex justify-between gap-3 py-2.5">
                <dt className="text-ink-muted">{f.encryption.dms}</dt>
                <dd className="font-medium">{f.encryption.yes}</dd>
              </div>
              <div className="flex justify-between gap-3 py-2.5">
                <dt className="text-ink-muted">{f.encryption.community}</dt>
                <dd className="font-medium">{f.encryption.no}</dd>
              </div>
            </dl>
          </article>
        </div>
      </div>
    </section>
  );
}
