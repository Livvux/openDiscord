import { AppError } from "./errors";

/** Hard caps that bound storage growth per user and per community. */
export const CAPS = {
  ownedCommunities: 25,
  channelsPerCommunity: 200,
  rolesPerCommunity: 100,
  activeInvitesPerCommunity: 100,
} as const;

export function enforceCap(current: number, cap: number, message: string): void {
  if (current >= cap) throw new AppError("conflict", message);
}

/** Burst limit for all mutations of one user (server actions). */
export const MUTATION_LIMIT = { max: 30, windowMs: 10_000 };

const hits = new Map<string, number[]>();

/**
 * Sliding-window limiter.
 * shortcut: in-memory per process, so N replicas allow N× the burst; move to Postgres or Redis
 * when running more than one web replica (docs/DECISIONS.md D4).
 */
export function consume(key: string, max: number, windowMs: number, now = Date.now()): void {
  const recent = (hits.get(key) ?? []).filter((t) => t > now - windowMs);
  if (recent.length >= max) {
    hits.set(key, recent);
    throw new AppError("rate_limited", "You're doing that too often. Wait a moment.");
  }
  hits.set(key, [...recent, now]);
  // Keep memory bounded: drop idle keys occasionally.
  if (hits.size > 10_000) {
    for (const [k, times] of hits) if (times.every((t) => t <= now - windowMs)) hits.delete(k);
  }
}
