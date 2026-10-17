"use client";

import { useState } from "react";

export type InstallLine = readonly [mark: string, text: string, note?: string];
export type InstallTab = { label: string; lines: readonly InstallLine[] };

export function InstallPanel({ label, tabs }: { label: string; tabs: readonly InstallTab[] }) {
  const [active, setActive] = useState(0);
  return (
    <div className="rounded-2xl border border-white/10 bg-black/50 p-1.5 shadow-2xl shadow-black/40 backdrop-blur-xl">
      <div role="tablist" aria-label={label} className="flex gap-1 p-1">
        {tabs.map((tab, i) => (
          <button
            key={tab.label}
            role="tab"
            aria-selected={active === i}
            onClick={() => setActive(i)}
            className={`rounded-lg px-3 py-1.5 text-sm transition ${
              active === i ? "bg-white/10 text-white" : "text-zinc-400 hover:text-zinc-200"
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>
      <pre role="tabpanel" tabIndex={0} className="overflow-x-auto rounded-xl bg-brand-charcoal p-5 font-mono text-[13px] leading-7">
        {tabs[active].lines.map(([mark, text, note]) => (
          <div key={text}>
            <span className={mark === "✓" ? "text-brand-mint" : "text-brand-cyan"}>{mark}</span>{" "}
            <span className="text-zinc-200">{text}</span>
            {note && <span className="text-zinc-400">  {note}</span>}
          </div>
        ))}
      </pre>
    </div>
  );
}
