"use client";

import { useState, useTransition } from "react";
import { setPresenceVisible } from "@/app/app/actions";
import { Switch } from "@/components/ui/switch";

export function PresenceSettings({ visible }: { visible: boolean }) {
  const [on, setOn] = useState(visible);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  return (
    <div className="grid gap-2">
      <label className="flex items-center gap-3 text-sm">
        <Switch
          checked={on}
          disabled={pending}
          onCheckedChange={(next) =>
            startTransition(async () => {
              const result = await setPresenceVisible(next);
              if (result.ok) setOn(next);
              setError(result.ok ? null : result.error);
            })
          }
        />
        Show members of my communities when I&apos;m online
      </label>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    </div>
  );
}
