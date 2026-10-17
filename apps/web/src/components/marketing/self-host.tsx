import type { Messages } from "./i18n";
import { InstallPanel, type InstallTab } from "./install-panel";

export function SelfHost({ t }: { t: Messages["selfHost"] }) {
  const tabs: InstallTab[] = [
    {
      label: t.tabSelfHost,
      lines: [
        ["$", "git clone https://github.com/opendiscord/opendiscord"],
        ["$", "cp .env.example .env", t.envNote],
        ["$", "docker compose up -d"],
        ["✓", "postgres  migrate  web  caddy", t.running],
        ["→", "https://chat.your-domain.org"],
      ],
    },
    {
      label: t.tabHosted,
      lines: [
        ["1", t.hosted.account],
        ["2", t.hosted.community, t.hosted.communityNote],
        ["3", t.hosted.invite],
        ["✓", t.hosted.same, t.hosted.sameNote],
        ["→", t.hosted.move],
      ],
    },
  ];

  return (
    <section id="self-host" className="relative isolate overflow-hidden border-t border-white/[0.06]">
      <div aria-hidden className="absolute top-1/3 -right-40 -z-10 size-[36rem] rounded-full border-[64px] border-brand-indigo/15 blur-2xl" />
      <div className="mx-auto grid max-w-6xl gap-16 px-6 py-28 sm:py-36 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.05fr)]">
        <div className="reveal">
          <p className="text-xs font-medium tracking-[0.3em] text-brand-mint uppercase">{t.eyebrow}</p>
          <h2 className="mt-5 text-4xl font-semibold tracking-[-0.03em] text-balance sm:text-6xl">
            {t.titleStart} <span className="accent">{t.titleAccent}</span>
          </h2>
          <p className="mt-6 max-w-lg text-lg leading-relaxed text-slate-300">{t.lead}</p>
          <ul className="mt-12 space-y-7">
            {t.principles.map((p, i) => (
              <li key={p.title} className="flex gap-5">
                <span aria-hidden className="mt-0.5 font-mono text-sm text-slate-400">{String(i + 1).padStart(2, "0")}</span>
                <div>
                  <p className="font-semibold">{p.title}</p>
                  <p className="mt-1 leading-relaxed text-slate-400">{p.body}</p>
                </div>
              </li>
            ))}
          </ul>
        </div>

        <div className="reveal space-y-4 self-center">
          <InstallPanel label={t.panelLabel} tabs={tabs} />
          <div className="rounded-2xl border border-white/10 bg-white/[0.025] p-5">
            <p className="font-mono text-sm text-slate-400">docker-compose.yml</p>
            <ul className="mt-4 grid gap-2 sm:grid-cols-2">
              {t.services.map((s) => (
                <li key={s.name} className="rounded-xl border border-white/[0.06] bg-black/20 px-4 py-3">
                  <p className="flex items-center gap-2 font-mono text-sm">
                    <span className="relative flex size-2">
                      <span aria-hidden className="animate-ping-soft absolute inset-0 rounded-full bg-brand-online" />
                      <span className="relative size-2 rounded-full bg-brand-online" />
                    </span>
                    {s.name}
                  </p>
                  <p className="mt-1 text-sm text-slate-400">{s.desc}</p>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </div>
    </section>
  );
}
