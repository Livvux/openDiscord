"use server";

import { refresh } from "next/cache";
import * as admin from "@/server/instance-admin";
import { toResult } from "@/server/errors";
import { consume, MUTATION_LIMIT } from "@/server/limits";
import { requireUser } from "@/server/session";
import type { z } from "zod";

async function run<T>(fn: (actor: admin.AdminActor) => Promise<T>, refreshUi = true) {
  return toResult(async () => {
    const user = await requireUser();
    consume(`admin:${user.id}`, MUTATION_LIMIT.max, MUTATION_LIMIT.windowMs);
    const result = await fn({ userId: user.id, sessionId: user.sessionId });
    if (refreshUi) refresh();
    return result;
  });
}
export const suspendUser = async (id: string, suspended: boolean, reason: string) => run((a) => admin.setUserSuspension(a, id, suspended, reason));
export const revokeSessions = async (id: string, reason: string) => run((a) => admin.revokeUserSessions(a, id, reason));
export const suspendCommunity = async (id: string, suspended: boolean, reason: string) => run((a) => admin.setCommunitySuspension(a, id, suspended, reason));
export const transferCommunity = async (id: string, email: string, reason: string) => run((a) => admin.transferCommunity(a, id, email, reason));
export const setAdmin = async (id: string, enabled: boolean, reason: string) => run((a) => admin.setInstanceAdmin(a, id, enabled, reason));
export const saveSettings = async (settings: z.infer<typeof admin.settingsInput>, reason: string) => run((a) => admin.updateInstanceSettings(a, settings, reason));
export const reviewReport = async (id: string, reason: string) => run((a) => admin.reviewReport(a, id, reason), false);
export const resolveReport = async (id: string, outcome: "dismissed" | "removed", reason: string) => run((a) => admin.resolveReport(a, id, outcome, reason));
