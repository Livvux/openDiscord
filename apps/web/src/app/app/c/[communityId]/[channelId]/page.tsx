import { HashIcon } from "lucide-react";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { ChannelSettingsDialog } from "@/components/app/channel-settings-dialog";
import { ChannelChat } from "@/components/app/chat/channel-chat";
import { MobileNavToggle } from "@/components/app/mobile-nav";
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
  const page = await listMessages(user.id, channelId);

  return (
    <>
      <header className="flex h-12 shrink-0 items-center gap-2 border-b px-3">
        <MobileNavToggle />
        <HashIcon aria-hidden className="size-5 text-muted-foreground" />
        <h1 className="font-semibold">{channel.name}</h1>
        {channel.topic && (
          <p className="hidden truncate border-l pl-3 text-sm text-muted-foreground sm:block">{channel.topic}</p>
        )}
        <div className="ml-auto">
          {has(view.authority, Permission.ManageChannels) && (
            <ChannelSettingsDialog channel={channel} communityId={view.id} />
          )}
        </div>
      </header>
      <ChannelChat
        key={channel.id}
        channel={channel}
        initialPage={page}
        currentUserId={user.id}
        canSend={has(view.authority, Permission.SendMessages)}
        canModerate={has(view.authority, Permission.ManageMessages)}
      />
    </>
  );
}
