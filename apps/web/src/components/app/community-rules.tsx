"use client";

import { useState, useTransition } from "react";
import { acknowledgeCommunityRules, updateCommunityRules } from "@/app/app/actions";
import { Button } from "@/components/ui/button";
import type { getCommunityRules } from "@/server/community-trust";

type Rules = Awaited<ReturnType<typeof getCommunityRules>>;

export function CommunityRules({ communityId, rules, canManage = false }: { communityId: string; rules: Rules; canManage?: boolean }) {
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [pending, startTransition] = useTransition();
  return <div className="grid gap-3">
    {canManage ? <form className="grid gap-3" onSubmit={(e) => {
      e.preventDefault();
      setSaved(false);
      const data = new FormData(e.currentTarget);
      startTransition(async () => {
        const result = await updateCommunityRules(communityId, { text: String(data.get("rules")), required: data.get("required") === "on" });
        setError(result.ok ? null : result.error);
        setSaved(result.ok);
      });
    }}>
      <label className="grid gap-2">Community rules
        <textarea name="rules" defaultValue={rules.text} maxLength={4000} rows={6} className="w-full rounded-lg border bg-background p-3" />
      </label>
      <p className="text-xs text-muted-foreground">Plain text, up to 4,000 characters. These are community participation rules. Saving changes asks members to acknowledge the new version when required.</p>
      <label className="flex items-center gap-2"><input name="required" type="checkbox" defaultChecked={rules.required} />Require acknowledgement before joining or sending messages</label>
      <Button className="justify-self-start" disabled={pending}>Save community rules</Button>
      {saved && <p role="status">Rules saved.</p>}
    </form> : <p className="whitespace-pre-wrap break-words text-sm">{rules.text || "This community has not published rules."}</p>}
    {!rules.accepted && rules.text && <div className="grid justify-items-start gap-2">
      {canManage && <p className="whitespace-pre-wrap break-words">{rules.text}</p>}
      <p className="text-sm text-muted-foreground">{rules.required ? "Acknowledge these rules before sending messages." : "You can acknowledge these community rules."}</p>
      <Button disabled={pending} onClick={() => startTransition(async () => {
        const result = await acknowledgeCommunityRules(communityId, rules.version);
        setError(result.ok ? null : result.error);
      })}>I acknowledge the community rules</Button>
    </div>}
    {rules.accepted && rules.text && <p className="text-xs text-muted-foreground">You acknowledged version {rules.version}.</p>}
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
  </div>;
}
