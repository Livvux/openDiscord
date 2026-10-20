import { BuildingIcon, FlagIcon, type LucideIcon, UserCheckIcon, UserXIcon, UsersIcon } from "lucide-react";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import type { AdminDashboard } from "@/server/instance-admin";
import { ClosedAlphaToggle } from "./closed-alpha-toggle";
import { AuditPanel, CommunitiesPanel, ReportsPanel, SettingsPanel } from "./moderation";
import { Panel } from "./shared";
import { ApprovalQueue, UsersPanel } from "./users";

export const ADMIN_TABS = ["overview", "approvals", "users", "communities", "reports", "settings", "audit"] as const;
export type AdminTab = (typeof ADMIN_TABS)[number];
const TAB_LABELS: Record<AdminTab, string> = {
  overview: "Overview", approvals: "Approvals", users: "Users", communities: "Communities", reports: "Reports", settings: "Settings", audit: "Audit log",
};

interface AdminPanelProps { data: AdminDashboard; tab: AdminTab; search: string; status: string }

export function AdminPanel({ data, tab, search, status }: AdminPanelProps) {
  const counts: Partial<Record<AdminTab, number>> = { approvals: data.stats.pending, reports: data.stats.openReports };
  return (
    <div className="mx-auto max-w-6xl space-y-6 px-4 py-6 sm:px-8">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-2xl font-semibold text-zinc-100">Instance control</h2>
          <p className="mt-1 text-muted-foreground">Accounts, access, communities and abuse across this instance. Community roles don&apos;t grant these rights.</p>
        </div>
        <Badge className={data.settings.closedAlpha ? "h-6 bg-brand-mint/15 px-3 text-brand-mint" : "h-6 bg-white/5 px-3 text-zinc-300"}>
          Closed Alpha {data.settings.closedAlpha ? "on" : "off"}
        </Badge>
      </div>
      <nav aria-label="Administration sections" className="relative -mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
        <ul className="flex min-w-max gap-1 border-b">
          {ADMIN_TABS.map((t) => (
            <li key={t}>
              <Link
                href={`/app/admin?tab=${t}`}
                aria-current={t === tab ? "page" : undefined}
                className="-mb-px flex items-center gap-2 border-b-2 border-transparent px-3 py-2 text-sm text-zinc-400 hover:text-zinc-100 aria-[current=page]:border-brand-indigo aria-[current=page]:font-medium aria-[current=page]:text-zinc-100"
              >
                {TAB_LABELS[t]}
                {!!counts[t] && <Badge className="h-4.5 min-w-4.5 bg-brand-indigo px-1.5 text-white">{counts[t]}<span className="sr-only"> {t === "approvals" ? "pending" : "open"}</span></Badge>}
              </Link>
            </li>
          ))}
        </ul>
      </nav>
      {tab === "overview" && <Overview data={data} />}
      {tab === "approvals" && (
        <Panel id="approvals" title="Pending approvals" description="Oldest requests first. Approved accounts get an email when mail is configured.">
          <ApprovalQueue pending={data.pending} closedAlpha={data.settings.closedAlpha} />
        </Panel>
      )}
      {tab === "users" && <UsersPanel users={data.users} filter={data.filter} search={search} />}
      {tab === "communities" && <CommunitiesPanel communities={data.communities} search={search} />}
      {tab === "reports" && <><Link href="/app/admin/private-reports" className="underline">Private message reports (explicit recipient disclosures)</Link><ReportsPanel reports={data.reports} status={status} /></>}
      {tab === "settings" && <SettingsPanel settings={data.settings} admins={data.admins} />}
      {tab === "audit" && <AuditPanel logs={data.logs} />}
    </div>
  );
}

function Overview({ data }: { data: AdminDashboard }) {
  const { stats } = data;
  const tiles: { label: string; value: number; icon: LucideIcon; href: string; highlight?: boolean }[] = [
    { label: "Pending approvals", value: stats.pending, icon: UserCheckIcon, href: "/app/admin?tab=approvals", highlight: stats.pending > 0 },
    { label: "Users", value: stats.users, icon: UsersIcon, href: "/app/admin?tab=users" },
    { label: "Suspended users", value: stats.suspended, icon: UserXIcon, href: "/app/admin?tab=users&filter=suspended" },
    { label: "Communities", value: stats.communities, icon: BuildingIcon, href: "/app/admin?tab=communities" },
    { label: "Open reports", value: stats.openReports, icon: FlagIcon, href: "/app/admin?tab=reports", highlight: stats.openReports > 0 },
  ];
  return (
    <div className="grid gap-6">
      <Panel id="access" title="Access">
        <ClosedAlphaToggle enabled={data.settings.closedAlpha} pending={stats.pending} />
        {!data.settings.registrationOpen && (
          <p className="mb-4 rounded-lg bg-white/5 px-3 py-2 text-sm text-zinc-300">
            Registration is closed in <Link href="/app/admin?tab=settings" className="link">Settings</Link>, so nobody can request access right now.
          </p>
        )}
      </Panel>
      <ul className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-5" aria-label="Instance statistics">
        {tiles.map(({ label, value, icon: Icon, href, highlight }) => (
          <li key={label}>
            <Link href={href} className={`flex h-full flex-col gap-3 rounded-xl border bg-panel p-4 hover:bg-white/[0.04] focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none ${highlight ? "border-brand-indigo/50" : ""}`}>
              <Icon className={`size-4 ${highlight ? "text-indigo-300" : "text-zinc-400"}`} aria-hidden />
              <span>
                <span className="block text-2xl font-semibold text-zinc-100 tabular-nums">{value}</span>
                <span className="text-sm text-muted-foreground">{label}</span>
              </span>
            </Link>
          </li>
        ))}
      </ul>
      <Panel id="queue" title="Waiting for approval" description="Oldest first.">
        <ApprovalQueue pending={data.pending} closedAlpha={data.settings.closedAlpha} limit={5} />
      </Panel>
    </div>
  );
}
