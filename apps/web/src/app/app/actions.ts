"use server";
// Thin wrappers: authenticate, call the service (which validates and authorises), refresh the UI.
// Next.js rejects cross-origin Server Action calls, which covers CSRF.
import { refresh } from "next/cache";
import * as automod from "@/server/automod";
import * as blocks from "@/server/blocks";
import * as categories from "@/server/categories";
import * as trust from "@/server/community-trust";
import * as communities from "@/server/communities";
import * as friends from "@/server/friends";
import * as integrations from "@/server/integrations";
import { toResult, type ActionResult } from "@/server/errors";
import { consume, MUTATION_LIMIT } from "@/server/limits";
import * as publicChannels from "@/server/public-channels";
import * as messages from "@/server/messages";
import * as moderation from "@/server/moderation";
import * as presence from "@/server/presence";
import * as profile from "@/server/profile";
import * as profileCard from "@/server/profile-card";
import { requireUser } from "@/server/session";
import * as unread from "@/server/unread";

async function run<T>(fn: (userId: string) => Promise<T>, refreshUi = true): Promise<ActionResult<T>> {
  return toResult(async () => {
    const user = await requireUser();
    await consume(`mutation:${user.id}`, MUTATION_LIMIT.max, MUTATION_LIMIT.windowMs);
    const data = await fn(user.id);
    if (refreshUi) refresh();
    return data;
  });
}

export const createCommunity = async (name: string) => run((u) => communities.createCommunity(u, name));
export const renameCommunity = async (id: string, name: string) => run((u) => communities.renameCommunity(u, id, name));
export const deleteCommunity = async (id: string) => run((u) => communities.deleteCommunity(u, id));
export const leaveCommunity = async (id: string) => run((u) => communities.leaveCommunity(u, id));

export const createChannel = async (communityId: string, name: string, kind: "text" | "voice" = "text") =>
  run((u) => communities.createChannel(u, communityId, name, kind));
export const createPublicChannel = async (communityId: string, input: { name: string; communityTitle: string; acknowledge: boolean }) =>
  run((u) => publicChannels.createPublicChannel(u, communityId, input));
export const unpublishChannel = async (channelId: string) => run((u) => publicChannels.unpublishChannel(u, channelId));
export const updateChannel = async (channelId: string, name: string, topic: string) =>
  run((u) => communities.updateChannel(u, channelId, name, topic));
export const listChannelOverrides = async (channelId: string) =>
  run((u) => communities.listChannelOverrides(u, channelId), false);
export const setChannelOverride = async (channelId: string, roleId: string, allow: number, deny: number) =>
  run((u) => communities.setChannelOverride(u, channelId, roleId, allow, deny));
export const createCategory = async (communityId: string, name: string) => run((u) => categories.createCategory(u, communityId, name));
export const renameCategory = async (categoryId: string, name: string) => run((u) => categories.renameCategory(u, categoryId, name));
export const deleteCategory = async (categoryId: string) => run((u) => categories.deleteCategory(u, categoryId));
export const setChannelCategory = async (channelId: string, categoryId: string | null) =>
  run((u) => categories.setChannelCategory(u, channelId, categoryId));
export const deleteChannel = async (channelId: string) => run((u) => communities.deleteChannel(u, channelId));

export const createInvite = async (communityId: string, options: { expiresInHours: number | null; maxUses: number | null }) =>
  run((u) => communities.createInvite(u, communityId, options), false);
export const revokeInvite = async (code: string) => run((u) => communities.revokeInvite(u, code));
export const acceptInvite = async (code: string, rulesVersion?: number) => run((u) => communities.acceptInvite(u, code, rulesVersion), false);

// Messages update the UI through the realtime stream, so they skip the router refresh.
export const sendMessage = async (
  channelId: string,
  content: string,
  attachmentIds: string[] = [],
  replyToId: string | null = null,
  threadId: string | null = null,
  publicGeneration: string | null = null,
) => run((u) => messages.sendMessage(u, channelId, content, attachmentIds, replyToId, threadId, publicGeneration), false);
export const toggleReaction = async (messageId: string, emoji: string) => run((u) => messages.toggleReaction(u, messageId, emoji), false);
export const setPinned = async (messageId: string, pinned: boolean) => run((u) => messages.setPinned(u, messageId, pinned), false);
export const searchMessages = async (communityId: string, query: string, before?: string) =>
  run((u) => messages.searchMessages(u, communityId, query, before), false);
export const listPinned = async (channelId: string) => run((u) => messages.listPinned(u, channelId), false);
export const editMessage = async (messageId: string, content: string, publicGeneration: string | null = null) =>
  run((u) => messages.editMessage(u, messageId, content, publicGeneration), false);
export const deleteMessage = async (messageId: string) => run((u) => messages.deleteMessage(u, messageId), false);

// Fires often while reading, so it neither refreshes the router nor counts toward the mutation burst limit.
export const markChannelRead = async (channelId: string, messageId: string) =>
  toResult(async () => {
    const user = await requireUser();
    await consume(`read:${user.id}`, 60, 60_000);
    await unread.markChannelRead(user.id, channelId, messageId);
  });

export const blockUser = async (userId: string) => run((u) => blocks.blockUser(u, userId));
export const unblockUser = async (userId: string) => run((u) => blocks.unblockUser(u, userId));
export const updateCommunitySafety = async (communityId: string, input: Partial<communities.CommunitySafety>) =>
  run((u) => communities.updateCommunitySafety(u, communityId, input));

export const updateAutomod = async (communityId: string, rules: { words: string[]; blockLinks: boolean }) =>
  run((u) => automod.updateAutomod(u, communityId, rules));

export const setPresenceVisible = async (visible: boolean) => run((u) => presence.setPresenceVisible(u, visible));
export const setPresenceStatus = async (choice: string) => run((u) => presence.setPresenceStatus(u, choice));
export const updateProfile = async (input: { bio: string; customStatus: string }) => run((u) => profile.updateProfile(u, input));
export const setCustomStatus = async (text: string) => run((u) => profile.setCustomStatus(u, text));

export const getProfileCard = async (userId: string) => run((u) => profileCard.getProfileCard(u, userId), false);
export const sendFriendRequest = async (target: string) => run((u) => friends.sendFriendRequest(u, target));
export const respondToFriendRequest = async (otherId: string, accept: boolean) => run((u) => friends.respondToFriendRequest(u, otherId, accept));
export const removeFriend = async (otherId: string) => run((u) => friends.removeFriend(u, otherId));
export const searchPeople = async (query: string) => run((u) => friends.searchPeople(u, query), false);
export const setNotificationLevel = async (communityId: string, level: "mentions" | "muted") =>
  run((u) => presence.setNotificationLevel(u, communityId, level));


export const createIntegration = async (
  communityId: string,
  input: { kind: "bot"; name: string } | { kind: "webhook"; name: string; channelId: string },
) => run((u) => integrations.createIntegration(u, communityId, input));
export const revokeIntegration = async (id: string) => run((u) => integrations.revokeIntegration(u, id));

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

export const updateCommunityRules = async (id: string, input: { text: string; required: boolean }) => run((u) => trust.updateCommunityRules(u, id, input));
export const acknowledgeCommunityRules = async (id: string, version: number) => run((u) => trust.acknowledgeCommunityRules(u, id, version));
export const submitBanAppeal = async (id: string, content: string) => run((u) => trust.submitBanAppeal(u, id, content));
export const resolveBanAppeal = async (id: string, appealId: string, resolution: "uphold" | "unban", note: string) => run((u) => trust.resolveBanAppeal(u, id, appealId, resolution, note));
