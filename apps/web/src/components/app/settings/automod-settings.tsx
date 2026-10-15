"use client";

import { useState, useTransition } from "react";
import { updateAutomod } from "@/app/app/actions";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import type { AutomodRules } from "@/server/automod";

export function AutomodSettings({ communityId, rules }: { communityId: string; rules: AutomodRules }) {
  const [blockLinks, setBlockLinks] = useState(rules.blockLinks);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [pending, startTransition] = useTransition();

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        const words = String(new FormData(e.currentTarget).get("words")).split(/[\n,]/).map((w) => w.trim()).filter(Boolean);
        startTransition(async () => {
          const result = await updateAutomod(communityId, { words, blockLinks });
          setError(result.ok ? null : result.error);
          setSaved(result.ok);
        });
      }}
      className="grid max-w-md gap-4"
    >
      <div className="grid gap-1.5">
        <Label htmlFor="automod-words">Blocked words</Label>
        <Textarea
          id="automod-words"
          name="words"
          rows={4}
          defaultValue={rules.words.join("\n")}
          aria-describedby="automod-words-help"
          onChange={() => setSaved(false)}
        />
        <p id="automod-words-help" className="text-xs text-muted-foreground">
          One per line or separated by commas, up to 100. Whole words, not case-sensitive. Members who can delete others&apos; messages are exempt.
        </p>
      </div>
      <label className="flex items-center gap-3 text-sm">
        <Switch checked={blockLinks} onCheckedChange={(v) => (setBlockLinks(v), setSaved(false))} />
        Block messages with links
      </label>
      <div className="flex items-center gap-3">
        <Button type="submit" disabled={pending}>Save AutoMod rules</Button>
        {saved && <p role="status" className="text-sm text-muted-foreground">Saved.</p>}
      </div>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    </form>
  );
}
