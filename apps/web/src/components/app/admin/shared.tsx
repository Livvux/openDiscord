import { Badge } from "@/components/ui/badge";
import type { AdminDashboard } from "@/server/instance-admin";

export type AdminUser = AdminDashboard["users"][number];

/** Deterministic (server and client render the same string), unambiguous across time zones. */
export const formatDate = (value: Date | string) => new Date(value).toISOString().replace("T", " ").slice(0, 16) + " UTC";

export function Panel({ title, description, actions, children, id }: { title: string; description?: React.ReactNode; actions?: React.ReactNode; children: React.ReactNode; id?: string }) {
  return (
    <section id={id} aria-labelledby={id ? `${id}-title` : undefined} className="rounded-xl border bg-panel">
      <header className="flex flex-wrap items-start justify-between gap-3 border-b px-4 py-3 sm:px-5">
        <div className="min-w-0">
          <h2 id={id ? `${id}-title` : undefined} className="font-semibold text-zinc-100">{title}</h2>
          {description && <p className="mt-0.5 text-sm text-muted-foreground">{description}</p>}
        </div>
        {actions}
      </header>
      <div className="px-4 sm:px-5">{children}</div>
    </section>
  );
}

export function EmptyState({ children }: { children: React.ReactNode }) {
  return <p className="py-10 text-center text-sm text-muted-foreground">{children}</p>;
}

/** Text labels carry the meaning; colour is only a secondary cue. */
export function StatusBadge({ user }: { user: Pick<AdminUser, "suspendedAt" | "approvalStatus"> }) {
  if (user.suspendedAt) return <Badge variant="destructive" className="text-red-200">Suspended</Badge>;
  if (user.approvalStatus === "pending") return <Badge className="bg-amber-400/15 text-amber-200">Pending approval</Badge>;
  if (user.approvalStatus === "rejected") return <Badge variant="outline" className="text-zinc-300">Rejected</Badge>;
  return <Badge className="bg-emerald-400/15 text-emerald-200">Active</Badge>;
}
