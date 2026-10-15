const marquee = [
  "Text channels", "Invite links", "Roles", "Private channels", "Kick & ban", "Message reports",
  "Image attachments", "Unread indicators", "Edit & delete", "Data export", "Account deletion", "Instance admin",
];

const features = [
  {
    title: "Real-time, written down first",
    body: "Every message lands in PostgreSQL before anyone sees it. Reconnects replay what you missed, so nothing acknowledged is ever lost.",
    span: "md:col-span-4",
  },
  {
    title: "Private means private",
    body: "Outsiders can't read, subscribe to or even discover private channels. That rule is enforced on the server and covered by tests.",
    span: "md:col-span-2",
  },
  {
    title: "Moderation built in",
    body: "Owner, moderator and member roles, kick and ban, message reports, upload quotas and rate limits from day one.",
    span: "md:col-span-2",
  },
  {
    title: "Your data, your call",
    body: "Export everything you've written or delete your account in a click. No dark patterns, no ad tracking.",
    span: "md:col-span-2",
  },
  {
    title: "Honest about encryption",
    body: "Version one is not end-to-end encrypted, and we won't pretend it is. Traffic is TLS, and self-hosting keeps data on your hardware.",
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
              <p className="font-mono text-xs text-slate-400">{String(i + 1).padStart(2, "0")}</p>
              <h3 className="mt-6 text-xl font-semibold">{f.title}</h3>
              <p className="mt-3 leading-relaxed text-slate-600">{f.body}</p>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}
