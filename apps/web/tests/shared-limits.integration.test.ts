// Requires a migrated PostgreSQL database; concurrent calls use separate pool connections.
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { db } from "@/db";
import { applicationRateLimit, streamLease } from "@/db/schema";
import { consume } from "@/server/limits";
import { hashRateLimitKey } from "@/server/rate-limit-store";
import { acquireStreamLease } from "@/server/stream-leases";
import { testUsers } from "./helpers";

const users = testUsers();
afterAll(() => users.cleanup());

describe("shared sliding-window limits", () => {
  it("admits exactly the cap under concurrent acquisition", async () => {
    const key = `concurrent:${randomUUID()}`;
    const results = await Promise.allSettled(Array.from({ length: 24 }, () => consume(key, 5, 1000, 10_000)));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(5);
    const [stored] = await db.select().from(applicationRateLimit).where(eq(applicationRateLimit.key, hashRateLimitKey(key)));
    expect(stored.hits).toHaveLength(5);
    for (const result of results) if (result.status === "rejected") expect(result.reason).toMatchObject({ code: "rate_limited" });
  });

  it("expires individual hits at the exact sliding-window boundary", async () => {
    const key = `sliding:${randomUUID()}`;
    await consume(key, 2, 1000, 10_000);
    await consume(key, 2, 1000, 10_500);
    await expect(consume(key, 2, 1000, 10_999)).rejects.toMatchObject({ code: "rate_limited" });
    await consume(key, 2, 1000, 11_000);
    await expect(consume(key, 2, 1000, 11_001)).rejects.toMatchObject({ code: "rate_limited" });
    await consume(key, 2, 1000, 11_500);
  });

  it("keeps raw identifiers out of stored counter keys", async () => {
    const key = `private:${randomUUID()}`;
    await consume(key, 2, 1000);
    expect(await db.select().from(applicationRateLimit).where(eq(applicationRateLimit.key, key))).toEqual([]);
  });
});

describe("shared stream leases", () => {
  it("serializes concurrent acquisitions and keeps personal/community caps independent", async () => {
    const userId = await users.create("Lease cap");
    const results = await Promise.allSettled(Array.from({ length: 24 }, () => acquireStreamLease(userId, "community")));
    const releases = results.flatMap((r) => r.status === "fulfilled" ? [r.value] : []);
    try {
      expect(releases).toHaveLength(8);
      for (const result of results) if (result.status === "rejected") expect(result.reason).toMatchObject({ code: "rate_limited" });
      const personal = await acquireStreamLease(userId, "personal");
      await personal();
      await Promise.all([releases[0](), releases[0]()]);
      const replacement = await acquireStreamLease(userId, "community");
      await expect(acquireStreamLease(userId, "community")).rejects.toMatchObject({ code: "rate_limited" });
      await replacement();
    } finally {
      await Promise.all(releases.map((release) => release()));
    }
    expect(await db.select().from(streamLease).where(eq(streamLease.userId, userId))).toEqual([]);
  });

  it("reclaims expired leases even when their owning process never released them", async () => {
    const userId = await users.create("Lease expiry");
    const releases = await Promise.all(Array.from({ length: 8 }, () => acquireStreamLease(userId, "personal")));
    await db.update(streamLease).set({ expiresAt: new Date(Date.now() - 1) }).where(eq(streamLease.userId, userId));
    const replacement = await acquireStreamLease(userId, "personal");
    try {
      await Promise.all(releases.map((release) => release()));
      expect(await db.select().from(streamLease).where(eq(streamLease.userId, userId))).toHaveLength(1);
    } finally { await replacement(); }
  });
});
