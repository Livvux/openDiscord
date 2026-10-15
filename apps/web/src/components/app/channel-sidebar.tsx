import { SettingsIcon } from "lucide-react";
import Link from "next/link";
import type { CommunityView } from "@/server/communities";
import { has, Permission } from "@/server/permissions";
import { ChannelLink } from "./channel-link";
import { CreateChannelDialog } from "./create-channel-dialog";
import { ReportDialog } from "./report-dialog";
import { InviteDialog } from "./invite-dialog";

const SETTINGS_PERMISSIONS =
  Permission.ManageCommunity | Permission.ManageRoles | Permission.KickMembers | Permission.BanMembers | Permission.ViewAuditLog;

export function ChannelSidebar({ view }: { view: CommunityView }) {
  const canManageChannels = has(view.authority, Permission.ManageChannels);
  const canModerate = (view.authority.permissions & SETTINGS_PERMISSIONS) !== 0;
  return (
    <>
      <header className="flex h-12 items-center gap-1 border-b border-white/5 px-3">
        <h2 className="min-w-0 flex-1 truncate px-2 font-semibold text-zinc-100">{view.name}</h2>
        <Link
          href={`/app/c/${view.id}/settings`}
          aria-label={canModerate ? "Community settings" : "Community info"}
          className="rounded-md p-1.5 text-zinc-400 hover:bg-white/5 hover:text-zinc-100 focus-visible:outline-2 focus-visible:outline-ring"
        >
          <SettingsIcon className="size-4" />
        </Link>
      </header>
      <div className="flex items-center justify-between px-3 pt-3 pb-1">
        <h3 className="px-2 text-[11px] tracking-widest text-zinc-400 uppercase">Text channels</h3>
        {canManageChannels && <CreateChannelDialog communityId={view.id} />}
      </div>
      <ul className="flex-1 space-y-0.5 overflow-y-auto px-3">
        {view.channels.map((c) => (
          <li key={c.id}>
            <ChannelLink href={`/app/c/${view.id}/${c.id}`} name={c.name} />
          </li>
        ))}
      </ul>
      <div className="px-3 py-2"><ReportDialog communityId={view.id} /></div>
      {has(view.authority, Permission.CreateInvites) && (
        <div className="border-t border-white/5 p-3">
          <InviteDialog communityId={view.id} communityName={view.name} />
        </div>
      )}
    </>
  );
}
