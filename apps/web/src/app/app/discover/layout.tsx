import { DiscoverHeading, DiscoverNavLink } from "@/components/app/discover/labels";
import { MobilePanel } from "@/components/app/mobile-nav";

/** Discord's discovery sidebar. Apps and Quests come later. */
export default function DiscoverLayout({ children }: LayoutProps<"/app/discover">) {
  return (
    <>
      <MobilePanel label="Discover" data-sidebar className="flex w-(--sidebar-w) shrink-0 flex-col border-r bg-panel max-md:left-(--rail-w)">
        <header className="flex h-12 shrink-0 items-center border-b px-4">
          <h2 className="text-base font-semibold"><DiscoverHeading /></h2>
        </header>
        <ul className="space-y-0.5 px-2 pt-2">
          <li><DiscoverNavLink /></li>
        </ul>
      </MobilePanel>
      <div className="flex min-w-0 flex-1 flex-col">{children}</div>
    </>
  );
}
