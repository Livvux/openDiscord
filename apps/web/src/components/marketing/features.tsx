const marquee = [
  "Text channels", "Invite links", "Roles", "Kick & ban", "Audit log", "Realtime updates",
  "Edit & delete", "Two-factor auth", "Passkeys", "Data export", "Account deletion", "Backups",
];

const features = [
  {
    title: "Real-time, written down first",
    body: "Every message lands in PostgreSQL before anyone sees it. After a dropped connection, the client catches up from the database.",
    span: "md:col-span-4",
  },
  {
    title: "Invite-only by default",
    body: "Outsiders can't read, subscribe to or even discover a community. That rule is enforced on the server and covered by tests.",
    span: "md:col-span-2",
  },
  {
    title: "Moderation built in",
    body: "Roles with a clear hierarchy, kick and ban with reasons, an audit log and rate limits from day one.",
    span: "md:col-span-2",
  },
  {
    title: "Your data, your call",
    body: "Export everything you've written or delete your account in a click. No dark patterns, no ad tracking.",
    span: "md:col-span-2",
  },
  {
    title: "Honest about encryption",
    body: "Direct messages are end-to-end encrypted between verified devices. Community text and voice are not. The integration has not had an independent security audit.",
    span: "md:col-span-2",
  },
];

export function Features() {
  return (
    <section id="features" className="bg-brand-surface text-brand-charcoal">
      <div className="relative overflow-hidden border-y border-brand-mist py-5">
        <ul className="animate-marquee flex w-max gap-3" aria-label="Included in the first release">
          {[...marquee, ...marquee].map((item, i) => (
            <li
              key={i}
              aria-hidden={i >= marquee.length}
              className="rounded-full border border-brand-mist bg-white px-4 py-1.5 text-sm whitespace-nowrap text-slate-600"
            >
              {item}
            </li>
          ))}
        </ul>
      </div>

      <div className="mx-auto max-w-6xl px-6 py-28">
        <p className="reveal text-xs font-medium tracking-[0.3em] text-slate-500 uppercase">Open source · Real people · Better communities</p>
        <h2 className="reveal mt-4 max-w-2xl text-4xl font-semibold tracking-tight text-balance sm:text-5xl">
          Everything a community needs. Nothing it has to rent.
        </h2>
        <div className="mt-14 grid gap-4 md:grid-cols-6">
          {features.map((f, i) => (
            <article
              key={f.title}
              className={`reveal group rounded-3xl border border-brand-mist bg-white p-8 shadow-[0_1px_0_rgba(15,23,42,0.04)] transition hover:-translate-y-0.5 hover:border-brand-indigo/40 ${f.span}`}
            >
              <p className="font-mono text-xs text-slate-500">{String(i + 1).padStart(2, "0")}</p>
              <h3 className="mt-6 text-xl font-semibold">{f.title}</h3>
              <p className="mt-3 leading-relaxed text-slate-600">{f.body}</p>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}
