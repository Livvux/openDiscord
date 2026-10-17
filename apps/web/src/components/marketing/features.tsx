import type { ReactNode } from "react";
import { Database, Download, Link2, Lock, LockOpen, ShieldCheck, Users } from "lucide-react";
import type { Messages } from "./i18n";

function Card({ title, body, className = "", children }: { title: string; body: string; className?: string; children: ReactNode }) {
  return (
    <article
      className={`reveal group relative overflow-hidden rounded-3xl border border-white/[0.08] bg-white/[0.025] p-8 transition duration-500 hover:border-white/20 hover:bg-white/[0.04] ${className}`}
    >
      <div aria-hidden className="absolute -top-24 -right-24 size-56 rounded-full bg-brand-indigo/0 blur-3xl transition duration-700 group-hover:bg-brand-indigo/25" />
      <div className="relative">{children}</div>
      <h3 className="relative mt-8 text-xl font-semibold tracking-tight">{title}</h3>
      <p className="relative mt-3 leading-relaxed text-slate-400">{body}</p>
    </article>
  );
}

function Realtime({ stages }: { stages: string[] }) {
  return (
    <div aria-hidden className="relative flex items-center justify-between gap-2 rounded-2xl border border-white/[0.06] bg-black/20 px-5 py-6">
      <svg className="absolute inset-x-12 top-1/2 h-2 w-[calc(100%-6rem)] -translate-y-1/2 overflow-visible" preserveAspectRatio="none">
        <line x1="0" x2="100%" y1="4" y2="4" stroke="url(#rt)" strokeWidth="2" strokeDasharray="4 6" />
        <defs>
          <linearGradient id="rt">
            <stop stopColor="#6366f1" />
            <stop offset="1" stopColor="#49ddc0" />
          </linearGradient>
        </defs>
      </svg>
      <span className="absolute top-1/2 left-12 size-2 -translate-y-1/2 rounded-full bg-brand-mint shadow-[0_0_12px_#49ddc0] [animation:flow-x_3s_ease-in-out_infinite]" />
      {stages.map((s, i) => (
        <span key={s} className="relative z-10 flex flex-col items-center gap-2 text-xs text-slate-300">
          <span className="grid size-11 place-items-center rounded-xl border border-white/10 bg-brand-charcoal">
            {i === 0 ? "💬" : i === 1 ? <Database className="size-5 text-indigo-300" /> : <Users className="size-5 text-brand-mint" />}
          </span>
          {s}
        </span>
      ))}
    </div>
  );
}

export function Features({ t }: { t: Messages }) {
  const f = t.features;
  return (
    <section id="features" className="relative isolate">
      <div className="relative overflow-hidden border-y border-white/[0.06] py-5 [mask-image:linear-gradient(90deg,transparent,black_12%,black_88%,transparent)]">
        <ul className="animate-marquee flex w-max gap-3" aria-label={t.marquee.label}>
          {[...t.marquee.items, ...t.marquee.items].map((item, i) => (
            <li
              key={i}
              aria-hidden={i >= t.marquee.items.length}
              className="rounded-full border border-white/10 bg-white/[0.03] px-4 py-1.5 text-sm whitespace-nowrap text-slate-300"
            >
              {item}
            </li>
          ))}
        </ul>
      </div>

      <div className="mx-auto max-w-6xl px-6 py-28 sm:py-36">
        <p className="reveal text-xs font-medium tracking-[0.3em] text-brand-mint uppercase">{f.eyebrow}</p>
        <h2 className="reveal mt-5 max-w-3xl text-4xl font-semibold tracking-[-0.03em] text-balance sm:text-6xl">
          {f.titleStart} <span className="accent">{f.titleAccent}</span>
        </h2>

        <div className="mt-16 grid gap-4 md:grid-cols-6">
          <Card title={f.realtime.title} body={f.realtime.body} className="md:col-span-4">
            <Realtime stages={f.realtime.stages} />
          </Card>

          <Card title={f.invite.title} body={f.invite.body} className="md:col-span-2">
            <div aria-hidden className="flex items-center gap-3">
              <span className="grid size-12 place-items-center rounded-2xl bg-indigo-500/15 text-indigo-300 ring-1 ring-indigo-400/30">
                <Lock className="size-5" />
              </span>
              <span className="flex items-center gap-2 rounded-xl border border-dashed border-white/15 px-3 py-2 font-mono text-xs text-slate-300">
                <Link2 className="size-3.5 text-brand-mint" />
                od.app/i/k7Qx…
              </span>
            </div>
          </Card>

          <Card title={f.moderation.title} body={f.moderation.body} className="md:col-span-2">
            <ul aria-hidden className="space-y-2 font-mono text-xs">
              {f.moderation.log.map((entry, i) => (
                <li key={entry} className="flex items-center gap-2 rounded-lg bg-black/20 px-3 py-2 text-slate-300">
                  <ShieldCheck className="size-3.5 shrink-0 text-brand-mint" />
                  <span className="text-slate-400">{["Ife", "Mara", "jonas"][i]}</span>
                  <span className="truncate">{entry}</span>
                </li>
              ))}
            </ul>
          </Card>

          <Card title={f.data.title} body={f.data.body} className="md:col-span-2">
            <span
              aria-hidden
              className="inline-flex items-center gap-2 rounded-full bg-white px-4 py-2 text-sm font-medium text-brand-charcoal shadow-[0_10px_30px_-10px_rgba(73,221,192,0.6)]"
            >
              <Download className="size-4" />
              {f.data.export}
            </span>
          </Card>

          <Card title={f.encryption.title} body={f.encryption.body} className="md:col-span-2">
            <dl className="space-y-2 text-sm">
              <div className="flex items-center justify-between gap-3 rounded-lg bg-black/20 px-3 py-2">
                <dt className="text-slate-300">{f.encryption.dms}</dt>
                <dd className="flex items-center gap-1.5 text-brand-mint">
                  <Lock aria-hidden className="size-3.5" />
                  {f.encryption.yes}
                </dd>
              </div>
              <div className="flex items-center justify-between gap-3 rounded-lg bg-black/20 px-3 py-2">
                <dt className="text-slate-300">{f.encryption.community}</dt>
                <dd className="flex items-center gap-1.5 text-slate-400">
                  <LockOpen aria-hidden className="size-3.5" />
                  {f.encryption.no}
                </dd>
              </div>
            </dl>
          </Card>
        </div>

        <dl className="reveal mt-4 grid grid-cols-2 overflow-hidden rounded-3xl border border-white/[0.08] md:grid-cols-4">
          {t.stats.map((s) => (
            <div key={s.label} className="flex flex-col-reverse gap-2 border-white/[0.08] p-8 not-last:border-r max-md:nth-2:border-r-0 max-md:nth-[-n+2]:border-b">
              <dt className="text-sm text-slate-400">{s.label}</dt>
              <dd className="text-3xl font-semibold tracking-tight sm:text-4xl">{s.value}</dd>
            </div>
          ))}
        </dl>
      </div>
    </section>
  );
}
