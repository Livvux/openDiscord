import { randomUUID } from "node:crypto";
import { like } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { db } from "@/db";
import { authRateLimit } from "@/db/schema";
import { consumeRateLimit } from "@/server/rate-limit-store";

describe("shared auth rate limit", () => {
  it("allows up to max per window, reports retry time, then resets", async () => {
    const key = `203.0.113.7/sign-up/email/${randomUUID()}`;
    const rule = { window: 600, max: 2 };
    const now = Date.now();
    const results = await Promise.all([1, 2, 3, 4].map(() => consumeRateLimit(key, rule, now)));
    expect(results.filter((r) => r.allowed)).toHaveLength(2);
    expect(results.find((r) => !r.allowed)?.retryAfter).toBe(600);
    expect((await consumeRateLimit(key, rule, now + 600_001)).allowed).toBe(true);
  });

  it("never stores the IP address", async () => {
    await consumeRateLimit(`198.51.100.23/sign-in/email`, { window: 10, max: 3 });
    expect(await db.select().from(authRateLimit).where(like(authRateLimit.key, "%198.51.100.23%"))).toHaveLength(0);
  });
});
