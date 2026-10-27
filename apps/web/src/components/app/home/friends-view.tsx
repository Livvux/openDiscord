"use client";

import { CheckIcon, CopyIcon, MessageCircleIcon, SearchIcon, UserMinusIcon, UsersIcon, XIcon } from "lucide-react";
import Link from "next/link";
import { useId, useState, useTransition } from "react";
import { blockUser, removeFriend, respondToFriendRequest, searchPeople, sendFriendRequest } from "@/app/app/actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { BlockedUser } from "@/server/blocks";
import type { FriendView, PersonResult } from "@/server/friends";
import { BlockedList } from "../settings/blocked-list";
import { GettingStarted } from "./getting-started";
import { PresenceAvatar } from "../presence-avatar";
import { UserContextMenu } from "../user-context-menu";
import { UserProfilePopover } from "../user-profile";
import { MobileNavToggle } from "../mobile-nav";

type Filter = "online" | "all" | "pending" | "blocked" | "add";
type Notice = { ok: boolean; text: string } | null;
const SENT: Record<"sent" | "accepted" | "already", string> = {
  sent: "Friend request sent.",
  accepted: "They had already asked you — you're now friends.",
  already: "You're already friends or have a pending request.",
};

interface FriendsViewProps {
  userId: string;
  friends: FriendView[];
  blocked: BlockedUser[];
  initialCode: string;
  hasPublicChannels?: boolean;
  /** The "Active Now" column, beside the list under the shared header. */
  aside?: React.ReactNode;
}

export function FriendsView({ userId, friends, blocked, initialCode, hasPublicChannels = false, aside }: FriendsViewProps) {
  const accepted = friends.filter((f) => f.state === "friend");
  const pending = friends.filter((f) => f.state !== "friend");
  const [filter, setFilter] = useState<Filter>(initialCode ? "add" : pending.some((f) => f.state === "incoming") ? "pending" : "all");
  const [notice, setNotice] = useState<Notice>(null);
  const [busy, startTransition] = useTransition();
  const [search, setSearch] = useState("");

  function act(fn: () => Promise<{ ok: true; data: unknown } | { ok: false; error: string }>, success?: string) {
    startTransition(async () => {
      const result = await fn();
      setNotice(result.ok ? (success ? { ok: true, text: success } : null) : { ok: false, text: result.error });
    });
  }

  const listed = filter === "pending" ? pending : filter === "online" ? accepted.filter((f) => f.presence) : accepted;
  const shown = search.trim() ? listed.filter((f) => f.name.toLowerCase().includes(search.trim().toLowerCase())) : listed;
  const tabs: { id: Filter; label: string; count: number }[] = [
    { id: "online", label: "Online", count: accepted.filter((f) => f.presence).length },
    { id: "all", label: "All", count: accepted.length },
    { id: "pending", label: "Pending", count: pending.length },
    { id: "blocked", label: "Blocked", count: blocked.length },
  ];

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex min-h-12 shrink-0 flex-wrap items-center gap-x-2 gap-y-1 border-b px-2 py-2 md:pl-4">
        <MobileNavToggle />
        <h1 className="flex items-center gap-2 text-base font-semibold"><UsersIcon aria-hidden className="size-5 text-muted-foreground" />Friends</h1>
        <span aria-hidden className="mx-1 size-1 rounded-full bg-muted-foreground/50" />
        <div role="group" aria-label="Filter friends" className="flex flex-wrap items-center gap-2">
          {tabs.map((t) => (
            <button
              key={t.id}
              type="button"
              aria-pressed={filter === t.id}
              onClick={() => setFilter(t.id)}
              className={`h-8 rounded-lg px-3 text-base font-medium focus-visible:outline-2 focus-visible:outline-ring ${filter === t.id ? "bg-white/10 text-foreground" : "text-muted-foreground hover:bg-white/[0.06] hover:text-foreground"}`}
            >
              {t.label}{t.id === "pending" && t.count > 0 ? <span className="ml-1.5 inline-block min-w-4 rounded-full bg-[#dc2626] px-1 text-center text-xs leading-4 font-bold text-white">{t.count}</span> : <span className="sr-only"> {t.count}</span>}
            </button>
          ))}
          <button
            type="button"
            aria-pressed={filter === "add"}
            onClick={() => setFilter("add")}
            className={`h-8 rounded-lg px-3 text-base font-medium focus-visible:outline-2 focus-visible:outline-ring ${filter === "add" ? "bg-primary/15 text-[#8ca0fd]" : "bg-primary text-primary-foreground hover:bg-primary/85"}`}
          >
            Add Friend
          </button>
        </div>
      </header>
      <div className="flex min-h-0 flex-1">
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="grid gap-4 px-4 pt-4 pb-6 md:px-6">
        {friends.length === 0 && (filter === "all" || filter === "online") && <GettingStarted onAddFriend={() => setFilter("add")} hasPublicChannels={hasPublicChannels} />}

        {filter === "add" ? <AddFriend userId={userId} initialCode={initialCode} /> : filter === "blocked" ? <BlockedList blocked={blocked} currentUserId={userId} /> : (
        <section aria-label="Your friends" className="grid gap-3">
          <label className="relative block">
            <span className="sr-only">Search friends</span>
            <input type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search" className="h-9 w-full rounded-lg bg-sidebar pr-9 pl-3 text-base text-foreground ring-1 ring-border outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring" />
            <SearchIcon aria-hidden className="pointer-events-none absolute top-1/2 right-3 size-4 -translate-y-1/2 text-muted-foreground" />
          </label>
          <h2 className="pt-2 text-sm font-medium text-muted-foreground">
            {tabs.find((t) => t.id === filter)!.label} — {shown.length}
          </h2>
          {notice && (
            <p role={notice.ok ? "status" : "alert"} className={`text-sm ${notice.ok ? "text-success" : "text-destructive"}`}>{notice.text}</p>
          )}
          <div>
            {shown.length === 0 ? (
              <p className="rounded-xl border border-dashed border-white/10 p-6 text-center text-sm text-muted-foreground">
                {filter === "pending" ? "No pending requests." : filter === "online" ? "No friends online right now." : "No friends yet. Choose Add Friend to find someone."}
              </p>
            ) : (
              <ul className="-mx-2.5">
                {shown.map((f) => (
                  <UserContextMenu key={f.id} userId={f.id} name={f.name} currentUserId={userId} relation={f.state} disabled={busy} onChanged={() => setNotice(null)} onError={(error) => setNotice({ ok: false, text: error })}>
                    <li className="group/friend flex h-[62px] items-center gap-3 rounded-lg border-t px-2.5 hover:border-transparent hover:bg-white/[0.06] focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring [&:hover+li]:border-transparent">
                      <UserProfilePopover userId={f.id} currentUserId={userId} render={
                        <button type="button" className="flex min-w-0 flex-1 items-center gap-3 rounded-md text-left focus-visible:outline-2 focus-visible:outline-ring">
                          <PresenceAvatar userId={f.id} name={f.name} avatar={f.avatar} status={f.presence} announce />
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-base font-semibold text-foreground">{f.name}</span>
                            <span className="block truncate text-sm text-muted-foreground">
                              {f.state === "incoming" ? "Incoming friend request" : f.state === "outgoing" ? "Outgoing friend request" : f.customStatus || f.bio || (f.presence ? "Online" : "Offline")}
                            </span>
                          </span>
                        </button>
                      } />
                      <div className="flex shrink-0 gap-2.5 [&_button]:rounded-full">
                        {f.state === "friend" && (
                          <>
                            <Link href={`/app/messages?to=${encodeURIComponent(f.id)}`} aria-label={`Message ${f.name}`} title="Message" className="grid size-9 place-items-center rounded-full bg-sidebar text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring">
                              <MessageCircleIcon className="size-5" />
                            </Link>
                            <Button variant="ghost" size="icon" className="size-9 bg-sidebar text-muted-foreground hover:text-[#dc2626]" disabled={busy} aria-label={`Remove ${f.name} as a friend`} title="Remove friend"
                              onClick={() => window.confirm(`Remove ${f.name} as a friend? They won't be notified.`) && act(() => removeFriend(f.id))}>
                              <UserMinusIcon />
                            </Button>
                          </>
                        )}
                        {f.state === "incoming" && (
                          <>
                            <Button size="sm" disabled={busy} aria-label={`Accept friend request from ${f.name}`} onClick={() => act(() => respondToFriendRequest(f.id, true), `You and ${f.name} are now friends.`)}>
                              <CheckIcon /> Accept
                            </Button>
                            <Button variant="outline" size="sm" disabled={busy} aria-label={`Decline friend request from ${f.name}`} onClick={() => act(() => respondToFriendRequest(f.id, false))}>
                              Decline
                            </Button>
                            <Button variant="ghost" size="sm" disabled={busy} aria-label={`Block ${f.name}`}
                              onClick={() => window.confirm(`Block ${f.name}? Their request is removed and they can't send another.`) && act(() => blockUser(f.id))}>
                              Block
                            </Button>
                          </>
                        )}
                        {f.state === "outgoing" && (
                          <Button variant="outline" size="sm" disabled={busy} aria-label={`Cancel friend request to ${f.name}`} onClick={() => act(() => removeFriend(f.id))}>
                            <XIcon /> Cancel
                          </Button>
                        )}
                      </div>
                    </li>
                  </UserContextMenu>
                ))}
              </ul>
            )}
          </div>
        </section>
        )}
      </div>
    </div>
      {aside}
      </div>
    </div>
  );
}

function AddFriend({ userId, initialCode }: { userId: string; initialCode: string }) {
  const id = useId();
  const [code, setCode] = useState(initialCode);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<PersonResult[] | null>(null);
  const [notice, setNotice] = useState<Notice>(null);
  const [copied, setCopied] = useState(false);
  const [busy, startTransition] = useTransition();

  function send(target: string, onSent?: (outcome: "sent" | "accepted" | "already") => void) {
    startTransition(async () => {
      const result = await sendFriendRequest(target);
      setNotice(result.ok ? { ok: true, text: SENT[result.data] } : { ok: false, text: result.error });
      if (result.ok) onSent?.(result.data);
    });
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(`${window.location.origin}/app?add=${encodeURIComponent(userId)}`);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setNotice({ ok: false, text: "Couldn't copy. Select the code and copy it manually." });
    }
  }

  function refreshResults() {
    if (query.trim().length < 2) {
      setResults(null);
      return;
    }
    startTransition(async () => {
      const result = await searchPeople(query);
      setResults(result.ok ? result.data : null);
      setNotice(result.ok ? null : { ok: false, text: result.error });
    });
  }

  return (
    <section aria-labelledby={`${id}-heading`} className="grid gap-4">
      <div>
        <h2 id={`${id}-heading`} className="text-xl font-semibold">Add Friend</h2>
        <p className="text-sm text-muted-foreground">There is no public directory. Find people from communities you share, or use a friend code they gave you.</p>
      </div>

      <form
        className="grid gap-1.5"
        onSubmit={(e) => {
          e.preventDefault();
          send(code.trim(), () => setCode(""));
        }}
      >
        <Label htmlFor={`${id}-code`}>Friend code</Label>
        <div className="flex gap-2">
          <Input id={`${id}-code`} value={code} onChange={(e) => setCode(e.target.value)} maxLength={64} autoComplete="off" spellCheck={false} placeholder="Paste a friend code" />
          <Button type="submit" disabled={busy || !code.trim()}>Send request</Button>
        </div>
      </form>

      <form
        className="grid gap-1.5"
        onSubmit={(e) => {
          e.preventDefault();
          refreshResults();
        }}
      >
        <Label htmlFor={`${id}-search`}>Search your communities</Label>
        <div className="flex gap-2">
          <Input id={`${id}-search`} type="search" value={query} onChange={(e) => setQuery(e.target.value)} minLength={2} maxLength={64} placeholder="Display name" />
          <Button type="submit" variant="outline" disabled={busy || query.trim().length < 2}><SearchIcon /> Search</Button>
        </div>
      </form>

      {notice && <p role={notice.ok ? "status" : "alert"} className={`text-sm ${notice.ok ? "text-success" : "text-destructive"}`}>{notice.text}</p>}

      {results && (
        results.length === 0 ? (
          <p role="status" className="text-sm text-muted-foreground">Nobody in your communities matches that name.</p>
        ) : (
          <ul aria-label="Search results" className="divide-y divide-white/5 rounded-lg border border-white/5">
            {results.map((p) => (
              <UserContextMenu key={p.id} userId={p.id} name={p.name} currentUserId={userId} relation={p.relation} disabled={busy} onChanged={refreshResults} onError={(error) => setNotice({ ok: false, text: error })}>
                <li className="flex items-center gap-3 px-3 py-2 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring">
                  <PresenceAvatar userId={p.id} name={p.name} avatar={p.avatar} size="sm" status={null} />
                  <span className="min-w-0 flex-1 truncate">{p.name}</span>
                  {p.relation === null || p.relation === "incoming" ? (
                    <Button size="sm" disabled={busy} aria-label={`${p.relation === "incoming" ? "Accept" : "Add friend"}: ${p.name}`}
                      onClick={() => send(p.id, (outcome) => setResults((rs) => rs?.map((r) => (r.id === p.id ? { ...r, relation: outcome === "sent" ? "outgoing" : outcome === "accepted" ? "friend" : r.relation } : r)) ?? null))}>
                      {p.relation === "incoming" ? "Accept" : "Add friend"}
                    </Button>
                  ) : (
                    <span className="text-xs text-muted-foreground">{p.relation === "friend" ? "Friends" : "Request sent"}</span>
                  )}
                </li>
              </UserContextMenu>
            ))}
          </ul>
        )
      )}

      <div className="flex flex-wrap items-center gap-2 border-t border-white/5 pt-3 text-sm">
        <span className="text-muted-foreground">Your friend code:</span>
        <code className="rounded bg-white/5 px-1.5 py-0.5 text-xs break-all">{userId}</code>
        <Button variant="ghost" size="sm" onClick={() => void copy()} aria-label={copied ? "Copied your friend link" : "Copy link to add you as a friend"}>
          {copied ? <CheckIcon /> : <CopyIcon />} {copied ? "Copied" : "Copy link"}
        </Button>
      </div>
    </section>
  );
}
