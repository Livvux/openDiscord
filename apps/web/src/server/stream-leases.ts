import { and, count, eq, gt, lte, sql } from "drizzle-orm";
import { db } from "@/db";
import { streamLease } from "@/db/schema";
import { AppError } from "./errors";

export const MAX_STREAM_LIFETIME_MS = 10 * 60_000;
const LEASE_TTL_MS = MAX_STREAM_LIFETIME_MS + 30_000;
const MAX_STREAMS_PER_USER = 8;

/** Separate statements after the transaction lock ensure the count sees the previous acquirer's commit. */
export async function acquireStreamLease(userId: string, scope: "personal" | "community"): Promise<() => Promise<void>> {
  const id = await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`stream:${scope}:${userId}`}, 2))`);
    const owner = and(eq(streamLease.userId, userId), eq(streamLease.scope, scope));
    await tx.delete(streamLease).where(and(owner, lte(streamLease.expiresAt, sql`clock_timestamp()`)));
    const [active] = await tx.select({ count: count() }).from(streamLease)
      .where(and(owner, gt(streamLease.expiresAt, sql`clock_timestamp()`)));
    if (active.count >= MAX_STREAMS_PER_USER) {
      throw new AppError("rate_limited", "Too many open connections. Close some tabs.");
    }
    const [lease] = await tx.insert(streamLease).values({
      userId, scope, expiresAt: sql`clock_timestamp() + ${LEASE_TTL_MS} * interval '1 millisecond'`,
    }).returning({ id: streamLease.id });
    return lease.id;
  });
  let releasing: Promise<void> | undefined;
  return () => releasing ??= db.delete(streamLease).where(eq(streamLease.id, id)).then(() => {});
}
