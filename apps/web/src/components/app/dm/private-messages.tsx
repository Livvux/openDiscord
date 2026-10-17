"use client";

import Link from "next/link";
import { CopyIcon, FlagIcon, HashIcon, SmilePlusIcon } from "lucide-react";
import { EmojiSelector } from "../emoji-selector";
import { GifSelector } from "../gif-selector";
import { GifEmbed } from "../gif-embed";
import { gifSource } from "@/lib/gifs";
import { EmojiText } from "../emoji-text";
import { insertEmoji } from "@/lib/emoji";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { blockUser, unblockUser } from "@/app/app/actions";
import { Button } from "@/components/ui/button";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from "@/components/ui/context-menu";
import { UserContextMenu } from "../user-context-menu";
import { IdentityReset } from "./identity-reset";
import { DM_MAX_TEXT, type DeviceView, type DirectConversation, type DirectEnvelope } from "@/lib/dm/contracts";
import { MAX_HISTORY_COPIES, type HistoryArchive } from "@/lib/dm/history";
import { dmFetch, enrollNewDmDevice, privateMessaging, type PrivateMessaging, type TrustedDevice, type VerificationView } from "@/lib/dm/client";

type MessageView = Awaited<ReturnType<PrivateMessaging["decrypt"]>>[number];
const field = "w-full rounded-lg border bg-background px-3 py-2 text-sm focus-visible:outline-2 focus-visible:outline-ring";
const errorText = (error: unknown) => error instanceof Error ? error.message : "Private messaging could not complete this action.";

/** These actions use only text already decrypted in this browser. Reporting keeps its explicit disclosure step. */
function PrivateMessageItem({ message, peerName, onError, onReport }: {
  message: MessageView;
  peerName: string;
  onError: (error: string) => void;
  onReport: () => void;
}) {
  const [notice, setNotice] = useState<string | null>(null);
  const handoffFocus = useRef(false);
  async function copy(value: string, success: string) {
    try {
      await navigator.clipboard.writeText(value);
      setNotice(success);
    } catch {
      onError("Couldn't copy. Your browser may not allow clipboard access.");
    }
  }
  return (
    <ContextMenu onOpenChange={(open) => { if (open) handoffFocus.current = false; }}>
      <ContextMenuTrigger render={<li />} className={`max-w-2xl rounded-lg border p-3 outline-none focus-visible:ring-2 focus-visible:ring-ring ${message.own ? "ml-auto bg-muted/40" : "mr-auto"}`}>
        <p className="mb-1 text-xs text-muted-foreground">{message.own ? "You" : peerName} · <time dateTime={message.createdAt}>{new Date(message.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time></p>
        {/* A GIF embed can't live inside <p>; text keeps <p>, which native acceptance reads. */}
        {message.body && gifSource(message.body) ? <div className="whitespace-pre-wrap break-words"><GifEmbed url={message.body} /></div> : <p className="whitespace-pre-wrap break-words" data-dm-failure-stage={message.diagnostic?.stage} data-dm-failure-code={message.diagnostic?.code} data-dm-shield-color={message.diagnostic?.shieldColor} data-dm-shield-code={message.diagnostic?.shieldCode}>{message.body ? <EmojiText text={message.body} /> : message.error}</p>}
        {!message.own && message.body && <Button className="mt-2" variant="ghost" size="sm" onClick={onReport}>Report private message</Button>}
        {notice && <p role="status" className="mt-1 text-xs text-muted-foreground">{notice}</p>}
      </ContextMenuTrigger>
      <ContextMenuContent aria-label="Private message actions" finalFocus={() => handoffFocus.current ? false : true}>
        {message.body && <ContextMenuItem onClick={() => void copy(message.body!, "Message text copied.")}><CopyIcon aria-hidden />Copy text</ContextMenuItem>}
        <ContextMenuItem onClick={() => void copy(message.id, "Message ID copied.")}><HashIcon aria-hidden />Copy message ID</ContextMenuItem>
        {!message.own && message.body && <><ContextMenuSeparator /><ContextMenuItem onClick={() => { handoffFocus.current = true; onReport(); }}><FlagIcon aria-hidden />Report private message</ContextMenuItem></>}
      </ContextMenuContent>
    </ContextMenu>
  );
}

export function PrivateMessages({ userId, target }: { userId: string; target?: string }) {
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
  const [archives, setArchives] = useState<HistoryArchive[]>([]);
  const [transfers, setTransfers] = useState<Awaited<ReturnType<PrivateMessaging["pendingTransfers"]>>>([]);
  const [pendingIdentity, setPendingIdentity] = useState(false);
  const [backupList, setBackupList] = useState<{ id: string; createdAt: string }[]>([]);
  const [recoveryDownload, setRecoveryDownload] = useState<string | null>(null);
  const [report, setReport] = useState<MessageView | null>(null);
  const reportTextarea = useRef<HTMLTextAreaElement>(null);
  const [reportReason, setReportReason] = useState("");
  const [reportDisclose, setReportDisclose] = useState(false);
  const active = conversations.find((c) => c.id === selected);
  const loading = useRef(false);
  const selectedRef = useRef(selected);
  const history = useRef<DirectEnvelope[]>([]);
  useEffect(() => { selectedRef.current = selected; history.current = []; }, [selected]);
  const ready = !!client;

  useEffect(() => {
    let alive = true;
    privateMessaging(userId).then((value) => { if (alive) { setClient(value); setStatus("Encrypted messaging ready."); } }).catch((e: unknown) => { if (alive) { setError(errorText(e)); setStatus("Encryption is unavailable. No plaintext messages will be sent."); } });
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
      if (!selection && target) { const matching = listing.conversations.find((c) => c.peerId === target); if (matching) setSelected(matching.id); }
      const current = listing.conversations.find((c) => c.id === selection);
      await client.sync(current && !current.blocked && current.status === "accepted" ? current.peerId : undefined);
      await client.acceptStartedVerifications();
      const own = await client.devices(userId);
      const peer = current && !current.blocked && current.status === "accepted" ? await client.devices(current.peerId) : [];
      if (selection !== selectedRef.current) return;
      setTrusted([...own, ...peer]);
      setVerifications(client.verifications().filter((v) => v.userId === userId || v.userId === current?.peerId));
      setArchives(await client.archives()); setPendingIdentity(client.hasPendingIdentity()); setTransfers(await client.pendingTransfers());
      if (current && selection === selectedRef.current) {
        const timeline = await dmFetch<{ messages: DirectEnvelope[]; hasMore: boolean }>(`/api/dm?conversation=${current.id}`);
        const all = [...new Map([...history.current, ...timeline.messages].map((m) => [m.id, m])).values()].sort((a, b) => a.id.localeCompare(b.id));
        const decoded = await client.decrypt(all, current.id, current.peerId);
        if (selection === selectedRef.current) { history.current = all; setMessages(decoded); setEnvelopes(all); if (all.length <= 50) setHasMore(timeline.hasMore); }
      }
      setStatus("Encrypted messaging ready.");
    } catch (e) { setError(errorText(e)); setStatus("Connection or verification needs attention."); }
    finally { loading.current = false; }
  }, [client, userId, target]);
  useEffect(() => {
    const initial = window.setTimeout(() => { void refresh(); }, 0);
    const timer = window.setInterval(() => { if (document.visibilityState === "visible") void refresh(); }, 3000);
    return () => { window.clearTimeout(initial); window.clearInterval(timer); };
  }, [refresh, selected]);

  async function run(fn: () => Promise<void>) {
    setBusy(true); setError(null);
    try { await fn(); await refresh(); } catch (e) { setError(errorText(e)); }
    finally { setBusy(false); }
  }
  async function request(targetId: string) {
    const response = await dmFetch<{ id: string }>("/api/dm", { action: "request", target: targetId });
    setText(""); selectedRef.current = response.id; setSelected(response.id); setVerifications([]); setTrusted([]); setSecurity(true);
  }
  async function backups() { const data = await dmFetch<{ backups: typeof backupList }>("/api/dm/backups"); setBackupList(data.backups); }
  async function loadEarlier() {
    if (!client || !active || !envelopes.length) return;
    const data = await dmFetch<{ messages: DirectEnvelope[]; hasMore: boolean }>(`/api/dm?conversation=${active.id}&before=${envelopes[0].id}`);
    const all = [...data.messages, ...envelopes];
    const decoded = await client.decrypt(all, active.id, active.peerId);
    if (selectedRef.current !== active.id) return;
    history.current = all;
    setMessages(decoded); setEnvelopes(all); setHasMore(data.hasMore);
  }
  const peersReady = active && trusted.some((d) => d.userId === active.peerId) && trusted.every((d) => d.verified);
  return <div className="flex min-h-0 flex-1 flex-col md:flex-row">
    <aside aria-label="Direct conversations" className="max-h-48 w-full shrink-0 overflow-y-auto border-b p-3 md:max-h-none md:w-64 md:border-r md:border-b-0">
      <h2 className="mb-2 font-semibold">Private messages</h2>
      <Button variant="outline" className="mb-3" onClick={() => { setSecurity((v) => !v); void run(backups); }}>Devices and recovery</Button>
      {target && !conversations.some((c) => c.peerId === target) && <Button disabled={!ready || busy} onClick={() => void run(() => request(target))}>Send message request</Button>}
      {!conversations.length && <p className="text-xs text-muted-foreground">Start from the message button beside a community member&apos;s message. There is no public user directory.</p>}
      <ul className="grid gap-1">{conversations.map((c) => <li key={c.id}><UserContextMenu userId={c.peerId} name={c.peerName} currentUserId={userId} blocked={c.ownBlocked} onChanged={() => void refresh()} onError={setError}><button className={`w-full rounded-lg px-3 py-2 text-left ${c.id === selected ? "bg-muted" : "hover:bg-muted/50"}`} onClick={() => { if (c.id !== selected) setText(""); selectedRef.current = c.id; setSelected(c.id); setVerifications([]); setTrusted([]); setReport(null); setMessages([]); setEnvelopes([]); setHasMore(false); }} aria-current={c.id === selected ? "page" : undefined}><span className="block truncate font-medium">{c.peerName}</span><span className="text-xs text-muted-foreground">{c.blocked ? "Unavailable" : c.status === "accepted" ? "Encrypted conversation" : c.status === "pending" ? c.requestedBy === userId ? "Request sent" : "Message request" : "Request declined"}</span></button></UserContextMenu></li>)}</ul>
    </aside>
    <section className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="border-b px-4 py-3"><p className="text-xs text-muted-foreground" role="status">{status}</p>{error && <p role="alert" className="mt-2 text-sm text-destructive">{error}</p>}{!client && error && <div className="mt-3 flex flex-wrap gap-2"><Button variant="outline" onClick={() => window.location.reload()}>Retry encryption</Button><Button variant="outline" disabled={busy} onClick={() => { if (window.confirm("Enroll a new encryption device? This revokes this browser's old device. Recover history with your private recovery file or another verified device. Existing contacts must verify the new device.")) void run(async () => { await enrollNewDmDevice(userId); window.location.reload(); }); }}>Enroll a new browser device</Button></div>}</div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {security && <section aria-label="Encryption settings" className="grid gap-4 border-b p-4">
          <h2 className="font-semibold">Verified devices and recovery</h2>
          <p className="max-w-3xl text-sm text-muted-foreground">Message content is encrypted in your browser. Verify every active device with the person over another trusted channel. The server sees participants and timing. A compromised browser or modified web application can access messages. <Link href="https://github.com/Livvux/openDiscord/blob/main/docs/PRIVATE-MESSAGES.md" className="underline">Privacy details</Link></p>
          <p className="break-all text-xs">This device: <code>{client?.deviceId ?? "Opening…"}</code></p>
          <ul className="grid gap-2">{trusted.map((d) => <li key={`${d.userId}:${d.id}`} className="flex min-w-0 flex-wrap items-center gap-2 rounded-lg border p-3"><div className="min-w-0 flex-1"><p className="text-sm">{d.userId === userId ? "Your device" : active?.peerName} · {d.id === client?.deviceId ? "This browser" : d.id.slice(0, 8)}</p><p className="break-all text-xs text-muted-foreground">{d.fingerprint}</p><p className="text-xs">{d.verified ? "Verified" : "Verification required"}</p></div>{!d.verified && <Button disabled={busy || !client} onClick={() => void run(() => client!.startVerification(d.userId, d.id))}>Verify device {d.id.slice(0, 8)}</Button>}{d.userId === userId && d.id !== client?.deviceId && d.verified && <Button variant="outline" disabled={busy} onClick={() => void run(async () => { await client!.shareHistory(d.id); setStatus("Recovery transfer queued; waiting for the other device to confirm storage."); })}>Share identity and history</Button>}{d.userId === userId && d.id !== client?.deviceId && <Button variant="destructive" disabled={busy} onClick={() => void run(async () => { await dmFetch("/api/dm", { action: "revoke", id: d.id }); })}>Revoke device {d.id.slice(0, 8)}</Button>}</li>)}</ul>
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
        {archives.length > 0 && <section aria-label="Recovered history archives" className="grid gap-3 border-b p-4"><h2 className="font-semibold">Recovered history — read-only copies</h2><p className="max-w-3xl text-sm text-muted-foreground">These copies were authenticated by your source device when recorded and recovered from your private file or verified device transfer. They are not live SDK-verified events on this browser. Source dates and server event IDs do not prove freshness or delivery time.</p>{archives.map((archive) => <details key={archive.id} className="rounded-lg border p-3"><summary className="cursor-pointer text-sm">View recovered archive · {archive.messages.length} copies · {new Date(archive.createdAt).toLocaleString()}</summary><p className="mt-2 break-all text-xs text-muted-foreground">Source device {archive.sourceDevice} · fingerprint {archive.sourceFingerprint} · archive {archive.id}</p><ol aria-label="Recovered private history" className="mt-3 grid gap-2">{archive.messages.map((entry) => <li key={entry.envelope.id} className="rounded border p-3"><p className="break-all text-xs text-muted-foreground">Conversation {entry.envelope.conversationId} · {entry.envelope.senderId === userId ? "You" : conversations.find((c) => c.peerId === entry.envelope.senderId)?.peerName ?? entry.envelope.senderId} · authenticated on source {new Date(entry.verifiedAt).toLocaleString()}</p><p className="whitespace-pre-wrap break-words">{entry.message.body}</p></li>)}</ol><Button variant="outline" size="sm" className="mt-3" disabled={busy} onClick={() => void run(() => client!.removeArchive(archive.id))}>Remove this local archive</Button></details>)}</section>}
        {verifications.filter((v) => !v.cancelled).map((v) => <section key={v.flowId} aria-label="Device verification" className="m-4 grid gap-3 rounded-lg border border-brand-mint/50 p-4"><h2 className="font-semibold">Verify {v.userId === userId ? "your other device" : conversations.find((c) => c.peerId === v.userId)?.peerName ?? v.userId}</h2><p className="text-xs">Account: {v.userId} · Other device: {v.deviceId.slice(0, 8)} · Flow: {v.flowId.slice(0, 8)}</p>{v.done ? <p role="status">Verification complete.</p> : <><p>Compare these numbers on both devices over a separate trusted channel. Confirm only if all three match.</p>{v.decimals ? <p className="text-xl font-semibold tabular-nums" data-verification-code>{v.decimals.join(" · ")}</p> : <p role="status">Waiting for the other device…</p>}<div className="flex flex-wrap gap-2">{v.requested && <Button disabled={busy} onClick={() => void run(() => client!.verificationAction(v.userId, v.flowId, "accept"))}>Accept verification</Button>}{v.ready && !v.decimals && <Button disabled={busy} onClick={() => void run(() => client!.verificationAction(v.userId, v.flowId, "start"))}>Show verification numbers</Button>}{v.decimals && !v.confirmed && <Button disabled={busy} onClick={() => void run(() => client!.verificationAction(v.userId, v.flowId, "confirm"))}>The numbers match</Button>}{v.confirmed && <p role="status">Waiting for their confirmation…</p>}<Button variant="outline" disabled={busy} onClick={() => void run(() => client!.verificationAction(v.userId, v.flowId, "cancel"))}>Cancel verification</Button></div></>}</section>)}
        {!active && <div className="p-6"><h2 className="text-lg font-semibold">Private by conversation</h2><p className="mt-2 max-w-lg text-muted-foreground">Select a conversation or send a message request from a community. Messages stay unavailable until you verify the participating devices.</p></div>}
        {active && <><header className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-3"><h2 className="font-semibold"><UserContextMenu userId={active.peerId} name={active.peerName} currentUserId={userId} blocked={active.ownBlocked} onChanged={() => void refresh()} onError={setError} openOnClick><button type="button" aria-label={`Actions for ${active.peerName}`} className="rounded hover:underline focus-visible:outline-2 focus-visible:outline-ring">{active.peerName}</button></UserContextMenu></h2><Button variant="outline" disabled={busy} onClick={() => void run(async () => { const result = await (active.ownBlocked ? unblockUser(active.peerId) : blockUser(active.peerId)); if (!result.ok) throw new Error(result.error); })}>{active.ownBlocked ? "Unblock person" : "Block person"}</Button></header>
          {active.status === "pending" && <div className="grid gap-3 p-4"><p>{active.requestedBy === userId ? "Your message request is waiting for acceptance." : "Accept this request to begin an encrypted conversation."}</p>{active.requestedBy !== userId && <div className="flex gap-2">{(["accepted", "rejected"] as const).map((s) => <Button key={s} disabled={busy || active.blocked} variant={s === "accepted" ? "default" : "outline"} onClick={() => void run(async () => { await dmFetch("/api/dm", { action: "respond", id: active.id, status: s }); setSecurity(true); })}>{s === "accepted" ? "Accept message request" : "Decline request"}</Button>)}</div>}</div>}
          {hasMore && <Button className="m-4" variant="outline" disabled={busy} onClick={() => void run(loadEarlier)}>Load earlier encrypted messages</Button>}
          <ol role="log" aria-label={`Private conversation with ${active.peerName}`} className="grid gap-3 p-4">{messages.map((m) => <PrivateMessageItem key={m.id} message={m} peerName={active.peerName} onError={setError} onReport={() => { setReport(m); setReportReason(""); setReportDisclose(false); requestAnimationFrame(() => reportTextarea.current?.focus()); }} />)}</ol>
        </>}
        {report && <section role="dialog" aria-modal="false" aria-label="Report private message" className="m-4 grid gap-3 rounded-lg border p-4"><h2 className="font-semibold">Report private message</h2><p>Your reason is shared with instance moderators. Including the selected message is optional and explicitly discloses that text.</p><label>Reason<textarea ref={reportTextarea} autoFocus className={field} maxLength={512} value={reportReason} onChange={(e) => setReportReason(e.target.value)} /></label><label className="flex gap-2"><input type="checkbox" checked={reportDisclose} onChange={(e) => setReportDisclose(e.target.checked)} />Include this selected message</label>{reportDisclose && <blockquote className="whitespace-pre-wrap break-words rounded border p-3">{report.body}</blockquote>}<div className="flex gap-2"><Button disabled={busy || reportReason.trim().length < 3} onClick={() => void run(async () => { await dmFetch("/api/dm", { action: "report", id: report.id, reason: reportReason, excerpt: reportDisclose ? report.body : null }); setReport(null); })}>Submit report</Button><Button variant="outline" onClick={() => setReport(null)}>Cancel</Button></div></section>}
      </div>
      {active?.status === "accepted" && !active.blocked && <form className="grid gap-2 border-t p-4" onSubmit={(e) => { e.preventDefault(); if (client && text.trim()) void run(async () => { await client.send(active.id, active.peerId, text); setText(""); }); }}>
        {!peersReady && <p className="text-xs text-muted-foreground">Verify all active devices in <button type="button" className="underline" onClick={() => setSecurity(true)}>Devices and recovery</button> before sending.</p>}
        <label className="sr-only" htmlFor="private-message">Encrypted message</label><textarea ref={textarea} id="private-message" className={`${field} min-h-20 resize-y`} maxLength={DM_MAX_TEXT} value={text} onChange={(e) => setText(e.target.value)} disabled={!client || busy} placeholder="Write an encrypted message" /><div className="flex items-center justify-between"><div className="flex items-center gap-1"><EmojiSelector returnFocusTo={textarea}
          trigger={<Button type="button" variant="ghost" size="icon" aria-label="Choose emoji" disabled={!client || busy}><SmilePlusIcon /></Button>}
          onPick={(emoji) => {
            const result = insertEmoji(text, emoji, textarea.current?.selectionStart ?? text.length, textarea.current?.selectionEnd ?? text.length, DM_MAX_TEXT);
            if (result) { pendingCaret.current = result.caret; setText(result.value); }
          }} />
          <GifSelector returnFocusTo={textarea} disabled={!client || busy || !peersReady}
            onPick={(url) => {
              if (!client || !active || busy || !peersReady) return;
              void run(async () => { await client.send(active.id, active.peerId, url); });
            }} />
          </div><Button type="submit" disabled={!client || busy || !peersReady || !text.trim()}>Send encrypted message</Button></div>
      </form>}
    </section>
  </div>;
}
