"use client";

import { HashIcon } from "lucide-react";
import { Fragment, useEffect, useLayoutEffect, useRef, useState } from "react";
import { sendMessage, sendStatus } from "@/app/app/actions";
import { Button } from "@/components/ui/button";
import type { ChannelSummary } from "@/server/communities";
import type { MessagePage, MessageView } from "@/server/messages";
import { decodeMentions, type Mention } from "@/lib/mentions";
import { readDraft, writeDraft } from "@/lib/chat-drafts";
import { outbox, type OutboxEntry } from "@/lib/outbox";
import { useRealtime } from "../realtime-provider";
import { Composer } from "./composer";
import { MessageItem, PendingItem } from "./message-item";
import { ThreadPanel } from "./thread-panel";
import { useChannelMessages } from "./use-channel-messages";
import { useChannelTyping } from "./use-channel-typing";
import { useOutbox } from "./use-outbox";
import { useReadMarker } from "./use-read-marker";
import { useMemberNames } from "../member-list";
import { typingText } from "@/lib/typing";

interface ChannelChatProps {
  channel: ChannelSummary;
  initialPage: MessagePage;
  currentUserId: string;
  canSend: boolean;
  publicGeneration?: string | null;
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

const GROUP_WINDOW_MS = 5 * 60_000;
const dayFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "long" });
const sameDay = (a: string, b: string) => new Date(a).toDateString() === new Date(b).toDateString();
const NEAR_BOTTOM_PX = 120;

export function ChannelChat(props: ChannelChatProps) {
  const { channel, initialPage, currentUserId, canSend, canModerate, mediaEnabled, communityId, lastReadId, blockedIds, threadRoot, publicGeneration } = props;
  const { state } = useRealtime();
  const threadId = threadRoot?.id ?? null;
  const { messages, hasMore, loadingOlder, loadError, loadOlder, upsert, remove } = useChannelMessages(channel.id, initialPage, threadId);
  const [openThreadId, setOpenThreadId] = useState<string | null>(null);
  // The live root from the list: edits show up, and a deleted root closes its thread.
  const openThread = openThreadId ? (messages.find((m) => m.id === openThreadId) ?? null) : null;
  const setOpenThread = (m: MessageView | null) => setOpenThreadId(m?.id ?? null);
  const pending = useOutbox(currentUserId, channel.id, threadId);
  const [sendError, setSendError] = useState<string | null>(null);
  const sending = useRef(new Set<string>());
  // Sends this view started or already resolved; anything else in the outbox was restored.
  const known = useRef(new Set<string>());
  // Restored after a reload or from an earlier view: the receipt says whether it arrived, so a delivered
  // message isn't shown twice and an undelivered one is clearly unsent. Retry stays safe either way.
  useEffect(() => {
    const ids = pending.filter((p) => p.state === "unconfirmed" && !known.current.has(p.id)).map((p) => p.id);
    if (ids.length === 0) return;
    ids.forEach((id) => known.current.add(id));
    void sendStatus(ids).then((result) => {
      if (!result.ok) return;
      for (const id of ids) {
        if (sending.current.has(id)) continue;
        const state = result.data[id];
        if (state === "sent") outbox.remove(currentUserId, id);
        else outbox.update(currentUserId, id, { state: state ?? "unsent", error: null });
      }
    }).catch(() => { /* offline: stays unconfirmed with Retry */ });
  }, [pending, currentUserId]);
  // Drafts outlive this component (channel switch, closed thread) but stay in memory: lib/chat-drafts.ts.
  const draftScope = threadId ? `thread:${threadId}` : `channel:${channel.id}`;
  const [draft, setDraft] = useState(() => readDraft<MessageView>(currentUserId, draftScope)?.text ?? "");
  const [replyTo, setReplyTo] = useState<MessageView | null>(() => readDraft<MessageView>(currentUserId, draftScope)?.replyTo ?? null);
  useEffect(() => writeDraft(currentUserId, draftScope, { text: draft, replyTo }), [currentUserId, draftScope, draft, replyTo]);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  const scroller = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const nearBottom = useRef(true);
  // Discord's "viewing older messages" bar, once the reader is more than a screen above the newest message.
  const [farFromPresent, setFarFromPresent] = useState(false);
  const heightBeforeOlder = useRef<number | null>(null);
  const [dividerAfter] = useState(lastReadId);
  const firstUnread = dividerAfter ? messages.find((m) => m.id > dividerAfter && m.authorId !== currentUserId)?.id : undefined;
  const typing = useChannelTyping(channel.id, currentUserId, blockedIds);
  const typingNow = typingText(useMemberNames(threadId ? [] : typing.typing));
  const announceTyping = typing.changed;
  // The draft drives the notice; threads keep their typing to themselves.
  useEffect(() => { if (!threadId && canSend) announceTyping(!!draft.trim()); }, [draft, threadId, canSend, announceTyping]);
  // Only messages that were on screen in a visible tab, or "Mark as read", move the marker (threads don't).
  const read = useReadMarker({ channelId: channel.id, enabled: !threadId, messages, currentUserId, lastReadId, scroller, connection: state });

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

  useEffect(() => {
    const el = scroller.current;
    const contents = content.current;
    if (!el || !contents) return;
    let active = true;
    // Content can grow after the message layout effect has already pinned the view.
    const observer = new ResizeObserver(() => {
      if (!active || scroller.current !== el || content.current !== contents
        || !nearBottom.current || heightBeforeOlder.current !== null) return;
      el.scrollTop = el.scrollHeight;
    });
    observer.observe(contents);
    return () => {
      active = false;
      observer.disconnect();
    };
  }, []);

  async function onLoadOlder() {
    heightBeforeOlder.current = scroller.current?.scrollHeight ?? null;
    await loadOlder();
  }

  /** `reply` is set on the first attempt only: a rejection then goes straight back into the composer. */
  async function deliver(item: Omit<OutboxEntry, "createdAt">, reply?: MessageView | null): Promise<boolean> {
    if (sending.current.has(item.id)) return true;
    sending.current.add(item.id);
    known.current.add(item.id);
    outbox.update(currentUserId, item.id, { state: "sending", error: null });
    try {
      // The entry id is the send id: a retry of a send that did arrive returns the stored message.
      const result = await sendMessage(channel.id, item.content, item.attachmentIds, item.replyToId, threadId, item.publicGeneration, item.id);
      if (!result.ok && result.code && reply !== undefined && mounted.current) {
        outbox.remove(currentUserId, item.id);
        setSendError(result.error);
        setDraft((draft) => draft.trim() ? draft : decodeMentions(item.content, item.mentions));
        setReplyTo((current) => current ?? reply);
        return false;
      }
      // Definitive: the server re-checked access and refused, or the stored message was deleted since.
      if (!result.ok && result.code) {
        outbox.update(currentUserId, item.id, { state: result.code === "conflict" ? "deleted" : "failed", error: result.error });
        return true;
      }
      if (!result.ok) throw new Error(result.error);
      upsert(result.data);
      outbox.remove(currentUserId, item.id);
    } catch (error) {
      const detail = error instanceof Error ? error.message : "Connection interrupted.";
      outbox.update(currentUserId, item.id, { state: "unconfirmed", error: detail });
    } finally {
      sending.current.delete(item.id);
    }
    return true;
  }

  async function onSend(content: string, attachmentIds: string[], mentions: Mention[]): Promise<boolean> {
    const item = { id: crypto.randomUUID(), channelId: channel.id, threadId, content, mentions, images: attachmentIds.length,
      attachmentIds, replyToId: replyTo?.id ?? null, publicGeneration: publicGeneration ?? null, state: "sending" as const, error: null };
    nearBottom.current = true;
    setSendError(null);
    setReplyTo(null);
    outbox.put(currentUserId, item);
    // Retries reuse the original attachment/reply context from the outbox entry.
    return deliver(item, replyTo);
  }

  /** A refused send goes back into the composer as a new message (new send id). */
  function editUnsent(item: OutboxEntry) {
    outbox.remove(currentUserId, item.id);
    const text = decodeMentions(item.content, item.mentions);
    setDraft((draft) => draft.trim() ? `${draft}\n${text}` : text);
    const target = messages.find((m) => m.id === item.replyToId);
    if (target) setReplyTo((current) => current ?? target);
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
      {read.unseen && (
        <div className="relative z-10 mx-4 flex h-7 shrink-0 items-center justify-between gap-2 rounded-b-lg bg-primary px-3 text-sm font-semibold text-primary-foreground">
          <button
            type="button"
            aria-label="Jump to new messages"
            className="truncate rounded px-1 hover:underline focus-visible:outline-2 focus-visible:outline-primary-foreground"
            onClick={() => scroller.current?.querySelector(`[data-message-id="${read.unseen}"]`)?.scrollIntoView({ block: "start", behavior: "smooth" })}
          >
            New messages
          </button>
          <button
            type="button"
            className="shrink-0 rounded px-1 hover:underline focus-visible:outline-2 focus-visible:outline-primary-foreground"
            onClick={read.markAll}
          >
            Mark as read
          </button>
        </div>
      )}
      <div
        ref={scroller}
        onScroll={(e) => {
          const el = e.currentTarget;
          const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
          nearBottom.current = distance < NEAR_BOTTOM_PX;
          setFarFromPresent(distance > el.clientHeight);
          read.schedule();
        }}
        className="min-h-0 flex-1 overflow-y-auto"
      >
        <div ref={content} className="flex min-h-full flex-col justify-end py-4">
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
            <div className="mx-4 mt-4 mb-2">
              <span aria-hidden className="mb-2 grid size-[68px] place-items-center rounded-full bg-white/10 text-foreground"><HashIcon className="size-10" /></span>
              <h2 className="text-[32px] leading-10 font-bold text-foreground">Welcome to #{channel.name}!</h2>
              <p className="text-base text-muted-foreground">This is the start of the #{channel.name} channel.{channel.topic ? ` ${channel.topic}` : ""}</p>
            </div>
          )}
          <div role="log" aria-label={threadRoot ? "Thread replies" : `Messages in #${channel.name}`} aria-live="polite" aria-relevant="additions">
          <ol>
            {messages.map((m, i) => {
              const prev = messages[i - 1];
              const newDay = prev === undefined || !sameDay(prev.createdAt, m.createdAt);
              // Discord starts a new group for replies and on a new day.
              const grouped =
                prev !== undefined &&
                !newDay &&
                !m.replyTo &&
                prev.authorId === m.authorId &&
                Date.parse(m.createdAt) - Date.parse(prev.createdAt) < GROUP_WINDOW_MS;
              return (
                <Fragment key={m.id}>
                {newDay && (
                  // A plain list item: list children can't take the separator role.
                  <li className="mx-4 mt-6 mb-2 flex items-center gap-2 text-xs font-semibold text-muted-foreground" suppressHydrationWarning>
                    <span aria-hidden className="h-px flex-1 bg-border" />
                    {dayFormat.format(new Date(m.createdAt))}
                    <span aria-hidden className="h-px flex-1 bg-border" />
                  </li>
                )}
                {m.id === firstUnread && (
                  <li className="relative mx-4 my-2 h-px bg-[#dc2626]">
                    <span className="absolute -top-2 right-0 rounded-sm bg-[#dc2626] px-1 text-[10px] leading-4 font-bold text-white uppercase">New<span className="sr-only"> messages</span></span>
                  </li>
                )}
                <MessageItem
                  message={m}
                  currentUserId={currentUserId}
                  blocked={blockedIds.includes(m.authorId)}
                  grouped={grouped && m.id !== firstUnread}
                  canEdit={canSend && m.authorId === currentUserId && !m.authorImported}
                  publicGeneration={publicGeneration}
                  canDelete={m.authorId === currentUserId || canModerate}
                  canReact={canSend && !publicGeneration}
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
              <Fragment key={p.id}>
                <PendingItem content={p.content} mentions={p.mentions} images={p.images} state={p.state} />
                {p.state !== "sending" && <li className="flex flex-wrap items-center gap-2 px-5 pb-2 text-sm text-destructive" role="alert">
                  {/* "deleted" already says it all in the row status. */}
                  {p.error && p.state !== "deleted" && <p className="basis-full">{p.error}</p>}
                  {p.state === "unconfirmed" || p.state === "unsent"
                    ? <Button type="button" variant="outline" size="sm" aria-label="Retry message" onClick={() => void deliver(p)}>Retry</Button>
                    : canSend && <Button type="button" variant="outline" size="sm" aria-label="Edit unsent message" onClick={() => editUnsent(p)}>Edit</Button>}
                  <Button type="button" variant="ghost" size="sm" aria-label="Discard message" onClick={() => outbox.remove(currentUserId, p.id)}>Discard</Button>
                </li>}
              </Fragment>
            ))}
          </ol>
          </div>
        </div>
      </div>
      {sendError && <p role="alert" className="px-5 pb-1 text-sm text-destructive">{sendError}</p>}
      {farFromPresent && (
        <div className="relative z-0 mx-4 -mb-2 flex items-center justify-between gap-2 rounded-t-lg bg-primary px-4 pt-1 pb-3 text-sm font-medium text-primary-foreground">
          <span className="truncate">You&apos;re viewing older messages</span>
          <button
            type="button"
            className="shrink-0 rounded px-1 font-semibold hover:underline focus-visible:outline-2 focus-visible:outline-primary-foreground"
            onClick={() => scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: "smooth" })}
          >
            Jump to present
          </button>
        </div>
      )}
      {canSend ? (
        <Composer
          channelId={channel.id}
          channelName={channel.name}
          placeholder={threadRoot ? "Reply in thread" : undefined}
          draft={draft}
          setDraft={setDraft}
          onSend={onSend}
          mediaEnabled={mediaEnabled && !publicGeneration}
          isPublic={!!publicGeneration}
          communityId={communityId}
          replyTo={replyTo}
          onCancelReply={() => setReplyTo(null)}
          onEditLast={() => {
            const mine = messages.findLast((m) => m.authorId === currentUserId && !m.authorImported);
            // The row owns its editor; open it the way its Edit button does.
            scroller.current?.querySelector<HTMLButtonElement>(`[data-message-id="${mine?.id}"] button[aria-label="Edit message"]`)?.click();
          }}
        />
      ) : (
        <p className="mx-4 mb-6 rounded-lg bg-card px-4 py-4 text-base text-muted-foreground">You do not have permission to send messages in this channel.</p>
      )}
      {!threadId && (
        <p aria-live="polite" className="-mt-6 flex h-6 min-w-0 items-center gap-1.5 px-4 text-xs text-muted-foreground">
          {typingNow && (
            <>
              <span aria-hidden className="flex gap-0.5">
                {[0, 150, 300].map((delay) => <span key={delay} className="size-1.5 animate-bounce rounded-full bg-foreground/80" style={{ animationDelay: `${delay}ms` }} />)}
              </span>
              <span className="truncate"><span className="font-semibold text-foreground">{typingNow.names}</span>{typingNow.verb}</span>
            </>
          )}
        </p>
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
