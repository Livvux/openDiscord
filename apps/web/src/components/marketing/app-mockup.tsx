// Static, decorative rendering of the opendiscord client for the landing page.
const communities = ["oD", "🎮", "λ", "✳︎", "♪"];
const channels = [
  { name: "announcements" },
  { name: "general", active: true },
  { name: "self-hosting" },
  { name: "design" },
  { name: "moderators" },
];
const messages = [
  { who: "Mara", color: "text-amber-300", time: "09:41", text: "Set up our study group in an evening. Invite links did the rest." },
  { who: "jonas", color: "text-sky-300", time: "09:42", text: "Same release on my own box. docker compose up and it was running 🚀" },
  { who: "Ife", color: "text-emerald-300", time: "09:44", text: "Kick and ban reasons land in the audit log. Our mods love it." },
  { who: "Mara", color: "text-amber-300", time: "09:45", text: "And exporting my data is one click. As it should be." },
];

export function AppMockup() {
  return (
    <div
      role="img"
      aria-label="Preview of the opendiscord chat client with communities, channels and messages"
      className="overflow-hidden rounded-2xl border border-white/10 bg-brand-charcoal/95 shadow-2xl shadow-black/40 backdrop-blur"
    >
      <div className="flex h-9 items-center gap-2 border-b border-white/5 px-4">
        <span className="size-3 rounded-full bg-[#ff5f57]" />
        <span className="size-3 rounded-full bg-[#febc2e]" />
        <span className="size-3 rounded-full bg-[#28c840]" />
        <span className="ml-4 font-mono text-xs text-zinc-500">opendiscord.app/c/study-hall/general</span>
      </div>
      <div className="grid h-[380px] grid-cols-[64px_200px_1fr] text-left text-sm max-md:grid-cols-[56px_1fr]">
        <nav className="flex flex-col items-center gap-3 border-r border-white/5 bg-black/30 py-4">
          {communities.map((c, i) => (
            <span
              key={c}
              className={`grid size-10 place-items-center rounded-2xl font-display text-sm font-semibold transition ${
                i === 0 ? "rounded-xl bg-indigo-600 text-white" : "bg-white/5 text-zinc-300"
              }`}
            >
              {c}
            </span>
          ))}
        </nav>
        <div className="border-r border-white/5 bg-white/[0.02] p-3 max-md:hidden">
          <p className="px-2 pb-3 font-display font-semibold text-zinc-100">Study Hall</p>
          <p className="px-2 pb-1 text-[11px] uppercase tracking-widest text-zinc-500">Text channels</p>
          {channels.map((ch) => (
            <p
              key={ch.name}
              className={`flex items-center gap-1.5 rounded-md px-2 py-1 ${
                ch.active ? "bg-white/10 text-white" : "text-zinc-500"
              }`}
            >
              <span className="text-zinc-600">#</span>
              {ch.name}
            </p>
          ))}
        </div>
        <div className="flex min-w-0 flex-col">
          <p className="border-b border-white/5 px-5 py-3 font-medium text-zinc-200"># general</p>
          <ul className="flex-1 space-y-4 overflow-hidden px-5 py-4">
            {messages.map((m, i) => (
              <li key={i} className="flex gap-3">
                <span className="grid size-8 shrink-0 place-items-center rounded-full bg-white/10 text-xs">{m.who[0]}</span>
                <div className="min-w-0">
                  <p>
                    <span className={`font-medium ${m.color}`}>{m.who}</span>
                    <span className="ml-2 text-[11px] text-zinc-600">{m.time}</span>
                  </p>
                  <p className="text-zinc-300">{m.text}</p>
                </div>
              </li>
            ))}
          </ul>
          <p className="mx-4 mb-4 rounded-lg bg-white/5 px-4 py-2.5 text-zinc-500">
            Message #general <span className="ml-2 text-xs text-zinc-600">Ife is typing…</span>
          </p>
        </div>
      </div>
    </div>
  );
}
