"use server";

import { headers } from "next/headers";
import { refresh } from "next/cache";
import { auth } from "@/lib/auth";
import * as admin from "@/server/instance-admin";
import { toResult } from "@/server/errors";
import { consume, MUTATION_LIMIT } from "@/server/limits";
import { requireUser } from "@/server/session";
import { parse } from "@/server/validation";
import { z } from "zod";

async function run<T>(fn: (actor: admin.AdminActor) => Promise<T>, refreshUi = true) {
  return toResult(async () => {
    const user = await requireUser();
    consume(`admin:${user.id}`, MUTATION_LIMIT.max, MUTATION_LIMIT.windowMs);
    const result = await fn({ userId: user.id, sessionId: user.sessionId });
    if (refreshUi) refresh();
    return result;
  });
}
export const verifyAdmin = async (code: string) => run(async (actor) => {
  const source = await headers();
  const parsed = parse(z.string().regex(/^\d{6}$/, "Enter a 6-digit authenticator code."), code);
  await admin.verifyAdminSession(actor, () => auth.api.verifyTOTP({ headers: source, body: { code: parsed } }));
});
export const suspendUser = async (id: string, suspended: boolean, reason: string) => run((a) => admin.setUserSuspension(a, id, suspended, reason));
export const revokeSessions = async (id: string, reason: string) => run((a) => admin.revokeUserSessions(a, id, reason));
export const suspendCommunity = async (id: string, suspended: boolean, reason: string) => run((a) => admin.setCommunitySuspension(a, id, suspended, reason));
export const transferCommunity = async (id: string, email: string, reason: string) => run((a) => admin.transferCommunity(a, id, email, reason));
export const setAdmin = async (id: string, enabled: boolean, reason: string) => run((a) => admin.setInstanceAdmin(a, id, enabled, reason));
export const saveSettings = async (settings: z.infer<typeof admin.settingsInput>, reason: string) => run((a) => admin.updateInstanceSettings(a, settings, reason));
export const reviewReport = async (id: string, reason: string) => run((a) => admin.reviewReport(a, id, reason), false);
export const resolveReport = async (id: string, outcome: "dismissed" | "removed", reason: string) => run((a) => admin.resolveReport(a, id, outcome, reason));
