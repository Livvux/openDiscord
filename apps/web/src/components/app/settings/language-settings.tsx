"use client";

import { useState, useTransition } from "react";
import { setLocale } from "@/app/app/actions";
import { APP_LOCALES, appLocaleNames } from "@/lib/i18n";
import { useLocale, useMessages } from "@/lib/i18n/client";

export function LanguageSettings() {
  const current = useLocale();
  const t = useMessages();
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  return (
    <div className="grid max-w-xs gap-2">
      <select
        aria-label={t.settings.language}
        value={current}
        disabled={pending}
        onChange={(e) => {
          const locale = e.target.value;
          startTransition(async () => {
            const result = await setLocale(locale);
            setError(result.ok ? null : result.error);
          });
        }}
        className="h-9 rounded-lg border bg-background px-3 text-sm focus-visible:outline-2 focus-visible:outline-ring"
      >
        {APP_LOCALES.map((l) => <option key={l} value={l} lang={l}>{appLocaleNames[l]}</option>)}
      </select>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    </div>
  );
}
