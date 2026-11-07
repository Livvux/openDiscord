import { Suspense } from "react";
import { CommunityRules } from "@/components/app/community-rules";
import { getCommunityRules } from "@/server/community-trust";
import { OnboardingPicker } from "@/components/app/onboarding-picker";
import { getOnboarding } from "@/server/onboarding";
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
import { DiamondOrbitSmoothLoader } from "@/components/ui/diamond-orbit-smooth-loader";

export default function CommunityLayout({ params, children }: LayoutProps<"/app/c/[communityId]">) {
  return (
    <Suspense fallback={<div className="m-auto text-primary"><DiamondOrbitSmoothLoader /></div>}>
      <CommunityShell params={params}>{children}</CommunityShell>
    </Suspense>
  );
}

async function CommunityShell({ params, children }: Pick<LayoutProps<"/app/c/[communityId]">, "params" | "children">) {
  const { communityId } = await params;
  const user = await requirePageUser();
  const [view, blocked] = await Promise.all([loadCommunityView(user.id, communityId), blockedIds(user.id)]);
  // After the view: non-members must get its not-found page, not listMembers' error.
  const [rules, members, onboarding] = await Promise.all([getCommunityRules(user.id, view.id), listMembers(user.id, view.id), getOnboarding(user.id, view.id)]);
  const rulesPending = rules.required && !rules.accepted;
  return (
    <RealtimeProvider communityId={view.id}>
      <PresenceProvider communityId={view.id}>
      <UnreadProvider
        communityId={view.id}
        currentUserId={user.id}
        blockedIds={blocked}
        initial={Object.fromEntries(view.channels.map((c) => [c.id, { unread: c.unread, mentions: c.mentions }]))}
      >
      <MemberListProvider currentUserId={user.id} blockedIds={blocked} members={members.map(({ userId, name, avatar, isOwner }) => ({ userId, name, avatar, isOwner }))}>
      <MobilePanel label="Channels" data-sidebar className="flex w-(--sidebar-w) shrink-0 flex-col border-r bg-panel max-md:left-(--rail-w)">
        <ChannelSidebar view={view} />
      </MobilePanel>
      <div className="flex min-w-0 flex-1 flex-col">{rulesPending && <section aria-label="Required community rules" className="max-h-[50dvh] shrink-0 overflow-y-auto border-b p-4"><h2 className="mb-2 font-semibold">Community rules updated</h2><CommunityRules communityId={view.id} rules={rules} /></section>}{!rulesPending && onboarding.pending && <OnboardingPicker communityId={view.id} communityName={view.name} options={onboarding.options} />}{children}</div>
      </MemberListProvider>
      </UnreadProvider>
      </PresenceProvider>
    </RealtimeProvider>
  );
}
