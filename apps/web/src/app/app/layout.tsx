import { requirePageUser } from "@/server/session";
import type { Metadata } from "next";
import { Suspense } from "react";
import { CommunityRail } from "@/components/app/community-rail";
import { MobileNavProvider, MobilePanel } from "@/components/app/mobile-nav";
import { NotificationsProvider } from "@/components/app/notifications-provider";
import { VoiceProvider } from "@/components/app/voice/voice-provider";

// Private area: never indexed.
export const metadata: Metadata = { robots: { index: false, follow: false } };

export default function AppLayout({ children }: LayoutProps<"/app">) {
  return <Suspense fallback={<div role="status" className="p-4">Opening your account…</div>}><AuthenticatedShell>{children}</AuthenticatedShell></Suspense>;
}
async function AuthenticatedShell({ children }: { children: React.ReactNode }) {
  const { id, sessionId } = await requirePageUser();
  return (
    <NotificationsProvider>
    <VoiceProvider key={`${id}:${sessionId}`} accountId={id} sessionId={sessionId}>
    <MobileNavProvider>
      <div className="flex h-dvh overflow-hidden bg-background text-sm text-foreground">
        <MobilePanel
          label="Communities"
          className="flex w-16 shrink-0 flex-col items-center border-r border-sidebar-border bg-sidebar max-md:left-0"
        >
          <Suspense fallback={<div className="py-3 text-xs text-muted-foreground">…</div>}>
            <CommunityRail />
          </Suspense>
        </MobilePanel>
        <div className="flex min-w-0 flex-1">{children}</div>
      </div>
    </MobileNavProvider>
    </VoiceProvider>
    </NotificationsProvider>
  );
}
