"use client";

import { useState, useTransition } from "react";
import { resolveBanAppeal, submitBanAppeal } from "@/app/app/actions";
import { Button } from "@/components/ui/button";
import type { listBanAppeals } from "@/server/community-trust";

export function BanAppealForm({ communityId }: { communityId: string }) {
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  return <form className="grid gap-3" onSubmit={(e) => {
    e.preventDefault();
    const content = String(new FormData(e.currentTarget).get("content"));
    startTransition(async () => {
      const result = await submitBanAppeal(communityId, content);
      setError(result.ok ? null : result.error);
    });
  }}>
    <label className="grid gap-2">Appeal explanation<textarea name="content" required maxLength={2000} rows={4} className="w-full rounded-lg border bg-background p-3" /></label>
    <p className="text-xs text-muted-foreground">One appeal per ban, up to 2,000 characters. Community moderators with ban permission can read it. Do not include sensitive personal information.</p>
    <Button disabled={pending} className="justify-self-start">Submit ban appeal</Button>
    {error && <p role="alert" className="text-destructive">{error}</p>}
  </form>;
}

type Appeal = Awaited<ReturnType<typeof listBanAppeals>>[number];
function AppealReview({ communityId, appeal }: { communityId: string; appeal: Appeal }) {
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  return <li className="grid gap-3 p-3">
    <p className="font-medium">{appeal.name}</p>
    <p className="whitespace-pre-wrap break-words">{appeal.content}</p>
    {appeal.resolution ? <p>Resolved: {appeal.resolution === "unban" ? "ban removed" : "ban upheld"}{appeal.resolutionNote && ` — ${appeal.resolutionNote}`}</p> : <form className="grid gap-2" onSubmit={(e) => {
      e.preventDefault();
      const data = new FormData(e.currentTarget);
      const resolution = data.get("resolution") === "unban" ? "unban" : "uphold";
      startTransition(async () => {
        const result = await resolveBanAppeal(communityId, appeal.id, resolution, String(data.get("note")));
        setError(result.ok ? null : result.error);
      });
    }}>
      <label className="grid gap-1">Decision<select name="resolution" className="rounded-lg border bg-background p-2"><option value="uphold">Uphold ban</option><option value="unban">Remove ban</option></select></label>
      <label className="grid gap-1">Reply to appellant (optional)<textarea name="note" maxLength={512} rows={2} className="rounded-lg border bg-background p-2" /></label>
      <Button disabled={pending} className="justify-self-start">Resolve appeal for {appeal.name}</Button>
    </form>}
    {error && <p role="alert" className="text-destructive">{error}</p>}
  </li>;
}
export function BanAppeals({ communityId, appeals }: { communityId: string; appeals: Appeal[] }) {
  return appeals.length ? <ul className="divide-y rounded-lg border">{appeals.map((appeal) => <AppealReview key={appeal.id} communityId={communityId} appeal={appeal} />)}</ul> : <p className="text-muted-foreground">No ban appeals.</p>;
}
