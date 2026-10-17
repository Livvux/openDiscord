import { Suspense } from "react";
import { CommunityRules } from "@/components/app/community-rules";
import { getCommunityRules } from "@/server/community-trust";
import { ChannelSidebar } from "@/components/app/channel-sidebar";
import { MemberListProvider } from "@/components/app/member-list";
import { MobilePanel } from "@/components/app/mobile-nav";
import { PresenceProvider } from "@/components/app/presence-provider";
import { RealtimeProvider } from "@/components/app/realtime-provider";
import { UnreadProvider } from "@/components/app/unread-provider";
import { blockedIds } from "@/server/blocks";
import { listMembers } from "@/server/moderation";
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
  const [view, blocked] = await Promise.all([loadCommunityView(user.id, communityId), blockedIds(user.id)]);
  // After the view: non-members must get its not-found page, not listMembers' error.
  const [rules, members] = await Promise.all([getCommunityRules(user.id, view.id), listMembers(user.id, view.id)]);
  return (
    <RealtimeProvider communityId={view.id}>
      <PresenceProvider communityId={view.id}>
      <UnreadProvider
        communityId={view.id}
        currentUserId={user.id}
        blockedIds={blocked}
        initial={Object.fromEntries(view.channels.map((c) => [c.id, { unread: c.unread, mentions: c.mentions }]))}
      >
      <MemberListProvider currentUserId={user.id} blockedIds={blocked} members={members.map(({ userId, name, isOwner }) => ({ userId, name, isOwner }))}>
      <MobilePanel label="Channels" className="flex w-60 shrink-0 flex-col border-r border-white/5 bg-panel max-md:left-16">
        <ChannelSidebar view={view} />
      </MobilePanel>
      <div className="flex min-w-0 flex-1 flex-col">{rules.required && !rules.accepted && <section aria-label="Required community rules" className="max-h-[50dvh] shrink-0 overflow-y-auto border-b p-4"><h2 className="mb-2 font-semibold">Community rules updated</h2><CommunityRules communityId={view.id} rules={rules} /></section>}{children}</div>
      </MemberListProvider>
      </UnreadProvider>
      </PresenceProvider>
    </RealtimeProvider>
  );
}
