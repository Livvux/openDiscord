"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { sendMessage } from "@/app/app/actions";
import { Button } from "@/components/ui/button";
import type { ChannelSummary } from "@/server/communities";
import type { MessagePage } from "@/server/messages";
import { useRealtime } from "../realtime-provider";
import { Composer } from "./composer";
import { MessageItem, PendingItem } from "./message-item";
import { useChannelMessages } from "./use-channel-messages";

interface ChannelChatProps {
  channel: ChannelSummary;
  initialPage: MessagePage;
  currentUserId: string;
  canSend: boolean;
  canModerate: boolean;
}

interface Pending {
  tempId: string;
  content: string;
}

const GROUP_WINDOW_MS = 5 * 60_000;
const NEAR_BOTTOM_PX = 120;

export function ChannelChat({ channel, initialPage, currentUserId, canSend, canModerate }: ChannelChatProps) {
  const { state } = useRealtime();
  const { messages, hasMore, loadingOlder, loadError, loadOlder, upsert, remove } = useChannelMessages(channel.id, initialPage);
  const [pending, setPending] = useState<Pending[]>([]);
  const [sendError, setSendError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const scroller = useRef<HTMLDivElement>(null);
  const nearBottom = useRef(true);
  const heightBeforeOlder = useRef<number | null>(null);

  // Keep the view pinned to the newest message unless the reader scrolled up;
  // keep the reading position stable when older messages are prepended.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    if (heightBeforeOlder.current !== null) {
      el.scrollTop += el.scrollHeight - heightBeforeOlder.current;
      heightBeforeOlder.current = null;
    } else if (nearBottom.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [messages, pending]);

  useEffect(() => {
    if (scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight;
  }, []);

  async function onLoadOlder() {
    heightBeforeOlder.current = scroller.current?.scrollHeight ?? null;
    await loadOlder();
  }

  async function onSend(content: string) {
    const tempId = crypto.randomUUID();
    setSendError(null);
    nearBottom.current = true;
    setPending((p) => [...p, { tempId, content }]);
    const result = await sendMessage(channel.id, content);
    setPending((p) => p.filter((x) => x.tempId !== tempId));
    if (result.ok) {
      upsert(result.data);
    } else {
      setSendError(result.error);
      // Put the text back unless the person already started a new message.
      setDraft((d) => (d.trim() ? d : content));
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {state === "reconnecting" && (
        <p role="status" className="bg-amber-500/15 px-4 py-1.5 text-center text-sm text-amber-200">
          Connection lost. Reconnecting…
        </p>
      )}
      {state === "closed" && (
        <p role="status" className="bg-destructive/15 px-4 py-1.5 text-center text-sm">
          Live updates stopped. <button className="underline" onClick={() => window.location.reload()}>Reload</button>
        </p>
      )}
      <div
        ref={scroller}
        onScroll={(e) => {
          const el = e.currentTarget;
          nearBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX;
        }}
        className="min-h-0 flex-1 overflow-y-auto"
      >
        <div className="flex min-h-full flex-col justify-end py-4">
          {hasMore ? (
            <div className="flex flex-col items-center gap-1 py-2">
              <Button variant="ghost" size="sm" onClick={onLoadOlder} disabled={loadingOlder}>
                {loadingOlder ? "Loading…" : "Load older messages"}
              </Button>
              {loadError && <p role="alert" className="text-sm text-destructive">{loadError}</p>}
            </div>
          ) : (
            <div className="px-5 pb-2">
              <h2 className="text-xl font-semibold text-zinc-100">Welcome to #{channel.name}</h2>
              <p className="text-sm text-zinc-400">This is the start of the channel.</p>
            </div>
          )}
          <div role="log" aria-label={`Messages in #${channel.name}`} aria-live="polite" aria-relevant="additions">
          <ol>
            {messages.map((m, i) => {
              const prev = messages[i - 1];
              const grouped =
                prev !== undefined &&
                prev.authorId === m.authorId &&
                Date.parse(m.createdAt) - Date.parse(prev.createdAt) < GROUP_WINDOW_MS;
              return (
                <MessageItem
                  key={m.id}
                  message={m}
                  grouped={grouped}
                  canEdit={m.authorId === currentUserId}
                  canDelete={m.authorId === currentUserId || canModerate}
                  onDeleted={remove}
                />
              );
            })}
            {pending.map((p) => (
              <PendingItem key={p.tempId} content={p.content} />
            ))}
          </ol>
          </div>
        </div>
      </div>
      {sendError && (
        <p role="alert" className="px-5 pb-1 text-sm text-destructive">
          {sendError}
        </p>
      )}
      {canSend ? (
        <Composer channelName={channel.name} draft={draft} setDraft={setDraft} onSend={onSend} />
      ) : (
        <p className="mx-4 mb-4 rounded-lg bg-white/5 px-4 py-2.5 text-sm text-zinc-400">You don&apos;t have permission to send messages here.</p>
      )}
    </div>
  );
}
