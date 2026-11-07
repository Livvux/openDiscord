"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { reopenOnboarding } from "@/app/app/actions";
import { Button } from "@/components/ui/button";

export function ReopenOnboarding({ communityId }: { communityId: string }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  return (
    <div className="grid gap-2">
      <Button
        variant="outline"
        className="justify-self-start"
        disabled={pending}
        onClick={() => startTransition(async () => {
          const result = await reopenOnboarding(communityId);
          if (!result.ok) return setError(result.error);
          router.push(`/app/c/${communityId}`);
          router.refresh();
        })}
      >
        Choose again
      </Button>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    </div>
  );
}
