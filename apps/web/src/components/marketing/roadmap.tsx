import type { Messages } from "./i18n";

export function Roadmap({ t }: { t: Messages["roadmap"] }) {
  return (
    <section id="roadmap" className="border-t border-white/[0.06]">
      <div className="mx-auto max-w-6xl px-6 py-28 sm:py-36">
        <p className="reveal text-xs font-medium tracking-[0.3em] text-brand-mint uppercase">{t.eyebrow}</p>
        <h2 className="reveal mt-5 max-w-3xl text-4xl font-semibold tracking-[-0.03em] text-balance sm:text-6xl">
          {t.titleStart} <span className="accent">{t.titleAccent}</span>
        </h2>
        <div className="relative mt-16">
        {/* The timeline rail: lit where we are, fading into what's next. */}
        <div aria-hidden className="absolute top-0 right-0 left-0 hidden h-px bg-gradient-to-r from-brand-mint via-brand-indigo/60 to-transparent md:block" />
        <ol className="grid gap-4 md:grid-cols-3">
          {t.stages.map((s, i) => {
            const active = i === 0;
            return (
              <li
                key={s.label}
                className={`reveal relative rounded-3xl border p-8 md:mt-8 ${
                  active ? "border-brand-mint/30 bg-gradient-to-b from-brand-mint/[0.07] to-transparent" : "border-white/[0.08] bg-white/[0.02]"
                }`}
              >
                <span aria-hidden className={`absolute -top-[37px] left-8 hidden size-3 rounded-full ring-4 ring-brand-charcoal md:block ${active ? "bg-brand-mint" : "bg-slate-600"}`} />
                <span
                  className={`inline-flex items-center gap-2 rounded-full px-3 py-1 text-xs font-medium ${
                    active ? "bg-brand-mint/15 text-brand-mint" : "bg-white/5 text-slate-300"
                  }`}
                >
                  {active && (
                    <span className="relative flex size-1.5">
                      <span aria-hidden className="animate-ping-soft absolute inset-0 rounded-full bg-brand-mint" />
                      <span className="relative size-1.5 rounded-full bg-brand-mint" />
                    </span>
                  )}
                  {s.label}
                </span>
                <h3 className="mt-6 text-xl font-semibold tracking-tight">{s.title}</h3>
                <ul className="mt-5 space-y-2.5 text-slate-400">
                  {s.items.map((item) => (
                    <li key={item} className="flex gap-3">
                      <span aria-hidden className={`mt-2.5 h-px w-3 shrink-0 ${active ? "bg-brand-mint" : "bg-slate-600"}`} />
                      {item}
                    </li>
                  ))}
                </ul>
              </li>
            );
          })}
        </ol>
        </div>
      </div>
    </section>
  );
}
