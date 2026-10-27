import { requirePageUser } from "@/server/session";
import type { Metadata, Viewport } from "next";
import { Suspense } from "react";
import { CommunityRail } from "@/components/app/community-rail";
import { Titlebar } from "@/components/app/titlebar";
import { MobileNavProvider, MobilePanel } from "@/components/app/mobile-nav";
import { NotificationsProvider } from "@/components/app/notifications-provider";
import { ServiceWorkerRegistration } from "@/components/app/service-worker";
import { VoiceProvider } from "@/components/app/voice/voice-provider";
import { DmCallRinger } from "@/components/app/voice/dm-call-ringer";
import { I18nProvider } from "@/lib/i18n/client";
import { appMessages } from "@/lib/i18n";
import { getLocale } from "@/lib/i18n/server";

// Private area: never indexed.
export const metadata: Metadata = { robots: { index: false, follow: false } };
// Edge-to-edge on notched phones (the shell pads itself with the safe-area insets) and a status bar matching the app.
export const viewport: Viewport = { themeColor: "#0f172a", viewportFit: "cover" };

export default function AppLayout({ children, settings }: LayoutProps<"/app">) {
  return <Suspense fallback={<div role="status" className="p-4">Opening your account…</div>}><AuthenticatedShell>{children}{settings}</AuthenticatedShell></Suspense>;
}
async function AuthenticatedShell({ children }: { children: React.ReactNode }) {
  const [{ id, sessionId }, locale] = await Promise.all([requirePageUser(), getLocale()]);
  return (
    <I18nProvider locale={locale} messages={appMessages[locale]}>
    <NotificationsProvider>
    <VoiceProvider key={`${id}:${sessionId}`} accountId={id} sessionId={sessionId}>
    <MobileNavProvider>
      <ServiceWorkerRegistration />
      <DmCallRinger />
      <div data-app-shell lang={locale} className="relative flex h-dvh flex-col overflow-hidden bg-sidebar pt-[env(safe-area-inset-top)] pr-[env(safe-area-inset-right)] pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)] text-sm text-foreground">
        <Suspense fallback={<div className="h-8 shrink-0 max-md:hidden" />}>
          <Titlebar />
        </Suspense>
        <div className="flex min-h-0 flex-1">
          <MobilePanel
            label={appMessages[locale].rail.communities}
            elevated
            className="flex w-(--rail-w) shrink-0 flex-col items-center bg-sidebar max-md:left-0"
          >
            <Suspense fallback={<div className="py-3 text-xs text-muted-foreground">…</div>}>
              <CommunityRail />
            </Suspense>
          </MobilePanel>
          {/* Discord's content sheet: one rounded corner and hairline where the channel list meets the rail. */}
          <div className="flex min-w-0 flex-1 overflow-hidden md:rounded-tl-lg md:border-t md:border-l">{children}</div>
        </div>
      </div>
    </MobileNavProvider>
    </VoiceProvider>
    </NotificationsProvider>
    </I18nProvider>
  );
}
