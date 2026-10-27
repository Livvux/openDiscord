import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import type { AdminDashboard } from "@/server/instance-admin";

export type AdminUser = AdminDashboard["users"]["items"][number];

/** Admin URLs only carry the parameters that matter; empty values are dropped. */
export function adminHref(params: Record<string, string | number | undefined>) {
  const query = new URLSearchParams(Object.entries(params).filter((e): e is [string, string | number] => e[1] !== undefined && e[1] !== "" && e[1] !== 1).map(([k, v]) => [k, String(v)]));
  return `/app/admin?${query}`;
}

export function FilterChips<T extends string>({ label, options, current, href }: { label: string; options: readonly (readonly [T, string])[]; current: T; href: (value: T) => string }) {
  return (
    <nav aria-label={label} className="flex flex-wrap gap-1.5">
      {options.map(([value, text]) => (
        <Link key={value} href={href(value)} aria-current={value === current ? "page" : undefined} className="rounded-full border px-3 py-1 text-sm text-zinc-300 hover:bg-muted aria-[current=page]:border-brand-indigo aria-[current=page]:bg-brand-indigo/15 aria-[current=page]:text-zinc-100">
          {text}
        </Link>
      ))}
    </nav>
  );
}

export function Pager({ page, hasMore, href }: { page: number; hasMore: boolean; href: (page: number) => string }) {
  if (page === 1 && !hasMore) return null;
  const link = "rounded-lg border px-3 py-1 text-sm text-zinc-300 hover:bg-muted";
  return (
    <nav aria-label="Pages" className="flex items-center justify-between gap-3 border-t py-3 text-sm text-muted-foreground">
      {page > 1 ? <Link href={href(page - 1)} className={link}>Previous</Link> : <span />}
      <span>Page {page}</span>
      {hasMore ? <Link href={href(page + 1)} className={link}>Next</Link> : <span />}
    </nav>
  );
}

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
