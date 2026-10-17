import type { Messages } from "./i18n";
import { container } from "./ui";

export function Roadmap({ t }: { t: Messages["roadmap"] }) {
  return (
    <section id="roadmap" className="border-t border-line">
      <div className={`${container} py-20 sm:py-32`}>
        <h2 className="max-w-3xl text-[clamp(2rem,4.6vw,3.5rem)] leading-[1.05] font-semibold tracking-[-0.035em] text-balance">
          {t.titleStart} <span className="block text-ink-muted">{t.titleAccent}</span>
        </h2>
        <ol className="mt-14 grid gap-12 md:grid-cols-3 md:gap-10">
          {t.stages.map((s, i) => (
            <li key={s.label} className={`border-t pt-6 ${i === 0 ? "border-ink" : "border-line"}`}>
              <p className="flex items-center gap-2 text-sm font-medium">
                {i === 0 && <span aria-hidden className="size-2 rounded-full bg-ink" />}
                <span className={i === 0 ? "" : "text-ink-muted"}>{s.label}</span>
              </p>
              <h3 className="mt-5 text-2xl font-semibold tracking-tight">{s.title}</h3>
              <ul className="mt-6 divide-y divide-line border-y border-line text-ink-muted">
                {s.items.map((item) => (
                  <li key={item} className="py-3">
                    {item}
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}
