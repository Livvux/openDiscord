const stages = [
  {
    label: "Now",
    title: "Closed alpha",
    items: ["Private channels, roles, moderation", "Mentions, threads, search, reactions", "Voice, video and screen sharing", "Bots, webhooks, public API", "Encrypted DMs with device verification", "Appeals, rules and retention controls"],
    active: true,
  },
  {
    label: "Next",
    title: "Closer together",
    items: ["Voice encryption and TURN", "Independent security review", "Physical-device acceptance", "Self-hosting polish"],
  },
  {
    label: "Later",
    title: "Voice and beyond",
    items: ["Custom emoji and stickers", "Native apps", "Opt-in public channels", "Community discovery"],
  },
];

export function Roadmap() {
  return (
    <section id="roadmap" className="bg-brand-surface text-brand-charcoal">
      <div className="mx-auto max-w-6xl px-6 py-28">
        <p className="reveal text-xs font-medium tracking-[0.3em] text-slate-500 uppercase">Built in the open</p>
        <h2 className="reveal mt-4 max-w-2xl text-4xl font-semibold tracking-tight text-balance sm:text-5xl">
          Small first release. Public roadmap.
        </h2>
        <ol className="mt-14 grid gap-4 md:grid-cols-3">
          {stages.map((s) => (
            <li
              key={s.label}
              className={`reveal rounded-3xl border p-8 ${
                s.active ? "border-brand-indigo/30 bg-white" : "border-brand-mist bg-white/60"
              }`}
            >
              <span
                className={`inline-flex items-center gap-2 rounded-full px-3 py-1 text-xs font-medium ${
                  s.active ? "bg-brand-online/15 text-emerald-700" : "bg-brand-mist text-slate-600"
                }`}
              >
                {s.active && <span className="size-1.5 rounded-full bg-brand-online" />}
                {s.label}
              </span>
              <h3 className="mt-6 text-xl font-semibold">{s.title}</h3>
              <ul className="mt-4 space-y-2 text-slate-600">
                {s.items.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}
