"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { acceptInvite, joinDiscoverable } from "@/app/app/actions";
import { Button } from "@/components/ui/button";

/** Joins by invite `code`, or a Discover-listed `communityId`. */
export function JoinButton({ code, communityId, rulesVersion, rulesRequired }: { code?: string; communityId?: string; rulesVersion: number; rulesRequired: boolean }) {
  const router = useRouter();
  const [acknowledged, setAcknowledged] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  return (
    <div className="grid gap-2">
      {rulesRequired && <label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={acknowledged} onChange={(e) => setAcknowledged(e.target.checked)} />I acknowledge the community rules</label>}
      <Button
        size="lg"
        disabled={pending || (rulesRequired && !acknowledged)}
        onClick={() =>
          startTransition(async () => {
            const accepted = acknowledged ? rulesVersion : undefined;
            const result = communityId ? await joinDiscoverable(communityId, accepted) : await acceptInvite(code!, accepted);
            if (!result.ok) return setError(result.error);
            router.push(`/app/c/${result.data}`);
            router.refresh();
          })
        }
      >
        {pending ? "Joining…" : communityId ? "Join community" : "Accept invite"}
      </Button>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    </div>
  );
}
