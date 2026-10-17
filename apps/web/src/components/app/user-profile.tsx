"use client";

import { CheckIcon, MessageSquareIcon, UserPlusIcon } from "lucide-react";
import Link from "next/link";
import { useCallback, useState, useTransition, type ComponentProps, type ReactElement } from "react";
import { getProfileCard, respondToFriendRequest, sendFriendRequest } from "@/app/app/actions";
import { buttonVariants } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from "@/components/ui/popover";
import { PRESENCE_LABEL } from "@/lib/presence";
import type { ActionResult } from "@/server/errors";
import type { ProfileCard } from "@/server/profile-card";
import { PresenceAvatar } from "./presence-avatar";

const dateFormat = new Intl.DateTimeFormat("en", { month: "short", day: "numeric", year: "numeric" });
type Loaded = { card: ProfileCard; error?: never } | { card?: never; error: string };

async function loadCard(userId: string): Promise<Loaded> {
  try {
    const result = await getProfileCard(userId);
    return result.ok ? { card: result.data } : { error: result.error };
  } catch {
    return { error: "Couldn't load this profile. Please try again." };
  }
}

/** A profile card loaded on demand; `load` (re)fetches it, e.g. when a popover opens or after a relationship change. */
export function useProfileCard(userId: string) {
  const [state, setState] = useState<Loaded | null>(null);
  const load = useCallback(() => loadCard(userId).then(setState), [userId]);
  return { state, load };
}

const section = "grid gap-1 border-t border-white/5 pt-3";
const sectionTitle = "text-[11px] font-semibold tracking-wide text-zinc-400 uppercase";

/** Discord-style profile: banner, large avatar with presence, status, about, member since, mutual communities. */
export function ProfileCardBody({ card, currentUserId, onChanged, headingLevel = "h2", title }: {
  card: ProfileCard;
  currentUserId: string;
  onChanged?: () => void;
  headingLevel?: "h2" | "h3";
  /** Popovers pass their accessible title element instead of a plain heading. */
  title?: (name: string) => ReactElement;
}) {
  const [pending, startTransition] = useTransition();
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const isSelf = card.id === currentUserId;
  const canMessage = !isSelf && !card.blocked && card.relation !== "incoming" && card.relation !== "outgoing";
  const Heading = headingLevel;

  function act(fn: () => Promise<ActionResult<unknown>>, success: string) {
    startTransition(async () => {
      try {
        const result = await fn();
        setNotice(result.ok ? { ok: true, text: success } : { ok: false, text: result.error });
        if (result.ok) onChanged?.();
      } catch {
        setNotice({ ok: false, text: "Couldn't complete that action. Please try again." });
      }
    });
  }

  return (
    <div className="grid">
      <div aria-hidden className="h-16 rounded-t-lg bg-primary/40" />
      <div className="-mt-10 grid gap-3 px-4 pb-4">
        <span className="w-fit rounded-full bg-popover p-1">
          <PresenceAvatar userId={card.id} name={card.name} size="lg" status={card.presence} />
        </span>
        <div>
          {title ? title(card.name) : <Heading className="text-lg font-semibold text-zinc-50">{card.name}</Heading>}
          <p className="text-xs text-muted-foreground">{card.presence ? PRESENCE_LABEL[card.presence] : "Offline"}{isSelf ? " · You" : ""}</p>
          {card.customStatus && <p className="mt-1 text-sm break-words text-zinc-200">{card.customStatus}</p>}
        </div>
        {card.bio && (
          <div className={section}>
            <p className={sectionTitle}>About me</p>
            <p className="text-sm break-words whitespace-pre-wrap text-zinc-200">{card.bio}</p>
          </div>
        )}
        <div className={section}>
          <p className={sectionTitle}>Member since</p>
          <p className="text-sm text-zinc-200"><time dateTime={card.memberSince}>{dateFormat.format(new Date(card.memberSince))}</time></p>
        </div>
        {card.mutualCommunities.length > 0 && (
          <div className={section}>
            <p className={sectionTitle}>Mutual communities — {card.mutualCommunities.length}</p>
            <ul className="grid gap-0.5">
              {card.mutualCommunities.map((c) => (
                <li key={c.id}><Link href={`/app/c/${c.id}`} className="block min-h-6 truncate rounded px-1 py-0.5 text-sm text-zinc-200 hover:bg-white/5 focus-visible:outline-2 focus-visible:outline-ring">{c.name}</Link></li>
              ))}
            </ul>
          </div>
        )}
        {card.blocked && <p className="text-sm text-muted-foreground">You blocked this person.</p>}
        {!isSelf && !card.blocked && (
          <div className="flex flex-wrap gap-2">
            {canMessage && (
              <Link href={`/app/messages?to=${encodeURIComponent(card.id)}`} className={buttonVariants({ className: "flex-1" })}>
                <MessageSquareIcon aria-hidden /> Message
              </Link>
            )}
            {card.relation === null && (
              <button type="button" disabled={pending} className={buttonVariants({ variant: "outline" })} onClick={() => act(() => sendFriendRequest(card.id), "Friend request sent.")}>
                <UserPlusIcon aria-hidden /> Add Friend
              </button>
            )}
            {card.relation === "incoming" && (
              <button type="button" disabled={pending} className={buttonVariants()} onClick={() => act(() => respondToFriendRequest(card.id, true), `You and ${card.name} are now friends.`)}>
                <CheckIcon aria-hidden /> Accept Friend Request
              </button>
            )}
            {card.relation === "outgoing" && <p className="text-sm text-muted-foreground">Friend request sent</p>}
          </div>
        )}
        {isSelf && <Link href="/app/settings" className={buttonVariants({ variant: "outline" })}>Edit profile</Link>}
        {notice && <p role={notice.ok ? "status" : "alert"} className={`text-sm ${notice.ok ? "text-success" : "text-destructive"}`}>{notice.text}</p>}
      </div>
    </div>
  );
}

type TriggerProps = Omit<ComponentProps<typeof PopoverTrigger>, "render"> & {
  userId: string;
  currentUserId: string;
  /** The name or avatar button that opens the card. */
  render: ReactElement;
};

/** Left click on a name or avatar opens the profile card; other trigger props (e.g. a context menu) pass through. */
export function UserProfilePopover({ userId, currentUserId, render, ...props }: TriggerProps) {
  const [open, setOpen] = useState(false);
  const { state, load } = useProfileCard(userId);
  return (
    <Popover open={open} onOpenChange={(next) => { setOpen(next); if (next) void load(); }}>
      <PopoverTrigger {...props} render={render} />
      <PopoverContent side="right" align="start" className="w-80 gap-0 overflow-hidden p-0" aria-label={state?.card ? undefined : "User profile"}>
        {!state ? (
          <p role="status" className="p-4 text-sm text-muted-foreground">Loading profile…</p>
        ) : state.card ? (
          <ProfileCardBody card={state.card} currentUserId={currentUserId} onChanged={() => void load()}
            title={(name) => <PopoverTitle className="text-lg font-semibold text-zinc-50">{name}</PopoverTitle>} />
        ) : (
          <p role="alert" className="p-4 text-sm text-destructive">{state.error}</p>
        )}
      </PopoverContent>
    </Popover>
  );
}
