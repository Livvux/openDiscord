"use client";

import { BellIcon, BellOffIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { setChannelNotificationLevel } from "@/app/app/actions";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from "@/components/ui/popover";

type Level = "default" | "mentions" | "muted";

/** The viewer's own level for one channel; "default" follows the community's. */
export function ChannelNotifications({ channelId, channelName, level, communityLevel }: { channelId: string; channelName: string; level: "mentions" | "muted" | null; communityLevel: "mentions" | "muted" }) {
  const [current, setCurrent] = useState<Level>(level ?? "default");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const router = useRouter();
  const options: { value: Level; label: string }[] = [
    { value: "default", label: `Community default (${communityLevel === "muted" ? "Muted" : "Mentions"})` },
    { value: "mentions", label: "Mentions" },
    { value: "muted", label: "Muted" },
  ];
  const muted = current === "muted" || (current === "default" && communityLevel === "muted");
  return (
    <Popover>
      <PopoverTrigger render={<Button variant="ghost" size="icon" aria-label={`Notifications for #${channelName}`} />}>
        {muted ? <BellOffIcon /> : <BellIcon />}
      </PopoverTrigger>
      <PopoverContent align="end" className="w-64 gap-2 p-3">
        <PopoverTitle className="text-sm font-semibold">Notifications for #{channelName}</PopoverTitle>
        <fieldset className="grid gap-1.5" disabled={pending}>
          <legend className="sr-only">Notification level</legend>
          {options.map((o) => (
            <label key={o.value} className="flex items-center gap-2 text-sm">
              <input
                type="radio"
                name={`channel-notifications-${channelId}`}
                value={o.value}
                checked={current === o.value}
                onChange={() => {
                  const previous = current;
                  setCurrent(o.value);
                  startTransition(async () => {
                    const result = await setChannelNotificationLevel(channelId, o.value);
                    if (!result.ok) setCurrent(previous);
                    setError(result.ok ? null : result.error);
                    if (result.ok) router.refresh();
                  });
                }}
              />
              {o.label}
            </label>
          ))}
        </fieldset>
        {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
      </PopoverContent>
    </Popover>
  );
}
