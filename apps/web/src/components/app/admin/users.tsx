"use client";

import { CheckIcon, MailCheckIcon, ShieldIcon, XIcon } from "lucide-react";
import Link from "next/link";
import * as actions from "@/app/app/admin/actions";
import { Badge } from "@/components/ui/badge";
import type { AdminDashboard, UserFilter } from "@/server/instance-admin";
import { AdminAction, type AdminActionProps, MoreActions, QuickAction } from "./admin-action";
import { adminHref, type AdminUser, EmptyState, FilterChips, formatDate, Pager, Panel, StatusBadge } from "./shared";

const APPROVE_REASON = "Approved for Closed Alpha access";

export function ApproveButton({ id }: { id: string }) {
  return <QuickAction label="Approve" icon={<CheckIcon />} action={() => actions.setApproval(id, "approved", APPROVE_REASON)} />;
}
export function RejectButton({ id, email }: { id: string; email: string }) {
  return (
    <AdminAction
      label="Reject"
      variant="destructive"
      icon={<XIcon />}
      description={`Decline access for ${email}. The account stays blocked, even if Closed Alpha is turned off, until you approve it.`}
      action={(reason) => actions.setApproval(id, "rejected", reason)}
    />
  );
}

type PendingUser = AdminDashboard["pending"][number];

export function ApprovalQueue({ pending, closedAlpha, limit }: { pending: PendingUser[]; closedAlpha: boolean; limit?: number }) {
  const shown = limit ? pending.slice(0, limit) : pending;
  if (!pending.length) return <EmptyState>No accounts are waiting for approval.</EmptyState>;
  return (
    <>
      {!closedAlpha && (
        <p className="mt-4 rounded-lg bg-amber-400/10 px-3 py-2 text-sm text-amber-100">
          Closed Alpha is off, so these accounts can already sign in. Approving them records the decision for when it&apos;s on again.
        </p>
      )}
      <ul className="divide-y" aria-label="Accounts waiting for approval">
        {shown.map((u) => (
          <li key={u.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 py-3">
            <div className="min-w-0 flex-1">
              <p className="font-medium break-words text-zinc-100">{u.name}</p>
              <p className="text-sm break-all text-muted-foreground">{u.email}</p>
              <p className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                <span>Requested <time dateTime={new Date(u.createdAt).toISOString()}>{formatDate(u.createdAt)}</time></span>
                {u.emailVerified && <Badge variant="outline"><MailCheckIcon />Email verified</Badge>}
              </p>
            </div>
            <div className="flex flex-wrap items-start gap-2">
              <ApproveButton id={u.id} />
              <RejectButton id={u.id} email={u.email} />
            </div>
          </li>
        ))}
      </ul>
      {limit && pending.length > limit && (
        <p className="border-t py-3 text-sm">
          <Link href="/app/admin?tab=approvals" className="link">View all {pending.length} pending accounts</Link>
        </p>
      )}
    </>
  );
}

const FILTERS = [["all", "All"], ["pending", "Pending"], ["active", "Active"], ["rejected", "Rejected"], ["suspended", "Suspended"], ["admins", "Admins"]] as const satisfies readonly (readonly [UserFilter, string])[];

export function UsersPanel({ users, filter, search, page }: { users: AdminDashboard["users"]; filter: UserFilter; search: string; page: number }) {
  return (
    <Panel id="users" title="Users">
      <div className="flex flex-col gap-3 py-4 lg:flex-row lg:items-end lg:justify-between">
        <FilterChips label="Filter users by status" options={FILTERS} current={filter} href={(f) => adminHref({ tab: "users", filter: f, q: search })} />
        <SearchForm tab="users" search={search} label="Search users by name or email" extra={{ filter }} />
      </div>
      {!users.items.length ? <EmptyState>No users match.</EmptyState> : (
        <ul className="divide-y border-t">
          {users.items.map((u) => <UserRow key={u.id} user={u} />)}
        </ul>
      )}
      <Pager page={page} hasMore={users.hasMore} href={(p) => adminHref({ tab: "users", filter, q: search, page: p })} />
    </Panel>
  );
}

function UserRow({ user: u }: { user: AdminUser }) {
  const more: AdminActionProps[] = [
    { label: "Revoke sessions", description: `Sign out every device of ${u.email}.`, action: (r) => actions.revokeSessions(u.id, r) },
    { label: u.hypesquad ? "Remove HypeSquad badge" : "Grant HypeSquad badge", description: `Account: ${u.email}. The badge shows on their profile.`, action: (r) => actions.setBadge(u.id, "hypesquad", !u.hypesquad, r) },
    ...(u.adminId
      ? [{ label: "Remove admin", variant: "destructive" as const, description: `Remove instance rights from ${u.email}.`, action: (r: string) => actions.setAdmin(u.id, false, r) }]
      : u.suspendedAt ? [] : [{ label: "Grant admin", description: `Grant full instance administrator rights to ${u.email}.`, action: (r: string) => actions.setAdmin(u.id, true, r) }]),
  ];
  return (
    <li className="grid gap-3 py-4 md:grid-cols-[minmax(0,1fr)_auto] md:items-center">
      <div className="min-w-0">
        <p className="flex flex-wrap items-center gap-2">
          <span className="font-medium break-words text-zinc-100">{u.name}</span>
          <StatusBadge user={u} />
          {u.adminId && <Badge className="bg-brand-indigo/20 text-indigo-200"><ShieldIcon />Instance admin</Badge>}
          {u.hypesquad && <Badge variant="outline">HypeSquad</Badge>}
        </p>
        <p className="text-sm break-all text-muted-foreground">{u.email}</p>
        <p className="mt-1 text-xs text-muted-foreground">
          Joined <time dateTime={new Date(u.createdAt).toISOString()}>{formatDate(u.createdAt)}</time>
          {" · "}{u.lastActiveAt ? <>Last active <time dateTime={new Date(u.lastActiveAt).toISOString()}>{formatDate(u.lastActiveAt)}</time></> : "Not signed in"}
          {" · "}{u.twoFactorEnabled ? "2FA on" : "2FA off"}
          {u.ownedCommunities > 0 && <> · Owns {u.ownedCommunities} {u.ownedCommunities === 1 ? "community" : "communities"}</>}
          {u.suspendedAt && <> · Suspended: {u.suspensionReason}</>}
        </p>
      </div>
      <div className="flex flex-wrap items-start gap-2 md:justify-end">
        {u.approvalStatus !== "approved" && !u.suspendedAt && <ApproveButton id={u.id} />}
        {u.approvalStatus === "pending" && !u.suspendedAt && <RejectButton id={u.id} email={u.email} />}
        {!u.adminId && (
          <AdminAction
            label={u.suspendedAt ? "Unsuspend user" : "Suspend user"}
            variant={u.suspendedAt ? "outline" : "destructive"}
            description={`Account: ${u.email}. Suspending revokes all sessions and blocks access.`}
            action={(r) => actions.suspendUser(u.id, !u.suspendedAt, r)}
          />
        )}
        <MoreActions label={`More actions for ${u.email}`} items={more} />
      </div>
    </li>
  );
}

export function SearchForm({ tab, search, label, extra = {} }: { tab: string; search: string; label: string; extra?: Record<string, string> }) {
  const id = `${tab}-search`;
  return (
    <form action="/app/admin" role="search" className="flex w-full gap-2 lg:w-auto">
      <input type="hidden" name="tab" value={tab} />
      {Object.entries(extra).map(([k, v]) => <input key={k} type="hidden" name={k} value={v} />)}
      <label htmlFor={id} className="sr-only">{label}</label>
      <input
        id={id}
        name="q"
        type="search"
        defaultValue={search}
        maxLength={100}
        placeholder={label}
        className="h-8 min-w-0 flex-1 rounded-lg border border-input bg-input/30 px-2.5 text-sm text-zinc-100 outline-none placeholder:text-zinc-400 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 lg:w-72"
      />
      <button type="submit" className="h-8 rounded-lg border border-input bg-input/30 px-3 text-sm font-medium hover:bg-input/50 focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none">
        Search
      </button>
    </form>
  );
}
