import { publicChannelState } from "@/server/public-channels";
import { PublicChannelControls } from "@/components/app/public-channel-controls";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { ChannelSettingsDialog } from "@/components/app/channel-settings-dialog";
import { ChannelChat } from "@/components/app/chat/channel-chat";
import { PinnedDialog } from "@/components/app/chat/pinned-dialog";
import { VoiceRoom } from "@/components/app/voice/voice-room";
import { voiceEnabled } from "@/server/voice";
import { HashIcon, Volume2Icon } from "lucide-react";
import { SearchDialog } from "@/components/app/search-dialog";
import { MemberListPanel, MemberListToggle } from "@/components/app/member-list";
import { MobileNavToggle } from "@/components/app/mobile-nav";
import { mediaEnabled } from "@/server/media";
import { blockedIds } from "@/server/blocks";
import { listMessages, openMessage } from "@/server/messages";
import { loadCommunityView } from "@/server/pages";
import { has, Permission } from "@/server/permissions";
import { requirePageUser } from "@/server/session";

export default function ChannelPage({ params, searchParams }: PageProps<"/app/c/[communityId]/[channelId]">) {
  return (
    <Suspense fallback={<p className="m-auto text-muted-foreground">Loading messages…</p>}>
      <Channel params={params} searchParams={searchParams} />
    </Suspense>
  );
}

/** `?m=<messageId>` opens the channel at that message (a thread reply opens its thread). */
async function Channel({ params, searchParams }: PageProps<"/app/c/[communityId]/[channelId]">) {
  const { communityId, channelId } = await params;
  const { m: linked } = await searchParams;
  const user = await requirePageUser();
  const view = await loadCommunityView(user.id, communityId);
  const channel = view.channels.find((c) => c.id === channelId);
  // Channel from another community, or deleted: 404 without revealing which.
  if (!channel) notFound();
  const [{ page, target }, blocked, publication] = await Promise.all([
    linked !== undefined && channel.kind === "text" ? openMessage(user.id, channelId, linked) : listMessages(user.id, channelId).then((page) => ({ page, target: null })),
    blockedIds(user.id),
    publicChannelState(user.id, channelId),
  ]);

  return (
    <>
      <header className="flex h-12 shrink-0 items-center gap-2 border-b bg-background px-2 md:pl-4">
        <MobileNavToggle />
        <h1 className="flex min-w-0 shrink-0 items-center gap-1.5 text-base font-semibold text-foreground">
          {channel.kind === "voice" ? <Volume2Icon aria-hidden className="size-6 text-muted-foreground" /> : <HashIcon aria-hidden className="size-6 text-muted-foreground" />}
          <span className="truncate">{channel.name}</span>
        </h1>
        {channel.topic && (
          <p className="hidden min-w-0 truncate border-l pl-3 text-sm text-muted-foreground sm:block">{channel.topic}</p>
        )}
        <div className="ml-auto flex shrink-0 items-center gap-1 text-muted-foreground [&>button]:hover:text-foreground">
          {channel.kind === "text" && <PinnedDialog channelId={channel.id} channelName={channel.name} />}
          {has(view.authority, Permission.ManageChannels) && (
            <ChannelSettingsDialog
              channel={channel}
              communityId={view.id}
              canManagePermissions={has(view.authority, Permission.ManageRoles)}
              categories={view.categories}
            />
          )}
          <MemberListToggle />
          <div className="ml-1"><SearchDialog communityId={view.id} communityName={view.name} /></div>
        </div>
      </header>
      {publication && <PublicChannelControls channelId={channel.id} unpublished={publication.unpublished} isOwner={view.isOwner} />}
      <div className="flex min-h-0 flex-1">
      {channel.kind === "voice" ? (
        <VoiceRoom
          key={channel.id}
          channel={{ id: channel.id, name: channel.name }}
          href={`/app/c/${view.id}/${channel.id}`}
          canConnect={voiceEnabled && has(channel, Permission.Connect)}
        />
      ) : (
      <ChannelChat
        // Another link into the same channel starts a fresh view.
        key={`${channel.id}:${linked ?? ""}`}
        channel={channel}
        initialPage={page}
        target={target}
        unavailable={page.unavailable}
        currentUserId={user.id}
        canSend={has(channel, Permission.SendMessages) && !publication?.unpublished}
        publicGeneration={publication && !publication.unpublished ? publication.generation : null}
        canModerate={has(channel, Permission.ManageMessages)}
        mediaEnabled={mediaEnabled}
        communityId={view.id}
        lastReadId={channel.lastReadId}
        blockedIds={blocked}
      />
      )}
      <MemberListPanel />
      </div>
    </>
  );
}
