import type { Messages } from "./i18n";

// Static, decorative rendering of the opendiscord client for the landing page.
const communities = ["oD", "🎮", "λ", "✳︎", "♪"];
const channels = [
  { name: "announcements" },
  { name: "general", active: true },
  { name: "self-hosting" },
  { name: "design" },
  { name: "moderators" },
];
const authors = [
  { who: "Mara", color: "text-amber-300", avatar: "bg-amber-400/20", time: "09:41" },
  { who: "jonas", color: "text-sky-300", avatar: "bg-sky-400/20", time: "09:42" },
  { who: "Ife", color: "text-emerald-300", avatar: "bg-emerald-400/20", time: "09:44" },
  { who: "Mara", color: "text-amber-300", avatar: "bg-amber-400/20", time: "09:45" },
];
const members = [
  { who: "Ife", online: true },
  { who: "jonas", online: true },
  { who: "Mara", online: true },
  { who: "Kai", online: false },
];

export function AppMockup({ t }: { t: Messages["mockup"] }) {
  return (
    <div
      role="img"
      aria-label={t.label}
      className="overflow-hidden rounded-[1.35rem] bg-brand-charcoal/95 backdrop-blur"
    >
      <div className="flex h-10 items-center gap-2 border-b border-white/5 px-4">
        <span className="size-3 rounded-full bg-[#ff5f57]" />
        <span className="size-3 rounded-full bg-[#febc2e]" />
        <span className="size-3 rounded-full bg-[#28c840]" />
        <span className="mx-auto rounded-md bg-white/5 px-3 py-0.5 font-mono text-xs text-zinc-400 max-sm:hidden">
          opendiscord.app/c/study-hall/general
        </span>
      </div>
      <div className="grid h-[400px] grid-cols-[64px_200px_1fr_180px] text-left text-sm max-lg:grid-cols-[64px_200px_1fr] max-md:grid-cols-[56px_1fr]">
        <nav className="flex flex-col items-center gap-3 border-r border-white/5 bg-black/30 py-4">
          {communities.map((c, i) => (
            <span
              key={c}
              className={`relative grid size-10 place-items-center rounded-2xl text-sm font-semibold ${
                i === 0 ? "rounded-xl bg-indigo-600 text-white shadow-[0_0_24px_-4px_rgba(99,102,241,0.8)]" : "bg-white/5 text-zinc-300"
              }`}
            >
              {i === 0 && <span className="absolute -left-3 h-6 w-1 rounded-r-full bg-white" />}
              {c}
            </span>
          ))}
        </nav>
        <div className="border-r border-white/5 bg-white/[0.02] p-3 max-md:hidden">
          <p className="px-2 pb-3 font-semibold text-zinc-100">{t.community}</p>
          <p className="px-2 pb-1 text-[11px] tracking-widest text-zinc-500 uppercase">{t.textChannels}</p>
          {channels.map((ch) => (
            <p
              key={ch.name}
              className={`flex items-center gap-1.5 rounded-md px-2 py-1 ${ch.active ? "bg-white/10 text-white" : "text-zinc-500"}`}
            >
              <span className="text-zinc-600">#</span>
              {ch.name}
            </p>
          ))}
        </div>
        <div className="flex min-w-0 flex-col">
          <p className="border-b border-white/5 px-5 py-3 font-medium text-zinc-200"># general</p>
          <ul className="flex-1 space-y-4 overflow-hidden px-5 py-4">
            {authors.map((m, i) => (
              <li key={i} className="flex gap-3">
                <span className={`grid size-8 shrink-0 place-items-center rounded-full text-xs ${m.avatar} ${m.color}`}>{m.who[0]}</span>
                <div className="min-w-0">
                  <p>
                    <span className={`font-medium ${m.color}`}>{m.who}</span>
                    <span className="ml-2 text-[11px] text-zinc-600">{m.time}</span>
                  </p>
                  <p className="text-zinc-300">{t.messages[i]}</p>
                  {i === 1 && (
                    <span className="mt-1.5 inline-flex items-center gap-1 rounded-full border border-indigo-400/30 bg-indigo-500/15 px-2 py-0.5 text-xs text-indigo-200">
                      🚀 4
                    </span>
                  )}
                </div>
              </li>
            ))}
          </ul>
          <p className="mx-4 mb-4 rounded-lg bg-white/5 px-4 py-2.5 text-zinc-500">
            {t.composer} <span className="ml-2 text-xs text-zinc-600">{t.typing}</span>
          </p>
        </div>
        <div className="space-y-2 border-l border-white/5 bg-white/[0.02] p-4 max-lg:hidden">
          {members.map((m) => (
            <p key={m.who} className={`flex items-center gap-2.5 ${m.online ? "text-zinc-300" : "text-zinc-600"}`}>
              <span className="relative grid size-7 place-items-center rounded-full bg-white/10 text-[11px]">
                {m.who[0]}
                <span
                  className={`absolute -right-0.5 -bottom-0.5 size-2.5 rounded-full ring-2 ring-brand-charcoal ${m.online ? "bg-brand-online" : "bg-zinc-600"}`}
                />
              </span>
              {m.who}
            </p>
          ))}
        </div>
      </div>
    </div>
  );
}
