"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import * as actions from "@/app/app/admin/actions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import type { listDirectReports } from "@/server/direct-messages";
import type { AdminDashboard, AuditArea } from "@/server/instance-admin";
import { AdminAction, MoreActions } from "./admin-action";
import { PrivateReports } from "./private-reports";
import { VerifiedBadge } from "../community-icon";
import { adminHref, EmptyState, FilterChips, formatDate, Pager, Panel } from "./shared";
import { SearchForm } from "./users";

type PrivateReport = Awaited<ReturnType<typeof listDirectReports>>[number];

export function CommunitiesPanel({ communities, search, page }: { communities: AdminDashboard["communities"]; search: string; page: number }) {
  return (
    <Panel id="communities" title="Communities" actions={<SearchForm tab="communities" search={search} label="Search communities by name" />}>
      {!communities.items.length ? <EmptyState>No communities match.</EmptyState> : (
        <ul className="divide-y">{communities.items.map((c) => (
          <li key={c.id} className="grid gap-3 py-4 md:grid-cols-[minmax(0,1fr)_auto] md:items-center">
            <div className="min-w-0">
              <p className="flex flex-wrap items-center gap-2">
                <span className="font-medium break-words text-zinc-100">{c.name}</span>
                {c.verifiedAt && <VerifiedBadge />}
                {c.suspendedAt ? <Badge variant="destructive" className="text-red-200">Suspended</Badge> : <Badge className="bg-emerald-400/15 text-emerald-200">Active</Badge>}
                {c.discoverable && !c.suspendedAt && <Link href={`/app/discover/${c.id}`} className="text-xs text-muted-foreground underline hover:text-zinc-100">In Discover</Link>}
              </p>
              <p className="text-sm break-all text-muted-foreground">Owner: {c.ownerEmail}</p>
              <p className="mt-1 text-xs text-muted-foreground">
                {c.members} {c.members === 1 ? "member" : "members"} · Created <time dateTime={new Date(c.createdAt).toISOString()}>{formatDate(c.createdAt)}</time>
                {c.suspendedAt && <> · Suspended: {c.suspensionReason}</>}
              </p>
            </div>
            <div className="flex flex-wrap gap-2 md:justify-end">
              <AdminAction label={c.suspendedAt ? "Unsuspend community" : "Suspend community"} variant={c.suspendedAt ? "outline" : "destructive"} description={`Community: ${c.name}. Suspension blocks access and invitations for every member.`} action={(r) => actions.suspendCommunity(c.id, !c.suspendedAt, r)} />
              <MoreActions label={`More actions for ${c.name}`} items={[
                { label: c.verifiedAt ? "Remove verification" : "Verify community", description: `Community: ${c.name}. Verified communities show a blue badge everywhere their name appears.`, action: (r) => actions.verifyCommunity(c.id, !c.verifiedAt, r) },
                { label: "Transfer ownership", description: `Community: ${c.name}. The new owner must already be an active member.`, extraLabel: "New owner's email", extraType: "email", action: (r, email) => actions.transferCommunity(c.id, email, r) },
              ]} />
            </div>
          </li>
        ))}</ul>
      )}
      <Pager page={page} hasMore={communities.hasMore} href={(p) => adminHref({ tab: "communities", q: search, page: p })} />
    </Panel>
  );
}

const REPORT_STATUSES = [["open", "Open"], ["private", "Private messages"], ["dismissed", "Dismissed"], ["removed", "Removed"]] as const;

export function ReportsPanel({ reports, privateReports, status, openPrivate }: { reports: AdminDashboard["reports"]; privateReports: PrivateReport[]; status: string; openPrivate: number }) {
  const options = REPORT_STATUSES.map(([s, label]) => [s, s === "private" && openPrivate ? `${label} (${openPrivate})` : label] as const);
  return (
    <Panel
      id="reports"
      title="Abuse reports"
      description={status === "private"
        ? "Only the recipient's reason and any text they chose to disclose. Excerpts are their statement, not proof: the server can't decrypt private messages."
        : "Message content stays hidden until you open it with a reason."}
      actions={<FilterChips label="Report status" options={options} current={status} href={(s) => adminHref({ tab: "reports", status: s })} />}
    >
      {status === "private"
        ? <PrivateReports reports={privateReports} />
        : !reports.length ? <EmptyState>No {status} reports.</EmptyState> : <ul className="divide-y">{reports.map((r) => <ReportRow key={r.id} report={r} />)}</ul>}
    </Panel>
  );
}

function ReportRow({ report }: { report: AdminDashboard["reports"][number] }) {
  const [preview, setPreview] = useState<{ content: string | null; authorName: string | null; deleted: boolean } | null>(null);
  return (
    <li className="space-y-3 py-4">
      <div>
        <p className="flex flex-wrap items-center gap-2 font-medium text-zinc-100">
          {report.messageId ? "Message" : "Community"} report · {report.communityName ?? "Deleted community"}
          <Badge variant="outline" className="capitalize">{report.status}</Badge>
        </p>
        <p className="text-xs text-muted-foreground">{formatDate(report.createdAt)} · Reported by {report.reporterName ?? "a deleted account"}</p>
      </div>
      <p className="break-words whitespace-pre-wrap">{report.reason}</p>
      {report.resolution && <p className="text-sm text-muted-foreground">Resolution: {report.resolution}</p>}
      {preview && (
        <div className="rounded-lg border bg-background/40 p-3">
          <p className="mb-1 text-xs text-muted-foreground">Reported content · {preview.authorName ?? "Unavailable"}</p>
          <p className="break-words whitespace-pre-wrap">{preview.deleted ? "This message has been deleted." : preview.content ?? "Community metadata is shown above."}</p>
          <Button variant="ghost" size="sm" onClick={() => setPreview(null)}>Hide content</Button>
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        {report.messageId && <AdminAction label="Review reported message" description="Explicitly access this reported private message. Only this message will be shown." action={async (reason) => { const result = await actions.reviewReport(report.id, reason); if (result.ok) setPreview(result.data); return result; }} />}
        {report.status === "open" && (
          <>
            <AdminAction label="Dismiss report" description="Close this report without removing content." action={(r) => actions.resolveReport(report.id, "dismissed", r)} />
            <AdminAction label={report.messageId ? "Remove reported message" : "Suspend reported community"} variant="destructive" description="Resolve the report and remove the message or suspend the community." action={(r) => actions.resolveReport(report.id, "removed", r)} />
          </>
        )}
      </div>
    </li>
  );
}

export function SettingsPanel({ settings, admins }: { settings: AdminDashboard["settings"]; admins: AdminDashboard["admins"] }) {
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [pending, startTransition] = useTransition();
  const limits = [["ownedCommunities", "Communities per owner"], ["channelsPerCommunity", "Channels per community"], ["rolesPerCommunity", "Roles per community"], ["activeInvitesPerCommunity", "Active invites per community"]] as const;
  return (
    <div className="grid gap-6">
      <Panel id="settings" title="Instance settings" description="Lower limits only affect new creations.">
        <form className="grid max-w-2xl gap-5 py-5" onSubmit={(event) => {
          event.preventDefault();
          const data = new FormData(event.currentTarget);
          const input = { registrationOpen: data.get("registrationOpen") === "on", inviteMode: data.get("inviteMode") as "members" | "admins" | "disabled",
            ownedCommunities: Number(data.get("ownedCommunities")), channelsPerCommunity: Number(data.get("channelsPerCommunity")), rolesPerCommunity: Number(data.get("rolesPerCommunity")), activeInvitesPerCommunity: Number(data.get("activeInvitesPerCommunity")) };
          startTransition(async () => { setError(null); setSaved(false); const result = await actions.saveSettings(input, String(data.get("reason"))); if (result.ok) setSaved(true); else setError(result.error); });
        }}>
          <label className="flex items-start gap-3">
            <input type="checkbox" name="registrationOpen" defaultChecked={settings.registrationOpen} className="mt-1 size-4 accent-brand-indigo" />
            <span><span className="font-medium text-zinc-100">Allow new account registrations</span><span className="block text-sm text-muted-foreground">When off, nobody can create an account, not even to request Closed Alpha access. Existing users can still sign in.</span></span>
          </label>
          <div className="grid gap-2">
            <Label htmlFor="invite-mode">Community invitations</Label>
            <select id="invite-mode" name="inviteMode" defaultValue={settings.inviteMode} className="h-8 rounded-lg border border-input bg-input/30 px-2 text-sm">
              <option value="members">Members with community invite permission</option>
              <option value="admins">Instance admins with community invite permission</option>
              <option value="disabled">Disabled (including existing invitations)</option>
            </select>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">{limits.map(([key, label]) => <div key={key} className="grid gap-2"><Label htmlFor={`limit-${key}`}>{label}</Label><Input id={`limit-${key}`} name={key} type="number" required min={1} max={1000} defaultValue={settings[key]} /></div>)}</div>
          <div className="grid gap-2"><Label htmlFor="settings-reason">Reason for changing settings</Label><Textarea id="settings-reason" name="reason" required minLength={3} maxLength={512} /></div>
          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}{saved && <p role="status" className="text-sm text-success">Instance settings saved.</p>}
          <Button type="submit" disabled={pending} className="w-fit">Save instance settings</Button>
        </form>
      </Panel>
      <Panel id="admins" title="Instance administrators" description={<>Manage rights in <Link href="/app/admin?tab=users&filter=admins" className="link">Users</Link>. The last admin can&apos;t be removed.</>}>
        <ul className="divide-y">{admins.map((u) => <li key={u.id} className="py-3"><p className="font-medium text-zinc-100">{u.name}</p><p className="text-sm break-all text-muted-foreground">{u.email}</p></li>)}</ul>
      </Panel>
    </div>
  );
}

const AUDIT_AREAS = [["all", "All"], ["user", "Users"], ["community", "Communities"], ["report", "Reports"], ["instance", "Instance"]] as const satisfies readonly (readonly [AuditArea, string])[];

export function AuditPanel({ logs, area, page }: { logs: AdminDashboard["logs"]; area: AuditArea; page: number }) {
  return (
    <Panel id="audit" title="Instance audit log" actions={<FilterChips label="Filter audit log" options={AUDIT_AREAS} current={area} href={(a) => adminHref({ tab: "audit", area: a })} />}>
      {!logs.items.length ? <EmptyState>No entries yet.</EmptyState> : <ol className="divide-y">{logs.items.map((entry) => <AuditEntry key={entry.id} entry={entry} />)}</ol>}
      <Pager page={page} hasMore={logs.hasMore} href={(p) => adminHref({ tab: "audit", area, page: p })} />
    </Panel>
  );
}

export function AuditEntry({ entry }: { entry: AdminDashboard["logs"]["items"][number] }) {
  return (
    <li className="space-y-1 py-3 break-words">
      <p className="flex flex-wrap items-baseline gap-x-2"><code className="font-mono text-sm text-zinc-100">{entry.action}</code><time className="text-xs text-muted-foreground" dateTime={new Date(entry.createdAt).toISOString()}>{formatDate(entry.createdAt)}</time></p>
      <p className="text-xs text-muted-foreground">
        By {entry.actorName ?? "operator / deleted account"} · Target: {entry.targetName ?? <span className="font-mono">{entry.targetId}</span>}
      </p>
      <p className="text-sm">{entry.reason}</p>
    </li>
  );
}
