"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { deleteCommunity, leaveCommunity, renameCommunity, revokeInvite, unbanMember } from "@/app/app/actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { InviteSummary } from "@/server/communities";
import type { ActionResult } from "@/server/errors";
import type { BanSummary } from "@/server/moderation";

/** Runs an action in a transition and exposes its error. */
function useAction() {
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const run = (fn: () => Promise<ActionResult<unknown>>, onOk?: () => void) =>
    startTransition(async () => {
      const result = await fn();
      if (result.ok) {
        setError(null);
        onOk?.();
      } else setError(result.error);
    });
  return { error, pending, run };
}

function ErrorText({ error }: { error: string | null }) {
  return error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null;
}

export function RenameCommunity({ communityId, name }: { communityId: string; name: string }) {
  const { error, pending, run } = useAction();
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        const value = String(new FormData(e.currentTarget).get("name"));
        run(() => renameCommunity(communityId, value));
      }}
      className="grid max-w-sm gap-2"
    >
      <Label htmlFor="community-rename">Community name</Label>
      <div className="flex gap-2">
        <Input id="community-rename" name="name" defaultValue={name} required maxLength={64} />
        <Button type="submit" disabled={pending}>Save</Button>
      </div>
      <ErrorText error={error} />
    </form>
  );
}

export function InviteList({ invites }: { invites: InviteSummary[] }) {
  const { error, pending, run } = useAction();
  if (invites.length === 0) return <p className="text-sm text-muted-foreground">No active invites.</p>;
  return (
    <>
      <ul className="divide-y rounded-lg border text-sm">
        {invites.map((i) => (
          <li key={i.code} className="flex items-center gap-3 px-3 py-2">
            <code className="min-w-0 flex-1 truncate font-mono">{i.code}</code>
            <span className="text-muted-foreground">
              {i.uses}
              {i.maxUses !== null ? ` / ${i.maxUses}` : ""} {(i.maxUses ?? i.uses) === 1 ? "use" : "uses"}
            </span>
            <span className="text-muted-foreground" suppressHydrationWarning>
              {i.expiresAt ? `expires ${i.expiresAt.toLocaleString()}` : "never expires"}
            </span>
            <Button variant="outline" size="sm" disabled={pending} onClick={() => run(() => revokeInvite(i.code))}>
              Revoke
            </Button>
          </li>
        ))}
      </ul>
      <ErrorText error={error} />
    </>
  );
}

export function BanList({ communityId, bans }: { communityId: string; bans: BanSummary[] }) {
  const { error, pending, run } = useAction();
  if (bans.length === 0) return <p className="text-sm text-muted-foreground">Nobody is banned.</p>;
  return (
    <>
      <ul className="divide-y rounded-lg border text-sm">
        {bans.map((b) => (
          <li key={b.userId} className="flex items-center gap-3 px-3 py-2">
            <span className="font-medium">{b.name}</span>
            <span className="min-w-0 flex-1 truncate text-muted-foreground">{b.reason ?? "No reason given"}</span>
            <Button variant="outline" size="sm" disabled={pending} onClick={() => run(() => unbanMember(communityId, b.userId))}>
              Unban
            </Button>
          </li>
        ))}
      </ul>
      <ErrorText error={error} />
    </>
  );
}

export function DangerZone({ communityId, name, isOwner }: { communityId: string; name: string; isOwner: boolean }) {
  const router = useRouter();
  const { error, pending, run } = useAction();
  const done = () => {
    router.push("/app");
    router.refresh();
  };
  if (!isOwner) {
    return (
      <>
        <Button
          variant="destructive"
          disabled={pending}
          onClick={() => window.confirm(`Leave ${name}?`) && run(() => leaveCommunity(communityId), done)}
        >
          Leave community
        </Button>
        <ErrorText error={error} />
      </>
    );
  }
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        run(() => deleteCommunity(communityId), done);
      }}
      className="grid max-w-sm gap-2"
    >
      <p className="text-sm text-muted-foreground">
        Deletes all channels, messages, roles and invites for everyone. This can&apos;t be undone.
      </p>
      <Label htmlFor="confirm-delete">Type the community name to confirm</Label>
      <ConfirmByName name={name} pending={pending} />
      <ErrorText error={error} />
    </form>
  );
}

function ConfirmByName({ name, pending }: { name: string; pending: boolean }) {
  const [value, setValue] = useState("");
  return (
    <div className="flex gap-2">
      <Input id="confirm-delete" value={value} onChange={(e) => setValue(e.target.value)} autoComplete="off" />
      <Button type="submit" variant="destructive" disabled={pending || value !== name}>
        Delete
      </Button>
    </div>
  );
}
