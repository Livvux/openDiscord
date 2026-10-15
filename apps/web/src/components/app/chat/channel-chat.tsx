"use client";

import { Fragment, useEffect, useLayoutEffect, useRef, useState } from "react";
import { markChannelRead, sendMessage } from "@/app/app/actions";
import { Button } from "@/components/ui/button";
import type { ChannelSummary } from "@/server/communities";
import type { MessagePage, MessageView } from "@/server/messages";
import { decodeMentions, type Mention } from "@/lib/mentions";
import { useRealtime } from "../realtime-provider";
import { useClearUnread } from "../unread-provider";
import { Composer } from "./composer";
import { MessageItem, PendingItem } from "./message-item";
import { ThreadPanel } from "./thread-panel";
import { useChannelMessages } from "./use-channel-messages";

interface ChannelChatProps {
  channel: ChannelSummary;
  initialPage: MessagePage;
  currentUserId: string;
  canSend: boolean;
  canModerate: boolean;
  mediaEnabled: boolean;
  communityId: string;
  /** Read marker when the channel was opened, for the "new messages" divider. */
  lastReadId: string | null;
  /** Authors whose messages are collapsed for this person. */
  blockedIds: string[];
  /** Set when this instance shows a thread (in the side panel) instead of the channel. */
  threadRoot?: MessageView;
}

interface Pending {
  tempId: string;
  content: string;
  mentions: Mention[];
  images: number;
}

const GROUP_WINDOW_MS = 5 * 60_000;
const NEAR_BOTTOM_PX = 120;

export function ChannelChat(props: ChannelChatProps) {
  const { channel, initialPage, currentUserId, canSend, canModerate, mediaEnabled, communityId, lastReadId, blockedIds, threadRoot } = props;
  const { state } = useRealtime();
  const threadId = threadRoot?.id ?? null;
  const { messages, hasMore, loadingOlder, loadError, loadOlder, upsert, remove } = useChannelMessages(channel.id, initialPage, threadId);
  const [openThreadId, setOpenThreadId] = useState<string | null>(null);
  // The live root from the list: edits show up, and a deleted root closes its thread.
  const openThread = openThreadId ? (messages.find((m) => m.id === openThreadId) ?? null) : null;
  const setOpenThread = (m: MessageView | null) => setOpenThreadId(m?.id ?? null);
  const [pending, setPending] = useState<Pending[]>([]);
  const [sendError, setSendError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [replyTo, setReplyTo] = useState<MessageView | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const nearBottom = useRef(true);
  const heightBeforeOlder = useRef<number | null>(null);
  const [dividerAfter] = useState(lastReadId);
  const firstUnread = dividerAfter ? messages.find((m) => m.id > dividerAfter && m.authorId !== currentUserId)?.id : undefined;
  const clearUnread = useClearUnread();
  const newest = messages.at(-1)?.id;

  // Reading the newest message while the tab is visible marks the channel read (threads don't move the marker).
  useEffect(() => {
    if (!newest || threadId) return;
    const mark = () => {
      if (document.visibilityState !== "visible") return;
      clearUnread?.(channel.id);
      void markChannelRead(channel.id, newest);
    };
    const timer = setTimeout(mark, 500);
    document.addEventListener("visibilitychange", mark);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", mark);
    };
  }, [newest, threadId, channel.id, clearUnread]);

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

  async function onSend(content: string, attachmentIds: string[], mentions: Mention[]): Promise<boolean> {
    const tempId = crypto.randomUUID();
    setSendError(null);
    nearBottom.current = true;
    setPending((p) => [...p, { tempId, content, mentions, images: attachmentIds.length }]);
    const replyToId = replyTo?.id ?? null;
    setReplyTo(null);
    const result = await sendMessage(channel.id, content, attachmentIds, replyToId, threadId);
    setPending((p) => p.filter((x) => x.tempId !== tempId));
    if (result.ok) {
      upsert(result.data);
      return true;
    }
    setSendError(result.error);
    // Put the text back unless the person already started a new message.
    setDraft((d) => (d.trim() ? d : decodeMentions(content, mentions)));
    return false;
  }

  const column = (
    <div className={`flex min-h-0 flex-1 flex-col ${openThread ? "max-lg:hidden" : ""}`}>
      {!threadId && state === "reconnecting" && (
        <p role="status" className="bg-amber-500/15 px-4 py-1.5 text-center text-sm text-amber-200">
          Connection lost. Reconnecting…
        </p>
      )}
      {!threadId && state === "closed" && (
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
          ) : threadRoot ? (
            <ol aria-label="Thread start" className="border-b border-white/5 pb-2">
              <MessageItem
                message={threadRoot}
                currentUserId={currentUserId}
                blocked={blockedIds.includes(threadRoot.authorId)}
                grouped={false}
                canEdit={false}
                canDelete={false}
                canReact={false}
                canPin={false}
                replyBlocked={false}
                onDeleted={() => {}}
                onReply={() => {}}
              />
            </ol>
          ) : (
            <div className="px-5 pb-2">
              <h2 className="text-xl font-semibold text-zinc-100">Welcome to #{channel.name}</h2>
              <p className="text-sm text-zinc-400">This is the start of the channel.</p>
            </div>
          )}
          <div role="log" aria-label={threadRoot ? "Thread replies" : `Messages in #${channel.name}`} aria-live="polite" aria-relevant="additions">
          <ol>
            {messages.map((m, i) => {
              const prev = messages[i - 1];
              const grouped =
                prev !== undefined &&
                prev.authorId === m.authorId &&
                Date.parse(m.createdAt) - Date.parse(prev.createdAt) < GROUP_WINDOW_MS;
              return (
                <Fragment key={m.id}>
                {m.id === firstUnread && (
                  <li role="separator" aria-label="New messages" className="mx-5 my-2 flex items-center gap-2 text-[11px] font-semibold text-red-400 uppercase">
                    <span className="h-px flex-1 bg-red-500/50" />
                    New
                  </li>
                )}
                <MessageItem
                  message={m}
                  currentUserId={currentUserId}
                  blocked={blockedIds.includes(m.authorId)}
                  grouped={grouped && m.id !== firstUnread}
                  canEdit={m.authorId === currentUserId && !m.authorImported}
                  canDelete={m.authorId === currentUserId || canModerate}
                  canReact={canSend}
                  canPin={canModerate}
                  replyBlocked={!!m.replyTo && blockedIds.includes(m.replyTo.authorId)}
                  onDeleted={remove}
                  onReply={setReplyTo}
                  onOpenThread={threadId ? undefined : setOpenThread}
                />
                </Fragment>
              );
            })}
            {pending.map((p) => (
              <PendingItem key={p.tempId} content={p.content} mentions={p.mentions} images={p.images} />
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
        <Composer
          channelId={channel.id}
          channelName={channel.name}
          placeholder={threadRoot ? "Reply in thread" : undefined}
          draft={draft}
          setDraft={setDraft}
          onSend={onSend}
          mediaEnabled={mediaEnabled}
          communityId={communityId}
          replyTo={replyTo}
          onCancelReply={() => setReplyTo(null)}
        />
      ) : (
        <p className="mx-4 mb-4 rounded-lg bg-white/5 px-4 py-2.5 text-sm text-zinc-400">You don&apos;t have permission to send messages here.</p>
      )}
    </div>
  );
  if (threadId) return column;
  return (
    <div className="flex min-h-0 flex-1">
      {column}
      {openThread && (
        <ThreadPanel key={openThread.id} {...props} root={openThread} onClose={() => setOpenThreadId(null)} />
      )}
    </div>
  );
}
