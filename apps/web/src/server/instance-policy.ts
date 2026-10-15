import { eq } from "drizzle-orm";
import { db } from "@/db";
import { instanceAdmin, instanceSettings, user, userSuspension } from "@/db/schema";
import type { Db } from "./access";
import { AppError, forbidden } from "./errors";
import { CAPS } from "./limits";
import { BLOCKED_MESSAGES, type BlockedState } from "@/lib/account-state";

export async function isInstanceAdmin(userId: string, tx: Db = db): Promise<boolean> {
  const [row] = await tx.select({ id: instanceAdmin.userId }).from(instanceAdmin).where(eq(instanceAdmin.userId, userId));
  return !!row;
}
/** The account may not use the app. `state` lets sign-in and pages explain why. */
export class AccountBlocked extends AppError {
  constructor(readonly state: BlockedState) {
    super("forbidden", BLOCKED_MESSAGES[state]);
  }
}

/** Runs on every authenticated request and session creation: suspension and the Closed Alpha gate. */
export async function assertActiveUser(userId: string, tx: Db = db) {
  const [row] = await tx
    .select({ suspended: userSuspension.userId, approval: user.approvalStatus, admin: instanceAdmin.userId, closedAlpha: instanceSettings.closedAlpha })
    .from(user)
    .leftJoin(userSuspension, eq(userSuspension.userId, user.id))
    .leftJoin(instanceAdmin, eq(instanceAdmin.userId, user.id))
    .leftJoin(instanceSettings, eq(instanceSettings.id, "instance"))
    .where(eq(user.id, userId));
  if (!row) return;
  if (row.suspended) throw new AccountBlocked("suspended");
  // Administrators are never gated, so enabling Closed Alpha can't lock the operator out.
  if (row.admin) return;
  // A rejection is a decision about the person and outlives the switch; pending only waits while it's on.
  if (row.approval === "rejected" || (row.closedAlpha && row.approval === "pending")) throw new AccountBlocked(row.approval);
}
export async function getInstanceSettings(tx: Db = db) {
  const [settings] = await tx.select().from(instanceSettings).where(eq(instanceSettings.id, "instance"));
  return settings ?? { id: "instance", registrationOpen: true, closedAlpha: false, inviteMode: "members" as const, ...CAPS };
}
export async function assertInvitesAllowed(userId?: string, tx: Db = db) {
  const settings = await getInstanceSettings(tx);
  if (settings.inviteMode === "disabled") throw forbidden("Invitations are disabled on this instance.");
  if (userId && settings.inviteMode === "admins" && !(await isInstanceAdmin(userId, tx))) {
    throw forbidden("Only instance administrators can create invitations.");
  }
}
