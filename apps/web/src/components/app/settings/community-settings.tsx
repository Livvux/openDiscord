import { CommunityAssetsEditor } from "@/components/app/settings/community-assets-editor";
import { listCommunityAssets } from "@/server/community-assets";
import { Suspense } from "react";
import { CommunityRules } from "@/components/app/community-rules";
import { BanAppeals } from "@/components/app/ban-appeals";
import { getCommunityRules, listBanAppeals } from "@/server/community-trust";
import { SettingsModal, SettingsSection as Section, type SettingsGroup } from "@/components/app/settings/settings-modal";
import { BanList, DangerZone, InviteList, RenameCommunity } from "@/components/app/settings/community-admin";
import { MembersManager } from "@/components/app/settings/members-manager";
import { RolesEditor } from "@/components/app/settings/roles-editor";
import { getCommunitySafety, listInvites } from "@/server/communities";
import { SafetySettings } from "@/components/app/settings/safety-settings";
import { AutomodSettings } from "@/components/app/settings/automod-settings";
import { NotificationLevel } from "@/components/app/settings/notification-level";
import { CategoriesEditor } from "@/components/app/settings/categories-editor";
import { getAutomod } from "@/server/automod";
import { getListing } from "@/server/discovery";
import { DiscoverListing } from "@/components/app/settings/discover-listing";
import { blockedIds } from "@/server/blocks";
import { listIntegrations } from "@/server/integrations";
import { IntegrationsEditor } from "@/components/app/settings/integrations-editor";
import { listAuditLog, listBans, listMembers, listRoles, type AuditEntry } from "@/server/moderation";
import { loadCommunityView } from "@/server/pages";
import { has, Permission } from "@/server/permissions";
import { requirePageUser } from "@/server/session";
import { DiamondOrbitSmoothLoader } from "@/components/ui/diamond-orbit-smooth-loader";

const AUDIT_LABELS: Record<string, string> = {
  "asset.create": "uploaded community image",
  "asset.delete": "deleted community image",
  "community.rules": "updated community rules",
  "ban.appeal": "submitted a ban appeal",
  "ban.appeal.uphold": "upheld a ban appeal for",
  "ban.appeal.unban": "accepted a ban appeal for",
  "member.kick": "kicked",
  "member.ban": "banned",
  "member.unban": "unbanned",
  "message.delete": "deleted a message by",
  "message.pin": "pinned a message by",
  "message.unpin": "unpinned a message by",
  "role.create": "created a role",
  "role.update": "updated a role",
  "role.delete": "deleted role",
  "role.assign": "gave a role to",
  "role.unassign": "removed a role from",
  "channel.delete": "deleted channel",
  "channel.permissions": "changed permissions of channel",
  "community.export": "exported the community",
  "community.import": "imported this community",
  "category.create": "created category",
  "category.rename": "renamed a category to",
  "category.delete": "deleted category",
  "invites.pause": "paused invites",
  "invites.resume": "resumed invites",
  "invites.auto_pause": "Raid protection paused invites",
  "community.safety": "changed safety settings",
  "automod.update": "changed AutoMod rules",
  "bot.create": "added the bot",
  "bot.revoke": "revoked the bot",
  "webhook.create": "created the webhook",
  "webhook.revoke": "revoked the webhook",
  "automod.block": "had a message blocked by AutoMod",
  "discover.list": "listed the community in Discover",
  "discover.unlist": "removed the community from Discover",
};

/** Person actions point at a user id; deletions store the deleted name; role edits show nothing. */
function auditTarget(e: AuditEntry): string | null {
  if (["asset.create", "asset.delete", "role.delete", "category.create", "category.rename", "category.delete"].includes(e.action)) return e.targetId;
  if (e.action === "channel.permissions") return e.targetId ? `#${e.targetId}` : "a private channel";
  if (e.action === "channel.delete") return e.targetId ?? "a private channel";
  if (["community.rules", "role.create", "role.update", "invites.pause", "invites.resume", "invites.auto_pause", "community.safety", "automod.update", "automod.block", "community.export", "community.import", "discover.list", "discover.unlist"].includes(e.action)) return null;
  return e.targetName ?? "a deleted user";
}

export function CommunitySettings({ params, intercepted = false }: Pick<PageProps<"/app/c/[communityId]/settings">, "params"> & { intercepted?: boolean }) {
  return (
    <Suspense fallback={<div className="p-6 text-primary"><DiamondOrbitSmoothLoader /></div>}>
      <Settings params={params} intercepted={intercepted} />
    </Suspense>
  );
}

async function Settings({ params, intercepted }: Pick<PageProps<"/app/c/[communityId]/settings">, "params"> & { intercepted: boolean }) {
  const { communityId } = await params;
  const user = await requirePageUser();
  const view = await loadCommunityView(user.id, communityId);
  const a = view.authority;
  const [members, roles, invites, bans, audit, safety, automod, integrations, blockedUserIds] = await Promise.all([
    listMembers(user.id, view.id),
    listRoles(user.id, view.id),
    has(a, Permission.ManageCommunity) ? listInvites(user.id, view.id) : null,
    has(a, Permission.BanMembers) ? listBans(user.id, view.id) : null,
    has(a, Permission.ViewAuditLog) ? listAuditLog(user.id, view.id) : null,
    has(a, Permission.ManageCommunity) ? getCommunitySafety(user.id, view.id) : null,
    has(a, Permission.ManageCommunity) ? getAutomod(user.id, view.id) : null,
    has(a, Permission.ManageCommunity) ? listIntegrations(user.id, view.id) : null,
    blockedIds(user.id),
  ]);
  const [assets, rules, appeals] = await Promise.all([has(a, Permission.ManageCommunity) ? listCommunityAssets(user.id, view.id) : [], getCommunityRules(user.id, view.id), has(a, Permission.BanMembers) ? listBanAppeals(user.id, view.id) : null]);
  const listing = view.isOwner ? await getListing(user.id, view.id) : null;
  const canModerateMembers = has(a, Permission.KickMembers) || has(a, Permission.BanMembers) || has(a, Permission.ManageRoles);

  const groups: SettingsGroup[] = [
    { label: view.name, sections: [
      ...(has(a, Permission.ManageCommunity) ? [["overview", "Overview"], ["community-assets", "Emoji and stickers"]] as [string, string][] : []),
      ["community-rules", "Community rules"],
      ...(has(a, Permission.ManageRoles) ? [["roles", "Roles"]] as [string, string][] : []),
      ...(has(a, Permission.ManageChannels) ? [["categories", "Categories"]] as [string, string][] : []),
    ] },
    { label: "Moderation", sections: [
      ["members", "Members"],
      ...(safety ? [["safety", "Safety"]] as [string, string][] : []),
      ...(automod ? [["automod", "AutoMod"]] as [string, string][] : []),
      ...(bans ? [["bans", "Bans"]] as [string, string][] : []),
      ...(appeals ? [["ban-appeals", "Ban appeals"]] as [string, string][] : []),
      ...(audit ? [["audit", "Audit log"]] as [string, string][] : []),
    ] },
    { label: "Community settings", sections: [
      ...(integrations ? [["integrations", "Bots and webhooks"]] as [string, string][] : []),
      ...(invites ? [["invites", "Active invites"]] as [string, string][] : []),
      ["notifications", "Notifications"],
      ...(view.isOwner ? [["export", "Export"]] as [string, string][] : []),
      ["danger", view.isOwner ? "Delete community" : "Leave community"],
    ] },
  ];

  return (
    <SettingsModal title="Community settings" closeHref={`/app/c/${view.id}`} intercepted={intercepted} groups={groups}>
      <Section id="community-rules" title="Community rules"><CommunityRules communityId={view.id} rules={rules} canManage={has(a, Permission.ManageCommunity)} /></Section>
      {has(a, Permission.ManageCommunity) && (
        <Section id="overview" title="Overview">
          <RenameCommunity communityId={view.id} name={view.name} />
          {listing && <DiscoverListing communityId={view.id} listing={listing} />}
        </Section>
      )}
      {has(a, Permission.ManageCommunity) && <Section id="community-assets" title="Emoji and stickers"><CommunityAssetsEditor communityId={view.id} initialAssets={assets} /></Section>}
      <Section
        id="members"
        title={`Members (${members.length})`}
        description={canModerateMembers ? "You can moderate members ranked below your highest role." : undefined}
      >
        <MembersManager communityId={view.id} currentUserId={user.id} authority={a} members={members} roles={roles} blockedUserIds={blockedUserIds} />
      </Section>
      {has(a, Permission.ManageRoles) && (
        <Section
          id="roles"
          title="Roles"
          description="Roles grant permissions. Higher roles outrank lower ones; you can only manage roles below your own."
        >
          <RolesEditor communityId={view.id} authority={a} roles={roles} />
        </Section>
      )}
      {has(a, Permission.ManageChannels) && (
        <Section id="categories" title="Categories" description="Group channels in the sidebar.">
          <CategoriesEditor communityId={view.id} categories={view.categories} />
        </Section>
      )}
      {safety && (
        <Section id="safety" title="Safety" description="Control who can join. Changes are recorded in the audit log.">
          <SafetySettings communityId={view.id} safety={safety} />
        </Section>
      )}
      {automod && (
        <Section id="automod" title="AutoMod" description="Refuses messages that break these rules before anyone sees them. Refusals appear in the audit log without the message.">
          <AutomodSettings communityId={view.id} rules={automod} />
        </Section>
      )}
      {integrations && (
        <Section id="integrations" title="Bots and webhooks" description="Connect other tools. Tokens are shown once; creation and revocation are audited.">
          <IntegrationsEditor
            communityId={view.id}
            integrations={integrations}
            textChannels={view.channels.filter((c) => c.kind === "text").map(({ id, name }) => ({ id, name }))}
          />
        </Section>
      )}
      {invites && (
        <Section id="invites" title="Active invites">
          <InviteList invites={invites} />
        </Section>
      )}
      {bans && (
        <Section id="bans" title="Bans">
          <BanList communityId={view.id} bans={bans} />
        </Section>
      )}
      {appeals && <Section id="ban-appeals" title="Ban appeals" description="The latest 100 appeals. Only moderators with ban permission can review them; the ban issuer’s rank also applies."><BanAppeals communityId={view.id} appeals={appeals} /></Section>}
      {audit && (
        <Section id="audit" title="Audit log" description="The last 100 moderation actions. Message contents are never logged.">
          {audit.length === 0 ? (
            <p className="text-sm text-muted-foreground">Nothing yet.</p>
          ) : (
            <ol className="divide-y rounded-lg border text-sm">
              {audit.map((e) => (
                <li key={e.id} className="flex flex-wrap gap-x-1 px-3 py-2">
                  {e.action !== "invites.auto_pause" && <span className="font-medium">{e.actorName ?? "Deleted user"}</span>}
                  <span>{AUDIT_LABELS[e.action] ?? e.action}</span>
                  {auditTarget(e) && <span className="font-medium">{auditTarget(e)}</span>}
                  {e.reason && <span className="text-muted-foreground">— {e.reason}</span>}
                  <time dateTime={e.createdAt.toISOString()} className="ml-auto text-xs text-muted-foreground" suppressHydrationWarning>
                    {e.createdAt.toLocaleString()}
                  </time>
                </li>
              ))}
            </ol>
          )}
        </Section>
      )}
      <Section id="notifications" title="Notifications" description="Applies to you only.">
        <NotificationLevel communityId={view.id} level={view.notifications} />
      </Section>
      {view.isOwner && (
        <Section id="export" title="Export" description="Download channels, roles, categories and messages as JSON to move this community to another instance. Includes every member's messages; the export is recorded in the audit log.">
          <a
            href={`/api/communities/${view.id}/export`}
            download
            className="inline-flex h-8 items-center rounded-lg border px-3 text-sm font-medium hover:bg-muted"
          >
            Download community export
          </a>
          <a
            href={`/api/communities/${view.id}/export?attachments=1`}
            download
            className="ml-2 inline-flex min-h-8 items-center rounded-lg border px-3 py-1 text-sm font-medium hover:bg-muted"
          >
            Download archive with files
          </a>
          <p className="mt-2 text-xs text-muted-foreground">JSON excludes files. The complete archive includes every file attached to the newest 100,000 messages, up to 4,096 files and 256 MiB. Larger exports fail instead of omitting files. Concurrent edits may change the export; keep a separate operator backup.</p>
        </Section>
      )}
      <Section id="danger" title={view.isOwner ? "Delete community" : "Leave community"}>
        <DangerZone communityId={view.id} name={view.name} isOwner={view.isOwner} />
      </Section>
    </SettingsModal>
  );
}
