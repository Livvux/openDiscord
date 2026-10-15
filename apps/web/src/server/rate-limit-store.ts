import { createHmac } from "node:crypto";
import { lt, sql } from "drizzle-orm";
import { db } from "@/db";
import { authRateLimit } from "@/db/schema";

const secret = process.env.BETTER_AUTH_SECRET ?? "";
const DAY_MS = 24 * 60 * 60_000;
/** Keyed hash: rows can't be turned back into IP addresses without the server secret. */
const hashKey = (key: string) => createHmac("sha256", secret).update(key).digest("base64url");

/** Fixed-window counter in one atomic upsert, so concurrent requests can't all slip past a stale read. */
export async function consumeRateLimit(key: string, rule: { window: number; max: number }, now = Date.now()) {
  const windowMs = rule.window * 1000;
  const expired = sql`${authRateLimit.windowStart} <= ${now - windowMs}`;
  const [row] = await db.insert(authRateLimit).values({ key: hashKey(key), count: 1, windowStart: now })
    .onConflictDoUpdate({
      target: authRateLimit.key,
      set: {
        count: sql`case when ${expired} then 1 else ${authRateLimit.count} + 1 end`,
        windowStart: sql`case when ${expired} then ${now} else ${authRateLimit.windowStart} end`,
      },
    })
    .returning({ count: authRateLimit.count, windowStart: authRateLimit.windowStart });
  // Occasional cleanup keeps the table to roughly one day of windows.
  if (Math.random() < 0.01) void db.delete(authRateLimit).where(lt(authRateLimit.windowStart, now - DAY_MS)).catch(() => {});
  const allowed = row.count <= rule.max;
  return { allowed, retryAfter: allowed ? null : Math.max(1, Math.ceil((row.windowStart + windowMs - now) / 1000)) };
}

export const authRateLimitStore = { consume: consumeRateLimit };
