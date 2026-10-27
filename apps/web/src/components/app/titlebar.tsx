import { loadCommunityNavigation } from "@/server/pages";
import { requirePageUser } from "@/server/session";
import { TitlebarLabel } from "./titlebar-label";

/** Discord's 32px window bar: where you are, centred above the whole app. */
export async function Titlebar() {
  const user = await requirePageUser();
  const communities = await loadCommunityNavigation(user.id);
  return (
    <div className="flex h-8 shrink-0 items-center justify-center bg-sidebar px-3 text-sm font-medium text-sidebar-foreground max-md:hidden">
      <TitlebarLabel names={Object.fromEntries(communities.map((c) => [c.id, c.name]))} />
    </div>
  );
}
