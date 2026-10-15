import { ShieldIcon } from "lucide-react";
import { isInstanceAdmin } from "@/server/instance-policy";
import Link from "next/link";
import { listCommunities } from "@/server/communities";
import { requirePageUser } from "@/server/session";
import { mutedCommunities } from "@/server/presence";
import { communityUnread } from "@/server/unread";

const NOTHING_UNREAD_SUMMARY = { unread: false, mentions: 0 };
import { Avatar } from "./avatar";
import { CreateCommunityDialog } from "./create-community-dialog";
import { RailLink } from "./rail-link";

export async function CommunityRail() {
  const user = await requirePageUser();
  const [communities, admin] = await Promise.all([listCommunities(user.id), isInstanceAdmin(user.id)]);
  const [unread, muted] = await Promise.all([communityUnread(user.id, communities), mutedCommunities(user.id, communities.map((c) => c.id))]);
  return (
    <>
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
      <Link href="/app/restrictions" className="mb-4 rounded-xl p-2 text-xs hover:bg-white/5" aria-label="Your community restrictions">Bans</Link>
      {admin && <Link href="/app/admin" aria-label="Instance administration" className="mb-4 rounded-xl p-2 text-brand-mint hover:bg-white/5 focus-visible:outline-2 focus-visible:outline-ring"><ShieldIcon className="size-5" /></Link>}
      <Link
        href="/app/settings"
        aria-label={`Account settings for ${user.name}`}
        className="mb-4 rounded-full focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
      >
        <Avatar name={user.name} />
      </Link>
    </>
  );
}
