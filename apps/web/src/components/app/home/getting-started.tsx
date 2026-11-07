"use client";

import { CompassIcon, LinkIcon, UserPlusIcon } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useId, useState } from "react";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useMessages } from "@/lib/i18n/client";
import { CreateCommunityDialog } from "../create-community-dialog";

const INVITE_CODE = /^[A-Za-z0-9_-]{1,64}$/;

/** Accepts a full invite link or a bare code; anything else is rejected before navigating. */
export function inviteCodeFrom(value: string): string | null {
  const trimmed = value.trim();
  const code = trimmed.includes("/invite/") ? trimmed.split("/invite/").pop()!.split(/[?#/]/)[0] : trimmed;
  return INVITE_CODE.test(code) ? code : null;
}

interface GettingStartedProps {
  /** Hidden when absent: the onboarding has its own invite step. */
  onAddFriend?: () => void;
  /** Discover is only offered when there is something to read. */
  hasPublicChannels: boolean;
  /** Id of an outer heading that already names this section; drops the own title. */
  labelledBy?: string;
}

/** Shown on Home while someone has no friends or requests yet: the ways in, in one place. */
export function GettingStarted({ onAddFriend, hasPublicChannels, labelledBy }: GettingStartedProps) {
  const t = useMessages().getStarted;
  const router = useRouter();
  const id = useId();
  const [invite, setInvite] = useState("");
  const [error, setError] = useState<string | null>(null);

  function join(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const code = inviteCodeFrom(invite);
    if (!code) return setError(t.badInvite);
    router.push(`/invite/${code}`);
  }

  return (
    <section aria-labelledby={labelledBy ?? `${id}-title`} className="grid gap-4 rounded-xl border border-white/10 p-5">
      {!labelledBy && <h2 id={`${id}-title`} className="text-base font-semibold text-zinc-50">{t.title}</h2>}
      <form onSubmit={join} className="grid gap-1.5">
        <Label htmlFor={`${id}-invite`} className="flex items-center gap-2"><LinkIcon aria-hidden className="size-4" />{t.haveInvite}</Label>
        <div className="flex flex-wrap gap-2">
          <Input id={`${id}-invite`} value={invite} onChange={(e) => { setInvite(e.target.value); setError(null); }} placeholder={t.invitePlaceholder} autoComplete="off" className="min-w-0 flex-1" aria-invalid={!!error} aria-describedby={error ? `${id}-error` : undefined} />
          <Button type="submit" disabled={!invite.trim()}>{t.join}</Button>
        </div>
        {error && <p id={`${id}-error`} role="alert" className="text-sm text-destructive">{error}</p>}
      </form>
      <div className="flex flex-wrap gap-2">
        <CreateCommunityDialog trigger="button" />
        {onAddFriend && <Button variant="outline" size="lg" onClick={onAddFriend}><UserPlusIcon aria-hidden />{t.addFriend}</Button>}
        {hasPublicChannels && (
          <Link href="/app/discover" className={buttonVariants({ variant: "outline", size: "lg" })}><CompassIcon aria-hidden />{t.discover}</Link>
        )}
      </div>
    </section>
  );
}
