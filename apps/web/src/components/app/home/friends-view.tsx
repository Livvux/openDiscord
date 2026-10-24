"use client";

import { CheckIcon, CopyIcon, MessageSquareIcon, SearchIcon, UserMinusIcon, XIcon } from "lucide-react";
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
}

export function FriendsView({ userId, friends, blocked, initialCode, hasPublicChannels = false }: FriendsViewProps) {
  const accepted = friends.filter((f) => f.state === "friend");
  const pending = friends.filter((f) => f.state !== "friend");
  const [filter, setFilter] = useState<Filter>(initialCode ? "add" : pending.some((f) => f.state === "incoming") ? "pending" : "all");
  const [notice, setNotice] = useState<Notice>(null);
  const [busy, startTransition] = useTransition();

  function act(fn: () => Promise<{ ok: true; data: unknown } | { ok: false; error: string }>, success?: string) {
    startTransition(async () => {
      const result = await fn();
      setNotice(result.ok ? (success ? { ok: true, text: success } : null) : { ok: false, text: result.error });
    });
  }

  const shown = filter === "pending" ? pending : filter === "online" ? accepted.filter((f) => f.presence) : accepted;
  const tabs: { id: Filter; label: string; count: number }[] = [
    { id: "online", label: "Online", count: accepted.filter((f) => f.presence).length },
    { id: "all", label: "All", count: accepted.length },
    { id: "pending", label: "Pending", count: pending.length },
    { id: "blocked", label: "Blocked", count: blocked.length },
  ];

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="grid gap-4 p-4 md:px-6">
        <div role="group" aria-label="Filter friends" className="flex flex-wrap items-center gap-1">
          {tabs.map((t) => (
            <button
              key={t.id}
              type="button"
              aria-pressed={filter === t.id}
              onClick={() => setFilter(t.id)}
              className={`min-h-8 rounded-md px-3 py-1 text-sm focus-visible:outline-2 focus-visible:outline-ring ${filter === t.id ? "bg-white/10 text-zinc-50" : "text-zinc-400 hover:bg-white/5 hover:text-zinc-100"}`}
            >
              {t.label} <span className="text-muted-foreground">{t.count}</span>
            </button>
          ))}
          <button
            type="button"
            aria-pressed={filter === "add"}
            onClick={() => setFilter("add")}
            className={`min-h-8 rounded-md px-3 py-1 text-sm font-medium focus-visible:outline-2 focus-visible:outline-ring ${filter === "add" ? "bg-transparent text-brand-mint" : "bg-emerald-700 text-white hover:bg-emerald-600"}`}
          >
            Add Friend
          </button>
        </div>

        {friends.length === 0 && (filter === "all" || filter === "online") && <GettingStarted onAddFriend={() => setFilter("add")} hasPublicChannels={hasPublicChannels} />}

        {filter === "add" ? <AddFriend userId={userId} initialCode={initialCode} /> : filter === "blocked" ? <BlockedList blocked={blocked} currentUserId={userId} /> : (
        <section aria-label="Your friends" className="grid gap-3">
          <h2 className="text-xs font-semibold tracking-widest text-zinc-400 uppercase">
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
              <ul className="divide-y divide-white/5 rounded-xl border border-white/5">
                {shown.map((f) => (
                  <UserContextMenu key={f.id} userId={f.id} name={f.name} currentUserId={userId} relation={f.state} disabled={busy} onChanged={() => setNotice(null)} onError={(error) => setNotice({ ok: false, text: error })}>
                    <li className="flex items-center gap-3 px-3 py-2.5 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring">
                      <UserProfilePopover userId={f.id} currentUserId={userId} render={
                        <button type="button" className="flex min-w-0 flex-1 items-center gap-3 rounded-md text-left focus-visible:outline-2 focus-visible:outline-ring">
                          <PresenceAvatar userId={f.id} name={f.name} avatar={f.avatar} status={f.presence} announce />
                          <span className="min-w-0 flex-1">
                            <span className="block truncate font-medium text-zinc-100">{f.name}</span>
                            <span className="block truncate text-xs text-muted-foreground">
                              {f.state === "incoming" ? "Incoming friend request" : f.state === "outgoing" ? "Outgoing friend request" : f.customStatus || f.bio || (f.presence ? "Online" : "Offline")}
                            </span>
                          </span>
                        </button>
                      } />
                      <div className="flex shrink-0 gap-1">
                        {f.state === "friend" && (
                          <>
                            <Link href={`/app/messages?to=${encodeURIComponent(f.id)}`} aria-label={`Message ${f.name}`} title="Message" className="grid size-8 place-items-center rounded-lg text-zinc-400 hover:bg-white/5 hover:text-zinc-100 focus-visible:outline-2 focus-visible:outline-ring">
                              <MessageSquareIcon className="size-4" />
                            </Link>
                            <Button variant="ghost" size="icon" disabled={busy} aria-label={`Remove ${f.name} as a friend`} title="Remove friend"
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
    <section aria-labelledby={`${id}-heading`} className="grid gap-4 rounded-xl border border-white/5 bg-panel/60 p-4">
      <div>
        <h2 id={`${id}-heading`} className="font-semibold">Add a friend</h2>
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
        <Button variant="ghost" size="sm" onClick={() => void copy()} aria-label="Copy your friend link">
          {copied ? <CheckIcon /> : <CopyIcon />} {copied ? "Copied" : "Copy link"}
        </Button>
      </div>
    </section>
  );
}
