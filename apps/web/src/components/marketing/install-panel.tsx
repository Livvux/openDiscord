"use client";

import { useState } from "react";

const tabs = {
  "Self-host": [
    ["$", "git clone https://github.com/opendiscord/opendiscord"],
    ["$", "cp .env.example .env", "# set DOMAIN + secrets"],
    ["$", "docker compose up -d"],
    ["✓", "postgres  migrate  web  caddy", "running"],
    ["→", "https://chat.your-domain.org"],
  ],
  Hosted: [
    ["1", "Create an account on opendiscord.app"],
    ["2", "Start a community", "# channels, roles, invites"],
    ["3", "Share an invite link"],
    ["✓", "Same open-source release", "no lock-in"],
    ["→", "Move to your own server any time"],
  ],
} as const;

type Tab = keyof typeof tabs;

export function InstallPanel() {
  const [tab, setTab] = useState<Tab>("Self-host");
  return (
    <div className="rounded-2xl border border-white/10 bg-black/50 p-1.5 backdrop-blur-xl">
      <div role="tablist" aria-label="Ways to run opendiscord" className="flex gap-1 p-1">
        {(Object.keys(tabs) as Tab[]).map((t) => (
          <button
            key={t}
            role="tab"
            aria-selected={tab === t}
            onClick={() => setTab(t)}
            className={`rounded-lg px-3 py-1.5 text-sm transition ${
              tab === t ? "bg-white/10 text-white" : "text-zinc-500 hover:text-zinc-300"
            }`}
          >
            {t}
          </button>
        ))}
      </div>
      <pre role="tabpanel" tabIndex={0} className="overflow-x-auto rounded-xl bg-brand-charcoal p-5 font-mono text-[13px] leading-7">
        {tabs[tab].map(([mark, text, note]) => (
          <div key={text}>
            <span className={mark === "✓" ? "text-brand-mint" : "text-brand-cyan"}>{mark}</span>{" "}
            <span className="text-zinc-200">{text}</span>
            {note && <span className="text-zinc-600">  {note}</span>}
          </div>
        ))}
      </pre>
    </div>
  );
}
