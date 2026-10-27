import type { ReactNode } from "react";
import { BADGES, type BadgeId } from "@/lib/badges";

const ICONS: Record<BadgeId, { color: string; path: ReactNode }> = {
  system_admin: {
    color: "#f04747",
    path: <><path d="M12 2 4 5v6c0 5 3.4 9.3 8 11 4.6-1.7 8-6 8-11V5l-8-3Z" fill="currentColor" /><path d="m8.5 12 2.5 2.5 4.5-5" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></>,
  },
  hypesquad: {
    color: "#f8a532",
    path: <><path d="M12 2 3 7v10l9 5 9-5V7l-9-5Z" fill="currentColor" /><path d="m12 7 1.6 3.3 3.6.5-2.6 2.5.6 3.6L12 15.2l-3.2 1.7.6-3.6-2.6-2.5 3.6-.5L12 7Z" fill="#fff" /></>,
  },
  early_supporter: {
    color: "#7289da",
    path: <><circle cx="12" cy="12" r="10" fill="currentColor" /><path d="M12 17.5s-5-3-5-6.6A2.9 2.9 0 0 1 12 9a2.9 2.9 0 0 1 5 1.9c0 3.6-5 6.6-5 6.6Z" fill="#fff" /></>,
  },
  community_founder: {
    color: "#3ba55c",
    path: <><rect x="2" y="2" width="20" height="20" rx="6" fill="currentColor" /><path d="m6.5 15.5 1-7 3 3 1.5-4 1.5 4 3-3 1 7h-11Z" fill="#fff" /></>,
  },
};

export function BadgeIcon({ id, className = "size-5" }: { id: BadgeId; className?: string }) {
  const icon = ICONS[id];
  return <svg viewBox="0 0 24 24" aria-hidden className={className} style={{ color: icon.color }}>{icon.path}</svg>;
}

/** Earned badges on a profile: icon first, then label. */
export function BadgeList({ badges }: { badges: BadgeId[] }) {
  if (!badges.length) return null;
  return (
    <ul aria-label="Badges" className="flex flex-wrap gap-1.5">
      {BADGES.filter((b) => badges.includes(b.id)).map((b) => (
        <li key={b.id} title={b.hint} className="flex items-center gap-1.5 rounded-md bg-white/5 py-1 pr-2 pl-1.5 text-xs font-medium text-zinc-200">
          <BadgeIcon id={b.id} className="size-4" />
          {b.label}
        </li>
      ))}
    </ul>
  );
}

/** Every badge, with the ones you have marked and how to get the rest. */
export function BadgeOverview({ badges }: { badges: BadgeId[] }) {
  return (
    <ul className="grid gap-2">
      {BADGES.map((b) => {
        const earned = badges.includes(b.id);
        return (
          <li key={b.id} className={`flex items-center gap-3 rounded-lg border p-3 ${earned ? "" : "opacity-50 grayscale"}`}>
            <BadgeIcon id={b.id} className="size-8 shrink-0" />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold">{b.label}</p>
              <p className="text-xs text-muted-foreground">{b.hint}</p>
            </div>
            <span className="text-xs font-medium text-muted-foreground">{earned ? "Earned" : "Locked"}</span>
          </li>
        );
      })}
    </ul>
  );
}
