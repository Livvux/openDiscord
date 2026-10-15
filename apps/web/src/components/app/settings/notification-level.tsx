"use client";

import { useState, useTransition } from "react";
import { setNotificationLevel } from "@/app/app/actions";

const OPTIONS = [
  { value: "mentions", label: "Mentions", help: "Badges for mentions, unread markers, and desktop notifications if you enabled them." },
  { value: "muted", label: "Muted", help: "Mention badges only: no unread marker and no desktop notifications." },
] as const;

export function NotificationLevel({ communityId, level }: { communityId: string; level: "mentions" | "muted" }) {
  const [current, setCurrent] = useState(level);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [pending, startTransition] = useTransition();
  return (
    <fieldset className="grid gap-2" disabled={pending}>
      <legend className="sr-only">Notifications for this community</legend>
      {OPTIONS.map((o) => (
        <label key={o.value} className="flex items-start gap-2 text-sm">
          <input
            type="radio"
            name="notification-level"
            value={o.value}
            checked={current === o.value}
            onChange={() => {
              const previous = current;
              setCurrent(o.value);
              setSaved(false);
              startTransition(async () => {
                const result = await setNotificationLevel(communityId, o.value);
                if (!result.ok) setCurrent(previous);
                setError(result.ok ? null : result.error);
                setSaved(result.ok);
              });
            }}
            className="mt-1"
          />
          <span>
            <span className="font-medium">{o.label}</span>
            <span className="block text-xs text-muted-foreground">{o.help}</span>
          </span>
        </label>
      ))}
      {saved && <p role="status" className="text-sm text-muted-foreground">Saved.</p>}
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    </fieldset>
  );
}
