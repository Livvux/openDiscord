import { SettingsIcon } from "lucide-react";
import Link from "next/link";
import type { CommunityView } from "@/server/communities";
import { has, Permission } from "@/server/permissions";
import { CategoryGroup } from "./category-group";
import { ChannelLink } from "./channel-link";
import { CreateChannelDialog } from "./create-channel-dialog";
import { ReportDialog } from "./report-dialog";
import { SearchDialog } from "./search-dialog";
import { VoiceBar } from "./voice/voice-bar";
import { voiceEnabled } from "@/server/voice";
import { InviteDialog } from "./invite-dialog";

const SETTINGS_PERMISSIONS =
  Permission.ManageCommunity | Permission.ManageRoles | Permission.KickMembers | Permission.BanMembers | Permission.ViewAuditLog;

export function ChannelSidebar({ view }: { view: CommunityView }) {
  const canManageChannels = has(view.authority, Permission.ManageChannels);
  const loose = view.channels.filter((c) => !c.categoryId);
  const voice = loose.filter((c) => c.kind === "voice");
  const link = (c: CommunityView["channels"][number]) => (
    <li key={c.id}>
      <ChannelLink channelId={c.id} href={`/app/c/${view.id}/${c.id}`} name={c.name} isPrivate={c.isPrivate} kind={c.kind} />
    </li>
  );
  const canModerate = (view.authority.permissions & SETTINGS_PERMISSIONS) !== 0;
  return (
    <>
      <header className="flex h-12 items-center gap-1 border-b border-white/5 px-3">
        <h2 className="min-w-0 flex-1 truncate px-2 font-semibold text-zinc-100">{view.name}</h2>
        <SearchDialog communityId={view.id} communityName={view.name} />
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
        {canManageChannels && <CreateChannelDialog communityId={view.id} voiceEnabled={voiceEnabled} />}
      </div>
      <ul className="flex-1 space-y-0.5 overflow-y-auto px-3">
        {loose.filter((c) => c.kind === "text").map(link)}
        {voice.length > 0 && (
          <li>
            <h3 className="px-2 pt-4 pb-1 text-[11px] tracking-widest text-zinc-400 uppercase">Voice channels</h3>
            <ul className="space-y-0.5">{voice.map(link)}</ul>
          </li>
        )}
        {view.categories.map((cat) => {
          const inside = view.channels.filter((c) => c.categoryId === cat.id);
          // Members only see groups with a channel they can open; managers also see empty ones.
          if (inside.length === 0 && !canManageChannels) return null;
          return (
            <CategoryGroup key={cat.id} id={cat.id} name={cat.name} hrefs={inside.map((c) => `/app/c/${view.id}/${c.id}`)}>
              {inside.map(link)}
            </CategoryGroup>
          );
        })}
      </ul>
      <VoiceBar />
      <div className="px-3 py-2"><ReportDialog communityId={view.id} /></div>
      {has(view.authority, Permission.CreateInvites) && (
        <div className="border-t border-white/5 p-3">
          <InviteDialog communityId={view.id} communityName={view.name} />
        </div>
      )}
    </>
  );
}
