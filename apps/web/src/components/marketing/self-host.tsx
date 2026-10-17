import type { Messages } from "./i18n";
import { InstallPanel, type InstallTab } from "./install-panel";
import { container } from "./ui";

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
    <section id="self-host" className="border-t border-line">
      <div className={`${container} grid grid-cols-[minmax(0,1fr)] gap-14 py-20 sm:py-32 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.05fr)] lg:gap-20`}>
        <div>
          <h2 className="text-[clamp(2rem,4.6vw,3.5rem)] leading-[1.05] font-semibold tracking-[-0.035em] text-balance">
            {t.titleStart} <span className="block text-ink-muted">{t.titleAccent}</span>
          </h2>
          <p className="mt-6 max-w-lg text-lg leading-relaxed text-ink-muted">{t.lead}</p>
          <ul className="mt-10 divide-y divide-line border-y border-line">
            {t.principles.map((p) => (
              <li key={p.title} className="py-5">
                <p className="font-semibold">{p.title}</p>
                <p className="mt-1 leading-relaxed text-ink-muted">{p.body}</p>
              </li>
            ))}
          </ul>
        </div>

        <div className="space-y-6 self-center">
          <InstallPanel label={t.panelLabel} tabs={tabs} />
          <dl className="divide-y divide-line border-y border-line">
            {t.services.map((s) => (
              <div key={s.name} className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 py-3">
                <dt className="font-mono text-sm font-medium">{s.name}</dt>
                <dd className="text-sm text-ink-muted">{s.desc}</dd>
              </div>
            ))}
          </dl>
        </div>
      </div>
    </section>
  );
}
