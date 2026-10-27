"use client";

import { SearchIcon } from "lucide-react";
import Link from "next/link";
import { useEffect, useId, useState } from "react";
import { searchMessages } from "@/app/app/actions";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import type { SearchResult } from "@/server/messages";
import { MessageContent } from "./chat/message-item";

const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

/** Searches readable channels of one community. Opens with Ctrl/Cmd+K. */
export function SearchDialog({ communityId, communityName }: { communityId: string; communityName: string }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<{ query: string; items: SearchResult[]; done: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inputId = useId();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    const q = query.trim();
    if (!q) return;
    let active = true;
    const timer = setTimeout(() => {
      void searchMessages(communityId, q).then((r) => {
        if (!active) return;
        if (r.ok) {
          setResults({ query: q, items: r.data, done: r.data.length < 25 });
          setError(null);
        } else setError(r.error);
      });
    }, 300);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [communityId, query]);

  const shown = query.trim() && results?.query === query.trim() ? results.items : null;

  async function loadOlder() {
    if (!results || results.items.length === 0) return;
    const r = await searchMessages(communityId, results.query, results.items.at(-1)!.id);
    if (r.ok) setResults((cur) => (cur && cur.query === results.query ? { ...cur, items: [...cur.items, ...r.data], done: r.data.length < 25 } : cur));
    else setError(r.error);
  }
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={
          <button type="button" aria-label="Search messages" title="Search messages (Ctrl+K)" className="flex h-8 w-8 items-center gap-2 rounded-lg bg-sidebar px-2 text-left sm:w-36 text-sm text-muted-foreground ring-1 ring-border transition-[width] hover:text-sidebar-foreground focus-visible:outline-2 focus-visible:outline-ring lg:w-60" />
        }
      >
        <span className="min-w-0 flex-1 truncate max-sm:hidden">Search</span>
        <SearchIcon aria-hidden className="size-4 shrink-0" />
      </DialogTrigger>
      <DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Search {communityName}</DialogTitle>
        </DialogHeader>
        <label htmlFor={inputId} className="sr-only">Search messages</label>
        <Input id={inputId} type="search" autoFocus value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search messages" />
        <p role="status" className="text-xs text-muted-foreground">
          {shown ? (shown.length === 0 ? "No messages found." : `${shown.length}${results?.done ? "" : "+"} ${shown.length === 1 ? "result" : "results"}, newest first.`) : "Matches words by their beginning, in channels you can read."}
        </p>
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        {shown && shown.length > 0 && (
          <ol className="divide-y rounded-lg border">
            {shown.map((m) => (
              <li key={m.id}>
                <Link
                  href={`/app/c/${communityId}/${m.channelId}`}
                  onClick={() => setOpen(false)}
                  className="grid gap-0.5 px-3 py-2 text-sm hover:bg-white/5 focus-visible:outline-2 focus-visible:outline-ring"
                >
                  <span className="flex flex-wrap gap-x-2 text-xs text-zinc-400">
                    <span className="font-medium text-zinc-200">{m.authorName}</span>
                    {m.authorImported && <span className="text-zinc-500">(imported)</span>}
                    <span>#{m.channelName}</span>
                    <time dateTime={m.createdAt} suppressHydrationWarning>{dateFormat.format(new Date(m.createdAt))}</time>
                  </span>
                  <span className="line-clamp-3 break-words whitespace-pre-wrap text-zinc-300">
                    <MessageContent content={m.content} mentions={m.mentions} />
                  </span>
                </Link>
              </li>
            ))}
          </ol>
        )}
        {shown && shown.length > 0 && !results?.done && (
          <Button variant="ghost" size="sm" onClick={() => void loadOlder()}>Show older results</Button>
        )}
      </DialogContent>
    </Dialog>
  );
}
