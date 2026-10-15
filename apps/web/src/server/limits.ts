import { sql } from "drizzle-orm";
import { db } from "@/db";
import { applicationRateLimit } from "@/db/schema";
import { hashRateLimitKey } from "./rate-limit-store";
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

/** Atomic sliding-window acquisition shared by every web process. Rejected hits do not extend the window. */
export async function consume(key: string, max: number, windowMs: number, now = Date.now()): Promise<void> {
  const recent = sql`array(select hit from unnest(${applicationRateLimit.hits}) as hit where hit > ${now - windowMs})`;
  const [row] = await db.insert(applicationRateLimit).values({
    key: hashRateLimitKey(key), hits: [now], windowStart: now,
  }).onConflictDoUpdate({
    target: applicationRateLimit.key,
    set: { hits: sql`${recent} || array[${now}]::bigint[]`, windowStart: now },
    setWhere: sql`cardinality(${recent}) < ${max}`,
  }).returning({ key: applicationRateLimit.key });
  if (!row) throw new AppError("rate_limited", "You're doing that too often. Wait a moment.");
}
