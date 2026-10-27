import { SettingsIcon } from "lucide-react";
import Link from "next/link";
import type { CommunityView } from "@/server/communities";
import { has, Permission } from "@/server/permissions";
import { CategoryGroup } from "./category-group";
import { ChannelLink } from "./channel-link";
import { communityImageUrl } from "./community-icon";
import { getMessages } from "@/lib/i18n/server";
import { CreateChannelDialog } from "./create-channel-dialog";
import { voiceEnabled } from "@/server/voice";
import { InviteDialog } from "./invite-dialog";
import { ServerContextMenu } from "./server-context-menu";
import { ServerMenuButton } from "./server-menu-button";

const SETTINGS_PERMISSIONS =
  Permission.ManageCommunity | Permission.ManageRoles | Permission.KickMembers | Permission.BanMembers | Permission.ViewAuditLog;

export async function ChannelSidebar({ view }: { view: CommunityView }) {
  const { community: t } = await getMessages();
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
        {/* With a banner, Discord lays the header over the picture's top edge. */}
        <div className="relative shrink-0">
        {view.bannerId && (
          // eslint-disable-next-line @next/next/no-img-element -- already re-encoded WebP behind an authenticated route
          <img src={communityImageUrl(view.bannerId)} alt="" className="block aspect-video max-h-36 w-full object-cover" draggable={false} />
        )}
        <header className={`flex h-12 shrink-0 items-center gap-0.5 px-2 ${view.bannerId ? "absolute inset-x-0 top-0 bg-linear-to-b from-black/60 to-transparent [&_a]:text-white [&_button]:text-white" : "border-b"}`}>
          <h2 className="flex min-w-0 flex-1 items-center"><ServerMenuButton name={view.name} verified={view.verified} /></h2>
          {canManageChannels && <CreateChannelDialog communityId={view.id} voiceEnabled={voiceEnabled} isOwner={view.isOwner} />}
          {has(view.authority, Permission.CreateInvites) && <InviteDialog communityId={view.id} communityName={view.name} iconTrigger />}
          <Link
            href={`/app/c/${view.id}/settings`}
            aria-label={canModerate ? t.settings : t.info}
            title={canModerate ? t.settings : t.info}
            className="grid size-8 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-white/[0.06] hover:text-sidebar-foreground focus-visible:outline-2 focus-visible:outline-ring"
          >
            <SettingsIcon className="size-4" />
          </Link>
        </header>
        </div>
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
