import { SettingsIcon } from "lucide-react";
import Link from "next/link";
import type { CommunityView } from "@/server/communities";
import { has, Permission } from "@/server/permissions";
import { CategoryGroup } from "./category-group";
import { ChannelLink } from "./channel-link";
import { CreateChannelDialog } from "./create-channel-dialog";
import { voiceEnabled } from "@/server/voice";
import { InviteDialog } from "./invite-dialog";
import { ServerContextMenu } from "./server-context-menu";
import { ServerMenuButton } from "./server-menu-button";

const SETTINGS_PERMISSIONS =
  Permission.ManageCommunity | Permission.ManageRoles | Permission.KickMembers | Permission.BanMembers | Permission.ViewAuditLog;

export function ChannelSidebar({ view }: { view: CommunityView }) {
  const canManageChannels = has(view.authority, Permission.ManageChannels);
  const loose = view.channels.filter((c) => !c.categoryId);
  const link = (c: CommunityView["channels"][number]) => (
    <li key={c.id}>
      <ChannelLink channelId={c.id} href={`/app/c/${view.id}/${c.id}`} name={c.name} isPrivate={c.isPrivate} kind={c.kind} />
    </li>
  );
  const canModerate = (view.authority.permissions & SETTINGS_PERMISSIONS) !== 0;
  return (
    <>
      <ServerContextMenu
        community={{ id: view.id, name: view.name, authority: view.authority, notifications: view.notifications }}
        tabIndex={-1}
      >
        <header className="flex h-12 shrink-0 items-center gap-0.5 border-b px-2">
          <h2 className="flex min-w-0 flex-1"><ServerMenuButton name={view.name} /></h2>
          {canManageChannels && <CreateChannelDialog communityId={view.id} voiceEnabled={voiceEnabled} isOwner={view.isOwner} />}
          {has(view.authority, Permission.CreateInvites) && <InviteDialog communityId={view.id} communityName={view.name} iconTrigger />}
          <Link
            href={`/app/c/${view.id}/settings`}
            aria-label={canModerate ? "Community settings" : "Community info"}
            title={canModerate ? "Community settings" : "Community info"}
            className="grid size-8 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-white/[0.06] hover:text-sidebar-foreground focus-visible:outline-2 focus-visible:outline-ring"
          >
            <SettingsIcon className="size-4" />
          </Link>
        </header>
      </ServerContextMenu>
      {/* Bottom padding keeps the last channels above the floating user panel. */}
      <ul className="flex-1 space-y-0.5 overflow-y-auto px-2 pt-3 pb-20">
        {loose.filter((c) => c.kind === "text").map(link)}
        {loose.filter((c) => c.kind === "voice").map(link)}
        {view.categories.map((cat) => {
          const inside = view.channels.filter((c) => c.categoryId === cat.id);
          return (
            <CategoryGroup key={cat.id} id={cat.id} name={cat.name} hrefs={inside.map((c) => `/app/c/${view.id}/${c.id}`)}>
              {inside.map(link)}
            </CategoryGroup>
          );
        })}
      </ul>
    </>
  );
}
