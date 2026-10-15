import type { Metadata } from "next";
import { Suspense } from "react";
import { CommunityRail } from "@/components/app/community-rail";
import { MobileNavProvider, MobilePanel } from "@/components/app/mobile-nav";
import { NotificationsProvider } from "@/components/app/notifications-provider";

// Private area: never indexed.
export const metadata: Metadata = { robots: { index: false, follow: false } };

export default function AppLayout({ children }: LayoutProps<"/app">) {
  return (
    <NotificationsProvider>
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
    </NotificationsProvider>
  );
}
