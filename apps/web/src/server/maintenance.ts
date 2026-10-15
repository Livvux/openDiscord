import { and, eq, isNotNull, lt, lte, ne, notInArray, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { abuseReport, banAppeal, applicationRateLimit, auditLog, authRateLimit, instanceAuditLog, session, streamLease, verification } from "@/db/schema";
import { SESSION_DEVICE_LABELS, sessionDeviceLabel } from "@/lib/session-device";

const DAY_MS = 86_400_000;
export const AUDIT_RETENTION_DAYS = 180;

export interface MaintenanceOptions {
  apply?: boolean;
  now?: Date;
  batchSize?: number;
  maxBatches?: number;
}

/** Operator-only, bounded maintenance. No messages, accounts or unresolved reports are deleted. */
export async function runMaintenance({ apply = false, now = new Date(), batchSize = 500, maxBatches = 20 }: MaintenanceOptions = {}) {
  if (!Number.isFinite(now.getTime())) throw new Error("Invalid maintenance timestamp.");
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 1000) throw new Error("Batch size must be between 1 and 1000.");
  if (!Number.isInteger(maxBatches) || maxBatches < 1 || maxBatches > 100) throw new Error("Batch count must be between 1 and 100.");
  const auditCutoff = new Date(now.getTime() - AUDIT_RETENTION_DAYS * DAY_MS);
  const policies = [
    { name: "sessions", table: session, key: session.id, condition: lte(session.expiresAt, now) },
    { name: "verifications", table: verification, key: verification.id, condition: lte(verification.expiresAt, now) },
    { name: "authRateLimits", table: authRateLimit, key: authRateLimit.key, condition: lt(authRateLimit.windowStart, now.getTime() - DAY_MS) },
    { name: "applicationRateLimits", table: applicationRateLimit, key: applicationRateLimit.key, condition: lt(applicationRateLimit.windowStart, now.getTime() - DAY_MS) },
    { name: "streamLeases", table: streamLease, key: streamLease.id, condition: lte(streamLease.expiresAt, now) },
    { name: "communityAudit", table: auditLog, key: auditLog.id, condition: lt(auditLog.createdAt, auditCutoff) },
    { name: "instanceAudit", table: instanceAuditLog, key: instanceAuditLog.id, condition: lt(instanceAuditLog.createdAt, auditCutoff) },
    { name: "resolvedAppeals", table: banAppeal, key: banAppeal.id, condition: lt(banAppeal.resolvedAt, auditCutoff) },
    { name: "resolvedReports", table: abuseReport, key: abuseReport.id, condition: and(ne(abuseReport.status, "open"), lt(abuseReport.resolvedAt, auditCutoff))! },
  ];
  const counts: Record<string, number> = {};
  const limited: string[] = [];
  for (const { name, table, key, condition } of policies) {
    if (!apply) {
      const result = await db.execute<{ count: number }>(sql`select count(*)::int as count from ${table} where ${condition}`);
      counts[name] = result.rows[0].count;
      continue;
    }
    counts[name] = 0;
    for (let batch = 0; batch < maxBatches; batch++) {
      const result = await db.execute(sql`
        with expired as (
          select ${key} as row_key from ${table} where ${condition}
          limit ${batchSize} for update skip locked
        )
        delete from ${table} using expired where ${key} = expired.row_key and ${condition}
        returning ${key}
      `);
      const removed = result.rowCount ?? 0;
      counts[name] += removed;
      if (removed < batchSize) break;
      if (batch === maxBatches - 1) limited.push(name);
    }
  }

  const legacyMetadata = or(isNotNull(session.ipAddress), and(isNotNull(session.userAgent), notInArray(session.userAgent, SESSION_DEVICE_LABELS)))!;
  counts.sessionMetadata = 0;
  if (!apply) {
    const [result] = await db.select({ count: sql<number>`count(*)::int` }).from(session).where(legacyMetadata);
    counts.sessionMetadata = result.count;
  } else {
    for (let batch = 0; batch < maxBatches; batch++) {
      const changed = await db.transaction(async (tx) => {
        const rows = await tx.select({ id: session.id, agent: session.userAgent }).from(session)
          .where(legacyMetadata).limit(batchSize).for("update", { skipLocked: true });
        for (const row of rows) {
          await tx.update(session).set({ ipAddress: null, userAgent: sessionDeviceLabel(row.agent) }).where(eq(session.id, row.id));
        }
        return rows.length;
      });
      counts.sessionMetadata += changed;
      if (changed < batchSize) break;
      if (batch === maxBatches - 1) limited.push("sessionMetadata");
    }
  }
  return { apply, at: now.toISOString(), auditRetentionDays: AUDIT_RETENTION_DAYS, counts, limited };
}
