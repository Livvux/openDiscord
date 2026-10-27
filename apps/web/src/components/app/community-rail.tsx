import { CompassIcon, ShieldIcon } from "lucide-react";
import { isInstanceAdmin } from "@/server/instance-policy";
import Link from "next/link";
import { loadCommunityNavigation } from "@/server/pages";
import { requirePageUser } from "@/server/session";
import { presenceChoice } from "@/server/presence";
import { getProfile } from "@/server/profile";
import { ownAvatar } from "@/server/avatars";
import { communityUnread } from "@/server/unread";
import { listDirectConversations } from "@/server/direct-messages";
import { unreadTotal } from "@/lib/dm/contracts";

const NOTHING_UNREAD_SUMMARY = { unread: false, mentions: 0 };
import { RailHomeLink } from "./home/home-nav-link";
import { CreateCommunityDialog } from "./create-community-dialog";
import { RailLink } from "./rail-link";
import { ServerContextMenu } from "./server-context-menu";
import { UserPanel } from "./user-panel";

const railAction = "grid size-12 place-items-center rounded-2xl bg-white/[0.08] text-[#23a55a] transition-colors hover:bg-[#23a55a] hover:text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";

export async function CommunityRail() {
  const user = await requirePageUser();
  const [communities, admin, presence, profile, avatar] = await Promise.all([loadCommunityNavigation(user.id), isInstanceAdmin(user.id), presenceChoice(user.id), getProfile(user.id), ownAvatar(user.id)]);
  const [unread, direct] = await Promise.all([communityUnread(user.id, communities), listDirectConversations(user.id)]);
  return (
    <>
      <RailHomeLink initialUnread={unreadTotal(direct)} />
      <span aria-hidden className="mt-2 h-0.5 w-8 shrink-0 rounded-full bg-white/10" />
      {/* Bottom padding keeps the last icons above the floating user panel. */}
      <ul className="flex w-full flex-1 flex-col items-center gap-2 overflow-y-auto pt-2 pb-20 [scrollbar-width:none]">
        {communities.map((c) => (
          <li key={c.id}>
            <ServerContextMenu community={c}>
              <RailLink communityId={c.id} name={c.name} initial={unread.get(c.id) ?? NOTHING_UNREAD_SUMMARY} muted={c.notifications === "muted"} />
            </ServerContextMenu>
          </li>
        ))}
        <li>
          <CreateCommunityDialog />
        </li>
        <li>
          <Link href="/discover" aria-label="Discover communities" title="Discover" className={railAction}><CompassIcon /></Link>
        </li>
        {admin && (
          <li>
            <Link href="/app/admin" aria-label="Instance administration" title="Instance administration" className={railAction}><ShieldIcon /></Link>
          </li>
        )}
      </ul>
      <UserPanel userId={user.id} name={user.name} avatar={avatar} presence={presence} customStatus={profile.customStatus} />
    </>
  );
}
