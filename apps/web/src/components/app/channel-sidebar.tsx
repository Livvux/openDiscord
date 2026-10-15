import { SettingsIcon } from "lucide-react";
import Link from "next/link";
import type { CommunityView } from "@/server/communities";
import { has, Permission } from "@/server/permissions";
import { ChannelLink } from "./channel-link";
import { CreateChannelDialog } from "./create-channel-dialog";
import { InviteDialog } from "./invite-dialog";

const SETTINGS_PERMISSIONS =
  Permission.ManageCommunity | Permission.ManageRoles | Permission.KickMembers | Permission.BanMembers | Permission.ViewAuditLog;

export function ChannelSidebar({ view }: { view: CommunityView }) {
  const canManageChannels = has(view.authority, Permission.ManageChannels);
  const canModerate = (view.authority.permissions & SETTINGS_PERMISSIONS) !== 0;
  return (
    <>
      <header className="flex h-12 items-center gap-1 border-b px-3">
        <h2 className="min-w-0 flex-1 truncate font-semibold">{view.name}</h2>
        <Link
          href={`/app/c/${view.id}/settings`}
          aria-label={canModerate ? "Community settings" : "Community info"}
          className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
        >
          <SettingsIcon className="size-4" />
        </Link>
      </header>
      <div className="flex items-center justify-between px-3 pt-4 pb-1">
        <h3 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">Channels</h3>
        {canManageChannels && <CreateChannelDialog communityId={view.id} />}
      </div>
      <ul className="flex-1 space-y-0.5 overflow-y-auto px-2">
        {view.channels.map((c) => (
          <li key={c.id}>
            <ChannelLink href={`/app/c/${view.id}/${c.id}`} name={c.name} />
          </li>
        ))}
      </ul>
      {has(view.authority, Permission.CreateInvites) && (
        <div className="border-t p-3">
          <InviteDialog communityId={view.id} communityName={view.name} />
        </div>
      )}
    </>
  );
}
