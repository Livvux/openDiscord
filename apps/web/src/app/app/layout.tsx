import type { Metadata } from "next";
import { Suspense } from "react";
import { CommunityRail } from "@/components/app/community-rail";
import { MobileNavProvider, MobilePanel } from "@/components/app/mobile-nav";

// Private area: never indexed.
export const metadata: Metadata = { robots: { index: false, follow: false } };

export default function AppLayout({ children }: LayoutProps<"/app">) {
  return (
    <MobileNavProvider>
      <div className="flex h-dvh overflow-hidden bg-background text-foreground">
        <MobilePanel
          label="Communities"
          className="flex w-[4.5rem] shrink-0 flex-col items-center border-r bg-sidebar max-md:left-0"
        >
          <Suspense fallback={<div className="py-3 text-xs text-muted-foreground">…</div>}>
            <CommunityRail />
          </Suspense>
        </MobilePanel>
        <div className="flex min-w-0 flex-1">{children}</div>
      </div>
    </MobileNavProvider>
  );
}
