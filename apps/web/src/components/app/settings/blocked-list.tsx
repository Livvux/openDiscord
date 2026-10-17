"use client";

import { useState, useTransition } from "react";
import { unblockUser } from "@/app/app/actions";
import { Button } from "@/components/ui/button";
import type { BlockedUser } from "@/server/blocks";
import { UserContextMenu } from "../user-context-menu";

export function BlockedList({ blocked, currentUserId }: { blocked: BlockedUser[]; currentUserId: string }) {
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  if (blocked.length === 0) return <p className="text-sm text-muted-foreground">You haven&apos;t blocked anyone.</p>;
  return (
    <>
      <ul className="divide-y rounded-lg border text-sm">
        {blocked.map((b) => (
          <UserContextMenu key={b.id} userId={b.id} name={b.name} currentUserId={currentUserId} blocked disabled={pending} onChanged={() => setError(null)} onError={setError}>
            <li className="flex items-center justify-between gap-2 px-3 py-2 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring">
              <span className="font-medium">{b.name}</span>
              <Button
                variant="outline"
                size="sm"
                disabled={pending}
                aria-label={`Unblock ${b.name}`}
                onClick={() =>
                  startTransition(async () => {
                    const result = await unblockUser(b.id);
                    setError(result.ok ? null : result.error);
                  })
                }
              >
                Unblock
              </Button>
            </li>
          </UserContextMenu>
        ))}
      </ul>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    </>
  );
}
