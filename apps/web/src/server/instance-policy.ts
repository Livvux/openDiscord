import { eq } from "drizzle-orm";
import { db } from "@/db";
import { instanceAdmin, instanceSettings, userSuspension } from "@/db/schema";
import type { Db } from "./access";
import { forbidden } from "./errors";
import { CAPS } from "./limits";

export async function isInstanceAdmin(userId: string, tx: Db = db): Promise<boolean> {
  const [row] = await tx.select({ id: instanceAdmin.userId }).from(instanceAdmin).where(eq(instanceAdmin.userId, userId));
  return !!row;
}
export async function assertActiveUser(userId: string, tx: Db = db) {
  const [row] = await tx.select({ id: userSuspension.userId }).from(userSuspension).where(eq(userSuspension.userId, userId));
  if (row) throw forbidden("Your account is suspended. Contact the instance operator.");
}
export async function getInstanceSettings(tx: Db = db) {
  const [settings] = await tx.select().from(instanceSettings).where(eq(instanceSettings.id, "instance"));
  return settings ?? { id: "instance", registrationOpen: true, inviteMode: "members" as const, ...CAPS };
}
export async function assertInvitesAllowed(userId?: string, tx: Db = db) {
  const settings = await getInstanceSettings(tx);
  if (settings.inviteMode === "disabled") throw forbidden("Invitations are disabled on this instance.");
  if (userId && settings.inviteMode === "admins" && !(await isInstanceAdmin(userId, tx))) {
    throw forbidden("Only instance administrators can create invitations.");
  }
}
