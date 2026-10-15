import { Suspense } from "react";
import { ChannelSidebar } from "@/components/app/channel-sidebar";
import { MobilePanel } from "@/components/app/mobile-nav";
import { RealtimeProvider } from "@/components/app/realtime-provider";
import { loadCommunityView } from "@/server/pages";
import { requirePageUser } from "@/server/session";

export default function CommunityLayout({ params, children }: LayoutProps<"/app/c/[communityId]">) {
  return (
    <Suspense fallback={<p className="m-auto text-muted-foreground">Loading…</p>}>
      <CommunityShell params={params}>{children}</CommunityShell>
    </Suspense>
  );
}

async function CommunityShell({ params, children }: Pick<LayoutProps<"/app/c/[communityId]">, "params" | "children">) {
  const { communityId } = await params;
  const user = await requirePageUser();
  const view = await loadCommunityView(user.id, communityId);
  return (
    <RealtimeProvider communityId={view.id}>
      <MobilePanel label="Channels" className="flex w-60 shrink-0 flex-col border-r bg-sidebar max-md:left-[4.5rem]">
        <ChannelSidebar view={view} />
      </MobilePanel>
      <div className="flex min-w-0 flex-1 flex-col">{children}</div>
    </RealtimeProvider>
  );
}
