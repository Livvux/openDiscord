"use client";

import { CompassIcon, LinkIcon, UserPlusIcon } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useId, useState } from "react";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { CreateCommunityDialog } from "../create-community-dialog";

const INVITE_CODE = /^[A-Za-z0-9_-]{1,64}$/;

/** Accepts a full invite link or a bare code; anything else is rejected before navigating. */
export function inviteCodeFrom(value: string): string | null {
  const trimmed = value.trim();
  const code = trimmed.includes("/invite/") ? trimmed.split("/invite/").pop()!.split(/[?#/]/)[0] : trimmed;
  return INVITE_CODE.test(code) ? code : null;
}

interface GettingStartedProps {
  onAddFriend: () => void;
  /** Discover is only offered when there is something to read. */
  hasPublicChannels: boolean;
}

/** Shown on Home while someone has no friends or requests yet: the ways in, in one place. */
export function GettingStarted({ onAddFriend, hasPublicChannels }: GettingStartedProps) {
  const router = useRouter();
  const id = useId();
  const [invite, setInvite] = useState("");
  const [error, setError] = useState<string | null>(null);

  function join(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const code = inviteCodeFrom(invite);
    if (!code) return setError("Paste an invite link like https://…/invite/abc123 or just its code.");
    router.push(`/invite/${code}`);
  }

  return (
    <section aria-labelledby={`${id}-title`} className="grid gap-4 rounded-xl border border-white/10 p-5">
      <div>
        <h2 id={`${id}-title`} className="text-base font-semibold text-zinc-50">Get started</h2>
        <p className="text-sm text-muted-foreground">openDiscord is invite-based. Join people you know, or start your own community and invite them.</p>
      </div>
      <form onSubmit={join} className="grid gap-1.5">
        <Label htmlFor={`${id}-invite`} className="flex items-center gap-2"><LinkIcon aria-hidden className="size-4" />Have an invite?</Label>
        <div className="flex flex-wrap gap-2">
          <Input id={`${id}-invite`} value={invite} onChange={(e) => { setInvite(e.target.value); setError(null); }} placeholder="Invite link or code" autoComplete="off" className="min-w-0 flex-1" aria-invalid={!!error} aria-describedby={error ? `${id}-error` : undefined} />
          <Button type="submit" disabled={!invite.trim()}>Join</Button>
        </div>
        {error && <p id={`${id}-error`} role="alert" className="text-sm text-destructive">{error}</p>}
      </form>
      <div className="flex flex-wrap gap-2">
        <CreateCommunityDialog trigger="button" />
        <Button variant="outline" size="lg" onClick={onAddFriend}><UserPlusIcon aria-hidden />Add a friend</Button>
        {hasPublicChannels && (
          <Link href="/discover" className={buttonVariants({ variant: "outline", size: "lg" })}><CompassIcon aria-hidden />Browse public channels</Link>
        )}
      </div>
    </section>
  );
}
