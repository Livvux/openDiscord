import { ShieldIcon } from "lucide-react";
import { isInstanceAdmin } from "@/server/instance-policy";
import Link from "next/link";
import { listCommunities } from "@/server/communities";
import { requirePageUser } from "@/server/session";
import { mutedCommunities, presenceChoice } from "@/server/presence";
import { getProfile } from "@/server/profile";
import { communityUnread } from "@/server/unread";

const NOTHING_UNREAD_SUMMARY = { unread: false, mentions: 0 };
import { AccountMenu } from "./account-menu";
import { RailHomeLink } from "./home/home-nav-link";
import { CreateCommunityDialog } from "./create-community-dialog";
import { RailLink } from "./rail-link";

export async function CommunityRail() {
  const user = await requirePageUser();
  const [communities, admin, presence, profile] = await Promise.all([listCommunities(user.id), isInstanceAdmin(user.id), presenceChoice(user.id), getProfile(user.id)]);
  const [unread, muted] = await Promise.all([communityUnread(user.id, communities), mutedCommunities(user.id, communities.map((c) => c.id))]);
  return (
    <>
      <RailHomeLink />
      <span aria-hidden className="mt-3 h-0.5 w-8 rounded-full bg-white/10" />
      <ul className="flex flex-1 flex-col items-center gap-3 overflow-y-auto py-4">
        {communities.map((c) => (
          <li key={c.id}>
            <RailLink communityId={c.id} name={c.name} initial={unread.get(c.id) ?? NOTHING_UNREAD_SUMMARY} muted={muted.has(c.id)} />
          </li>
        ))}
        <li>
          <CreateCommunityDialog />
        </li>
      </ul>
      {admin && <Link href="/app/admin" aria-label="Instance administration" className="mb-4 rounded-xl p-2 text-brand-mint hover:bg-white/5 focus-visible:outline-2 focus-visible:outline-ring"><ShieldIcon className="size-5" /></Link>}
      <AccountMenu userId={user.id} name={user.name} presence={presence} customStatus={profile.customStatus} />
    </>
  );
}
