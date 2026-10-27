"use client";

import { HashIcon, SearchIcon, UsersIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useId, useState } from "react";
import { Dialog, DialogContent, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { visibleConversation, type DirectConversation } from "@/lib/dm/contracts";
import { CommunityIcon } from "../community-icon";
import { useDirectConversations } from "../notifications-provider";
import { Avatar } from "../avatar";

interface Destination {
  key: string;
  label: string;
  hint: string;
  href: string;
  icon: React.ReactNode;
}

const MAX_RESULTS = 8;

function destinations(communities: { id: string; name: string }[], conversations: DirectConversation[]): Destination[] {
  return [
    ...conversations.filter(visibleConversation).map((c) => ({
      key: c.id,
      label: c.peerName,
      hint: c.kind === "group" ? "Group" : "Direct message",
      href: c.kind === "group" ? `/app/messages?c=${encodeURIComponent(c.id)}` : `/app/messages?to=${encodeURIComponent(c.peerId)}`,
      icon: c.kind === "group" ? <UsersIcon className="size-5 text-muted-foreground" /> : <Avatar name={c.peerName} avatar={c.peerAvatar} size="sm" />,
    })),
    ...communities.map((c) => ({ key: c.id, label: c.name, hint: "Community", href: `/app/c/${c.id}`, icon: <CommunityIcon name={c.name} size="sm" /> })),
    { key: "friends", label: "Friends", hint: "Home", href: "/app", icon: <HashIcon className="size-5 text-muted-foreground" /> },
  ];
}

/** Discord's "Find or start a conversation": jump to a conversation or community by name. */
export function QuickSwitcher({ communities, initial }: { communities: { id: string; name: string }[]; initial: DirectConversation[] }) {
  const router = useRouter();
  const id = useId();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const { direct } = useDirectConversations();
  const q = query.trim().toLowerCase();
  const results = destinations(communities, direct ?? initial).filter((d) => !q || d.label.toLowerCase().includes(q)).slice(0, MAX_RESULTS);
  const active = Math.min(selected, results.length - 1);
  const go = (d: Destination | undefined) => {
    if (!d) return;
    setOpen(false);
    router.push(d.href);
  };
  return (
    <Dialog open={open} onOpenChange={(next) => { setOpen(next); setQuery(""); setSelected(0); }}>
      <DialogTrigger className="h-7 w-full truncate rounded-md bg-sidebar px-2 text-left text-sm font-medium text-muted-foreground ring-1 ring-border hover:text-sidebar-foreground focus-visible:outline-2 focus-visible:outline-ring">
        Find or start a conversation
      </DialogTrigger>
      <DialogContent className="gap-3 p-4 sm:max-w-xl">
        <DialogTitle className="sr-only">Find or start a conversation</DialogTitle>
        <label htmlFor={id} className="relative block">
          <span className="sr-only">Where would you like to go?</span>
          <SearchIcon aria-hidden className="pointer-events-none absolute top-1/2 left-3 size-5 -translate-y-1/2 text-muted-foreground" />
          <input
            id={id}
            role="combobox"
            aria-expanded
            aria-controls={`${id}-results`}
            aria-activedescendant={results[active] ? `${id}-${results[active].key}` : undefined}
            autoComplete="off"
            value={query}
            placeholder="Where would you like to go?"
            onChange={(e) => { setQuery(e.target.value); setSelected(0); }}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") { e.preventDefault(); setSelected((active + 1) % Math.max(results.length, 1)); }
              if (e.key === "ArrowUp") { e.preventDefault(); setSelected((active - 1 + results.length) % Math.max(results.length, 1)); }
              if (e.key === "Enter") { e.preventDefault(); go(results[active]); }
            }}
            className="h-12 w-full rounded-lg bg-sidebar pr-3 pl-11 text-lg text-foreground outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
          />
        </label>
        <ul id={`${id}-results`} role="listbox" aria-label="Destinations" className="grid gap-0.5">
          {results.map((d, i) => (
            <li
              key={d.key}
              id={`${id}-${d.key}`}
              role="option"
              aria-selected={i === active}
              onMouseEnter={() => setSelected(i)}
              onClick={() => go(d)}
              className={`flex h-10 cursor-pointer items-center gap-3 rounded-md px-2 ${i === active ? "bg-white/10 text-foreground" : "text-muted-foreground"}`}
            >
              <span className="grid w-7 shrink-0 place-items-center">{d.icon}</span>
              <span className="min-w-0 flex-1 truncate text-base font-medium">{d.label}</span>
              <span className="text-xs text-muted-foreground">{d.hint}</span>
            </li>
          ))}
          {results.length === 0 && <li className="px-2 py-6 text-center text-sm text-muted-foreground">Nothing matches “{query}”.</li>}
        </ul>
      </DialogContent>
    </Dialog>
  );
}
