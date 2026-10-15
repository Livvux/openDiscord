"use server";
// Thin wrappers: authenticate, call the service (which validates and authorises), refresh the UI.
// Next.js rejects cross-origin Server Action calls, which covers CSRF.
import { refresh } from "next/cache";
import * as communities from "@/server/communities";
import { toResult, type ActionResult } from "@/server/errors";
import { consume, MUTATION_LIMIT } from "@/server/limits";
import * as messages from "@/server/messages";
import * as moderation from "@/server/moderation";
import { requireUser } from "@/server/session";

async function run<T>(fn: (userId: string) => Promise<T>, refreshUi = true): Promise<ActionResult<T>> {
  return toResult(async () => {
    const user = await requireUser();
    consume(`mutation:${user.id}`, MUTATION_LIMIT.max, MUTATION_LIMIT.windowMs);
    const data = await fn(user.id);
    if (refreshUi) refresh();
    return data;
  });
}

export const createCommunity = async (name: string) => run((u) => communities.createCommunity(u, name));
export const renameCommunity = async (id: string, name: string) => run((u) => communities.renameCommunity(u, id, name));
export const deleteCommunity = async (id: string) => run((u) => communities.deleteCommunity(u, id));
export const leaveCommunity = async (id: string) => run((u) => communities.leaveCommunity(u, id));

export const createChannel = async (communityId: string, name: string) =>
  run((u) => communities.createChannel(u, communityId, name));
export const updateChannel = async (channelId: string, name: string, topic: string) =>
  run((u) => communities.updateChannel(u, channelId, name, topic));
export const deleteChannel = async (channelId: string) => run((u) => communities.deleteChannel(u, channelId));

export const createInvite = async (communityId: string, options: { expiresInHours: number | null; maxUses: number | null }) =>
  run((u) => communities.createInvite(u, communityId, options), false);
export const revokeInvite = async (code: string) => run((u) => communities.revokeInvite(u, code));
export const acceptInvite = async (code: string) => run((u) => communities.acceptInvite(u, code), false);

// Messages update the UI through the realtime stream, so they skip the router refresh.
export const sendMessage = async (channelId: string, content: string, attachmentIds: string[] = []) =>
  run((u) => messages.sendMessage(u, channelId, content, attachmentIds), false);
export const editMessage = async (messageId: string, content: string) =>
  run((u) => messages.editMessage(u, messageId, content), false);
export const deleteMessage = async (messageId: string) => run((u) => messages.deleteMessage(u, messageId), false);

export const kickMember = async (communityId: string, userId: string, reason: string) =>
  run((u) => moderation.kickMember(u, communityId, userId, reason));
export const banMember = async (communityId: string, userId: string, reason: string) =>
  run((u) => moderation.banMember(u, communityId, userId, reason));
export const unbanMember = async (communityId: string, userId: string) =>
  run((u) => moderation.unbanMember(u, communityId, userId));

export const createRole = async (communityId: string, name: string, permissions: string[]) =>
  run((u) => moderation.createRole(u, communityId, name, permissions));
export const updateRole = async (roleId: string, name: string, permissions: string[]) =>
  run((u) => moderation.updateRole(u, roleId, name, permissions));
export const deleteRole = async (roleId: string) => run((u) => moderation.deleteRole(u, roleId));
export const setMemberRole = async (roleId: string, userId: string, assigned: boolean) =>
  run((u) => moderation.setMemberRole(u, roleId, userId, assigned));

export const reportContent = async (input: { communityId?: string; messageId?: string; reason: string }) =>
  run(async (u) => (await import("@/server/reports")).reportContent(u, input), false);
