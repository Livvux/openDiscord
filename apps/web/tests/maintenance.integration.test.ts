import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { db } from "@/db";
import { abuseReport, auditLog, banAppeal, community, instanceAuditLog, session, verification } from "@/db/schema";
import { AUDIT_RETENTION_DAYS, runMaintenance } from "@/server/maintenance";
import { testUsers } from "./helpers";

// An old reference time prevents this operator-wide job from touching other suites' current data.
const now = new Date("2000-07-01T00:00:00Z");
const cutoff = new Date(now.getTime() - AUDIT_RETENTION_DAYS * 86_400_000);
const older = new Date(cutoff.getTime() - 1);
const users = testUsers();
const verificationIds: string[] = [];
const instanceAuditIds: string[] = [];
const reportIds: string[] = [];

describe("operator retention maintenance", () => {
  afterAll(async () => {
    if (verificationIds.length) await db.delete(verification).where(inArray(verification.id, verificationIds));
    if (instanceAuditIds.length) await db.delete(instanceAuditLog).where(inArray(instanceAuditLog.id, instanceAuditIds));
    if (reportIds.length) await db.delete(abuseReport).where(inArray(abuseReport.id, reportIds));
    await users.cleanup();
  });

  it("defaults to a dry run, removes only expired/resolved data and minimizes legacy sessions", async () => {
    const userId = await users.create("Retention test");
    const [group] = await db.insert(community).values({ ownerId: userId, name: "Retention fixture" }).returning();
    const expiredSession = randomUUID();
    const activeSession = randomUUID();
    await db.insert(session).values([
      { id: expiredSession, token: randomUUID(), userId, expiresAt: now, updatedAt: now },
      { id: activeSession, token: randomUUID(), userId, expiresAt: new Date("2100-01-01"), updatedAt: now,
        ipAddress: "192.0.2.1", userAgent: "Mozilla/5.0 (Windows NT 10.0) Chrome/130.0.1 unique-device-id" },
    ]);
    const expiredVerification = randomUUID();
    const activeVerification = randomUUID();
    verificationIds.push(expiredVerification, activeVerification);
    await db.insert(verification).values([
      { id: expiredVerification, identifier: randomUUID(), value: "expired-token", expiresAt: now },
      { id: activeVerification, identifier: randomUUID(), value: "active-token", expiresAt: new Date("2100-01-01") },
    ]);
    const audits = await db.insert(auditLog).values([
      { communityId: group.id, action: "fixture.old", createdAt: older },
      { communityId: group.id, action: "fixture.boundary", createdAt: cutoff },
    ]).returning();
    const instanceAudits = await db.insert(instanceAuditLog).values([
      { action: "fixture.old", targetId: userId, reason: "Retention test", createdAt: older },
      { action: "fixture.boundary", targetId: userId, reason: "Retention test", createdAt: cutoff },
    ]).returning();
    instanceAuditIds.push(...instanceAudits.map((r) => r.id));
    const reports = await db.insert(abuseReport).values([
      { communityId: group.id, reason: "Unresolved report must survive", status: "open", createdAt: older },
      { communityId: group.id, reason: "Expired resolution", status: "dismissed", createdAt: older, resolvedAt: older },
      { communityId: group.id, reason: "Recently resolved old report", status: "removed", createdAt: older, resolvedAt: now },
    ]).returning();
    reportIds.push(...reports.map((r) => r.id));
    const appeals = await db.insert(banAppeal).values([
      { communityId: group.id, userId, banId: randomUUID(), content: "Pending appeal must survive", createdAt: older },
      { communityId: group.id, userId, banId: randomUUID(), content: "Old resolved appeal", createdAt: older, resolvedAt: older, resolution: "uphold" },
    ]).returning();

    const dryRun = await runMaintenance({ now });
    expect(dryRun.apply).toBe(false);
    expect(dryRun.counts.sessions).toBeGreaterThanOrEqual(1);
    expect(await db.select().from(session).where(eq(session.id, expiredSession))).toHaveLength(1);
    const [untouched] = await db.select().from(session).where(eq(session.id, activeSession));
    expect(untouched.ipAddress).toBe("192.0.2.1");

    await runMaintenance({ apply: true, now });
    expect(await db.select().from(session).where(eq(session.id, expiredSession))).toHaveLength(0);
    const [active] = await db.select().from(session).where(eq(session.id, activeSession));
    expect(active.ipAddress).toBeNull();
    expect(active.userAgent).toBe("Chrome on Windows");
    expect(await db.select().from(verification).where(eq(verification.id, expiredVerification))).toHaveLength(0);
    expect(await db.select().from(verification).where(eq(verification.id, activeVerification))).toHaveLength(1);
    expect(await db.select().from(auditLog).where(eq(auditLog.id, audits[0].id))).toHaveLength(0);
    expect(await db.select().from(auditLog).where(eq(auditLog.id, audits[1].id))).toHaveLength(1);
    expect(await db.select().from(instanceAuditLog).where(eq(instanceAuditLog.id, instanceAudits[0].id))).toHaveLength(0);
    expect(await db.select().from(instanceAuditLog).where(eq(instanceAuditLog.id, instanceAudits[1].id))).toHaveLength(1);
    expect(await db.select().from(abuseReport).where(eq(abuseReport.id, reports[0].id))).toHaveLength(1);
    expect(await db.select().from(abuseReport).where(eq(abuseReport.id, reports[1].id))).toHaveLength(0);
    expect(await db.select().from(abuseReport).where(eq(abuseReport.id, reports[2].id))).toHaveLength(1);
    expect(await db.select().from(banAppeal).where(eq(banAppeal.id, appeals[0].id))).toHaveLength(1);
    expect(await db.select().from(banAppeal).where(eq(banAppeal.id, appeals[1].id))).toHaveLength(0);
    expect((await runMaintenance({ apply: true, now })).counts.sessions).toBe(0);
  });

  it("rejects invalid timestamps and unbounded batch settings before querying", async () => {
    await expect(runMaintenance({ now: new Date("invalid") })).rejects.toThrow(/timestamp/);
    await expect(runMaintenance({ batchSize: 0 })).rejects.toThrow(/Batch size/);
    await expect(runMaintenance({ maxBatches: 101 })).rejects.toThrow(/Batch count/);
  });
});
