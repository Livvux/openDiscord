import { lockVoiceLifecycle } from "./voice-locks";
import { invalidateVoiceMembership } from "./voice-control";
import { createHash } from "node:crypto";
import { and, eq, inArray, or } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { dmBackup, dmCryptoReceipt, dmDevice, dmIdentity, dmKey, dmMailbox, dmSignature, instanceAuditLog, session, user } from "@/db/schema";
import type { DmResetState } from "@/lib/dm/contracts";
import { AppError, forbidden } from "./errors";
import { assertActiveUser } from "./instance-policy";
import { parse } from "./validation";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
const FRESH_MS = 5 * 60_000;
function fingerprint(identity: typeof dmIdentity.$inferSelect | undefined): string | null {
  if (!identity) return null;
  const { keys } = parse(z.object({ keys: z.record(z.string(), z.string()) }), identity.keys.master_key);
  return createHash("sha256").update(JSON.stringify(Object.entries(keys).sort(([a], [b]) => a.localeCompare(b)))).digest("hex");
}
async function readState(tx: Tx, actor: string, sessionId: string): Promise<DmResetState> {
  await assertActiveUser(actor, tx);
  const [current] = await tx.select({ createdAt: session.createdAt, expiresAt: session.expiresAt, twoFactorEnabled: user.twoFactorEnabled })
    .from(session).innerJoin(user, eq(user.id, session.userId)).where(and(eq(session.id, sessionId), eq(session.userId, actor)));
  if (!current || current.expiresAt.getTime() <= Date.now()) throw forbidden("Sign in again before resetting encryption.");
  const [identity] = await tx.select().from(dmIdentity).where(eq(dmIdentity.userId, actor));
  const age = Date.now() - current.createdAt.getTime();
  return { identity: fingerprint(identity), twoFactorEnabled: current.twoFactorEnabled === true, freshSession: age >= 0 && age < FRESH_MS };
}
export function dmResetState(actor: string, sessionId: string): Promise<DmResetState> {
  return db.transaction((tx) => readState(tx, actor, sessionId));
}
/** Called only after route-level password and, when enabled, TOTP verification. */
export async function resetDmIdentity(actor: string, sessionId: string, expected: { identity: string; twoFactorEnabled: boolean }): Promise<void> {
  await db.transaction(async (tx) => {
    await lockVoiceLifecycle(tx, "auth");
    // Account mutations consistently lock the user before any session rows.
    await tx.select({ id: user.id }).from(user).where(eq(user.id, actor)).for("update");
    const current = await readState(tx, actor, sessionId);
    if (!current.freshSession) throw forbidden("Sign in again within five minutes before resetting encryption.");
    if (!current.identity || current.identity !== expected.identity || current.twoFactorEnabled !== expected.twoFactorEnabled) throw new AppError("conflict", "Account security changed. Reopen the reset form and verify again.");
    await invalidateVoiceMembership(tx, { userId: actor }, "identity-reset");
    const ownDevices = tx.select({ id: dmDevice.id }).from(dmDevice).where(eq(dmDevice.userId, actor));
    await tx.update(dmDevice).set({ revokedAt: new Date(), keys: null }).where(eq(dmDevice.userId, actor));
    await tx.delete(dmKey).where(inArray(dmKey.deviceId, ownDevices));
    await tx.delete(dmMailbox).where(or(inArray(dmMailbox.deviceId, ownDevices), eq(dmMailbox.senderId, actor)));
    await tx.delete(dmCryptoReceipt).where(inArray(dmCryptoReceipt.deviceId, ownDevices));
    await tx.delete(dmSignature).where(or(eq(dmSignature.signerId, actor), eq(dmSignature.targetId, actor)));
    await tx.delete(dmBackup).where(eq(dmBackup.userId, actor));
    await tx.delete(dmIdentity).where(eq(dmIdentity.userId, actor));
    await tx.delete(session).where(eq(session.userId, actor));
    await tx.insert(instanceAuditLog).values({ actorId: actor, action: "dm.identity.reset", targetId: actor, reason: "Explicit encryption identity reset after fresh account authentication." });
  });
}
