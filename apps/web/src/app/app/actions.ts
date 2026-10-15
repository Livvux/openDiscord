"use server";
// Thin wrappers: authenticate, call the service (which validates and authorises), refresh the UI.
// Next.js rejects cross-origin Server Action calls, which covers CSRF.
import { refresh } from "next/cache";
import * as automod from "@/server/automod";
import * as blocks from "@/server/blocks";
import * as communities from "@/server/communities";
import { toResult, type ActionResult } from "@/server/errors";
import { consume, MUTATION_LIMIT } from "@/server/limits";
import * as messages from "@/server/messages";
import * as moderation from "@/server/moderation";
import { requireUser } from "@/server/session";
import * as unread from "@/server/unread";

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
export const listChannelOverrides = async (channelId: string) =>
  run((u) => communities.listChannelOverrides(u, channelId), false);
export const setChannelOverride = async (channelId: string, roleId: string, allow: number, deny: number) =>
  run((u) => communities.setChannelOverride(u, channelId, roleId, allow, deny));
export const deleteChannel = async (channelId: string) => run((u) => communities.deleteChannel(u, channelId));

export const createInvite = async (communityId: string, options: { expiresInHours: number | null; maxUses: number | null }) =>
  run((u) => communities.createInvite(u, communityId, options), false);
export const revokeInvite = async (code: string) => run((u) => communities.revokeInvite(u, code));
export const acceptInvite = async (code: string) => run((u) => communities.acceptInvite(u, code), false);

// Messages update the UI through the realtime stream, so they skip the router refresh.
export const sendMessage = async (channelId: string, content: string, attachmentIds: string[] = [], replyToId: string | null = null) =>
  run((u) => messages.sendMessage(u, channelId, content, attachmentIds, replyToId), false);
export const toggleReaction = async (messageId: string, emoji: string) => run((u) => messages.toggleReaction(u, messageId, emoji), false);
export const setPinned = async (messageId: string, pinned: boolean) => run((u) => messages.setPinned(u, messageId, pinned), false);
export const searchMessages = async (communityId: string, query: string, before?: string) =>
  run((u) => messages.searchMessages(u, communityId, query, before), false);
export const listPinned = async (channelId: string) => run((u) => messages.listPinned(u, channelId), false);
export const editMessage = async (messageId: string, content: string) =>
  run((u) => messages.editMessage(u, messageId, content), false);
export const deleteMessage = async (messageId: string) => run((u) => messages.deleteMessage(u, messageId), false);

// Fires often while reading, so it neither refreshes the router nor counts toward the mutation burst limit.
export const markChannelRead = async (channelId: string, messageId: string) =>
  toResult(async () => {
    const user = await requireUser();
    consume(`read:${user.id}`, 60, 60_000);
    await unread.markChannelRead(user.id, channelId, messageId);
  });

export const blockUser = async (userId: string) => run((u) => blocks.blockUser(u, userId));
export const unblockUser = async (userId: string) => run((u) => blocks.unblockUser(u, userId));
export const updateCommunitySafety = async (communityId: string, input: Partial<communities.CommunitySafety>) =>
  run((u) => communities.updateCommunitySafety(u, communityId, input));

export const updateAutomod = async (communityId: string, rules: { words: string[]; blockLinks: boolean }) =>
  run((u) => automod.updateAutomod(u, communityId, rules));

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
