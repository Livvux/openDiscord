"use client";

import { useState, useSyncExternalStore } from "react";
import { THEMES, applyTheme, storedTheme, type ThemeId } from "@/lib/themes";

const subscribeStorage = (onChange: () => void) => {
  window.addEventListener("storage", onChange);
  return () => window.removeEventListener("storage", onChange);
};

/** Color theme; stored per browser. */
export function ThemeSettings() {
  const stored = useSyncExternalStore(subscribeStorage, storedTheme, () => "default" as ThemeId);
  const [selected, setSelected] = useState<ThemeId | null>(null);
  const current = selected ?? stored;

  return (
    <fieldset className="grid grid-cols-2 gap-2 sm:grid-cols-5">
      <legend className="sr-only">Color theme</legend>
      {THEMES.map(({ id, name, swatch: [surface, accent] }) => (
        <label
          key={id}
          className="grid cursor-pointer gap-2 rounded-lg border p-2 text-sm has-checked:border-primary has-checked:bg-accent has-focus-visible:ring-2 has-focus-visible:ring-ring"
        >
          <input
            type="radio"
            name="theme"
            value={id}
            checked={current === id}
            onChange={() => { applyTheme(id); setSelected(id); }}
            className="sr-only"
          />
          <span aria-hidden className="flex h-10 items-end rounded-md p-1.5" style={{ background: surface }}>
            <span className="h-2 w-6 rounded-full" style={{ background: accent }} />
          </span>
          {name}
        </label>
      ))}
    </fieldset>
  );
}
