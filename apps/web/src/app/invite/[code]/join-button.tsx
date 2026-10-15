"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { acceptInvite } from "@/app/app/actions";
import { Button } from "@/components/ui/button";

export function JoinButton({ code }: { code: string }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  return (
    <div className="grid gap-2">
      <Button
        size="lg"
        disabled={pending}
        onClick={() =>
          startTransition(async () => {
            const result = await acceptInvite(code);
            if (!result.ok) return setError(result.error);
            router.push(`/app/c/${result.data}`);
            router.refresh();
          })
        }
      >
        {pending ? "Joining…" : "Accept invite"}
      </Button>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    </div>
  );
}
