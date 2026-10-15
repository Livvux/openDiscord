import Link from "next/link";
import { listCommunities } from "@/server/communities";
import { requirePageUser } from "@/server/session";
import { Avatar } from "./avatar";
import { CreateCommunityDialog } from "./create-community-dialog";
import { RailLink } from "./rail-link";

export async function CommunityRail() {
  const user = await requirePageUser();
  const communities = await listCommunities(user.id);
  return (
    <>
      <ul className="flex flex-1 flex-col items-center gap-3 overflow-y-auto py-4">
        {communities.map((c) => (
          <li key={c.id}>
            <RailLink href={`/app/c/${c.id}`} name={c.name} />
          </li>
        ))}
        <li>
          <CreateCommunityDialog />
        </li>
      </ul>
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
