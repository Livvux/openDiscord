"use client";

import { useState, useTransition } from "react";
import { updateCommunitySafety } from "@/app/app/actions";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import type { CommunitySafety } from "@/server/communities";

const AGE_LABELS: Record<number, string> = { 0: "No minimum", 1: "1 hour", 24: "1 day", 168: "1 week" };
const RAID_LABELS: Record<number, string> = { 0: "Off", 10: "10 joins in 10 minutes", 30: "30 joins in 10 minutes", 100: "100 joins in 10 minutes" };
const selectClass = "h-8 rounded-lg bg-white/5 px-2 text-sm ring-1 ring-white/10 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none";

export function SafetySettings({ communityId, safety }: { communityId: string; safety: CommunitySafety }) {
  const [paused, setPaused] = useState(safety.invitesPaused);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [pending, startTransition] = useTransition();

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        const data = new FormData(e.currentTarget);
        const minAccountAgeHours = Number(data.get("minAccountAgeHours"));
        const raidJoinLimit = Number(data.get("raidJoinLimit"));
        // Only what changed: raid protection may have paused invites since this page loaded.
        const input = {
          ...(paused !== safety.invitesPaused && { invitesPaused: paused }),
          ...(minAccountAgeHours !== safety.minAccountAgeHours && { minAccountAgeHours }),
          ...(raidJoinLimit !== safety.raidJoinLimit && { raidJoinLimit }),
        };
        startTransition(async () => {
          const result = await updateCommunitySafety(communityId, input);
          setError(result.ok ? null : result.error);
          setSaved(result.ok);
        });
      }}
      className="grid max-w-md gap-4"
    >
      <label className="flex items-center gap-3 text-sm">
        <Switch checked={paused} onCheckedChange={(v) => (setPaused(v), setSaved(false))} />
        Pause invites (nobody can join, no new links)
      </label>
      <div className="grid gap-1.5">
        <Label htmlFor="min-account-age">Minimum account age to join</Label>
        <select id="min-account-age" name="minAccountAgeHours" defaultValue={safety.minAccountAgeHours} className={selectClass}>
          {Object.entries(AGE_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor="raid-limit">Raid protection: pause invites after</Label>
        <select id="raid-limit" name="raidJoinLimit" defaultValue={safety.raidJoinLimit} className={selectClass} aria-describedby="raid-help">
          {Object.entries(RAID_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
        <p id="raid-help" className="text-xs text-muted-foreground">When reached, invites pause automatically until you resume them here.</p>
      </div>
      <div className="flex items-center gap-3">
        <Button type="submit" disabled={pending}>Save safety settings</Button>
        {saved && <p role="status" className="text-sm text-muted-foreground">Saved.</p>}
      </div>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    </form>
  );
}
