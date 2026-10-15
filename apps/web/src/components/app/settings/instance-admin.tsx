"use client";

import Link from "next/link";
import { useId, useState, useTransition } from "react";
import * as actions from "@/app/app/admin/actions";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import type { ActionResult } from "@/server/errors";
import type { AdminDashboard } from "@/server/instance-admin";

export function AdminUnlock({ enabled }: { enabled: boolean }) {
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  return (
    <section className="mx-auto grid max-w-lg gap-4 px-6 py-10">
      <h2 className="text-xl font-semibold">Secure instance administration</h2>
      <p className="text-muted-foreground">These rights apply across the instance, independently of community roles. All administrative changes and reported-content access are audited.</p>
      {!enabled ? <><p>Two-factor authentication is required before you can use these rights.</p><Link href="/app/settings" className="text-brand-mint underline">Set up an authenticator app</Link></> : (
        <form className="grid gap-3" onSubmit={(event) => {
          event.preventDefault();
          const code = String(new FormData(event.currentTarget).get("code")).replace(/\s/g, "");
          startTransition(async () => {
            const result = await actions.verifyAdmin(code);
            if (!result.ok) setError(result.error);
          });
        }}>
          <Label htmlFor="admin-code">Authenticator code</Label>
          <Input id="admin-code" name="code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} required autoFocus />
          <p className="text-xs text-muted-foreground">Confirm a code to unlock administration in this session for 15 minutes.</p>
          {error && <p role="alert" className="text-destructive">{error}</p>}
          <Button type="submit" disabled={pending}>Unlock administration</Button>
        </form>
      )}
    </section>
  );
}

function AdminAction({ label, description, action, extraLabel, extraType = "text" }: {
  label: string; description: string; extraLabel?: string; extraType?: "text" | "email";
  action: (reason: string, extra: string) => Promise<ActionResult<unknown>>;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  return <Dialog open={open} onOpenChange={(v) => { setOpen(v); setError(null); }}>
    <DialogTrigger render={<Button variant="outline" size="sm" />}>{label}</DialogTrigger>
    <DialogContent>
      <DialogHeader><DialogTitle>{label}</DialogTitle><DialogDescription>{description} This action and your reason are recorded in the instance audit log.</DialogDescription></DialogHeader>
      <form className="grid gap-3" onSubmit={(event) => {
        event.preventDefault();
        const data = new FormData(event.currentTarget);
        startTransition(async () => {
          const result = await action(String(data.get("reason")), String(data.get("extra") ?? ""));
          if (result.ok) setOpen(false); else setError(result.error);
        });
      }}>
        {extraLabel && <><Label htmlFor={`${id}-extra`}>{extraLabel}</Label><Input id={`${id}-extra`} name="extra" type={extraType} required maxLength={254} /></>}
        <Label htmlFor={`${id}-reason`}>Reason</Label>
        <Textarea id={`${id}-reason`} name="reason" required minLength={3} maxLength={512} />
        {error && <p role="alert" className="text-destructive">{error}</p>}
        <DialogFooter><Button type="submit" disabled={pending}>Confirm {label.toLowerCase()}</Button></DialogFooter>
      </form>
    </DialogContent>
  </Dialog>;
}
function Section({ id, title, children }: { id: string; title: string; children: React.ReactNode }) {
  return <section id={id} className="scroll-mt-4 space-y-4 border-t py-6" aria-labelledby={`${id}-title`}>
    <h2 id={`${id}-title`} className="text-lg font-semibold">{title}</h2>{children}
  </section>;
}
const date = (value: Date) => new Date(value).toISOString().replace("T", " ").slice(0, 19) + " UTC";

export function AdminPanel({ data, search, status }: { data: AdminDashboard; search: string; status: string }) {
  return <div className="mx-auto max-w-5xl space-y-5 px-4 py-6 sm:px-8">
    <div><h2 className="text-2xl font-semibold">Instance control</h2><p className="mt-2 text-muted-foreground">Manage accounts, communities and abuse across this instance. Community roles do not grant these rights.</p></div>
    <nav aria-label="Administration sections" className="flex flex-wrap gap-4 text-brand-mint">
      {[["users", "Users"], ["communities", "Communities"], ["reports", "Reports"], ["settings", "Instance settings"], ["admins", "Administrators"], ["audit", "Audit log"]].map(([id, label]) => <a key={id} href={`#${id}`} className="underline">{label}</a>)}
    </nav>
    <form className="flex flex-wrap items-end gap-2" action="/app/admin">
      <div className="grid flex-1 gap-2"><Label htmlFor="admin-search">Search users (name or email) and communities (name)</Label><Input id="admin-search" name="q" defaultValue={search} maxLength={100} /></div>
      <input type="hidden" name="status" value={status} /><Button type="submit" variant="outline">Search</Button>
    </form>
    <p className="text-xs text-muted-foreground">Showing up to 50 results per list and the latest 100 audit entries. Use search to narrow results.</p>
    <Section id="users" title="Users">
      {!data.users.length && <p>No matching users.</p>}
      <ul className="divide-y">{data.users.map((u) => <li key={u.id} className="grid gap-3 py-4 sm:grid-cols-[1fr_auto]">
        <div className="min-w-0"><p className="font-medium break-words">{u.name} {u.adminId && <span className="text-xs text-brand-mint">Instance admin</span>}</p><p className="break-all text-muted-foreground">{u.email}</p><p className="text-xs">{u.suspendedAt ? `Suspended: ${u.suspensionReason}` : "Active"} · {u.twoFactorEnabled ? "2FA enabled" : "2FA not enabled"}</p></div>
        <div className="flex flex-wrap items-center gap-2">
          {!u.adminId && <AdminAction label={u.suspendedAt ? "Unsuspend user" : "Suspend user"} description={`Account: ${u.email}. Suspending revokes all sessions and blocks access.`} action={(r) => actions.suspendUser(u.id, !u.suspendedAt, r)} />}
          <AdminAction label="Revoke sessions" description={`Sign out every device of ${u.email}.`} action={(r) => actions.revokeSessions(u.id, r)} />
        </div>
      </li>)}</ul>
    </Section>
    <Section id="communities" title="Communities">
      {!data.communities.length && <p>No matching communities.</p>}
      <ul className="divide-y">{data.communities.map((c) => <li key={c.id} className="grid gap-3 py-4 sm:grid-cols-[1fr_auto]">
        <div className="min-w-0"><p className="font-medium break-words">{c.name}</p><p className="break-all text-muted-foreground">Owner: {c.ownerEmail}</p><p className="text-xs">{c.suspendedAt ? `Suspended: ${c.suspensionReason}` : "Active"}</p></div>
        <div className="flex flex-wrap items-center gap-2">
          <AdminAction label={c.suspendedAt ? "Unsuspend community" : "Suspend community"} description={`Community: ${c.name}. Suspension blocks access and invitations for every member.`} action={(r) => actions.suspendCommunity(c.id, !c.suspendedAt, r)} />
          <AdminAction label="Transfer ownership" description={`Community: ${c.name}. The new owner must already be an active member.`} extraLabel="New owner's email" extraType="email" action={(r, email) => actions.transferCommunity(c.id, email, r)} />
        </div>
      </li>)}</ul>
    </Section>
    <Section id="reports" title="Abuse reports">
      <nav aria-label="Report status" className="flex flex-wrap gap-4">{["open", "dismissed", "removed"].map((s) => <Link key={s} className="capitalize underline" aria-current={s === status ? "page" : undefined} href={`/app/admin?q=${encodeURIComponent(search)}&status=${s}#reports`}>{s}</Link>)}</nav>
      <p className="text-xs text-muted-foreground">Message content stays hidden until you explicitly open it with a reason. Removing a reported community suspends it and preserves its data.</p>
      {!data.reports.length && <p>No {status} reports.</p>}
      <ul className="divide-y">{data.reports.map((r) => <ReportRow key={r.id} report={r} />)}</ul>
    </Section>
    <Section id="settings" title="Instance settings"><SettingsForm settings={data.settings} /></Section>
    <Section id="admins" title="Instance administrators">
      <p className="text-muted-foreground">Only instance administrators can grant these rights. The target account must have 2FA enabled. The last admin cannot be removed, suspended or deleted.</p>
      <ul className="space-y-3">{data.admins.map((u) => <li key={u.id} className="flex flex-wrap items-center justify-between gap-2"><span className="break-all">{u.email}</span><AdminAction label="Remove admin" description={`Remove instance rights from ${u.email}.`} action={(r) => actions.setAdmin(u.id, false, r)} /></li>)}</ul>
      {data.users.filter((u) => !u.adminId && !u.suspendedAt).map((u) => <div key={u.id} className="flex flex-wrap items-center justify-between gap-2"><span className="break-all text-muted-foreground">{u.email}</span><AdminAction label="Grant admin" description={`Grant full instance administrator rights to ${u.email}. Two-factor authentication must already be enabled.`} action={(r) => actions.setAdmin(u.id, true, r)} /></div>)}
    </Section>
    <Section id="audit" title="Instance audit log">
      <ol className="divide-y">{data.logs.map((entry) => <li key={entry.id} className="space-y-1 py-3 break-words">
        <p className="font-medium">{entry.action} <time className="font-normal text-muted-foreground" dateTime={new Date(entry.createdAt).toISOString()}>{date(entry.createdAt)}</time></p>
        <p className="text-xs">Actor: {entry.actorName ?? "Operator / deleted account"} {entry.actorId && `(${entry.actorId})`} · Target: {entry.targetId}</p>
        <p>{entry.reason}</p>
      </li>)}</ol>
    </Section>
  </div>;
}

function ReportRow({ report }: { report: AdminDashboard["reports"][number] }) {
  const [preview, setPreview] = useState<{ content: string | null; authorName: string | null; deleted: boolean } | null>(null);
  return <li className="space-y-3 py-4">
    <div><p className="font-medium">{report.messageId ? "Message" : "Community"} report · {report.communityName ?? "Deleted community"}</p><p className="text-xs text-muted-foreground">{date(report.createdAt)} · {report.status}</p></div>
    <p className="break-words whitespace-pre-wrap">{report.reason}</p>
    {report.resolution && <p className="text-muted-foreground">Resolution: {report.resolution}</p>}
    {preview && <div className="rounded-lg border p-3"><p className="mb-1 text-xs text-muted-foreground">Reported content · {preview.authorName ?? "Unavailable"}</p><p className="break-words whitespace-pre-wrap">{preview.deleted ? "This message has been deleted." : preview.content ?? "Community metadata is shown above."}</p><Button variant="ghost" size="sm" onClick={() => setPreview(null)}>Hide content</Button></div>}
    <div className="flex flex-wrap gap-2">
      {report.messageId && <AdminAction label="Review reported message" description="Explicitly access this reported private message. Only this message will be shown." action={async (reason) => { const result = await actions.reviewReport(report.id, reason); if (result.ok) setPreview(result.data); return result; }} />}
      {report.status === "open" && <><AdminAction label="Dismiss report" description="Close this report without removing content." action={(r) => actions.resolveReport(report.id, "dismissed", r)} /><AdminAction label={report.messageId ? "Remove reported message" : "Suspend reported community"} description="Resolve the report and remove the message or suspend the community." action={(r) => actions.resolveReport(report.id, "removed", r)} /></>}
    </div>
  </li>;
}
function SettingsForm({ settings }: { settings: AdminDashboard["settings"] }) {
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [pending, startTransition] = useTransition();
  const limits = [["ownedCommunities", "Communities per owner"], ["channelsPerCommunity", "Channels per community"], ["rolesPerCommunity", "Roles per community"], ["activeInvitesPerCommunity", "Active invites per community"]] as const;
  return <form className="grid max-w-xl gap-4" onSubmit={(event) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const input = { registrationOpen: data.get("registrationOpen") === "on", inviteMode: data.get("inviteMode") as "members" | "admins" | "disabled",
      ownedCommunities: Number(data.get("ownedCommunities")), channelsPerCommunity: Number(data.get("channelsPerCommunity")), rolesPerCommunity: Number(data.get("rolesPerCommunity")), activeInvitesPerCommunity: Number(data.get("activeInvitesPerCommunity")) };
    startTransition(async () => { setError(null); setSaved(false); const result = await actions.saveSettings(input, String(data.get("reason"))); if (result.ok) setSaved(true); else setError(result.error); });
  }}>
    <label className="flex items-center gap-2"><input type="checkbox" name="registrationOpen" defaultChecked={settings.registrationOpen} />Allow new account registrations</label>
    <div className="grid gap-2"><Label htmlFor="invite-mode">Community invitations</Label><select id="invite-mode" name="inviteMode" defaultValue={settings.inviteMode} className="rounded-lg border bg-background p-2"><option value="members">Members with community invite permission</option><option value="admins">Instance admins with community invite permission</option><option value="disabled">Disabled (including existing invitations)</option></select></div>
    <p className="text-xs text-muted-foreground">Registration is independent of community invitations. Disabling registration prevents all new accounts; existing users can still sign in. Lower limits affect new creations and do not delete existing data.</p>
    <div className="grid gap-3 sm:grid-cols-2">{limits.map(([key, label]) => <div key={key} className="grid gap-2"><Label htmlFor={`limit-${key}`}>{label}</Label><Input id={`limit-${key}`} name={key} type="number" required min={1} max={1000} defaultValue={settings[key]} /></div>)}</div>
    <Label htmlFor="settings-reason">Reason for changing settings</Label><Textarea id="settings-reason" name="reason" required minLength={3} maxLength={512} />
    {error && <p role="alert" className="text-destructive">{error}</p>}{saved && <p role="status">Instance settings saved.</p>}
    <Button type="submit" disabled={pending}>Save instance settings</Button>
  </form>;
}
