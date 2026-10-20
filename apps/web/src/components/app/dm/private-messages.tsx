"use client";

import Link from "next/link";
import { FileIcon, PaperclipIcon, SendHorizontalIcon, ShieldCheckIcon, SmilePlusIcon, XIcon } from "lucide-react";
import { EmojiSelector } from "../emoji-selector";
import { GifSelector } from "../gif-selector";
import { insertEmoji } from "@/lib/emoji";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { blockUser, unblockUser } from "@/app/app/actions";
import { Button } from "@/components/ui/button";
import { MobileNavToggle } from "../mobile-nav";
import { PresenceAvatar } from "../presence-avatar";
import type { DmNotice } from "@/app/api/me/events/route";
import { DM_CHANGED_EVENT } from "../notifications-provider";
import { UserContextMenu } from "../user-context-menu";
import { PrivateMessageItem, type MessageView } from "./dm-message";
import { IdentityReset } from "./identity-reset";
import { GroupAvatars, GroupSettings, NewGroupForm, type FriendOption } from "./group-panel";
import { PeerProfile } from "./peer-profile";
import { DmCallButton, DmCallPanel } from "../voice/dm-call";
import { shortFilename } from "@/lib/filename";
import { DM_MAX_ATTACHMENT_BYTES, DM_MAX_ATTACHMENTS, DM_MAX_TEXT, type DeviceView, type DirectConversation, type DirectEnvelope } from "@/lib/dm/contracts";
import { MAX_HISTORY_COPIES, type HistoryArchive } from "@/lib/dm/history";
import { iosBrowserTab, persistDmStorage, storageHint } from "@/lib/dm/storage-persistence";
import { dmFetch, enrollNewDmDevice, privateMessaging, type PrivateMessaging, type TrustedDevice, type VerificationView } from "@/lib/dm/client";

const field = "w-full rounded-lg border bg-background px-3 py-2 text-sm focus-visible:outline-2 focus-visible:outline-ring";
const errorText = (error: unknown) => error instanceof Error ? error.message : "Private messaging could not complete this action.";
/** People whose devices are queried and get keys: the 1:1 peer, or current group members neither side blocked. */
const recipientsOf = (c: DirectConversation) => c.blocked || c.status !== "accepted" ? [] : c.members.filter((m) => !m.left && !m.blocked).map((m) => m.id);
/** Everyone who may have written here, including former group members. */
const sendersOf = (c: DirectConversation) => c.members.map((m) => m.id);
/** Former group members: their public keys authenticate earlier messages; they never receive keys. */
const formerOf = (c: DirectConversation) => c.members.filter((m) => m.left && !m.blocked).map((m) => m.id);

interface PrivateMessagesProps {
  userId: string;
  userName: string;
  userAvatar: string | null;
  /** Peer from ?to=. */
  target?: string;
  /** Friends need no message request: opening ?to= starts the conversation. */
  targetIsFriend?: boolean;
  /** Encrypted files need private object storage on this instance. */
  attachmentsEnabled?: boolean;
  /** A conversation from ?c= (groups have no single peer). */
  conversation?: string;
  /** Your friends, for creating groups and adding people. */
  friends?: FriendOption[];
}

export function PrivateMessages({ userId, userName, userAvatar, target, targetIsFriend = false, attachmentsEnabled = false, conversation, friends = [] }: PrivateMessagesProps) {
  const [client, setClient] = useState<PrivateMessaging | null>(null);
  const [conversations, setConversations] = useState<DirectConversation[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [devices, setDevices] = useState<DeviceView[]>([]);
  const [trusted, setTrusted] = useState<TrustedDevice[]>([]);
  const [verifications, setVerifications] = useState<VerificationView[]>([]);
  const [messages, setMessages] = useState<MessageView[]>([]);
  const [envelopes, setEnvelopes] = useState<DirectEnvelope[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [text, setText] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const fileInput = useRef<HTMLInputElement>(null);
  const openAttachment = useCallback((file: Parameters<PrivateMessaging["openAttachment"]>[0]) => client ? client.openAttachment(file) : Promise.reject(new Error("Encryption is unavailable.")), [client]);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const pendingCaret = useRef<number | null>(null);
  useLayoutEffect(() => {
    if (pendingCaret.current === null) return;
    textarea.current?.setSelectionRange(pendingCaret.current, pendingCaret.current);
    pendingCaret.current = null;
  }, [text]);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState("Opening encrypted messages…");
  const [busy, setBusy] = useState(false);
  const [security, setSecurity] = useState(false);
  const [creatingGroup, setCreatingGroup] = useState(false);
  const [groupSettings, setGroupSettings] = useState(false);
  const [callFor, setCallFor] = useState<string | null>(null);
  const [archives, setArchives] = useState<HistoryArchive[]>([]);
  const [transfers, setTransfers] = useState<Awaited<ReturnType<PrivateMessaging["pendingTransfers"]>>>([]);
  const [pendingIdentity, setPendingIdentity] = useState(false);
  const [backupList, setBackupList] = useState<{ id: string; createdAt: string }[]>([]);
  const [recoveryDownload, setRecoveryDownload] = useState<string | null>(null);
  const [persistenceHint, setPersistenceHint] = useState<string | null>(null);
  const [unverifiedBrowser, setUnverifiedBrowser] = useState(false);
  const [report, setReport] = useState<MessageView | null>(null);
  const reportTextarea = useRef<HTMLTextAreaElement>(null);
  const [reportReason, setReportReason] = useState("");
  const [reportDisclose, setReportDisclose] = useState(false);
  const active = conversations.find((c) => c.id === selected);
  const loading = useRef(false);
  const autoStarted = useRef(false);
  const refocus = useRef(false);
  // The composer is disabled while sending; give focus back once it is enabled again.
  useEffect(() => { if (!busy && refocus.current) { refocus.current = false; textarea.current?.focus(); } }, [busy]);
  const selectedRef = useRef(selected);
  const history = useRef<DirectEnvelope[]>([]);
  const markedRead = useRef<string | null>(null);
  useEffect(() => { selectedRef.current = selected; history.current = []; }, [selected]);
  const ready = !!client;

  useEffect(() => {
    let alive = true;
    privateMessaging(userId).then((value) => {
      if (!alive) return;
      setClient(value); setStatus("Encrypted messaging ready.");
      void persistDmStorage().then((state) => { if (alive) setPersistenceHint(storageHint(state, iosBrowserTab())); });
    }).catch((e: unknown) => { if (alive) { setError(errorText(e)); setStatus("Encryption is unavailable. No plaintext messages will be sent."); } });
    return () => { alive = false; };
  }, [userId]);
  useEffect(() => () => { if (recoveryDownload) URL.revokeObjectURL(recoveryDownload); }, [recoveryDownload]);

  const refresh = useCallback(async () => {
    if (!client || loading.current) return;
    loading.current = true;
    const selection = selectedRef.current;
    try {
      const listing = await dmFetch<{ conversations: DirectConversation[]; devices: DeviceView[] }>("/api/dm");
      setConversations(listing.conversations); setDevices(listing.devices);
      if (!selection && conversation && listing.conversations.some((c) => c.id === conversation)) { selectedRef.current = conversation; setSelected(conversation); }
      else if (!selection && target) {
        const matching = listing.conversations.find((c) => c.peerId === target);
        if (matching) setSelected(matching.id);
        else if (targetIsFriend && !autoStarted.current) {
          autoStarted.current = true;
          const started = await dmFetch<{ id: string }>("/api/dm", { action: "request", target });
          selectedRef.current = started.id; setSelected(started.id);
        }
      }
      const current = listing.conversations.find((c) => c.id === selection);
      const people = current ? recipientsOf(current) : [];
      await client.sync(people, current ? formerOf(current) : []);
      await client.acceptStartedVerifications();
      const verifiedHere = await client.ownIdentityVerified();
      setUnverifiedBrowser(!verifiedHere);
      const own = await client.devices(userId);
      const peer: TrustedDevice[] = [];
      for (const id of people) peer.push(...await client.devices(id));
      if (selection !== selectedRef.current) return;
      setTrusted([...own, ...peer]);
      setVerifications(client.verifications().filter((v) => v.userId === userId || people.includes(v.userId)));
      setArchives(await client.archives()); setPendingIdentity(client.hasPendingIdentity()); setTransfers(await client.pendingTransfers());
      if (current && selection === selectedRef.current) {
        const timeline = await dmFetch<{ messages: DirectEnvelope[]; hasMore: boolean }>(`/api/dm?conversation=${current.id}`);
        const all = [...new Map([...history.current, ...timeline.messages].map((m) => [m.id, m])).values()].sort((a, b) => a.id.localeCompare(b.id));
        const decoded = await client.decrypt(all, current.id, sendersOf(current));
        if (selection === selectedRef.current) {
          history.current = all; setMessages(decoded); setEnvelopes(all); if (all.length <= 50) setHasMore(timeline.hasMore);
          // Seen only when it is on screen, and not by an unverified browser that gets no keys: it must not
          // clear the unread marker for the person's trusted devices. The server keeps the marker monotonic.
          const latest = all.at(-1);
          if (latest && latest.senderId !== userId && verifiedHere && markedRead.current !== latest.id && document.visibilityState === "visible") {
            markedRead.current = latest.id;
            void dmFetch("/api/dm", { action: "read", id: current.id, message: latest.id }).catch(() => { markedRead.current = null; });
          }
        }
      }
      setStatus("Encrypted messaging ready.");
    } catch (e) { setError(errorText(e)); setStatus("Connection or verification needs attention."); }
    finally { loading.current = false; }
  }, [client, userId, target, targetIsFriend, conversation]);
  useEffect(() => {
    const initial = window.setTimeout(() => { void refresh(); }, 0);
    const timer = window.setInterval(() => { if (document.visibilityState === "visible") void refresh(); }, 3000);
    // New messages arrive through the personal stream; the interval also drives crypto sync.
    // Our own read markers need no crypto refresh.
    const changed = (event: Event) => { if ((event as CustomEvent<DmNotice | undefined>).detail?.reason !== "read") void refresh(); };
    // Only on becoming visible: the hidden transition also fires while the page unloads, and WebKit
    // refuses a fetch started then ("cannot load … due to access control checks").
    const shown = () => { if (document.visibilityState === "visible") void refresh(); };
    window.addEventListener(DM_CHANGED_EVENT, changed);
    document.addEventListener("visibilitychange", shown);
    return () => { window.clearTimeout(initial); window.clearInterval(timer); window.removeEventListener(DM_CHANGED_EVENT, changed); document.removeEventListener("visibilitychange", shown); };
  }, [refresh, selected]);

  async function run(fn: () => Promise<void>) {
    setBusy(true); setError(null);
    try { await fn(); await refresh(); } catch (e) { setError(errorText(e)); }
    finally { setBusy(false); }
  }
  async function request(targetId: string) {
    const response = await dmFetch<{ id: string }>("/api/dm", { action: "request", target: targetId });
    setText(""); selectedRef.current = response.id; setSelected(response.id); setVerifications([]); setTrusted([]);
  }
  async function backups() { const data = await dmFetch<{ backups: typeof backupList }>("/api/dm/backups"); setBackupList(data.backups); }
  async function loadEarlier() {
    if (!client || !active || !envelopes.length) return;
    const data = await dmFetch<{ messages: DirectEnvelope[]; hasMore: boolean }>(`/api/dm?conversation=${active.id}&before=${envelopes[0].id}`);
    // The polling refresh may be in flight or stalled; never decrypt against a stale peer identity.
    await client.sync(recipientsOf(active), formerOf(active));
    const all = [...new Map([...data.messages, ...history.current].map((m) => [m.id, m])).values()].sort((a, b) => a.id.localeCompare(b.id));
    const decoded = await client.decrypt(all, active.id, sendersOf(active));
    if (selectedRef.current !== active.id) return;
    history.current = all;
    setMessages(decoded); setEnvelopes(all); setHasMore(data.hasMore);
  }
  /** Group membership changes any time: send to the server's current members, never a stale list. */
  async function sendNow(c: DirectConversation, body: string, attached: File[] = []) {
    if (!client) return;
    let current = c;
    if (c.kind === "group") {
      const fresh = (await dmFetch<{ conversations: DirectConversation[] }>("/api/dm")).conversations.find((x) => x.id === c.id);
      if (!fresh) throw new Error("You are no longer in this group.");
      current = fresh;
    }
    await client.send(c.id, recipientsOf(current), body, attached, c.kind === "group");
  }
  async function createGroup(members: string[], name: string) {
    const created = await dmFetch<{ id: string }>("/api/dm", { action: "group", members, name });
    setCreatingGroup(false); selectedRef.current = created.id; setSelected(created.id);
  }
  const personName = (id: string) => conversations.flatMap((c) => c.members).find((m) => m.id === id)?.name ?? id;
  const authorOf = (id: string) => active?.members.find((m) => m.id === id);
  const group = active?.kind === "group";
  const peerVerified = !!active && !group && trusted.some((d) => d.userId === active.peerId) && trusted.filter((d) => d.userId === active.peerId).every((d) => d.verified);
  const missingRequest = target && !conversations.some((c) => c.peerId === target);
  const toggleSecurity = () => { setSecurity((v) => !v); void run(backups); };
  return <div className="flex min-h-0 flex-1">
    <section className="flex min-h-0 min-w-0 flex-1 flex-col">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b px-3">
        <MobileNavToggle />
        {active && group ? <>
          <GroupAvatars members={active.members} />
          <h1 className="min-w-0 truncate font-semibold">{active.peerName}</h1>
        </> : active ? <>
          <UserContextMenu userId={active.peerId} name={active.peerName} currentUserId={userId} blocked={active.ownBlocked} onChanged={() => void refresh()} onError={setError} profileOnClick>
            <button type="button" aria-label={`View profile of ${active.peerName}`} className="flex min-h-6 min-w-0 items-center gap-2 rounded px-1 hover:bg-white/5 focus-visible:outline-2 focus-visible:outline-ring"><PresenceAvatar userId={active.peerId} name={active.peerName} avatar={active.peerAvatar} size="sm" status={null} /></button>
          </UserContextMenu>
          <h1 className="min-w-0 truncate font-semibold">{active.peerName}</h1>
          {peerVerified && <span className="inline-flex items-center gap-1 text-xs text-brand-mint"><ShieldCheckIcon aria-hidden className="size-3.5" />Verified</span>}
        </> : <h1 className="font-semibold">Private messages</h1>}
        <div className="ml-auto flex items-center gap-1">
          {friends.length >= 2 && <Button variant="ghost" size="sm" aria-expanded={creatingGroup} onClick={() => setCreatingGroup((v) => !v)}>New group</Button>}
          {active?.status === "accepted" && !active.blocked && <DmCallButton conversation={{ id: active.id, name: active.peerName }} open={callFor === active.id} onToggle={() => setCallFor((id) => (id === active.id ? null : active.id))} />}
          {active && group && <Button variant="ghost" size="sm" aria-expanded={groupSettings} onClick={() => setGroupSettings((v) => !v)}>Group settings</Button>}
          <Button variant="ghost" size="sm" aria-expanded={security} onClick={toggleSecurity}><ShieldCheckIcon aria-hidden /><span className="max-sm:sr-only">Devices and recovery</span></Button>
          {active && !group && <Button variant="ghost" size="sm" disabled={busy} onClick={() => void run(async () => { const result = await (active.ownBlocked ? unblockUser(active.peerId) : blockUser(active.peerId)); if (!result.ok) throw new Error(result.error); })}>{active.ownBlocked ? "Unblock person" : "Block person"}</Button>}
        </div>
      </header>
      <div className="border-b px-4 py-1.5"><p className="text-xs text-muted-foreground" role="status">{status}</p>{unverifiedBrowser && <p className="mt-1 text-sm" data-unverified-browser>This browser is a new device on your account. Until you verify it from your other signed-in device in Devices and recovery, it can’t send messages and others’ messages can’t be read here.</p>}{error && <p role="alert" className="mt-2 text-sm text-destructive">{error}</p>}{!client && error && <div className="mt-3 flex flex-wrap gap-2"><Button variant="outline" onClick={() => window.location.reload()}>Retry encryption</Button><Button variant="outline" disabled={busy} onClick={() => { if (window.confirm("Enroll a new encryption device? This revokes this browser's old device. Recover history with your private recovery file or another verified device. Existing contacts must verify the new device.")) void run(async () => { await enrollNewDmDevice(userId); window.location.reload(); }); }}>Enroll a new browser device</Button></div>}</div>
      {active && <DmCallPanel key={active.id} conversation={{ id: active.id, name: active.peerName }} open={callFor === active.id && active.status === "accepted" && !active.blocked} />}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {creatingGroup && <NewGroupForm friends={friends} busy={busy} onCancel={() => setCreatingGroup(false)} onCreate={(members, name) => void run(() => createGroup(members, name))} />}
        {active && group && groupSettings && <GroupSettings key={active.id} conversation={active} userId={userId} friends={friends} busy={busy}
          onRename={(name) => void run(async () => { await dmFetch("/api/dm", { action: "group-rename", id: active.id, name }); })}
          onAdd={(ids) => void run(async () => { await dmFetch("/api/dm", { action: "group-add", id: active.id, members: ids }); })}
          onRemove={(id) => void run(async () => { await dmFetch("/api/dm", { action: "group-remove", id: active.id, target: id }); })}
          onLeave={() => void run(async () => { await dmFetch("/api/dm", { action: "group-leave", id: active.id }); setGroupSettings(false); selectedRef.current = null; setSelected(null); })} />}
        {security && <section aria-label="Encryption settings" className="grid gap-4 border-b p-4">
          <h2 className="font-semibold">Verified devices and recovery</h2>
          <p className="max-w-3xl text-sm text-muted-foreground">Message content is encrypted in your browser. New contacts are trusted on first use: their identity is pinned and a change blocks the conversation. Verify their device over another trusted channel to rule out a server in between. The server sees participants and timing. A compromised browser or modified web application can access messages. <Link href="https://github.com/Livvux/openDiscord/blob/main/docs/PRIVATE-MESSAGES.md" className="underline">Privacy details</Link></p>
          <p className="break-all text-xs">This device: <code>{client?.deviceId ?? "Opening…"}</code></p>
          {persistenceHint && <p className="max-w-3xl rounded-lg border p-3 text-sm text-muted-foreground" data-storage-hint>{persistenceHint}</p>}
          <ul className="grid gap-2">{trusted.map((d) => <li key={`${d.userId}:${d.id}`} className="flex min-w-0 flex-wrap items-center gap-2 rounded-lg border p-3"><div className="min-w-0 flex-1"><p className="text-sm">{d.userId === userId ? "Your device" : personName(d.userId)} · {d.id === client?.deviceId ? "This browser" : d.id.slice(0, 8)}</p><p className="break-all text-xs text-muted-foreground">{d.fingerprint}</p><p className="text-xs">{d.verified ? "Verified" : "Not verified"}</p></div>{!d.verified && <Button disabled={busy || !client} onClick={() => void run(() => client!.startVerification(d.userId, d.id))}>Verify device {d.id.slice(0, 8)}</Button>}{d.userId === userId && d.id !== client?.deviceId && d.verified && <Button variant="outline" disabled={busy} onClick={() => void run(async () => { await client!.shareHistory(d.id); setStatus("Recovery transfer queued; waiting for the other device to confirm storage."); })}>Share identity and history</Button>}{d.userId === userId && d.id !== client?.deviceId && <Button variant="destructive" disabled={busy} onClick={() => void run(async () => { await dmFetch("/api/dm", { action: "revoke", id: d.id }); })}>Revoke device {d.id.slice(0, 8)}</Button>}</li>)}</ul>
          {devices.filter((d) => d.revoked).map((d) => <p key={d.id} className="text-xs text-muted-foreground">Revoked device {d.id.slice(0, 8)}</p>)}
          <p className="text-xs" role="status">{transfers.length ? `${transfers.length} encrypted transfer(s) awaiting storage confirmation.` : "No pending encrypted transfers."}</p>
          {transfers.map((transfer) => <div key={transfer.id} className="flex flex-wrap items-center gap-2 text-xs"><span>To device {transfer.target.slice(0, 8)} · {transfer.attempts >= 8 ? "Automatic retries paused" : "Waiting for receiver"}. Already sent copies may still arrive after retries stop.</span><Button variant="outline" size="sm" disabled={busy} onClick={() => void run(() => client!.retryTransfer(transfer.id))}>Retry encrypted transfer</Button><Button variant="outline" size="sm" disabled={busy} onClick={() => void run(() => client!.cancelTransfer(transfer.id))}>Stop transfer retries</Button></div>)}
          <p className="max-w-3xl text-sm">A recovery file opens a separate read-only archive of up to {MAX_HISTORY_COPIES} recent messages this browser loaded and authenticated, within a 3.5 MB source-copy limit. Load earlier messages before creating a backup if you need them. Identity recovery is a separate explicit step. Keep the file private: anyone with it and access to its encrypted backup can read the archive. Password reset cannot recover messages.</p>
          <div className="flex flex-wrap items-center gap-3"><Button disabled={busy || !client} onClick={() => void run(async () => {
            const recovery = await client!.createBackup();
            if (recoveryDownload) URL.revokeObjectURL(recoveryDownload);
            setRecoveryDownload(URL.createObjectURL(new Blob([JSON.stringify(recovery, null, 2)], { type: "application/json" })));
            await backups();
          })}>Create encrypted recovery backup</Button>{recoveryDownload && <a className="font-medium underline" href={recoveryDownload} download="opendiscord-private-recovery.json">Download your private recovery file</a>}</div>
          <IdentityReset userId={userId} />
          <label className="grid max-w-lg gap-1 text-sm">Open encrypted recovery archive<input className={field} type="file" accept="application/json,.json" disabled={busy || !client} onChange={(e) => { const file = e.target.files?.[0]; if (file) void run(async () => { if (file.size > 8192) throw new Error("Choose a private recovery file, not a data export."); await client!.restoreBackup(JSON.parse(await file.text())); setStatus("Recovery archive opened. Restore your identity separately if needed."); }); e.currentTarget.value = ""; }} /></label>
          {pendingIdentity && <Button variant="outline" disabled={busy} onClick={() => { if (window.confirm("Restore your current encryption identity from this trusted recovery source? The public master key must match your current identity. This does not mark archived messages as newly verified.")) void run(() => client!.restorePendingIdentity()); }}>Restore current encryption identity</Button>}
          {backupList.length > 0 && <ul aria-label="Encrypted backups" className="grid gap-2">{backupList.map((b) => <li key={b.id} className="flex flex-wrap items-center gap-2 text-xs"><time>{new Date(b.createdAt).toLocaleString()}</time><span>{b.id.slice(0, 8)}</span><Button variant="destructive" size="sm" disabled={busy} onClick={() => void run(async () => { await dmFetch("/api/dm/backups", { id: b.id }, undefined, "DELETE"); await backups(); })}>Delete encrypted backup</Button></li>)}</ul>}
        </section>}
        {archives.length > 0 && <section aria-label="Recovered history archives" className="grid gap-3 border-b p-4"><h2 className="font-semibold">Recovered history — read-only copies</h2><p className="max-w-3xl text-sm text-muted-foreground">These copies were authenticated by your source device when recorded and recovered from your private file or verified device transfer. They are not live SDK-verified events on this browser. Source dates and server event IDs do not prove freshness or delivery time.</p>{archives.map((archive) => <details key={archive.id} className="rounded-lg border p-3"><summary className="cursor-pointer text-sm">View recovered archive · {archive.messages.length} copies · {new Date(archive.createdAt).toLocaleString()}</summary><p className="mt-2 break-all text-xs text-muted-foreground">Source device {archive.sourceDevice} · fingerprint {archive.sourceFingerprint} · archive {archive.id}</p><ol aria-label="Recovered private history" className="mt-3 grid gap-2">{archive.messages.map((entry) => <li key={entry.envelope.id} className="rounded border p-3"><p className="break-all text-xs text-muted-foreground">Conversation {entry.envelope.conversationId} · {entry.envelope.senderId === userId ? "You" : personName(entry.envelope.senderId)} · authenticated on source {new Date(entry.verifiedAt).toLocaleString()}</p><p className="whitespace-pre-wrap break-words">{entry.message.body}</p></li>)}</ol><Button variant="outline" size="sm" className="mt-3" disabled={busy} onClick={() => void run(() => client!.removeArchive(archive.id))}>Remove this local archive</Button></details>)}</section>}
        {verifications.filter((v) => !v.cancelled).map((v) => <section key={v.flowId} aria-label="Device verification" className="m-4 grid gap-3 rounded-lg border border-brand-mint/50 p-4"><h2 className="font-semibold">Verify {v.userId === userId ? "your other device" : personName(v.userId)}</h2><p className="text-xs">Account: {v.userId} · Other device: {v.deviceId.slice(0, 8)} · Flow: {v.flowId.slice(0, 8)}</p>{v.done ? <p role="status">Verification complete.</p> : <><p>Compare these numbers on both devices over a separate trusted channel. Confirm only if all three match.</p>{v.decimals ? <p className="text-xl font-semibold tabular-nums" data-verification-code>{v.decimals.join(" · ")}</p> : <p role="status">Waiting for the other device…</p>}<div className="flex flex-wrap gap-2">{v.requested && <Button disabled={busy} onClick={() => void run(() => client!.verificationAction(v.userId, v.flowId, "accept"))}>Accept verification</Button>}{v.ready && !v.decimals && <Button disabled={busy} onClick={() => void run(() => client!.verificationAction(v.userId, v.flowId, "start"))}>Show verification numbers</Button>}{v.decimals && !v.confirmed && <Button disabled={busy} onClick={() => void run(() => client!.verificationAction(v.userId, v.flowId, "confirm"))}>The numbers match</Button>}{v.confirmed && <p role="status">Waiting for their confirmation…</p>}<Button variant="outline" disabled={busy} onClick={() => void run(() => client!.verificationAction(v.userId, v.flowId, "cancel"))}>Cancel verification</Button></div></>}</section>)}
        {!active && <div className="grid gap-3 p-6">
          <h2 className="text-lg font-semibold">{missingRequest ? (targetIsFriend ? "Opening your conversation…" : "Start a private conversation") : "Your private messages"}</h2>
          <p className="max-w-lg text-muted-foreground">{missingRequest && !targetIsFriend ? "You're not friends yet, so they'll get a message request first. Messages are end-to-end encrypted." : "Pick a conversation in the sidebar, or message a friend from Home. Messages are end-to-end encrypted."}</p>
          {missingRequest && !targetIsFriend && <Button className="w-fit" disabled={!ready || busy} onClick={() => void run(() => request(target))}>Send message request</Button>}
        </div>}
        {active && <>
          {active.status === "pending" && <div className="grid gap-3 p-4"><p>{active.requestedBy === userId ? "Your message request is waiting for acceptance." : "Accept this request to begin an encrypted conversation."}</p>{active.requestedBy !== userId && <div className="flex gap-2">{(["accepted", "rejected"] as const).map((s) => <Button key={s} disabled={busy || active.blocked} variant={s === "accepted" ? "default" : "outline"} onClick={() => void run(async () => { await dmFetch("/api/dm", { action: "respond", id: active.id, status: s }); })}>{s === "accepted" ? "Accept message request" : "Decline request"}</Button>)}</div>}</div>}
          {hasMore && <Button className="m-4" variant="outline" disabled={busy} onClick={() => void run(loadEarlier)}>Load earlier encrypted messages</Button>}
          {active.status === "accepted" && group && <div className="grid gap-2 px-4 pt-6 pb-2"><GroupAvatars members={active.members} /><h2 className="text-2xl font-semibold text-zinc-50">{active.peerName}</h2><p className="text-sm text-muted-foreground">This is the beginning of the end-to-end encrypted group with {active.members.filter((m) => !m.left).map((m) => m.name).join(", ")}. People added later cannot read earlier messages; people who leave cannot read later ones.</p></div>}
          {active.status === "accepted" && !group && <div className="grid gap-2 px-4 pt-6 pb-2"><PresenceAvatar userId={active.peerId} name={active.peerName} avatar={active.peerAvatar} size="lg" status={null} /><h2 className="text-2xl font-semibold text-zinc-50">{active.peerName}</h2><p className="text-sm text-muted-foreground">This is the beginning of your end-to-end encrypted conversation with {active.peerName}.{peerVerified ? "" : " Verify their device in Devices and recovery to confirm nobody is in between."}</p></div>}
          <div role="log" aria-label={group ? `Group conversation ${active.peerName}` : `Private conversation with ${active.peerName}`}><ol className="grid py-2">{messages.map((m) => <PrivateMessageItem key={m.id} message={m} authorName={m.own ? userName : authorOf(m.senderId)?.name ?? "Former member"} authorAvatar={m.own ? userAvatar : authorOf(m.senderId)?.avatar ?? null} onError={setError} openAttachment={openAttachment} onReport={() => { setReport(m); setReportReason(""); setReportDisclose(false); requestAnimationFrame(() => reportTextarea.current?.focus()); }} />)}</ol></div>
        </>}
        {report && <section role="dialog" aria-modal="false" aria-label="Report private message" className="m-4 grid gap-3 rounded-lg border p-4"><h2 className="font-semibold">Report private message</h2><p>Your reason is shared with instance moderators. Including the selected message is optional and explicitly discloses that text.</p><label>Reason<textarea ref={reportTextarea} autoFocus className={field} maxLength={512} value={reportReason} onChange={(e) => setReportReason(e.target.value)} /></label>{!!report.body && <label className="flex gap-2"><input type="checkbox" checked={reportDisclose} onChange={(e) => setReportDisclose(e.target.checked)} />Include this selected message</label>}{reportDisclose && <blockquote className="whitespace-pre-wrap break-words rounded border p-3">{report.body}</blockquote>}<div className="flex gap-2"><Button disabled={busy || reportReason.trim().length < 3} onClick={() => void run(async () => { await dmFetch("/api/dm", { action: "report", id: report.id, reason: reportReason, excerpt: reportDisclose && report.body ? report.body : null }); setReport(null); })}>Submit report</Button><Button variant="outline" onClick={() => setReport(null)}>Cancel</Button></div></section>}
      </div>
      {active?.status === "accepted" && !active.blocked && <form className="px-4 pb-4" onSubmit={(e) => { e.preventDefault(); if (client && !busy && (text.trim() || files.length)) void run(async () => { await sendNow(active, text, files); setText(""); setFiles([]); refocus.current = true; }); }}>
        {files.length > 0 && <ul aria-label="Encrypted attachments" className="flex flex-wrap gap-2 pb-2">{files.map((file, index) => <li key={`${file.name}:${index}`} className="flex max-w-60 items-center gap-1 rounded-md bg-white/5 py-1 pr-1 pl-2 text-xs"><FileIcon aria-hidden className="size-4 shrink-0" /><span className="min-w-0 break-all">{shortFilename(file.name, 32)}</span><Button type="button" variant="ghost" size="icon-xs" aria-label={`Remove ${file.name}`} disabled={busy} onClick={() => setFiles((list) => list.filter((_, i) => i !== index))}><XIcon /></Button></li>)}</ul>}
        <div className="flex items-end gap-1 rounded-lg bg-white/5 px-2 py-1.5">
          {attachmentsEnabled && <>
            <input ref={fileInput} type="file" multiple hidden onChange={(e) => {
              const picked = [...(e.target.files ?? [])];
              e.target.value = "";
              const rejected = picked.find((file) => file.size === 0 || file.size > DM_MAX_ATTACHMENT_BYTES);
              if (rejected) { setError(`${rejected.name}: files must be between 1 byte and ${DM_MAX_ATTACHMENT_BYTES / 1024 / 1024} MB.`); return; }
              setFiles((list) => [...list, ...picked].slice(0, DM_MAX_ATTACHMENTS));
            }} />
            <Button type="button" variant="ghost" size="icon" aria-label={`Attach encrypted files (up to ${DM_MAX_ATTACHMENTS}, ${DM_MAX_ATTACHMENT_BYTES / 1024 / 1024} MB each)`} disabled={!client || busy || files.length >= DM_MAX_ATTACHMENTS} onClick={() => fileInput.current?.click()}><PaperclipIcon /></Button>
          </>}
          <EmojiSelector returnFocusTo={textarea}
            trigger={<Button type="button" variant="ghost" size="icon" aria-label="Choose emoji" disabled={!client || busy}><SmilePlusIcon /></Button>}
            onPick={(emoji) => {
              const result = insertEmoji(text, emoji, textarea.current?.selectionStart ?? text.length, textarea.current?.selectionEnd ?? text.length, DM_MAX_TEXT);
              if (result) { pendingCaret.current = result.caret; setText(result.value); }
            }} />
          <GifSelector returnFocusTo={textarea} disabled={!client || busy}
            onPick={(url) => {
              if (!client || busy) return;
              void run(() => sendNow(active, url));
            }} />
          <label className="sr-only" htmlFor="private-message">Encrypted message</label>
          <textarea ref={textarea} id="private-message" rows={1} className="max-h-48 min-h-8 flex-1 resize-none bg-transparent px-1 py-1.5 text-sm outline-none placeholder:text-zinc-500" maxLength={DM_MAX_TEXT} value={text} onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); e.currentTarget.form?.requestSubmit(); } }}
            disabled={!client || busy} placeholder={group ? `Message ${active.peerName}` : `Message @${active.peerName}`} />
          <Button type="submit" variant="ghost" size="icon" disabled={!client || busy || (!text.trim() && !files.length)}><SendHorizontalIcon aria-hidden /><span className="sr-only">Send encrypted message</span></Button>
        </div>
      </form>}
    </section>
    {active && !group && <PeerProfile userId={userId} peerId={active.peerId} />}
  </div>;
}
