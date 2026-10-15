import { lockVoiceLifecycle } from "../src/server/voice-locks";
// Operator-only bootstrap. Existing admins must grant further rights through the admin UI.
import { eq, sql } from "drizzle-orm";
import { db } from "../src/db";
import { instanceAdmin, instanceAuditLog, user, userSuspension } from "../src/db/schema";

const [email, reason] = process.argv.slice(2);
if (!email || !reason || reason.trim().length < 3 || reason.length > 512) {
  throw new Error('Usage: pnpm --filter web admin:bootstrap <existing-email> "<reason>"');
}
async function main() {
  try {
    await db.transaction(async (tx) => {
      await lockVoiceLifecycle(tx, "auth");
      await tx.execute(sql`select pg_advisory_xact_lock(187412, 1)`);
      const existing = await tx.select({ id: instanceAdmin.userId }).from(instanceAdmin).limit(1);
      if (existing.length) throw new Error("An instance administrator already exists. Use instance administration to grant rights.");
      const [target] = await tx.select({ id: user.id }).from(user).where(eq(user.email, email.toLowerCase()));
      if (!target) throw new Error("No existing account with this email address.");
      const [suspended] = await tx.select({ id: userSuspension.userId }).from(userSuspension).where(eq(userSuspension.userId, target.id));
      if (suspended) throw new Error("A suspended account cannot become an administrator.");
      await tx.insert(instanceAdmin).values({ userId: target.id });
      await tx.update(user).set({ approvalStatus: "approved" }).where(eq(user.id, target.id));
      await tx.insert(instanceAuditLog).values({ actorId: target.id, action: "admin.bootstrap", targetId: target.id, reason: `Operator bootstrap: ${reason.trim()}` });
    });
    console.log("First instance administrator assigned to the existing account. Sign in and open /app/admin.");
  } finally {
    await db.$client.end();
  }
}
void main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : "Bootstrap failed."); process.exitCode = 1; });
