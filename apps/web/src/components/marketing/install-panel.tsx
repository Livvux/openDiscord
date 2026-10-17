"use client";

import { useId, useState, type KeyboardEvent } from "react";

export type InstallLine = readonly [mark: string, text: string, note?: string];
export type InstallTab = { label: string; lines: readonly InstallLine[] };

export function InstallPanel({ label, tabs }: { label: string; tabs: readonly InstallTab[] }) {
  const [active, setActive] = useState(0);
  const id = useId();
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    const last = tabs.length - 1;
    const next = { ArrowRight: active === last ? 0 : active + 1, ArrowLeft: active === 0 ? last : active - 1, Home: 0, End: last }[event.key];
    if (next === undefined) return;
    event.preventDefault();
    setActive(next);
    document.getElementById(`${id}-tab-${next}`)?.focus();
  };
  return (
    <div className="rounded-2xl bg-dark p-1.5 text-canvas">
      <div role="tablist" aria-label={label} className="flex gap-1 p-1">
        {tabs.map((tab, i) => (
          <button
            key={tab.label}
            id={`${id}-tab-${i}`}
            role="tab"
            aria-selected={active === i}
            aria-controls={`${id}-panel`}
            tabIndex={active === i ? 0 : -1}
            onClick={() => setActive(i)}
            onKeyDown={onKeyDown}
            className={`rounded-lg px-3 py-1.5 text-sm transition-colors focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-canvas ${
              active === i ? "bg-dark-raised text-canvas" : "text-dark-muted hover:text-canvas"
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>
      <pre id={`${id}-panel`} role="tabpanel" aria-labelledby={`${id}-tab-${active}`} tabIndex={0} className="overflow-x-auto rounded-xl p-5 font-mono text-[13px] leading-7 focus-visible:outline-2 focus-visible:outline-canvas">
        {tabs[active].lines.map(([mark, text, note]) => (
          <div key={text}>
            <span className="text-dark-muted">{mark}</span> <span>{text}</span>
            {note && <span className="text-dark-muted">  {note}</span>}
          </div>
        ))}
      </pre>
    </div>
  );
}
