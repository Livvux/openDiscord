import { and, count, eq, gt, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { abuseReport, message } from "@/db/schema";
import { requireChannel, requireMember } from "./access";
import { AppError, notFound } from "./errors";
import { parse, uuid } from "./validation";
import { z } from "zod";

export const requiredReason = z.string().trim().min(3, "Give a reason (at least 3 characters).").max(512);

export async function reportContent(userId: string, input: unknown) {
  const data = parse(z.object({ communityId: uuid.optional(), messageId: uuid.optional(), reason: requiredReason })
    .refine((v) => !!v.communityId !== !!v.messageId, "Choose one report target."), input);
  return db.transaction(async (tx) => {
    // Cross-process rate limit and deduplication, without copying private message content.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${userId}, 1))`);
    const [{ recent }] = await tx.select({ recent: count() }).from(abuseReport)
      .where(and(eq(abuseReport.reporterId, userId), gt(abuseReport.createdAt, new Date(Date.now() - 3_600_000))));
    if (recent >= 10) throw new AppError("rate_limited", "You can submit at most 10 reports per hour.");
    let communityId = data.communityId;
    if (data.messageId) {
      const [row] = await tx.select({ channelId: message.channelId }).from(message).where(eq(message.id, data.messageId));
      if (!row) throw notFound("Message not found.");
      communityId = (await requireChannel(tx, row.channelId, userId)).channel.communityId;
    } else if (communityId) await requireMember(tx, communityId, userId);
    if (!communityId) throw notFound();
    const [existing] = await tx.select({ id: abuseReport.id }).from(abuseReport).where(and(
      eq(abuseReport.reporterId, userId), eq(abuseReport.communityId, communityId), eq(abuseReport.status, "open"),
      data.messageId ? eq(abuseReport.messageId, data.messageId) : isNull(abuseReport.messageId),
    ));
    if (existing) throw new AppError("conflict", "You have already reported this content.");
    await tx.insert(abuseReport).values({ reporterId: userId, communityId, messageId: data.messageId, reason: data.reason });
  });
}
