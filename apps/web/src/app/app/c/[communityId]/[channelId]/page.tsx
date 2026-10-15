import { notFound } from "next/navigation";
import { Suspense } from "react";
import { ChannelSettingsDialog } from "@/components/app/channel-settings-dialog";
import { ChannelChat } from "@/components/app/chat/channel-chat";
import { PinnedDialog } from "@/components/app/chat/pinned-dialog";
import { VoiceRoom } from "@/components/app/voice/voice-room";
import { voiceEnabled } from "@/server/voice";
import { Volume2Icon } from "lucide-react";
import { MobileNavToggle } from "@/components/app/mobile-nav";
import { mediaEnabled } from "@/server/media";
import { blockedIds } from "@/server/blocks";
import { listMessages } from "@/server/messages";
import { loadCommunityView } from "@/server/pages";
import { has, Permission } from "@/server/permissions";
import { requirePageUser } from "@/server/session";

export default function ChannelPage({ params }: PageProps<"/app/c/[communityId]/[channelId]">) {
  return (
    <Suspense fallback={<p className="m-auto text-muted-foreground">Loading messages…</p>}>
      <Channel params={params} />
    </Suspense>
  );
}

async function Channel({ params }: Pick<PageProps<"/app/c/[communityId]/[channelId]">, "params">) {
  const { communityId, channelId } = await params;
  const user = await requirePageUser();
  const view = await loadCommunityView(user.id, communityId);
  const channel = view.channels.find((c) => c.id === channelId);
  // Channel from another community, or deleted: 404 without revealing which.
  if (!channel) notFound();
  const [page, blocked] = await Promise.all([listMessages(user.id, channelId), blockedIds(user.id)]);

  return (
    <>
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-white/5 px-3 md:px-5">
        <MobileNavToggle />
        <h1 className="flex items-center gap-1 font-medium text-zinc-200">
          {channel.kind === "voice" ? <Volume2Icon aria-hidden className="size-4 text-zinc-400" /> : <span aria-hidden className="text-zinc-400"># </span>}
          {channel.name}
        </h1>
        {channel.topic && (
          <p className="hidden truncate border-l border-white/10 pl-3 text-sm text-zinc-400 sm:block">{channel.topic}</p>
        )}
        <div className="ml-auto flex items-center">
          {channel.kind === "text" && <PinnedDialog channelId={channel.id} channelName={channel.name} />}
          {has(view.authority, Permission.ManageChannels) && (
            <ChannelSettingsDialog
              channel={channel}
              communityId={view.id}
              canManagePermissions={has(view.authority, Permission.ManageRoles)}
              categories={view.categories}
            />
          )}
        </div>
      </header>
      {channel.kind === "voice" ? (
        <VoiceRoom
          key={channel.id}
          channel={{ id: channel.id, name: channel.name }}
          href={`/app/c/${view.id}/${channel.id}`}
          canConnect={voiceEnabled && has(channel, Permission.Connect)}
        />
      ) : (
      <ChannelChat
        key={channel.id}
        channel={channel}
        initialPage={page}
        currentUserId={user.id}
        canSend={has(channel, Permission.SendMessages)}
        canModerate={has(channel, Permission.ManageMessages)}
        mediaEnabled={mediaEnabled}
        communityId={view.id}
        lastReadId={channel.lastReadId}
        blockedIds={blocked}
      />
      )}
    </>
  );
}
