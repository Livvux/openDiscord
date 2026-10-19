import { requirePageUser } from "@/server/session";
import type { Metadata, Viewport } from "next";
import { Suspense } from "react";
import { CommunityRail } from "@/components/app/community-rail";
import { MobileNavProvider, MobilePanel } from "@/components/app/mobile-nav";
import { NotificationsProvider } from "@/components/app/notifications-provider";
import { ServiceWorkerRegistration } from "@/components/app/service-worker";
import { VoiceProvider } from "@/components/app/voice/voice-provider";
import { DmCallRinger } from "@/components/app/voice/dm-call-ringer";

// Private area: never indexed.
export const metadata: Metadata = { robots: { index: false, follow: false } };
// Edge-to-edge on notched phones (the shell pads itself with the safe-area insets) and a status bar matching the app.
export const viewport: Viewport = { themeColor: "#0f172a", viewportFit: "cover" };

export default function AppLayout({ children }: LayoutProps<"/app">) {
  return <Suspense fallback={<div role="status" className="p-4">Opening your account…</div>}><AuthenticatedShell>{children}</AuthenticatedShell></Suspense>;
}
async function AuthenticatedShell({ children }: { children: React.ReactNode }) {
  const { id, sessionId } = await requirePageUser();
  return (
    <NotificationsProvider>
    <VoiceProvider key={`${id}:${sessionId}`} accountId={id} sessionId={sessionId}>
    <MobileNavProvider>
      <ServiceWorkerRegistration />
      <DmCallRinger />
      <div data-app-shell className="flex h-dvh overflow-hidden bg-background pt-[env(safe-area-inset-top)] pr-[env(safe-area-inset-right)] pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)] text-sm text-foreground">
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
