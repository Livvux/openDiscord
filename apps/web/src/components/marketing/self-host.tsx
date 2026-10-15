const services = [
  ["postgres", "Source of truth for every message"],
  ["migrate", "Applies schema changes, then exits"],
  ["web", "Next.js app, API and auth"],
  ["caddy", "Automatic HTTPS for your domain"],
] as const;

const principles = [
  ["No dependency on us", "A self-hosted instance never calls home: no shared login, no payment account, no Cloudflare required."],
  ["Same core everywhere", "opendiscord.app runs the public release. Hosting is a convenience, not a feature gate."],
  ["Money can't buy mod powers", "Sponsorship funds development and servers. It never grants rights inside a community."],
] as const;

export function SelfHost() {
  return (
    <section id="self-host" className="bg-white text-brand-charcoal">
      <div className="mx-auto grid max-w-6xl gap-12 px-6 py-28 lg:grid-cols-2">
        <div className="reveal">
          <p className="text-xs font-medium tracking-[0.3em] text-slate-500 uppercase">Self-host</p>
          <h2 className="mt-4 text-4xl font-semibold tracking-tight text-balance sm:text-5xl">
            One compose file. Your server. Your rules.
          </h2>
          <p className="mt-6 max-w-lg text-lg leading-relaxed text-slate-600">
            The official instance and your instance run the same image. Point a domain at a small VPS, set two secrets
            and you have a community server with backups you control.
          </p>
          <ul className="mt-10 space-y-6">
            {principles.map(([title, body]) => (
              <li key={title} className="flex gap-4">
                <span aria-hidden className="mt-2 size-2 shrink-0 rounded-full bg-brand-mint" />
                <div>
                  <p className="font-semibold">{title}</p>
                  <p className="mt-1 text-slate-600">{body}</p>
                </div>
              </li>
            ))}
          </ul>
        </div>

        <div className="reveal relative self-center overflow-hidden rounded-3xl bg-brand-charcoal p-8 text-white">
          <div aria-hidden className="absolute -top-20 -right-20 size-56 rounded-full border-[28px] border-brand-indigo/40" />
          <div aria-hidden className="absolute -bottom-20 -left-12 size-44 rounded-full border-[22px] border-brand-mint/30" />
          <p className="relative font-mono text-sm text-slate-400">docker-compose.yml</p>
          <ul className="relative mt-6 space-y-3">
            {services.map(([name, desc]) => (
              <li key={name} className="flex items-center gap-4 rounded-2xl border border-white/10 bg-white/5 px-5 py-4 backdrop-blur">
                <span className="size-2 rounded-full bg-brand-online" />
                <span className="font-mono text-sm">{name}</span>
                <span className="ml-auto text-right text-sm text-slate-400">{desc}</span>
              </li>
            ))}
          </ul>
          <p className="relative mt-6 font-mono text-sm text-brand-mint">$ docker compose up -d</p>
        </div>
      </div>
    </section>
  );
}
